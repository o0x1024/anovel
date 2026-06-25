import { ipcMain } from 'electron'
import { foreshadowingDAO, characterSnapshotDAO, timelineDAO, anchorAlignmentDAO, anchorDAO, volumeChapterDAO, coreSettingDAO } from './db'
import type { AnchorRow, TimelineEventRow } from './db'
import { filterAnchorsForChapter } from './context/anchor-scope'
import { modelService } from './model'
import { buildNarrativeMemoryPrompt } from './context/narrative-memory'
import { buildWorkContext } from './context/work-context'
import { buildConsistencyReport } from './context/consistency-report'
import { checkWorldviewConsistency } from './context/worldview-check'
import {
  CRITIQUE_APPLY_FIXES_PROMPT,
  CRITIQUE_SYSTEM_PROMPT,
  formatCritiqueFixReport,
  parseCritiqueResponse,
  type CritiqueResult
} from './context/chapter-critique'
import {
  diagnoseChapterQuality,
  QUALITY_AI_SYSTEM_PROMPT,
  QUALITY_APPLY_FIXES_PROMPT,
  ADJUST_WORDS_EXPAND_PROMPT,
  ADJUST_WORDS_COMPRESS_PROMPT
} from './context/chapter-quality'

const QUALITY_PATCH_SYSTEM_PROMPT = [
  '你是文字编辑，只输出修复指令 JSON，绝不输出全文。',
  '',
  '【你的唯一任务】',
  '针对每条诊断问题，从原文中找到问题片段(evidence)，输出替换后的文本。',
  '只修改 evidence 涉及的片段，原文其余部分保持逐字不变——不要重写、不要润色、不要输出完整文章。',
  '',
  '【严格禁止】',
  '- 禁止输出完整原文或修改后的全文',
  '- 禁止输出任何 Markdown 标题、解释、分析或客套话',
  '- 禁止输出 "以下是修改后的文本" "修改如下" 等引导语',
  '- 禁止添加新的情节、对话或描写',
  '',
  '【输出格式 — 严格遵守】',
  '只输出一个 JSON 对象：',
  '{"patches":[{"find":"原文精确片段（含标点）","replace":"替换后文本"}]}',
  '',
  'find 规则：',
  '1. 必须是原文中精确存在的字符串，否则无法定位替换',
  '2. 长度 >= 10 字，若 evidence 太短需向两侧扩展到足够唯一',
  '3. 章末钩子修复时 find 取最后 200-500 字，replace 为改写后的结尾',
  '',
  '如果所有问题都已经很好、无需修改，输出：{"patches":[]}'
].join('\n')
import {
  buildStyleRewriteSystemPrompt,
  buildStyleDiagnosisContext,
  STYLE_REWRITE_INSTRUCTION
} from './context/anti-ai-rules'
import { parseQualityAiScoreReport, parseQualityAiPatchResponse, type QualityAiPatch, type QualityAiTopIssue } from '../shared/quality-ai-score'
import { loadWritingPlan } from './context/writing-plan'
import { bodyWordCountBounds, countWords } from '../shared/body-word-target'
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
  FORESHADOWING_RESOLVE_SYSTEM_PROMPT,
  parseMemoryExtract,
  applyMemoryExtract,
  parseForeshadowingResolutions,
  applyForeshadowingResolutions
} from './context/memory-extract'
import {
  cleanupDuplicateNarrativeMemory,
  clearChapterMemoryBeforeExtract
} from './context/memory-cleanup'
import { generationLogDAO } from './db'
import { parseStoryQualityAiScoreBreakdown } from '../shared/story-quality-score'
import { STORY_QUALITY_AI_SYSTEM_PROMPT } from './context/story-chapter-quality'
import { workDAO } from './db'
import type { MilestoneAuditResult, PassiveMonitorResult } from '../shared/milestone-audit'
import { incubatorVersionDAO } from './db/dao/incubator'
import { buildFrozenStorylineContext } from './context/incubator/build-storyline-context'

interface QualityGateSnapshot {
  fatalCount: number
  warningCount: number
}

function extractScoreTotal(report: string): number | null {
  const jsonMatch = report.match(/"(?:score_total|scoreTotal)"\s*:\s*(\d{1,3})/)
  if (jsonMatch) return Number(jsonMatch[1])
  const lineMatch = report.match(/总分[:：]\s*(\d{1,3})\s*\/\s*100/)
  if (lineMatch) return Number(lineMatch[1])
  return null
}

function extractHardFail(report: string): boolean | null {
  const jsonMatch = report.match(/"(?:hard_fail|hardFail)"\s*:\s*(true|false)/i)
  if (jsonMatch) return jsonMatch[1].toLowerCase() === 'true'
  const lineMatch = report.match(/硬失败[:：]\s*(true|false)/i)
  if (lineMatch) return lineMatch[1].toLowerCase() === 'true'
  return null
}

function reconcileQualityAiReport(
  report: string,
  gate: QualityGateSnapshot
): { report: string; scoreTotal: number; hardFail: boolean; capped: boolean } {
  const scoreFromReport = extractScoreTotal(report)
  const hardFailFromReport = extractHardFail(report)

  const capFromGate = gate.fatalCount > 0 ? 59 : gate.warningCount > 0 ? 79 : 100
  let scoreTotal = scoreFromReport == null ? capFromGate : Math.min(scoreFromReport, capFromGate)
  let hardFail = gate.fatalCount > 0 || hardFailFromReport === true
  if (hardFail && scoreTotal > 59) scoreTotal = 59

  let next = report
  let hasScoreSlot = false
  let hasHardFailSlot = false

  next = next.replace(/("(?:score_total|scoreTotal)"\s*:\s*)\d+/, (_m, p1: string) => {
    hasScoreSlot = true
    return `${p1}${scoreTotal}`
  })
  next = next.replace(/("(?:hard_fail|hardFail)"\s*:\s*)(true|false)/i, (_m, p1: string) => {
    hasHardFailSlot = true
    return `${p1}${hardFail}`
  })
  next = next.replace(/(-\s*总分[:：]\s*)\d+\s*\/\s*100/, (_m, p1: string) => {
    hasScoreSlot = true
    return `${p1}${scoreTotal}/100`
  })
  next = next.replace(/(-\s*硬失败[:：]\s*)(true|false)/i, (_m, p1: string) => {
    hasHardFailSlot = true
    return `${p1}${hardFail}`
  })

  const gateLine = `- 门禁对齐：致命 ${gate.fatalCount} 项，警告 ${gate.warningCount} 项`
  const capped = scoreFromReport != null && scoreTotal < scoreFromReport

  if (!hasScoreSlot || !hasHardFailSlot) {
    const prefix = [
      '## 量化评分结果（门禁对齐）',
      `- 总分：${scoreTotal}/100`,
      `- 硬失败：${hardFail}`,
      gateLine,
      ''
    ].join('\n')
    next = `${prefix}\n${next}`
  } else if (!next.includes('门禁对齐：')) {
    next = next.replace(/(##\s*量化评分结果[^\n]*\n(?:-[^\n]*\n){1,3})/, (_m, block: string) => {
      return `${block}${gateLine}\n`
    })
  }

  return { report: next, scoreTotal, hardFail, capped }
}

const ANCHOR_TYPE_LABELS: Record<string, string> = {
  scene: '场景锚点',
  character: '角色锚点',
  plot: '情节锚点',
  emotion: '情感锚点',
  structure: '结构锚点',
  memory: '记忆锚点',
  contrast: '反差锚点'
}

function buildAnchorDiagnosisSection(workId: number, chapterId: number): string | null {
  const allActive = anchorDAO.listActiveByWork(workId)
  if (allActive.length === 0) return null

  const chapter = volumeChapterDAO.getChapter(chapterId)
  let anchors: AnchorRow[]
  if (chapter) {
    anchors = filterAnchorsForChapter(allActive, chapter).applicable
  } else {
    anchors = allActive
  }
  if (anchors.length === 0) return null

  const lines = anchors.map((a, i) => {
    const label = ANCHOR_TYPE_LABELS[a.type] || `${a.type}锚点`
    return `${i + 1}. [${label}] ${a.title}：${a.content}`
  })

  return [
    '【本章创作锚点 — 请逐条评估对齐情况】',
    ...lines
  ].join('\n')
}

const PREV_CHAPTER_SUMMARY_CHARS = 800

function buildContentLogicContext(workId: number, chapterId: number): string | null {
  const sections: string[] = []

  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (chapter?.outline?.trim()) {
    sections.push(`【本章大纲】\n${chapter.outline.trim()}`)
  }

  if (chapter?.characters?.trim()) {
    sections.push(`【本章出场角色】\n${chapter.characters.trim()}`)
  }

  const allChapters = volumeChapterDAO.listChaptersByWork(workId)
  const idx = allChapters.findIndex(c => c.id === chapterId)
  if (idx > 0) {
    for (let i = idx - 1; i >= 0; i--) {
      const prev = allChapters[i]
      const prevContent = prev.content?.trim()
      if (prevContent) {
        const tail = prevContent.length > PREV_CHAPTER_SUMMARY_CHARS
          ? `…（前文省略）\n${prevContent.slice(-PREV_CHAPTER_SUMMARY_CHARS)}`
          : prevContent
        sections.push(`【上一章末尾 — ${prev.title}】\n${tail}`)
        break
      }
    }
  }

  const coreSettings = coreSettingDAO.listByWork(workId)
  const charSetting = coreSettings.find(s => s.type === 'character')
  const worldSetting = coreSettings.find(s => s.type === 'worldview')
  const coreLines: string[] = []
  if (charSetting?.content?.trim()) {
    const trimmed = charSetting.content.trim()
    coreLines.push(trimmed.length > 600 ? trimmed.slice(0, 600) + '…' : trimmed)
  }
  if (worldSetting?.content?.trim()) {
    const trimmed = worldSetting.content.trim()
    coreLines.push(trimmed.length > 600 ? trimmed.slice(0, 600) + '…' : trimmed)
  }
  if (coreLines.length) {
    sections.push(`【核心设定摘要】\n${coreLines.join('\n\n')}`)
  }

  if (sections.length === 0) return null
  return ['【章节上下文 — 供内容逻辑诊断参考】', ...sections].join('\n\n')
}

/**
 * 章节 AI 质量诊断（主进程函数）。
 * 从 quality:diagnoseAI IPC 下沉而来，sender 可选：不传则 headless 运行（供目标循环 checker 调用）。
 */
export async function diagnoseChapterQualityAi(
  workId: number,
  chapterId: number,
  content: string,
  modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean; wordTarget?: number },
  sender?: import('electron').WebContents
): Promise<{ success: boolean; error?: string; report?: string; scoreTotal?: number; hardFail?: boolean; cappedByGate?: boolean; scoreBreakdown?: unknown }> {
  const gate = diagnoseChapterQuality(workId, chapterId, content)
  const styleCtx = buildStyleDiagnosisContext(workId)
  const workInfo = workDAO.getById(workId)
  const isStory = workInfo?.work_type === 'story'

  const basePrompt = isStory ? STORY_QUALITY_AI_SYSTEM_PROMPT : QUALITY_AI_SYSTEM_PROMPT
  const systemPrompt = styleCtx
    ? [basePrompt, styleCtx].join('\n\n')
    : basePrompt

  const resolvedWordTarget = modelOpts?.wordTarget ?? loadWritingPlan(workId).wordsPerChapter
  const anchorSection = buildAnchorDiagnosisSection(workId, chapterId)
  const sections = [content]
  if (resolvedWordTarget > 0) {
    const { min, max } = bodyWordCountBounds(resolvedWordTarget)
    const actualChars = countWords(content)
    const deviation = Math.round(((actualChars - resolvedWordTarget) / resolvedWordTarget) * 100)
    const deviationLabel = deviation > 25 ? '严重超标' : deviation > 10 ? '轻微超标' : deviation < -25 ? '严重不足' : deviation < -10 ? '轻微不足' : '达标'
    sections.push(
      `\n【目标字数诊断数据 - 已由系统预计算，直接使用，禁止自行重新计数】`,
      `目标：约 ${resolvedWordTarget} 字（允许 ±10%，即 ${min}–${max} 字）`,
      `实际字数（含标点，不含空白）：${actualChars} 字`,
      `偏差：${deviation > 0 ? '+' : ''}${deviation}%（${deviationLabel}）`
    )
  }
  if (anchorSection) sections.push('', anchorSection)
  if (!isStory) {
    const logicCtx = buildContentLogicContext(workId, chapterId)
    if (logicCtx) sections.push('', logicCtx)
  }
  const prompt = sections.join('\n')

  const res = await modelService.chat({
    prompt,
    systemPrompt,
    workId,
    chapterId,
    step: 'quality_diagnosis_ai',
    enrichWorkContext: false,
    enrichNarrativeMemory: false,
    modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
    modelName: modelOpts?.modelName,
    thinkingEnabled: modelOpts?.thinkingEnabled
  }, sender ? { webContents: sender } : { stream: false })
  if (!res.success) return { success: false, error: res.error }

  const reconciled = reconcileQualityAiReport(res.content, {
    fatalCount: gate.fatalCount,
    warningCount: gate.warningCount
  })
  const parsed = isStory
    ? parseStoryQualityAiScoreBreakdown(reconciled.report)
    : parseQualityAiScoreReport(reconciled.report)

  const scoreBreakdown = parsed
    ? { ...parsed, scoreTotal: reconciled.scoreTotal, hardFail: reconciled.hardFail }
    : null

  if (parsed?.anchorAlignment?.length) {
    const activeAnchors = anchorDAO.listActiveByWork(workId)
    for (const item of parsed.anchorAlignment) {
      const anchor = activeAnchors.find(a => a.title === item.title)
      if (!anchor) continue
      const level = item.verdict === 'aligned' ? 2 : item.verdict === 'partial' ? 1 : 0
      anchorAlignmentDAO.log({
        anchor_id: anchor.id,
        chapter_id: chapterId,
        step: 'quality_diagnosis_ai',
        aligned: level,
        detail: `${item.verdict} — ${item.reason}`
      })
    }
  }

  return {
    success: true,
    report: reconciled.report,
    scoreTotal: reconciled.scoreTotal,
    hardFail: reconciled.hardFail,
    cappedByGate: reconciled.capped,
    scoreBreakdown
  }
}

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

function parseTimelineGeneration(content: string): Array<{
  event_name: string
  event_description: string
  absolute_time: string | null
  relative_time: string | null
  chapter_id: number | null
}> {
  const match = content.match(/```json\s*([\s\S]*?)```/)
  try {
    const parsed = JSON.parse(match?.[1] ?? content) as {
      events?: Array<{
        event_name?: string
        event_description?: string
        absolute_time?: string
        relative_time?: string
        chapter_id?: number
      }>
    }
    return (parsed.events ?? [])
      .filter(e => e.event_name?.trim())
      .map(e => ({
        event_name: e.event_name!.trim(),
        event_description: e.event_description?.trim() ?? '',
        absolute_time: e.absolute_time?.trim() ?? null,
        relative_time: e.relative_time?.trim() ?? null,
        chapter_id: typeof e.chapter_id === 'number' ? e.chapter_id : null
      }))
  } catch {
    return []
  }
}

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

  ipcMain.handle('timeline:generate', async (e, workId: number, modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean }) => {
    const chapters = volumeChapterDAO.listChaptersByWork(workId)
    if (chapters.length === 0) {
      return { success: false, error: '作品暂无章节，无法生成时间线' }
    }

    const chapterContext = chapters.map((ch, i) => {
      const parts: string[] = []
      parts.push(`章节${i + 1}：《${ch.title}》（分卷：${ch.volume_name}）`)
      if (ch.outline?.trim()) parts.push(`  大纲：${ch.outline.trim()}`)
      if (ch.beat_role) parts.push(`  节奏角色：${ch.beat_role}`)
      if (ch.content?.trim()) {
        const truncated = ch.content.trim().slice(0, 500)
        parts.push(`  正文开头：${truncated}${ch.content.trim().length > 500 ? '…' : ''}`)
      }
      return parts.join('\n')
    }).join('\n\n')

    const workCtx = buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true })

    const systemPrompt = [
      '你是专业的小说编辑，擅长分析叙事结构并提取时间线事件。',
      '',
      '【任务】分析所有章节，提取关键时间线事件。时间线事件是故事中具有因果关系、推动情节发展的重大时刻。',
      '',
      '【输出格式 — 仅输出 JSON，不输出其他内容】',
      '{"events": [{',
      '  "event_name": "事件名称（简短，10字以内）",',
      '  "event_description": "事件描述（一句话，30字以内）",',
      '  "absolute_time": "绝对时间（如：第三天上午、一个月后）或 null",',
      '  "relative_time": "相对时间（如：主角离开后2小时）或 null",',
      '  "chapter_id": 章节编号（数字，对应上方「章节N」的 N）',
      '}]}',
      '',
      '【规则】',
      '1. 事件按时间顺序排列',
      '2. 每个章节提取 2-5 个关键事件',
      '3. 只包含推动情节的重大事件，忽略日常过渡和次要细节',
      '4. absolute_time 和 relative_time 至少填写一个',
      '5. chapter_id 必须对应上方标注的章节编号'
    ].join('\n')

    const prompt = [
      workCtx ? `【作品背景】\n${workCtx.text.slice(0, 2000)}` : '',
      '【所有章节】',
      chapterContext,
      '',
      '请分析以上所有章节，按 JSON 格式输出完整的时间线事件列表。'
    ].filter(Boolean).join('\n\n')

    const res = await modelService.chat({
      prompt,
      systemPrompt,
      workId,
      step: 'timeline_generate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })

    if (!res.success) return { success: false, error: res.error }

    const events = parseTimelineGeneration(res.content)
    if (events.length === 0) {
      return { success: false, error: 'AI 未能生成有效的时间线事件，请重试' }
    }

    timelineDAO.deleteByWork(workId)
    const created: TimelineEventRow[] = []
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]
      const id = timelineDAO.create({
        work_id: workId,
        event_name: ev.event_name,
        event_description: ev.event_description || undefined,
        absolute_time: ev.absolute_time || undefined,
        relative_time: ev.relative_time || undefined,
        chapter_id: ev.chapter_id ?? undefined,
        sort_order: i + 1
      })
      const row = timelineDAO.getById(id)
      if (row) created.push(row)
    }

    return { success: true, events: created, totalGenerated: events.length }
  })

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

  ipcMain.handle('memory:extractFromChapter', async (e, workId: number, chapterId: number, content: string, modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean }) => {
    const res = await modelService.chat({
      prompt: content,
      systemPrompt: MEMORY_EXTRACT_SYSTEM_PROMPT,
      workId,
      chapterId,
      step: 'memory_extract',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })
    if (!res.success) return { success: false, error: res.error, planted: 0, resolved: 0, snapshots: 0 }
    const extracted = parseMemoryExtract(res.content)
    const cleared = clearChapterMemoryBeforeExtract(workId, chapterId)
    const result = applyMemoryExtract(workId, chapterId, extracted)
    return { success: true, ...result, replaced: cleared }
  })

  // ==================== AI 伏笔回收检测（替换硬编码 8 字匹配） ====================
  ipcMain.handle('foreshadowing:detectResolutions', async (e, workId: number, chapterId: number, content: string, modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean }) => {
    const pending = foreshadowingDAO.listPending(workId)
    if (!pending.length) return { success: true, resolved: 0, partial: 0, message: '无待回收伏笔' }

    const pendingList = pending.map(p =>
      `- [id:${p.id}] depth:${p.depth ?? 'normal'} 描述：${p.description}`
    ).join('\n')

    const prompt = [
      '【待回收伏笔列表】',
      pendingList,
      '',
      '【本章内容】',
      content.slice(0, 8000)  // 截断超长章节，伏笔回收信息通常在后半段
    ].join('\n')

    const res = await modelService.chat({
      prompt,
      systemPrompt: FORESHADOWING_RESOLVE_SYSTEM_PROMPT,
      workId,
      chapterId,
      step: 'foreshadowing_resolve',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })

    if (!res.success) return { success: false, error: res.error }

    const parsed = parseForeshadowingResolutions(res.content)
    const applied = applyForeshadowingResolutions(workId, chapterId, parsed)

    return {
      success: true,
      ...applied,
      total: pending.length
    }
  })

  ipcMain.handle('memory:cleanupDuplicates', (_e, workId: number) =>
    cleanupDuplicateNarrativeMemory(workId))

  // ==================== 生成-批判双通道 ====================
  ipcMain.handle('critique:run', async (e, workId: number, content: string, chapterId?: number, modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean }) => {
    const res = await modelService.chat({
      prompt: content,
      systemPrompt: CRITIQUE_SYSTEM_PROMPT,
      workId,
      chapterId,
      step: 'critique_dual_channel',
      enrichWorkContext: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
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

  ipcMain.handle('critique:applyFixes', async (e, workId: number, content: string, critique: CritiqueResult, modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean }) => {
    const workInfo = workDAO.getById(workId)
    const isStory = workInfo?.work_type === 'story'

    if (isStory) {
      const filteredIssues = (critique.issues || []).filter(issue => issue.evidence?.trim())
      if (!filteredIssues.length) {
        return { success: true, content: content }
      }
      
      const issueLines = filteredIssues.map((issue, i) =>
        `${i + 1}. [${issue.dimension}] evidence: "${issue.evidence}" → fixHint: ${issue.suggestion}`
      ).join('\n')

      const prompt = [
        '【诊断问题列表（只修复以下问题，其余保持原文不变）】',
        issueLines,
        '',
        '【原文】',
        content
      ].join('\n')

      const res = await modelService.chat({
        prompt,
        systemPrompt: QUALITY_PATCH_SYSTEM_PROMPT,
        workId,
        step: 'critique_apply_fixes',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
        modelName: modelOpts?.modelName,
        thinkingEnabled: modelOpts?.thinkingEnabled
      }, { webContents: e.sender })

      if (!res.success) return { success: false, error: res.error }

      let patches: QualityAiPatch[] = []
      try {
        patches = parseQualityAiPatchResponse(res.content)
      } catch {
        // ignore
      }

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
        return { success: true, content: content }
      }

      let patchedText = content
      for (const patch of patches) {
        if (!patch.find) continue
        const idx = patchedText.indexOf(patch.find)
        if (idx === -1) continue
        patchedText = patchedText.slice(0, idx) + patch.replace + patchedText.slice(idx + patch.find.length)
      }
      return { success: true, content: patchedText }
    }

    const report = formatCritiqueFixReport(critique)
    const styleSystem = buildStyleRewriteSystemPrompt(workId)
    const systemPrompt = [CRITIQUE_APPLY_FIXES_PROMPT, styleSystem].join('\n\n')
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
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })
    return res.success
      ? { success: true, content: res.content }
      : { success: false, error: res.error }
  })

  // ==================== 章节质量诊断 ====================
  ipcMain.handle('quality:diagnose', (_e, workId: number, chapterId: number, content: string) =>
    diagnoseChapterQuality(workId, chapterId, content))

  ipcMain.handle('quality:diagnoseAI', async (e, workId: number, chapterId: number, content: string, modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean; wordTarget?: number }) =>
    diagnoseChapterQualityAi(workId, chapterId, content, modelOpts, e.sender))

  ipcMain.handle('quality:applyFixes', async (e, workId: number, content: string, report: string, modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean; wordTarget?: number }) => {
    const systemPrompt = [QUALITY_APPLY_FIXES_PROMPT, STYLE_REWRITE_INSTRUCTION].join('\n\n')
    const resolvedWordTarget = modelOpts?.wordTarget ?? loadWritingPlan(workId).wordsPerChapter
    const wordTargetSection = resolvedWordTarget > 0
      ? `\n【目标字数】${resolvedWordTarget} 字（允许 ±10%，即 ${bodyWordCountBounds(resolvedWordTarget).min}–${bodyWordCountBounds(resolvedWordTarget).max} 字）\n`
      : ''
    const prompt = [
      '【诊断报告】',
      report,
      wordTargetSection,
      '【需要修改的原文】',
      content
    ].join('\n')
    const res = await modelService.chat({
      prompt,
      systemPrompt,
      workId,
      step: 'body_style_rewrite',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })
    return res.success
      ? { success: true, content: res.content }
      : { success: false, error: res.error }
  })

  ipcMain.handle('quality:adjustWordCount', async (e, workId: number, content: string, action: 'expand' | 'compress', modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean; wordTarget?: number }) => {
    if (!content?.trim()) return { success: false, error: '章节内容为空，无法调整字数。' }
    
    const systemPrompt = action === 'expand' ? ADJUST_WORDS_EXPAND_PROMPT : ADJUST_WORDS_COMPRESS_PROMPT
    const resolvedWordTarget = modelOpts?.wordTarget ?? loadWritingPlan(workId).wordsPerChapter
    const wordTargetSection = resolvedWordTarget > 0
      ? `\n【目标字数】将字数调整至：约 ${resolvedWordTarget} 字（允许 ±10%，即 ${bodyWordCountBounds(resolvedWordTarget).min}–${bodyWordCountBounds(resolvedWordTarget).max} 字）\n`
      : ''
    
    const prompt = [
      wordTargetSection,
      '【原文】',
      content
    ].join('\n')

    const res = await modelService.chat({
      prompt,
      systemPrompt,
      workId,
      step: 'body_style_rewrite',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })

    return res.success
      ? { success: true, content: res.content }
      : { success: false, error: res.error }
  })

  function fuzzyReplace(content: string, find: string, replace: string): string | null {
    if (!find?.trim()) return null
    // 1. 优先尝试精确匹配
    const exactIdx = content.indexOf(find)
    if (exactIdx !== -1) {
      return content.slice(0, exactIdx) + replace + content.slice(exactIdx + find.length)
    }

    // 2. 尝试空白/换行自适应匹配
    const escapedFind = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = escapedFind.trim().replace(/\s+/g, '\\s+')
    try {
      const regex = new RegExp(pattern, 'm')
      const match = content.match(regex)
      if (match && match.index !== undefined) {
        return content.slice(0, match.index) + replace + content.slice(match.index + match[0].length)
      }
    } catch {
      // 忽略无效的正则异常
    }
    return null
  }

  // ==================== Patch 模式修复（精准替换，不重写全文） ====================
  ipcMain.handle('quality:applyPatches', async (e, workId: number, content: string, topIssues: QualityAiTopIssue[], modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean; wordTarget?: number }) => {
    if (!content?.trim()) return { success: false, error: '原文为空' }
    
    // 过滤掉关于字数问题的 Issue，因为字数调整属于全局性重构，无法通过局部 Patch 模式完成
    const filteredIssues = (topIssues || []).filter(issue => issue.id !== 'word_count' && issue.id !== 'wordCount')
    if (!filteredIssues.length) {
      return { success: true, patchedText: content, appliedCount: 0, patches: [] }
    }

    const issueLines = filteredIssues.map((issue, i) =>
      `${i + 1}. [${issue.id}] evidence: "${issue.evidence}" → fixHint: ${issue.fixHint}`
    ).join('\n')

    const prompt = [
      '【诊断问题列表（只修复以下问题，其余保持原文不变）】',
      issueLines,
      '',
      '【原文】',
      content
    ].join('\n')

    const res = await modelService.chat({
      prompt,
      systemPrompt: QUALITY_PATCH_SYSTEM_PROMPT,
      workId,
      step: 'body_style_rewrite',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })

    if (!res.success) return { success: false, error: res.error, patchedText: content, appliedCount: 0, patches: [] }

    let patches: QualityAiPatch[] = []
    try {
      patches = parseQualityAiPatchResponse(res.content)
    } catch {
      // 解析异常继续走回退，不中断
    }

    // 智能回退：AI 没输出 patch JSON，但返回了大量文本 → 当作全文重写
    if (!patches.length && res.content.trim().length > 200) {
      console.log('[quality:applyPatches] AI 未输出 patch JSON，使用全文作为单 patch')
      const rewritten = res.content.trim()
      const cleaned = rewritten
        .replace(/^.*?(?:以下是|修改后|修订后|优化后)[^\n]*[:：]?\s*\n+/i, '')
        .trim()
      if (cleaned.length > 50 && cleaned !== content.trim()) {
        patches = [{ find: content.trim(), replace: cleaned }]
      }
    }

    if (!patches.length) {
      return { success: true, patchedText: content, appliedCount: 0, patches: [] }
    }

    let patchedText = content
    const applied: QualityAiPatch[] = []
    for (const patch of patches) {
      if (!patch.find) continue
      const nextText = fuzzyReplace(patchedText, patch.find, patch.replace)
      if (nextText === null) continue
      patchedText = nextText
      applied.push(patch)
    }

    console.log(`[quality:applyPatches] 应用 ${applied.length}/${patches.length} 个 patch`)
    return { success: true, patchedText, appliedCount: applied.length, patches: applied }
  })

  ipcMain.handle('quality:applyLocalPatches', (_e, content: string, patches: { find: string; replace: string }[]) => {
    if (!content?.trim()) return { success: false, error: '原文为空' }
    let patchedText = content
    const applied: { find: string; replace: string }[] = []
    for (const patch of patches) {
      if (!patch.find) continue
      const nextText = fuzzyReplace(patchedText, patch.find, patch.replace)
      if (nextText === null) {
        console.warn(`[applyLocalPatches] 未能定位到原文片段: "${patch.find}"`)
        continue
      }
      patchedText = nextText
      applied.push(patch)
    }
    return { success: true, patchedText, appliedCount: applied.length, patches: applied }
  })

  // ==================== 自动优化配置 ====================
  ipcMain.handle('quality:getAutoOptimizeConfig', () => {
    return appPreferenceDAO.getAutoOptimizeConfig()
  })

  ipcMain.handle('quality:setAutoOptimizeConfig', (_e, config: Record<string, unknown>) => {
    const parsed: { enabled?: boolean; maxIterations?: number; targetTotalScore?: number; stopOnHardFail?: boolean } = {
      enabled: typeof config.enabled === 'boolean' ? config.enabled : undefined,
      maxIterations: typeof config.maxIterations === 'number' ? config.maxIterations : undefined,
      targetTotalScore: typeof config.targetTotalScore === 'number' ? config.targetTotalScore : undefined,
      stopOnHardFail: typeof config.stopOnHardFail === 'boolean' ? config.stopOnHardFail : undefined
    }
    return appPreferenceDAO.setAutoOptimizeConfig(parsed)
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

  // ==================== 里程碑 AI 深度审计 ====================
  const MILESTONE_AUDIT_SYSTEM_PROMPT = [
    '你是资深网文结构编辑。对比原始主线设定与当前已写章节，做全链路深度审计。',
    '',
    '审计维度：',
    '1. 主线偏离：当前剧情走向是否偏离原始主冲突轴与终局结构？',
    '2. 角色崩塌：主角行为逻辑是否与原始角色驱动一致？配角功能是否退化？',
    '3. 节奏塌方：是否存在连续章节无有效冲突推进或明显注水？',
    '4. 伏笔黑洞：深伏笔是否长期未回收？新伏笔是否过度堆积？',
    '5. 逻辑矛盾：跨章之间是否存在时间线/地点/能力/规则矛盾？',
    '6. 重复模式：是否出现换地图打怪式结构重复？爽点类型单一化？',
    '7. 终局对齐：当前走向是否还能自然收束到原始终局结构？',
    '',
    '输出严格 JSON：',
    '{"verdict":"pass|warning|blocking","drift_score":0,"summary":"一句话总结","strengths":["优点"],"issues":[{"dimension":"主线偏离","severity":"warning","evidence":"第X章...","suggestion":"建议..."}]}',
    'verdict: blocking=严重偏离须立即纠正 warning=有偏移趋势 pass=基本对齐',
    'drift_score: 0=完全对齐 100=完全失控',
    'issues 仅列实际问题，不要为凑数编造。'
  ].join('\n')

  ipcMain.handle('milestone:audit', async (e, workId: number, modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean }) => {
    const frozenCtx = buildFrozenStorylineContext(workId, { includeSlots: true })
    const storylineSection = frozenCtx || '（尚无冻结主线，请先在大岗孵化中完成并冻结）'

    const allChapters = volumeChapterDAO.listChaptersByWork(workId)
    const withContent = allChapters.filter(c => c.content?.trim())
    if (!withContent.length) return { success: false, error: '尚无已写章节' }

    // ===== Phase 1: 大纲扫描（>200章时按卷分组，避免 AI 注意力稀释） =====
    let outlineSection: string
    const TOO_MANY = 200
    if (allChapters.length > TOO_MANY) {
      // 按卷分组，每卷生成摘要
      const volumes = volumeChapterDAO.listVolumes(workId)
      const volGroups = new Map<number, typeof allChapters>()
      for (const ch of allChapters) {
        const vid = ch.volume_id ?? 0
        if (!volGroups.has(vid)) volGroups.set(vid, [])
        volGroups.get(vid)!.push(ch)
      }
      const volLines: string[] = []
      for (const [vid, chs] of volGroups) {
        const volName = volumes.find(v => v.id === vid)?.name ?? '未分卷'
        const firstIdx = allChapters.indexOf(chs[0]) + 1
        const lastIdx = allChapters.indexOf(chs[chs.length - 1]) + 1
        const emotionSummary = chs.map(c => c.emotion_intensity ?? 5)
        const avgEmo = Math.round(emotionSummary.reduce((a, b) => a + b, 0) / emotionSummary.length)
        const outlines = chs.slice(0, 5).map(c => c.outline?.slice(0, 50)).filter(Boolean).join(' | ')
        volLines.push(`- [卷${vid}] ${volName}：第${firstIdx}-${lastIdx}章（${chs.length}章）平均情绪${avgEmo}${outlines ? ' | ' + outlines : ''}`)
      }
      outlineSection = `【分卷摘要（共${volGroups.size}卷，${allChapters.length}章）】\n${volLines.join('\n')}`
    } else {
      outlineSection = allChapters
        .map(c => {
          const idx = allChapters.indexOf(c) + 1
          return `- [${idx}] ${c.title}${c.outline ? '：' + c.outline.slice(0, 80) : ''}${c.emotion_intensity ? ' 情绪:' + c.emotion_intensity : ''}`
        })
        .join('\n')
      outlineSection = `【全部章节大纲（共${allChapters.length}章）】\n${outlineSection}`
    }

    const pendingF = foreshadowingDAO.listByWork(workId).filter(f => f.status === 'pending' || f.status === 'partial')
    const snapshotNames = characterSnapshotDAO.listCharacterNames(workId)

    const scanPrompt = [
      '【原始主线设定（冻结版）】', storylineSection, '',
      outlineSection, '',
      `统计：待回收伏笔${pendingF.length} · 追踪角色${snapshotNames.length}`,
      '',
      allChapters.length > 200
        ? '请根据各卷摘要与主线的偏离度、情绪异常、角色轨迹，标记1-3个最需要深度审计的卷，输出该卷中可疑的5-8个章节编号。'
        : '请根据大纲与主线的偏离度、情绪节奏异常、角色轨迹可疑度，输出需要深度审计的章节编号列表。',
      '输出 JSON：{"suspectChapterIds":[3,15,22,...]}（按优先级排序，最多8章）'
    ].join('\n')

    const scanRes = await modelService.chat({
      prompt: scanPrompt,
      systemPrompt: '你是网文结构编辑。根据章节大纲快速判断哪些章节最可能存在主线偏离、角色崩塌或逻辑矛盾。只输出 JSON。',
      workId,
      step: 'milestone_audit_scan',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })

    let suspectIds: number[] = []
    if (scanRes.success) {
      try {
        const t = scanRes.content.trim()
        const f = t.match(/```(?:json)?\s*([\s\S]*?)```/) ?? t.match(/(\{[\s\S]*\})/)
        const parsed = JSON.parse(f?.[1] ?? f?.[0] ?? t) as { suspectChapterIds?: number[] }
        suspectIds = (parsed.suspectChapterIds ?? []).filter(id => withContent.some(c => c.id === id))
      } catch { /* fall through */ }
    }
    // 如果 AI 扫描失败或返回空，回退到最近 5 章
    if (!suspectIds.length) {
      suspectIds = withContent.slice(-5).map(c => c.id)
    }
    // 始终包含最近 3 章
    const recentIds = withContent.slice(-3).map(c => c.id)
    const deepDiveIds = [...new Set([...suspectIds, ...recentIds])]

    // ===== Phase 2: 深度审计可疑章节 =====
    const deepChapters = withContent.filter(c => deepDiveIds.includes(c.id))
    const chapterLines = deepChapters.map(ch => {
      const idx = allChapters.indexOf(ch) + 1
      return `## 第${idx}章 ${ch.title}\n${(ch.content ?? '').slice(0, 1500)}${(ch.content ?? '').length > 1500 ? '…' : ''}`
    })

    const foreshadowingSection = pendingF.length > 0
      ? ['【待回收伏笔】', ...pendingF.slice(0, 15).map(f =>
          `- [${f.depth ?? 'normal'}] ${f.description}（埋于第${f.plant_chapter_id ?? '?'}章）`
        )].join('\n')
      : '（无待回收伏笔）'

    const snapshotSection = snapshotNames.length > 0
      ? ['【角色最新状态】', ...snapshotNames.map(name => {
          const s = characterSnapshotDAO.getLatest(workId, name)
          if (!s) return null
          return `- ${name}：${[s.location, s.mental_state, s.relationship_changes].filter(Boolean).join(' | ') || '无记录'}`
        }).filter((x): x is string => x !== null)].join('\n')
      : '（无角色快照）'

    const prompt = [
      '【原始主线设定（冻结版）】', storylineSection, '',
      `【深度审计章节（共${withContent.length}章，AI筛选${deepChapters.length}章重点审查）】`, ...chapterLines, '',
      foreshadowingSection, '',
      snapshotSection, '',
      `统计：总章节${allChapters.length} · 待回收伏笔${pendingF.length} · 追踪角色${snapshotNames.length}`
    ].join('\n')

    const res = await modelService.chat({
      prompt,
      systemPrompt: MILESTONE_AUDIT_SYSTEM_PROMPT,
      workId,
      step: 'milestone_audit_deep',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })

    if (!res.success) return { success: false, error: res.error }

    let audit: MilestoneAuditResult | null = null
    try {
      const trimmed = res.content.trim()
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
      audit = JSON.parse(fenced?.[1] ?? trimmed) as MilestoneAuditResult
    } catch {
      return { success: false, error: '审计结果解析失败，请重试' }
    }

    const monitor: PassiveMonitorResult = computePassiveMonitor(workId)
    return { success: true, audit, monitor, scannedChapters: allChapters.length, deepDivedChapters: deepChapters.length }
  })
}

  // ==================== 锚点自动匹配 ====================
  const ANCHOR_MATCH_SYSTEM_PROMPT = [
    '你是锚点-章节匹配器。为每个锚点找到最相关的章节或分卷。',
    '',
    '规则：',
    '- 每个锚点绑定 0-1 个章节（通过 chapterId）或分卷（通过 volumeId）',
    '- 如果锚点描述是某一章大纲的核心事件 → bind 到该章',
    '- 如果锚点跨越多章 → bind 到首次出现章节或所在分卷',
    '- 如果锚点无法确定归属 → 不绑定',
    '- 全书级(scope=work)的锚点不需要绑定',
    '',
    '输出严格 JSON：',
    '{"bindings":[{"anchorId":1,"chapterId":103,"volumeId":null,"reason":"该场景与本章大纲完全一致"}]}',
    'chapterId 和 volumeId 至少一个为 null'
  ].join('\n')

  ipcMain.handle('anchor:autoMatch', async (e, workId: number, modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean }) => {
    const allAnchors = anchorDAO.listByWork(workId).filter(a => a.is_active === 1)
    const unbound = allAnchors.filter(a => a.scope !== 'work' && !a.target_chapter_id && !a.target_volume_id)
    if (!unbound.length) return { success: true, matched: 0, message: '所有锚点已绑定或为全书级' }

    const chapters = volumeChapterDAO.listChaptersByWork(workId).filter(c => c.outline?.trim() || c.title?.trim())
    if (!chapters.length) return { success: true, matched: 0, message: '尚无章节大纲，无法匹配' }

    const anchorLines = unbound.map(a =>
      `- [id:${a.id}] [${a.type}]${a.scope ? `[${a.scope}]` : ''} ${a.title}：${a.content.slice(0, 150)}`
    ).join('\n')

    const chapterLines = chapters.map(ch => {
      const volLabel = ch.volume_id ? `[卷${ch.volume_id}]` : ''
      return `- id:${ch.id} ${volLabel} ${ch.title}${ch.outline ? '：' + ch.outline.slice(0, 200) : ''}`
    }).join('\n')

    const prompt = [
      '【待匹配锚点】', anchorLines, '',
      '【可用章节】', chapterLines
    ].join('\n')

    const res = await modelService.chat({
      prompt,
      systemPrompt: ANCHOR_MATCH_SYSTEM_PROMPT,
      workId,
      step: 'anchor_auto_match',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })

    if (!res.success) return { success: false, error: res.error }

    let bindings: { anchorId: number; chapterId: number | null; volumeId: number | null; reason: string }[] = []
    try {
      const trimmed = res.content.trim()
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
      const parsed = JSON.parse(fenced?.[1] ?? trimmed) as { bindings?: typeof bindings }
      bindings = parsed.bindings ?? []
    } catch {
      return { success: false, error: 'AI 匹配结果解析失败' }
    }

    let matched = 0
    for (const b of bindings) {
      if (!b.anchorId) continue
      const anchor = anchorDAO.getById(b.anchorId)
      if (!anchor || anchor.work_id !== workId) continue
      anchorDAO.update(b.anchorId, {
        target_chapter_id: b.chapterId ?? null,
        target_volume_id: b.volumeId ?? null
      })
      matched++
    }

    return { success: true, matched, details: bindings.slice(0, 20) }
  })

  // ==================== 审计自动修复（章节正文） ====================
  const AUDIT_FIX_SYSTEM_PROMPT = [
    '你是资深网文编辑。根据审计发现的问题，对已写章节正文进行精准修复。',
    '',
    '核心原则：问题出在章节正文里，修复目标就是章节正文。不要建议改大纲或设定——除非问题本质是设定本身有误。',
    '',
    '每条问题包含 dimension（问题类型）、evidence（文中证据）、suggestion（修复建议）。',
    '你需要为每个可修复的问题输出具体的章节级 patch。',
    '',
    '修复策略：',
    '- 逻辑矛盾：找出矛盾涉及的两处正文，修改其中一处使其一致',
    '- 角色崩塌：修改角色行为描写的具体段落，使其符合原始设定',
    '- 主线偏离：在偏离章节中插入/修改 1-2 段过渡文字，重新锚定主线',
    '- 重复模式：合并或删减重复段落，增加变化',
    '',
    '输出 JSON：',
    '{',
    '  "chapterPatches": [',
    '    {',
    '      "chapterId": 章节ID,',
    '      "reason": "为什么修改这一章",',
    '      "patches": [',
    '        {"find": "原文精确片段（>=15字）", "replace": "修改后文本"}',
    '      ]',
    '    }',
    '  ],',
    '  "foreshadowingActions": [',
    '    {"id": 伏笔ID, "action": "resolve|partial|abandon", "reason": "原因"}',
    '  ],',
    '  "advice": "无法自动修复的结构性建议（可选）"',
    '}',
    '',
    'find 必须是原文中精确匹配的字符串（含标点），否则前端无法定位。',
    '若某问题无法通过章节 patch 修复，不要强行编造 patch。'
  ].join('\n')

  ipcMain.handle('milestone:autoFix', async (e, workId: number, issues: import('../shared/milestone-audit').AuditIssue[], modelOpts?: { modelType?: string; modelName?: string; thinkingEnabled?: boolean }) => {
    if (!issues?.length) return { success: false, error: '无待修复问题' }

    // 构建修复上下文
    const issueLines = issues.map((iss, i) =>
      `${i + 1}. [${iss.dimension}] ${iss.evidence}\n   建议：${iss.suggestion}`
    ).join('\n\n')

    // 伏笔上下文
    const allForeshadowing = foreshadowingDAO.listByWork(workId)
    const pendingF = allForeshadowing.filter(f => f.status === 'pending' || f.status === 'partial')
    const foreshadowingCtx = pendingF.length > 0
      ? ['\n【待回收伏笔】', ...pendingF.map(f => `- id:${f.id} depth:${f.depth ?? 'normal'} ${f.description}`)].join('\n')
      : ''

    // 智能选取相关章节：最近 5 章全文 + 其余仅标题大纲（避免 100 章时爆上下文）
    const allChapters = volumeChapterDAO.listChaptersByWork(workId)
    const withContent = allChapters.filter(c => c.content?.trim())
    const recentChapters = withContent.slice(-5)
    const olderChapters = withContent.slice(0, -5)

    const chapterSections: string[] = []
    // 最近 5 章：完整内容（每章截取前 2000 字）
    for (const c of recentChapters) {
      chapterSections.push(`\n### 第${c.id}章 ${c.title} (vol:${c.volume_id ?? '?'})\n${(c.content ?? '').slice(0, 2000)}${(c.content ?? '').length > 2000 ? '…' : ''}`)
    }
    // 更早的章节：仅标题+大纲摘要，不送全文
    if (olderChapters.length > 0) {
      const summary = olderChapters.map(c =>
        `- 第${c.id}章 ${c.title}${c.outline ? '：' + c.outline.slice(0, 60) : ''}`
      ).join('\n')
      chapterSections.push(`\n【更早章节摘要（共${olderChapters.length}章）】\n${summary}`)
    }

    const prompt = [
      '【审计问题列表】', issueLines, '',
      foreshadowingCtx, '',
      '【章节正文（最近5章全文 + 历史章节摘要）】', ...chapterSections
    ].join('\n')

    const res = await modelService.chat({
      prompt,
      systemPrompt: AUDIT_FIX_SYSTEM_PROMPT,
      workId,
      step: 'milestone_audit_fix',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      modelType: modelOpts?.modelType as import('./model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    }, { webContents: e.sender })

    if (!res.success) return { success: false, error: res.error }

    // 解析修复指令
    let chapterPatches: { chapterId: number; reason: string; patches: { find: string; replace: string }[] }[] = []
    let foreshadowingActions: { id: number; action: string; reason: string }[] = []
    let advice: string | undefined
    try {
      const trimmed = res.content.trim()
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
      const parsed = JSON.parse(fenced?.[1] ?? trimmed) as Record<string, unknown>
      chapterPatches = (parsed.chapterPatches as typeof chapterPatches) ?? []
      foreshadowingActions = (parsed.foreshadowingActions as typeof foreshadowingActions) ?? []
      advice = typeof parsed.advice === 'string' ? parsed.advice : undefined
    } catch {
      return { success: false, error: '修复指令解析失败' }
    }

    // 应用伏笔操作
    let fsApplied = 0
    for (const fa of foreshadowingActions) {
      const row = foreshadowingDAO.getById(fa.id)
      if (!row || row.work_id !== workId) continue
      if (fa.action === 'resolve') { foreshadowingDAO.resolve(fa.id, 0); fsApplied++ }
      else if (fa.action === 'partial') { foreshadowingDAO.updateStatus(fa.id, 'partial'); fsApplied++ }
      else if (fa.action === 'abandon') { foreshadowingDAO.updateStatus(fa.id, 'abandoned'); fsApplied++ }
    }

    // 应用章节 patches
    let chApplied = 0
    const patchedChapterIds: number[] = []
    for (const cp of chapterPatches) {
      if (!cp.chapterId || !cp.patches?.length) continue
      const ch = withContent.find(c => c.id === cp.chapterId)
      if (!ch?.content) continue
      let text = ch.content
      for (const p of cp.patches) {
        if (!p.find) continue
        const idx = text.indexOf(p.find)
        if (idx === -1) continue
        text = text.slice(0, idx) + p.replace + text.slice(idx + p.find.length)
        chApplied++
      }
      // 保存修改后的章节（自动创建版本快照）
      volumeChapterDAO.updateChapterWithVersion(cp.chapterId, { content: text, word_count: text.replace(/\s/g, '').length }, { generation_round: 99 })
      patchedChapterIds.push(cp.chapterId)
    }

    return {
      success: true,
      chapterPatchesApplied: chApplied,
      patchedChapterIds,
      foreshadowingApplied: fsApplied,
      advice: advice ?? null
    }
  })

function computePassiveMonitor(workId: number): PassiveMonitorResult {
  const allForeshadowing = foreshadowingDAO.listByWork(workId)
  const resolved = allForeshadowing.filter(f => f.status === 'resolved').length
  const totalTrackable = allForeshadowing.filter(f => f.status !== 'abandoned').length
  const recoveryRate = totalTrackable > 0 ? Math.round((resolved / totalTrackable) * 100) : 100
  const deepPending = allForeshadowing.filter(
    f => f.depth === 'deep' && (f.status === 'pending' || f.status === 'partial')
  ).length

  const snapshotNames = characterSnapshotDAO.listCharacterNames(workId)
  const chapters = volumeChapterDAO.listChaptersByWork(workId).filter(c => c.content?.trim())
  const charactersLongAbsent: PassiveMonitorResult['charactersLongAbsent'] = []
  for (const name of snapshotNames) {
    const latest = characterSnapshotDAO.getLatest(workId, name)
    if (!latest?.chapter_id) continue
    const latestIdx = chapters.findIndex(c => c.id === latest.chapter_id)
    if (latestIdx >= 0 && chapters.length - 1 - latestIdx >= 5) {
      charactersLongAbsent.push({ name, chaptersAgo: chapters.length - 1 - latestIdx })
    }
  }

  const newCharacterRate = chapters.length > 0
    ? Math.round((snapshotNames.length / chapters.length) * 10) / 10
    : 0

  const intensities = chapters.map(c => c.emotion_intensity ?? 5)
  let streak = 0; let maxStreak = 0
  for (const v of intensities) { if (v <= 4) { streak++; maxStreak = Math.max(maxStreak, streak) } else streak = 0 }

  return {
    foreshadowingRecoveryRate: recoveryRate,
    deepForeshadowingPending: deepPending,
    charactersLongAbsent,
    newCharacterRate,
    emotionFlatStreak: maxStreak,
    repeatedPatternWarnings: [],
    timelineGaps: []
  }
}
