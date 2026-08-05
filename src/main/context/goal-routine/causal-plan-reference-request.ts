import type {
  CausalChapterPlanDraft,
  CausalEventCandidateProposal,
  CausalEvidenceFact,
  CausalNarrativeState
} from '../../../shared/causal-novel-types'
import { modelService } from '../../model'
import { classifyWorkflowError } from '../../workflow/workflow-errors'
import {
  applyCandidateReferencePatches,
  applyDecisionReferencePatches,
  assertReferencePatches,
  CausalPlanReferenceRepairExhaustedError,
  type CausalPlanReferenceIssue,
  type CausalPlanReferencePatch
} from './causal-plan-reference-repair'
import { withGoalLoopModelOptions } from './story-goal-model'
import { requestStructuredModelOutput } from './structured-model-output'

function referencePatchSchema(
  issues: CausalPlanReferenceIssue[]
): Record<string, unknown> {
  const variants = issues.map(issue => ({
    type: 'object',
    additionalProperties: false,
    required: ['path', 'value'],
    properties: {
      path: { type: 'string', enum: [issue.path] },
      value: Array.isArray(issue.actual)
        ? { type: 'array', minItems: 1, items: { type: 'string' } }
        : { type: 'string', minLength: 1 }
    }
  }))
  return {
    type: 'object', additionalProperties: false, required: ['patches'],
    properties: {
      patches: {
        type: 'array', minItems: issues.length, maxItems: issues.length,
        items: variants.length === 1 ? variants[0] : { oneOf: variants }
      }
    }
  }
}

function referenceRepairFailure(error: unknown): never {
  const classified = classifyWorkflowError(error)
  if (
    classified.errorClass === 'cancelled'
    || classified.errorClass === 'transient_transport'
    || classified.errorClass === 'provider_rate_limit'
    || classified.errorClass === 'budget_exhausted'
    || classified.errorClass === 'user_action_required'
  ) throw error
  throw new CausalPlanReferenceRepairExhaustedError(classified.message)
}

function parsePatches(value: Record<string, unknown>): CausalPlanReferencePatch[] {
  if (!Array.isArray(value.patches)) throw new Error('引用修复缺少 patches 数组')
  return value.patches.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`引用修复第 ${index + 1} 项不是对象`)
    }
    const row = item as Record<string, unknown>
    if (typeof row.path !== 'string' || !row.path.trim()) {
      throw new Error(`引用修复第 ${index + 1} 项缺少 path`)
    }
    if (typeof row.value !== 'string' && !Array.isArray(row.value)) {
      throw new Error(`引用修复 ${row.path} 的 value 类型无效`)
    }
    return {
      path: row.path,
      value: Array.isArray(row.value) ? row.value.map(String) : row.value
    }
  })
}

async function requestReferencePatches(input: {
  workId: number
  step: string
  label: string
  source: unknown
  issues: CausalPlanReferenceIssue[]
  signal?: AbortSignal
}): Promise<CausalPlanReferencePatch[]> {
  const schema = referencePatchSchema(input.issues)
  const typedIssues = input.issues.map(issue => ({
    ...issue,
    valueType: Array.isArray(issue.actual) ? 'string_array' : 'string'
  }))
  return requestStructuredModelOutput<CausalPlanReferencePatch[]>({
    workId: input.workId,
    label: input.label,
    attempts: 2,
    signal: input.signal,
    schema,
    request: async (_attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(input.workId, {
        workId: input.workId,
        step: input.step,
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        maxTokens: Math.max(800, input.issues.length * 160),
        forceThinkingDisabled: true,
        responseSchema: {
          name: 'causal_plan_reference_patches',
          schema,
          strict: true
        },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是因果计划权威引用绑定器。只修复列出的引用路径，不得改写任何创作字段。',
          '每个 issue 必须且只能返回一个 patch；path 必须逐字照抄。',
          'value 只能从该 issue 的 allowed 中选择，且必须严格遵守 valueType。',
          'valueType=string 时必须返回一个 JSON 字符串；即使原值描述了多个合法 ID，也只能选择与该候选行动最直接相关的一个主承诺，禁止返回数组或附加解释。',
          'valueType=string_array 时必须返回非空 JSON 字符串数组。',
          '只输出 JSON：{"patches":[{"path":"原路径","value":"允许值"}]}'
        ].join('\n'),
        prompt: [
          `【冻结制品，不得改写】\n${JSON.stringify(input.source, null, 2)}`,
          `【唯一允许修复的问题】\n${JSON.stringify(typedIssues, null, 2)}`,
          lastError && lastError !== '未知结构化输出错误'
            ? `【上一绑定补丁无效】\n${lastError}`
            : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal: input.signal }
    ),
    validate: value => assertReferencePatches(input.issues, parsePatches(value))
  })
}

export async function repairCandidateReferences(input: {
  workId: number
  state: CausalNarrativeState
  candidates: CausalEventCandidateProposal[]
  issues: CausalPlanReferenceIssue[]
  signal?: AbortSignal
}): Promise<CausalEventCandidateProposal[]> {
  try {
    const patches = await requestReferencePatches({
      workId: input.workId,
      step: 'goal_novel_causal_candidates_reference_rebind',
      label: '因果候选权威引用定点修复',
      source: { candidates: input.candidates },
      issues: input.issues,
      signal: input.signal
    })
    return applyCandidateReferencePatches(input.state, input.candidates, patches)
  } catch (error) {
    referenceRepairFailure(error)
  }
}

export async function repairDecisionReferences(input: {
  workId: number
  state: CausalNarrativeState
  catalog: CausalEvidenceFact[]
  draft: Omit<CausalChapterPlanDraft, 'candidates'>
  issues: CausalPlanReferenceIssue[]
  signal?: AbortSignal
}): Promise<Omit<CausalChapterPlanDraft, 'candidates'>> {
  try {
    const patches = await requestReferencePatches({
      workId: input.workId,
      step: 'goal_novel_causal_decision_reference_rebind',
      label: '因果决策权威引用定点修复',
      source: input.draft,
      issues: input.issues,
      signal: input.signal
    })
    return applyDecisionReferencePatches(input.state, input.catalog, input.draft, patches)
  } catch (error) {
    referenceRepairFailure(error)
  }
}
