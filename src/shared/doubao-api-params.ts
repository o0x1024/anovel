/** 豆包 / 火山方舟 (Volcengine Ark) 思考模式配置
 * @see https://www.volcengine.com/docs/82379/1449737
 */

export interface DoubaoProviderOptions {
  /** 思考模式开关；仅深度思考模型（如 doubao-1.5-thinking、deepseek-r1）支持 */
  thinkingEnabled: boolean
}

export const DEFAULT_DOUBAO_PROVIDER_OPTIONS: DoubaoProviderOptions = {
  thinkingEnabled: false
}

export function parseDoubaoProviderOptions(raw: string | null | undefined): DoubaoProviderOptions {
  if (!raw?.trim()) return { ...DEFAULT_DOUBAO_PROVIDER_OPTIONS }
  try {
    const parsed = JSON.parse(raw) as Partial<DoubaoProviderOptions>
    return {
      thinkingEnabled: parsed.thinkingEnabled === true
    }
  } catch {
    return { ...DEFAULT_DOUBAO_PROVIDER_OPTIONS }
  }
}

export function isDoubaoProvider(modelType: string): boolean {
  return modelType === 'doubao'
}

/**
 * 将豆包/火山方舟思考模式参数写入 OpenAI 兼容请求体。
 * 思考模式开启时不发送 temperature / top_p / penalty（API 会忽略，但文档建议不传）。
 */
export function applyDoubaoThinkingParams(
  body: Record<string, unknown>,
  options: DoubaoProviderOptions
): void {
  body.thinking = { type: options.thinkingEnabled ? 'enabled' : 'disabled' }
  if (options.thinkingEnabled) {
    delete body.temperature
    delete body.top_p
    delete body.frequency_penalty
    delete body.presence_penalty
  }
}
