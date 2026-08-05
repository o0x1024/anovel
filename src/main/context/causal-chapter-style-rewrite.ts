import { createHash } from 'node:crypto'
import {
  causalNovelDAO,
  emotionalStateDAO,
  getDatabase,
  storyStateDAO,
  volumeChapterDAO,
  writingStyleDAO
} from '../db'
import { modelService } from '../model'
import { normalizeModelBodyOutput } from '../../shared/normalize-body-text'
import type { CausalChapterDecisionRecord } from '../../shared/causal-novel-types'
import { buildStyleRewriteSystemPrompt } from './anti-ai-rules'
import { extractJsonText } from './parse-json-extract'
import { withGoalLoopModelOptions } from './goal-routine/story-goal-model'
import { countWords as wordCount } from '../../shared/body-word-target'

export interface CausalStyleRewritePreview {
  chapterId: number
  originalContent: string
  candidateContent: string
  originalWordCount: number
  candidateWordCount: number
  evidenceAnchors: string[]
  auditReasons: string[]
  expectedUpdateTime: string
  validationToken: string
  styleId: number
  styleName: string
}

const REWRITE_AUDIT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'reasons'],
  properties: {
    passed: { type: 'boolean' },
    reasons: { type: 'array', maxItems: 12, items: { type: 'string' } }
  }
}

function evidenceValues(value: unknown, parentKey = ''): string[] {
  if (typeof value === 'string') {
    return /evidence|source[_A-Z]?event/i.test(parentKey) ? [value.trim()] : []
  }
  if (Array.isArray(value)) {
    if (/evidenceIds$/i.test(parentKey)) return []
    if (/evidence/i.test(parentKey)) {
      return value.filter((item): item is string => typeof item === 'string').map(item => item.trim())
    }
    return value.flatMap(item => evidenceValues(item, parentKey))
  }
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => evidenceValues(child, key))
}

export function collectCausalRewriteEvidenceAnchors(input: {
  decision: CausalChapterDecisionRecord | null
  stateFacts: Array<{ evidence: string | null }>
  emotionalStates: Array<{ source_event: string }>
  emotionAssessment?: unknown
}): string[] {
  const values = [
    ...evidenceValues(input.decision?.outcome ?? null),
    ...input.stateFacts.map(item => item.evidence?.trim() ?? ''),
    ...input.emotionalStates.map(item => item.source_event.trim()),
    ...evidenceValues(input.emotionAssessment ?? null)
  ]
  return [...new Set(values.filter(item => item.length >= 2))]
}

export function validateCausalRewriteCandidate(
  originalContent: string,
  candidateContent: string,
  evidenceAnchors: string[]
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = []
  const originalCount = wordCount(originalContent)
  const candidateCount = wordCount(candidateContent)
  if (!candidateContent.trim()) reasons.push('重写候选为空')
  if (candidateContent.trim() === originalContent.trim()) reasons.push('模型没有产生有效改写')
  if (originalCount > 0 && candidateCount < Math.floor(originalCount * 0.75)) {
    reasons.push(`候选过短：${candidateCount} 字，原文 ${originalCount} 字`)
  }
  if (originalCount > 0 && candidateCount > Math.ceil(originalCount * 1.25)) {
    reasons.push(`候选过长：${candidateCount} 字，原文 ${originalCount} 字`)
  }
  const compactCandidate = candidateContent.replace(/\s+/g, '')
  const missing = evidenceAnchors.filter(anchor => !compactCandidate.includes(anchor.replace(/\s+/g, '')))
  if (missing.length) reasons.push(`缺少 ${missing.length} 条权威逐字证据：${missing.slice(0, 3).join('；')}`)
  return { passed: reasons.length === 0, reasons }
}

export function buildCausalRewriteValidationToken(input: {
  workId: number
  chapterId: number
  updateTime: string
  stateRevision: number | null
  candidateContent: string
  evidenceAnchors: string[]
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function parseAudit(content: string): { passed: boolean; reasons: string[] } {
  const json = extractJsonText(content) ?? content.trim()
  try {
    const parsed = JSON.parse(json) as { passed?: unknown; reasons?: unknown }
    return {
      passed: parsed.passed === true,
      reasons: Array.isArray(parsed.reasons)
        ? parsed.reasons.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        : []
    }
  } catch {
    return { passed: false, reasons: ['重写一致性审计未返回有效 JSON'] }
  }
}

function assertChapter(workId: number, chapterId: number) {
  if (volumeChapterDAO.getWorkIdForChapter(chapterId) !== workId) throw new Error('章节不属于当前小说')
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!chapter?.content?.trim()) throw new Error('当前章节没有可重写的正文')
  return { ...chapter, content: chapter.content }
}

function loadLocks(workId: number, chapterId: number) {
  const chapter = assertChapter(workId, chapterId)
  const decision = causalNovelDAO.getDecision(chapterId)
  const stateFacts = storyStateDAO.listFactsByChapter(workId, chapterId)
  const emotionalStates = emotionalStateDAO.listByChapter(chapterId)
  let emotionAssessment: unknown = null
  try {
    emotionAssessment = chapter.emotion_assessment_json ? JSON.parse(chapter.emotion_assessment_json) : null
  } catch { /* 保留空值 */ }
  const evidenceAnchors = collectCausalRewriteEvidenceAnchors({
    decision, stateFacts, emotionalStates, emotionAssessment
  })
  return { chapter, decision, stateFacts, emotionalStates, evidenceAnchors }
}

function lockedContextFor(
  workId: number,
  chapterId: number,
  locks: ReturnType<typeof loadLocks>
): Record<string, unknown> {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const chapterIndex = chapters.findIndex(item => item.id === chapterId)
  const nextChapter = chapterIndex >= 0 ? chapters[chapterIndex + 1] : undefined
  return {
    decisionStatus: locks.decision?.status ?? null,
    stateRevision: locks.decision?.stateRevision ?? null,
    decision: locks.decision?.plan.decision ?? null,
    committedOutcome: locks.decision?.outcome ?? null,
    stateFacts: locks.stateFacts.map(item => ({
      entity: item.entity,
      key: item.state_key,
      value: item.value_json,
      transition: item.transition,
      irreversible: Boolean(item.irreversible)
    })),
    emotionalAftereffects: locks.emotionalStates.map(item => ({
      character: item.character_name,
      unresolvedEmotion: item.unresolved_emotion,
      behavioralAftereffect: item.behavioral_aftereffect
    })),
    nextChapterOpening: nextChapter?.content?.trim().slice(0, 1200) ?? ''
  }
}

export async function auditCausalManualExpressionEdit(
  workId: number,
  chapterId: number,
  candidateContent: string
): Promise<{ evidenceAnchors: string[]; auditReasons: string[] }> {
  const locks = loadLocks(workId, chapterId)
  if (locks.decision?.status !== 'committed') {
    throw new Error('只有已提交章节需要执行表达等价审计')
  }
  const deterministic = validateCausalRewriteCandidate(
    locks.chapter.content, candidateContent, locks.evidenceAnchors
  )
  if (!deterministic.passed) throw new Error(deterministic.reasons.join('；'))
  const lockedContext = lockedContextFor(workId, chapterId, locks)
  const auditResponse = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'goal_novel_causal_edit_audit',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 1600,
      forceThinkingDisabled: true,
      responseSchema: { name: 'causal_manual_edit_audit', schema: REWRITE_AUDIT_SCHEMA, strict: true },
      structuredOutputMode: 'prompt_json',
      systemPrompt: [
        '你是因果小说人工编辑一致性审计器，只判断新正文是否与已提交事实完全等价。',
        '人物行动、事件顺序、选择、代价、资源、伤势、认知、压力、承诺、情绪余波、章末状态或下一章衔接有任何变化，必须 passed=false。',
        '只允许措辞、句式、节奏、段落与错别字变化。不要因为用户声明“只改文字”而放宽审计。只返回 JSON。'
      ].join('\n'),
      prompt: [
        `【冻结事实】\n${JSON.stringify(lockedContext, null, 2)}`,
        `【原正文】\n${locks.chapter.content}`,
        `【人工编辑候选】\n${candidateContent}`
      ].join('\n\n')
    }),
    { stream: false }
  )
  if (!auditResponse.success || !auditResponse.content?.trim()) {
    throw new Error(auditResponse.error || '人工编辑一致性审计失败')
  }
  const audit = parseAudit(auditResponse.content)
  if (!audit.passed) {
    throw new Error(`人工编辑改变了已提交事实：${audit.reasons.join('；') || '存在未说明的事实漂移'}`)
  }
  return { evidenceAnchors: locks.evidenceAnchors, auditReasons: audit.reasons }
}

export async function generateCausalStyleRewritePreview(
  workId: number,
  chapterId: number
): Promise<CausalStyleRewritePreview> {
  const styleId = writingStyleDAO.getWorkStyleId(workId)
  const style = styleId ? writingStyleDAO.getById(styleId) : undefined
  if (!styleId || !style) throw new Error('当前作品尚未绑定文风，请先选择文风')
  const locks = loadLocks(workId, chapterId)
  const { chapter, decision, evidenceAnchors } = locks
  if (!decision) throw new Error('手动章节没有因果决策，不能执行因果锁定重写')
  const lockedContext = lockedContextFor(workId, chapterId, locks)
  const targetWords = wordCount(chapter.content)
  const rewriteResponse = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      styleId,
      step: 'body_style_rewrite',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.35,
      maxTokens: Math.min(12000, Math.max(3000, Math.ceil(chapter.content.length * 1.7))),
      systemPrompt: [
        buildStyleRewriteSystemPrompt(workId),
        '【因果锁定重写最高规则】',
        '本次任务是完整章节的文风迁移，允许重写全部表达层文字；本条覆盖“未命中句保持原样”的局部修订限制。',
        '只改变叙述语言、句式、节奏和文风，不得增删、替换或重排任何已发生事件。',
        '不得改变人物选择、阻力、代价、资源、认知、压力、承诺、情绪余波、章末状态及与下一章的衔接。',
        '下方列出的“权威逐字证据”必须逐字保留在重写正文中，不能同义替换。',
        '只输出重写后的完整正文，不要标题、说明、Markdown 围栏或审计报告。'
      ].join('\n\n'),
      prompt: [
        `【冻结的因果与事实】\n${JSON.stringify(lockedContext, null, 2)}`,
        `【必须逐字保留的权威证据】\n${evidenceAnchors.length ? evidenceAnchors.map((item, index) => `${index + 1}. ${item}`).join('\n') : '无已提交逐字证据；仍须严格保留冻结事实。'}`,
        `【目标长度】${targetWords} 字，允许上下浮动 25%。`,
        `【原正文】\n${chapter.content}`
      ].join('\n\n')
    }),
    { stream: false }
  )
  if (!rewriteResponse.success || !rewriteResponse.content?.trim()) {
    throw new Error(rewriteResponse.error || 'AI 文风重写失败')
  }
  const candidateContent = normalizeModelBodyOutput(rewriteResponse.content.trim(), 'body_generation')
  const deterministic = validateCausalRewriteCandidate(chapter.content, candidateContent, evidenceAnchors)
  if (!deterministic.passed) throw new Error(deterministic.reasons.join('；'))

  const auditResponse = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'body_style_rewrite',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 1600,
      forceThinkingDisabled: true,
      responseSchema: { name: 'causal_style_rewrite_audit', schema: REWRITE_AUDIT_SCHEMA, strict: true },
      structuredOutputMode: 'prompt_json',
      systemPrompt: [
        '你是因果小说重写一致性审计器。只判断候选正文是否与冻结的情节、事实和章后状态完全等价。',
        '任何事件增删、顺序改变、人物选择/代价变化、事实漂移、提前揭示、章末状态改变或与下一章冲突，都必须 passed=false。',
        '文风、句式和叙述节奏变化不算事实变化。只返回 JSON。'
      ].join('\n'),
      prompt: [
        `【冻结内容】\n${JSON.stringify(lockedContext, null, 2)}`,
        `【原正文】\n${chapter.content}`,
        `【候选正文】\n${candidateContent}`
      ].join('\n\n')
    }),
    { stream: false }
  )
  if (!auditResponse.success || !auditResponse.content?.trim()) {
    throw new Error(auditResponse.error || '重写一致性审计失败')
  }
  const audit = parseAudit(auditResponse.content)
  if (!audit.passed) throw new Error(`候选未通过因果一致性审计：${audit.reasons.join('；') || '存在未说明的事实漂移'}`)
  const stateRevision = decision.stateRevision ?? null
  const validationToken = buildCausalRewriteValidationToken({
    workId, chapterId, updateTime: chapter.update_time, stateRevision,
    candidateContent, evidenceAnchors
  })
  return {
    chapterId,
    originalContent: chapter.content,
    candidateContent,
    originalWordCount: wordCount(chapter.content),
    candidateWordCount: wordCount(candidateContent),
    evidenceAnchors,
    auditReasons: audit.reasons,
    expectedUpdateTime: chapter.update_time,
    validationToken,
    styleId,
    styleName: style.name
  }
}

export function applyCausalStyleRewrite(input: {
  workId: number
  chapterId: number
  candidateContent: string
  expectedUpdateTime: string
  validationToken: string
}): boolean {
  const { chapter, decision, emotionalStates, evidenceAnchors } = loadLocks(input.workId, input.chapterId)
  if (!decision) throw new Error('章节因果决策不存在')
  if (chapter.update_time !== input.expectedUpdateTime) throw new Error('章节已被其他操作修改，请重新生成重写候选')
  const deterministic = validateCausalRewriteCandidate(chapter.content, input.candidateContent, evidenceAnchors)
  if (!deterministic.passed) throw new Error(deterministic.reasons.join('；'))
  const expectedToken = buildCausalRewriteValidationToken({
    workId: input.workId,
    chapterId: input.chapterId,
    updateTime: chapter.update_time,
    stateRevision: decision.stateRevision ?? null,
    candidateContent: input.candidateContent,
    evidenceAnchors
  })
  if (expectedToken !== input.validationToken) throw new Error('重写候选已变化，请重新生成并审计')
  const styleId = writingStyleDAO.getWorkStyleId(input.workId)
  return getDatabase().transaction(() => {
    const sourceVersion = causalNovelDAO.ensureCurrentContentVersion(
      input.workId, input.chapterId, 'style_rewrite_source', 'expression'
    )
    const updated = volumeChapterDAO.updateChapterWithVersion(input.chapterId, {
      content: input.candidateContent,
      word_count: wordCount(input.candidateContent),
      expectedUpdateTime: input.expectedUpdateTime,
      emotion_assessment_json: chapter.emotion_assessment_json
    }, { model_type: 'causal_style_rewrite', style_id: styleId ?? undefined })
    if (!updated) throw new Error('章节已被其他操作修改，请重新生成重写候选')
    const persisted = volumeChapterDAO.getChapter(input.chapterId)
    if (!persisted?.content?.trim()) throw new Error('文风重写后的持久化正文为空')
    const targetVersion = causalNovelDAO.createContentVersion({
      workId: input.workId,
      chapterId: input.chapterId,
      parentVersionId: sourceVersion.id,
      content: persisted.content,
      source: 'ai_style_rewrite',
      editKind: 'expression',
      status: 'candidate'
    })
    causalNovelDAO.activateContentVersion({
      workId: input.workId,
      chapterId: input.chapterId,
      contentVersionId: targetVersion.id,
      stateBeforeRevision: decision.stateRevision,
      stateAfterRevision: decision.status === 'committed' ? decision.stateRevision + 1 : null,
      decisionStatus: decision.status
    })
    causalNovelDAO.invalidateCheckpoints(input.workId, input.chapterId)
    if (emotionalStates.length) {
      emotionalStateDAO.replaceChapter(input.chapterId, emotionalStates.map(item => ({
        work_id: item.work_id,
        chapter_id: item.chapter_id,
        character_name: item.character_name,
        felt_state: item.felt_state,
        displayed_state: item.displayed_state,
        unresolved_emotion: item.unresolved_emotion,
        protective_strategy: item.protective_strategy,
        behavioral_aftereffect: item.behavioral_aftereffect,
        beliefs_json: item.beliefs_json ?? undefined,
        relationships_json: item.relationships_json ?? undefined,
        source_event: item.source_event
      })))
    }
    return true
  })()
}
