import { persistRejectedStructuredArtifact } from './structured-model-output'

export type QualityDiagnosisFailureKind = 'cancelled' | 'timeout' | 'transport' | 'protocol'

export const MAX_QUALITY_EVALUATOR_FAILURES = 2

export interface QualityEvaluatorResponse {
  success: boolean
  content?: string
  error?: string
  cancelled?: boolean
}

export type QualityEvaluatorEvidenceResult<T> =
  | { success: true; value: T; attempts: number }
  | {
      success: false
      code: 'QUALITY_EVALUATOR_UNAVAILABLE' | 'QUALITY_EVALUATOR_PROTOCOL'
      failureKind: Exclude<QualityDiagnosisFailureKind, 'cancelled'>
      message: string
      attempts: number
    }

export type QualityEvaluatorFailureCode = 'QUALITY_EVALUATOR_UNAVAILABLE' | 'QUALITY_EVALUATOR_PROTOCOL'

export class QualityEvaluatorFailureError extends Error {
  readonly code: QualityEvaluatorFailureCode
  readonly attempts: number

  constructor(input: {
    code: QualityEvaluatorFailureCode
    message: string
    attempts: number
    label: string
  }) {
    super(`${input.label}连续 ${input.attempts} 次失败：${input.message}`)
    this.code = input.code
    this.attempts = input.attempts
  }
}

export function requireQualityEvaluatorEvidence<T>(
  result: QualityEvaluatorEvidenceResult<T>,
  label: string
): T {
  if (result.success) return result.value
  throw new QualityEvaluatorFailureError({
    code: result.code,
    message: result.message,
    attempts: result.attempts,
    label
  })
}

export function classifyQualityDiagnosisFailure(
  error: string,
  cancelled = false
): QualityDiagnosisFailureKind {
  if (cancelled || /(?:已取消|abort|cancel)/i.test(error)) return 'cancelled'
  if (/(?:timeout|timed out|超时|ECONNABORTED)/i.test(error)) return 'timeout'
  if (/(?:finishReason=length|finish_reason.?=.?length|正文为空|未返回正文|结构化评分协议|JSON|Schema|解析失败)/i.test(error)) {
    return 'protocol'
  }
  return 'transport'
}

export function qualityEvaluatorFailureCode(
  failureKind: Exclude<QualityDiagnosisFailureKind, 'cancelled'>
): 'QUALITY_EVALUATOR_UNAVAILABLE' | 'QUALITY_EVALUATOR_PROTOCOL' {
  return failureKind === 'protocol'
    ? 'QUALITY_EVALUATOR_PROTOCOL'
    : 'QUALITY_EVALUATOR_UNAVAILABLE'
}

export function shouldOpenQualityEvaluatorCircuit(input: {
  failureKind: QualityDiagnosisFailureKind
  consecutiveFailures: number
}): boolean {
  if (input.failureKind === 'cancelled') return false
  return input.consecutiveFailures >= MAX_QUALITY_EVALUATOR_FAILURES
}

/**
 * 质量评估器的有限取证边界。
 *
 * 传输失败与结构化协议失败都会在当前只读评估步骤内有限重试；重试期间不允许
 * 调用方修改正文。连续失败后保留原始失败类型，交由目标循环冻结当前版本。
 */
export async function requestQualityEvaluatorEvidence<T>(input: {
  workId?: number
  label?: string
  request: (attempt: number, lastError: string) => Promise<QualityEvaluatorResponse>
  parse: (content: string) => T
  signal?: AbortSignal
  attempts?: number
  onRetry?: (input: {
    attempt: number
    maxAttempts: number
    failureKind: Exclude<QualityDiagnosisFailureKind, 'cancelled'>
    message: string
  }) => void
}): Promise<QualityEvaluatorEvidenceResult<T>> {
  const maxAttempts = Math.max(1, input.attempts ?? MAX_QUALITY_EVALUATOR_FAILURES)
  let lastFailure: Exclude<QualityDiagnosisFailureKind, 'cancelled'> = 'transport'
  let lastError = '质量评估器无返回'

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (input.signal?.aborted) throw new Error('已取消')
    let response: QualityEvaluatorResponse
    try {
      response = await input.request(attempt, lastError)
    } catch (error) {
      if (input.signal?.aborted) throw new Error('已取消')
      lastError = error instanceof Error ? error.message : String(error)
      const failureKind = classifyQualityDiagnosisFailure(lastError)
      if (failureKind === 'cancelled') throw new Error('已取消')
      lastFailure = failureKind
      if (attempt < maxAttempts) {
        input.onRetry?.({
          attempt,
          maxAttempts,
          failureKind: lastFailure,
          message: lastError
        })
      }
      continue
    }

    if (!response.success || !response.content?.trim()) {
      lastError = response.error || '质量评估器无返回'
      const failureKind = classifyQualityDiagnosisFailure(lastError, Boolean(response.cancelled))
      if (failureKind === 'cancelled') throw new Error('已取消')
      lastFailure = failureKind
    } else {
      try {
        return {
          success: true,
          value: input.parse(response.content),
          attempts: attempt
        }
      } catch (error) {
        lastFailure = 'protocol'
        lastError = error instanceof Error ? error.message : String(error)
        if (input.workId != null) {
          persistRejectedStructuredArtifact({
            workId: input.workId,
            label: input.label ?? '质量评估器',
            attempt,
            stage: 'business_validation',
            content: response.content,
            error
          })
        }
      }
    }

    if (attempt < maxAttempts) {
      input.onRetry?.({
        attempt,
        maxAttempts,
        failureKind: lastFailure,
        message: lastError
      })
    }
  }

  return {
    success: false,
    code: qualityEvaluatorFailureCode(lastFailure),
    failureKind: lastFailure,
    message: lastError,
    attempts: maxAttempts
  }
}
