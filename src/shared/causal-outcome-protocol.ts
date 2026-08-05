import { createHash } from 'node:crypto'
import type {
  CausalChapterOutcome,
  CausalNarrativeState,
  CausalOutcomeMutation
} from './causal-novel-types'

export const CAUSAL_OUTCOME_PROTOCOL_VERSION = 29
export const CAUSAL_OUTCOME_AUDIT_BATCH_SIZE = 6
export const CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX = 4

export interface CausalBodyEvidenceUnit {
  id: string
  paragraph: number
  start: number
  end: number
  text: string
}

export interface CausalOutcomeEvidenceClaimDraft {
  claim: string
  evidenceIds: string[]
}

export interface CausalOutcomeCoreDraft {
  primaryEvent: CausalOutcomeEvidenceClaimDraft & {
    eventSignature: string
  }
  supportingEvents: CausalOutcomeEvidenceClaimDraft[]
  advancedPromises: Array<CausalOutcomeEvidenceClaimDraft & {
    promiseId: string
  }>
  resolvedPromises: Array<CausalOutcomeEvidenceClaimDraft & {
    promiseId: string
  }>
  newPromises: Array<CausalOutcomeEvidenceClaimDraft & {
    question: string
  }>
  terminal: {
    conditionMet: boolean
    matchedCondition: string
    completionReason: string
    evidenceIds: string[]
  }
}

export interface CausalOutcomeActorDraft {
  actorMutations: Array<{
    actor: string
    field:
      | 'currentGoal'
      | 'knowledge'
      | 'resources'
      | 'constraint'
      | 'location'
      | 'physicalState'
      | 'relationships'
      | 'obligations'
    operation: 'set' | 'add' | 'remove'
    value: string
    evidenceIds: string[]
  }>
  newActors: Array<{
    key: string
    facts: Array<{
      field:
        | 'name'
        | 'currentGoal'
        | 'fear'
        | 'knowledge'
        | 'resources'
        | 'constraint'
        | 'location'
        | 'physicalState'
        | 'relationships'
        | 'obligations'
      value: string
      evidenceIds: string[]
    }>
  }>
}

export interface CausalOutcomeWorldDraft {
  pressureConditionUpdates: Array<{
    id: string
    value: string
    evidenceIds: string[]
  }>
  pressureStatusUpdates: Array<{
    id: string
    value: 'stable' | 'escalated' | 'relieved' | 'resolved'
    evidenceIds: string[]
  }>
  pressureUrgencyUpdates: Array<{
    id: string
    value: number
    evidenceIds: string[]
  }>
  newPressures: Array<{
    key: string
    source: CausalOutcomeEvidenceClaimDraft
    target: CausalOutcomeEvidenceClaimDraft
    condition: CausalOutcomeEvidenceClaimDraft
    escalation: CausalOutcomeEvidenceClaimDraft
    urgency: {
      value: number
      claim: string
      evidenceIds: string[]
    }
  }>
  arcUpdates: Array<{
    id: string
    status: 'active' | 'completed'
    claim: string
    evidenceIds: string[]
  }>
}

export interface CausalOutcomeEmotionDraft {
  readerEffect: CausalOutcomeEvidenceClaimDraft
  trigger: CausalOutcomeEvidenceClaimDraft
  choice: CausalOutcomeEvidenceClaimDraft
  cost: CausalOutcomeEvidenceClaimDraft
  residue: CausalOutcomeEvidenceClaimDraft
  debtOpened: CausalOutcomeEvidenceClaimDraft
  debtPaid: CausalOutcomeEvidenceClaimDraft
}

export interface CausalOutcomeDraftBundle {
  core: CausalOutcomeCoreDraft
  actors: CausalOutcomeActorDraft
  world: CausalOutcomeWorldDraft
  emotion: CausalOutcomeEmotionDraft
}

export type CausalOutcomeFailureCode =
  | 'OUTCOME_TRANSPORT'
  | 'OUTCOME_TRUNCATED'
  | 'OUTCOME_SCHEMA'
  | 'OUTCOME_EVIDENCE_ID'
  | 'OUTCOME_ATOMIZATION_REQUIRED'
  | 'OUTCOME_REFERENCE'
  | 'OUTCOME_OPERATION'
  | 'OUTCOME_PROMISE_PROGRESS'
  | 'OUTCOME_EMOTION'
  | 'OUTCOME_ENTAILMENT'
  | 'OUTCOME_BODY_CONTRACT'
  | 'OUTCOME_BUDGET'
  | 'OUTCOME_STALE_BODY'
  | 'OUTCOME_UNKNOWN'

export function causalOutcomeAuditBatches<T>(
  items: readonly T[],
  batchSize = CAUSAL_OUTCOME_AUDIT_BATCH_SIZE
): T[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('章后结果审计批大小必须是正整数')
  }
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += batchSize) {
    batches.push(items.slice(index, index + batchSize))
  }
  return batches
}

export class CausalOutcomeProtocolError extends Error {
  constructor(
    public readonly code: CausalOutcomeFailureCode,
    message: string,
    public readonly paths: string[] = [],
    public readonly issues: CausalOutcomeProtocolIssue[] = []
  ) {
    super(message)
    this.name = 'CausalOutcomeProtocolError'
  }
}

export interface CausalOutcomeProtocolIssue {
  path: string
  actualCount?: number
  min?: number
  max?: number
  invalidIds?: string[]
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
  const normalized = [...new Set((ids ?? []).map(id => String(id).trim()).filter(Boolean))]
  const min = options.min ?? 1
  const max = options.max ?? 8
  if (normalized.length < min || normalized.length > max) {
    const requiresAtomization = normalized.length > max
    throw new CausalOutcomeProtocolError(
      requiresAtomization ? 'OUTCOME_ATOMIZATION_REQUIRED' : 'OUTCOME_EVIDENCE_ID',
      requiresAtomization
        ? `${path} 实际包含 ${normalized.length} 个正文证据 ID，单条原子结论上限为 ${max}；需要拆分结论`
        : `${path} 需要 ${min}-${max} 个正文证据 ID，实际为 ${normalized.length} 个`,
      [path],
      [{ path, actualCount: normalized.length, min, max }]
    )
  }
  const invalid = normalized.filter(id => !allowed.has(id))
  if (invalid.length) {
    throw new CausalOutcomeProtocolError(
      'OUTCOME_EVIDENCE_ID',
      `${path} 引用了不存在的正文证据 ID：${invalid.join('、')}`,
      [path],
      [{ path, invalidIds: invalid }]
    )
  }
  return normalized
}

export function causalStageEvidencePaths(
  value: unknown,
  base = ''
): Array<{ path: string; ids: string[] }> {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => causalStageEvidencePaths(item, `${base}[${index}]`))
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = base ? `${base}.${key}` : key
    if (/EvidenceIds$|^evidenceIds$/.test(key) && Array.isArray(child)) {
      return [{ path, ids: child.map(String) }]
    }
    return causalStageEvidencePaths(child, path)
  })
}

function causalProtocolPathValue(root: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let current = root as any
  for (const part of parts) current = current?.[part]
  return current
}

export function validateCausalStageEvidence(
  stage: unknown,
  units: CausalBodyEvidenceUnit[]
): void {
  const failures: Array<{
    path: string
    reason: string
    code: CausalOutcomeFailureCode
    issues: CausalOutcomeProtocolIssue[]
  }> = []
  for (const item of causalStageEvidencePaths(stage)) {
    const claimPath = item.path.replace(/\.evidenceIds$/, '.claim')
    const associatedClaim = causalProtocolPathValue(stage, claimPath)
    const allowsEmptyEvidence = (
      item.path.endsWith('terminal.evidenceIds') &&
      !(stage as CausalOutcomeCoreDraft).terminal?.conditionMet
    ) || (
      typeof associatedClaim === 'string' &&
      !associatedClaim.trim() &&
      /(?:debtOpened|debtPaid)\.evidenceIds$/.test(item.path)
    )
    const min = allowsEmptyEvidence ? 0 : 1
    const max = CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX
    try {
      validateCausalEvidenceIds(units, item.ids, item.path, { min, max })
    } catch (error) {
      failures.push({
        path: item.path,
        reason: error instanceof Error ? error.message : String(error),
        code: error instanceof CausalOutcomeProtocolError ? error.code : 'OUTCOME_EVIDENCE_ID',
        issues: error instanceof CausalOutcomeProtocolError ? error.issues : []
      })
    }
  }
  if (failures.length) {
    const code = failures.some(item => item.code === 'OUTCOME_ATOMIZATION_REQUIRED')
      ? 'OUTCOME_ATOMIZATION_REQUIRED'
      : 'OUTCOME_EVIDENCE_ID'
    throw new CausalOutcomeProtocolError(
      code,
      failures.map(item => item.reason).join('；'),
      [...new Set(failures.map(item => item.path))],
      failures.flatMap(item => item.issues)
    )
  }
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

const PHYSICAL_CONDITION_PATTERN =
  /受伤|负伤|伤势|伤口|创伤|失血|流血|出血|感染|中毒|骨折|残疾|疼痛|昏迷|僵硬|咳血|吐血|症状|疲劳|虚弱|发烧|高烧|脱臼|扭伤|烧伤|烫伤|冻伤/
const PHYSICAL_CONDITION_RESOURCE_HEAD_PATTERN =
  /(?:徽章|钥匙|药|药剂|血清|样本|报告|记录|档案|文件|衣物|绷带|夹板|武器|工具|设备|仪器|容器|瓶|盒|包|信物|证件|照片|录音|录像|芯片|零件|材料|账本|地图|名单|票据|笔记|令牌|通行证)$/

export function isCausalPhysicalConditionValue(value: string): boolean {
  const normalized = value.trim()
  return PHYSICAL_CONDITION_PATTERN.test(normalized)
    && !PHYSICAL_CONDITION_RESOURCE_HEAD_PATTERN.test(normalized)
}

export function materializeCausalOutcomeDraft(input: {
  state: CausalNarrativeState
  units: CausalBodyEvidenceUnit[]
  draft: CausalOutcomeDraftBundle
  mutations: CausalOutcomeMutation[]
}): CausalChapterOutcome {
  const { state, units, draft, mutations } = input
  if (!mutations.length) {
    throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', '章后结果缺少 v6 原子状态变更制品')
  }
  const unitMap = new Map(units.map(unit => [unit.id, unit]))
  const usedEvidenceIds = new Set<string>()
  const useEvidence = (ids: string[], path: string, min = 1): string[] => {
    const valid = validateCausalEvidenceIds(units, ids, path, {
      min,
      max: Math.max(min, units.length)
    })
    valid.forEach(id => usedEvidenceIds.add(id))
    return valid
  }

  const activePromises = new Set(state.promises.filter(item => item.status !== 'resolved').map(item => item.id))
  const advancedPromiseIds = draft.core.advancedPromises.map(item => item.promiseId)
  const resolvedPromiseIds = draft.core.resolvedPromises.map(item => item.promiseId)
  for (const id of [...advancedPromiseIds, ...resolvedPromiseIds]) {
    if (!activePromises.has(id)) {
      throw new CausalOutcomeProtocolError('OUTCOME_REFERENCE', `章后结果引用了不存在或已关闭的读者承诺：${id}`, ['core.advancedPromises'])
    }
  }
  const progressed = new Set([...advancedPromiseIds, ...resolvedPromiseIds])
  if (!progressed.size) {
    throw new CausalOutcomeProtocolError('OUTCOME_PROMISE_PROGRESS', '章后结果没有推进任何读者承诺', ['core.advancedPromises'])
  }
  const coreEvidenceIds = [
    ...useEvidence(draft.core.primaryEvent.evidenceIds, 'core.primaryEvent.evidenceIds'),
    ...draft.core.supportingEvents.flatMap((event, index) => useEvidence(
      event.evidenceIds,
      `core.supportingEvents[${index}].evidenceIds`
    ))
  ]
  const actorNames = new Set(state.actors.map(actor => actor.name))
  type ActorUpdateAccumulator = CausalChapterOutcome['actorUpdates'][number] & {
    evidenceIds: string[]
  }
  const actorUpdateMap = new Map<string, ActorUpdateAccumulator>()
  const actorMutationKeys = new Set<string>()
  const addUnique = (items: string[] | undefined, value: string): string[] => (
    [...new Set([...(items ?? []), value])]
  )
  draft.actors.actorMutations.forEach((mutation, index) => {
    const path = `actors.actorMutations[${index}]`
    if (!actorNames.has(mutation.actor)) {
      throw new CausalOutcomeProtocolError(
        'OUTCOME_REFERENCE',
        `${path} 引用了不存在的人物：${mutation.actor}`,
        [`${path}.actor`]
      )
    }
    const value = assertNonEmpty(mutation.value, `${path}.value`)
    const scalarField = ['currentGoal', 'constraint', 'location', 'physicalState'].includes(mutation.field)
    const mutationKey = scalarField
      ? `${mutation.actor}\u0000${mutation.field}`
      : `${mutation.actor}\u0000${mutation.field}\u0000${mutation.operation}\u0000${value}`
    if (actorMutationKeys.has(mutationKey)) {
      throw new CausalOutcomeProtocolError(
        'OUTCOME_OPERATION',
        `${path} 与同阶段的另一条人物操作重复`,
        [path]
      )
    }
    actorMutationKeys.add(mutationKey)
    const evidenceIds = useEvidence(mutation.evidenceIds, `${path}.evidenceIds`)
    const allowedOperation = scalarField
      ? mutation.operation === 'set'
      : mutation.field === 'knowledge'
        ? mutation.operation === 'add'
        : mutation.operation === 'add' || mutation.operation === 'remove'
    if (!allowedOperation) {
      throw new CausalOutcomeProtocolError(
        'OUTCOME_OPERATION',
        `${path} 的 ${mutation.field} 不支持 ${mutation.operation} 操作`,
        [`${path}.operation`]
      )
    }
    if (mutation.field === 'resources' && isCausalPhysicalConditionValue(value)) {
      throw new CausalOutcomeProtocolError(
        'OUTCOME_OPERATION',
        `${path} 把伤势/身体状态误当作资源：${value}`,
        [`${path}.value`]
      )
    }
    const update = actorUpdateMap.get(mutation.actor) ?? {
      actor: mutation.actor,
      evidence: '',
      evidenceIds: []
    }
    for (const id of evidenceIds) update.evidenceIds = addUnique(update.evidenceIds, id)
    if (mutation.field === 'currentGoal') update.currentGoal = value
    if (mutation.field === 'constraint') update.constraint = value
    if (mutation.field === 'location') update.location = value
    if (mutation.field === 'physicalState') update.physicalState = value
    if (mutation.field === 'knowledge') update.knowledgeAdded = addUnique(update.knowledgeAdded, value)
    if (mutation.field === 'resources') {
      if (mutation.operation === 'add') update.resourcesAdded = addUnique(update.resourcesAdded, value)
      else update.resourcesRemoved = addUnique(update.resourcesRemoved, value)
    }
    if (mutation.field === 'relationships') {
      if (mutation.operation === 'add') update.relationshipsAdded = addUnique(update.relationshipsAdded, value)
      else update.relationshipsRemoved = addUnique(update.relationshipsRemoved, value)
    }
    if (mutation.field === 'obligations') {
      if (mutation.operation === 'add') update.obligationsAdded = addUnique(update.obligationsAdded, value)
      else update.obligationsRemoved = addUnique(update.obligationsRemoved, value)
    }
    actorUpdateMap.set(mutation.actor, update)
  })
  const actorUpdates = [...actorUpdateMap.values()].map(update => ({
    ...update,
    evidence: evidenceText(update.evidenceIds, unitMap)
  }))

  const newActors = draft.actors.newActors.map((item, index) => {
    const path = `actors.newActors[${index}]`
    if (!item.key.trim() || !item.facts.length) {
      throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', `${path} 缺少 key 或原子人物事实`, [path])
    }
    const factMap = new Map<string, string[]>()
    const evidenceIds: string[] = []
    item.facts.forEach((fact, factIndex) => {
      const factPath = `${path}.facts[${factIndex}]`
      const value = assertNonEmpty(fact.value, `${factPath}.value`)
      if (
        ['name', 'currentGoal', 'fear', 'constraint', 'location', 'physicalState'].includes(fact.field) &&
        factMap.has(fact.field)
      ) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_OPERATION',
          `${factPath} 重复定义新增人物的标量字段 ${fact.field}`,
          [factPath]
        )
      }
      const ids = useEvidence(fact.evidenceIds, `${factPath}.evidenceIds`)
      ids.forEach(id => {
        if (!evidenceIds.includes(id)) evidenceIds.push(id)
      })
      factMap.set(fact.field, addUnique(factMap.get(fact.field), value))
    })
    const names = factMap.get('name') ?? []
    if (names.length !== 1) {
      throw new CausalOutcomeProtocolError(
        'OUTCOME_SCHEMA',
        `${path} 必须且只能包含一个 name 原子事实`,
        [`${path}.facts`]
      )
    }
    const name = names[0]
    if (actorNames.has(name)) {
      throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `新增人物重复：${name}`, [`${path}.facts`])
    }
    actorNames.add(name)
    const scalar = (field: string, fallback = ''): string => factMap.get(field)?.[0] ?? fallback
    return {
      actor: {
        name,
        currentGoal: scalar('currentGoal'),
        fear: scalar('fear'),
        knowledge: factMap.get('knowledge') ?? [],
        resources: factMap.get('resources') ?? [],
        constraint: scalar('constraint'),
        location: scalar('location', '未记录'),
        physicalState: scalar('physicalState', '未记录'),
        relationships: factMap.get('relationships') ?? [],
        obligations: factMap.get('obligations') ?? []
      },
      evidence: evidenceText(evidenceIds, unitMap),
      evidenceIds
    }
  })

  const pressureMap = new Map(state.activePressures.map(item => [item.id, item]))
  type PressureUpdateAccumulator = CausalChapterOutcome['pressureUpdates'][number] & {
    evidenceIds: string[]
  }
  const pressureUpdateMap = new Map<string, PressureUpdateAccumulator>()
  const pressureAccumulator = (id: string, path: string): PressureUpdateAccumulator => {
    if (!pressureMap.has(id)) {
      throw new CausalOutcomeProtocolError(
        'OUTCOME_REFERENCE',
        `${path} 引用了不存在的压力：${id}`,
        [`${path}.id`]
      )
    }
    const current = pressureUpdateMap.get(id) ?? {
      id,
      status: 'unchanged',
      evidence: '',
      evidenceIds: []
    }
    pressureUpdateMap.set(id, current)
    return current
  }
  draft.world.pressureConditionUpdates.forEach((item, index) => {
    const path = `world.pressureConditionUpdates[${index}]`
    const update = pressureAccumulator(item.id, path)
    update.condition = assertNonEmpty(item.value, `${path}.value`)
    for (const id of useEvidence(item.evidenceIds, `${path}.evidenceIds`)) {
      update.evidenceIds = addUnique(update.evidenceIds, id)
    }
  })
  draft.world.pressureStatusUpdates.forEach((item, index) => {
    const path = `world.pressureStatusUpdates[${index}]`
    const update = pressureAccumulator(item.id, path)
    update.status = item.value
    for (const id of useEvidence(item.evidenceIds, `${path}.evidenceIds`)) {
      update.evidenceIds = addUnique(update.evidenceIds, id)
    }
  })
  draft.world.pressureUrgencyUpdates.forEach((item, index) => {
    const path = `world.pressureUrgencyUpdates[${index}]`
    const update = pressureAccumulator(item.id, path)
    update.urgency = item.value
    for (const id of useEvidence(item.evidenceIds, `${path}.evidenceIds`)) {
      update.evidenceIds = addUnique(update.evidenceIds, id)
    }
  })
  const pressureUpdates = [...pressureUpdateMap.values()].map(update => {
    const previous = pressureMap.get(update.id)!
    const nextUrgency = update.urgency ?? previous.urgency
    if (update.status === 'escalated' && nextUrgency < previous.urgency) {
      throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `压力 ${update.id} 声明升级但紧迫度下降`)
    }
    if (update.status === 'relieved' && nextUrgency > previous.urgency) {
      throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `压力 ${update.id} 声明缓解但紧迫度上升`)
    }
    return {
      ...update,
      evidence: evidenceText(update.evidenceIds, unitMap)
    }
  })
  const assignedPressureIds = new Set(pressureMap.keys())
  const newPressures = draft.world.newPressures.map((item, index) => {
    const path = `world.newPressures[${index}]`
    const id = nextServerId('ap', assignedPressureIds)
    assignedPressureIds.add(id)
    const sourceEvidenceIds = useEvidence(item.source.evidenceIds, `${path}.source.evidenceIds`)
    const targetEvidenceIds = useEvidence(item.target.evidenceIds, `${path}.target.evidenceIds`)
    const conditionEvidenceIds = useEvidence(item.condition.evidenceIds, `${path}.condition.evidenceIds`)
    const escalationEvidenceIds = useEvidence(item.escalation.evidenceIds, `${path}.escalation.evidenceIds`)
    const urgencyEvidenceIds = useEvidence(item.urgency.evidenceIds, `${path}.urgency.evidenceIds`)
    assertNonEmpty(item.urgency.claim, `${path}.urgency.claim`)
    const evidenceIds = [...new Set([
      ...sourceEvidenceIds,
      ...targetEvidenceIds,
      ...conditionEvidenceIds,
      ...escalationEvidenceIds,
      ...urgencyEvidenceIds
    ])]
    return {
      pressure: {
        id,
        source: assertNonEmpty(item.source.claim, `${path}.source.claim`),
        target: assertNonEmpty(item.target.claim, `${path}.target.claim`),
        condition: assertNonEmpty(item.condition.claim, `${path}.condition.claim`),
        escalation: assertNonEmpty(item.escalation.claim, `${path}.escalation.claim`),
        urgency: item.urgency.value,
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
    return {
      ...update,
      claim: assertNonEmpty(update.claim, `${path}.claim`),
      evidence: evidenceText(evidenceIds, unitMap),
      evidenceIds
    }
  })

  const emotion = draft.emotion
  const triggerEvidenceIds = useEvidence(emotion.trigger.evidenceIds, 'emotion.trigger.evidenceIds')
  const choiceEvidenceIds = useEvidence(emotion.choice.evidenceIds, 'emotion.choice.evidenceIds')
  const costEvidenceIds = useEvidence(emotion.cost.evidenceIds, 'emotion.cost.evidenceIds')
  const residueEvidenceIds = useEvidence(emotion.residue.evidenceIds, 'emotion.residue.evidenceIds')
  const terminalEvidenceIds = draft.core.terminal.conditionMet
    ? useEvidence(draft.core.terminal.evidenceIds, 'core.terminal.evidenceIds')
    : useEvidence(draft.core.terminal.evidenceIds, 'core.terminal.evidenceIds', 0)
  if (draft.core.terminal.conditionMet && !state.terminalConditions.includes(draft.core.terminal.matchedCondition.trim())) {
    throw new CausalOutcomeProtocolError('OUTCOME_REFERENCE', '完结声明没有命中权威终止条件', ['core.terminal.matchedCondition'])
  }

  const promiseIds = new Set([...state.promises.map(item => item.id), ...state.archivedPromiseIds])
  const newPromises = draft.core.newPromises.map(item => {
    const id = nextServerId('p', promiseIds)
    promiseIds.add(id)
    return { id, question: assertNonEmpty(item.question, 'core.newPromises.question') }
  })
  const summary = [
    assertNonEmpty(draft.core.primaryEvent.claim, 'core.primaryEvent.claim'),
    ...draft.core.supportingEvents.map((event, index) =>
      assertNonEmpty(event.claim, `core.supportingEvents[${index}].claim`)
    )
  ].join('；')
  for (const mutation of mutations) {
    const evidenceIds = validateCausalEvidenceIds(
      units,
      mutation.evidenceIds,
      `mutations.${mutation.id}.evidenceIds`,
      { min: 1, max: CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX }
    )
    evidenceIds.forEach(id => usedEvidenceIds.add(id))
  }
  const evidenceRefs = [...usedEvidenceIds].map(id => ({ id, text: unitMap.get(id)!.text }))
  return {
    summary,
    eventSignature: assertNonEmpty(draft.core.primaryEvent.eventSignature, 'core.primaryEvent.eventSignature'),
    evidenceQuotes: [...new Set(coreEvidenceIds)].map(id => unitMap.get(id)!.text),
    evidenceRefs,
    mutations,
    advancedPromiseIds: [...new Set(advancedPromiseIds)],
    resolvedPromiseIds: [...new Set(resolvedPromiseIds)],
    newPromises,
    actorUpdates,
    newActors,
    pressureUpdates,
    newPressures,
    arcUpdates,
    emotionalOutcome: {
      readerEffectSummary: assertNonEmpty(
        emotion.readerEffect.claim,
        'emotion.readerEffect.claim',
        'OUTCOME_EMOTION'
      ),
      triggerEvidence: evidenceText(triggerEvidenceIds, unitMap),
      choiceEvidence: evidenceText(choiceEvidenceIds, unitMap),
      costEvidence: evidenceText(costEvidenceIds, unitMap),
      residueEvidence: evidenceText(residueEvidenceIds, unitMap),
      triggerEvidenceIds,
      choiceEvidenceIds,
      costEvidenceIds,
      residueEvidenceIds,
      emotionalDebtOpened: emotion.debtOpened.claim.trim(),
      emotionalDebtPaid: emotion.debtPaid.claim.trim()
    },
    terminalConditionMet: draft.core.terminal.conditionMet,
    matchedTerminalCondition: draft.core.terminal.conditionMet ? draft.core.terminal.matchedCondition.trim() : '',
    terminalEvidence: evidenceText(terminalEvidenceIds, unitMap),
    terminalEvidenceIds,
    completionReason: draft.core.terminal.conditionMet
      ? assertNonEmpty(draft.core.terminal.completionReason, 'core.terminal.completionReason')
      : ''
  }
}

export function causalOutcomeFailureCode(error: unknown): CausalOutcomeFailureCode {
  if (error instanceof CausalOutcomeProtocolError) return error.code
  const message = error instanceof Error ? error.message : String(error)
  const cause = message.includes('结构化输出无效：')
    ? message.slice(message.lastIndexOf('结构化输出无效：') + '结构化输出无效：'.length)
    : message
  if (/预算|调用次数|超过 \d+ 次/.test(cause)) return 'OUTCOME_BUDGET'
  if (/finishReason=length|长度上限|输出.*截断/i.test(cause)) return 'OUTCOME_TRUNCATED'
  if (/timeout|timed out|网络|连接|模型无返回|请求失败/i.test(cause)) return 'OUTCOME_TRANSPORT'
  if (/正文合同|正文没有支持必要状态变更/.test(cause)) return 'OUTCOME_BODY_CONTRACT'
  if (/需要拆分结论|原子结论上限|actualCount|atomization/i.test(cause)) {
    return 'OUTCOME_ATOMIZATION_REQUIRED'
  }
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

export function causalOutcomeFailureIssues(error: unknown): CausalOutcomeProtocolIssue[] {
  if (error instanceof CausalOutcomeProtocolError && error.issues.length) {
    return error.issues.map(issue => ({ ...issue }))
  }
  const message = error instanceof Error ? error.message : String(error)
  const issues: CausalOutcomeProtocolIssue[] = []
  const capacityPattern = /([A-Za-z0-9_.[\]-]+) 实际包含 (\d+) 个正文证据 ID，单条原子结论上限为 (\d+)/g
  for (const match of message.matchAll(capacityPattern)) {
    issues.push({
      path: match[1],
      actualCount: Number(match[2]),
      max: Number(match[3])
    })
  }
  return issues
}
