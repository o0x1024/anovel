export const STRUCTURAL_REPAIR_MAX_ATTEMPTS = 2
export const STORY_ROUTINE_FAILURE_LIMIT = 3

const MIN_STRUCTURAL_REPAIR_TOKENS = 6000
const EXTRA_TARGET_TOKENS = 3500

export type StructuralRepairFailureCode =
  | 'STRUCTURE_RESPONSE_TRUNCATED'
  | 'STRUCTURE_JSON_INVALID'
  | 'STRUCTURE_PATCH_EMPTY'
  | 'STRUCTURE_TARGET_MISMATCH'

export class StructuralRepairError extends Error {
  constructor(
    public readonly code: StructuralRepairFailureCode,
    message: string
  ) {
    super(message)
    this.name = code
  }
}

/**
 * 系统 Max Tokens 是用户允许的单次输出上限；任务预算按目标数和重试轮次估算。
 * 第二次请求扩大一倍，但永远不突破用户上限。
 */
export function structuralRepairTokenBudget(
  userMaxTokens: number,
  targetCount: number,
  attempt: number
): number {
  const safeUserMax = Math.max(1, Math.floor(userMaxTokens))
  const safeTargetCount = Math.max(1, Math.floor(targetCount))
  const base = MIN_STRUCTURAL_REPAIR_TOKENS + (safeTargetCount - 1) * EXTRA_TARGET_TOKENS
  const expanded = base * 2 ** Math.max(0, Math.floor(attempt) - 1)
  return Math.min(safeUserMax, expanded)
}

export function classifyStructuralRepairParseFailure(input: {
  content: string
  completionTokens?: number
  maxTokens: number
  finishReason?: string
}): StructuralRepairError {
  const trimmed = input.content.trim()
  const completionTokens = Math.max(0, input.completionTokens ?? 0)
  const nearLimit = input.maxTokens > 0 && completionTokens >= Math.floor(input.maxTokens * 0.95)
  const startsLikeJson = /^(?:```json\s*)?[\[{]/i.test(trimmed)
  const visiblyUnclosed = startsLikeJson && !/[}\]]\s*(?:```)?\s*$/.test(trimmed)

  if (input.finishReason === 'length' || nearLimit || visiblyUnclosed) {
    return new StructuralRepairError(
      'STRUCTURE_RESPONSE_TRUNCATED',
      `结构修复输出达到 ${input.maxTokens} token 预算且 JSON 未闭合`
    )
  }
  return new StructuralRepairError(
    'STRUCTURE_JSON_INVALID',
    '结构修复返回内容不是可解析的完整 JSON'
  )
}

export function routineFailureSignature(phase: string, error: unknown): string {
  const name = error instanceof Error ? error.name : 'unknown'
  const message = error instanceof Error ? error.message : String(error)
  if (name.startsWith('STRUCTURE_')) return `${phase}:${name}`
  if (/正文确定性门禁/.test(message)) return `${phase}:BODY_TEXT_INTEGRITY`
  if (/叙事记忆提取/.test(message)) return `${phase}:MEMORY_EXTRACTION`
  if (/候选.*(?:达到|生成).*个|停止继续抽卡/.test(message)) return `${phase}:CANDIDATE_BUDGET`
  if (/跨拍连续性|连续性修复/.test(message)) return `${phase}:CONTINUITY`
  return `${phase}:${name}:${message.replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 180)}`
}
