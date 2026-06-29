import { ipcMain } from 'electron'
import {
  tasteProfileDAO, writingStyleDAO, styleDeviationDAO, imageDAO, volumeChapterDAO
} from './db'
import { formatTasteForPrompt, recordTasteReject, recordTasteChoice, exportTasteProfile, importTasteProfile } from './context/taste-profile'
import {
  extractStyleFingerprint, compareFingerprint, fingerprintToPrompt
} from './context/style-fingerprint'
import { detectAiTraces, AI_TRACE_POLISH_PROMPT } from './context/ai-trace-detect'
import { STYLE_REWRITE_INSTRUCTION } from './context/anti-ai-rules'
import { broadcastStyleChanged } from './style-events'
import { parseQualityAiPatchResponse } from '../shared/quality-ai-score'
import {
  suggestRulesFromAiTrace,
  buildStyleRewriteUserPrompt
} from './context/anti-ai-rules'
import { diagnoseChapterQuality, formatQualityFixHints } from './context/chapter-quality'
import { runModelDebate } from './context/model-debate'
import { buildExportQualityReport } from './context/export-quality-report'
import { exportWorkContent } from './context/export-content'
import { generateImage } from './image/image-service'
import { modelService } from './model'
import type { ModelType } from './model/types'

export function registerV20IpcHandlers(): void {
  // ==================== 品味档案 ====================
  ipcMain.handle('taste:list', () => tasteProfileDAO.list())
  ipcMain.handle('taste:get', (_e, id: number) => tasteProfileDAO.getById(id))
  ipcMain.handle('taste:getByWork', (_e, workId: number) => tasteProfileDAO.getByWork(workId))
  ipcMain.handle('taste:getDefault', () => tasteProfileDAO.getDefault())
  ipcMain.handle('taste:create', (_e, input: Record<string, unknown>) =>
    tasteProfileDAO.create(input as Parameters<typeof tasteProfileDAO.create>[0]))
  ipcMain.handle('taste:update', (_e, id: number, fields: Record<string, unknown>) =>
    tasteProfileDAO.update(id, fields as never))
  ipcMain.handle('taste:delete', (_e, id: number) => tasteProfileDAO.delete(id))
  ipcMain.handle('taste:bindToWork', (_e, workId: number, profileId: number) => {
    tasteProfileDAO.bindToWork(workId, profileId)
  })
  ipcMain.handle('taste:recordReject', (_e, workId: number, reason: string) => {
    recordTasteReject(workId, reason)
  })
  ipcMain.handle('taste:recordChoice', (_e, workId: number, type: string, detail: string) => {
    recordTasteChoice(workId, type, detail)
  })
  ipcMain.handle('taste:formatPrompt', (_e, workId: number) => formatTasteForPrompt(workId))
  ipcMain.handle('taste:export', (_e, profileId: number) => exportTasteProfile(profileId))
  ipcMain.handle('taste:import', (_e, json: string, workId?: number) => importTasteProfile(json, workId))

  // ==================== 文风指纹 ====================
  ipcMain.handle('fingerprint:extract', (_e, text: string) => extractStyleFingerprint(text))
  ipcMain.handle('fingerprint:toPrompt', (_e, text: string) => {
    const fp = extractStyleFingerprint(text)
    return { fingerprint: fp, prompt: fingerprintToPrompt(fp) }
  })
  ipcMain.handle('fingerprint:saveToStyle', (_e, styleId: number, text: string) => {
    const fp = extractStyleFingerprint(text)
    const ok = writingStyleDAO.update(styleId, { fingerprint_json: JSON.stringify(fp) })
    if (ok) broadcastStyleChanged(styleId)
    return ok
  })
  ipcMain.handle('fingerprint:checkDeviation', (_e, workId: number, chapterId: number, content: string) => {
    const styleId = writingStyleDAO.getWorkStyleId(workId)
    if (!styleId) return { success: false, error: '作品未绑定文风' }
    const style = writingStyleDAO.getById(styleId)
    if (!style?.fingerprint_json) return { success: false, error: '文风尚未提取指纹' }
    const expected = JSON.parse(style.fingerprint_json) as ReturnType<typeof extractStyleFingerprint>
    const actual = extractStyleFingerprint(content)
    const deviation = compareFingerprint(expected, actual)
    styleDeviationDAO.log({
      chapter_id: chapterId,
      style_id: styleId,
      deviation_score: deviation.score,
      deviation_details: JSON.stringify(deviation.details)
    })
    return { success: true, ...deviation, styleName: style.name }
  })
  ipcMain.handle('fingerprint:deviationList', (_e, workId: number) =>
    styleDeviationDAO.listByWork(workId))

  // ==================== AI 痕迹 ====================
  ipcMain.handle('aitrace:detect', (_e, content: string) => detectAiTraces(content))
  ipcMain.handle('aitrace:suggestRules', (_e, content: string) => {
    const report = detectAiTraces(content)
    return suggestRulesFromAiTrace(report.issues)
  })
  ipcMain.handle('aitrace:polish', async (e, workId: number, content: string, modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean }) => {
    const res = await modelService.chat({
      prompt: content,
      systemPrompt: AI_TRACE_POLISH_PROMPT,
      workId,
      step: 'ai_trace_polish',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })

    if (!res.success) return res

    // 解析并应用 patches
    let patches: import('../shared/quality-ai-score').QualityAiPatch[] = []
    try {
      patches = parseQualityAiPatchResponse(res.content)
    } catch {
      // 忽略解析错误
    }

    // 回退：如果 AI 没有返回 patches 而是返回了整篇修改后的文章
    if (!patches.length && res.content.trim().length > 200) {
      const rewritten = res.content.trim()
      const cleaned = rewritten
        .replace(/^.*?(?:以下是|修改后|修订后|优化后)[^\n]*[:：]?\s*\n+/i, '')
        .trim()
      if (cleaned.length > 50 && cleaned !== content.trim()) {
        patches = [{ find: content.trim(), replace: cleaned }]
      }
    }

    if (!patches.length) {
      return { success: true, content }
    }

    let patchedText = content
    for (const patch of patches) {
      if (!patch.find) continue
      const idx = patchedText.indexOf(patch.find)
      if (idx === -1) continue
      patchedText = patchedText.slice(0, idx) + patch.replace + patchedText.slice(idx + patch.find.length)
    }

    return { success: true, content: patchedText }
  })

  ipcMain.handle('body:styleRewrite', async (e, workId: number, content: string, wordTarget?: number, chapterId?: number, modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean }) => {
    const systemPrompt = STYLE_REWRITE_INSTRUCTION
    const target = typeof wordTarget === 'number' && wordTarget > 0 ? wordTarget : undefined
    const qualityHints = typeof chapterId === 'number' && chapterId > 0
      ? formatQualityFixHints(diagnoseChapterQuality(workId, chapterId, content))
      : undefined
    return modelService.chat({
      prompt: buildStyleRewriteUserPrompt(content, target, qualityHints),
      systemPrompt,
      workId,
      step: 'body_style_rewrite',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })
  })

  // ==================== 多模型辩论 ====================
  ipcMain.handle('debate:run', async (e, workId: number, prompt: string, systemPrompt: string, models?: [string, string]) => {
    return runModelDebate(workId, prompt, systemPrompt, models as [ModelType, ModelType] | undefined, e.sender)
  })

  // ==================== 导出质量报告 ====================
  ipcMain.handle('export:qualityReport', (_e, workId: number, title: string) =>
    buildExportQualityReport(workId, title))

  ipcMain.handle('export:contentWithReport', (_e, workId: number, title: string, format: 'markdown' | 'txt' | 'html', scope?: { volumeId?: number; chapterId?: number }, includeReport?: boolean, mode?: 'full' | 'body') => {
    const main = exportWorkContent(workId, title, format, scope, mode ?? 'full')
    if (!includeReport || mode === 'body') return main
    const report = buildExportQualityReport(workId, title)
    const separator = format === 'html'
      ? '<hr/><h1>整体质量报告</h1>'
      : '\n\n---\n\n'
    return {
      ...main,
      content: main.content + separator + (format === 'html' ? report.replace(/\n/g, '<br>') : report)
    }
  })

  // ==================== 图片生成 ====================
  ipcMain.handle('image:listByWork', (_e, workId: number) => imageDAO.listByWork(workId))
  ipcMain.handle('image:delete', (_e, id: number) => imageDAO.delete(id))
  ipcMain.handle('image:generate', (_e, input: Record<string, unknown>) =>
    generateImage(input as { workId: number; chapterId?: number; prompt: string; imageType?: string }))
  ipcMain.handle('image:getVolcengineConfig', () => {
    const cfg = imageDAO.getVolcengineConfig()
    if (!cfg) return null
    return { ...cfg, secret_key: cfg.secret_key ? '***' : '' }
  })
  ipcMain.handle('image:setVolcengineConfig', (_e, accessKey: string, secretKey: string, region?: string, enabled?: boolean) => {
    imageDAO.upsertVolcengineConfig(accessKey, secretKey, region, enabled)
  })
  ipcMain.handle('image:buildPromptFromChapter', async (_e, chapterId: number) => {
    const ch = volumeChapterDAO.getChapter(chapterId)
    if (!ch) return ''
    return [ch.title, ch.outline, ch.content?.slice(0, 500)].filter(Boolean).join('\n\n')
  })
}
