import { createHash } from 'node:crypto'
import { emotionalStateDAO, volumeChapterDAO } from '../../db'
import type { EmotionalStateLedgerInput } from '../../db'
import { modelService } from '../../model'
import {
  type EmotionBlindAssessment,
  type EmotionContract,
  type EmotionFailureLayer,
  EMOTION_LEDGER_JSON_SCHEMA,
  EMOTION_LEDGER_SCHEMA_VERSION
} from '../../../shared/emotion-contract'
import { loadChapterEmotionContract } from './emotion-engine'
import { withGoalLoopModelOptions } from './story-goal-model'
import { EmotionLedgerParseError, parseEmotionLedgerResponse } from './emotion-ledger'
import { appLogger } from '../../logger/app-logger'
import { requestStructuredModelOutput } from './structured-model-output'

interface BlindReadResult {
  attachmentScore: number
  causalEarnednessScore: number
  inferabilityScore: number
  povImmediacyScore: number
  subtextScore: number
  modulationScore: number
  residueScore: number
  actualReaderCurve: EmotionBlindAssessment['actual_reader_curve']
  readerCaresAbout: string
  readerHopes: string
  readerFears: string
  blockingIssues: string[]
}

const EMOTION_PASS_SCORE = 80
const EMOTION_HARD_FLOOR = 65
const EMOTION_LEDGER_MAX_ATTEMPTS = 3
const EMOTION_BLIND_READ_SCHEMA = {
  type: 'object',
  required: [
    'attachment_score', 'causal_earnedness_score', 'inferability_score',
    'pov_immediacy_score', 'subtext_score', 'modulation_score', 'residue_score',
    'actual_reader_curve', 'reader_cares_about', 'reader_hopes', 'reader_fears', 'blocking_issues'
  ],
  properties: {
    attachment_score: { type: 'integer' }, causal_earnedness_score: { type: 'integer' },
    inferability_score: { type: 'integer' }, pov_immediacy_score: { type: 'integer' },
    subtext_score: { type: 'integer' }, modulation_score: { type: 'integer' }, residue_score: { type: 'integer' },
    actual_reader_curve: { type: 'array' }, reader_cares_about: { type: 'string' },
    reader_hopes: { type: 'string' }, reader_fears: { type: 'string' }, blocking_issues: { type: 'array' }
  }
}
const EMOTION_TARGET_COMPARE_SCHEMA = {
  type: 'object',
  required: ['target_alignment_score', 'failure_layer', 'blocking_issues', 'repair_instruction'],
  properties: {
    target_alignment_score: { type: 'integer' }, failure_layer: { type: 'string' },
    blocking_issues: { type: 'array' }, repair_instruction: { type: 'string' }
  }
}

export function emotionContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function parseStoredEmotionAssessment(raw: string | null | undefined): EmotionBlindAssessment | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as EmotionBlindAssessment
    return parsed && typeof parsed === 'object' && typeof parsed.passed === 'boolean' ? parsed : null
  } catch { return null }
}

export function isEmotionOutcomeComplete(
  chapterId: number,
  content: string,
  raw: string | null | undefined
): boolean {
  const assessment = parseStoredEmotionAssessment(raw)
  if (!assessment?.passed) return false
  if (assessment.outcome_meta?.ledger_complete === false) return false
  if (assessment.outcome_meta?.content_hash
    && assessment.outcome_meta.content_hash !== emotionContentHash(content)) return false
  return emotionalStateDAO.listByChapter(chapterId).length > 0
}

function clamp(value: unknown, min = 0, max = 100): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : 0
}

/**
 * 情绪评分协议统一使用百分制。部分模型会受 arousal 的 0-4 约束影响，
 * 误把同一 JSON 中的质量分也输出为 0-5 或 0-10；这里兼容旧响应，
 * 同时保留正常的 0-100 分结果。
 */
function normalizePercentScores(values: unknown[]): number[] {
  const scores = values.map(value => clamp(value))
  const maxScore = Math.max(0, ...scores)
  const scale = maxScore <= 5 ? 20 : maxScore <= 10 ? 10 : 1
  return scores.map(score => clamp(score * scale))
}

function normalizePercentScore(value: unknown): number {
  return normalizePercentScores([value])[0] ?? 0
}

function list(value: unknown, limit = 10): string[] {
  return Array.isArray(value) ? value.map(String).map(item => item.trim()).filter(Boolean).slice(0, limit) : []
}

function numberedParagraphs(content: string): string {
  return content.split(/\n\s*\n/).map(item => item.trim()).filter(Boolean)
    .map((paragraph, index) => `[P${index + 1}] ${paragraph}`).join('\n\n')
}

async function blindRead(
  workId: number,
  chapterId: number,
  content: string,
  signal?: AbortSignal
): Promise<BlindReadResult> {
  const parsed = await requestStructuredModelOutput<Record<string, unknown>>({
    workId,
    label: '情绪盲读',
    signal,
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId, chapterId, step: 'emotion_blind_read', enrichWorkContext: false, enrichNarrativeMemory: false,
        temperature: 0, maxTokens: 2800, forceThinkingDisabled: true,
        responseSchema: { name: 'emotion_blind_read', schema: EMOTION_BLIND_READ_SCHEMA, strict: false },
        systemPrompt: [
          '你是目标读者盲读员。你看不到标题、大纲、情绪计划和作者意图，只能根据原文报告自己实际产生的读者情绪。',
          '严格区分：人物声称的情绪、你从行为推断的情绪、你作为读者实际感受到的情绪。刺激词、哭喊、心跳和反转数量不能直接加分。',
          '去标签测试：假设删除“悲伤/愤怒/恐惧/感动”等直接标签，判断情绪是否仍能由关切、事件意义、视角细节、潜台词、选择与代价推出。',
          'attachment_score 判断读者是否有具体理由在乎；causal_earnedness_score 判断情绪是否由前因挣得；inferability_score 判断去标签后是否成立。',
          'modulation_score 判断是否有蓄力、停顿、转折、释放和恢复；residue_score 判断情绪是否改变后续行为、关系或信念。',
          '所有 *_score 都必须使用 0-100 的整数百分制：80 表示通过，65 以下表示硬伤。禁止使用 0-5 或 0-10 量表。只有 actual_reader_curve[].arousal 使用 0-4。',
          '只输出 JSON：{"attachment_score":80,"causal_earnedness_score":80,"inferability_score":80,"pov_immediacy_score":80,"subtext_score":80,"modulation_score":80,"residue_score":80,"actual_reader_curve":[{"range":"P1-P3","emotion":"","arousal":0,"evidence":""}],"reader_cares_about":"","reader_hopes":"","reader_fears":"","blocking_issues":[]}',
          'arousal 只能是0-4。blocking_issues 必须引用段落编号；没有具体希望或害怕结果时必须列为阻塞。'
        ].join('\n\n'),
        prompt: [
          numberedParagraphs(content),
          attempt > 1 ? `【格式重试】${error}。返回更短的完整 JSON。` : ''
        ].filter(Boolean).join('\n\n')
      }), { stream: false, signal }
    )
  })
  const curveRaw = Array.isArray(parsed.actual_reader_curve) ? parsed.actual_reader_curve : []
  const curve = curveRaw.map(item => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    return {
      range: String(row.range ?? '').trim(), emotion: String(row.emotion ?? '').trim(),
      arousal: clamp(row.arousal, 0, 4), evidence: String(row.evidence ?? '').trim()
    }
  }).filter(item => item.range && item.emotion && item.evidence)
  const [attachmentScore, causalEarnednessScore, inferabilityScore, povImmediacyScore,
    subtextScore, modulationScore, residueScore] = normalizePercentScores([
    parsed.attachment_score,
    parsed.causal_earnedness_score,
    parsed.inferability_score,
    parsed.pov_immediacy_score,
    parsed.subtext_score,
    parsed.modulation_score,
    parsed.residue_score
  ])
  return {
    attachmentScore,
    causalEarnednessScore,
    inferabilityScore,
    povImmediacyScore,
    subtextScore,
    modulationScore,
    residueScore,
    actualReaderCurve: curve,
    readerCaresAbout: String(parsed.reader_cares_about ?? '').trim(),
    readerHopes: String(parsed.reader_hopes ?? '').trim(),
    readerFears: String(parsed.reader_fears ?? '').trim(),
    blockingIssues: list(parsed.blocking_issues)
  }
}

async function compareTarget(
  workId: number,
  chapterId: number,
  contract: EmotionContract,
  blind: BlindReadResult,
  signal?: AbortSignal
): Promise<{ score: number; failureLayer: EmotionFailureLayer; issues: string[]; repairInstruction: string }> {
  const parsed = await requestStructuredModelOutput<Record<string, unknown>>({
    workId,
    label: '情绪目标比较',
    signal,
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId, chapterId, step: 'emotion_target_compare', enrichWorkContext: false, enrichNarrativeMemory: false,
        temperature: 0, maxTokens: 1800, forceThinkingDisabled: true,
        responseSchema: { name: 'emotion_target_compare', schema: EMOTION_TARGET_COMPARE_SCHEMA, strict: false },
        systemPrompt: [
          '你是情绪目标差异审计员。只比较预定 emotion_contract 与独立盲读结果，不重新想象原文。',
          'failure_layer 只能是 attachment/arc/scene/continuity/prose/none。选择需要返工的最高层级。',
          'target_alignment_score 必须使用 0-100 的整数百分制：80 表示通过，65 以下表示硬伤。禁止使用 0-5 或 0-10 量表。',
          '只输出 JSON：{"target_alignment_score":80,"failure_layer":"scene","blocking_issues":[],"repair_instruction":"可直接执行且限定范围的修订要求"}',
          '若盲读者不在乎，attachment；情绪峰谷位置错误，arc；触发/评价/选择缺失，scene；前章余波断裂，continuity；结构成立但表达直白或视角远，prose。'
        ].join('\n\n'),
        prompt: [
          `【目标契约】\n${JSON.stringify(contract, null, 2)}\n\n【盲读结果】\n${JSON.stringify(blind, null, 2)}`,
          attempt > 1 ? `【格式重试】${error}。返回更短的完整 JSON。` : ''
        ].filter(Boolean).join('\n\n')
      }), { stream: false, signal }
    )
  })
  const layer = String(parsed.failure_layer ?? 'scene') as EmotionFailureLayer
  const validLayer: EmotionFailureLayer = ['attachment', 'arc', 'scene', 'continuity', 'prose', 'none'].includes(layer) ? layer : 'scene'
  return {
    score: normalizePercentScore(parsed.target_alignment_score),
    failureLayer: validLayer,
    issues: list(parsed.blocking_issues),
    repairInstruction: String(parsed.repair_instruction ?? '').trim()
  }
}

async function extractEmotionalLedgerRows(
  workId: number,
  chapterId: number,
  content: string,
  contract: EmotionContract,
  signal?: AbortSignal
): Promise<EmotionalStateLedgerInput[]> {
  let lastError: Error | null = null
  let lastExcerpt = ''
  for (let attempt = 1; attempt <= EMOTION_LEDGER_MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new Error('已取消')
    const retryHint = lastError
      ? `\n\n上一次输出无效：${lastError.message}。必须重新输出完整JSON，不得解释或复制错误片段。`
      : ''
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId, chapterId, step: 'emotion_state_extract', enrichWorkContext: false, enrichNarrativeMemory: false,
        temperature: 0, maxTokens: 1800,
        responseSchema: { name: 'emotion_ledger', schema: EMOTION_LEDGER_JSON_SCHEMA, strict: true },
        systemPrompt: [
          '你是跨章情绪状态提取器。只提取正文结尾仍会影响后续的真实状态，不把一闪而过的表情当作持续状态。',
          '只输出符合给定JSON Schema的单个JSON对象。所有属性名必须使用英文固定字段，文本内的双引号必须正确转义。',
          '每个本章核心角色必须有一条；behavioral_aftereffect 必须是下一章可观察的注意、语言、回避、风险偏好或选择变化。',
          'belief_changes 只允许 [{"belief":"","change":""}]；relationship_changes 只允许 [{"character":"","state":""}]。无变化时输出空数组。',
          `Schema：${JSON.stringify(EMOTION_LEDGER_JSON_SCHEMA)}`,
          retryHint
        ].filter(Boolean).join('\n\n'),
        prompt: `【情绪契约】\n${JSON.stringify(contract, null, 2)}\n\n【正文】\n${content}`
      }), { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) {
      lastError = new Error(response.error || '情绪账本提取无返回')
    } else {
      try {
        return parseEmotionLedgerResponse(response.content).map(state => ({
          work_id: workId,
          chapter_id: chapterId,
          character_name: state.character_name,
          felt_state: state.felt_state,
          displayed_state: state.displayed_state,
          unresolved_emotion: state.unresolved_emotion,
          protective_strategy: state.protective_strategy,
          behavioral_aftereffect: state.behavioral_aftereffect,
          beliefs_json: JSON.stringify(state.belief_changes),
          relationships_json: JSON.stringify(state.relationship_changes),
          source_event: state.source_event
        }))
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        lastExcerpt = error instanceof EmotionLedgerParseError ? error.outputExcerpt : response.content.slice(0, 240)
      }
    }
    appLogger.warn('emotion_ledger', '情绪账本输出无效，局部重试', {
      workId, chapterId, attempt, error: lastError.message, excerpt: lastExcerpt
    })
  }
  const finalError = new EmotionLedgerParseError(
    `情绪账本连续 ${EMOTION_LEDGER_MAX_ATTEMPTS} 次解析或校验失败：${lastError?.message ?? '未知错误'}`
      + (lastExcerpt ? `；错误片段：${lastExcerpt}` : ''),
    lastExcerpt
  )
  appLogger.error('emotion_ledger', '情绪账本提取终止', {
    workId, chapterId, error: finalError.message, excerpt: lastExcerpt
  })
  throw finalError
}

export async function assessChapterEmotion(
  workId: number,
  chapterId: number,
  content: string,
  signal?: AbortSignal,
  persistLedger = true,
  persistAssessment = true
): Promise<EmotionBlindAssessment> {
  const contract = loadChapterEmotionContract(chapterId)
  if (!contract) throw new Error('章节缺少 emotion_contract，禁止情绪验收')
  const blind = await blindRead(workId, chapterId, content, signal)
  const compared = await compareTarget(workId, chapterId, contract, blind, signal)
  const scores = [blind.attachmentScore, blind.causalEarnednessScore, blind.inferabilityScore,
    blind.povImmediacyScore, blind.subtextScore, blind.modulationScore, blind.residueScore, compared.score]
  const score = Math.round(scores.reduce((sum, item) => sum + item, 0) / scores.length)
  const hardScores = [blind.attachmentScore, blind.causalEarnednessScore, blind.inferabilityScore,
    blind.modulationScore, blind.residueScore, compared.score]
  const blockers = [...blind.blockingIssues, ...compared.issues]
  if (!blind.readerCaresAbout) blockers.push('盲读者无法指出具体在乎对象')
  if (!blind.readerHopes || !blind.readerFears) blockers.push('盲读者无法形成明确希望与担忧')
  if (hardScores.some(item => item < EMOTION_HARD_FLOOR)) blockers.push(`存在低于情绪硬伤线 ${EMOTION_HARD_FLOOR} 的承重维度`)
  const assessment: EmotionBlindAssessment = {
    passed: score >= EMOTION_PASS_SCORE && blockers.length === 0,
    score,
    attachment_score: blind.attachmentScore,
    causal_earnedness_score: blind.causalEarnednessScore,
    inferability_score: blind.inferabilityScore,
    pov_immediacy_score: blind.povImmediacyScore,
    subtext_score: blind.subtextScore,
    modulation_score: blind.modulationScore,
    residue_score: blind.residueScore,
    target_alignment_score: compared.score,
    actual_reader_curve: blind.actualReaderCurve,
    reader_cares_about: blind.readerCaresAbout,
    reader_hopes: blind.readerHopes,
    reader_fears: blind.readerFears,
    failure_layer: compared.failureLayer,
    blocking_issues: [...new Set(blockers)],
    repair_instruction: compared.repairInstruction
  }
  const averageArousal = blind.actualReaderCurve.length > 0
    ? blind.actualReaderCurve.reduce((sum, point) => sum + point.arousal, 0) / blind.actualReaderCurve.length
    : 0
  const emotionIntensity = Math.max(1, Math.min(10, Math.round(1 + averageArousal * 2.25)))
  if (persistAssessment) {
    if (assessment.passed && persistLedger) {
      // 先在内存中完成提取与校验；任何失败都不得留下 passed assessment。
      const ledgerRows = await extractEmotionalLedgerRows(workId, chapterId, content, contract, signal)
      assessment.outcome_meta = {
        content_hash: emotionContentHash(content),
        ledger_complete: true,
        ledger_schema_version: EMOTION_LEDGER_SCHEMA_VERSION
      }
      emotionalStateDAO.replaceChapterOutcome(
        chapterId, ledgerRows, JSON.stringify(assessment), emotionIntensity
      )
    } else {
      assessment.outcome_meta = {
        content_hash: emotionContentHash(content),
        ledger_complete: false,
        ledger_schema_version: EMOTION_LEDGER_SCHEMA_VERSION
      }
      emotionalStateDAO.replaceAssessmentWithoutLedger(
        chapterId, JSON.stringify(assessment), emotionIntensity
      )
    }
  }
  return assessment
}

/**
 * 恢复/整书验收入口：旧评估已通过但账本缺失时，只补账本，
 * 不重做盲读、不改正文。
 */
export async function ensureChapterEmotionOutcome(
  workId: number,
  chapterId: number,
  content: string,
  signal?: AbortSignal
): Promise<EmotionBlindAssessment> {
  const existingLedgerRows = emotionalStateDAO.listByChapter(chapterId)
  const row = volumeChapterDAO.getChapter(chapterId)
  const stored = parseStoredEmotionAssessment(row?.emotion_assessment_json)
  const hashMatches = !stored?.outcome_meta?.content_hash
    || stored.outcome_meta.content_hash === emotionContentHash(content)
  if (stored && hashMatches) {
    if (!stored.passed) return stored
    if (existingLedgerRows.length > 0 && stored.outcome_meta?.ledger_complete !== false) return stored
    const contract = loadChapterEmotionContract(chapterId)
    if (!contract) throw new Error('章节缺少 emotion_contract，禁止补抽取情绪账本')
    const repairedLedgerRows = await extractEmotionalLedgerRows(workId, chapterId, content, contract, signal)
    stored.outcome_meta = {
      content_hash: emotionContentHash(content),
      ledger_complete: true,
      ledger_schema_version: EMOTION_LEDGER_SCHEMA_VERSION
    }
    const readerCurve = Array.isArray(stored.actual_reader_curve) ? stored.actual_reader_curve : []
    const averageArousal = readerCurve.length > 0
      ? readerCurve.reduce((sum, point) => sum + point.arousal, 0) / readerCurve.length
      : 0
    emotionalStateDAO.replaceChapterOutcome(
      chapterId,
      repairedLedgerRows,
      JSON.stringify(stored),
      Math.max(1, Math.min(10, Math.round(1 + averageArousal * 2.25)))
    )
    return stored
  }
  return assessChapterEmotion(workId, chapterId, content, signal, true, true)
}

export function emotionRepairHint(assessment: EmotionBlindAssessment): string {
  return [
    `情绪失败层级：${assessment.failure_layer}`,
    assessment.blocking_issues.length ? `阻塞证据：${assessment.blocking_issues.join('；')}` : '',
    assessment.repair_instruction ? `定向修订：${assessment.repair_instruction}` : '',
    '禁止仅增加哭泣、心跳、身体反应或直接心理解释。必须修复关切、事件意义、表里冲突、选择代价或余波中的真实缺口。'
  ].filter(Boolean).join('\n')
}

export const EMOTION_GATE_MIN_SCORE = EMOTION_PASS_SCORE
