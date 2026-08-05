import type { NarrativeEvent } from './domain'
import { assertNarrativeKernel } from './errors'
import { canonicalHash, sha256 } from './hash'

export const NARRATIVE_CHAPTER_PROTOCOL_VERSION = 1 as const

export type NarrativeEventType = NarrativeEvent['type']

export interface EventRequirement {
  eventType: NarrativeEventType
  entityId?: string
  minCount: number
}

export interface EventProhibition {
  eventType: NarrativeEventType
  entityId?: string
}

export interface ChapterIntentInput {
  id: string
  workId: number
  chapterOrdinal: number
  baseStateRevision: number
  objective: string
  requiredEvents: EventRequirement[]
  forbiddenEvents: EventProhibition[]
  allowedEntityIds: string[]
  creatableEntityIds: string[]
  targetWordRange: { min: number; max: number }
}

export interface ChapterIntent extends ChapterIntentInput {
  protocolVersion: typeof NARRATIVE_CHAPTER_PROTOCOL_VERSION
  contractHash: string
}

export interface CandidateGenerationMetadata {
  source: 'model' | 'author' | 'revision'
  finishReason?: string
  completionTokens?: number
  modelCallId?: string
}

export interface ChapterCandidateInput {
  id: string
  intentId: string
  parentCandidateId?: string
  content: string
  generation: CandidateGenerationMetadata
}

export interface ChapterCandidate extends ChapterCandidateInput {
  contentHash: string
  wordCount: number
}

export interface CandidateEvidenceSpan {
  candidateId: string
  startOffset: number
  endOffset: number
  quoteHash: string
}

type WithCandidateEvidence<T> = T extends NarrativeEvent
  ? Omit<T, 'evidence'> & { evidence: CandidateEvidenceSpan }
  : never

export type ProposedNarrativeEvent = WithCandidateEvidence<NarrativeEvent>

export interface NarrativePatchInput {
  id: string
  intentId: string
  candidateId: string
  baseStateRevision: number
  events: ProposedNarrativeEvent[]
}

export interface NarrativePatch extends NarrativePatchInput {
  protocolVersion: typeof NARRATIVE_CHAPTER_PROTOCOL_VERSION
  patchHash: string
}

export type EditorialGateType =
  | 'causal_motivation'
  | 'emotion_contract'
  | 'chapter_objective'
  | 'voice_style'
  | 'repetition'
  | 'opening_hook'

export const REQUIRED_EDITORIAL_GATES: readonly EditorialGateType[] = [
  'causal_motivation',
  'emotion_contract',
  'chapter_objective',
  'voice_style',
  'repetition',
  'opening_hook'
]

export interface EditorialGateResult {
  id: string
  candidateId: string
  gateType: EditorialGateType
  policyVersion: number
  status: 'passed' | 'failed'
  score?: number
  report: string
  reportHash: string
  evidence: CandidateEvidenceSpan[]
  resultHash: string
}

function assertNonEmpty(value: string, field: string): void {
  assertNarrativeKernel(
    value.trim().length > 0,
    'CHAPTER_INTENT_INVALID',
    `章节契约字段不能为空：${field}`,
    { field }
  )
}

function assertUnique(values: string[], field: string): void {
  assertNarrativeKernel(
    new Set(values).size === values.length,
    'CHAPTER_INTENT_INVALID',
    `章节契约字段包含重复值：${field}`,
    { field, values }
  )
}

export function createChapterIntent(input: ChapterIntentInput): ChapterIntent {
  assertNonEmpty(input.id, 'id')
  assertNonEmpty(input.objective, 'objective')
  assertNarrativeKernel(
    Number.isInteger(input.workId) && input.workId > 0,
    'CHAPTER_INTENT_INVALID',
    'workId 必须是正整数'
  )
  assertNarrativeKernel(
    Number.isInteger(input.chapterOrdinal) && input.chapterOrdinal > 0,
    'CHAPTER_INTENT_INVALID',
    'chapterOrdinal 必须是正整数'
  )
  assertNarrativeKernel(
    Number.isInteger(input.baseStateRevision) && input.baseStateRevision >= 0,
    'CHAPTER_INTENT_INVALID',
    'baseStateRevision 必须是非负整数'
  )
  assertNarrativeKernel(
    Number.isInteger(input.targetWordRange.min) &&
      Number.isInteger(input.targetWordRange.max) &&
      input.targetWordRange.min > 0 &&
      input.targetWordRange.max >= input.targetWordRange.min,
    'CHAPTER_INTENT_INVALID',
    '章节目标字数范围无效',
    { targetWordRange: input.targetWordRange }
  )
  assertUnique(input.allowedEntityIds, 'allowedEntityIds')
  assertUnique(input.creatableEntityIds, 'creatableEntityIds')
  const overlap = input.allowedEntityIds.filter(id => input.creatableEntityIds.includes(id))
  assertNarrativeKernel(
    overlap.length === 0,
    'CHAPTER_INTENT_INVALID',
    '已存在实体与可创建实体不能重叠',
    { entityIds: overlap }
  )
  for (const requirement of input.requiredEvents) {
    assertNarrativeKernel(
      Number.isInteger(requirement.minCount) && requirement.minCount > 0,
      'CHAPTER_INTENT_INVALID',
      '必须事件数量必须是正整数',
      { requirement }
    )
    const prohibited = input.forbiddenEvents.some(item =>
      item.eventType === requirement.eventType && item.entityId === requirement.entityId
    )
    assertNarrativeKernel(
      !prohibited,
      'CHAPTER_INTENT_INVALID',
      '同一事件不能同时被要求和禁止',
      { requirement }
    )
  }
  const payload = {
    ...input,
    protocolVersion: NARRATIVE_CHAPTER_PROTOCOL_VERSION
  }
  return { ...payload, contractHash: canonicalHash(payload) }
}

export function countNarrativeWords(content: string): number {
  return content.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu)?.length ?? 0
}

export function createChapterCandidate(
  intent: ChapterIntent,
  input: ChapterCandidateInput
): ChapterCandidate {
  assertNarrativeKernel(
    input.id.trim().length > 0,
    'CHAPTER_CANDIDATE_INVALID',
    '候选正文 ID 不能为空'
  )
  assertNarrativeKernel(
    input.intentId === intent.id,
    'CHAPTER_CANDIDATE_INVALID',
    '候选正文不属于当前章节契约',
    { expectedIntentId: intent.id, actualIntentId: input.intentId }
  )
  assertNarrativeKernel(
    input.content.trim().length > 0,
    'CHAPTER_CANDIDATE_INVALID',
    '候选正文不能为空',
    { candidateId: input.id }
  )
  if (input.generation.source === 'model') {
    assertNarrativeKernel(
      input.generation.finishReason === 'stop',
      'CHAPTER_CANDIDATE_TRUNCATED',
      '模型候选没有正常结束',
      {
        candidateId: input.id,
        finishReason: input.generation.finishReason
      }
    )
    assertNarrativeKernel(
      Number.isInteger(input.generation.completionTokens) &&
        (input.generation.completionTokens ?? 0) > 0,
      'CHAPTER_CANDIDATE_INVALID',
      '模型候选缺少有效 completion token 记录',
      { candidateId: input.id }
    )
  }
  assertNarrativeKernel(
    input.generation.source !== 'revision' || Boolean(input.parentCandidateId),
    'CHAPTER_CANDIDATE_INVALID',
    '修订候选必须引用父候选',
    { candidateId: input.id }
  )
  const wordCount = countNarrativeWords(input.content)
  assertNarrativeKernel(
    wordCount >= intent.targetWordRange.min && wordCount <= intent.targetWordRange.max,
    'CHAPTER_WORD_COUNT_OUT_OF_RANGE',
    '候选正文不满足章节字数契约',
    { candidateId: input.id, wordCount, targetWordRange: intent.targetWordRange }
  )
  return {
    ...input,
    contentHash: sha256(input.content),
    wordCount
  }
}

export function createNarrativePatch(input: NarrativePatchInput): NarrativePatch {
  assertNarrativeKernel(
    input.id.trim().length > 0 &&
      input.intentId.trim().length > 0 &&
      input.candidateId.trim().length > 0 &&
      Number.isInteger(input.baseStateRevision) &&
      input.baseStateRevision >= 0,
    'NARRATIVE_PATCH_INVALID',
    '叙事补丁身份或基础修订无效',
    { patchId: input.id }
  )
  assertNarrativeKernel(
    input.events.length > 0,
    'NARRATIVE_PATCH_INVALID',
    '叙事补丁至少包含一个事件',
    { patchId: input.id }
  )
  const eventIds = input.events.map(event => event.id)
  assertNarrativeKernel(
    new Set(eventIds).size === eventIds.length,
    'NARRATIVE_PATCH_INVALID',
    '叙事补丁包含重复事件 ID',
    { patchId: input.id, eventIds }
  )
  const payload = {
    ...input,
    protocolVersion: NARRATIVE_CHAPTER_PROTOCOL_VERSION
  }
  return { ...payload, patchHash: canonicalHash(payload) }
}

export function createEditorialGateResult(
  input: Omit<EditorialGateResult, 'reportHash' | 'resultHash'>
): EditorialGateResult {
  assertNarrativeKernel(
    Number.isInteger(input.policyVersion) && input.policyVersion > 0,
    'EDITORIAL_GATE_INCOMPLETE',
    '文学门策略版本必须是正整数',
    { gateType: input.gateType }
  )
  assertNarrativeKernel(
    input.report.trim().length > 0,
    'EDITORIAL_GATE_INCOMPLETE',
    '文学门必须提供审读报告',
    { gateType: input.gateType }
  )
  assertNarrativeKernel(
    input.evidence.length > 0,
    'EDITORIAL_GATE_INCOMPLETE',
    '文学门必须绑定至少一处候选正文证据',
    { gateType: input.gateType, candidateId: input.candidateId }
  )
  if (input.score != null) {
    assertNarrativeKernel(
      Number.isFinite(input.score) && input.score >= 0 && input.score <= 100,
      'EDITORIAL_GATE_INCOMPLETE',
      '文学门评分必须位于 0 到 100',
      { gateType: input.gateType, score: input.score }
    )
  }
  const result = { ...input, reportHash: sha256(input.report) }
  return { ...result, resultHash: canonicalHash(result) }
}
