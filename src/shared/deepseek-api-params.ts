/** DeepSeek 思考模式配置，见 https://api-docs.deepseek.com/zh-cn/guides/thinking_mode */

export type DeepSeekReasoningEffort = 'high' | 'max'

export interface DeepSeekProviderOptions {
  /** 思考模式开关，默认开启 */
  thinkingEnabled: boolean
  /** 思考强度，默认 high */
  reasoningEffort: DeepSeekReasoningEffort
}

export const DEFAULT_DEEPSEEK_PROVIDER_OPTIONS: DeepSeekProviderOptions = {
  thinkingEnabled: true,
  reasoningEffort: 'high'
}

export function parseDeepSeekProviderOptions(raw: string | null | undefined): DeepSeekProviderOptions {
  if (!raw?.trim()) return { ...DEFAULT_DEEPSEEK_PROVIDER_OPTIONS }
  try {
    const parsed = JSON.parse(raw) as Partial<DeepSeekProviderOptions>
    const effort = parsed.reasoningEffort === 'max' ? 'max' : 'high'
    return {
      thinkingEnabled: parsed.thinkingEnabled !== false,
      reasoningEffort: effort
    }
  } catch {
    return { ...DEFAULT_DEEPSEEK_PROVIDER_OPTIONS }
  }
}

export function isDeepSeekProvider(modelType: string): boolean {
  return modelType === 'deepseek'
}

/**
 * 将 DeepSeek 思考模式参数写入 OpenAI 兼容请求体。
 * 思考模式开启时不发送 temperature / top_p / penalty（API 会忽略，但文档建议不传）。
 */
export function applyDeepSeekThinkingParams(
  body: Record<string, unknown>,
  options: DeepSeekProviderOptions
): void {
  body.thinking = { type: options.thinkingEnabled ? 'enabled' : 'disabled' }
  if (options.thinkingEnabled) {
    body.reasoning_effort = options.reasoningEffort
    delete body.temperature
    delete body.top_p
    delete body.frequency_penalty
    delete body.presence_penalty
  }
}
