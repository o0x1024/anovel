export type NarrativeMemoryFailureCode =
  | 'MEMORY_EXTRACT_TRUNCATED'
  | 'MEMORY_EXTRACT_PROTOCOL'
  | 'MEMORY_EXTRACT_TRANSPORT'

export const NARRATIVE_MEMORY_BASE_MAX_TOKENS = 4200
export const NARRATIVE_MEMORY_MAX_ATTEMPTS = 3
export const NARRATIVE_MEMORY_MAX_TRANSPORT_ATTEMPTS = 2

/**
 * 结构化生成轮次使用确定预算：1x -> 2x -> 3x。
 * 传输失败由独立内层重试处理，不得推进该轮次。
 */
export function narrativeMemoryTokenBudget(generationAttempt: number): number {
  if (
    !Number.isInteger(generationAttempt)
    || generationAttempt < 1
    || generationAttempt > NARRATIVE_MEMORY_MAX_ATTEMPTS
  ) {
    throw new Error(`叙事记忆生成轮次必须为 1-${NARRATIVE_MEMORY_MAX_ATTEMPTS}`)
  }
  return NARRATIVE_MEMORY_BASE_MAX_TOKENS * generationAttempt
}

export type NarrativeMemoryRetryAction =
  | 'retry_transport'
  | 'next_generation'
  | 'pause'

export function decideNarrativeMemoryRetry(input: {
  failureCode: NarrativeMemoryFailureCode
  generationAttempt: number
  transportAttempt: number
}): NarrativeMemoryRetryAction {
  if (input.failureCode === 'MEMORY_EXTRACT_TRANSPORT') {
    return input.transportAttempt < NARRATIVE_MEMORY_MAX_TRANSPORT_ATTEMPTS
      ? 'retry_transport'
      : 'pause'
  }
  return input.generationAttempt < NARRATIVE_MEMORY_MAX_ATTEMPTS
    ? 'next_generation'
    : 'pause'
}

export class NarrativeMemoryPipelineError extends Error {
  constructor(
    public readonly code: NarrativeMemoryFailureCode,
    message: string
  ) {
    super(message)
    this.name = code
  }
}

export function classifyNarrativeMemoryFailure(
  message: string,
  finishReason?: string
): NarrativeMemoryFailureCode {
  if (
    finishReason === 'length'
    || /Unexpected end of JSON|Unterminated string|finishReason=length|截断/i.test(message)
  ) return 'MEMORY_EXTRACT_TRUNCATED'
  if (/timeout|timed out|ECONNRESET|ECONNABORTED|network|网络/i.test(message)) {
    return 'MEMORY_EXTRACT_TRANSPORT'
  }
  return 'MEMORY_EXTRACT_PROTOCOL'
}
