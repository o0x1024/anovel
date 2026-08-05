import { createHash } from 'node:crypto'
import { causalNovelDAO } from '../../db'
import { modelService } from '../../model'
import {
  CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX,
  CAUSAL_OUTCOME_PROTOCOL_VERSION,
  CausalOutcomeProtocolError,
  buildCausalBodyEvidenceUnits,
  causalOutcomeAuditBatches,
  causalEvidenceIndexHash,
  causalOutcomeFailureCode,
  causalOutcomeFailureIssues,
  isCausalPhysicalConditionValue,
  materializeCausalOutcomeDraft,
  validateCausalEvidenceIds,
  validateCausalStageEvidence,
  type CausalBodyEvidenceUnit,
  type CausalOutcomeActorDraft,
  type CausalOutcomeCoreDraft,
  type CausalOutcomeDraftBundle,
  type CausalOutcomeEmotionDraft,
  type CausalOutcomeWorldDraft
} from '../../../shared/causal-outcome-protocol'
import {
  CAUSAL_CORE_SEMANTIC_EVIDENCE_MAX,
  applyCausalCoreSemanticRepairs,
  atomicOutcomeArtifactHash,
  atomicOutcomeClaimEvidenceText,
  buildAtomicOutcomeClaims,
  materializeAtomicOutcomeClaims,
  type AtomicOutcomeClaim,
  type CausalCoreSemanticRepair
} from '../../../shared/causal-outcome-atomic'
import type {
  CausalChapterDecisionRecord,
  CausalChapterOutcome,
  CausalNarrativeState
} from '../../../shared/causal-novel-types'
import { requestStructuredModelOutput } from './structured-model-output'
import { withGoalLoopModelOptions } from './story-goal-model'
import {
  projectCausalOutcomeActorPromptState,
  projectCausalOutcomeState
} from './causal-outcome-context'
import { repairWorldStageAtomization } from './causal-outcome-world-atomization'
import { validateCausalOutcomeActorMutationReferences } from './causal-outcome-actor-references'

const NORMAL_STAGE_MODEL_CALLS = 4
const STAGE_EXTRACTION_ATTEMPTS = 2
const STAGE_REPAIR_ATTEMPTS = 2
const MAX_STAGE_MODEL_CALLS = NORMAL_STAGE_MODEL_CALLS * STAGE_EXTRACTION_ATTEMPTS
const MAX_CLAIM_REPAIR_ROUNDS = 4
const MAX_CLAIM_REPAIR_EVIDENCE_IDS = 2
const MAX_CORE_SEMANTIC_REPAIR_ROUNDS = 8
const MAX_CORE_SEMANTIC_ADDITIONAL_EVENTS = 8
const MAX_AUDIT_CALLS_PER_BATCH = 1 + MAX_CLAIM_REPAIR_ROUNDS * 2
const ACTOR_STAGE_MIN_OUTPUT_TOKENS = 4800
const ACTOR_STAGE_MAX_OUTPUT_TOKENS = 7200
const ACTOR_STAGE_TRUNCATION_RETRY_TOKENS = 1800

function evidenceArraySchema(
  _ids: string[],
  minItems = 1,
  _maxItems = CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX
): Record<string, unknown> {
  return {
    type: 'array',
    minItems,
    items: { type: 'string', pattern: '^e\\d{4}$' }
  }
}

function runtimeReferenceSchema(): Record<string, unknown> {
  // 运行时 ID 属于业务状态，不属于传输形状。合法集合由 materialize/validate 层校验。
  return { type: 'string', minLength: 1 }
}

function coreSchema(state: CausalNarrativeState, units: CausalBodyEvidenceUnit[]): Record<string, unknown> {
  const evidenceIds = units.map(unit => unit.id)
  const promiseIds = state.promises.filter(item => item.status !== 'resolved').map(item => item.id)
  const evidenceClaimProperties = {
    claim: { type: 'string', minLength: 1 },
    evidenceIds: evidenceArraySchema(
      evidenceIds,
      1,
      CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX
    )
  }
  const evidenceClaim = {
    type: 'object',
    additionalProperties: false,
    required: ['claim', 'evidenceIds'],
    properties: evidenceClaimProperties
  }
  const promiseClaim = {
    type: 'object',
    additionalProperties: false,
    required: ['promiseId', 'claim', 'evidenceIds'],
    properties: {
      promiseId: runtimeReferenceSchema(),
      ...evidenceClaimProperties
    }
  }
  return {
    type: 'object', additionalProperties: false,
    required: [
      'primaryEvent', 'supportingEvents', 'advancedPromises', 'resolvedPromises',
      'newPromises', 'terminal'
    ],
    properties: {
      primaryEvent: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'eventSignature', 'evidenceIds'],
        properties: {
          claim: { type: 'string', minLength: 1 },
          eventSignature: { type: 'string', minLength: 1 },
          evidenceIds: evidenceArraySchema(
            evidenceIds,
            1,
            CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX
          )
        }
      },
      supportingEvents: {
        type: 'array',
        maxItems: 12,
        items: evidenceClaim
      },
      advancedPromises: {
        type: 'array',
        maxItems: 6,
        items: promiseClaim
      },
      resolvedPromises: {
        type: 'array',
        maxItems: 6,
        items: promiseClaim
      },
      newPromises: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['question', 'claim', 'evidenceIds'],
          properties: {
            question: { type: 'string', minLength: 1 },
            ...evidenceClaimProperties
          }
        }
      },
      terminal: {
        type: 'object',
        additionalProperties: false,
        required: ['conditionMet', 'matchedCondition', 'completionReason', 'evidenceIds'],
        properties: {
          conditionMet: { type: 'boolean' },
          matchedCondition: { type: 'string' },
          completionReason: { type: 'string' },
          evidenceIds: evidenceArraySchema(
            evidenceIds,
            0,
            CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX
          )
        }
      }
    }
  }
}

function actorMutationSchema(
  actorNames: string[],
  evidenceIds: string[]
): Record<string, unknown> {
  const variant = (
    fields: string[],
    operations: string[]
  ): Record<string, unknown> => ({
    type: 'object',
    additionalProperties: false,
    required: ['actor', 'field', 'operation', 'value', 'evidenceIds'],
    properties: {
      actor: runtimeReferenceSchema(),
      field: { type: 'string', enum: fields },
      operation: { type: 'string', enum: operations },
      value: { type: 'string', minLength: 1 },
      evidenceIds: evidenceArraySchema(evidenceIds)
    }
  })
  return {
    oneOf: [
      variant(['currentGoal', 'constraint', 'location', 'physicalState'], ['set']),
      variant(['knowledge'], ['add']),
      variant(['resources', 'relationships', 'obligations'], ['add', 'remove'])
    ]
  }
}

function actorsSchema(state: CausalNarrativeState, units: CausalBodyEvidenceUnit[]): Record<string, unknown> {
  const actorNames = state.actors.map(actor => actor.name)
  const evidenceIds = units.map(unit => unit.id)
  const newActorFields = [
    'name', 'currentGoal', 'fear', 'knowledge', 'resources',
    'constraint', 'location', 'physicalState', 'relationships', 'obligations'
  ]
  return {
    type: 'object', additionalProperties: false, required: ['actorMutations', 'newActors'],
    properties: {
      actorMutations: {
        type: 'array',
        maxItems: 64,
        items: actorMutationSchema(actorNames, evidenceIds)
      },
      newActors: {
        type: 'array', maxItems: 4, items: {
          type: 'object', additionalProperties: false,
          required: ['key', 'facts'],
          properties: {
            key: { type: 'string', minLength: 1 },
            facts: {
              type: 'array', minItems: 1, maxItems: 36,
              items: {
                type: 'object', additionalProperties: false,
                required: ['field', 'value', 'evidenceIds'],
                properties: {
                  field: { type: 'string', enum: newActorFields },
                  value: { type: 'string', minLength: 1 },
                  evidenceIds: evidenceArraySchema(evidenceIds)
                }
              }
            }
          }
        }
      }
    }
  }
}

function worldSchema(state: CausalNarrativeState, units: CausalBodyEvidenceUnit[]): Record<string, unknown> {
  const evidenceIds = units.map(unit => unit.id)
  const pressureIds = state.activePressures.map(item => item.id)
  const pressureValueSchema = (valueSchema: Record<string, unknown>) => ({
    type: 'object', additionalProperties: false,
    required: ['id', 'value', 'evidenceIds'],
    properties: {
      id: runtimeReferenceSchema(),
      value: valueSchema,
      evidenceIds: evidenceArraySchema(evidenceIds)
    }
  })
  const evidenceValueSchema = {
    type: 'object', additionalProperties: false,
    required: ['claim', 'evidenceIds'],
    properties: {
      claim: { type: 'string', minLength: 1 },
      evidenceIds: evidenceArraySchema(evidenceIds)
    }
  }
  return {
    type: 'object', additionalProperties: false,
    required: [
      'pressureConditionUpdates', 'pressureStatusUpdates',
      'pressureUrgencyUpdates', 'newPressures', 'arcUpdates'
    ],
    properties: {
      pressureConditionUpdates: {
        type: 'array', maxItems: 64,
        items: pressureValueSchema({ type: 'string', minLength: 1 })
      },
      pressureStatusUpdates: {
        type: 'array', maxItems: 64,
        items: pressureValueSchema({
          type: 'string',
          enum: ['stable', 'escalated', 'relieved', 'resolved']
        })
      },
      pressureUrgencyUpdates: {
        type: 'array', maxItems: 64,
        items: pressureValueSchema({ type: 'integer', minimum: 1, maximum: 10 })
      },
      newPressures: {
        type: 'array', maxItems: 6, items: {
          type: 'object', additionalProperties: false,
          required: ['key', 'source', 'target', 'condition', 'escalation', 'urgency'],
          properties: {
            key: { type: 'string', minLength: 1 },
            source: evidenceValueSchema,
            target: evidenceValueSchema,
            condition: evidenceValueSchema,
            escalation: evidenceValueSchema,
            urgency: {
              type: 'object', additionalProperties: false,
              required: ['value', 'claim', 'evidenceIds'],
              properties: {
                value: { type: 'integer', minimum: 1, maximum: 10 },
                claim: { type: 'string', minLength: 1 },
                evidenceIds: evidenceArraySchema(evidenceIds)
              }
            }
          }
        }
      },
      arcUpdates: {
        type: 'array', maxItems: 4, items: {
          type: 'object', additionalProperties: false, required: ['id', 'status', 'claim', 'evidenceIds'],
          properties: {
            id: runtimeReferenceSchema(),
            status: { type: 'string', enum: ['active', 'completed'] },
            claim: { type: 'string', minLength: 1 },
            evidenceIds: evidenceArraySchema(evidenceIds)
          }
        }
      }
    }
  }
}

function emotionSchema(units: CausalBodyEvidenceUnit[]): Record<string, unknown> {
  const evidenceIds = units.map(unit => unit.id)
  const claimSchema = (minItems = 1) => ({
    type: 'object', additionalProperties: false,
    required: ['claim', 'evidenceIds'],
    properties: {
      claim: { type: 'string' },
      evidenceIds: evidenceArraySchema(evidenceIds, minItems)
    }
  })
  return {
    type: 'object', additionalProperties: false,
    required: [
      'readerEffect', 'trigger', 'choice', 'cost', 'residue', 'debtOpened', 'debtPaid'
    ],
    properties: {
      readerEffect: claimSchema(),
      trigger: claimSchema(),
      choice: claimSchema(),
      cost: claimSchema(),
      residue: claimSchema(),
      debtOpened: claimSchema(0),
      debtPaid: claimSchema(0)
    }
  }
}

interface PipelineBudget {
  calls: number
  max: number
  reservations: Set<string>
}

function reservePipelineCalls(
  budget: PipelineBudget,
  key: string,
  calls: number
): void {
  if (budget.reservations.has(key)) return
  budget.reservations.add(key)
  budget.max += calls
}

async function repairStageAtomization<T>(input: {
  workId: number
  chapterId: number
  stage: string
  label: string
  schema: Record<string, unknown>
  invalidValue: Record<string, unknown>
  error: unknown
  units: CausalBodyEvidenceUnit[]
  budget: PipelineBudget
  signal?: AbortSignal
  validate: (value: Record<string, unknown>) => T
  onProgress?: (message: string) => void
}): Promise<T> {
  const issues = causalOutcomeFailureIssues(input.error)
  if (
    !(input.error instanceof CausalOutcomeProtocolError) ||
    input.error.code !== 'OUTCOME_ATOMIZATION_REQUIRED' ||
    issues.length === 0
  ) {
    throw input.error
  }
  if (input.stage === 'outcome_world') {
    return repairWorldStageAtomization({ ...input, issues })
  }
  input.onProgress?.(
    `${input.label}：检测到 ${issues.length} 个证据聚合项，正在执行定向原子化修复`
  )
  reservePipelineCalls(
    input.budget,
    `${input.stage}:atomization`,
    STAGE_REPAIR_ATTEMPTS
  )
  const stageRules = input.stage === 'outcome_world'
    ? [
        'pressureConditionUpdates、pressureStatusUpdates、pressureUrgencyUpdates 中，同一数组内每个压力 ID 最多出现一次；原子化时收窄 value 与 evidenceIds，禁止复制同 ID 对象。',
        'newPressures 中每个 key 最多出现一次；source、target、condition、escalation、urgency 是固定字段，只能分别收窄声明与证据，禁止复制整项。'
      ]
    : input.stage === 'outcome_actors'
      ? [
          'currentGoal、constraint、location、physicalState 是人物标量字段，同一人物同一标量字段最多一项；原子化时收窄 value 与 evidenceIds，禁止复制该操作。'
        ]
      : []
  return requestStructuredModelOutput<T>({
    workId: input.workId,
    label: `${input.label}原子化修复`,
    attempts: STAGE_REPAIR_ATTEMPTS,
    signal: input.signal,
    schema: input.schema,
    request: async (attempt, lastError) => {
      input.budget.calls++
      if (input.budget.calls > input.budget.max) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_BUDGET',
          `章后结果模型调用超过 ${input.budget.max} 次预算`
        )
      }
      input.onProgress?.(
        `${input.label}：原子化修复 ${attempt}/2，模型调用 ${input.budget.calls}/${input.budget.max}`
      )
      return modelService.chat(
        withGoalLoopModelOptions(input.workId, {
          workId: input.workId,
          chapterId: input.chapterId,
          step: `goal_novel_causal_outcome_${input.stage}_atomize`,
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          temperature: 0,
          maxTokens: 2600,
          forceThinkingDisabled: true,
          responseSchema: {
            name: `causal_outcome_${input.stage}_atomized`,
            schema: input.schema,
            strict: true
          },
          structuredOutputMode: 'prompt_json',
          systemPrompt: [
            '你是因果小说章后结果的原子化修复器，只修复给定 JSON 中证据绑定超过上限的声明。',
            `每条声明只能绑定 1-${CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX} 个最直接的正文证据 ID。`,
            '若一个声明混合多个独立事实，只有业务允许同一实体出现多项的数组才可拆分；要求实体唯一的字段必须收窄为章末单一事实，禁止复制实体 ID 或 key。',
            'primaryEvent、terminal 和固定情绪字段不能复制；必须收窄为一个原子结论并只保留最直接证据。primaryEvent 中被移出的独立事件放入 supportingEvents。',
            '拆分后仍必须遵守 JSON Schema 的 maxItems；达到数组上限时优先保留影响后续因果的事实，其余声明收窄而不是继续扩张数组。',
            ...stageRules,
            '不得截断整份结果、删除必需操作、改变已引用的实体 ID 或承诺 ID，不得添加正文没有支持的事实。',
            '除原子化所需的 claim、evidenceIds 和同级对象拆分外，保持其他字段语义不变。只返回符合原 JSON Schema 的完整对象。'
          ].join('\n'),
          prompt: [
            `【超限路径】\n${JSON.stringify(issues, null, 2)}`,
            `【待修复 JSON】\n${JSON.stringify(input.invalidValue, null, 2)}`,
            `【正文证据索引】\n${evidenceCatalog(input.units)}`,
            attempt > 1 ? `【上次修复错误】\n${lastError}` : ''
          ].filter(Boolean).join('\n\n')
        }),
        { stream: false, signal: input.signal }
      )
    },
    validate: value => {
      const repaired = input.validate(value)
      validateCausalStageEvidence(repaired, input.units)
      return repaired
    }
  })
}

async function repairStageEvidenceIds<T>(input: {
  workId: number
  chapterId: number
  stage: string
  label: string
  invalidValue: Record<string, unknown>
  error: unknown
  units: CausalBodyEvidenceUnit[]
  budget: PipelineBudget
  signal?: AbortSignal
  validate: (value: Record<string, unknown>) => T
  onProgress?: (message: string) => void
}): Promise<T> {
  if (!(input.error instanceof CausalOutcomeProtocolError) || input.error.code !== 'OUTCOME_EVIDENCE_ID') {
    throw input.error
  }
  const paths = [...new Set(input.error.paths)]
  if (paths.length === 0) throw input.error
  const repairSchema: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['repairs'],
    properties: {
      repairs: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'evidenceIds'],
          properties: {
            path: runtimeReferenceSchema(),
            evidenceIds: evidenceArraySchema(
              input.units.map(unit => unit.id),
              1,
              CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX
            )
          }
        }
      }
    }
  }
  const brokenBindings = paths.map(path => ({
    path,
    claim: getPath(input.invalidValue, path.replace(/\.evidenceIds$/, '.claim')),
    currentEvidenceIds: getPath(input.invalidValue, path)
  }))
  input.onProgress?.(`${input.label}：正在定点修复 ${paths.length} 个无效证据绑定`)
  reservePipelineCalls(
    input.budget,
    `${input.stage}:evidence_rebind`,
    STAGE_REPAIR_ATTEMPTS
  )
  return requestStructuredModelOutput<T>({
    workId: input.workId,
    label: `${input.label}证据重绑`,
    attempts: STAGE_REPAIR_ATTEMPTS,
    signal: input.signal,
    schema: repairSchema,
    request: async (attempt, lastError) => {
      input.budget.calls++
      if (input.budget.calls > input.budget.max) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_BUDGET',
          `章后结果模型调用超过 ${input.budget.max} 次预算`
        )
      }
      input.onProgress?.(
        `${input.label}：证据重绑 ${attempt}/2，模型调用 ${input.budget.calls}/${input.budget.max}`
      )
      return modelService.chat(
        withGoalLoopModelOptions(input.workId, {
          workId: input.workId,
          chapterId: input.chapterId,
          step: `goal_novel_causal_outcome_${input.stage}_evidence_rebind`,
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          temperature: 0,
          maxTokens: 1200,
          forceThinkingDisabled: true,
          responseSchema: {
            name: `causal_outcome_${input.stage}_evidence_rebind`,
            schema: repairSchema,
            strict: true
          },
          structuredOutputMode: 'prompt_json',
          systemPrompt: [
            '你是因果小说章后事实的证据重绑器。声明文本已经冻结，只能为列出的错误路径重新选择正文证据 ID。',
            `每个路径必须返回 1-${CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX} 个目录中真实存在、可直接推出该声明的 ID。`,
            '禁止猜测相邻编号、禁止改写或补充声明、禁止返回未列出的路径。只返回修复清单 JSON。'
          ].join('\n'),
          prompt: [
            `【错误证据绑定】\n${JSON.stringify(brokenBindings, null, 2)}`,
            `【正文证据索引】\n${evidenceCatalog(input.units)}`,
            attempt > 1 ? `【上次重绑错误】\n${lastError}` : ''
          ].filter(Boolean).join('\n\n')
        }),
        { stream: false, signal: input.signal }
      )
    },
    validate: value => {
      const repairs = Array.isArray(value.repairs)
        ? value.repairs as Array<{ path: string; evidenceIds: string[] }>
        : []
      const returnedPaths = repairs.map(item => item.path)
      if (
        new Set(returnedPaths).size !== paths.length ||
        paths.some(path => !returnedPaths.includes(path))
      ) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_EVIDENCE_ID',
          '证据重绑必须且只能覆盖全部报错路径',
          paths
        )
      }
      const candidate = structuredClone(input.invalidValue)
      for (const repair of repairs) {
        const evidenceIds = validateCausalEvidenceIds(
          input.units,
          repair.evidenceIds,
          repair.path,
          { min: 1, max: CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX }
        )
        setPath(candidate, repair.path, evidenceIds)
      }
      const validated = input.validate(candidate)
      validateCausalStageEvidence(validated, input.units)
      return validated
    }
  })
}

function evidenceCatalog(units: CausalBodyEvidenceUnit[]): string {
  return units.map(unit => `${unit.id} [段${unit.paragraph}] ${unit.text}`).join('\n')
}

function actorStageOutputTokens(input: {
  actorCount: number
  evidenceCount: number
  lastError: string
}): number {
  const chapterScale = 2400
    + Math.min(8, input.actorCount) * 360
    + Math.min(100, input.evidenceCount) * 36
  const firstAttempt = Math.min(
    ACTOR_STAGE_MAX_OUTPUT_TOKENS,
    Math.max(ACTOR_STAGE_MIN_OUTPUT_TOKENS, chapterScale)
  )
  return input.lastError.includes('OUTPUT_TRUNCATED')
    ? firstAttempt + ACTOR_STAGE_TRUNCATION_RETRY_TOKENS
    : firstAttempt
}

function stageStateProjection(
  stage: string,
  state: CausalNarrativeState,
  knownActorNames: string[]
): Record<string, unknown> {
  if (stage === 'outcome_core') {
    return {
      revision: state.revision,
      centralQuestion: state.centralQuestion,
      terminalConditions: state.terminalConditions,
      promises: state.promises,
      macroArcs: state.macroArcs,
      completionStatus: state.completionStatus,
      recentEventSignatures: state.recentEventSignatures
    }
  }
  if (stage === 'outcome_actors') {
    return {
      revision: state.revision,
      immutableRules: state.immutableRules,
      knownActorNames,
      actors: projectCausalOutcomeActorPromptState(state)
    }
  }
  if (stage === 'outcome_world') {
    return {
      revision: state.revision,
      immutableRules: state.immutableRules,
      activePressures: state.activePressures,
      macroArcs: state.macroArcs
    }
  }
  return { revision: state.revision, centralQuestion: state.centralQuestion }
}

function stageDecisionProjection(
  stage: string,
  record: CausalChapterDecisionRecord
): Record<string, unknown> {
  const decision = record.plan.decision
  if (stage === 'outcome_core') {
    return {
      initiator: decision.initiator,
      chosenAction: decision.chosenAction,
      opposition: decision.opposition,
      cost: decision.cost,
      endingState: decision.endingState,
      advancedPromiseIds: decision.advancedPromiseIds,
      newQuestion: decision.newQuestion
    }
  }
  if (stage === 'outcome_actors') {
    return {
      characters: decision.characters,
      openingState: decision.openingState,
      chosenAction: decision.chosenAction,
      cost: decision.cost,
      endingState: decision.endingState
    }
  }
  if (stage === 'outcome_world') {
    return {
      chosenAction: decision.chosenAction,
      opposition: decision.opposition,
      cost: decision.cost,
      endingState: decision.endingState
    }
  }
  return {
    chosenAction: decision.chosenAction,
    cost: decision.cost,
    endingState: decision.endingState
  }
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

async function requestStage<T>(input: {
  workId: number
  chapterId: number
  contentVersionId: number
  bodyHash: string
  stage: string
  label: string
  schema: Record<string, unknown>
  state: CausalNarrativeState
  promptState: CausalNarrativeState
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
    validateCausalStageEvidence(validated, input.units)
    input.onProgress?.(`${input.label}：复用正文版本检查点`)
    return validated
  }
  const catalog = evidenceCatalog(input.units)
  const stateProjection = stageStateProjection(
    input.stage,
    input.promptState,
    input.state.actors.map(actor => actor.name)
  )
  const decisionProjection = stageDecisionProjection(input.stage, input.record)
  const request = async (attempt: number, lastError: string) => {
    input.budget.calls++
    if (input.budget.calls > input.budget.max) {
      throw new CausalOutcomeProtocolError('OUTCOME_BUDGET', `章后结果模型调用超过 ${input.budget.max} 次预算`)
    }
    input.onProgress?.(`${input.label}：模型调用 ${input.budget.calls}/${input.budget.max}`)
    const maxTokens = input.stage === 'outcome_actors'
      ? actorStageOutputTokens({
          actorCount: input.promptState.actors.length,
          evidenceCount: input.units.length,
          lastError
        })
      : 2600
    return modelService.chat(
      withGoalLoopModelOptions(input.workId, {
        workId: input.workId,
        chapterId: input.chapterId,
        step: `goal_novel_causal_outcome_${input.stage}`,
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        maxTokens,
        forceThinkingDisabled: true,
        responseSchema: { name: `causal_outcome_${input.stage}`, schema: input.schema, strict: true },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是因果小说章后事实协议的单阶段提取器。只处理本阶段，不写正文、不修改其他阶段。',
          '证据只能填写给定 evidence ID；多个不连续证据必须使用多个 ID，禁止复制或拼接原文。',
          `每条原子结论的 evidenceIds 必须选择 1-${CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX} 个最直接的正文证据 ID；不得把多个事件合并后共用证据数组；终止条件未满足时 terminal.evidenceIds 必须为空数组。`,
          '没有正文支持的变化必须省略或填空数组；不得把计划当成已发生事实。',
          ...input.instructions,
          '只返回符合 JSON Schema 的完整对象。'
        ].join('\n'),
        prompt: [
          `【本阶段权威状态投影】\n${JSON.stringify(stateProjection, null, 2)}`,
          `【本阶段冻结决策】\n${JSON.stringify(decisionProjection, null, 2)}`,
          input.stage === 'outcome_emotion'
            ? `【冻结情绪事务】\n${JSON.stringify(input.record.plan.emotionContract, null, 2)}`
            : '',
          `【正文证据索引】\n${catalog}`,
          attempt > 1 ? `【上次结构错误】\n${lastError}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal: input.signal }
    )
  }
  try {
    const result = await requestStructuredModelOutput<T>({
      workId: input.workId,
      label: input.label,
      attempts: STAGE_EXTRACTION_ATTEMPTS,
      signal: input.signal,
      schema: input.schema,
      request,
      repairValidationError: ({ value, error }) => {
        const commonRepair = {
          workId: input.workId,
          chapterId: input.chapterId,
          stage: input.stage,
          label: input.label,
          invalidValue: value,
          error,
          units: input.units,
          budget: input.budget,
          signal: input.signal,
          validate: input.validate,
          onProgress: input.onProgress
        }
        return error instanceof CausalOutcomeProtocolError && error.code === 'OUTCOME_EVIDENCE_ID'
          ? repairStageEvidenceIds<T>(commonRepair)
          : repairStageAtomization<T>({ ...commonRepair, schema: input.schema })
      },
      shouldRepairValidationError: error => (
        error instanceof CausalOutcomeProtocolError
        && (error.code === 'OUTCOME_ATOMIZATION_REQUIRED' || error.code === 'OUTCOME_EVIDENCE_ID')
      ),
      shouldRetryError: error => !(
        error instanceof CausalOutcomeProtocolError &&
        error.code === 'OUTCOME_ATOMIZATION_REQUIRED'
      ),
      validate: value => {
        const validated = input.validate(value)
        validateCausalStageEvidence(validated, input.units)
        return validated
      }
    })
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

function auditSchema(): Record<string, unknown> {
  return {
    type: 'object', additionalProperties: false, required: ['results'],
    properties: {
      results: {
        type: 'array',
        minItems: 1,
        maxItems: 64,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claimId', 'supported', 'reason'],
          properties: {
            claimId: runtimeReferenceSchema(),
            supported: { type: 'boolean' },
            reason: { type: 'string', minLength: 1 }
          }
        }
      }
    }
  }
}

interface ClaimRepair {
  claimId: string
  replacement: string
  evidenceIds: string[]
}

interface CoreSemanticRepairArtifact {
  stateRevision: number
  inputHash: string
  repairRound: number
  failedClaims: AtomicOutcomeClaim[]
  auditReasons: string[]
  repairs: CausalCoreSemanticRepair[]
  candidate: CausalOutcomeCoreDraft
  passed?: boolean
}

function dropUnsupportedOptionalMutations(
  bundle: CausalOutcomeDraftBundle,
  failures: AtomicOutcomeClaim[]
): number {
  const resolvedPromiseIds = new Set(
    failures
      .filter(item => item.kind === 'promise_resolve' && !item.required)
      .map(item => item.subject)
  )
  const pressureStatusIds = new Set(
    failures
      .filter(item => item.kind === 'pressure_state' && !item.required && item.subject.endsWith(':status'))
      .map(item => item.subject.slice(0, -':status'.length))
  )
  const pressureUrgencyIds = new Set(
    failures
      .filter(item => item.kind === 'pressure_state' && !item.required && item.subject.endsWith(':urgency'))
      .map(item => item.subject.slice(0, -':urgency'.length))
  )
  const before = bundle.core.resolvedPromises.length
    + bundle.world.pressureStatusUpdates.length
    + bundle.world.pressureUrgencyUpdates.length
  bundle.core.resolvedPromises = bundle.core.resolvedPromises.filter(
    item => !resolvedPromiseIds.has(item.promiseId)
  )
  bundle.world.pressureStatusUpdates = bundle.world.pressureStatusUpdates.filter(
    item => !pressureStatusIds.has(item.id)
  )
  bundle.world.pressureUrgencyUpdates = bundle.world.pressureUrgencyUpdates.filter(
    item => !pressureUrgencyIds.has(item.id)
  )
  return before - (
    bundle.core.resolvedPromises.length
    + bundle.world.pressureStatusUpdates.length
    + bundle.world.pressureUrgencyUpdates.length
  )
}

function coreSemanticRepairSchema(
  _claims: AtomicOutcomeClaim[],
  evidenceIds: string[]
): Record<string, unknown> {
  const eventProperties = {
    claim: { type: 'string', minLength: 1 },
    evidenceIds: evidenceArraySchema(
      evidenceIds,
      1,
      CAUSAL_CORE_SEMANTIC_EVIDENCE_MAX
    )
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['repairs'],
    properties: {
      repairs: {
        type: 'array',
        minItems: 1,
        maxItems: 32,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['claimId', 'replacement', 'additionalEvents'],
          properties: {
            claimId: runtimeReferenceSchema(),
            replacement: {
              type: 'object',
              additionalProperties: false,
              required: ['claim', 'eventSignature', 'evidenceIds'],
              properties: {
                ...eventProperties,
                eventSignature: { type: 'string' }
              }
            },
            additionalEvents: {
              type: 'array',
              maxItems: MAX_CORE_SEMANTIC_ADDITIONAL_EVENTS,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['claim', 'evidenceIds'],
                properties: eventProperties
              }
            }
          }
        }
      }
    }
  }
}

async function repairCompoundCoreClaims(input: {
  workId: number
  chapterId: number
  contentVersionId: number
  bodyHash: string
  stateRevision: number
  core: CausalOutcomeCoreDraft
  failedClaims: AtomicOutcomeClaim[]
  auditReasons: string[]
  units: CausalBodyEvidenceUnit[]
  budget: PipelineBudget
  repairRound: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
}): Promise<{
  candidate: CausalOutcomeCoreDraft
  stage: string
  artifact: CoreSemanticRepairArtifact
}> {
  const stage = `outcome_core_semantic_${String(input.repairRound).padStart(2, '0')}`
  const inputHash = atomicOutcomeArtifactHash(input.failedClaims)
  const cached = causalNovelDAO.getCheckpoint(
    input.chapterId,
    input.contentVersionId,
    stage,
    CAUSAL_OUTCOME_PROTOCOL_VERSION
  )
  const cachedArtifact = cached?.payload as CoreSemanticRepairArtifact | null
  if (
    cachedArtifact?.stateRevision === input.stateRevision &&
    cachedArtifact.inputHash === inputHash &&
    cachedArtifact.candidate
  ) {
    const candidate = applyCausalCoreSemanticRepairs({
      core: input.core,
      claims: input.failedClaims,
      repairs: cachedArtifact.repairs,
      units: input.units
    })
    input.onProgress?.(`章后结果 · 已恢复核心事件结构修复制品 ${input.repairRound}`)
    return { candidate, stage, artifact: { ...cachedArtifact, candidate } }
  }

  const repairSchema = coreSemanticRepairSchema(
    input.failedClaims,
    input.units.map(unit => unit.id)
  )
  const result = await requestStructuredModelOutput<{
    repairs: CausalCoreSemanticRepair[]
    candidate: CausalOutcomeCoreDraft
  }>({
    workId: input.workId,
    label: '核心事件语义原子化修复',
    attempts: 2,
    signal: input.signal,
    schema: repairSchema,
    request: (attempt, lastError) => {
      input.budget.calls++
      if (input.budget.calls > input.budget.max) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_BUDGET',
          `章后结果模型调用超过 ${input.budget.max} 次预算`
        )
      }
      input.onProgress?.(
        `章后结果 · 核心事件语义拆分 ${input.repairRound}/${MAX_CORE_SEMANTIC_REPAIR_ROUNDS}`
        + `，协议尝试 ${attempt}/2，模型调用 ${input.budget.calls}/${input.budget.max}`
      )
      return modelService.chat(
        withGoalLoopModelOptions(input.workId, {
          workId: input.workId,
          chapterId: input.chapterId,
          step: 'goal_novel_causal_outcome_core_semantic_atomize',
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          temperature: 0,
          maxTokens: 2200,
          forceThinkingDisabled: true,
          responseSchema: {
            name: 'causal_outcome_core_semantic_atomize',
            schema: repairSchema,
            strict: true
          },
          structuredOutputMode: 'prompt_json',
          systemPrompt: [
            '你是因果小说核心事件的证据优先结构修复器。',
            '当前失败不是正文缺失，而是一条 claim 混合了多个独立事实，无法由自身绑定证据直接推出。',
            `replacement 和 additionalEvents 每条只能绑定 1-${CAUSAL_CORE_SEMANTIC_EVIDENCE_MAX} 个最直接证据 ID。`,
            '先选择证据，再写该证据能够逐字直接推出的窄事件；不得把只出现在其他证据中的年份、身份、签名、因果或结论写进当前事件。',
            '若原声明包含多个事实，replacement 只保留一个主事实，其余事实拆入 additionalEvents；不得用换词方式保留复合声明。',
            '修复 primaryEvent 时 replacement.eventSignature 写简短稳定事件签名；修复 supportingEvent 时必须为空字符串。',
            '每个 claimId 必须恰好返回一次。只返回符合 Schema 的 JSON。'
          ].join('\n'),
          prompt: [
            `【失败核心声明】\n${JSON.stringify(input.failedClaims, null, 2)}`,
            `【审计意见】\n${input.auditReasons.join('；')}`,
            `【当前核心事件结构】\n${JSON.stringify({
              primaryEvent: input.core.primaryEvent,
              supportingEvents: input.core.supportingEvents
            }, null, 2)}`,
            `【正文证据索引】\n${evidenceCatalog(input.units)}`,
            attempt > 1 ? `【上次协议错误】\n${lastError}` : ''
          ].filter(Boolean).join('\n\n')
        }),
        { stream: false, signal: input.signal }
      )
    },
    validate: value => {
      const repairs = Array.isArray(value.repairs)
        ? value.repairs as unknown as CausalCoreSemanticRepair[]
        : []
      const candidate = applyCausalCoreSemanticRepairs({
        core: input.core,
        claims: input.failedClaims,
        repairs,
        units: input.units
      })
      validateCausalStageEvidence(candidate, input.units)
      return { repairs, candidate }
    }
  })
  const artifact: CoreSemanticRepairArtifact = {
    stateRevision: input.stateRevision,
    inputHash,
    repairRound: input.repairRound,
    failedClaims: input.failedClaims,
    auditReasons: input.auditReasons,
    repairs: result.repairs,
    candidate: result.candidate
  }
  causalNovelDAO.saveCheckpoint({
    workId: input.workId,
    chapterId: input.chapterId,
    contentVersionId: input.contentVersionId,
    bodyHash: input.bodyHash,
    protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
    stage,
    status: 'failed',
    payload: artifact,
    errorMessage: input.auditReasons.join('；')
  })
  return { candidate: result.candidate, stage, artifact }
}

async function auditAtomicClaims(input: {
  workId: number; chapterId: number; contentVersionId: number; bodyHash: string
  bundle: CausalOutcomeDraftBundle; state: CausalNarrativeState
  record: CausalChapterDecisionRecord
  units: CausalBodyEvidenceUnit[]; budget: PipelineBudget
  signal?: AbortSignal; onProgress?: (message: string) => void
}, semanticRepairRound = 0, budgetPrepared = false): Promise<AtomicOutcomeClaim[]> {
  const claims = buildAtomicOutcomeClaims({
    bundle: input.bundle,
    state: input.state,
    record: input.record
  })
  if (!claims.length) return []
  const unitMap = new Map(input.units.map(unit => [unit.id, unit.text]))
  for (const claim of claims) {
    validateCausalEvidenceIds(
      input.units,
      claim.evidenceIds,
      `${claim.id}.evidenceIds`,
      { min: 1, max: CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX }
    )
  }
  const claimBatches = causalOutcomeAuditBatches(claims)
  if (!budgetPrepared) {
    input.budget.max += claimBatches.length * MAX_AUDIT_CALLS_PER_BATCH
      + MAX_CORE_SEMANTIC_REPAIR_ROUNDS * 2
  }
  const auditOnce = async (currentClaims: AtomicOutcomeClaim[]) => {
    const schema = auditSchema()
    return requestStructuredModelOutput<{
      passed: boolean
      failedClaimIds: string[]
      reasons: string[]
    }>({
      workId: input.workId, label: '因果结果证据蕴含审计', attempts: 2, signal: input.signal,
      schema,
      request: (attempt, lastError) => {
        input.budget.calls++
        if (input.budget.calls > input.budget.max) {
          throw new CausalOutcomeProtocolError('OUTCOME_BUDGET', `章后结果模型调用超过 ${input.budget.max} 次预算`)
        }
        input.onProgress?.(
          `章后结果 · 证据蕴含审计 ${currentClaims.length} 条，协议尝试 ${attempt}/2：`
          + `模型调用 ${input.budget.calls}/${input.budget.max}`
        )
        return modelService.chat(
          withGoalLoopModelOptions(input.workId, {
            workId: input.workId, chapterId: input.chapterId,
            step: 'goal_novel_causal_outcome_entailment', enrichWorkContext: false, enrichNarrativeMemory: false,
            temperature: 0, maxTokens: 1600, forceThinkingDisabled: true,
            responseSchema: { name: 'causal_outcome_entailment', schema, strict: true },
            structuredOutputMode: 'prompt_json',
            systemPrompt: [
              '你是因果状态声明的独立证据审计器。逐条判断声明是否能由绑定的正文证据直接推出。',
              '必须为每个 claimId 独立返回 supported 与 reason；一条失败不得影响其他声明。',
              '概括可以比原文短，但不得加入证据没有表达的目标、因果、资源归属、确定性或未来推测。',
              'kind、subject、claimPath 是状态操作上下文，不是正文必须逐字出现的事实；只审计 evidenceClaim。',
              '不得因为正文没有出现“本章推进读者承诺”“本章新打开悬念”等系统操作标签而判失败。',
              '证据仅出现相关词语但不能推出声明时必须判失败。只返回 JSON。'
            ].join('\n'),
            prompt: [
              JSON.stringify(currentClaims.map(claim => ({
                id: claim.id,
                kind: claim.kind,
                subject: claim.subject,
                claimPath: claim.claimPath,
                evidenceClaim: atomicOutcomeClaimEvidenceText(claim),
                evidence: claim.evidenceIds.map(id => ({ id, text: unitMap.get(id) ?? '' }))
              }))),
              attempt > 1 ? `【上次协议错误】${lastError}` : ''
            ].filter(Boolean).join('\n\n')
          }),
          { stream: false, signal: input.signal }
        )
      },
      validate: value => {
        const results = Array.isArray(value.results)
          ? value.results as Array<{ claimId: string; supported: boolean; reason: string }>
          : []
        const allowedIds = new Set(currentClaims.map(item => item.id))
        const returnedIds = results.map(item => String(item.claimId))
        if (
          returnedIds.length !== currentClaims.length
          || new Set(returnedIds).size !== returnedIds.length
          || returnedIds.some(id => !allowedIds.has(id))
          || currentClaims.some(claim => !returnedIds.includes(claim.id))
        ) {
          throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', '证据审计必须恰好返回当前批次的每个 claimId')
        }
        const failures = results.filter(item => item.supported !== true)
        return {
          passed: failures.length === 0,
          failedClaimIds: failures.map(item => item.claimId),
          reasons: failures.map(item => `${item.claimId}：${item.reason}`)
        }
      }
    })
  }

  const validatedClaims: AtomicOutcomeClaim[] = []
  for (let batchIndex = 0; batchIndex < claimBatches.length; batchIndex++) {
    const batch = claimBatches[batchIndex]
    const claimIds = batch.map(item => item.id)
    const inputHash = atomicOutcomeArtifactHash(batch)
    const checkpointStage = `outcome_audit_${String(batchIndex + 1).padStart(2, '0')}`
    const cached = causalNovelDAO.getCheckpoint(
      input.chapterId, input.contentVersionId, checkpointStage, CAUSAL_OUTCOME_PROTOCOL_VERSION
    )
    const cachedPayload = cached?.payload as {
      stateRevision?: number
      inputHash?: string
      claims?: AtomicOutcomeClaim[]
    } | null
    if (
      cached?.status === 'completed' &&
      cachedPayload?.stateRevision === input.state.revision &&
      cachedPayload.inputHash === inputHash &&
      Array.isArray(cachedPayload.claims)
    ) {
      const cachedIds = cachedPayload.claims.map(claim => claim.id)
      if (
        cachedIds.length !== claimIds.length ||
        new Set(cachedIds).size !== claimIds.length ||
        claimIds.some(id => !cachedIds.includes(id))
      ) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_SCHEMA',
          `${checkpointStage} 的原子声明集合与当前输入不一致`
        )
      }
      for (const claim of cachedPayload.claims) {
        validateCausalEvidenceIds(
          input.units,
          claim.evidenceIds,
          `${claim.id}.evidenceIds`,
          { min: 1, max: CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX }
        )
      }
      validatedClaims.push(...cachedPayload.claims)
      input.onProgress?.(`章后结果 · 已复用证据审计批次 ${batchIndex + 1}/${claimBatches.length}`)
      continue
    }

    input.onProgress?.(
      `章后结果 · 正在审计声明批次 ${batchIndex + 1}/${claimBatches.length}（${claimIds.length} 条）`
    )
    const first = await auditOnce(batch)
    if (first.passed && first.failedClaimIds.length === 0) {
      causalNovelDAO.saveCheckpoint({
        workId: input.workId, chapterId: input.chapterId, contentVersionId: input.contentVersionId,
        bodyHash: input.bodyHash, protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
        stage: checkpointStage, status: 'completed',
        payload: { stateRevision: input.state.revision, inputHash, claims: batch }
      })
      validatedClaims.push(...batch)
      continue
    }
    if (!batch.some(item => first.failedClaimIds.includes(item.id))) {
      throw new CausalOutcomeProtocolError(
        'OUTCOME_ENTAILMENT', `证据蕴含审计未通过：${first.reasons.join('；')}`
      )
    }
    const failedCoreClaims = batch.filter(item => (
      first.failedClaimIds.includes(item.id) &&
      item.kind === 'core_summary' &&
      item.repairable
    ))
    if (failedCoreClaims.length > 0) {
      if (semanticRepairRound >= MAX_CORE_SEMANTIC_REPAIR_ROUNDS) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_ENTAILMENT',
          `核心事件经 ${MAX_CORE_SEMANTIC_REPAIR_ROUNDS} 轮证据结构修复后仍未通过：${first.reasons.join('；')}`,
          first.failedClaimIds
        )
      }
      const structuralRepair = await repairCompoundCoreClaims({
        workId: input.workId,
        chapterId: input.chapterId,
        contentVersionId: input.contentVersionId,
        bodyHash: input.bodyHash,
        stateRevision: input.state.revision,
        core: input.bundle.core,
        failedClaims: failedCoreClaims,
        auditReasons: first.reasons,
        units: input.units,
        budget: input.budget,
        repairRound: semanticRepairRound + 1,
        signal: input.signal,
        onProgress: input.onProgress
      })
      input.bundle.core = structuralRepair.candidate
      const validated = await auditAtomicClaims(
        input,
        semanticRepairRound + 1,
        true
      )
      causalNovelDAO.saveCheckpoint({
        workId: input.workId,
        chapterId: input.chapterId,
        contentVersionId: input.contentVersionId,
        bodyHash: input.bodyHash,
        protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
        stage: structuralRepair.stage,
        status: 'completed',
        payload: { ...structuralRepair.artifact, passed: true }
      })
      return validated
    }
    let currentBatch = batch
    let currentAudit = first
    let repairedBatch: AtomicOutcomeClaim[] | undefined
    for (let repairRound = 1; repairRound <= MAX_CLAIM_REPAIR_ROUNDS; repairRound++) {
      const failed = currentBatch.filter(item => currentAudit.failedClaimIds.includes(item.id))
      const immutableFailures = failed.filter(item => !item.repairable)
      if (immutableFailures.length) {
        const requiredFailures = immutableFailures.filter(item => item.required)
        const optionalFailures = immutableFailures.filter(item => !item.required)
        if (requiredFailures.length === 0) {
          const dropped = dropUnsupportedOptionalMutations(input.bundle, optionalFailures)
          if (dropped !== optionalFailures.length) {
            throw new CausalOutcomeProtocolError(
              'OUTCOME_SCHEMA',
              '可选状态变化无法从正文取证，但协议没有可删除的对应操作',
              optionalFailures.map(item => item.id)
            )
          }
          input.onProgress?.(`章后结果 · 已删除 ${dropped} 条正文不支持的可选状态推断`)
          return auditAtomicClaims(input, semanticRepairRound, true)
        }
        causalNovelDAO.saveCheckpoint({
          workId: input.workId,
          chapterId: input.chapterId,
          contentVersionId: input.contentVersionId,
          bodyHash: input.bodyHash,
          protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
          stage: 'outcome_body_contract',
          status: 'failed',
          payload: {
            stateRevision: input.state.revision,
            inputHash: atomicOutcomeArtifactHash(requiredFailures),
            claims: requiredFailures
          },
          errorMessage: `正文没有支持必要状态变更：${requiredFailures.map(item => item.claim).join('；')}`
        })
        throw new CausalOutcomeProtocolError(
          'OUTCOME_BODY_CONTRACT',
          `正文没有支持必要状态变更：${requiredFailures.map(item => item.claim).join('；')}`,
          requiredFailures.map(item => item.id)
        )
      }
      input.onProgress?.(
        `章后结果 · 定点修复批次 ${batchIndex + 1}/${claimBatches.length}`
        + ` 第 ${repairRound}/${MAX_CLAIM_REPAIR_ROUNDS} 轮的 ${failed.length} 个声明`
      )
      const repairSchema = {
        type: 'object', additionalProperties: false, required: ['repairs'],
        properties: {
          repairs: {
            type: 'array', minItems: 1, maxItems: 32,
            items: {
              type: 'object', additionalProperties: false,
              required: ['claimId', 'replacement', 'evidenceIds'],
              properties: {
                claimId: runtimeReferenceSchema(),
                replacement: { type: 'string', minLength: 1 },
                evidenceIds: evidenceArraySchema(
                  input.units.map(unit => unit.id),
                  1,
                  MAX_CLAIM_REPAIR_EVIDENCE_IDS
                )
              }
            }
          }
        }
      }
      const repaired = await requestStructuredModelOutput<{ repairs: ClaimRepair[] }>({
        workId: input.workId, label: '因果结果失败声明定点修复', attempts: 2, signal: input.signal,
        schema: repairSchema,
        request: (attempt, lastError) => {
          input.budget.calls++
          if (input.budget.calls > input.budget.max) {
            throw new CausalOutcomeProtocolError('OUTCOME_BUDGET', `章后结果模型调用超过 ${input.budget.max} 次预算`)
          }
          return modelService.chat(
            withGoalLoopModelOptions(input.workId, {
              workId: input.workId, chapterId: input.chapterId,
              step: 'goal_novel_causal_outcome_claim_repair', enrichWorkContext: false, enrichNarrativeMemory: false,
              temperature: 0, maxTokens: 1400, forceThinkingDisabled: true,
              responseSchema: { name: 'causal_outcome_claim_repair', schema: repairSchema, strict: true },
              structuredOutputMode: 'prompt_json',
              systemPrompt: [
                '只重新提取列出的失败原子声明。replacement 只填写证据能直接支持的更窄状态值，不要重复主语、字段名或解释。',
                '审计指出不存在的事实必须从 replacement 中删除，不得通过改写措辞保留。',
                `每条 replacement 最多绑定 ${MAX_CLAIM_REPAIR_EVIDENCE_IDS} 个直接证据；若原声明包含多个事实，只保留其中一个有直接证据的事实。`,
                '每个 claimId 必须恰好返回一次；evidenceIds 只能从正文证据索引选择。只返回 JSON。'
              ].join('\n'),
              prompt: [
                `【失败声明】\n${JSON.stringify(failed, null, 2)}`,
                `【审计原因】\n${currentAudit.reasons.join('；')}`,
                `【正文证据索引】\n${evidenceCatalog(input.units)}`,
                attempt > 1 ? `【上次协议错误】\n${lastError}` : ''
              ].filter(Boolean).join('\n\n')
            }),
            { stream: false, signal: input.signal }
          )
        },
        validate: value => ({ repairs: Array.isArray(value.repairs) ? value.repairs as ClaimRepair[] : [] })
      })
      const returnedIds = repaired.repairs.map(item => item.claimId)
      if (
        new Set(returnedIds).size !== failed.length ||
        failed.some(item => !returnedIds.includes(item.id))
      ) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_SCHEMA', '失败声明定点修复没有完整返回当前批次的全部 claimId',
          failed.map(item => item.id)
        )
      }
      const repairMap = new Map(repaired.repairs.map(item => [item.claimId, item]))
      const nextBatch = currentBatch.map(claim => {
        const repair = repairMap.get(claim.id)
        if (!repair) return claim
        const replacement = repair.replacement.trim()
        if (!replacement) {
          throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', `${claim.id} 的 replacement 不能为空`)
        }
        if (!claim.claimTemplate) {
          throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', `${claim.id} 缺少可修复声明模板`)
        }
        return {
          ...claim,
          value: replacement,
          claim: claim.claimTemplate.split('{{value}}').join(replacement),
          evidenceIds: validateCausalEvidenceIds(
            input.units,
            repair.evidenceIds,
            `${claim.id}.evidenceIds`,
            { min: 1, max: MAX_CLAIM_REPAIR_EVIDENCE_IDS }
          )
        }
      })
      const nextAudit = await auditOnce(nextBatch)
      if (nextAudit.passed && nextAudit.failedClaimIds.length === 0) {
        repairedBatch = nextBatch
        break
      }
      currentBatch = nextBatch
      currentAudit = nextAudit
    }
    if (!repairedBatch) {
      throw new CausalOutcomeProtocolError(
        'OUTCOME_ENTAILMENT',
        `批次 ${batchIndex + 1} 经 ${MAX_CLAIM_REPAIR_ROUNDS} 轮定点修复后仍未通过：${currentAudit.reasons.join('；')}`,
        currentAudit.failedClaimIds
      )
    }
    causalNovelDAO.saveCheckpoint({
      workId: input.workId, chapterId: input.chapterId, contentVersionId: input.contentVersionId,
      bodyHash: input.bodyHash, protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
      stage: checkpointStage, status: 'completed',
      payload: { stateRevision: input.state.revision, inputHash, claims: repairedBatch }
    })
    validatedClaims.push(...repairedBatch)
  }
  return validatedClaims
}

export async function runCausalOutcomePipeline(input: {
  workId: number
  chapterId: number
  contentVersionId: number
  state: CausalNarrativeState
  record: CausalChapterDecisionRecord
  content: string
  chapterOrdinal?: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
}): Promise<{ outcome: CausalChapterOutcome; bodyHash: string; modelCalls: number }> {
  const bodyHash = createHash('sha256').update(input.content).digest('hex')
  const budget: PipelineBudget = {
    calls: 0,
    max: MAX_STAGE_MODEL_CALLS,
    reservations: new Set()
  }
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

  const promptState = projectCausalOutcomeState(input.state, input.record)
  const common = {
    workId: input.workId, chapterId: input.chapterId, contentVersionId: input.contentVersionId,
    bodyHash, state: input.state, promptState, record: input.record, units, budget,
    signal: input.signal, onProgress: input.onProgress
  }
  const staleMacroArc = input.chapterOrdinal == null
    ? undefined
    : input.state.macroArcs.find(arc =>
        arc.status === 'active'
        && input.chapterOrdinal! - arc.lastAdvancedChapter >= 3
    )
  const frozenPromises = new Set(input.record.plan.decision.advancedPromiseIds)
  input.onProgress?.('章后结果 2/8 · 提取核心事件与读者承诺')
  const core = await requestStage<CausalOutcomeCoreDraft>({
    ...common, stage: 'outcome_core', label: '核心事件提取', schema: coreSchema(promptState, units),
    instructions: [
      'primaryEvent 只描述一个最主要的已发生事件；eventSignature 使用简短稳定中文事件签名。',
      '其他独立事实分别放入 supportingEvents，每个事件独立绑定证据，禁止写覆盖整章多事件的综合 claim。',
      '每个承诺推进、关闭和新悬念分别输出独立对象与独立证据；至少推进冻结决策 advancedPromiseIds 中的一项。',
      '未达到终止条件时 terminal.matchedCondition、terminal.completionReason 为空字符串，terminal.evidenceIds 为空数组。'
    ],
    validate: value => {
      const draft = value as unknown as CausalOutcomeCoreDraft
      if (
        !draft.primaryEvent?.claim?.trim() ||
        !draft.primaryEvent.eventSignature?.trim() ||
        !Array.isArray(draft.primaryEvent.evidenceIds) ||
        !Array.isArray(draft.supportingEvents) ||
        !Array.isArray(draft.advancedPromises) ||
        !Array.isArray(draft.resolvedPromises) ||
        !Array.isArray(draft.newPromises) ||
        !draft.terminal ||
        !Array.isArray(draft.terminal.evidenceIds)
      ) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_SCHEMA',
          '核心事件缺少完整的 v6 原子事件、承诺操作或终止状态'
        )
      }
      const emptyClaimPath = [
        ...draft.supportingEvents.map((item, index) => ({
          value: item.claim,
          path: `core.supportingEvents[${index}].claim`
        })),
        ...draft.advancedPromises.map((item, index) => ({
          value: item.claim,
          path: `core.advancedPromises[${index}].claim`
        })),
        ...draft.resolvedPromises.map((item, index) => ({
          value: item.claim,
          path: `core.resolvedPromises[${index}].claim`
        })),
        ...draft.newPromises.flatMap((item, index) => [
          { value: item.question, path: `core.newPromises[${index}].question` },
          { value: item.claim, path: `core.newPromises[${index}].claim` }
        ])
      ].find(item => !item.value?.trim())?.path
      if (emptyClaimPath) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_SCHEMA',
          `${emptyClaimPath} 不能为空`,
          [emptyClaimPath]
        )
      }
      const advancedIds = draft.advancedPromises.map(item => item.promiseId)
      const resolvedIds = draft.resolvedPromises.map(item => item.promiseId)
      const operationIds = [...advancedIds, ...resolvedIds]
      if (new Set(operationIds).size !== operationIds.length) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_OPERATION',
          '同一读者承诺不能重复操作或同时标记为推进和关闭'
        )
      }
      if (![...advancedIds, ...resolvedIds].some(id => frozenPromises.has(id))) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_PROMISE_PROGRESS',
          '核心事件没有推进冻结决策中的任何读者承诺',
          ['core.advancedPromises']
        )
      }
      if (draft.terminal.conditionMet) {
        if (!draft.terminal.matchedCondition.trim() || !draft.terminal.completionReason.trim()) {
          throw new CausalOutcomeProtocolError(
            'OUTCOME_SCHEMA',
            '终止条件命中时必须填写 matchedCondition 与 completionReason'
          )
        }
      } else if (
        draft.terminal.matchedCondition.trim() ||
        draft.terminal.completionReason.trim() ||
        draft.terminal.evidenceIds.length
      ) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_OPERATION',
          '终止条件未命中时 terminal 的条件、原因和证据必须为空'
        )
      }
      return draft
    }
  })

  input.onProgress?.('章后结果 3/8 · 提取人物状态操作')
  const actors = await requestStage<CausalOutcomeActorDraft>({
    ...common, stage: 'outcome_actors', label: '人物变化提取', schema: actorsSchema(promptState, units),
    instructions: [
      'actorMutations 每项只表达一个人物字段变化；同一人物的多条知识、资源、关系或义务必须拆成多个对象并独立取证。',
      '只记录会改变后续选择、能力、位置、身体状态、关系或义务的章末净变化；不得把共同目睹的动作、对白、兑换过程和核心事件逐人复制为 knowledge。',
      '知识账本只提供既有条目数量用于识别历史规模，不要求也禁止复述既有知识；knowledge 只添加本章新获得且会改变该人物未来判断的信息差。',
      'knowledgeLedgerCount、resourceLedgerCount、relationshipLedgerCount、obligationLedgerCount 只表示历史规模，不是待输出清单；禁止按数量猜测、展开或复述历史集合。',
      'resources 只记录章末相对章初的净增减，不得同时保留本章内已经消耗或转化的中间物品。',
      '同一 actor、field、operation、value 组合最多出现一次；禁止通过重复同一变化扩大响应。',
      '标量字段只能使用 set；knowledge 只能 add；resources/relationships/obligations 可以 add 或 remove。',
      'actorMutations.actor 只能逐字使用权威状态投影 knownActorNames 中的名字；正文中新登场的人物不得写入 actorMutations，必须合并到 newActors，并用一个 name 事实声明姓名。',
      'newActors 的每个 facts 项只表达一个字段事实，必须包含且只能包含一个 name 事实。',
      '伤势、感染、疲劳和情绪必须使用 physicalState，禁止作为 resources。'
    ],
    validate: value => {
      const draft = value as unknown as CausalOutcomeActorDraft
      if (!Array.isArray(draft.actorMutations) || !Array.isArray(draft.newActors)) {
        throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', '人物阶段缺少 v6 原子人物操作')
      }
      validateCausalOutcomeActorMutationReferences(
        draft,
        input.state.actors.map(item => item.name)
      )
      const actorMutationKeys = new Set<string>()
      for (const [index, item] of draft.actorMutations.entries()) {
        const scalarField = ['currentGoal', 'constraint', 'location', 'physicalState'].includes(item.field)
        const allowedOperation = scalarField
          ? item.operation === 'set'
          : item.field === 'knowledge'
            ? item.operation === 'add'
            : item.operation === 'add' || item.operation === 'remove'
        if (!allowedOperation) {
          throw new CausalOutcomeProtocolError(
            'OUTCOME_OPERATION',
            `actors.actorMutations[${index}] 的 ${item.field} 不支持 ${item.operation} 操作`
          )
        }
        const mutationKey = scalarField
          ? `${item.actor}\u0000${item.field}`
          : `${item.actor}\u0000${item.field}\u0000${item.operation}\u0000${item.value.trim()}`
        if (actorMutationKeys.has(mutationKey)) {
          throw new CausalOutcomeProtocolError(
            'OUTCOME_OPERATION',
            `actors.actorMutations[${index}] 与同阶段的另一条人物操作重复`
          )
        }
        actorMutationKeys.add(mutationKey)
      }
      const invalid = draft.actorMutations
        .filter(item => item.field === 'resources')
        .map(item => item.value)
        .find(isCausalPhysicalConditionValue)
      if (invalid) {
        throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `人物阶段把伤势/身体状态误当作资源：${invalid}`)
      }
      const knownNames = new Set(input.state.actors.map(item => item.name))
      const newActorKeys = new Set<string>()
      for (const item of draft.newActors) {
        if (newActorKeys.has(item.key)) {
          throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `新增人物 key 重复：${item.key}`)
        }
        newActorKeys.add(item.key)
        const names = item.facts.filter(fact => fact.field === 'name').map(fact => fact.value.trim())
        if (names.length !== 1) {
          throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', `新增人物 ${item.key} 必须且只能包含一个 name 事实`)
        }
        if (knownNames.has(names[0])) {
          throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `新增人物与权威状态重复：${names[0]}`)
        }
        const scalarFacts = item.facts
          .filter(fact => ['name', 'currentGoal', 'fear', 'constraint', 'location', 'physicalState'].includes(fact.field))
          .map(fact => fact.field)
        if (new Set(scalarFacts).size !== scalarFacts.length) {
          throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `新增人物 ${item.key} 重复定义标量字段`)
        }
        knownNames.add(names[0])
      }
      return draft
    }
  })

  input.onProgress?.('章后结果 4/8 · 提取压力与阶段操作')
  const world = await requestStage<CausalOutcomeWorldDraft>({
    ...common, stage: 'outcome_world', label: '世界压力提取', schema: worldSchema(promptState, units),
    instructions: [
      '压力条件、状态和紧迫度必须分别输出到对应数组，每个对象只表达一个变化并独立取证。',
      '同一数组内每个压力 ID 最多出现一次；若同一压力有多条依据，必须收窄为一个章末值并选择最直接的证据，禁止复制同 ID 对象。',
      '状态只能是 stable/escalated/relieved/resolved；escalated 时最终 urgency 不得低于原值，relieved 不得高于原值。',
      '新压力使用当前响应内唯一 key，每个字段独立绑定证据；正式 ID 由服务器分配。urgency.claim 必须写造成当前紧迫性的正文事实，不能写数值或系统等级。不能把未来推测当成当前压力。',
      'arcUpdates 只在正文已经满足阶段推进或完成条件时输出；claim 必须写正文直接发生的单一事实，不能写阶段 ID、active/completed 等系统状态。'
      , ...(staleMacroArc
        ? [`当前章节已触发宏观阶段停滞：必须在正文证据支持范围内输出 arcUpdates，目标阶段 id=${staleMacroArc.id}；禁止返回空数组。`]
        : [])
    ],
    validate: value => {
      const draft = value as unknown as CausalOutcomeWorldDraft
      if (
        !Array.isArray(draft.pressureConditionUpdates) ||
        !Array.isArray(draft.pressureStatusUpdates) ||
        !Array.isArray(draft.pressureUrgencyUpdates) ||
        !Array.isArray(draft.newPressures) ||
        !Array.isArray(draft.arcUpdates)
      ) {
        throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', '世界阶段缺少 v6 原子压力操作')
      }
      if (staleMacroArc && !draft.arcUpdates.some(update => update.id === staleMacroArc.id)) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_OPERATION',
          `宏观阶段 ${staleMacroArc.id} 已停滞，arcUpdates 必须包含该阶段的正文推进证据`
        )
      }
      const pressureMap = new Map(input.state.activePressures.map(item => [item.id, item]))
      const assertUniqueIds = (
        items: Array<{ id: string }>,
        path: string
      ): void => {
        const ids = items.map(item => item.id)
        if (new Set(ids).size !== ids.length) {
          throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `${path} 包含重复压力 ID`)
        }
      }
      assertUniqueIds(draft.pressureConditionUpdates, 'world.pressureConditionUpdates')
      assertUniqueIds(draft.pressureStatusUpdates, 'world.pressureStatusUpdates')
      assertUniqueIds(draft.pressureUrgencyUpdates, 'world.pressureUrgencyUpdates')
      const pressureKeys = draft.newPressures.map(item => item.key)
      if (new Set(pressureKeys).size !== pressureKeys.length) {
        throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', 'world.newPressures 包含重复 key')
      }
      const urgencyMap = new Map(draft.pressureUrgencyUpdates.map(item => [item.id, item.value]))
      for (const update of draft.pressureStatusUpdates) {
        const previous = pressureMap.get(update.id)
        if (!previous) throw new CausalOutcomeProtocolError('OUTCOME_REFERENCE', `压力不存在：${update.id}`)
        const urgency = urgencyMap.get(update.id) ?? previous.urgency
        if (update.value === 'escalated' && urgency < previous.urgency) {
          throw new CausalOutcomeProtocolError('OUTCOME_OPERATION', `压力 ${update.id} 声明升级但紧迫度下降`)
        }
        if (update.value === 'relieved' && urgency > previous.urgency) {
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
      'readerEffect.claim 必须说明正文已经造成的读者情绪效果。',
      'trigger/choice/cost/residue 必须分别写一条可由自身证据直接推出的原子声明，禁止把 choice 与 cost 合并。',
      '没有开启或兑现情绪债时，debtOpened/debtPaid 的 claim 为空字符串且 evidenceIds 为空数组。'
    ],
    validate: value => {
      const draft = value as unknown as CausalOutcomeEmotionDraft
      const required = ['readerEffect', 'trigger', 'choice', 'cost', 'residue'] as const
      const missing = required.find(key => !draft[key]?.claim?.trim())
      if (missing) {
        throw new CausalOutcomeProtocolError('OUTCOME_EMOTION', `本章缺少 ${missing} 原子情绪结果`)
      }
      for (const key of ['debtOpened', 'debtPaid'] as const) {
        if (!draft[key]?.claim?.trim() && draft[key]?.evidenceIds?.length) {
          throw new CausalOutcomeProtocolError(
            'OUTCOME_OPERATION',
            `${key} 没有声明时不得绑定正文证据`
          )
        }
      }
      return draft
    }
  })

  const bundle: CausalOutcomeDraftBundle = { core, actors, world, emotion }
  input.onProgress?.('章后结果 6/8 · 服务器正在组装类型化状态操作')
  input.onProgress?.('章后结果 7/8 · 本地验证原子状态变更与正文证据 ID')
  const validatedClaims = buildAtomicOutcomeClaims({
    bundle,
    state: input.state,
    record: input.record
  })
  for (const claim of validatedClaims) {
    validateCausalEvidenceIds(
      units,
      claim.evidenceIds,
      `${claim.id}.evidenceIds`,
      { min: 1, max: CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX }
    )
  }
  const mutations = materializeAtomicOutcomeClaims({ bundle, claims: validatedClaims, units })
  const outcome = materializeCausalOutcomeDraft({
    state: input.state,
    units,
    draft: bundle,
    mutations
  })
  causalNovelDAO.saveCheckpoint({
    workId: input.workId, chapterId: input.chapterId, contentVersionId: input.contentVersionId,
    bodyHash, protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
    stage: 'outcome_materialized', status: 'completed',
    payload: { stateRevision: input.state.revision, outcome, modelCalls: budget.calls }
  })
  input.onProgress?.(`章后结果 8/8 · 协议校验完成，正常预算 ${NORMAL_STAGE_MODEL_CALLS} 次，本次调用 ${budget.calls}/${budget.max} 次`)
  return { outcome, bodyHash, modelCalls: budget.calls }
}

export { causalOutcomeFailureCode }
