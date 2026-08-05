import type {
  CausalChapterDecisionRecord,
  CausalNarrativeState
} from '../../../shared/causal-novel-types'

export interface CausalOutcomeActorPromptState {
  name: string
  currentGoal: string
  constraint: string
  location: string
  physicalState: string
  knowledgeLedgerCount: number
  resourceLedgerCount: number
  relationshipLedgerCount: number
  obligationLedgerCount: number
}

/**
 * 人物阶段只需要章初标量与历史账本规模。
 * 历史集合正文会诱导模型复述全书状态，完整集合只留在确定性校验与 CAS 提交层。
 */
export function projectCausalOutcomeActorPromptState(
  state: CausalNarrativeState
): CausalOutcomeActorPromptState[] {
  return state.actors.map(actor => ({
    name: actor.name,
    currentGoal: actor.currentGoal,
    constraint: actor.constraint,
    location: actor.location,
    physicalState: actor.physicalState,
    knowledgeLedgerCount: actor.knowledge.length,
    resourceLedgerCount: actor.resources.length,
    relationshipLedgerCount: actor.relationships.length,
    obligationLedgerCount: actor.obligations.length
  }))
}

function referencedIds(refs: string[], prefix: string): string[] {
  return refs
    .filter(ref => ref.startsWith(`${prefix}:`))
    .map(ref => ref.slice(prefix.length + 1).trim())
    .filter(Boolean)
}

/**
 * 章后提取只读取冻结章节合同可触达的状态切片。
 * 权威全量状态仍由最终确定性校验和 CAS 提交持有，禁止把全书状态复制进每个模型请求。
 */
export function projectCausalOutcomeState(
  state: CausalNarrativeState,
  record: CausalChapterDecisionRecord
): CausalNarrativeState {
  const decision = record.plan.decision
  const horizon = record.plan.rollingHorizon.find(item => item.offset === 0)
  const groundingRefs = record.plan.emotionContract.grounding_refs
  const actorNames = new Set([
    decision.initiator,
    decision.pov,
    ...decision.characters,
    ...referencedIds(groundingRefs, 'actor')
  ].filter(Boolean))
  const pressureIds = new Set([
    ...(horizon?.pressureIds ?? []),
    ...referencedIds(groundingRefs, 'pressure')
  ])
  const promiseIds = new Set([
    ...decision.advancedPromiseIds,
    ...(horizon?.promiseIds ?? []),
    ...referencedIds(groundingRefs, 'promise')
  ])

  return {
    ...state,
    actors: state.actors.filter(actor => actorNames.has(actor.name)),
    activePressures: state.activePressures.filter(pressure => pressureIds.has(pressure.id)),
    promises: state.promises.filter(promise => promiseIds.has(promise.id)),
    macroArcs: state.macroArcs.filter(arc => arc.status === 'active'),
    archivedPromiseIds: [],
    recentEventSignatures: state.recentEventSignatures.slice(-8),
    completionAuditFeedback: state.completionAuditFeedback.slice(-4)
  }
}
