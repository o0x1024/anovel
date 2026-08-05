import assert from 'node:assert/strict'
import {
  parseStructuredModelContent,
  requestStructuredModelOutput
} from '../src/main/context/goal-routine/structured-model-output'
import { classifyWorkflowError } from '../src/main/workflow/workflow-errors'

async function main(): Promise<void> {
  let calls = 0
  const recovered = await requestStructuredModelOutput<{ ok: boolean }>({
    workId: 1,
    label: '测试结构化调用',
    log: false,
    attempts: 2,
    request: async () => {
      calls++
      return calls === 1
        ? { success: true, content: '{"ok":', finishReason: 'length' }
        : { success: true, content: '{"ok":true}', finishReason: 'stop' }
    }
  })
  assert.equal(calls, 2)
  assert.equal(recovered.ok, true)

  const repaired = await requestStructuredModelOutput<{ ok: boolean }>({
    workId: 1,
    label: '测试闭合修复',
    log: false,
    request: async () => ({ success: true, content: '{"ok":true', finishReason: 'stop' })
  })
  assert.equal(repaired.ok, true)

  const parsedDirectly = parseStructuredModelContent<{ ok: boolean }>({
    content: '{"ok":true',
    validate: value => ({ ok: value.ok === true })
  })
  assert.equal(parsedDirectly.value.ok, true)
  assert.ok(parsedDirectly.repairs.length > 0)

  const emptyGateResult = await requestStructuredModelOutput<{ blockers: unknown[] }>({
    workId: 1,
    label: '测试空门禁结果',
    log: false,
    request: async () => ({
      success: true,
      content: '```json\n{"blockers":[]}\n```',
      finishReason: 'stop'
    })
  })
  assert.deepEqual(emptyGateResult.blockers, [])

  const fencedNestedEvidence = await requestStructuredModelOutput<{
    readerEffect: { claim: string; evidenceIds: string[] }
  }>({
    workId: 1,
    label: '测试嵌套证据围栏结果',
    log: false,
    request: async () => ({
      success: true,
      content: [
        '```json',
        JSON.stringify({
          readerEffect: {
            claim: '正文已经造成紧张感',
            evidenceIds: ['e0001', 'e0002']
          }
        }),
        '```'
      ].join('\n'),
      finishReason: 'stop'
    })
  })
  assert.deepEqual(fencedNestedEvidence.readerEffect.evidenceIds, ['e0001', 'e0002'])

  const fencedScalarObject = parseStructuredModelContent<{ ok: boolean }>({
    content: ['```json', '{"ok":true}', '```'].join('\n')
  })
  assert.equal(fencedScalarObject.value.ok, true)

  let capabilityCalls = 0
  await assert.rejects(
    requestStructuredModelOutput({
      workId: 1,
      label: '测试模型能力门禁',
      log: false,
      attempts: 2,
      request: async () => {
        capabilityCalls++
        return {
          success: false,
          content: '',
          error: 'MODEL_CAPABILITY_UNSUPPORTED: 当前模型不支持原生 JSON Schema'
        }
      }
    }),
    /MODEL_CAPABILITY_UNSUPPORTED/
  )
  assert.equal(capabilityCalls, 1)
  assert.deepEqual(
    classifyWorkflowError(new Error(
      'MODEL_CAPABILITY_UNSUPPORTED: 当前模型不支持原生 JSON Schema'
    )),
    {
      errorClass: 'user_action_required',
      code: 'MODEL_CAPABILITY_UNSUPPORTED',
      message: 'MODEL_CAPABILITY_UNSUPPORTED: 当前模型不支持原生 JSON Schema',
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  )

  let validationCalls = 0
  let retryReason = ''
  const locallyValidated = await requestStructuredModelOutput<{ evidenceIds: string[] }>({
    workId: 1,
    label: '测试本地协议校验重取',
    log: false,
    attempts: 2,
    request: async (_attempt, lastError) => {
      validationCalls++
      retryReason = lastError
      return {
        success: true,
        content: validationCalls === 1
          ? JSON.stringify({ evidenceIds: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'] })
          : JSON.stringify({ evidenceIds: ['e1', 'e2', 'e3'] }),
        finishReason: 'stop'
      }
    },
    validate: value => {
      const evidenceIds = Array.isArray(value.evidenceIds)
        ? value.evidenceIds.map(String)
        : []
      if (evidenceIds.length < 1 || evidenceIds.length > 6) {
        throw new Error('evidenceIds 需要 1-6 个正文证据 ID')
      }
      return { evidenceIds }
    }
  })
  assert.equal(validationCalls, 2)
  assert.match(retryReason, /evidenceIds 需要 1-6/)
  assert.deepEqual(locallyValidated.evidenceIds, ['e1', 'e2', 'e3'])

  const failedAttempts: Array<{ attempt: number; error: string }> = []
  let callbackCalls = 0
  const callbackRecovered = await requestStructuredModelOutput<{ ok: boolean }>({
    workId: 1,
    label: '测试失败回调',
    log: false,
    attempts: 2,
    request: async () => {
      callbackCalls++
      return callbackCalls === 1
        ? { success: true, content: '{"ok":', finishReason: 'length' }
        : { success: true, content: '{"ok":true}', finishReason: 'stop' }
    },
    onAttemptFailure: ({ attempt, error }) => failedAttempts.push({ attempt, error })
  })
  assert.equal(callbackRecovered.ok, true)
  assert.equal(failedAttempts.length, 1)
  assert.equal(failedAttempts[0].attempt, 1)
  assert.match(failedAttempts[0].error, /finishReason=length/)

  let schemaCalls = 0
  const schemaValidated = await requestStructuredModelOutput<{
    source: { claim: string; evidenceIds: string[] }
  }>({
    workId: 1,
    label: '测试 prompt_json 本地 Schema',
    log: false,
    attempts: 2,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['source'],
      properties: {
        source: {
          type: 'object',
          additionalProperties: false,
          required: ['claim', 'evidenceIds'],
          properties: {
            claim: { type: 'string', minLength: 1 },
            evidenceIds: { type: 'array', minItems: 1, items: { type: 'string' } }
          }
        }
      }
    },
    request: async () => {
      schemaCalls++
      return {
        success: true,
        content: JSON.stringify(schemaCalls === 1
          ? { source: '被压平的字符串' }
          : { source: { claim: '楼道脚步声', evidenceIds: ['e0103'] } }),
        finishReason: 'stop'
      }
    }
  })
  assert.equal(schemaCalls, 2)
  assert.deepEqual(schemaValidated.source.evidenceIds, ['e0103'])

  let deterministicCalls = 0
  await assert.rejects(
    requestStructuredModelOutput({
      workId: 1,
      label: '测试确定性协议错误',
      log: false,
      attempts: 2,
      request: async () => {
        deterministicCalls++
        return {
          success: true,
          content: JSON.stringify({ evidenceIds: ['e1', 'e2', 'e3', 'e4', 'e5'] }),
          finishReason: 'stop'
        }
      },
      shouldRetryError: error => !(error instanceof Error && /需要拆分结论/.test(error.message)),
      validate: () => {
        throw new Error('单条原子结论包含 5 个证据，需要拆分结论')
      }
    }),
    /需要拆分结论/
  )
  assert.equal(deterministicCalls, 1)

  let atomizationSourceCalls = 0
  let atomizationRepairCalls = 0
  const atomized = await requestStructuredModelOutput<{ evidenceIds: string[] }>({
    workId: 1,
    label: '测试定向原子化修复',
    log: false,
    attempts: 2,
    request: async () => {
      atomizationSourceCalls++
      return {
        success: true,
        content: JSON.stringify({ evidenceIds: ['e1', 'e2', 'e3', 'e4', 'e5'] }),
        finishReason: 'stop'
      }
    },
    validate: value => {
      const evidenceIds = Array.isArray(value.evidenceIds)
        ? value.evidenceIds.map(String)
        : []
      if (evidenceIds.length > 4) throw new Error('需要拆分结论')
      return { evidenceIds }
    },
    repairValidationError: async ({ value, error, attempt }) => {
      atomizationRepairCalls++
      assert.deepEqual(value.evidenceIds, ['e1', 'e2', 'e3', 'e4', 'e5'])
      assert.match(error instanceof Error ? error.message : String(error), /需要拆分结论/)
      assert.equal(attempt, 1)
      return { evidenceIds: ['e1', 'e2', 'e3'] }
    }
  })
  assert.equal(atomizationSourceCalls, 1)
  assert.equal(atomizationRepairCalls, 1)
  assert.deepEqual(atomized.evidenceIds, ['e1', 'e2', 'e3'])

  await assert.rejects(
    requestStructuredModelOutput({
      workId: 1,
      label: '测试持续截断',
      log: false,
      attempts: 2,
      request: async () => ({ success: true, content: '{"ok":', finishReason: 'length' })
    }),
    /连续 2 次结构化输出无效/
  )

  console.log('structured model output retry tests passed')
}

void main()
