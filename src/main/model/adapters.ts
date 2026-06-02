import axios from 'axios'
import { ModelAdapter, ModelRequest, ModelResponse, ModelType, AdapterChatOptions } from './types'
import { consumeSseStream, isAbortError } from './stream-utils'

/**
 * OpenAI 兼容适配器
 * DeepSeek 与 OpenAI 均使用相同的 chat completions API 格式
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  constructor(
    public readonly type: ModelType,
    private defaultModel: string
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

      const body: Record<string, unknown> = {
        model: resolvedModel,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
        stream: false
      }
      if (request.frequencyPenalty != null) body.frequency_penalty = request.frequencyPenalty
      if (request.presencePenalty != null) body.presence_penalty = request.presencePenalty
      if (request.topP != null) body.top_p = request.topP

      const response = await axios.post(
        url,
        body,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 120000,
          signal: options?.signal
        }
      )

      const data = response.data
      const message = data.choices?.[0]?.message as {
        content?: string
        reasoning_content?: string
        reasoning?: string
      } | undefined
      const content = message?.content ?? ''
      const reasoning = message?.reasoning_content ?? message?.reasoning
      if (reasoning) {
        options?.onThinkingDelta?.(reasoning)
      }

      return {
        success: true,
        content,
        modelType: this.type,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? 0,
          completionTokens: data.usage?.completion_tokens ?? 0
        },
        durationMs: Date.now() - startTime
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return {
          success: false,
          content: '',
          modelType: this.type,
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
        modelType: this.type,
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

    try {
      const streamBody: Record<string, unknown> = {
        model,
        messages,
        max_tokens: request.maxTokens ?? 4096,
        temperature: request.temperature ?? 0.7,
        stream: true,
        stream_options: { include_usage: true }
      }
      if (request.frequencyPenalty != null) streamBody.frequency_penalty = request.frequencyPenalty
      if (request.presencePenalty != null) streamBody.presence_penalty = request.presencePenalty
      if (request.topP != null) streamBody.top_p = request.topP

      const response = await axios.post(
        url,
        streamBody,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          responseType: 'stream',
          timeout: 120000,
          signal: options?.signal
        }
      )

      await consumeSseStream(response.data, (data) => {
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
          }
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens ?? promptTokens
            completionTokens = parsed.usage.completion_tokens ?? completionTokens
          }
          const deltaObj = parsed.choices?.[0]?.delta
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

      return {
        success: true,
        content,
        modelType: this.type,
        usage: { promptTokens, completionTokens },
        durationMs: Date.now() - startTime
      }
    } catch (error: unknown) {
      if (isAbortError(error)) {
        return {
          success: false,
          content,
          modelType: this.type,
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
        modelType: this.type,
        error: errMsg,
        durationMs: Date.now() - startTime
      }
    }
  }
}

/**
 * Google Gemini 适配器
 */
export class GeminiAdapter implements ModelAdapter {
  public readonly type: ModelType = 'gemini'
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

    const genConfig: Record<string, unknown> = {
      maxOutputTokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7
    }
    if (request.topP != null) genConfig.topP = request.topP
    if (request.frequencyPenalty != null) genConfig.frequencyPenalty = request.frequencyPenalty
    if (request.presencePenalty != null) genConfig.presencePenalty = request.presencePenalty

    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
      generationConfig: genConfig
    }

    if (request.systemPrompt) {
      body.system_instruction = { parts: [{ text: request.systemPrompt }] }
    }

    try {
      if (useStream) {
        return await this.chatStream(model, apiKey, body, startTime, options)
      }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 120000,
        signal: options?.signal
      })

      const data = response.data
      const parts = data.candidates?.[0]?.content?.parts as Array<{ text?: string; thought?: boolean }> | undefined
      let content = ''
      let thinking = ''
      for (const part of parts ?? []) {
        if (!part.text) continue
        if (part.thought) thinking += part.text
        else content += part.text
      }
      if (thinking) {
        options?.onThinkingDelta?.(thinking)
      }

      return {
        success: true,
        content,
        modelType: 'gemini',
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
      const axiosError = error as { response?: { data?: { error?: { message?: string } } }; message?: string }
      const errMsg = axiosError.response?.data?.error?.message
        ?? axiosError.message
        ?? '未知错误'

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
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`

    try {
      const response = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        responseType: 'stream',
        timeout: 120000,
        signal: options?.signal
      })

      await consumeSseStream(response.data, (data) => {
        try {
          const parsed = JSON.parse(data) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>
          }
          for (const part of parsed.candidates?.[0]?.content?.parts ?? []) {
            if (!part.text) continue
            if (part.thought) {
              options?.onThinkingDelta?.(part.text)
            } else {
              content += part.text
              options?.onDelta?.(part.text)
            }
          }
        } catch {
          // ignore malformed chunk
        }
      }, options?.signal)

      return {
        success: true,
        content,
        modelType: 'gemini',
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
      const axiosError = error as { response?: { data?: { error?: { message?: string } } }; message?: string }
      const errMsg = axiosError.response?.data?.error?.message
        ?? axiosError.message
        ?? '未知错误'
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

export function createDeepSeekAdapter(): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter('deepseek', 'deepseek-chat')
}

export function createOpenAIAdapter(): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter('openai', 'gpt-4o')
}

export function createGeminiAdapter(): GeminiAdapter {
  return new GeminiAdapter()
}
