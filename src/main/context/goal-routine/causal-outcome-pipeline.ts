import { createHash } from 'node:crypto'
import { causalNovelDAO } from '../../db'
import { modelService } from '../../model'
import {
  CAUSAL_OUTCOME_PROTOCOL_VERSION,
  CausalOutcomeProtocolError,
  buildCausalBodyEvidenceUnits,
  causalEvidenceIndexHash,
  causalOutcomeFailureCode,
  materializeCausalOutcomeDraft,
  validateCausalEvidenceIds,
  type CausalBodyEvidenceUnit,
  type CausalOutcomeActorDraft,
  type CausalOutcomeCoreDraft,
  type CausalOutcomeDraftBundle,
  type CausalOutcomeEmotionDraft,
  type CausalOutcomeWorldDraft
} from '../../../shared/causal-outcome-protocol'
import type {
  CausalChapterDecisionRecord,
  CausalChapterOutcome,
  CausalNarrativeState
} from '../../../shared/causal-novel-types'
import { requestStructuredModelOutput } from './structured-model-output'
import { withGoalLoopModelOptions } from './story-goal-model'

const MAX_MODEL_CALLS = 8

const STRING_ARRAY = { type: 'array', maxItems: 12, items: { type: 'string' } }
function evidenceArraySchema(ids: string[], minItems = 1): Record<string, unknown> {
  return { type: 'array', minItems, maxItems: 6, items: { type: 'string', enum: ids } }
}

function knownIdArraySchema(ids: string[], maxItems = 6): Record<string, unknown> {
  return {
    type: 'array',
    maxItems: ids.length ? Math.min(maxItems, ids.length) : 0,
    items: ids.length ? { type: 'string', enum: ids } : { type: 'string' }
  }
}

function knownIdSchema(ids: string[]): Record<string, unknown> {
  return ids.length ? { type: 'string', enum: ids } : { type: 'string' }
}

function coreSchema(state: CausalNarrativeState, units: CausalBodyEvidenceUnit[]): Record<string, unknown> {
  const evidenceIds = units.map(unit => unit.id)
  const promiseIds = state.promises.filter(item => item.status !== 'resolved').map(item => item.id)
  return {
    type: 'object', additionalProperties: false,
    required: [
      'summary', 'eventSignature', 'evidenceIds', 'advancedPromiseIds', 'resolvedPromiseIds',
      'newPromiseQuestions', 'terminalConditionMet', 'matchedTerminalCondition',
      'terminalEvidenceIds', 'completionReason'
    ],
    properties: {
      summary: { type: 'string' }, eventSignature: { type: 'string' },
      evidenceIds: evidenceArraySchema(evidenceIds),
      advancedPromiseIds: knownIdArraySchema(promiseIds),
      resolvedPromiseIds: knownIdArraySchema(promiseIds),
      newPromiseQuestions: { type: 'array', maxItems: 4, items: { type: 'string' } },
      terminalConditionMet: { type: 'boolean' },
      matchedTerminalCondition: { type: 'string' },
      terminalEvidenceIds: evidenceArraySchema(evidenceIds, 0),
      completionReason: { type: 'string' }
    }
  }
}

function actorsSchema(state: CausalNarrativeState, units: CausalBodyEvidenceUnit[]): Record<string, unknown> {
  const actorNames = state.actors.map(actor => actor.name)
  const evidenceIds = units.map(unit => unit.id)
  return {
    type: 'object', additionalProperties: false, required: ['actorUpdates', 'newActors'],
    properties: {
      actorUpdates: {
        type: 'array', maxItems: Math.min(12, actorNames.length), items: {
          type: 'object', additionalProperties: false,
          required: [
            'actor', 'currentGoal', 'knowledgeAdded', 'resourcesAdded', 'resourcesRemoved',
            'constraint', 'location', 'physicalState', 'relationshipsAdded',
            'relationshipsRemoved', 'obligationsAdded', 'obligationsRemoved', 'evidenceIds'
          ],
          properties: {
            actor: knownIdSchema(actorNames), currentGoal: { type: 'string' },
            knowledgeAdded: STRING_ARRAY, resourcesAdded: STRING_ARRAY,
            resourcesRemoved: STRING_ARRAY, constraint: { type: 'string' },
            location: { type: 'string' }, physicalState: { type: 'string' },
            relationshipsAdded: STRING_ARRAY, relationshipsRemoved: STRING_ARRAY,
            obligationsAdded: STRING_ARRAY, obligationsRemoved: STRING_ARRAY,
            evidenceIds: evidenceArraySchema(evidenceIds)
          }
        }
      },
      newActors: {
        type: 'array', maxItems: 4, items: {
          type: 'object', additionalProperties: false,
          required: [
            'name', 'currentGoal', 'fear', 'knowledge', 'resources', 'constraint',
            'location', 'physicalState', 'relationships', 'obligations', 'evidenceIds'
          ],
          properties: {
            name: { type: 'string' }, currentGoal: { type: 'string' }, fear: { type: 'string' },
            knowledge: STRING_ARRAY, resources: STRING_ARRAY, constraint: { type: 'string' },
            location: { type: 'string' }, physicalState: { type: 'string' },
            relationships: STRING_ARRAY, obligations: STRING_ARRAY,
            evidenceIds: evidenceArraySchema(evidenceIds)
          }
        }
      }
    }
  }
}

function worldSchema(state: CausalNarrativeState, units: CausalBodyEvidenceUnit[]): Record<string, unknown> {
  const evidenceIds = units.map(unit => unit.id)
  return {
    type: 'object', additionalProperties: false,
    required: ['pressureUpdates', 'newPressures', 'arcUpdates'],
    properties: {
      pressureUpdates: {
        type: 'array', maxItems: Math.min(12, state.activePressures.length), items: {
          type: 'object', additionalProperties: false,
          required: ['id', 'direction', 'condition', 'urgency', 'evidenceIds'],
          properties: {
            id: knownIdSchema(state.activePressures.map(item => item.id)),
            direction: { type: 'string', enum: ['stable', 'escalated', 'relieved', 'resolved'] },
            condition: { type: 'string' }, urgency: { type: 'integer', minimum: 1, maximum: 10 },
            evidenceIds: evidenceArraySchema(evidenceIds)
          }
        }
      },
      newPressures: {
        type: 'array', maxItems: 6, items: {
          type: 'object', additionalProperties: false,
          required: ['source', 'target', 'condition', 'escalation', 'urgency', 'evidenceIds'],
          properties: {
            source: { type: 'string' }, target: { type: 'string' }, condition: { type: 'string' },
            escalation: { type: 'string' }, urgency: { type: 'integer', minimum: 1, maximum: 10 },
            evidenceIds: evidenceArraySchema(evidenceIds)
          }
        }
      },
      arcUpdates: {
        type: 'array', maxItems: Math.min(4, state.macroArcs.length), items: {
          type: 'object', additionalProperties: false, required: ['id', 'status', 'evidenceIds'],
          properties: {
            id: knownIdSchema(state.macroArcs.map(item => item.id)),
            status: { type: 'string', enum: ['active', 'completed'] },
            evidenceIds: evidenceArraySchema(evidenceIds)
          }
        }
      }
    }
  }
}

function emotionSchema(units: CausalBodyEvidenceUnit[]): Record<string, unknown> {
  const evidenceIds = units.map(unit => unit.id)
  return {
    type: 'object', additionalProperties: false,
    required: [
      'readerEffectSummary', 'triggerEvidenceIds', 'choiceEvidenceIds', 'costEvidenceIds',
      'residueEvidenceIds', 'emotionalDebtOpened', 'emotionalDebtPaid'
    ],
    properties: {
      readerEffectSummary: { type: 'string' },
      triggerEvidenceIds: evidenceArraySchema(evidenceIds),
      choiceEvidenceIds: evidenceArraySchema(evidenceIds),
      costEvidenceIds: evidenceArraySchema(evidenceIds),
      residueEvidenceIds: evidenceArraySchema(evidenceIds),
      emotionalDebtOpened: { type: 'string' }, emotionalDebtPaid: { type: 'string' }
    }
  }
}

interface PipelineBudget {
  calls: number
  max: number
}

interface ClaimDescriptor {
  id: string
  claimPath?: string
  evidencePath: string
  claim: string
  evidenceIds: string[]
}

function evidenceCatalog(units: CausalBodyEvidenceUnit[]): string {
  return units.map(unit => `${unit.id} [段${unit.paragraph}] ${unit.text}`).join('\n')
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

function evidencePaths(value: unknown, base = ''): Array<{ path: string; ids: string[] }> {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => evidencePaths(item, `${base}[${index}]`))
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = base ? `${base}.${key}` : key
    if (/EvidenceIds$|^evidenceIds$/.test(key) && Array.isArray(child)) {
      return [{ path, ids: child.map(String) }]
    }
    return evidencePaths(child, path)
  })
}

function validateStageEvidence(stage: unknown, units: CausalBodyEvidenceUnit[]): void {
  const failures: string[] = []
  for (const item of evidencePaths(stage)) {
    try {
      validateCausalEvidenceIds(units, item.ids, item.path, {
        min: item.path.endsWith('terminalEvidenceIds') && !(stage as CausalOutcomeCoreDraft).terminalConditionMet ? 0 : 1
      })
    } catch {
      failures.push(item.path)
    }
  }
  if (failures.length) {
    throw new CausalOutcomeProtocolError(
      'OUTCOME_EVIDENCE_ID', `以下字段引用了非法证据 ID：${failures.join('、')}`, failures
    )
  }
}

async function requestStage<T>(input: {
  workId: number
  chapterId: number
  contentVersionId: number
  bodyHash: string
  stage: string
  label: string
  schema: Record<string, unknown>
  state: CausalNarrativeState
  record: CausalChapterDecisionRecord
  units: CausalBodyEvidenceUnit[]
  budget: PipelineBudget
  signal?: AbortSignal
  instructions: string[]
  validate: (value: Record<string, unknown>) => T
  onProgress?: (message: string) => void
}): Promise<T> {
  const cached = causalNovelDAO.getCheckpoint(
    input.chapterId, input.contentVersionId, input.stage, CAUSAL_OUTCOME_PROTOCOL_VERSION
  )
  const cachedEnvelope = cached?.payload as { stateRevision?: number; value?: Record<string, unknown> } | null
  if (
    cached?.status === 'completed' &&
    cachedEnvelope?.stateRevision === input.state.revision &&
    cachedEnvelope.value
  ) {
    const validated = input.validate(cachedEnvelope.value)
    validateStageEvidence(validated, input.units)
    input.onProgress?.(`${input.label}：复用正文版本检查点`)
    return validated
  }
  const catalog = evidenceCatalog(input.units)
  const request = async (attempt: number, lastError: string) => {
    input.budget.calls++
    if (input.budget.calls > input.budget.max) {
      throw new CausalOutcomeProtocolError('OUTCOME_BUDGET', `章后结果模型调用超过 ${input.budget.max} 次预算`)
    }
    input.onProgress?.(`${input.label}：模型调用 ${input.budget.calls}/${input.budget.max}`)
    return modelService.chat(
      withGoalLoopModelOptions(input.workId, {
        workId: input.workId,
        chapterId: input.chapterId,
        step: `goal_novel_causal_outcome_${input.stage}`,
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        maxTokens: 2600,
        forceThinkingDisabled: true,
        responseSchema: { name: `causal_outcome_${input.stage}`, schema: input.schema, strict: true },
        systemPrompt: [
          '你是因果小说章后事实协议的单阶段提取器。只处理本阶段，不写正文、不修改其他阶段。',
          '证据只能填写给定 evidence ID；多个不连续证据必须使用多个 ID，禁止复制或拼接原文。',
          '没有正文支持的变化必须省略或填空数组；不得把计划当成已发生事实。',
          ...input.instructions,
          '只返回符合 JSON Schema 的完整对象。'
        ].join('\n'),
        prompt: [
          `【提交前权威状态】\n${JSON.stringify(input.state, null, 2)}`,
          `【冻结章节决策】\n${JSON.stringify(input.record.plan.decision, null, 2)}`,
          `【冻结情绪事务】\n${JSON.stringify(input.record.plan.emotionContract, null, 2)}`,
          `【正文证据索引】\n${catalog}`,
          attempt > 1 ? `【上次结构错误】\n${lastError}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal: input.signal }
    )
  }
  try {
    let result = await requestStructuredModelOutput<T>({
      workId: input.workId, label: input.label, attempts: 2, signal: input.signal,
      request, validate: input.validate
    })
    try {
      validateStageEvidence(result, input.units)
    } catch (error) {
      if (!(error instanceof CausalOutcomeProtocolError) || error.code !== 'OUTCOME_EVIDENCE_ID') throw error
      const paths = [...new Set(error.paths)]
      if (!paths.length) throw error
      input.budget.calls++
      if (input.budget.calls > input.budget.max) {
        throw new CausalOutcomeProtocolError('OUTCOME_BUDGET', `章后结果模型调用超过 ${input.budget.max} 次预算`)
      }
      input.onProgress?.(`${input.label}：定点修复 ${paths.length} 个证据路径，模型调用 ${input.budget.calls}/${input.budget.max}`)
      const repairSchema = {
        type: 'object', additionalProperties: false, required: ['repairs'],
        properties: {
          repairs: {
            type: 'array', minItems: paths.length, maxItems: paths.length,
            items: {
              type: 'object', additionalProperties: false, required: ['path', 'evidenceIds'],
              properties: {
                path: { type: 'string', enum: paths },
                evidenceIds: evidenceArraySchema(input.units.map(unit => unit.id))
              }
            }
          }
        }
      }
      const repaired = await requestStructuredModelOutput<{
        repairs: Array<{ path: string; evidenceIds: string[] }>
      }>({
        workId: input.workId, label: `${input.label}证据路径修复`, attempts: 1, signal: input.signal,
        request: () => modelService.chat(
          withGoalLoopModelOptions(input.workId, {
            workId: input.workId, chapterId: input.chapterId,
            step: 'goal_novel_causal_outcome_evidence_repair',
            enrichWorkContext: false, enrichNarrativeMemory: false,
            temperature: 0, maxTokens: 900, forceThinkingDisabled: true,
            responseSchema: { name: 'causal_outcome_evidence_repair', schema: repairSchema, strict: true },
            systemPrompt: [
              '只修复给定阶段对象中列出的 evidence ID 路径，不改任何事实声明或操作。',
              '每个 path 必须恰好返回一次；evidenceIds 只能从正文证据索引选择。只返回 JSON。'
            ].join('\n'),
            prompt: [
              `【待修复路径】\n${paths.join('\n')}`,
              `【阶段对象】\n${JSON.stringify(result, null, 2)}`,
              `【正文证据索引】\n${catalog}`
            ].join('\n\n')
          }),
          { stream: false, signal: input.signal }
        ),
        validate: value => ({ repairs: Array.isArray(value.repairs) ? value.repairs as any : [] })
      })
      const returnedPaths = repaired.repairs.map(item => item.path)
      if (new Set(returnedPaths).size !== paths.length || paths.some(path => !returnedPaths.includes(path))) {
        throw new CausalOutcomeProtocolError('OUTCOME_EVIDENCE_ID', '证据路径定点修复没有完整返回所有字段', paths)
      }
      for (const item of repaired.repairs) {
        const validIds = validateCausalEvidenceIds(input.units, item.evidenceIds, item.path)
        setPath(result, item.path, validIds)
      }
      validateStageEvidence(result, input.units)
    }
    causalNovelDAO.saveCheckpoint({
      workId: input.workId, chapterId: input.chapterId, contentVersionId: input.contentVersionId,
      bodyHash: input.bodyHash, protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
      stage: input.stage, status: 'completed',
      payload: { stateRevision: input.state.revision, value: result }
    })
    return result
  } catch (error) {
    causalNovelDAO.saveCheckpoint({
      workId: input.workId, chapterId: input.chapterId, contentVersionId: input.contentVersionId,
      bodyHash: input.bodyHash, protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
      stage: input.stage, status: 'failed', errorMessage: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}

function claimDescriptors(bundle: CausalOutcomeDraftBundle, state?: CausalNarrativeState): ClaimDescriptor[] {
  const claims: ClaimDescriptor[] = []
  const add = (claimPath: string | undefined, evidencePath: string, claim: string): void => {
    const normalized = claim.trim()
    if (!normalized) return
    claims.push({
      id: `c${String(claims.length + 1).padStart(3, '0')}`,
      claimPath, evidencePath, claim: normalized,
      evidenceIds: (getPath(bundle, evidencePath) as string[]) ?? []
    })
  }
  add('core.summary', 'core.evidenceIds', bundle.core.summary)
  const promiseMap = new Map((state?.promises ?? []).map(item => [item.id, item.question]))
  bundle.core.advancedPromiseIds.forEach(id => add(
    undefined, 'core.evidenceIds', `本章实质推进了读者承诺「${promiseMap.get(id) ?? id}」`
  ))
  bundle.core.resolvedPromiseIds.forEach(id => add(
    undefined, 'core.evidenceIds', `本章已经回答并关闭读者承诺「${promiseMap.get(id) ?? id}」`
  ))
  bundle.core.newPromiseQuestions.forEach((claim, index) => add(
    `core.newPromiseQuestions[${index}]`, 'core.evidenceIds', `本章新打开悬念「${claim}」`
  ))
  bundle.actors.actorUpdates.forEach((item, index) => {
    const evidencePath = `actors.actorUpdates[${index}].evidenceIds`
    add(`actors.actorUpdates[${index}].currentGoal`, evidencePath, item.currentGoal)
    add(`actors.actorUpdates[${index}].constraint`, evidencePath, item.constraint)
    add(`actors.actorUpdates[${index}].location`, evidencePath, item.location)
    add(`actors.actorUpdates[${index}].physicalState`, evidencePath, item.physicalState)
    item.knowledgeAdded.forEach((claim, child) => add(`actors.actorUpdates[${index}].knowledgeAdded[${child}]`, evidencePath, claim))
    item.resourcesAdded.forEach((claim, child) => add(`actors.actorUpdates[${index}].resourcesAdded[${child}]`, evidencePath, claim))
    item.resourcesRemoved.forEach((claim, child) => add(`actors.actorUpdates[${index}].resourcesRemoved[${child}]`, evidencePath, claim))
    item.relationshipsAdded.forEach((claim, child) => add(`actors.actorUpdates[${index}].relationshipsAdded[${child}]`, evidencePath, claim))
    item.relationshipsRemoved.forEach((claim, child) => add(`actors.actorUpdates[${index}].relationshipsRemoved[${child}]`, evidencePath, claim))
    item.obligationsAdded.forEach((claim, child) => add(`actors.actorUpdates[${index}].obligationsAdded[${child}]`, evidencePath, claim))
    item.obligationsRemoved.forEach((claim, child) => add(`actors.actorUpdates[${index}].obligationsRemoved[${child}]`, evidencePath, claim))
  })
  bundle.actors.newActors.forEach((item, index) => {
    const evidencePath = `actors.newActors[${index}].evidenceIds`
    add(`actors.newActors[${index}].name`, evidencePath, item.name)
    add(`actors.newActors[${index}].currentGoal`, evidencePath, item.currentGoal)
    add(`actors.newActors[${index}].fear`, evidencePath, item.fear)
    add(`actors.newActors[${index}].constraint`, evidencePath, item.constraint)
    add(`actors.newActors[${index}].location`, evidencePath, item.location)
    add(`actors.newActors[${index}].physicalState`, evidencePath, item.physicalState)
  })
  bundle.world.pressureUpdates.forEach((item, index) => add(
    `world.pressureUpdates[${index}].condition`, `world.pressureUpdates[${index}].evidenceIds`, item.condition
  ))
  bundle.world.pressureUpdates.forEach((item, index) => add(
    undefined,
    `world.pressureUpdates[${index}].evidenceIds`,
    `压力 ${item.id} 在本章变为 ${item.direction}，紧迫度为 ${item.urgency}`
  ))
  bundle.world.newPressures.forEach((item, index) => {
    const evidencePath = `world.newPressures[${index}].evidenceIds`
    add(`world.newPressures[${index}].condition`, evidencePath, item.condition)
    add(`world.newPressures[${index}].source`, evidencePath, item.source)
  })
  add('emotion.readerEffectSummary', 'emotion.residueEvidenceIds', bundle.emotion.readerEffectSummary)
  add('emotion.emotionalDebtOpened', 'emotion.residueEvidenceIds', bundle.emotion.emotionalDebtOpened)
  add('emotion.emotionalDebtPaid', 'emotion.residueEvidenceIds', bundle.emotion.emotionalDebtPaid)
  if (bundle.core.terminalConditionMet) add('core.completionReason', 'core.terminalEvidenceIds', bundle.core.completionReason)
  return claims
}

function auditSchema(claimIds: string[]): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false, required: ['passed', 'failedClaimIds', 'reasons'],
    properties: {
      passed: { type: 'boolean' },
      failedClaimIds: { type: 'array', maxItems: claimIds.length, items: { type: 'string', enum: claimIds } },
      reasons: { type: 'array', maxItems: 12, items: { type: 'string' } }
    }
  }
}

async function auditEntailment(input: {
  workId: number; chapterId: number; contentVersionId: number; bodyHash: string
  bundle: CausalOutcomeDraftBundle; state: CausalNarrativeState
  units: CausalBodyEvidenceUnit[]; budget: PipelineBudget
  signal?: AbortSignal; onProgress?: (message: string) => void
}): Promise<void> {
  const claims = claimDescriptors(input.bundle, input.state)
  if (!claims.length) return
  const unitMap = new Map(input.units.map(unit => [unit.id, unit.text]))
  const auditOnce = async () => {
    const currentClaims = claimDescriptors(input.bundle, input.state)
    input.budget.calls++
    if (input.budget.calls > input.budget.max) {
      throw new CausalOutcomeProtocolError('OUTCOME_BUDGET', `章后结果模型调用超过 ${input.budget.max} 次预算`)
    }
    input.onProgress?.(`章后结果 · 证据蕴含审计：模型调用 ${input.budget.calls}/${input.budget.max}`)
    return requestStructuredModelOutput<{ passed: boolean; failedClaimIds: string[]; reasons: string[] }>({
      workId: input.workId, label: '因果结果证据蕴含审计', attempts: 1, signal: input.signal,
      request: () => modelService.chat(
        withGoalLoopModelOptions(input.workId, {
          workId: input.workId, chapterId: input.chapterId,
          step: 'goal_novel_causal_outcome_entailment', enrichWorkContext: false, enrichNarrativeMemory: false,
          temperature: 0, maxTokens: 1600, forceThinkingDisabled: true,
          responseSchema: { name: 'causal_outcome_entailment', schema: auditSchema(currentClaims.map(item => item.id)), strict: true },
          systemPrompt: [
            '你是因果状态声明的独立证据审计器。逐条判断声明是否能由绑定的正文证据直接推出。',
            '概括可以比原文短，但不得加入证据没有表达的目标、因果、资源归属、确定性或未来推测。',
            '证据仅出现相关词语但不能推出声明时必须判失败。只返回 JSON。'
          ].join('\n'),
          prompt: JSON.stringify(currentClaims.map(claim => ({
            id: claim.id,
            claim: claim.claim,
            evidence: claim.evidenceIds.map(id => ({ id, text: unitMap.get(id) ?? '' }))
          })))
        }),
        { stream: false, signal: input.signal }
      ),
      validate: value => ({
        passed: value.passed === true,
        failedClaimIds: Array.isArray(value.failedClaimIds) ? value.failedClaimIds.map(String) : [],
        reasons: Array.isArray(value.reasons) ? value.reasons.map(String) : []
      })
    })
  }
  const first = await auditOnce()
  if (first.passed && first.failedClaimIds.length === 0) return
  const failed = claims.filter(item => first.failedClaimIds.includes(item.id))
  if (!failed.length) {
    throw new CausalOutcomeProtocolError('OUTCOME_ENTAILMENT', `证据蕴含审计未通过：${first.reasons.join('；')}`)
  }
  input.budget.calls++
  if (input.budget.calls > input.budget.max) {
    throw new CausalOutcomeProtocolError('OUTCOME_BUDGET', `章后结果模型调用超过 ${input.budget.max} 次预算`)
  }
  input.onProgress?.(`章后结果 · 定点修复 ${failed.length} 个声明：模型调用 ${input.budget.calls}/${input.budget.max}`)
  const repairSchema = {
    type: 'object', additionalProperties: false, required: ['repairs'],
    properties: {
      repairs: {
        type: 'array', minItems: failed.length, maxItems: failed.length,
        items: {
          type: 'object', additionalProperties: false,
          required: ['claimId', 'replacement', 'evidenceIds'],
          properties: {
            claimId: { type: 'string', enum: failed.map(item => item.id) },
            replacement: { type: 'string' },
            evidenceIds: evidenceArraySchema(input.units.map(unit => unit.id))
          }
        }
      }
    }
  }
  const repaired = await requestStructuredModelOutput<{
    repairs: Array<{ claimId: string; replacement: string; evidenceIds: string[] }>
  }>({
    workId: input.workId, label: '因果结果失败声明定点修复', attempts: 1, signal: input.signal,
    request: () => modelService.chat(
      withGoalLoopModelOptions(input.workId, {
        workId: input.workId, chapterId: input.chapterId,
        step: 'goal_novel_causal_outcome_claim_repair', enrichWorkContext: false, enrichNarrativeMemory: false,
        temperature: 0, maxTokens: 1400, forceThinkingDisabled: true,
        responseSchema: { name: 'causal_outcome_claim_repair', schema: repairSchema, strict: true },
        systemPrompt: [
          '只修复列出的失败声明。replacement 必须是证据能直接支持的更窄事实；不能改变操作类型、人物 ID、压力 ID或承诺 ID。',
          'evidenceIds 只能从正文证据索引选择。只返回 JSON。'
        ].join('\n'),
        prompt: [
          `【失败声明】\n${JSON.stringify(failed, null, 2)}`,
          `【审计原因】\n${first.reasons.join('；')}`,
          `【正文证据索引】\n${evidenceCatalog(input.units)}`
        ].join('\n\n')
      }),
      { stream: false, signal: input.signal }
    ),
    validate: value => ({ repairs: Array.isArray(value.repairs) ? value.repairs as any : [] })
  })
  for (const item of repaired.repairs) {
    const descriptor = failed.find(claim => claim.id === item.claimId)
    if (!descriptor) continue
    const validIds = validateCausalEvidenceIds(input.units, item.evidenceIds, descriptor.evidencePath)
    if (descriptor.claimPath) setPath(input.bundle, descriptor.claimPath, item.replacement.trim())
    setPath(input.bundle, descriptor.evidencePath, validIds)
    descriptor.claim = item.replacement.trim()
    descriptor.evidenceIds = validIds
  }
  const second = await auditOnce()
  if (!second.passed || second.failedClaimIds.length) {
    throw new CausalOutcomeProtocolError(
      'OUTCOME_ENTAILMENT', `定点修复后证据蕴含审计仍未通过：${second.reasons.join('；')}`,
      second.failedClaimIds
    )
  }
}

export async function runCausalOutcomePipeline(input: {
  workId: number
  chapterId: number
  contentVersionId: number
  state: CausalNarrativeState
  record: CausalChapterDecisionRecord
  content: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}): Promise<{ outcome: CausalChapterOutcome; bodyHash: string; modelCalls: number }> {
  const bodyHash = createHash('sha256').update(input.content).digest('hex')
  const budget: PipelineBudget = { calls: 0, max: MAX_MODEL_CALLS }
  const evidenceCheckpoint = causalNovelDAO.getCheckpoint(
    input.chapterId, input.contentVersionId, 'evidence_index', CAUSAL_OUTCOME_PROTOCOL_VERSION
  )
  let units: CausalBodyEvidenceUnit[]
  if (evidenceCheckpoint?.status === 'completed' && Array.isArray(evidenceCheckpoint.payload)) {
    units = evidenceCheckpoint.payload as CausalBodyEvidenceUnit[]
    input.onProgress?.('章后结果 1/8 · 已复用正文证据索引')
  } else {
    input.onProgress?.('章后结果 1/8 · 正在建立不可变正文证据索引')
    units = buildCausalBodyEvidenceUnits(input.content)
    if (!units.length) throw new CausalOutcomeProtocolError('OUTCOME_EVIDENCE_ID', '正文无法建立证据索引')
    causalNovelDAO.saveCheckpoint({
      workId: input.workId, chapterId: input.chapterId, contentVersionId: input.contentVersionId,
      bodyHash, protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
      stage: 'evidence_index', status: 'completed',
      payload: units
    })
  }
  if (causalEvidenceIndexHash(units) !== causalEvidenceIndexHash(buildCausalBodyEvidenceUnits(input.content))) {
    throw new CausalOutcomeProtocolError('OUTCOME_STALE_BODY', '正文证据索引与当前正文不一致')
  }
  const materializedCheckpoint = causalNovelDAO.getCheckpoint(
    input.chapterId, input.contentVersionId, 'outcome_materialized', CAUSAL_OUTCOME_PROTOCOL_VERSION
  )
  const materializedPayload = materializedCheckpoint?.payload as {
    stateRevision?: number; outcome?: CausalChapterOutcome; modelCalls?: number
  } | null
  if (
    materializedCheckpoint?.status === 'completed' &&
    materializedPayload?.stateRevision === input.state.revision &&
    materializedPayload.outcome
  ) {
    input.onProgress?.('章后结果 8/8 · 已复用当前正文与状态版本的完整校验结果')
    return {
      outcome: materializedPayload.outcome,
      bodyHash,
      modelCalls: materializedPayload.modelCalls ?? 0
    }
  }

  const common = {
    workId: input.workId, chapterId: input.chapterId, contentVersionId: input.contentVersionId,
    bodyHash, state: input.state, record: input.record, units, budget,
    signal: input.signal, onProgress: input.onProgress
  }
  const frozenPromises = new Set(input.record.plan.decision.advancedPromiseIds)
  input.onProgress?.('章后结果 2/8 · 提取核心事件与读者承诺')
  const core = await requestStage<CausalOutcomeCoreDraft>({
    ...common, stage: 'outcome_core', label: '核心事件提取', schema: coreSchema(input.state, units),
    instructions: [
      'summary 是已经发生事件的短摘要；eventSignature 使用简短稳定中文事件签名。',
      '至少推进冻结决策 advancedPromiseIds 中的一项。新承诺只输出问题，ID 由服务器分配。',
      '未达到终止条件时 matchedTerminalCondition、completionReason 为空字符串，terminalEvidenceIds 为空数组。'
    ],
    validate: value => {
      const draft = value as unknown as CausalOutcomeCoreDraft
      if (![...draft.advancedPromiseIds, ...draft.resolvedPromiseIds].some(id => frozenPromises.has(id))) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_PROMISE_PROGRESS', '核心事件没有推进冻结决策中的任何读者承诺', ['core.advancedPromiseIds']
        )
      }
      const resolved = new Set(draft.resolvedPromiseIds)
      if (draft.advancedPromiseIds.some(id => resolved.has(id))) {
        throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', '同一读者承诺不能同时标记为推进和关闭')
      }
      return draft
    }
  })

  input.onProgress?.('章后结果 3/8 · 提取人物状态操作')
  const actors = await requestStage<CausalOutcomeActorDraft>({
    ...common, stage: 'outcome_actors', label: '人物变化提取', schema: actorsSchema(input.state, units),
    instructions: [
      '只输出本章真正改变的人物字段；未改变的字段填空字符串或空数组。',
      '知识、目标和约束可以是受证据支持的简短事实概括，不要求复制原句。',
      '伤势、感染、疲劳和情绪不是资源，禁止放入 resourcesAdded/resourcesRemoved。'
    ],
    validate: value => {
      const draft = value as unknown as CausalOutcomeActorDraft
      const invalid = draft.actorUpdates.flatMap(item => [...item.resourcesAdded, ...item.resourcesRemoved])
        .find(item => /伤|血|感染|中毒|骨折|残疾|疼痛|昏迷|僵硬|咳血|症状/.test(item))
      if (invalid) {
        throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `人物阶段把伤势/身体状态误当作资源：${invalid}`)
      }
      const knownNames = new Set(input.state.actors.map(item => item.name))
      for (const item of draft.newActors) {
        if (knownNames.has(item.name)) {
          throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `新增人物与权威状态重复：${item.name}`)
        }
        knownNames.add(item.name)
      }
      return draft
    }
  })

  input.onProgress?.('章后结果 4/8 · 提取压力与阶段操作')
  const world = await requestStage<CausalOutcomeWorldDraft>({
    ...common, stage: 'outcome_world', label: '世界压力提取', schema: worldSchema(input.state, units),
    instructions: [
      '压力 direction 只能是 stable/escalated/relieved/resolved。escalated 时 urgency 不得低于原值，relieved 不得高于原值。',
      '新压力不输出 ID，由服务器分配。不能把未来推测当成当前压力。',
      'arcUpdates 只在正文已经满足阶段推进或完成条件时输出。'
    ],
    validate: value => {
      const draft = value as unknown as CausalOutcomeWorldDraft
      const pressureMap = new Map(input.state.activePressures.map(item => [item.id, item]))
      for (const update of draft.pressureUpdates) {
        const previous = pressureMap.get(update.id)
        if (!previous) throw new CausalOutcomeProtocolError('OUTCOME_REFERENCE', `压力不存在：${update.id}`)
        if (update.direction === 'escalated' && update.urgency < previous.urgency) {
          throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `压力 ${update.id} 声明升级但紧迫度下降`)
        }
        if (update.direction === 'relieved' && update.urgency > previous.urgency) {
          throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `压力 ${update.id} 声明缓解但紧迫度上升`)
        }
      }
      return draft
    }
  })

  input.onProgress?.('章后结果 5/8 · 提取已经挣得的情绪结果')
  const emotion = await requestStage<CausalOutcomeEmotionDraft>({
    ...common, stage: 'outcome_emotion', label: '情绪结果提取', schema: emotionSchema(units),
    instructions: [
      'readerEffectSummary 必须说明正文已经造成的读者情绪效果，不能为空。',
      'trigger/choice/cost/residue 分别绑定一组证据 ID；不得用未来预告替代已发生余波。',
      '没有开启或兑现情绪债时对应字段填空字符串。'
    ],
    validate: value => {
      const draft = value as unknown as CausalOutcomeEmotionDraft
      if (!draft.readerEffectSummary.trim()) {
        throw new CausalOutcomeProtocolError('OUTCOME_EMOTION', '本章缺少已经挣得的情绪结果摘要')
      }
      return draft
    }
  })

  const bundle: CausalOutcomeDraftBundle = { core, actors, world, emotion }
  input.onProgress?.('章后结果 6/8 · 服务器正在组装类型化状态操作')
  let outcome = materializeCausalOutcomeDraft({ state: input.state, units, draft: bundle })
  input.onProgress?.('章后结果 7/8 · 独立审计声明与证据的蕴含关系')
  await auditEntailment({ ...common, bundle })
  outcome = materializeCausalOutcomeDraft({ state: input.state, units, draft: bundle })
  causalNovelDAO.saveCheckpoint({
    workId: input.workId, chapterId: input.chapterId, contentVersionId: input.contentVersionId,
    bodyHash, protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
    stage: 'outcome_materialized', status: 'completed',
    payload: { stateRevision: input.state.revision, outcome, modelCalls: budget.calls }
  })
  input.onProgress?.(`章后结果 8/8 · 协议校验完成，共调用模型 ${budget.calls}/${budget.max} 次`)
  return { outcome, bodyHash, modelCalls: budget.calls }
}

export { causalOutcomeFailureCode }
