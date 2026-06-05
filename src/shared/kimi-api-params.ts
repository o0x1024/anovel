import {
  applyDeepSeekThinkingParams,
  type DeepSeekProviderOptions
} from './deepseek-api-params'
import { isMimoModel } from './mimo-api-params'

/** Kimi K2 系列（kimi-k2.6 / kimi-k2.5 等），参数约束见 platform.kimi.com/docs/api/models-overview */
export function isKimiK2Model(modelId: string): boolean {
  return /^kimi-k2/i.test(modelId.trim())
}

export interface OpenAICompatGenerationParams {
  maxTokens?: number
  temperature?: number
  frequencyPenalty?: number
  presencePenalty?: number
  topP?: number
  /** DeepSeek 提供商专属：思考模式 */
  deepseekOptions?: DeepSeekProviderOptions
}

export function buildOpenAICompatibleBody(
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  request: OpenAICompatGenerationParams,
  options: { stream: boolean }
): Record<string, unknown> {
  const maxOut = request.maxTokens ?? 4096
  const body: Record<string, unknown> = {
    model: modelId,
    messages,
    stream: options.stream
  }

  if (isKimiK2Model(modelId)) {
    // K2.6：temperature / top_p / penalty 均不可改，勿传入高级配置中的值
    body.max_completion_tokens = maxOut
    body.thinking = { type: 'disabled' }
    return body
  }

  if (isMimoModel(modelId)) {
    body.max_completion_tokens = maxOut
    body.temperature = request.temperature ?? 0.7
    if (request.frequencyPenalty != null) body.frequency_penalty = request.frequencyPenalty
    if (request.presencePenalty != null) body.presence_penalty = request.presencePenalty
    if (request.topP != null) body.top_p = request.topP
    if (options.stream) {
      body.stream_options = { include_usage: true }
    }
    return body
  }

  body.max_tokens = maxOut
  body.temperature = request.temperature ?? 0.7
  if (request.frequencyPenalty != null) body.frequency_penalty = request.frequencyPenalty
  if (request.presencePenalty != null) body.presence_penalty = request.presencePenalty
  if (request.topP != null) body.top_p = request.topP
  if (request.deepseekOptions) {
    applyDeepSeekThinkingParams(body, request.deepseekOptions)
  }
  if (options.stream) {
    body.stream_options = { include_usage: true }
  }
  return body
}
