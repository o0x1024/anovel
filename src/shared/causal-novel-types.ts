import {
  formatEmotionContractForPrompt,
  validateEmotionContract,
  type EmotionContract
} from './emotion-contract'

export const CAUSAL_NOVEL_SCHEMA_VERSION = 1

export type CausalPromiseStatus = 'open' | 'advanced' | 'resolved'

export interface CausalActorState {
  name: string
  currentGoal: string
  fear: string
  knowledge: string[]
  resources: string[]
  constraint: string
}

export interface CausalPressure {
  id: string
  source: string
  target: string
  condition: string
  escalation: string
  urgency: number
  status: 'active' | 'resolved'
}

export interface CausalReaderPromise {
  id: string
  question: string
  status: CausalPromiseStatus
  openedChapter: number
  lastAdvancedChapter: number
}

export interface CausalNarrativeState {
  schemaVersion: typeof CAUSAL_NOVEL_SCHEMA_VERSION
  revision: number
  centralQuestion: string
  terminalConditions: string[]
  immutableRules: string[]
  actors: CausalActorState[]
  activePressures: CausalPressure[]
  promises: CausalReaderPromise[]
  recentEventSignatures: string[]
  completed: boolean
  completionReason: string
}

export interface CausalEventCandidate {
  id: string
  initiator: string
  action: string
  opposition: string
  cost: string
  irreversibleChange: string
  promiseAdvanced: string
  newQuestion: string
  scores: {
    causalNecessity: number
    promiseProgress: number
    irreversibleImpact: number
    novelty: number
    pressureEscalation: number
    total: number
  }
}

export interface CausalChapterDecision {
  title: string
  pov: string
  initiator: string
  immediateWant: string
  chosenAction: string
  opposition: string
  cost: string
  openingState: string
  mustCover: string[]
  forbiddenEvents: string[]
  endingState: string
  continuityConstraints: string[]
  characters: string[]
  advancedPromiseIds: string[]
  newQuestion: string
}

export interface CausalChapterPlan {
  candidates: CausalEventCandidate[]
  selectedCandidateId: string
  decision: CausalChapterDecision
  emotionContract: CausalChapterEmotionContract
}

/**
 * 因果模式不建立全书关系路线。情绪合同只约束当前章，并且所有依据必须引用
 * 当前权威状态或已提交正文，禁止模型凭空补造传统小说设定。
 */
export interface CausalChapterEmotionContract extends EmotionContract {
  grounding_refs: string[]
}

export interface CausalChapterEmotionalOutcome {
  readerEffectSummary: string
  triggerEvidence: string
  choiceEvidence: string
  costEvidence: string
  residueEvidence: string
  emotionalDebtOpened: string
  emotionalDebtPaid: string
}

export interface CausalActorUpdate {
  actor: string
  currentGoal?: string
  knowledgeAdded?: string[]
  resourcesAdded?: string[]
  resourcesRemoved?: string[]
  constraint?: string
  evidence: string
}

export interface CausalPressureUpdate {
  id: string
  status: 'unchanged' | 'escalated' | 'resolved'
  condition?: string
  urgency?: number
  evidence: string
}

export interface CausalChapterOutcome {
  summary: string
  eventSignature: string
  evidenceQuotes: string[]
  advancedPromiseIds: string[]
  resolvedPromiseIds: string[]
  newPromises: Array<{ id: string; question: string }>
  actorUpdates: CausalActorUpdate[]
  pressureUpdates: CausalPressureUpdate[]
  newPressures: Array<{ pressure: CausalPressure; evidence: string }>
  emotionalOutcome: CausalChapterEmotionalOutcome
  terminalConditionMet: boolean
  completionReason: string
}

export interface CausalChapterDecisionRecord {
  chapterId: number
  workId: number
  stateRevision: number
  status: 'planned' | 'committed' | 'rejected'
  plan: CausalChapterPlan
  outcome: CausalChapterOutcome | null
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))]
}

function clampUrgency(value: number): number {
  return Math.max(1, Math.min(10, Math.round(value)))
}

function assertEvidence(content: string, evidence: string, label: string): void {
  const quote = evidence.trim()
  if (!quote || !content.includes(quote)) throw new Error(`${label}缺少正文逐字证据`)
}

export function causalEmotionGroundingRefs(
  state: CausalNarrativeState,
  recentChapterIds: number[] = []
): string[] {
  return [
    ...state.actors.map(actor => `actor:${actor.name}`),
    ...state.activePressures.filter(item => item.status === 'active').map(item => `pressure:${item.id}`),
    ...state.promises.filter(item => item.status !== 'resolved').map(item => `promise:${item.id}`),
    ...state.immutableRules.map((_, index) => `rule:${index + 1}`),
    ...recentChapterIds.map(id => `recent:${id}`)
  ]
}

export function validateCausalChapterEmotionContract(
  state: CausalNarrativeState,
  plan: CausalChapterPlan,
  recentChapterIds: number[] = []
): void {
  const contract = plan.emotionContract
  const errors = validateEmotionContract(contract)
  if (errors.length > 0) throw new Error(`因果章节情绪事务无效：${errors.join('；')}`)
  if (contract.pov_character !== plan.decision.pov) {
    throw new Error('因果章节情绪事务的视角人物与章节决策不一致')
  }
  const allowed = new Set(causalEmotionGroundingRefs(state, recentChapterIds))
  const refs = [...new Set(contract.grounding_refs.map(item => item.trim()).filter(Boolean))]
  if (refs.length < 2) throw new Error('因果章节情绪事务至少需要两个权威依据')
  const invalid = refs.filter(ref => !allowed.has(ref))
  if (invalid.length > 0) throw new Error(`因果章节情绪事务引用了非权威依据：${invalid.join('、')}`)
  if (!refs.includes(`actor:${plan.decision.pov}`)) {
    throw new Error('因果章节情绪事务没有引用当前视角人物状态')
  }
  if (!refs.some(ref => /^(pressure|promise|rule|recent):/.test(ref))) {
    throw new Error('因果章节情绪事务缺少世界压力、读者承诺、硬规则或前章正文依据')
  }
}

export function applyCausalChapterOutcome(
  state: CausalNarrativeState,
  outcome: CausalChapterOutcome,
  chapterOrdinal: number,
  content: string
): CausalNarrativeState {
  const emotional = outcome.emotionalOutcome
  if (!emotional || !emotional.readerEffectSummary?.trim()) {
    throw new Error('章节结果缺少已经挣得的情绪结果摘要')
  }
  const emotionalEvidence = [
    emotional.triggerEvidence,
    emotional.choiceEvidence,
    emotional.costEvidence,
    emotional.residueEvidence
  ]
  if (emotionalEvidence.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error('章节情绪结果缺少触发、选择、代价或余波的正文证据')
  }
  for (const quote of outcome.evidenceQuotes) assertEvidence(content, quote, '章节结果')
  for (const update of outcome.actorUpdates) assertEvidence(content, update.evidence, `人物「${update.actor}」更新`)
  for (const update of outcome.pressureUpdates) assertEvidence(content, update.evidence, `压力「${update.id}」更新`)
  for (const item of outcome.newPressures) assertEvidence(content, item.evidence, `新增压力「${item.pressure.id}」`)
  assertEvidence(content, emotional.triggerEvidence, '情绪触发')
  assertEvidence(content, emotional.choiceEvidence, '情绪选择')
  assertEvidence(content, emotional.costEvidence, '情绪代价')
  assertEvidence(content, emotional.residueEvidence, '情绪余波')

  const promiseIds = new Set(state.promises.map(item => item.id))
  for (const id of [...outcome.advancedPromiseIds, ...outcome.resolvedPromiseIds]) {
    if (!promiseIds.has(id)) throw new Error(`章节结果引用不存在的读者承诺：${id}`)
  }
  const nextPromises = state.promises.map(item => {
    if (outcome.resolvedPromiseIds.includes(item.id)) {
      return { ...item, status: 'resolved' as const, lastAdvancedChapter: chapterOrdinal }
    }
    if (outcome.advancedPromiseIds.includes(item.id)) {
      return { ...item, status: 'advanced' as const, lastAdvancedChapter: chapterOrdinal }
    }
    return item
  })
  for (const item of outcome.newPromises) {
    if (!item.id.trim() || promiseIds.has(item.id)) throw new Error(`新增读者承诺 ID 非法或重复：${item.id}`)
    promiseIds.add(item.id)
    nextPromises.push({
      id: item.id.trim(), question: item.question.trim(), status: 'open',
      openedChapter: chapterOrdinal, lastAdvancedChapter: chapterOrdinal
    })
  }

  const actors = state.actors.map(actor => {
    const updates = outcome.actorUpdates.filter(update => update.actor === actor.name)
    return updates.reduce<CausalActorState>((current, update) => ({
      ...current,
      currentGoal: update.currentGoal?.trim() || current.currentGoal,
      knowledge: unique([...current.knowledge, ...(update.knowledgeAdded ?? [])]),
      resources: unique([
        ...current.resources.filter(resource => !(update.resourcesRemoved ?? []).includes(resource)),
        ...(update.resourcesAdded ?? [])
      ]),
      constraint: update.constraint?.trim() || current.constraint
    }), actor)
  })

  const knownActorNames = new Set(actors.map(actor => actor.name))
  const unknownActor = outcome.actorUpdates.find(update => !knownActorNames.has(update.actor))
  if (unknownActor) throw new Error(`章节结果更新了不存在的人物：${unknownActor.actor}`)

  const pressureIds = new Set(state.activePressures.map(item => item.id))
  const activePressures = state.activePressures.map(pressure => {
    const update = outcome.pressureUpdates.find(item => item.id === pressure.id)
    if (!update) return pressure
    return {
      ...pressure,
      condition: update.condition?.trim() || pressure.condition,
      urgency: update.urgency == null ? pressure.urgency : clampUrgency(update.urgency),
      status: update.status === 'resolved' ? 'resolved' as const : 'active' as const
    }
  })
  const unknownPressure = outcome.pressureUpdates.find(update => !pressureIds.has(update.id))
  if (unknownPressure) throw new Error(`章节结果更新了不存在的压力：${unknownPressure.id}`)
  for (const item of outcome.newPressures) {
    const pressure = item.pressure
    if (!pressure.id.trim() || pressureIds.has(pressure.id)) throw new Error(`新增压力 ID 非法或重复：${pressure.id}`)
    pressureIds.add(pressure.id)
    activePressures.push({ ...pressure, urgency: clampUrgency(pressure.urgency), status: 'active' })
  }

  return {
    ...state,
    revision: state.revision + 1,
    actors,
    activePressures,
    promises: nextPromises,
    recentEventSignatures: unique([...state.recentEventSignatures, outcome.eventSignature]).slice(-12),
    completed: outcome.terminalConditionMet,
    completionReason: outcome.terminalConditionMet ? outcome.completionReason.trim() : ''
  }
}

export function formatCausalDecisionCard(plan: CausalChapterPlan): string {
  const decision = plan.decision
  return [
    `【开场状态】${decision.openingState}`,
    `【必须覆盖】${decision.mustCover.join('；')}`,
    `【禁止越界】${decision.forbiddenEvents.join('；')}`,
    `【结尾落点】${decision.endingState}`,
    `【连续性约束】${decision.continuityConstraints.join('；')}`,
    `【情节节点】${[
      `${decision.initiator}为了${decision.immediateWant}采取${decision.chosenAction}`,
      `遭遇阻力：${decision.opposition}`,
      `必须付出代价：${decision.cost}`,
      `留下新问题：${decision.newQuestion}`
    ].join('；')}`,
    formatEmotionContractForPrompt(plan.emotionContract),
    `【情绪事务权威依据】${plan.emotionContract.grounding_refs.join('；')}`
  ].join('\n')
}
