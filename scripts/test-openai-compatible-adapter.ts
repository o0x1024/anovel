import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import axios from 'axios'
import { appLogger } from '../src/main/logger/app-logger'
import { OpenAICompatibleAdapter } from '../src/main/model/adapters'
import { buildPromptJsonSchemaInstruction } from '../src/shared/prompt-json-schema'

type AxiosPost = typeof axios.post

async function main(): Promise<void> {
  const originalPost = axios.post
  const originalWarn = appLogger.warn
  const adapter = new OpenAICompatibleAdapter('openai', 'test-model')
  appLogger.warn = () => {}

  try {
    const bodies: Array<Record<string, unknown>> = []
    let call = 0
    axios.post = (async (_url: string, body: Record<string, unknown>) => {
      bodies.push(structuredClone(body))
      call++
      if (call === 1) {
        return {
          status: 200,
          data: { code: 'UPSTREAM_EMPTY', message: 'structured output unavailable' }
        }
      }
      return {
        status: 200,
        data: {
          choices: [{
            message: { content: '{"chapters":[]}' },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 12, completion_tokens: 5 }
        }
      }
    }) as AxiosPost

    const incompatibleStructured = await adapter.chat({
      prompt: 'repair',
      step: 'story_repair_blueprint',
      responseSchema: {
        name: 'story_structural_repair',
        schema: { type: 'object' }
      },
      structuredOutputMode: 'native_json_schema',
      requireResponseSchema: true
    }, 'test-key', 'https://example.invalid/v1', 'test-model', { stream: false })

    assert.equal(incompatibleStructured.success, false)
    assert.match(incompatibleStructured.error ?? '', /UPSTREAM_EMPTY|structured output unavailable/)
    assert.equal(call, 1)
    assert.ok(bodies[0].response_format)

    call = 0
    axios.post = (async () => {
      call++
      const error = new Error('request failed') as Error & {
        response?: { status: number; data: { error: { message: string } } }
      }
      error.response = {
        status: 400,
        data: { error: { message: 'This response_format type is unavailable now' } }
      }
      throw error
    }) as AxiosPost

    const strictSchemaFailure = await adapter.chat({
      prompt: 'state transaction',
      step: 'emotion_state_extract',
      responseSchema: {
        name: 'emotion_ledger',
        schema: { type: 'object' }
      },
      structuredOutputMode: 'native_json_schema',
      requireResponseSchema: true
    }, 'test-key', 'https://example.invalid/v1', 'test-model', { stream: false })

    assert.equal(strictSchemaFailure.success, false)
    assert.match(strictSchemaFailure.error ?? '', /MODEL_CAPABILITY_UNSUPPORTED/)
    assert.match(strictSchemaFailure.error ?? '', /情绪状态提取/)
    assert.match(strictSchemaFailure.error ?? '', /test-model/)
    assert.match(strictSchemaFailure.error ?? '', /This response_format type is unavailable now/)
    assert.equal(call, 1)

    const promptSchema = {
      name: 'prompt_json_test',
      schema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } }
      }
    }
    assert.match(buildPromptJsonSchemaInstruction(promptSchema), /required/)

    call = 0
    axios.post = (async (_url: string, body: Record<string, unknown>) => {
      call++
      bodies.push(structuredClone(body))
      return {
        status: 200,
        data: {
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }]
        }
      }
    }) as AxiosPost
    const promptJson = await adapter.chat({
      prompt: 'prompt-only json',
      responseSchema: promptSchema,
      structuredOutputMode: 'prompt_json'
    }, 'test-key', 'https://example.invalid/v1', 'deepseek-v4-flash', { stream: false })
    assert.equal(promptJson.success, true)
    assert.equal(call, 1)
    assert.equal(bodies.at(-1)?.response_format, undefined)

    call = 0
    axios.post = (async () => {
      call++
      return {
        status: 200,
        data: call === 1
          ? { choices: [] }
          : { error: { message: 'upstream route returned no candidate' } }
      }
    }) as AxiosPost

    const rejected = await adapter.chat({
      prompt: 'repair',
      step: 'story_repair_blueprint',
      responseSchema: {
        name: 'story_structural_repair',
        schema: { type: 'object' }
      }
    }, 'test-key', 'https://example.invalid/v1', 'test-model', { stream: false })

    assert.equal(rejected.success, false)
    assert.match(rejected.error ?? '', /choices=0/)
    assert.equal(call, 1)

    call = 0
    axios.post = (async () => {
      call++
      return { status: 200, data: { choices: [] } }
    }) as AxiosPost

    const plainEmpty = await adapter.chat(
      { prompt: 'plain request' },
      'test-key',
      'https://example.invalid/v1',
      'test-model',
      { stream: false }
    )
    assert.equal(plainEmpty.success, false)
    assert.match(plainEmpty.error ?? '', /choices=0/)
    assert.equal(call, 1)

    call = 0
    axios.post = (async (_url: string, body: Record<string, unknown>) => {
      bodies.push(structuredClone(body))
      call++
      return call === 1
        ? {
            status: 200,
            data: {
              choices: [{
                message: { content: '', reasoning_content: 'internal reasoning' },
                finish_reason: 'length'
              }],
              usage: { completion_tokens: 1200 }
            }
          }
        : {
            status: 200,
            data: {
              choices: [{ text: 'recovered plain text', finish_reason: 'stop' }],
              usage: { completion_tokens: 4 }
            }
          }
    }) as AxiosPost

    const emptyReasoningOnly = await adapter.chat(
      { prompt: 'plain retry', thinkingEnabled: false },
      'test-key',
      'https://example.invalid/v1',
      'deepseek/deepseek-v4-flash',
      { stream: false }
    )
    assert.equal(emptyReasoningOnly.success, false)
    assert.match(emptyReasoningOnly.error ?? '', /正文为空|未返回正文|finishReason=length/)
    assert.equal(call, 1)
    assert.deepEqual(bodies.at(-1)?.thinking, { type: 'disabled' })

    axios.post = (async (_url: string, body: Record<string, unknown>) => {
      bodies.push(structuredClone(body))
      return {
        status: 200,
        data: {
          choices: [{
            message: {
              content: '{"score_total":88}',
              reasoning_content: 'quality diagnosis reasoning'
            },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 20, completion_tokens: 10 }
        }
      }
    }) as AxiosPost

    let diagnosisThinking = ''
    const thinkingEnabledDiagnosis = await adapter.chat(
      {
        prompt: 'quality diagnosis',
        thinkingEnabled: true,
        temperature: 0.1,
        deepseekOptions: {
          thinkingEnabled: false,
          reasoningEffort: 'max'
        }
      },
      'test-key',
      'https://example.invalid/v1',
      'deepseek-v4-pro',
      {
        stream: false,
        onThinkingDelta: delta => { diagnosisThinking += delta }
      }
    )
    assert.equal(thinkingEnabledDiagnosis.success, true)
    assert.deepEqual(bodies.at(-1)?.thinking, { type: 'enabled' })
    assert.equal(bodies.at(-1)?.reasoning_effort, 'max')
    assert.equal(bodies.at(-1)?.temperature, undefined)
    assert.equal(diagnosisThinking, 'quality diagnosis reasoning')

    axios.post = (async () => ({
      status: 200,
      data: {
        choices: [{
          message: {
            content: [
              { type: 'text', text: '{"ok":' },
              { type: 'text', text: 'true}' }
            ]
          },
          finish_reason: 'stop'
        }]
      }
    })) as AxiosPost

    const blockContent = await adapter.chat(
      { prompt: 'blocks' },
      'test-key',
      'https://example.invalid/v1',
      'test-model',
      { stream: false }
    )
    assert.equal(blockContent.success, true)
    assert.equal(blockContent.content, '{"ok":true}')

    axios.post = (async () => ({
      status: 200,
      data: Readable.from(['data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n', 'data: [DONE]\n\n'])
    })) as AxiosPost

    const emptyStream = await adapter.chat(
      { prompt: 'stream' },
      'test-key',
      'https://example.invalid/v1',
      'test-model',
      { onDelta: () => {} }
    )
    assert.equal(emptyStream.success, false)
    assert.match(emptyStream.error ?? '', /流式响应结束但未返回正文/)

    let observedTimeout: number | undefined
    axios.post = (async (
      _url: string,
      _body: Record<string, unknown>,
      config?: { timeout?: number }
    ) => {
      observedTimeout = config?.timeout
      return {
        status: 200,
        data: {
          choices: [{ message: { content: '{"score_total":88}' }, finish_reason: 'stop' }]
        }
      }
    }) as AxiosPost

    const bounded = await adapter.chat(
      { prompt: 'bounded evaluator', timeoutMs: 120_000 },
      'test-key',
      'https://example.invalid/v1',
      'test-model',
      { stream: false }
    )
    assert.equal(bounded.success, true)
    assert.equal(observedTimeout, 120_000)

    console.log('OpenAI compatible adapter response validation tests passed')
  } finally {
    axios.post = originalPost
    appLogger.warn = originalWarn
  }
}

void main()
