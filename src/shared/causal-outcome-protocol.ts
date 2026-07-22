import { createHash } from 'node:crypto'
import type {
  CausalChapterOutcome,
  CausalNarrativeState
} from './causal-novel-types'

export const CAUSAL_OUTCOME_PROTOCOL_VERSION = 2

export interface CausalBodyEvidenceUnit {
  id: string
  paragraph: number
  start: number
  end: number
  text: string
}

export interface CausalOutcomeCoreDraft {
  summary: string
  eventSignature: string
  evidenceIds: string[]
  advancedPromiseIds: string[]
  resolvedPromiseIds: string[]
  newPromiseQuestions: string[]
  terminalConditionMet: boolean
  matchedTerminalCondition: string
  terminalEvidenceIds: string[]
  completionReason: string
}

export interface CausalOutcomeActorDraft {
  actorUpdates: Array<{
    actor: string
    currentGoal: string
    knowledgeAdded: string[]
    resourcesAdded: string[]
    resourcesRemoved: string[]
    constraint: string
    evidenceIds: string[]
  }>
  newActors: Array<{
    name: string
    currentGoal: string
    fear: string
    knowledge: string[]
    resources: string[]
    constraint: string
    evidenceIds: string[]
  }>
}

export interface CausalOutcomeWorldDraft {
  pressureUpdates: Array<{
    id: string
    direction: 'stable' | 'escalated' | 'relieved' | 'resolved'
    condition: string
    urgency: number
    evidenceIds: string[]
  }>
  newPressures: Array<{
    source: string
    target: string
    condition: string
    escalation: string
    urgency: number
    evidenceIds: string[]
  }>
  arcUpdates: Array<{
    id: string
    status: 'active' | 'completed'
    evidenceIds: string[]
  }>
}

export interface CausalOutcomeEmotionDraft {
  readerEffectSummary: string
  triggerEvidenceIds: string[]
  choiceEvidenceIds: string[]
  costEvidenceIds: string[]
  residueEvidenceIds: string[]
  emotionalDebtOpened: string
  emotionalDebtPaid: string
}

export interface CausalOutcomeDraftBundle {
  core: CausalOutcomeCoreDraft
  actors: CausalOutcomeActorDraft
  world: CausalOutcomeWorldDraft
  emotion: CausalOutcomeEmotionDraft
}

export type CausalOutcomeFailureCode =
  | 'OUTCOME_TRANSPORT'
  | 'OUTCOME_SCHEMA'
  | 'OUTCOME_EVIDENCE_ID'
  | 'OUTCOME_REFERENCE'
  | 'OUTCOME_OPERATION'
  | 'OUTCOME_PROMISE_PROGRESS'
  | 'OUTCOME_EMOTION'
  | 'OUTCOME_ENTAILMENT'
  | 'OUTCOME_BUDGET'
  | 'OUTCOME_STALE_BODY'
  | 'OUTCOME_UNKNOWN'

export class CausalOutcomeProtocolError extends Error {
  constructor(
    public readonly code: CausalOutcomeFailureCode,
    message: string,
    public readonly paths: string[] = []
  ) {
    super(message)
    this.name = 'CausalOutcomeProtocolError'
  }
}

function trimmedSpan(content: string, start: number, end: number): { start: number; end: number; text: string } | null {
  while (start < end && /\s/.test(content[start])) start++
  while (end > start && /\s/.test(content[end - 1])) end--
  if (end <= start) return null
  return { start, end, text: content.slice(start, end) }
}

/**
 * 确定性正文证据索引。ID 只表达当前正文版本内的位置；版本身份由 bodyHash/checkpoint 键负责。
 * 句末标点和紧随其后的闭引号保留在同一单元，禁止模型自行拼接不连续文本。
 */
export function buildCausalBodyEvidenceUnits(content: string): CausalBodyEvidenceUnit[] {
  const units: CausalBodyEvidenceUnit[] = []
  const paragraphs = [...content.matchAll(/[^\r\n]+/g)]
  let sequence = 0
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
    const match = paragraphs[paragraphIndex]
    const paragraph = match[0]
    const paragraphStart = match.index ?? 0
    let segmentStart = 0
    for (let index = 0; index < paragraph.length; index++) {
      const terminal = /[。！？!?；;]/.test(paragraph[index])
      const reachedSoftLimit = index - segmentStart >= 220 && /[，,、：:]/.test(paragraph[index])
      if (!terminal && !reachedSoftLimit) continue
      let segmentEnd = index + 1
      while (segmentEnd < paragraph.length && /[”’"』」）》】]/.test(paragraph[segmentEnd])) segmentEnd++
      const span = trimmedSpan(content, paragraphStart + segmentStart, paragraphStart + segmentEnd)
      if (span) {
        sequence++
        units.push({
          id: `e${String(sequence).padStart(4, '0')}`,
          paragraph: paragraphIndex + 1,
          ...span
        })
      }
      segmentStart = segmentEnd
      index = segmentEnd - 1
    }
    const tail = trimmedSpan(content, paragraphStart + segmentStart, paragraphStart + paragraph.length)
    if (tail) {
      sequence++
      units.push({
        id: `e${String(sequence).padStart(4, '0')}`,
        paragraph: paragraphIndex + 1,
        ...tail
      })
    }
  }
  if (!units.length && content.trim()) {
    const start = content.indexOf(content.trim())
    units.push({ id: 'e0001', paragraph: 1, start, end: start + content.trim().length, text: content.trim() })
  }
  return units
}

export function causalEvidenceIndexHash(units: CausalBodyEvidenceUnit[]): string {
  return createHash('sha256').update(JSON.stringify(units)).digest('hex')
}

export function validateCausalEvidenceIds(
  units: CausalBodyEvidenceUnit[],
  ids: string[],
  path: string,
  options: { min?: number; max?: number } = {}
): string[] {
  const allowed = new Set(units.map(unit => unit.id))
  const normalized = [...new Set(ids.map(id => id.trim()).filter(Boolean))]
  const min = options.min ?? 1
  const max = options.max ?? 8
  if (normalized.length < min || normalized.length > max) {
    throw new CausalOutcomeProtocolError(
      'OUTCOME_EVIDENCE_ID', `${path} 需要 ${min}-${max} 个正文证据 ID`, [path]
    )
  }
  const invalid = normalized.filter(id => !allowed.has(id))
  if (invalid.length) {
    throw new CausalOutcomeProtocolError(
      'OUTCOME_EVIDENCE_ID', `${path} 引用了不存在的正文证据 ID：${invalid.join('、')}`, [path]
    )
  }
  return normalized
}

function nextServerId(prefix: string, existing: Iterable<string>): string {
  const used = new Set(existing)
  let index = 1
  while (used.has(`${prefix}${index}`)) index++
  return `${prefix}${index}`
}

function evidenceText(ids: string[], unitMap: Map<string, CausalBodyEvidenceUnit>): string {
  return ids.map(id => unitMap.get(id)?.text ?? '').filter(Boolean).join(' ｜ ')
}

function assertNonEmpty(value: string, path: string, code: CausalOutcomeFailureCode = 'OUTCOME_SCHEMA'): string {
  const normalized = value.trim()
  if (!normalized) throw new CausalOutcomeProtocolError(code, `${path} 不能为空`, [path])
  return normalized
}

function looksLikeCondition(value: string): boolean {
  return /伤|血|感染|中毒|骨折|残疾|疼痛|昏迷|僵硬|咳血|症状/.test(value)
}

export function materializeCausalOutcomeDraft(input: {
  state: CausalNarrativeState
  units: CausalBodyEvidenceUnit[]
  draft: CausalOutcomeDraftBundle
}): CausalChapterOutcome {
  const { state, units, draft } = input
  const unitMap = new Map(units.map(unit => [unit.id, unit]))
  const usedEvidenceIds = new Set<string>()
  const useEvidence = (ids: string[], path: string, min = 1): string[] => {
    const valid = validateCausalEvidenceIds(units, ids, path, { min })
    valid.forEach(id => usedEvidenceIds.add(id))
    return valid
  }

  const activePromises = new Set(state.promises.filter(item => item.status !== 'resolved').map(item => item.id))
  for (const id of [...draft.core.advancedPromiseIds, ...draft.core.resolvedPromiseIds]) {
    if (!activePromises.has(id)) {
      throw new CausalOutcomeProtocolError('OUTCOME_REFERENCE', `章后结果引用了不存在或已关闭的读者承诺：${id}`, ['core.advancedPromiseIds'])
    }
  }
  const progressed = new Set([...draft.core.advancedPromiseIds, ...draft.core.resolvedPromiseIds])
  if (!progressed.size) {
    throw new CausalOutcomeProtocolError('OUTCOME_PROMISE_PROGRESS', '章后结果没有推进任何读者承诺', ['core.advancedPromiseIds'])
  }
  const coreEvidenceIds = useEvidence(draft.core.evidenceIds, 'core.evidenceIds')
  const actorNames = new Set(state.actors.map(actor => actor.name))
  const actorUpdates = draft.actors.actorUpdates.map((update, index) => {
    const path = `actors.actorUpdates[${index}]`
    if (!actorNames.has(update.actor)) {
      throw new CausalOutcomeProtocolError('OUTCOME_REFERENCE', `${path} 引用了不存在的人物：${update.actor}`, [`${path}.actor`])
    }
    const evidenceIds = useEvidence(update.evidenceIds, `${path}.evidenceIds`)
    const invalidResource = [...update.resourcesAdded, ...update.resourcesRemoved].find(looksLikeCondition)
    if (invalidResource) {
      throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `${path} 把伤势/身体状态误当作资源：${invalidResource}`, [`${path}.resourcesAdded`])
    }
    return {
      actor: update.actor,
      currentGoal: update.currentGoal.trim() || undefined,
      knowledgeAdded: update.knowledgeAdded.map(value => value.trim()).filter(Boolean),
      resourcesAdded: update.resourcesAdded.map(value => value.trim()).filter(Boolean),
      resourcesRemoved: update.resourcesRemoved.map(value => value.trim()).filter(Boolean),
      constraint: update.constraint.trim() || undefined,
      evidence: evidenceText(evidenceIds, unitMap),
      evidenceIds
    }
  })
  const newActors = draft.actors.newActors.map((item, index) => {
    const path = `actors.newActors[${index}]`
    const name = assertNonEmpty(item.name, `${path}.name`)
    if (actorNames.has(name)) {
      throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `新增人物重复：${name}`, [`${path}.name`])
    }
    actorNames.add(name)
    const evidenceIds = useEvidence(item.evidenceIds, `${path}.evidenceIds`)
    return {
      actor: {
        name,
        currentGoal: item.currentGoal.trim(),
        fear: item.fear.trim(),
        knowledge: item.knowledge.map(value => value.trim()).filter(Boolean),
        resources: item.resources.map(value => value.trim()).filter(Boolean),
        constraint: item.constraint.trim()
      },
      evidence: evidenceText(evidenceIds, unitMap),
      evidenceIds
    }
  })

  const pressureMap = new Map(state.activePressures.map(item => [item.id, item]))
  const pressureUpdates = draft.world.pressureUpdates.map((update, index) => {
    const path = `world.pressureUpdates[${index}]`
    const previous = pressureMap.get(update.id)
    if (!previous) {
      throw new CausalOutcomeProtocolError('OUTCOME_REFERENCE', `${path} 引用了不存在的压力：${update.id}`, [`${path}.id`])
    }
    if (update.direction === 'escalated' && update.urgency < previous.urgency) {
      throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `${path} 声明升级但紧迫度下降`, [`${path}.urgency`])
    }
    if (update.direction === 'relieved' && update.urgency > previous.urgency) {
      throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `${path} 声明缓解但紧迫度上升`, [`${path}.urgency`])
    }
    const evidenceIds = useEvidence(update.evidenceIds, `${path}.evidenceIds`)
    return {
      id: update.id,
      status: update.direction,
      condition: update.condition.trim() || undefined,
      urgency: update.urgency,
      evidence: evidenceText(evidenceIds, unitMap),
      evidenceIds
    }
  })
  const assignedPressureIds = new Set(pressureMap.keys())
  const newPressures = draft.world.newPressures.map((item, index) => {
    const path = `world.newPressures[${index}]`
    const id = nextServerId('ap', assignedPressureIds)
    assignedPressureIds.add(id)
    const evidenceIds = useEvidence(item.evidenceIds, `${path}.evidenceIds`)
    return {
      pressure: {
        id,
        source: assertNonEmpty(item.source, `${path}.source`),
        target: assertNonEmpty(item.target, `${path}.target`),
        condition: assertNonEmpty(item.condition, `${path}.condition`),
        escalation: assertNonEmpty(item.escalation, `${path}.escalation`),
        urgency: item.urgency,
        status: 'active' as const
      },
      evidence: evidenceText(evidenceIds, unitMap),
      evidenceIds
    }
  })
  const arcIds = new Set(state.macroArcs.map(item => item.id))
  const arcUpdates = draft.world.arcUpdates.map((update, index) => {
    const path = `world.arcUpdates[${index}]`
    if (!arcIds.has(update.id)) {
      throw new CausalOutcomeProtocolError('OUTCOME_REFERENCE', `${path} 引用了不存在的阶段：${update.id}`, [`${path}.id`])
    }
    const evidenceIds = useEvidence(update.evidenceIds, `${path}.evidenceIds`)
    return { ...update, evidence: evidenceText(evidenceIds, unitMap), evidenceIds }
  })

  const emotion = draft.emotion
  const triggerEvidenceIds = useEvidence(emotion.triggerEvidenceIds, 'emotion.triggerEvidenceIds')
  const choiceEvidenceIds = useEvidence(emotion.choiceEvidenceIds, 'emotion.choiceEvidenceIds')
  const costEvidenceIds = useEvidence(emotion.costEvidenceIds, 'emotion.costEvidenceIds')
  const residueEvidenceIds = useEvidence(emotion.residueEvidenceIds, 'emotion.residueEvidenceIds')
  const terminalEvidenceIds = draft.core.terminalConditionMet
    ? useEvidence(draft.core.terminalEvidenceIds, 'core.terminalEvidenceIds')
    : useEvidence(draft.core.terminalEvidenceIds, 'core.terminalEvidenceIds', 0)
  if (draft.core.terminalConditionMet && !state.terminalConditions.includes(draft.core.matchedTerminalCondition.trim())) {
    throw new CausalOutcomeProtocolError('OUTCOME_REFERENCE', '完结声明没有命中权威终止条件', ['core.matchedTerminalCondition'])
  }

  const promiseIds = new Set([...state.promises.map(item => item.id), ...state.archivedPromiseIds])
  const newPromises = draft.core.newPromiseQuestions.map(question => {
    const id = nextServerId('p', promiseIds)
    promiseIds.add(id)
    return { id, question: assertNonEmpty(question, 'core.newPromiseQuestions') }
  })
  const evidenceRefs = [...usedEvidenceIds].map(id => ({ id, text: unitMap.get(id)!.text }))
  return {
    summary: assertNonEmpty(draft.core.summary, 'core.summary'),
    eventSignature: assertNonEmpty(draft.core.eventSignature, 'core.eventSignature'),
    evidenceQuotes: coreEvidenceIds.map(id => unitMap.get(id)!.text),
    evidenceRefs,
    advancedPromiseIds: [...new Set(draft.core.advancedPromiseIds)],
    resolvedPromiseIds: [...new Set(draft.core.resolvedPromiseIds)],
    newPromises,
    actorUpdates,
    newActors,
    pressureUpdates,
    newPressures,
    arcUpdates,
    emotionalOutcome: {
      readerEffectSummary: assertNonEmpty(emotion.readerEffectSummary, 'emotion.readerEffectSummary', 'OUTCOME_EMOTION'),
      triggerEvidence: evidenceText(triggerEvidenceIds, unitMap),
      choiceEvidence: evidenceText(choiceEvidenceIds, unitMap),
      costEvidence: evidenceText(costEvidenceIds, unitMap),
      residueEvidence: evidenceText(residueEvidenceIds, unitMap),
      triggerEvidenceIds,
      choiceEvidenceIds,
      costEvidenceIds,
      residueEvidenceIds,
      emotionalDebtOpened: emotion.emotionalDebtOpened.trim(),
      emotionalDebtPaid: emotion.emotionalDebtPaid.trim()
    },
    terminalConditionMet: draft.core.terminalConditionMet,
    matchedTerminalCondition: draft.core.terminalConditionMet ? draft.core.matchedTerminalCondition.trim() : '',
    terminalEvidence: evidenceText(terminalEvidenceIds, unitMap),
    terminalEvidenceIds,
    completionReason: draft.core.terminalConditionMet ? assertNonEmpty(draft.core.completionReason, 'core.completionReason') : ''
  }
}

export function causalOutcomeFailureCode(error: unknown): CausalOutcomeFailureCode {
  if (error instanceof CausalOutcomeProtocolError) return error.code
  const message = error instanceof Error ? error.message : String(error)
  const cause = message.includes('结构化输出无效：')
    ? message.slice(message.lastIndexOf('结构化输出无效：') + '结构化输出无效：'.length)
    : message
  if (/预算|调用次数|超过 \d+ 次/.test(cause)) return 'OUTCOME_BUDGET'
  if (/timeout|timed out|网络|连接|模型无返回|请求失败/i.test(cause)) return 'OUTCOME_TRANSPORT'
  if (/蕴含|审计/.test(cause)) return 'OUTCOME_ENTAILMENT'
  if (/证据|evidence/i.test(cause)) return 'OUTCOME_EVIDENCE_ID'
  if (/资源|紧迫度|操作类型|重复/.test(cause)) return 'OUTCOME_OPERATION'
  if (/引用不存在|不存在的人物|不存在的压力|不存在的阶段|已关闭/.test(cause)) return 'OUTCOME_REFERENCE'
  if (/承诺/.test(cause)) return 'OUTCOME_PROMISE_PROGRESS'
  if (/情绪/.test(cause)) return 'OUTCOME_EMOTION'
  if (/正文.*变化|过期|哈希/.test(cause)) return 'OUTCOME_STALE_BODY'
  if (/JSON|结构化|格式|Unexpected token|Expected property|缺少.*字段/.test(cause)) return 'OUTCOME_SCHEMA'
  return 'OUTCOME_UNKNOWN'
}
