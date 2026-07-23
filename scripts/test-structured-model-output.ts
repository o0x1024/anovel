import assert from 'node:assert/strict'
import { requestStructuredModelOutput } from '../src/main/context/goal-routine/structured-model-output'

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
