import { modelService } from '../../model'
import {
  CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX,
  CausalOutcomeProtocolError,
  validateCausalEvidenceIds,
  validateCausalStageEvidence,
  type CausalBodyEvidenceUnit
} from '../../../shared/causal-outcome-protocol'
import { requestStructuredModelOutput } from './structured-model-output'
import { withGoalLoopModelOptions } from './story-goal-model'

const REPAIR_ATTEMPTS = 2

interface WorldAtomizationBudget {
  calls: number
  max: number
  reservations: Set<string>
}

interface WorldAtomizationRepairTarget {
  key: string
  path: string
  statementPath: string | null
  statement: unknown
  currentEvidenceIds: unknown
}

interface WorldAtomizationRepairValue {
  statement?: string
  evidenceIds: string[]
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

function evidenceCatalog(units: CausalBodyEvidenceUnit[]): string {
  return units.map(unit => `${unit.id} [段${unit.paragraph}] ${unit.text}`).join('\n')
}

function evidenceArraySchema(): Record<string, unknown> {
  return {
    type: 'array',
    minItems: 1,
    items: { type: 'string', pattern: '^e\\d{4}$' }
  }
}

function repairTargets(
  invalidValue: Record<string, unknown>,
  issues: Array<{ path: string }>
): WorldAtomizationRepairTarget[] {
  return issues.map((issue, index) => {
    const basePath = issue.path.replace(/\.evidenceIds$/, '')
    const claimPath = `${basePath}.claim`
    const valuePath = `${basePath}.value`
    const claim = getPath(invalidValue, claimPath)
    const value = getPath(invalidValue, valuePath)
    const statementPath = typeof claim === 'string'
      ? claimPath
      : issue.path.startsWith('pressureConditionUpdates[') && typeof value === 'string'
        ? valuePath
        : null
    return {
      key: `r${String(index + 1).padStart(3, '0')}`,
      path: issue.path,
      statementPath,
      statement: statementPath ? getPath(invalidValue, statementPath) : value,
      currentEvidenceIds: getPath(invalidValue, issue.path)
    }
  })
}

export function applyWorldAtomizationRepairPatch(
  invalidValue: Record<string, unknown>,
  issues: Array<{ path: string }>,
  repairs: Record<string, WorldAtomizationRepairValue>
): Record<string, unknown> {
  const targets = repairTargets(invalidValue, issues)
  const expectedKeys = targets.map(target => target.key)
  const actualKeys = Object.keys(repairs)
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some(key => !expectedKeys.includes(key))
  ) {
    throw new CausalOutcomeProtocolError(
      'OUTCOME_SCHEMA',
      '世界压力原子化修复必须且只能覆盖全部固定修复槽位'
    )
  }
  const candidate = structuredClone(invalidValue)
  for (const target of targets) {
    const repair = repairs[target.key]
    if (!repair || !Array.isArray(repair.evidenceIds)) {
      throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', `缺少世界压力修复槽位 ${target.key}`)
    }
    if (target.statementPath) {
      if (!repair.statement?.trim()) {
        throw new CausalOutcomeProtocolError('OUTCOME_SCHEMA', `${target.key}.statement 不能为空`)
      }
      setPath(candidate, target.statementPath, repair.statement.trim())
    }
    setPath(candidate, target.path, repair.evidenceIds)
  }
  return candidate
}

function repairSchema(targets: WorldAtomizationRepairTarget[]): Record<string, unknown> {
  const properties = Object.fromEntries(targets.map(target => [target.key, {
    type: 'object',
    additionalProperties: false,
    required: target.statementPath ? ['statement', 'evidenceIds'] : ['evidenceIds'],
    properties: {
      ...(target.statementPath ? { statement: { type: 'string', minLength: 1 } } : {}),
      evidenceIds: evidenceArraySchema()
    }
  }]))
  return {
    type: 'object', additionalProperties: false, required: ['repairs'],
    properties: {
      repairs: {
        type: 'object', additionalProperties: false,
        required: targets.map(target => target.key),
        properties
      }
    }
  }
}

export async function repairWorldStageAtomization<T>(input: {
  workId: number
  chapterId: number
  stage: string
  label: string
  invalidValue: Record<string, unknown>
  issues: Array<{ path: string }>
  units: CausalBodyEvidenceUnit[]
  budget: WorldAtomizationBudget
  signal?: AbortSignal
  validate: (value: Record<string, unknown>) => T
  onProgress?: (message: string) => void
}): Promise<T> {
  const targets = repairTargets(input.invalidValue, input.issues)
  const schema = repairSchema(targets)
  const budgetKey = `${input.stage}:world_atomization_patch`
  if (!input.budget.reservations.has(budgetKey)) {
    input.budget.reservations.add(budgetKey)
    input.budget.max += REPAIR_ATTEMPTS
  }
  return requestStructuredModelOutput<T>({
    workId: input.workId,
    label: `${input.label}定点原子化修复`,
    attempts: REPAIR_ATTEMPTS,
    signal: input.signal,
    schema,
    request: async (attempt, lastError) => {
      input.budget.calls++
      if (input.budget.calls > input.budget.max) {
        throw new CausalOutcomeProtocolError(
          'OUTCOME_BUDGET',
          `章后结果模型调用超过 ${input.budget.max} 次预算`
        )
      }
      input.onProgress?.(
        `${input.label}：定点原子化修复 ${attempt}/2，模型调用 ${input.budget.calls}/${input.budget.max}`
      )
      return modelService.chat(
        withGoalLoopModelOptions(input.workId, {
          workId: input.workId,
          chapterId: input.chapterId,
          step: `goal_novel_causal_outcome_${input.stage}_atomize`,
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          temperature: 0,
          maxTokens: 1600,
          forceThinkingDisabled: true,
          responseSchema: {
            name: `causal_outcome_${input.stage}_atomized_patch`,
            schema,
            strict: true
          },
          structuredOutputMode: 'prompt_json',
          systemPrompt: [
            '你是世界压力事实的定点原子化修复器。服务器已经为每个超限路径创建唯一修复槽位。',
            `每个槽位的 evidenceIds 只能保留 1-${CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX} 个最直接正文证据 ID。`,
            '需要 statement 的槽位必须把原复合事实收窄为一个章末状态事实；禁止拆分、复制或新增压力对象。',
            '不含 statement 的槽位只重绑证据，不得改变冻结的状态或紧迫度值。',
            '必须恰好填写全部修复槽位，不得返回原始世界压力数组。只返回符合 Schema 的 JSON。'
          ].join('\n'),
          prompt: [
            `【固定修复槽位】\n${JSON.stringify(targets, null, 2)}`,
            `【正文证据索引】\n${evidenceCatalog(input.units)}`,
            attempt > 1 ? `【上次修复错误】\n${lastError}` : ''
          ].filter(Boolean).join('\n\n')
        }),
        { stream: false, signal: input.signal }
      )
    },
    validate: value => {
      const repairs = value.repairs && typeof value.repairs === 'object'
        ? value.repairs as Record<string, WorldAtomizationRepairValue>
        : {}
      for (const target of targets) {
        validateCausalEvidenceIds(
          input.units,
          repairs[target.key]?.evidenceIds ?? [],
          target.path,
          { min: 1, max: CAUSAL_OUTCOME_ATOMIC_EVIDENCE_MAX }
        )
      }
      const candidate = applyWorldAtomizationRepairPatch(input.invalidValue, input.issues, repairs)
      const validated = input.validate(candidate)
      validateCausalStageEvidence(validated, input.units)
      return validated
    }
  })
}
