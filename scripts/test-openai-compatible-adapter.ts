import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import axios from 'axios'
import { appLogger } from '../src/main/logger/app-logger'
import { OpenAICompatibleAdapter } from '../src/main/model/adapters'

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

    const recovered = await adapter.chat({
      prompt: 'repair',
      step: 'story_repair_blueprint',
      responseSchema: {
        name: 'story_structural_repair',
        schema: { type: 'object' }
      }
    }, 'test-key', 'https://example.invalid/v1', 'test-model', { stream: false })

    assert.equal(recovered.success, true)
    assert.equal(recovered.content, '{"chapters":[]}')
    assert.equal(call, 2)
    assert.ok(bodies[0].response_format)
    assert.equal(bodies[1].response_format, undefined)

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
    assert.match(rejected.error ?? '', /upstream route returned no candidate/)
    assert.equal(call, 2)

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

    console.log('OpenAI compatible adapter response validation tests passed')
  } finally {
    axios.post = originalPost
    appLogger.warn = originalWarn
  }
}

void main()
