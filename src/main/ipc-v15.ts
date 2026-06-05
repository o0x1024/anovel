import { ipcMain } from 'electron'
import { foreshadowingDAO, characterSnapshotDAO, timelineDAO, anchorAlignmentDAO } from './db'
import { modelService } from './model'
import { buildNarrativeMemoryPrompt } from './context/narrative-memory'
import { buildConsistencyReport } from './context/consistency-report'
import { checkWorldviewConsistency } from './context/worldview-check'
import {
  CRITIQUE_SYSTEM_PROMPT,
  formatCritiqueFixReport,
  parseCritiqueResponse,
  type CritiqueResult
} from './context/chapter-critique'
import { diagnoseChapterQuality } from './context/chapter-quality'
import { resolvePrompt } from './context/prompt-registry'
import { buildStyleRewriteSystemPrompt, buildStyleDiagnosisContext } from './context/anti-ai-rules'
import {
  SURPRISE_SYSTEM_PROMPT,
  DISRUPTOR_SYSTEM_PROMPT,
  GENRE_DEVIATION_PROMPT,
  parseSurpriseScore,
  parseDisruptorResponse,
  parseGenreDeviation
} from './context/anti-mean'
import {
  MEMORY_EXTRACT_SYSTEM_PROMPT,
  parseMemoryExtract,
  applyMemoryExtract
} from './context/memory-extract'
import {
  cleanupDuplicateNarrativeMemory,
  clearChapterMemoryBeforeExtract
} from './context/memory-cleanup'
import { generationLogDAO } from './db'

export function registerV15IpcHandlers(): void {
  // ==================== 伏笔追踪 ====================
  ipcMain.handle('foreshadowing:listByWork', (_e, workId: number) =>
    foreshadowingDAO.listByWork(workId))
  ipcMain.handle('foreshadowing:listPending', (_e, workId: number) =>
    foreshadowingDAO.listPending(workId))
  ipcMain.handle('foreshadowing:create', (_e, input: Record<string, unknown>) =>
    foreshadowingDAO.create(input as Parameters<typeof foreshadowingDAO.create>[0]))
  ipcMain.handle('foreshadowing:resolve', (_e, id: number, payoffChapterId: number, payoffLocation?: string) =>
    foreshadowingDAO.resolve(id, payoffChapterId, payoffLocation))
  ipcMain.handle('foreshadowing:updateStatus', (_e, id: number, status: string) =>
    foreshadowingDAO.updateStatus(id, status as 'pending' | 'partial' | 'resolved' | 'abandoned'))
  ipcMain.handle('foreshadowing:update', (_e, id: number, fields: Record<string, unknown>) =>
    foreshadowingDAO.update(id, fields as never))
  ipcMain.handle('foreshadowing:delete', (_e, id: number) =>
    foreshadowingDAO.delete(id))

  // ==================== 角色状态快照 ====================
  ipcMain.handle('snapshot:listByWork', (_e, workId: number) =>
    characterSnapshotDAO.listByWork(workId))
  ipcMain.handle('snapshot:getLatest', (_e, workId: number, characterName: string) =>
    characterSnapshotDAO.getLatest(workId, characterName))
  ipcMain.handle('snapshot:listByChapter', (_e, chapterId: number) =>
    characterSnapshotDAO.listByChapter(chapterId))
  ipcMain.handle('snapshot:listCharacters', (_e, workId: number) =>
    characterSnapshotDAO.listCharacterNames(workId))
  ipcMain.handle('snapshot:create', (_e, input: Record<string, unknown>) =>
    characterSnapshotDAO.create(input as Parameters<typeof characterSnapshotDAO.create>[0]))
  ipcMain.handle('snapshot:delete', (_e, id: number) =>
    characterSnapshotDAO.delete(id))
  ipcMain.handle('snapshot:deleteByChapter', (_e, chapterId: number) =>
    characterSnapshotDAO.deleteByChapter(chapterId))

  // ==================== 故事时间线 ====================
  ipcMain.handle('timeline:listByWork', (_e, workId: number) =>
    timelineDAO.listByWork(workId))
  ipcMain.handle('timeline:create', (_e, input: Record<string, unknown>) =>
    timelineDAO.create(input as Parameters<typeof timelineDAO.create>[0]))
  ipcMain.handle('timeline:update', (_e, id: number, fields: Record<string, unknown>) =>
    timelineDAO.update(id, fields as never))
  ipcMain.handle('timeline:reorder', (_e, workId: number, orderedIds: number[]) =>
    timelineDAO.reorder(workId, orderedIds))
  ipcMain.handle('timeline:delete', (_e, id: number) =>
    timelineDAO.delete(id))

  // ==================== 锚点对齐检测 ====================
  ipcMain.handle('alignment:listByAnchor', (_e, anchorId: number) =>
    anchorAlignmentDAO.listByAnchor(anchorId))
  ipcMain.handle('alignment:listByChapter', (_e, chapterId: number) =>
    anchorAlignmentDAO.listByChapter(chapterId))
  ipcMain.handle('alignment:log', (_e, input: Record<string, unknown>) =>
    anchorAlignmentDAO.log(input as Parameters<typeof anchorAlignmentDAO.log>[0]))
  ipcMain.handle('alignment:latestByWork', (_e, workId: number) =>
    anchorAlignmentDAO.latestByWork(workId))

  // ==================== 叙事记忆体 ====================
  ipcMain.handle('narrative:buildMemory', (_e, workId: number, chapterId?: number) =>
    buildNarrativeMemoryPrompt(workId, chapterId))
  ipcMain.handle('narrative:consistencyReport', (_e, workId: number) =>
    buildConsistencyReport(workId))
  ipcMain.handle('narrative:checkWorldview', (_e, workId: number, content: string) =>
    checkWorldviewConsistency(workId, content))

  ipcMain.handle('memory:extractFromChapter', async (e, workId: number, chapterId: number, content: string) => {
    const res = await modelService.chat({
      prompt: content,
      systemPrompt: MEMORY_EXTRACT_SYSTEM_PROMPT,
      workId,
      chapterId,
      step: 'memory_extract',
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    }, { webContents: e.sender })
    if (!res.success) return { success: false, error: res.error, planted: 0, resolved: 0, snapshots: 0 }
    const extracted = parseMemoryExtract(res.content)
    const cleared = clearChapterMemoryBeforeExtract(workId, chapterId)
    const result = applyMemoryExtract(workId, chapterId, extracted)
    return { success: true, ...result, replaced: cleared }
  })

  ipcMain.handle('memory:cleanupDuplicates', (_e, workId: number) =>
    cleanupDuplicateNarrativeMemory(workId))

  // ==================== 生成-批判双通道 ====================
  ipcMain.handle('critique:run', async (e, workId: number, content: string, chapterId?: number) => {
    const res = await modelService.chat({
      prompt: content,
      systemPrompt: CRITIQUE_SYSTEM_PROMPT,
      workId,
      chapterId,
      step: 'critique_dual_channel',
      enrichWorkContext: false
    }, { webContents: e.sender })
    if (!res.success) return { success: false, error: res.error }
    const parsed = parseCritiqueResponse(res.content)
    generationLogDAO.log({
      work_id: workId,
      step: 'critique_dual_channel',
      model_type: res.modelType || 'unknown',
      ai_self_score: parsed.overallScore,
      author_action: parsed.needsReview ? 'review' : 'pass'
    })
    return { success: true, ...parsed }
  })

  ipcMain.handle('critique:applyFixes', async (e, workId: number, content: string, critique: CritiqueResult) => {
    const report = formatCritiqueFixReport(critique)
    const styleSystem = buildStyleRewriteSystemPrompt(workId)
    const systemPrompt = [resolvePrompt('critique_apply_fixes.system'), styleSystem].join('\n\n')
    const prompt = [
      '【批判报告】',
      report,
      '',
      '【需要修改的原文】',
      content
    ].join('\n')
    const res = await modelService.chat({
      prompt,
      systemPrompt,
      workId,
      step: 'critique_apply_fixes',
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    }, { webContents: e.sender })
    return res.success
      ? { success: true, content: res.content }
      : { success: false, error: res.error }
  })

  // ==================== 章节质量诊断 ====================
  ipcMain.handle('quality:diagnose', (_e, workId: number, chapterId: number, content: string) =>
    diagnoseChapterQuality(workId, chapterId, content))

  ipcMain.handle('quality:diagnoseAI', async (e, workId: number, chapterId: number, content: string) => {
    const styleCtx = buildStyleDiagnosisContext(workId)
    const systemPrompt = styleCtx
      ? [resolvePrompt('quality_diagnosis_ai.system'), styleCtx].join('\n\n')
      : resolvePrompt('quality_diagnosis_ai.system')
    const res = await modelService.chat({
      prompt: content,
      systemPrompt,
      workId,
      chapterId,
      step: 'quality_diagnosis_ai',
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    }, { webContents: e.sender })
    return res.success
      ? { success: true, report: res.content }
      : { success: false, error: res.error }
  })

  ipcMain.handle('quality:applyFixes', async (e, workId: number, content: string, report: string) => {
    const styleSystem = buildStyleRewriteSystemPrompt(workId)
    const systemPrompt = [resolvePrompt('quality_apply_fixes.system'), styleSystem].join('\n\n')
    const prompt = [
      '【诊断报告】',
      report,
      '',
      '【需要修改的原文】',
      content
    ].join('\n')
    const res = await modelService.chat({
      prompt,
      systemPrompt,
      workId,
      step: 'body_style_rewrite',
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    }, { webContents: e.sender })
    return res.success
      ? { success: true, content: res.content }
      : { success: false, error: res.error }
  })

  // ==================== 反均值化引擎 ====================
  ipcMain.handle('antimean:surpriseScore', async (e, workId: number, content: string) => {
    const res = await modelService.chat({
      prompt: content,
      systemPrompt: SURPRISE_SYSTEM_PROMPT,
      workId,
      step: 'anti_mean_surprise',
      enrichWorkContext: false
    }, { webContents: e.sender })
    if (!res.success) return { success: false, error: res.error }
    return { success: true, ...parseSurpriseScore(res.content) }
  })

  ipcMain.handle('antimean:disruptor', async (e, workId: number, content: string) => {
    const res = await modelService.chat({
      prompt: content,
      systemPrompt: DISRUPTOR_SYSTEM_PROMPT,
      workId,
      step: 'anti_mean_disruptor',
      enrichWorkContext: false
    }, { webContents: e.sender })
    if (!res.success) return { success: false, error: res.error }
    return { success: true, ...parseDisruptorResponse(res.content) }
  })

  ipcMain.handle('antimean:genreDeviation', async (e, workId: number, content: string) => {
    const res = await modelService.chat({
      prompt: content,
      systemPrompt: GENRE_DEVIATION_PROMPT,
      workId,
      step: 'anti_mean_genre',
      enrichWorkContext: false
    }, { webContents: e.sender })
    if (!res.success) return { success: false, error: res.error }
    return { success: true, ...parseGenreDeviation(res.content) }
  })
}
