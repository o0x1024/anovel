import { ipcMain } from 'electron'
import {
  tasteProfileDAO, writingStyleDAO, styleDeviationDAO, imageDAO, volumeChapterDAO
} from './db'
import { formatTasteForPrompt, recordTasteReject, recordTasteChoice, exportTasteProfile, importTasteProfile } from './context/taste-profile'
import {
  extractStyleFingerprint, compareFingerprint, fingerprintToPrompt
} from './context/style-fingerprint'
import { detectAiTraces, AI_TRACE_POLISH_PROMPT } from './context/ai-trace-detect'
import {
  suggestRulesFromAiTrace,
  buildStyleRewriteSystemPrompt,
  buildStyleRewriteUserPrompt
} from './context/anti-ai-rules'
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
    return writingStyleDAO.update(styleId, { fingerprint_json: JSON.stringify(fp) })
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
  ipcMain.handle('aitrace:polish', async (e, workId: number, content: string) => {
    const res = await modelService.chat({
      prompt: content,
      systemPrompt: AI_TRACE_POLISH_PROMPT,
      workId,
      step: 'ai_trace_polish',
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    }, { webContents: e.sender })
    return res
  })

  ipcMain.handle('body:styleRewrite', async (e, workId: number, content: string, wordTarget?: number) => {
    const systemPrompt = buildStyleRewriteSystemPrompt(workId)
    const target = typeof wordTarget === 'number' && wordTarget > 0 ? wordTarget : undefined
    return modelService.chat({
      prompt: buildStyleRewriteUserPrompt(content, target),
      systemPrompt,
      step: 'body_style_rewrite',
      maxTokens: target ? Math.ceil(target * 1.5) : undefined,
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    }, { webContents: e.sender })
  })

  // ==================== 多模型辩论 ====================
  ipcMain.handle('debate:run', async (e, workId: number, prompt: string, systemPrompt: string, models?: [string, string]) => {
    return runModelDebate(workId, prompt, systemPrompt, models as [ModelType, ModelType] | undefined, e.sender)
  })

  // ==================== 导出质量报告 ====================
  ipcMain.handle('export:qualityReport', (_e, workId: number, title: string) =>
    buildExportQualityReport(workId, title))

  ipcMain.handle('export:contentWithReport', (_e, workId: number, title: string, format: 'markdown' | 'txt' | 'html', scope?: { volumeId?: number; chapterId?: number }, includeReport?: boolean) => {
    const main = exportWorkContent(workId, title, format, scope)
    if (!includeReport) return main
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
