import axios from 'axios'
import { ModelAdapter, ModelRequest, ModelResponse, AdapterChatOptions } from './types'
import type { ProviderProtocol } from '../../shared/model-providers'
import { buildOpenAICompatibleBody } from '../../shared/kimi-api-params'
import { openAICompatibleAuthHeaders } from '../../shared/mimo-api-params'
import { appLogger } from '../logger/app-logger'
import { consumeSseStream, isAbortError, parseAxiosErrorMessage } from './stream-utils'

function normalizeFinishReason(value: unknown): ModelResponse['finishReason'] {
  const reason = String(value ?? '').toLowerCase()
  if (!reason) return undefined
  if (reason === 'stop' || reason === 'end_turn' || reason === 'stop_sequence') return 'stop'
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max_token') return 'length'
  if (reason.includes('safety') || reason.includes('content_filter')) return 'content_filter'
  if (reason.includes('tool')) return 'tool'
  return 'unknown'
}

interface OpenAICompatiblePayload {
  content: string
  reasoning?: string
  finishReason?: ModelResponse['finishReason']
  usage: {
    promptTokens: number
    completionTokens: number
  }
}

function responseShape(data: unknown): string {
  if (data == null) return String(data)
  if (Array.isArray(data)) return `array(length=${data.length})`
  if (typeof data !== 'object') return typeof data
  const record = data as Record<string, unknown>
  const keys = Object.keys(record).slice(0, 12).join(',') || 'none'
  const choices = Array.isArray(record.choices) ? record.choices.length : 'missing'
  return `keys=${keys}; choices=${choices}`
}

function upstreamErrorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const record = data as Record<string, unknown>
  const error = record.error
  if (typeof error === 'string' && error.trim()) return error.trim().replace(/\s+/g, ' ').slice(0, 500)
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim()) {
      return message.trim().replace(/\s+/g, ' ').slice(0, 500)
    }
  }
  const message = record.message
  if (typeof message === 'string' && message.trim()) {
    return message.trim().replace(/\s+/g, ' ').slice(0, 500)
  }
  return undefined
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => {
      if (typeof item === 'string') return item
      if (!item || typeof item !== 'object') return ''
      const text = (item as Record<string, unknown>).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

function parseOpenAICompatiblePayload(data: unknown, status?: number): OpenAICompatiblePayload {
  const record = data && typeof data === 'object'
    ? data as Record<string, unknown>
    : {}
  const choices = Array.isArray(record.choices) ? record.choices : []
  const firstChoice = choices[0] && typeof choices[0] === 'object'
    ? choices[0] as Record<string, unknown>
    : undefined
  const message = firstChoice?.message && typeof firstChoice.message === 'object'
    ? firstChoice.message as Record<string, unknown>
    : undefined
  const content = contentText(message?.content)
  if (!content.trim()) {
    const upstreamError = upstreamErrorMessage(data)
    const statusLabel = status ? `HTTP ${status}` : 'HTTP 2xx'
    throw new Error(
      upstreamError
        ? `OpenAI 兼容服务返回空正文（${statusLabel}）：${upstreamError}`
        : `OpenAI 兼容服务返回空正文（${statusLabel}；${responseShape(data)}）`
    )
  }

  const usage = record.usage && typeof record.usage === 'object'
    ? record.usage as Record<string, unknown>
    : {}
  const reasoning = contentText(message?.reasoning_content ?? message?.reasoning)
  return {
    content,
    reasoning: reasoning || undefined,
    finishReason: normalizeFinishReason(firstChoice?.finish_reason),
    usage: {
      promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
    }
  }
}

/**
 * OpenAI 兼容适配器
 * DeepSeek / OpenAI / 第三方中转均使用相同的 chat completions API 格式
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(
    public readonly protocol: ProviderProtocol = 'openai',
    private defaultModel = 'gpt-4o'
  ) {}

  async chat(
    request: ModelRequest,
    apiKey: string,
    apiBase: string,
    modelName?: string,
    options?: AdapterChatOptions
  ): Promise<ModelResponse> {
    const startTime = Date.now()
    const url = `${apiBase}/chat/completions`
    const resolvedModel = modelName || this.defaultModel
    const useStream = options?.stream !== false && !!options?.onDelta

    const messages: Array<{ role: string; content: string }> = []
    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }
    messages.push({ role: 'user', content: request.prompt })

    try {
      if (useStream) {
        return await this.chatStream(url, resolvedModel, messages, request, apiKey, startTime, options)
      }

      const body = buildOpenAICompatibleBody(resolvedModel, messages, request, { stream: false })
      if (request.responseSchema) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: request.responseSchema.name,
            strict: request.responseSchema.strict !== false,
            schema: request.responseSchema.schema
          }
        }
      }

      const requestOptions = {
          headers: openAICompatibleAuthHeaders(options?.modelType ?? 'openai', apiKey),
          timeout: 240000,
          signal: options?.signal
      }
      let response
      let schemaEnabled = !!request.responseSchema
      try {
        response = await axios.post(url, body, requestOptions)
      } catch (error: unknown) {
        const status = (error as { response?: { status?: number } }).response?.status
        if (!request.responseSchema || (status !== 400 && status !== 422)) throw error
        delete body.response_format
        schemaEnabled = false
        appLogger.warn('model', '提供商拒绝 JSON Schema，移除 response_format 后有限重试', {
          step: request.step,
          workId: request.workId,
          status
        })
        response = await axios.post(url, body, requestOptions)
      }

      let payload: OpenAICompatiblePayload
      try {
        payload = parseOpenAICompatiblePayload(response.data, response.status)
      } catch (error) {
        if (!schemaEnabled) throw error
        delete body.response_format
        schemaEnabled = false
        appLogger.warn('model', '结构化响应为空或不兼容，移除 JSON Schema 后有限重试', {
          step: request.step,
          workId: request.workId,
          reason: error instanceof Error ? error.message : String(error)
        })
        response = await axios.post(url, body, requestOptions)
        payload = parseOpenAICompatiblePayload(response.data, response.status)
      }

      if (payload.reasoning) {
        options?.onThinkingDelta?.(payload.reasoning)
      }

      return {
        success: true,
        content: payload.content,
        modelType: this.protocol,
        finishReason: payload.finishReason,
        usage: payload.usage,
        durationMs: Date.now() - startTime
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return {
          success: false,
          content: '',
          modelType: this.protocol,
          error: '已取消',
          cancelled: true,
          durationMs: Date.now() - startTime
        }
      }
      const axiosError = error as { response?: { data?: { error?: { message?: string } } }; message?: string }
      const errMsg = axiosError.response?.data?.error?.message
        ?? axiosError.message
        ?? '未知错误'

      return {
        success: false,
        content: '',
        modelType: this.protocol,
        error: errMsg,
        durationMs: Date.now() - startTime
      }
    }
  }

  private async chatStream(
    url: string,
    model: string,
    messages: Array<{ role: string; content: string }>,
    request: ModelRequest,
    apiKey: string,
    startTime: number,
    options?: AdapterChatOptions
  ): Promise<ModelResponse> {
    let content = ''
    let promptTokens = 0
    let completionTokens = 0
    let finishReason: ModelResponse['finishReason']

    try {
      const streamBody = buildOpenAICompatibleBody(model, messages, request, { stream: true })

      const response = await axios.post(
        url,
        streamBody,
        {
          headers: openAICompatibleAuthHeaders(options?.modelType ?? 'openai', apiKey),
          responseType: 'stream',
          timeout: 240000,
          signal: options?.signal
        }
      )

      await consumeSseStream(response.data, (data) => {
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ finish_reason?: string; delta?: { content?: string; reasoning_content?: string; reasoning?: string } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens ?? promptTokens
            completionTokens = parsed.usage.completion_tokens ?? completionTokens
          }
          const deltaObj = parsed.choices?.[0]?.delta
          finishReason = normalizeFinishReason(parsed.choices?.[0]?.finish_reason) ?? finishReason
          const thinkingDelta = deltaObj?.reasoning_content ?? deltaObj?.reasoning
          if (thinkingDelta) {
            options?.onThinkingDelta?.(thinkingDelta)
          }
          const delta = deltaObj?.content
          if (delta) {
            content += delta
            options?.onDelta?.(delta)
          }
        } catch {
          // ignore malformed chunk
        }
      }, options?.signal)

      if (!content.trim()) {
        return {
          success: false,
          content: '',
          modelType: this.protocol,
          error: 'OpenAI 兼容流式响应结束但未返回正文',
          finishReason,
          usage: { promptTokens, completionTokens },
          durationMs: Date.now() - startTime
        }
      }

      return {
        success: true,
        content,
        modelType: this.protocol,
        finishReason,
        usage: { promptTokens, completionTokens },
        durationMs: Date.now() - startTime
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return {
          success: false,
          content,
          modelType: this.protocol,
          error: '已取消',
          cancelled: true,
          durationMs: Date.now() - startTime
        }
      }
      const axiosError = error as { response?: { data?: { error?: { message?: string } } }; message?: string }
      const errMsg = axiosError.response?.data?.error?.message
        ?? axiosError.message
        ?? '未知错误'
      return {
        success: false,
        content,
        modelType: this.protocol,
        error: errMsg,
        durationMs: Date.now() - startTime
      }
    }
  }
}

type GeminiContentPart = { text?: string; thought?: boolean }

/** Gemini 2.5+ / 3.x 支持思考摘要；1.5 等旧模型传入 thinkingConfig 可能 400 */
function geminiSupportsThoughtSummaries(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    /gemini-2\.5/.test(normalized) ||
    /gemini-3/.test(normalized) ||
    normalized.includes('thinking')
  )
}

function dispatchGeminiParts(
  parts: GeminiContentPart[] | undefined,
  handlers: {
    onThinkingDelta?: (delta: string) => void
    onDelta?: (delta: string) => void
    appendContent?: (text: string) => void
    appendThinking?: (text: string) => void
  }
): void {
  for (const part of parts ?? []) {
    if (!part.text) continue
    if (part.thought) {
      handlers.appendThinking?.(part.text)
      handlers.onThinkingDelta?.(part.text)
    } else {
      handlers.appendContent?.(part.text)
      handlers.onDelta?.(part.text)
    }
  }
}

/**
 * Google Gemini 适配器
 */
function buildGeminiRequestBody(
  request: ModelRequest,
  options?: { model?: string; includeThoughts?: boolean }
): Record<string, unknown> {
  const genConfig: Record<string, unknown> = {
    maxOutputTokens: request.maxTokens ?? 4096,
    temperature: request.temperature ?? 0.7
  }
  if (request.topP != null) genConfig.topP = request.topP
  if (request.responseSchema) {
    genConfig.responseMimeType = 'application/json'
    genConfig.responseJsonSchema = request.responseSchema.schema
  }
  // Gemini 多数模型不支持 frequencyPenalty / presencePenalty，传入会触发 400
  const model = options?.model ?? ''
  if (geminiSupportsThoughtSummaries(model)) {
    if (request.thinkingEnabled === false) {
      genConfig.thinkingConfig = { thinkingBudget: 0 }
    } else if (options?.includeThoughts) {
      genConfig.thinkingConfig = { thinkingBudget: 2048, includeThoughts: true }
    }
  }

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
    generationConfig: genConfig
  }

  if (request.systemPrompt) {
    body.systemInstruction = { parts: [{ text: request.systemPrompt }] }
  }

  return body
}

export class GeminiAdapter implements ModelAdapter {
  public readonly protocol: ProviderProtocol = 'gemini'
  private readonly defaultModel = 'gemini-1.5-pro'

  async chat(
    request: ModelRequest,
    apiKey: string,
    _apiBase: string,
    modelName?: string,
    options?: AdapterChatOptions
  ): Promise<ModelResponse> {
    const startTime = Date.now()
    const model = modelName || this.defaultModel
    const useStream = options?.stream !== false && !!options?.onDelta
    const body = buildGeminiRequestBody(request, {
      model,
      includeThoughts: !!options?.onThinkingDelta
    })

    try {
      if (useStream) {
        return await this.chatStream(model, apiKey, body, startTime, options)
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const requestOptions = {
        headers: { 'Content-Type': 'application/json' },
        timeout: 240000,
        signal: options?.signal
      }
      let response
      try {
        response = await axios.post(url, body, requestOptions)
      } catch (error: unknown) {
        const status = (error as { response?: { status?: number } }).response?.status
        if (!request.responseSchema || (status !== 400 && status !== 422)) throw error
        const generationConfig = body.generationConfig as Record<string, unknown> | undefined
        if (generationConfig) {
          delete generationConfig.responseMimeType
          delete generationConfig.responseJsonSchema
        }
        response = await axios.post(url, body, requestOptions)
      }

      const data = response.data
      let content = ''
      dispatchGeminiParts(data.candidates?.[0]?.content?.parts as GeminiContentPart[] | undefined, {
        onThinkingDelta: options?.onThinkingDelta,
        appendContent: (text) => { content += text }
      })

      return {
        success: true,
        content,
        modelType: 'gemini',
        finishReason: normalizeFinishReason(data.candidates?.[0]?.finishReason),
        usage: {
          promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
          completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0
        },
        durationMs: Date.now() - startTime
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return {
          success: false,
          content: '',
          modelType: 'gemini',
          error: '已取消',
          cancelled: true,
          durationMs: Date.now() - startTime
        }
      }
      const errMsg = await parseAxiosErrorMessage(error)

      return {
        success: false,
        content: '',
        modelType: 'gemini',
        error: errMsg,
        durationMs: Date.now() - startTime
      }
    }
  }

  private async chatStream(
    model: string,
    apiKey: string,
    body: Record<string, unknown>,
    startTime: number,
    options?: AdapterChatOptions
  ): Promise<ModelResponse> {
    let content = ''
    let finishReason: ModelResponse['finishReason']
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`

    try {
      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: 240000,
        signal: options?.signal
      })

      await consumeSseStream(response.data, (data) => {
        try {
          const parsed = JSON.parse(data) as {
            candidates?: Array<{ finishReason?: string; content?: { parts?: GeminiContentPart[] } }> | null
          }
          finishReason = normalizeFinishReason(parsed.candidates?.[0]?.finishReason) ?? finishReason
          // 思考阶段部分 chunk 的 candidates 为 null，跳过即可
          dispatchGeminiParts(parsed.candidates?.[0]?.content?.parts, {
            onThinkingDelta: options?.onThinkingDelta,
            onDelta: options?.onDelta,
            appendContent: (text) => { content += text }
          })
        } catch {
          // ignore malformed chunk
        }
      }, options?.signal)

      return {
        success: true,
        content,
        modelType: 'gemini',
        finishReason,
        durationMs: Date.now() - startTime
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return {
          success: false,
          content,
          modelType: 'gemini',
          error: '已取消',
          cancelled: true,
          durationMs: Date.now() - startTime
        }
      }
      const errMsg = await parseAxiosErrorMessage(error)
      return {
        success: false,
        content,
        modelType: 'gemini',
        error: errMsg,
        durationMs: Date.now() - startTime
      }
    }
  }
}

export function createOpenAIAdapter(): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter('openai', 'gpt-4o')
}

export function createGeminiAdapter(): GeminiAdapter {
  return new GeminiAdapter()
}

/**
 * Anthropic Messages API 适配器
 */
export class AnthropicAdapter implements ModelAdapter {
  public readonly protocol: ProviderProtocol = 'anthropic'
  private readonly defaultModel = 'claude-sonnet-4-20250514'

  async chat(
    request: ModelRequest,
    apiKey: string,
    apiBase: string,
    modelName?: string,
    options?: AdapterChatOptions
  ): Promise<ModelResponse> {
    const startTime = Date.now()
    const base = (apiBase || 'https://api.anthropic.com/v1').replace(/\/$/, '')
    const url = `${base}/messages`
    const resolvedModel = modelName || this.defaultModel
    const useStream = options?.stream !== false && !!options?.onDelta

    const body: Record<string, unknown> = {
      model: resolvedModel,
      max_tokens: request.maxTokens ?? 4096,
      messages: [{ role: 'user', content: request.prompt }]
    }
    if (request.systemPrompt) body.system = request.systemPrompt
    if (request.temperature != null) body.temperature = request.temperature
    if (request.topP != null) body.top_p = request.topP

    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    }

    try {
      if (useStream) {
        return await this.chatStream(url, body, headers, startTime, options)
      }

      const response = await axios.post(url, body, {
        headers,
        timeout: 240000,
        signal: options?.signal
      })

      const data = response.data as {
        content?: Array<{ type?: string; text?: string }>
        usage?: { input_tokens?: number; output_tokens?: number }
        stop_reason?: string
      }
      const content = (data.content ?? [])
        .filter(block => block.type === 'text' || !block.type)
        .map(block => block.text ?? '')
        .join('')

      return {
        success: true,
        content,
        modelType: 'anthropic',
        finishReason: normalizeFinishReason(data.stop_reason),
        usage: {
          promptTokens: data.usage?.input_tokens ?? 0,
          completionTokens: data.usage?.output_tokens ?? 0
        },
        durationMs: Date.now() - startTime
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return {
          success: false,
          content: '',
          modelType: 'anthropic',
          error: '已取消',
          cancelled: true,
          durationMs: Date.now() - startTime
        }
      }
      const axiosError = error as { response?: { data?: { error?: { message?: string } } }; message?: string }
      const errMsg = axiosError.response?.data?.error?.message
        ?? axiosError.message
        ?? '未知错误'
      return {
        success: false,
        content: '',
        modelType: 'anthropic',
        error: errMsg,
        durationMs: Date.now() - startTime
      }
    }
  }

  private async chatStream(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    startTime: number,
    options?: AdapterChatOptions
  ): Promise<ModelResponse> {
    let content = ''
    let promptTokens = 0
    let completionTokens = 0
    let finishReason: ModelResponse['finishReason']

    try {
      const response = await axios.post(url, { ...body, stream: true }, {
        headers,
        responseType: 'stream',
        timeout: 240000,
        signal: options?.signal
      })

      await consumeSseStream(response.data, (data) => {
        try {
          const parsed = JSON.parse(data) as {
            type?: string
            delta?: { type?: string; text?: string; stop_reason?: string }
            message?: { usage?: { input_tokens?: number; output_tokens?: number } }
            usage?: { input_tokens?: number; output_tokens?: number }
          }
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            content += parsed.delta.text
            options?.onDelta?.(parsed.delta.text)
          }
          finishReason = normalizeFinishReason(parsed.delta?.stop_reason) ?? finishReason
          const usage = parsed.usage ?? parsed.message?.usage
          if (usage) {
            promptTokens = usage.input_tokens ?? promptTokens
            completionTokens = usage.output_tokens ?? completionTokens
          }
        } catch {
          // ignore malformed chunk
        }
      }, options?.signal)

      return {
        success: true,
        content,
        modelType: 'anthropic',
        finishReason,
        usage: { promptTokens, completionTokens },
        durationMs: Date.now() - startTime
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return {
          success: false,
          content,
          modelType: 'anthropic',
          error: '已取消',
          cancelled: true,
          durationMs: Date.now() - startTime
        }
      }
      const axiosError = error as { response?: { data?: { error?: { message?: string } } }; message?: string }
      const errMsg = axiosError.response?.data?.error?.message
        ?? axiosError.message
        ?? '未知错误'
      return {
        success: false,
        content,
        modelType: 'anthropic',
        error: errMsg,
        durationMs: Date.now() - startTime
      }
    }
  }
}

export function createAnthropicAdapter(): AnthropicAdapter {
  return new AnthropicAdapter()
}

const protocolAdapters: Record<ProviderProtocol, ModelAdapter> = {
  openai: createOpenAIAdapter(),
  gemini: createGeminiAdapter(),
  anthropic: createAnthropicAdapter()
}

export function getAdapterForProtocol(protocol: ProviderProtocol): ModelAdapter {
  return protocolAdapters[protocol]
}
