import { createHash } from 'node:crypto'
import type {
  CausalChapterDecisionRecord,
  CausalNarrativeState,
  CausalOutcomeMutation,
  CausalOutcomeMutationKind
} from './causal-novel-types'
import {
  CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX,
  CausalOutcomeProtocolError,
  validateCausalEvidenceIds,
  type CausalBodyEvidenceUnit,
  type CausalOutcomeCoreDraft,
  type CausalOutcomeDraftBundle
} from './causal-outcome-protocol'

export const CAUSAL_CORE_SEMANTIC_EVIDENCE_MAX = 2

export interface AtomicOutcomeClaim {
  id: string
  kind: CausalOutcomeMutationKind
  subject: string
  claimPath?: string
  evidencePath: string
  claim: string
  value?: string
  claimTemplate?: string
  evidenceIds: string[]
  required: boolean
  repairable: boolean
}

export interface CausalCoreSemanticEventDraft {
  claim: string
  eventSignature: string
  evidenceIds: string[]
}

export interface CausalCoreSemanticRepair {
  claimId: string
  replacement: CausalCoreSemanticEventDraft
  additionalEvents: Array<{
    claim: string
    evidenceIds: string[]
  }>
}

function getPath(root: unknown, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let current = root as any
  for (const part of parts) current = current?.[part]
  return current
}

function setPath(root: unknown, path: string, value: unknown): void {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let current = root as any
  for (let index = 0; index < parts.length - 1; index++) current = current[parts[index]]
  current[parts.at(-1)!] = value
}

function stableMutationId(input: {
  kind: CausalOutcomeMutationKind
  subject: string
  claimPath?: string
  evidencePath: string
}): string {
  const identity = [
    input.kind,
    input.subject,
    input.claimPath ?? '',
    input.evidencePath
  ].join('\u0000')
  return `m_${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`
}

export function atomicOutcomeArtifactHash(claims: readonly AtomicOutcomeClaim[]): string {
  return createHash('sha256').update(JSON.stringify(claims)).digest('hex')
}

export function atomicOutcomeClaimEvidenceText(claim: AtomicOutcomeClaim): string {
  return claim.value?.trim() || claim.claim
}

export function buildAtomicOutcomeClaims(input: {
  bundle: CausalOutcomeDraftBundle
  state: CausalNarrativeState
  record: CausalChapterDecisionRecord
}): AtomicOutcomeClaim[] {
  const { bundle, state, record } = input
  const claims: AtomicOutcomeClaim[] = []
  const add = (item: Omit<AtomicOutcomeClaim, 'id' | 'claim' | 'evidenceIds'> & {
    claim: string
  }): void => {
    const claim = item.claim.trim()
    if (!claim) return
    const evidenceIds = (
      (getPath(bundle, item.evidencePath) as string[] | undefined) ?? []
    ).map(String)
    const rawValue = item.claimPath ? String(getPath(bundle, item.claimPath) ?? '').trim() : undefined
    const claimTemplate = rawValue
      ? claim.split(rawValue).join('{{value}}')
      : undefined
    claims.push({
      ...item,
      id: stableMutationId(item),
      claim,
      value: rawValue,
      claimTemplate,
      evidenceIds
    })
  }

  add({
    kind: 'core_summary',
    subject: 'chapter',
    claimPath: 'core.primaryEvent.claim',
    evidencePath: 'core.primaryEvent.evidenceIds',
    claim: bundle.core.primaryEvent.claim,
    required: true,
    repairable: true
  })
  bundle.core.supportingEvents.forEach((event, index) => add({
    kind: 'core_summary',
    subject: `supporting:${index}`,
    claimPath: `core.supportingEvents[${index}].claim`,
    evidencePath: `core.supportingEvents[${index}].evidenceIds`,
    claim: event.claim,
    required: false,
    repairable: true
  }))

  const promiseMap = new Map(state.promises.map(item => [item.id, item.question]))
  bundle.core.advancedPromises.forEach((item, index) => add({
    kind: 'promise_advance',
    subject: item.promiseId,
    claimPath: `core.advancedPromises[${index}].claim`,
    evidencePath: `core.advancedPromises[${index}].evidenceIds`,
    claim: `本章实质推进了读者承诺「${promiseMap.get(item.promiseId) ?? item.promiseId}」：${item.claim}`,
    required: record.plan.decision.advancedPromiseIds.includes(item.promiseId),
    repairable: true
  }))
  bundle.core.resolvedPromises.forEach((item, index) => add({
    kind: 'promise_resolve',
    subject: item.promiseId,
    claimPath: `core.resolvedPromises[${index}].claim`,
    evidencePath: `core.resolvedPromises[${index}].evidenceIds`,
    claim: `本章已经回答并关闭读者承诺「${promiseMap.get(item.promiseId) ?? item.promiseId}」：${item.claim}`,
    required: false,
    repairable: false
  }))
  bundle.core.newPromises.forEach((item, index) => add({
    kind: 'promise_open',
    subject: `new:${index}`,
    claimPath: `core.newPromises[${index}].claim`,
    evidencePath: `core.newPromises[${index}].evidenceIds`,
    claim: `本章新打开悬念「${item.question}」：${item.claim}`,
    required: false,
    repairable: true
  }))

  const actorFieldLabels: Record<string, string> = {
    currentGoal: '当前目标',
    knowledge: '知识',
    resources: '资源',
    constraint: '约束',
    location: '位置',
    physicalState: '身体状态',
    relationships: '关系事实',
    obligations: '义务'
  }
  bundle.actors.actorMutations.forEach((mutation, index) => add({
    kind: 'actor_state',
    subject: `${mutation.actor}:${mutation.field}:${mutation.operation}:${index}`,
    claimPath: `actors.actorMutations[${index}].value`,
    evidencePath: `actors.actorMutations[${index}].evidenceIds`,
    claim: `${mutation.actor}的${actorFieldLabels[mutation.field] ?? mutation.field}${mutation.operation === 'set' ? '变为' : mutation.operation === 'add' ? '新增' : '移除'}：${mutation.value}`,
    required: false,
    repairable: true
  }))

  bundle.actors.newActors.forEach((actor, actorIndex) => {
    const name = actor.facts.find(fact => fact.field === 'name')?.value.trim() || actor.key
    actor.facts.forEach((fact, factIndex) => add({
      kind: 'actor_create',
      subject: fact.field === 'name'
        ? `${name}:name`
        : `${name}:${fact.field}:${factIndex}`,
      claimPath: `actors.newActors[${actorIndex}].facts[${factIndex}].value`,
      evidencePath: `actors.newActors[${actorIndex}].facts[${factIndex}].evidenceIds`,
      claim: `新增人物${name}的${fact.field}：${fact.value}`,
      required: fact.field === 'name',
      repairable: fact.field !== 'name'
    }))
  })

  bundle.world.pressureConditionUpdates.forEach((item, index) => add({
    kind: 'pressure_state',
    subject: `${item.id}:condition`,
    claimPath: `world.pressureConditionUpdates[${index}].value`,
    evidencePath: `world.pressureConditionUpdates[${index}].evidenceIds`,
    claim: `压力 ${item.id} 的当前条件变为：${item.value}`,
    required: false,
    repairable: true
  }))
  bundle.world.pressureStatusUpdates.forEach((item, index) => add({
    kind: 'pressure_state',
    subject: `${item.id}:status`,
    evidencePath: `world.pressureStatusUpdates[${index}].evidenceIds`,
    claim: item.value === 'escalated'
      ? `压力 ${item.id} 在本章升级`
      : item.value === 'relieved'
        ? `压力 ${item.id} 在本章缓解`
        : item.value === 'resolved'
          ? `压力 ${item.id} 在本章解除`
          : `压力 ${item.id} 在本章持续存在`,
    required: false,
    repairable: false
  }))
  bundle.world.pressureUrgencyUpdates.forEach((item, index) => {
    const previousUrgency = state.activePressures.find(pressure => pressure.id === item.id)?.urgency
    const direction = previousUrgency == null || item.value === previousUrgency
      ? '维持'
      : item.value > previousUrgency ? '上升' : '下降'
    add({
      kind: 'pressure_state',
      subject: `${item.id}:urgency`,
      evidencePath: `world.pressureUrgencyUpdates[${index}].evidenceIds`,
      claim: `压力 ${item.id} 的紧迫性在本章${direction}`,
      required: false,
      repairable: false
    })
  })

  bundle.world.newPressures.forEach((pressure, index) => {
    for (const field of ['source', 'target', 'condition', 'escalation'] as const) {
      add({
        kind: 'pressure_create',
        subject: `new:${index}:${field}`,
        claimPath: `world.newPressures[${index}].${field}.claim`,
        evidencePath: `world.newPressures[${index}].${field}.evidenceIds`,
        claim: `新增压力的${field}：${pressure[field].claim}`,
        required: true,
        repairable: true
      })
    }
    add({
      kind: 'pressure_create',
      subject: `new:${index}:urgency`,
      claimPath: `world.newPressures[${index}].urgency.claim`,
      evidencePath: `world.newPressures[${index}].urgency.evidenceIds`,
      claim: `新增压力的现实紧迫事实：${pressure.urgency.claim}`,
      required: true,
      repairable: true
    })
  })

  bundle.world.arcUpdates.forEach((arc, index) => add({
    kind: 'arc_state',
    subject: arc.id,
    claimPath: `world.arcUpdates[${index}].claim`,
    evidencePath: `world.arcUpdates[${index}].evidenceIds`,
    claim: `阶段 ${arc.id} 在本章${arc.status === 'completed' ? '完成' : '推进'}：${arc.claim}`,
    required: false,
    repairable: true
  }))

  const emotionItems: Array<{
    key: 'readerEffect' | 'trigger' | 'choice' | 'cost' | 'residue' | 'debtOpened' | 'debtPaid'
    subject: string
    required: boolean
  }> = [
    { key: 'readerEffect', subject: 'reader_effect', required: true },
    { key: 'trigger', subject: 'trigger', required: true },
    { key: 'choice', subject: 'choice', required: true },
    { key: 'cost', subject: 'cost', required: true },
    { key: 'residue', subject: 'residue', required: true },
    { key: 'debtOpened', subject: 'debt_opened', required: false },
    { key: 'debtPaid', subject: 'debt_paid', required: false }
  ]
  for (const item of emotionItems) {
    const value = bundle.emotion[item.key]
    if (!item.required && !value.claim.trim()) continue
    add({
      kind: 'emotion_result',
      subject: item.subject,
      claimPath: `emotion.${item.key}.claim`,
      evidencePath: `emotion.${item.key}.evidenceIds`,
      claim: value.claim,
      required: item.required,
      repairable: true
    })
  }

  if (bundle.core.terminal.conditionMet) {
    add({
      kind: 'terminal_state',
      subject: bundle.core.terminal.matchedCondition,
      claimPath: 'core.terminal.completionReason',
      evidencePath: 'core.terminal.evidenceIds',
      claim: bundle.core.terminal.completionReason,
      required: true,
      repairable: false
    })
  }

  const ids = claims.map(item => item.id)
  if (new Set(ids).size !== ids.length) {
    throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', '原子状态变更 ID 冲突')
  }
  const evidencePaths = claims.map(item => item.evidencePath)
  if (new Set(evidencePaths).size !== evidencePaths.length) {
    throw new CausalOutcomeProtocolError(
      'OUTCOME_SCHEMA',
      'v6 原子状态变更必须一条声明对应唯一证据路径'
    )
  }
  return claims
}

export function materializeAtomicOutcomeClaims(input: {
  bundle: CausalOutcomeDraftBundle
  claims: AtomicOutcomeClaim[]
  units: CausalBodyEvidenceUnit[]
}): CausalOutcomeMutation[] {
  const { bundle, claims, units } = input
  const evidencePaths = claims.map(item => item.evidencePath)
  if (new Set(evidencePaths).size !== evidencePaths.length) {
    throw new CausalOutcomeProtocolError(
      'OUTCOME_SCHEMA',
      'v6 原子状态变更不能共享或合并证据路径'
    )
  }
  return claims.map(claim => {
    const evidenceIds = validateCausalEvidenceIds(
      units,
      claim.evidenceIds,
      `${claim.id}.evidenceIds`,
      { min: 1, max: CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX }
    )
    if (claim.claimPath && claim.repairable) {
      const value = claim.value?.trim() ?? ''
      if (!value) {
        throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', `${claim.id} 的声明不能为空`)
      }
      setPath(bundle, claim.claimPath, value)
    }
    setPath(bundle, claim.evidencePath, evidenceIds)
    return {
      id: claim.id,
      kind: claim.kind,
      subject: claim.subject,
      claim: claim.claim,
      evidenceIds,
      required: claim.required
    }
  })
}

export function applyCausalCoreSemanticRepairs(input: {
  core: CausalOutcomeCoreDraft
  claims: AtomicOutcomeClaim[]
  repairs: CausalCoreSemanticRepair[]
  units: CausalBodyEvidenceUnit[]
}): CausalOutcomeCoreDraft {
  const repairIds = input.repairs.map(item => item.claimId)
  if (new Set(repairIds).size !== repairIds.length) {
    throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', '核心事件结构修复包含重复 claimId')
  }
  if (
    repairIds.length !== input.claims.length ||
    input.claims.some(claim => !repairIds.includes(claim.id))
  ) {
    throw new CausalOutcomeProtocolError(
      'OUTCOME_SCHEMA',
      '核心事件结构修复没有完整返回当前批次的全部 claimId'
    )
  }
  const targetClaims = input.claims.filter(claim => repairIds.includes(claim.id))
  if (
    targetClaims.length !== repairIds.length ||
    targetClaims.some(claim => claim.kind !== 'core_summary' || !claim.claimPath)
  ) {
    throw new CausalOutcomeProtocolError(
      'OUTCOME_SCHEMA',
      '核心事件结构修复只能处理当前批次中可定位的 core_summary 声明'
    )
  }

  const next = structuredClone(input.core)
  const supportingRepairs: Array<{
    index: number
    replacement: { claim: string; evidenceIds: string[] }
    additionalEvents: Array<{ claim: string; evidenceIds: string[] }>
  }> = []
  for (const repair of input.repairs) {
    const claim = targetClaims.find(item => item.id === repair.claimId)!
    const replacementClaim = repair.replacement.claim.trim()
    if (!replacementClaim) {
      throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', `${repair.claimId} 的 replacement.claim 不能为空`)
    }
    const replacementEvidenceIds = validateCausalEvidenceIds(
      input.units,
      repair.replacement.evidenceIds,
      `${repair.claimId}.replacement.evidenceIds`,
      { min: 1, max: CAUSAL_CORE_SEMANTIC_EVIDENCE_MAX }
    )
    const additionalEvents = repair.additionalEvents.map((event, index) => {
      const eventClaim = event.claim.trim()
      if (!eventClaim) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_SCHEMA',
          `${repair.claimId}.additionalEvents[${index}].claim 不能为空`
        )
      }
      return {
        claim: eventClaim,
        evidenceIds: validateCausalEvidenceIds(
          input.units,
          event.evidenceIds,
          `${repair.claimId}.additionalEvents[${index}].evidenceIds`,
          { min: 1, max: CAUSAL_CORE_SEMANTIC_EVIDENCE_MAX }
        )
      }
    })

    if (claim.claimPath === 'core.primaryEvent.claim') {
      const eventSignature = repair.replacement.eventSignature.trim()
      if (!eventSignature) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_SCHEMA',
          `${repair.claimId} 修复主事件时 eventSignature 不能为空`
        )
      }
      next.primaryEvent = {
        claim: replacementClaim,
        eventSignature,
        evidenceIds: replacementEvidenceIds
      }
      next.supportingEvents.push(...additionalEvents)
      continue
    }

    const match = /^core\.supportingEvents\[(\d+)]\.claim$/.exec(claim.claimPath)
    if (!match) {
      throw new CausalOutcomeProtocolError(
        'OUTCOME_SCHEMA',
        `${repair.claimId} 不是可拆分的核心事件声明`
      )
    }
    if (repair.replacement.eventSignature.trim()) {
      throw new CausalOutcomeProtocolError(
        'OUTCOME_SCHEMA',
        `${repair.claimId} 修复 supportingEvent 时 eventSignature 必须为空`
      )
    }
    supportingRepairs.push({
      index: Number(match[1]),
      replacement: { claim: replacementClaim, evidenceIds: replacementEvidenceIds },
      additionalEvents
    })
  }

  for (const repair of supportingRepairs.sort((left, right) => right.index - left.index)) {
    if (!next.supportingEvents[repair.index]) {
      throw new CausalOutcomeProtocolError(
        'OUTCOME_SCHEMA',
        `核心事件结构修复引用不存在的 supportingEvents[${repair.index}]`
      )
    }
    next.supportingEvents.splice(
      repair.index,
      1,
      repair.replacement,
      ...repair.additionalEvents
    )
  }
  return next
}
