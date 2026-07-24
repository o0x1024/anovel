import {
  formatEmotionContractForPrompt,
  validateEmotionContract,
  type EmotionContract
} from './emotion-contract'

export const CAUSAL_NOVEL_SCHEMA_VERSION = 3

export type CausalPromiseStatus = 'open' | 'advanced' | 'resolved'
export type CausalCompletionStatus = 'writing' | 'proposed' | 'completed'
export type CausalChapterFunction =
  | 'advance'
  | 'complicate'
  | 'reveal'
  | 'payoff'
  | 'consolidate'
  | 'aftermath'

export function causalChapterCountBounds(targetChapters: number): { min: number; max: number } {
  if (!Number.isFinite(targetChapters) || targetChapters <= 0) return { min: 0, max: Number.MAX_SAFE_INTEGER }
  return {
    min: Math.max(1, Math.floor(targetChapters * 0.85)),
    max: Math.max(1, Math.ceil(targetChapters * 1.15))
  }
}

export interface CausalMacroArc {
  id: string
  title: string
  objective: string
  entryConditions: string[]
  exitConditions: string[]
  mandatoryPayoffs: string[]
  forbiddenDrift: string[]
  status: 'pending' | 'active' | 'completed'
  lastAdvancedChapter: number
}

export interface CausalActorState {
  name: string
  currentGoal: string
  fear: string
  knowledge: string[]
  resources: string[]
  constraint: string
  location: string
  physicalState: string
  relationships: string[]
  obligations: string[]
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
  macroArcs: CausalMacroArc[]
  macroArchitectureReady: boolean
  lastMacroAuditChapter: number
  archivedPromiseIds: string[]
  recentEventSignatures: string[]
  completionStatus: CausalCompletionStatus
  completionAuditFeedback: string[]
  completed: boolean
  completionReason: string
}

export interface CausalEventCandidate {
  id: string
  chapterFunction: CausalChapterFunction
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
    pacingFitness: number
    total: number
  }
}

export function causalCandidateTotal(candidate: CausalEventCandidate): number {
  const scores = candidate.scores
  if (scores.pacingFitness == null) {
    return Math.round((
      scores.causalNecessity + scores.promiseProgress + scores.irreversibleImpact +
      scores.novelty + scores.pressureEscalation
    ) / 5)
  }
  return Math.round(
    scores.causalNecessity * 0.25 +
    scores.promiseProgress * 0.20 +
    scores.irreversibleImpact * 0.10 +
    scores.novelty * 0.15 +
    scores.pressureEscalation * 0.10 +
    scores.pacingFitness * 0.20
  )
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
  rollingHorizon: CausalHorizonBeat[]
}

export interface CausalHorizonBeat {
  offset: number
  objective: string
  initiator: string
  pressureIds: string[]
  promiseIds: string[]
  expectedIrreversibleChange: string
  replanningTrigger: string
}

export interface CausalGroundedClaim {
  field: 'attachment_anchor' | 'private_detail_anchor'
  ref: string
  evidence: string
}

export interface CausalEvidenceFact {
  id: string
  ref: string
  text: string
}

export interface CausalEvidenceSelection {
  attachmentEvidenceId: string
  privateDetailEvidenceId: string
}

export interface CausalPlanFailureEvent {
  revision: number
  code: string
}

export function registerCausalPlanFailure(
  history: CausalPlanFailureEvent[],
  event: CausalPlanFailureEvent,
  maxPerRevision = 3,
  maxPerFamily = 2
): {
  history: CausalPlanFailureEvent[]
  revisionCount: number
  familyCount: number
  shouldPause: boolean
} {
  const next = [...history, event].slice(-40)
  const revisionCount = next.filter(item => item.revision === event.revision).length
  const familyCount = next.filter(item => item.revision === event.revision && item.code === event.code).length
  return {
    history: next,
    revisionCount,
    familyCount,
    shouldPause: revisionCount >= maxPerRevision || familyCount >= maxPerFamily
  }
}

/**
 * 因果模式不建立全书关系路线。情绪合同只约束当前章，并且所有依据必须引用
 * 当前权威状态或已提交正文，禁止模型凭空补造传统小说设定。
 */
export interface CausalChapterEmotionContract extends EmotionContract {
  grounding_refs: string[]
  grounded_claims: CausalGroundedClaim[]
}

export type CausalChapterEmotionContractDraft = Omit<
  CausalChapterEmotionContract,
  'pov_character' | 'grounding_refs' | 'grounded_claims'
> & {
  groundingEvidence: CausalEvidenceSelection
}

export type CausalEventCandidateProposal = Omit<CausalEventCandidate, 'id' | 'scores'>

export type CausalEventCandidateDraft = Omit<CausalEventCandidate, 'id' | 'scores'> & {
  scores: Omit<CausalEventCandidate['scores'], 'total'>
}

export type CausalChapterDecisionDraft = Omit<
  CausalChapterDecision,
  'initiator' | 'chosenAction' | 'opposition' | 'cost' | 'advancedPromiseIds' | 'newQuestion'
>

export type CausalChapterPlanDraft = Omit<
  CausalChapterPlan,
  'candidates' | 'selectedCandidateId' | 'decision' | 'emotionContract'
> & {
  candidates: CausalEventCandidateDraft[]
  decision: CausalChapterDecisionDraft
  emotionContract: CausalChapterEmotionContractDraft
}

export interface CausalChapterEmotionalOutcome {
  readerEffectSummary: string
  triggerEvidence: string
  choiceEvidence: string
  costEvidence: string
  residueEvidence: string
  emotionalDebtOpened: string
  emotionalDebtPaid: string
  triggerEvidenceIds?: string[]
  choiceEvidenceIds?: string[]
  costEvidenceIds?: string[]
  residueEvidenceIds?: string[]
}

export interface CausalActorUpdate {
  actor: string
  currentGoal?: string
  knowledgeAdded?: string[]
  resourcesAdded?: string[]
  resourcesRemoved?: string[]
  constraint?: string
  location?: string
  physicalState?: string
  relationshipsAdded?: string[]
  relationshipsRemoved?: string[]
  obligationsAdded?: string[]
  obligationsRemoved?: string[]
  evidence: string
  evidenceIds?: string[]
}

export interface CausalPressureUpdate {
  id: string
  status: 'unchanged' | 'stable' | 'escalated' | 'relieved' | 'resolved'
  condition?: string
  urgency?: number
  evidence: string
  evidenceIds?: string[]
}

export interface CausalChapterOutcome {
  summary: string
  eventSignature: string
  evidenceQuotes: string[]
  evidenceRefs?: Array<{ id: string; text: string }>
  advancedPromiseIds: string[]
  resolvedPromiseIds: string[]
  newPromises: Array<{ id: string; question: string }>
  actorUpdates: CausalActorUpdate[]
  newActors: Array<{ actor: CausalActorState; evidence: string; evidenceIds?: string[] }>
  pressureUpdates: CausalPressureUpdate[]
  newPressures: Array<{ pressure: CausalPressure; evidence: string; evidenceIds?: string[] }>
  arcUpdates: Array<{ id: string; status: 'active' | 'completed'; evidence: string; evidenceIds?: string[] }>
  emotionalOutcome: CausalChapterEmotionalOutcome
  terminalConditionMet: boolean
  matchedTerminalCondition: string
  terminalEvidence: string
  terminalEvidenceIds?: string[]
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
  const compact = (value: string): string => value.replace(/\s+/g, '')
  if (!quote || !compact(content).includes(compact(quote))) {
    const preview = quote ? `：“${quote.slice(0, 80)}”` : ''
    throw new Error(`${label}缺少正文逐字证据${preview}`)
  }
}

export function normalizeCausalNarrativeState(input: CausalNarrativeState): CausalNarrativeState {
  const legacy = input as CausalNarrativeState & {
    macroArcs?: CausalMacroArc[]
    macroArchitectureReady?: boolean
    archivedPromiseIds?: string[]
    completionStatus?: CausalCompletionStatus
    completionAuditFeedback?: string[]
    lastMacroAuditChapter?: number
  }
  const fallbackArc: CausalMacroArc = {
    id: 'arc_main',
    title: '核心问题主线',
    objective: legacy.centralQuestion,
    entryConditions: ['故事已经开始'],
    exitConditions: [...legacy.terminalConditions],
    mandatoryPayoffs: legacy.promises.filter(item => item.status !== 'resolved').map(item => item.question),
    forbiddenDrift: [...legacy.immutableRules],
    status: legacy.completed ? 'completed' : 'active',
    lastAdvancedChapter: legacy.revision
  }
  return {
    ...legacy,
    schemaVersion: CAUSAL_NOVEL_SCHEMA_VERSION,
    macroArcs: legacy.macroArcs?.length ? legacy.macroArcs : [fallbackArc],
    macroArchitectureReady: legacy.macroArchitectureReady === true,
    lastMacroAuditChapter: Math.max(0, legacy.lastMacroAuditChapter ?? 0),
    actors: legacy.actors.map(actor => ({
      ...actor,
      location: actor.location ?? '未记录',
      physicalState: actor.physicalState ?? '未记录',
      relationships: unique(actor.relationships ?? []),
      obligations: unique(actor.obligations ?? [])
    })),
    archivedPromiseIds: unique(legacy.archivedPromiseIds ?? []).slice(-1000),
    completionStatus: legacy.completionStatus ?? (legacy.completed ? 'completed' : 'writing'),
    completionAuditFeedback: unique(legacy.completionAuditFeedback ?? []).slice(-12),
    completed: legacy.completed || legacy.completionStatus === 'completed'
  }
}

export function causalEmotionGroundingSources(
  state: CausalNarrativeState,
  recentChapters: Array<{ id: number; content: string }> = []
): Record<string, string> {
  return Object.fromEntries([
    ...state.actors.map(actor => [
      `actor:${actor.name}`,
      [
        actor.currentGoal, actor.fear, actor.constraint, actor.location, actor.physicalState,
        ...actor.knowledge, ...actor.resources, ...(actor.relationships ?? []), ...(actor.obligations ?? [])
      ].join('\n')
    ] as const),
    ...state.activePressures
      .filter(item => item.status === 'active')
      .map(item => [
        `pressure:${item.id}`,
        [item.source, item.target, item.condition, item.escalation].join('\n')
      ] as const),
    ...state.promises
      .filter(item => item.status !== 'resolved')
      .map(item => [`promise:${item.id}`, item.question] as const),
    ...state.immutableRules.map((rule, index) => [`rule:${index + 1}`, rule] as const),
    ...recentChapters.map(chapter => [`recent:${chapter.id}`, chapter.content] as const)
  ])
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

function evidenceText(value: string | null | undefined): string {
  return value?.trim() ?? ''
}

/**
 * 把权威状态拆成模型可选择的原子事实。模型只返回 fact id，服务端负责恢复来源和逐字证据，
 * 避免要求弱模型从整段 JSON 中复制字段、转义符和标点。
 */
export function buildCausalEvidenceCatalog(
  state: CausalNarrativeState,
  recentChapters: Array<{ id: number; content: string }> = []
): CausalEvidenceFact[] {
  const facts: CausalEvidenceFact[] = []
  const seen = new Set<string>()
  const add = (id: string, ref: string, value: string | null | undefined): void => {
    const text = evidenceText(value)
    if (text.replace(/\s/g, '').length < 3) return
    const key = `${ref}\u0000${text}`
    if (seen.has(key)) return
    seen.add(key)
    facts.push({ id, ref, text })
  }

  state.actors.forEach((actor, actorIndex) => {
    const ref = `actor:${actor.name}`
    add(`actor_${actorIndex}_goal`, ref, actor.currentGoal)
    add(`actor_${actorIndex}_fear`, ref, actor.fear)
    add(`actor_${actorIndex}_constraint`, ref, actor.constraint)
    add(`actor_${actorIndex}_location`, ref, actor.location)
    add(`actor_${actorIndex}_physical`, ref, actor.physicalState)
    actor.knowledge.forEach((item, index) => add(`actor_${actorIndex}_knowledge_${index}`, ref, item))
    actor.resources.forEach((item, index) => add(`actor_${actorIndex}_resource_${index}`, ref, item))
    ;(actor.relationships ?? []).forEach((item, index) => add(`actor_${actorIndex}_relationship_${index}`, ref, item))
    ;(actor.obligations ?? []).forEach((item, index) => add(`actor_${actorIndex}_obligation_${index}`, ref, item))
  })
  state.activePressures.filter(item => item.status === 'active').forEach((pressure, index) => {
    const ref = `pressure:${pressure.id}`
    add(`pressure_${index}_condition`, ref, pressure.condition)
    add(`pressure_${index}_escalation`, ref, pressure.escalation)
    add(`pressure_${index}_source`, ref, pressure.source)
    add(`pressure_${index}_target`, ref, pressure.target)
  })
  state.promises.filter(item => item.status !== 'resolved').forEach((promise, index) => {
    add(`promise_${index}_question`, `promise:${promise.id}`, promise.question)
  })
  state.immutableRules.forEach((rule, index) => add(`rule_${index}`, `rule:${index + 1}`, rule))
  recentChapters.forEach(chapter => {
    const fragments = chapter.content
      .slice(-1800)
      .split(/(?<=[。！？!?])|\n+/)
      .map(item => item.trim())
      .filter(item => item.replace(/\s/g, '').length >= 6)
      .slice(-12)
    fragments.forEach((fragment, index) => add(`recent_${chapter.id}_${index}`, `recent:${chapter.id}`, fragment))
  })
  return facts.slice(0, 160)
}

function includeEvidence(field: string, evidence: string): string {
  const current = field.trim()
  if (!current) return evidence
  return current.includes(evidence) ? current : `${evidence}；${current}`
}

/** 服务端固化所有跨字段等值关系和可计算字段，模型不再负责重复抄写。 */
export function materializeCausalCandidates(
  drafts: Array<CausalEventCandidateDraft | CausalEventCandidateProposal>,
  independentScores?: Array<Omit<CausalEventCandidate['scores'], 'total'>>
): CausalEventCandidate[] {
  return drafts.map((candidate, index) => {
    const score = independentScores?.[index] ?? ('scores' in candidate ? candidate.scores : null)
    if (!score) throw new Error(`候选 candidate_${index + 1} 缺少独立评分`)
    const { scores: _ignored, ...proposal } = candidate as CausalEventCandidateDraft
    const withTotal: CausalEventCandidate = {
      ...proposal,
      id: `candidate_${index + 1}`,
      scores: { ...score, total: 0 }
    }
    withTotal.scores.total = causalCandidateTotal(withTotal)
    return withTotal
  })
}

export function materializeCausalChapterPlan(
  state: CausalNarrativeState,
  draft: CausalChapterPlanDraft,
  catalog: CausalEvidenceFact[]
): CausalChapterPlan {
  if (draft.candidates.length === 0) throw new Error('因果候选为空')
  const candidates = materializeCausalCandidates(draft.candidates)
  const bestScore = Math.max(...candidates.map(candidate => candidate.scores.total))
  const selected = candidates.find(candidate => candidate.scores.total === bestScore)
  if (!selected) throw new Error('无法确定最高分因果候选')
  const actorNames = new Set(state.actors.map(actor => actor.name))
  if (!actorNames.has(selected.initiator)) throw new Error(`候选发起人不在当前人物状态中：${selected.initiator}`)
  if (!actorNames.has(draft.decision.pov)) throw new Error(`章节视角人物不在当前人物状态中：${draft.decision.pov}`)

  const evidenceById = new Map(catalog.map(item => [item.id, item]))
  const attachment = evidenceById.get(draft.emotionContract.groundingEvidence.attachmentEvidenceId)
  const privateDetail = evidenceById.get(draft.emotionContract.groundingEvidence.privateDetailEvidenceId)
  if (!attachment) throw new Error('依恋锚点引用了不存在的原子证据')
  if (!privateDetail) throw new Error('私人细节引用了不存在的原子证据')

  const promiseIds = new Set(state.promises.filter(item => item.status !== 'resolved').map(item => item.id))
  const selectedPromiseId = promiseIds.has(selected.promiseAdvanced) ? selected.promiseAdvanced : undefined
  if (!selectedPromiseId) throw new Error('最高分候选没有引用有效的未关闭读者承诺')
  const nonActorRef = [attachment.ref, privateDetail.ref, `promise:${selectedPromiseId}`]
    .find(ref => /^(pressure|promise|rule|recent):/.test(ref))
  const groundingRefs = [...new Set([
    `actor:${draft.decision.pov}`,
    attachment.ref,
    privateDetail.ref,
    nonActorRef ?? `promise:${selectedPromiseId}`
  ])]

  const decision: CausalChapterDecision = {
    ...draft.decision,
    initiator: selected.initiator,
    chosenAction: selected.action,
    opposition: selected.opposition,
    cost: selected.cost,
    advancedPromiseIds: [selectedPromiseId],
    newQuestion: selected.newQuestion
  }
  const rollingHorizon = draft.rollingHorizon.map((beat, index) => ({
    ...beat,
    offset: index,
    initiator: index === 0 ? decision.initiator : beat.initiator,
    pressureIds: unique(beat.pressureIds),
    promiseIds: unique(beat.promiseIds)
  }))
  const { groundingEvidence: _groundingEvidence, ...emotionDraft } = draft.emotionContract
  const emotionContract: CausalChapterEmotionContract = {
    ...emotionDraft,
    pov_character: decision.pov,
    attachment_anchor: includeEvidence(emotionDraft.attachment_anchor, attachment.text),
    private_detail_anchor: privateDetail.text,
    grounding_refs: groundingRefs,
    grounded_claims: [
      { field: 'attachment_anchor', ref: attachment.ref, evidence: attachment.text },
      { field: 'private_detail_anchor', ref: privateDetail.ref, evidence: privateDetail.text }
    ]
  }
  return {
    ...draft,
    candidates,
    selectedCandidateId: selected.id,
    decision,
    emotionContract,
    rollingHorizon
  }
}

export function validateCausalChapterEmotionContract(
  state: CausalNarrativeState,
  plan: CausalChapterPlan,
  recentChapters: Array<number | { id: number; content: string }> = []
): void {
  const contract = plan.emotionContract
  const errors = validateEmotionContract(contract)
  if (errors.length > 0) throw new Error(`因果章节情绪事务无效：${errors.join('；')}`)
  if (contract.pov_character !== plan.decision.pov) {
    throw new Error('因果章节情绪事务的视角人物与章节决策不一致')
  }
  const recentChapterIds = recentChapters.map(item => typeof item === 'number' ? item : item.id)
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
  const sources = causalEmotionGroundingSources(
    state,
    recentChapters.filter((item): item is { id: number; content: string } => typeof item !== 'number')
  )
  const claims = contract.grounded_claims ?? []
  for (const field of ['attachment_anchor', 'private_detail_anchor'] as const) {
    const claim = claims.find(item => item.field === field)
    if (!claim) throw new Error(`因果章节情绪事务缺少 ${field} 的逐字依据`)
    if (!refs.includes(claim.ref) || !allowed.has(claim.ref)) {
      throw new Error(`因果章节情绪事务的 ${field} 引用了非权威依据：${claim.ref}`)
    }
    const evidence = claim.evidence.trim()
    if (evidence.length < 3 || !sources[claim.ref]?.includes(evidence)) {
      throw new Error(`因果章节情绪事务的 ${field} 缺少权威来源逐字证据`)
    }
    if (!contract[field].includes(evidence)) {
      throw new Error(`因果章节情绪事务的 ${field} 没有包含所声明的逐字证据`)
    }
    if (field === 'private_detail_anchor') {
      const evidenceLength = evidence.replace(/\s/g, '').length
      const fieldLength = contract[field].replace(/\s/g, '').length
      if (fieldLength > 0 && evidenceLength / fieldLength < 0.45) {
        throw new Error('因果章节情绪事务的 private_detail_anchor 包含过多无权威依据的补写')
      }
    }
  }
}

export function applyCausalChapterOutcome(
  state: CausalNarrativeState,
  outcome: CausalChapterOutcome,
  chapterOrdinal: number,
  content: string
): CausalNarrativeState {
  const evidenceRefMap = new Map((outcome.evidenceRefs ?? []).map(item => [item.id, item.text]))
  for (const ref of outcome.evidenceRefs ?? []) assertEvidence(content, ref.text, `证据单元「${ref.id}」`)
  const assertBoundEvidence = (evidence: string, evidenceIds: string[] | undefined, label: string): void => {
    if (evidenceIds?.length) {
      const missing = evidenceIds.filter(id => !evidenceRefMap.has(id))
      if (missing.length) throw new Error(`${label}引用不存在的证据单元：${missing.join('、')}`)
      return
    }
    assertEvidence(content, evidence, label)
  }
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
  for (const update of outcome.actorUpdates) {
    assertBoundEvidence(update.evidence, update.evidenceIds, `人物「${update.actor}」更新`)
    if (!update.evidenceIds?.length) {
      for (const fact of [
        update.currentGoal,
        update.constraint,
        ...(update.knowledgeAdded ?? []),
        ...(update.resourcesAdded ?? []),
        ...(update.resourcesRemoved ?? [])
      ]) {
        if (fact?.trim()) assertEvidence(content, fact, `人物「${update.actor}」状态字段`)
      }
    }
  }
  for (const item of outcome.newActors ?? []) {
    assertBoundEvidence(item.evidence, item.evidenceIds, `新增人物「${item.actor.name}」`)
    if (!item.evidenceIds?.length) {
      for (const fact of [
        item.actor.name,
        item.actor.currentGoal,
        item.actor.fear,
        item.actor.constraint,
        ...item.actor.knowledge,
        ...item.actor.resources
      ]) {
        if (fact.trim()) assertEvidence(content, fact, `新增人物「${item.actor.name}」状态字段`)
      }
    }
  }
  for (const update of outcome.pressureUpdates) assertBoundEvidence(update.evidence, update.evidenceIds, `压力「${update.id}」更新`)
  for (const item of outcome.newPressures) assertBoundEvidence(item.evidence, item.evidenceIds, `新增压力「${item.pressure.id}」`)
  for (const update of outcome.arcUpdates ?? []) assertBoundEvidence(update.evidence, update.evidenceIds, `阶段「${update.id}」更新`)
  assertBoundEvidence(emotional.triggerEvidence, emotional.triggerEvidenceIds, '情绪触发')
  assertBoundEvidence(emotional.choiceEvidence, emotional.choiceEvidenceIds, '情绪选择')
  assertBoundEvidence(emotional.costEvidence, emotional.costEvidenceIds, '情绪代价')
  assertBoundEvidence(emotional.residueEvidence, emotional.residueEvidenceIds, '情绪余波')

  const activePromiseIds = new Set(state.promises.map(item => item.id))
  const knownPromiseIds = new Set([...activePromiseIds, ...state.archivedPromiseIds])
  for (const id of [...outcome.advancedPromiseIds, ...outcome.resolvedPromiseIds]) {
    if (!activePromiseIds.has(id)) throw new Error(`章节结果引用不存在或已归档的读者承诺：${id}`)
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
    if (!item.id.trim() || knownPromiseIds.has(item.id)) throw new Error(`新增读者承诺 ID 非法或重复：${item.id}`)
    knownPromiseIds.add(item.id)
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
      constraint: update.constraint?.trim() || current.constraint,
      location: update.location?.trim() || current.location || '未记录',
      physicalState: update.physicalState?.trim() || current.physicalState || '未记录',
      relationships: unique([
        ...(current.relationships ?? []).filter(item => !(update.relationshipsRemoved ?? []).includes(item)),
        ...(update.relationshipsAdded ?? [])
      ]),
      obligations: unique([
        ...(current.obligations ?? []).filter(item => !(update.obligationsRemoved ?? []).includes(item)),
        ...(update.obligationsAdded ?? [])
      ])
    }), actor)
  })

  const knownActorNames = new Set(actors.map(actor => actor.name))
  const unknownActor = outcome.actorUpdates.find(update => !knownActorNames.has(update.actor))
  if (unknownActor) throw new Error(`章节结果更新了不存在的人物：${unknownActor.actor}`)
  for (const item of outcome.newActors ?? []) {
    const actor = item.actor
    if (!actor.name.trim() || knownActorNames.has(actor.name)) {
      throw new Error(`新增人物名称为空或重复：${actor.name}`)
    }
    knownActorNames.add(actor.name)
    actors.push({
      ...actor,
      name: actor.name.trim(),
      knowledge: unique(actor.knowledge),
      resources: unique(actor.resources),
      location: actor.location || '未记录',
      physicalState: actor.physicalState || '未记录',
      relationships: unique(actor.relationships ?? []),
      obligations: unique(actor.obligations ?? [])
    })
  }

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

  const arcIds = new Set(state.macroArcs.map(item => item.id))
  const unknownArc = (outcome.arcUpdates ?? []).find(update => !arcIds.has(update.id))
  if (unknownArc) throw new Error(`章节结果更新了不存在的阶段：${unknownArc.id}`)
  let macroArcs = state.macroArcs.map(arc => {
    const update = (outcome.arcUpdates ?? []).find(item => item.id === arc.id)
    return update
      ? { ...arc, status: update.status, lastAdvancedChapter: chapterOrdinal }
      : arc
  })
  if (!macroArcs.some(item => item.status === 'active')) {
    const nextPendingIndex = macroArcs.findIndex(item => item.status === 'pending')
    if (nextPendingIndex >= 0) {
      macroArcs = macroArcs.map((item, index) => index === nextPendingIndex
        ? { ...item, status: 'active' as const, lastAdvancedChapter: chapterOrdinal }
        : item)
    }
  }
  if (macroArcs.filter(item => item.status === 'active').length > 1) {
    throw new Error('章节结果导致多个阶段同时处于 active')
  }

  if (outcome.terminalConditionMet) {
    if (!state.terminalConditions.includes(outcome.matchedTerminalCondition?.trim())) {
      throw new Error('章节结果声明完结，但没有命中权威终止条件')
    }
    assertBoundEvidence(outcome.terminalEvidence, outcome.terminalEvidenceIds, '终止条件')
    if (!outcome.completionReason?.trim()) throw new Error('章节结果声明完结，但缺少完结原因')
  }

  const archivedPromiseIds = unique([
    ...state.archivedPromiseIds,
    ...nextPromises
      .filter(item => item.status === 'resolved' && chapterOrdinal - item.lastAdvancedChapter > 24)
      .map(item => item.id)
  ]).slice(-1000)
  const retainedPromises = nextPromises.filter(item =>
    item.status !== 'resolved' || chapterOrdinal - item.lastAdvancedChapter <= 24
  )

  return {
    ...state,
    revision: state.revision + 1,
    actors,
    activePressures: activePressures.filter(item => item.status === 'active'),
    promises: retainedPromises,
    macroArcs,
    archivedPromiseIds,
    recentEventSignatures: unique([...state.recentEventSignatures, outcome.eventSignature]).slice(-12),
    completionStatus: outcome.terminalConditionMet ? 'proposed' : 'writing',
    completionAuditFeedback: outcome.terminalConditionMet ? [] : state.completionAuditFeedback,
    completed: false,
    completionReason: outcome.terminalConditionMet ? outcome.completionReason.trim() : ''
  }
}

export function formatCausalDecisionCard(plan: CausalChapterPlan): string {
  const decision = plan.decision
  const selected = plan.candidates.find(item => item.id === plan.selectedCandidateId)
  return [
    `【章节功能】${selected?.chapterFunction ?? 'advance'}`,
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
    `【情绪事务权威依据】${plan.emotionContract.grounding_refs.join('；')}`,
    `【情绪锚点逐字证据】${plan.emotionContract.grounded_claims.map(item => `${item.field}:${item.ref}="${item.evidence}"`).join('；')}`,
    `【近期滚动窗口】${plan.rollingHorizon.map(item => `+${item.offset} ${item.objective}`).join('；')}`
  ].join('\n')
}
