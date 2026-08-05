import assert from 'node:assert/strict'
import {
  QualityEvaluatorFailureError,
  requestQualityEvaluatorEvidence,
  requireQualityEvaluatorEvidence,
  type QualityEvaluatorResponse
} from '../src/main/context/goal-routine/quality-evaluator-policy'

async function main(): Promise<void> {
  const retryKinds: string[] = []
  const transportThenSuccess: QualityEvaluatorResponse[] = [
    { success: false, error: 'timeout of 240000ms exceeded' },
    { success: true, content: '{"hard_blockers":[]}' }
  ]
  const recovered = await requestQualityEvaluatorEvidence({
    request: async () => transportThenSuccess.shift()!,
    parse: content => JSON.parse(content) as { hard_blockers: unknown[] },
    onRetry: retry => retryKinds.push(retry.failureKind)
  })
  assert.equal(recovered.success, true)
  assert.equal(recovered.attempts, 2)
  assert.deepEqual(retryKinds, ['timeout'])

  let thrownAttempts = 0
  const thrownThenSuccess = await requestQualityEvaluatorEvidence({
    request: async () => {
      thrownAttempts++
      if (thrownAttempts === 1) throw new Error('ETIMEDOUT')
      return { success: true, content: '{"hard_blockers":[]}' }
    },
    parse: content => JSON.parse(content) as { hard_blockers: unknown[] }
  })
  assert.equal(thrownThenSuccess.success, true)
  assert.equal(thrownThenSuccess.attempts, 2)

  const unavailable = await requestQualityEvaluatorEvidence({
    request: async () => ({ success: false, error: 'ECONNRESET' }),
    parse: content => JSON.parse(content)
  })
  assert.equal(unavailable.success, false)
  if (!unavailable.success) {
    assert.equal(unavailable.code, 'QUALITY_EVALUATOR_UNAVAILABLE')
    assert.equal(unavailable.failureKind, 'transport')
    assert.equal(unavailable.attempts, 2)
  }
  assert.throws(
    () => requireQualityEvaluatorEvidence(unavailable, '测试评估器'),
    error => error instanceof QualityEvaluatorFailureError
      && error.code === 'QUALITY_EVALUATOR_UNAVAILABLE'
      && error.attempts === 2
  )

  const protocolFailure = await requestQualityEvaluatorEvidence({
    request: async () => ({ success: true, content: '{"wrong_field":[]}' }),
    parse: content => {
      const parsed = JSON.parse(content) as Record<string, unknown>
      if (!Array.isArray(parsed.hard_blockers)) {
        throw new Error('整篇法医审计缺少 hard_blockers 数组')
      }
      return parsed
    }
  })
  assert.equal(protocolFailure.success, false)
  if (!protocolFailure.success) {
    assert.equal(protocolFailure.code, 'QUALITY_EVALUATOR_PROTOCOL')
    assert.equal(protocolFailure.failureKind, 'protocol')
    assert.equal(protocolFailure.attempts, 2)
  }
  assert.throws(
    () => requireQualityEvaluatorEvidence(protocolFailure, '测试协议评估器'),
    error => error instanceof QualityEvaluatorFailureError
      && error.code === 'QUALITY_EVALUATOR_PROTOCOL'
  )

  const reasoningBudgetFailure = await requestQualityEvaluatorEvidence({
    request: async () => ({
      success: false,
      error: 'HTTP 200；finishReason=length；正文为空；completionTokens=15360'
    }),
    parse: content => JSON.parse(content)
  })
  assert.equal(reasoningBudgetFailure.success, false)
  if (!reasoningBudgetFailure.success) {
    assert.equal(reasoningBudgetFailure.code, 'QUALITY_EVALUATOR_PROTOCOL')
    assert.equal(reasoningBudgetFailure.failureKind, 'protocol')
  }

  await assert.rejects(
    requestQualityEvaluatorEvidence({
      request: async () => ({ success: false, cancelled: true, error: '已取消' }),
      parse: content => JSON.parse(content)
    }),
    /已取消/
  )

  console.log('quality evaluator policy tests passed')
}

void main()
