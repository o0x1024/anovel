import { createHash } from 'node:crypto'
import { chapterEmotionCheckpointDAO, emotionalStateDAO, volumeChapterDAO } from '../../db'
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
import {
  EmotionLedgerParseError,
  EmotionLedgerPipelineError,
  classifyEmotionLedgerFailure,
  planEmotionLedgerBatches,
  parseEmotionLedgerResponse,
  selectAffectedEmotionCharacters,
  validateEmotionLedgerBatch
} from './emotion-ledger'
import { appLogger } from '../../logger/app-logger'
import { requestStructuredModelOutput } from './structured-model-output'
import { countWords } from '../../../shared/body-word-target'

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
const EMOTION_LEDGER_MAX_ATTEMPTS = 2
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

export function emotionAssessmentMatchesContent(
  assessment: EmotionBlindAssessment,
  content: string
): boolean {
  return assessment.outcome_meta?.content_hash === emotionContentHash(content)
}

export function parseStoredEmotionAssessment(raw: string | null | undefined): EmotionBlindAssessment | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as EmotionBlindAssessment
    return parsed && typeof parsed === 'object' && typeof parsed.passed === 'boolean' ? parsed : null
  } catch { return null }
}

export function isEmotionAssessmentAcceptedForTransition(
  assessment: EmotionBlindAssessment | null | undefined
): boolean {
  return Boolean(assessment?.passed || assessment?.outcome_meta?.accepted_deferred === true)
}

export function isEmotionOutcomeComplete(
  chapterId: number,
  content: string,
  raw: string | null | undefined
): boolean {
  const assessment = parseStoredEmotionAssessment(raw)
  if (!assessment) return false
  if (!isEmotionAssessmentAcceptedForTransition(assessment)) return false
  if (assessment.outcome_meta?.ledger_complete === false) return false
  if (assessment.outcome_meta?.content_hash
    && assessment.outcome_meta.content_hash !== emotionContentHash(content)) return false
  return emotionalStateDAO.listByChapter(chapterId).length > 0
}

/**
 * 持久化用户明确接受当前情绪问题的最终决策。
 * 原始 passed 保持不变；accepted_deferred 只代表工作流可以带债务推进。
 */
export async function persistDeferredEmotionOutcome(
  workId: number,
  chapterId: number,
  content: string,
  assessment: EmotionBlindAssessment,
  signal?: AbortSignal
): Promise<EmotionBlindAssessment> {
  const latest = volumeChapterDAO.getChapter(chapterId)
  if (!latest?.content?.trim() || latest.content !== content) {
    throw new Error('候选正文已变化，拒绝提交过期的延后情绪验收')
  }
  if (!emotionAssessmentMatchesContent(assessment, content)) {
    throw new Error('情绪问题报告与当前正文不匹配，请重新验收后再决定是否接受')
  }
  const contract = loadChapterEmotionContract(chapterId)
  if (!contract) throw new Error('章节缺少 emotion_contract，禁止提交延后情绪验收')
  const ledgerRows = await extractEmotionalLedgerRows(workId, chapterId, content, contract, signal)
  const accepted: EmotionBlindAssessment = {
    ...assessment,
    outcome_meta: {
      content_hash: emotionContentHash(content),
      ledger_complete: true,
      ledger_schema_version: EMOTION_LEDGER_SCHEMA_VERSION,
      accepted_deferred: true
    }
  }
  const readerCurve = Array.isArray(accepted.actual_reader_curve) ? accepted.actual_reader_curve : []
  const averageArousal = readerCurve.length > 0
    ? readerCurve.reduce((sum, point) => sum + point.arousal, 0) / readerCurve.length
    : 0
  emotionalStateDAO.replaceChapterOutcome(
    chapterId,
    ledgerRows,
    JSON.stringify(accepted),
    Math.max(1, Math.min(10, Math.round(1 + averageArousal * 2.25)))
  )
  return accepted
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
        temperature: 0, maxTokens: 2800, timeoutMs: 120_000, forceThinkingDisabled: true,
        responseSchema: { name: 'emotion_blind_read', schema: EMOTION_BLIND_READ_SCHEMA, strict: false },
        structuredOutputMode: 'prompt_json',
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
  return requestStructuredModelOutput({
    workId,
    label: '情绪目标比较',
    signal,
    schema: EMOTION_TARGET_COMPARE_SCHEMA,
    validate: value => {
      const score = Number(value.target_alignment_score)
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        throw new Error('target_alignment_score 必须是 0-100 分')
      }
      const layer = value.failure_layer
      if (typeof layer !== 'string'
        || !['attachment', 'arc', 'scene', 'continuity', 'prose', 'none'].includes(layer)) {
        throw new Error('failure_layer 不在允许枚举内')
      }
      if (!Array.isArray(value.blocking_issues)) throw new Error('blocking_issues 必须是数组')
      const repairInstruction = typeof value.repair_instruction === 'string'
        ? value.repair_instruction.trim()
        : ''
      if (!repairInstruction) throw new Error('repair_instruction 不能为空')
      return {
        score: normalizePercentScore(score),
        failureLayer: layer as EmotionFailureLayer,
        issues: list(value.blocking_issues),
        repairInstruction
      }
    },
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId, chapterId, step: 'emotion_target_compare', enrichWorkContext: false, enrichNarrativeMemory: false,
        temperature: 0, maxTokens: 1800, timeoutMs: 120_000, forceThinkingDisabled: true,
        responseSchema: { name: 'emotion_target_compare', schema: EMOTION_TARGET_COMPARE_SCHEMA, strict: false },
        structuredOutputMode: 'prompt_json',
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
}

function parseCheckpointPayload<T>(payload: string | null | undefined): T | null {
  if (!payload) return null
  try {
    return JSON.parse(payload) as T
  } catch {
    return null
  }
}

function chapterEmotionCharacters(
  chapterId: number,
  content: string,
  contract: EmotionContract
): string[] {
  const chapter = volumeChapterDAO.getChapter(chapterId)
  let configured: string[] = []
  try {
    const parsed = JSON.parse(chapter?.characters ?? '[]') as unknown
    if (Array.isArray(parsed)) {
      configured = parsed.map(String).map(name => name.trim()).filter(Boolean)
    }
  } catch {
    configured = (chapter?.characters ?? '')
      .split(/[、,，/]/)
      .map(name => name.trim())
      .filter(Boolean)
  }
  return selectAffectedEmotionCharacters({
    configuredCharacters: configured,
    povCharacter: contract.pov_character,
    content
  })
}

function ledgerBatchKey(index: number, characters: string[]): string {
  return `${String(index + 1).padStart(3, '0')}:${characters.join('|')}`
}

function ledgerRowsFromStates(
  workId: number,
  chapterId: number,
  states: ReturnType<typeof parseEmotionLedgerResponse>
): EmotionalStateLedgerInput[] {
  return states.map(state => ({
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
}

async function extractEmotionLedgerBatch(input: {
  workId: number
  chapterId: number
  content: string
  contentHash: string
  contract: EmotionContract
  characters: string[]
  batchKey: string
  signal?: AbortSignal
}): Promise<EmotionalStateLedgerInput[]> {
  const cached = chapterEmotionCheckpointDAO.find(
    input.chapterId,
    input.contentHash,
    'ledger_batch',
    input.batchKey
  )
  const cachedRows = cached?.status === 'completed'
    ? parseCheckpointPayload<EmotionalStateLedgerInput[]>(cached.payload_json)
    : null
  if (cachedRows) return cachedRows

  let lastError: EmotionLedgerPipelineError | null = null
  try {
    const states = await requestStructuredModelOutput({
      workId: input.workId,
      label: `情绪账本批次-${input.batchKey}`,
      attempts: EMOTION_LEDGER_MAX_ATTEMPTS,
      signal: input.signal,
      schema: EMOTION_LEDGER_JSON_SCHEMA,
      request: (attempt, error) => modelService.chat(
        withGoalLoopModelOptions(input.workId, {
          workId: input.workId,
          chapterId: input.chapterId,
          step: 'emotion_state_extract',
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          temperature: 0,
          maxTokens: 1600,
          timeoutMs: 120_000,
          forceThinkingDisabled: true,
          responseSchema: {
            name: 'emotion_ledger',
            schema: EMOTION_LEDGER_JSON_SCHEMA,
            strict: true
          },
          structuredOutputMode: 'prompt_json',
          systemPrompt: [
            '你是跨章情绪状态提取器，只输出一个符合 JSON Schema 的对象。',
            `本批只能输出这些角色，且每个角色恰好一条：${input.characters.join('、')}。禁止输出其他角色。`,
            '只保留正文结尾仍会影响后续选择、语言、注意、回避、关系或信念的状态。',
            '字段必须简短。不得复述剧情，不得写心理分析报告，不得使用正文中无法验证的未来事件。',
            'behavioral_aftereffect 只能描述下一章可观察的倾向；belief_changes 和 relationship_changes 各最多 3 项。',
            `Schema：${JSON.stringify(EMOTION_LEDGER_JSON_SCHEMA)}`,
            attempt > 1
              ? `上一轮失败：${error}。重新生成完整短 JSON，不得复制截断内容。`
              : ''
          ].filter(Boolean).join('\n\n'),
          prompt: [
            `【本批角色】${input.characters.join('、')}`,
            `【情绪契约】\n${JSON.stringify(input.contract)}`,
            `【正文】\n${input.content}`
          ].join('\n\n')
        }),
        { stream: false, signal: input.signal }
      ),
      validate: value => {
        const states = parseEmotionLedgerResponse(JSON.stringify(value))
        const validation = validateEmotionLedgerBatch(states, input.characters)
        if (!validation.valid) {
          throw new EmotionLedgerParseError(
            `情绪账本角色集合不匹配：缺少 ${validation.missing.join('、') || '无'}`
            + `；多余 ${validation.unexpected.join('、') || '无'}`
            + `；重复 ${validation.duplicates.join('、') || '无'}`,
            JSON.stringify(value).slice(0, 240)
          )
        }
        return states
      },
      onAttemptFailure: ({ attempt, error, response }) => {
        const code = classifyEmotionLedgerFailure(error, response?.finishReason)
        const outputExcerpt = response?.content
          ? (code === 'EMOTION_LEDGER_TRUNCATED'
              ? response.content.slice(-240)
              : response.content.slice(0, 240))
          : ''
        const pipelineError = new EmotionLedgerPipelineError(
          code,
          error,
          outputExcerpt
        )
        lastError = pipelineError
        const persistedAttempts = chapterEmotionCheckpointDAO.fail({
          workId: input.workId,
          chapterId: input.chapterId,
          contentHash: input.contentHash,
          stage: 'ledger_batch',
          batchKey: input.batchKey,
          failureCode: pipelineError.code,
          failureMessage: pipelineError.message
        })
        appLogger.warn('emotion_ledger', '情绪账本批次输出无效', {
          workId: input.workId,
          chapterId: input.chapterId,
          batchKey: input.batchKey,
          attempt,
          persistedAttempts,
          errorCode: pipelineError.code,
          error: pipelineError.message,
          excerpt: pipelineError.outputExcerpt
        })
      }
    })
    const rows = ledgerRowsFromStates(input.workId, input.chapterId, states)
    chapterEmotionCheckpointDAO.complete({
      workId: input.workId,
      chapterId: input.chapterId,
      contentHash: input.contentHash,
      stage: 'ledger_batch',
      batchKey: input.batchKey,
      payload: rows
    })
    return rows
  } catch (error) {
    if (input.signal?.aborted) throw error
    const finalError = lastError ?? (error instanceof EmotionLedgerPipelineError
      ? error
      : new EmotionLedgerPipelineError(
          classifyEmotionLedgerFailure(error instanceof Error ? error.message : String(error)),
          error instanceof Error ? error.message : String(error),
          ''
        ))
    throw new EmotionLedgerPipelineError(
      finalError.code,
      `情绪账本批次 ${input.batchKey} 连续 ${EMOTION_LEDGER_MAX_ATTEMPTS} 次失败：${finalError.message}`,
      finalError.outputExcerpt
    )
  }
}

async function extractEmotionalLedgerRows(
  workId: number,
  chapterId: number,
  content: string,
  contract: EmotionContract,
  signal?: AbortSignal
): Promise<EmotionalStateLedgerInput[]> {
  const contentHash = emotionContentHash(content)
  chapterEmotionCheckpointDAO.deleteStale(chapterId, contentHash)
  const characters = chapterEmotionCharacters(chapterId, content, contract)
  if (characters.length === 0) {
    throw new EmotionLedgerPipelineError(
      'EMOTION_LEDGER_PROTOCOL',
      '无法确定本章需要提交情绪状态的角色',
      ''
    )
  }
  const rows: EmotionalStateLedgerInput[] = []
  const batches = planEmotionLedgerBatches(characters)
  for (const [index, batch] of batches.entries()) {
    rows.push(...await extractEmotionLedgerBatch({
      workId,
      chapterId,
      content,
      contentHash,
      contract,
      characters: batch,
      batchKey: ledgerBatchKey(index, batch),
      signal
    }))
  }
  const actualCharacters = rows.map(row => row.character_name)
  const missing = characters.filter(name => !actualCharacters.includes(name))
  const duplicates = actualCharacters.filter((name, index) => actualCharacters.indexOf(name) !== index)
  if (missing.length > 0 || duplicates.length > 0) {
    throw new EmotionLedgerPipelineError(
      'EMOTION_LEDGER_PROTOCOL',
      `情绪账本完整性失败：缺少 ${missing.join('、') || '无'}；重复 ${[...new Set(duplicates)].join('、') || '无'}`,
      ''
    )
  }
  return rows
}

async function checkpointedBlindRead(
  workId: number,
  chapterId: number,
  content: string,
  contentHash: string,
  signal?: AbortSignal
): Promise<BlindReadResult> {
  const checkpoint = chapterEmotionCheckpointDAO.find(
    chapterId,
    contentHash,
    'blind_read'
  )
  const cached = checkpoint?.status === 'completed'
    ? parseCheckpointPayload<BlindReadResult>(checkpoint.payload_json)
    : null
  if (cached) return cached
  try {
    const result = await blindRead(workId, chapterId, content, signal)
    chapterEmotionCheckpointDAO.complete({
      workId,
      chapterId,
      contentHash,
      stage: 'blind_read',
      payload: result
    })
    return result
  } catch (error) {
    if (signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    const code = classifyEmotionLedgerFailure(message)
    chapterEmotionCheckpointDAO.fail({
      workId,
      chapterId,
      contentHash,
      stage: 'blind_read',
      failureCode: code,
      failureMessage: message
    })
    throw new EmotionLedgerPipelineError(code, `情绪盲读失败：${message}`, '')
  }
}

async function checkpointedTargetCompare(
  workId: number,
  chapterId: number,
  contentHash: string,
  contract: EmotionContract,
  blind: BlindReadResult,
  signal?: AbortSignal
): Promise<Awaited<ReturnType<typeof compareTarget>>> {
  const checkpoint = chapterEmotionCheckpointDAO.find(
    chapterId,
    contentHash,
    'target_compare'
  )
  const cached = checkpoint?.status === 'completed'
    ? parseCheckpointPayload<Awaited<ReturnType<typeof compareTarget>>>(checkpoint.payload_json)
    : null
  if (cached) return cached
  try {
    const result = await compareTarget(workId, chapterId, contract, blind, signal)
    chapterEmotionCheckpointDAO.complete({
      workId,
      chapterId,
      contentHash,
      stage: 'target_compare',
      payload: result
    })
    return result
  } catch (error) {
    if (signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    const code = classifyEmotionLedgerFailure(message)
    chapterEmotionCheckpointDAO.fail({
      workId,
      chapterId,
      contentHash,
      stage: 'target_compare',
      failureCode: code,
      failureMessage: message
    })
    throw new EmotionLedgerPipelineError(code, `情绪目标比较失败：${message}`, '')
  }
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
  const contentHash = emotionContentHash(content)
  chapterEmotionCheckpointDAO.deleteStale(chapterId, contentHash)
  const blind = await checkpointedBlindRead(workId, chapterId, content, contentHash, signal)
  const compared = await checkpointedTargetCompare(
    workId,
    chapterId,
    contentHash,
    contract,
    blind,
    signal
  )
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
    repair_instruction: compared.repairInstruction,
    outcome_meta: {
      content_hash: contentHash,
      ledger_complete: false,
      ledger_schema_version: EMOTION_LEDGER_SCHEMA_VERSION
    }
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
    if (!isEmotionAssessmentAcceptedForTransition(stored)) return stored
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

/** 只生成情绪修复候选，不写入正文、情绪评估或跨章账本。 */
export async function repairEmotionCandidate(
  workId: number,
  chapterId: number,
  content: string,
  assessment: EmotionBlindAssessment,
  signal?: AbortSignal
): Promise<{ success: boolean; content: string; error?: string }> {
  const trimmed = content.trim()
  if (!trimmed) return { success: false, content, error: '当前章节没有可修订正文' }
  const contract = loadChapterEmotionContract(chapterId)
  if (!contract) return { success: false, content, error: '章节缺少 emotion_contract，无法定向修复' }

  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'emotion_repair',
      enrichWorkContext: false,
      enrichNarrativeMemory: true,
      temperature: 0.3,
      maxTokens: Math.max(6000, Math.min(12000, Math.ceil(countWords(trimmed) * 2))),
      systemPrompt: [
        '你是长篇小说情绪因果修复编辑。只输出修复后的完整正文，不要解释、标题或 Markdown。',
        '只修复盲读报告指出的情绪因果缺口，保留未被问题证据涉及的情节、事实、人物状态和有效表达。',
        '禁止用哭泣、心跳、身体反应、直接心理解释或堆叠形容词冒充情绪修复。',
        '必须通过可观察的主动选择、阻力、代价、表里冲突和事件余波建立读者关切。',
        '不得改变章节大纲、提前兑现后续情节、增加新支线或改写既有世界观事实。'
      ].join('\n'),
      prompt: [
        `【本章情绪合同】\n${JSON.stringify(contract, null, 2)}`,
        `【盲读失败报告】\n${emotionRepairHint(assessment)}`,
        `【当前正文】\n${trimmed}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )

  if (!response.success || !response.content?.trim()) {
    return { success: false, content, error: response.error || '情绪定向修复失败' }
  }
  if (response.finishReason === 'length') {
    return { success: false, content, error: '情绪定向修复输出被截断，候选正文未应用' }
  }
  return { success: true, content: response.content.trim() }
}

export const EMOTION_GATE_MIN_SCORE = EMOTION_PASS_SCORE
