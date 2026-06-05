/** API 协议类型，决定使用哪个适配器 */
export type ProviderProtocol = 'openai' | 'gemini' | 'anthropic'

export interface BuiltinProviderMeta {
  type: string
  label: string
  description: string
  protocol: ProviderProtocol
  defaultBase: string
  defaultModel: string
  icon: string
  color: string
}

export const BUILTIN_PROVIDERS: BuiltinProviderMeta[] = [
  {
    type: 'deepseek',
    label: 'DeepSeek',
    description: '深度求索大语言模型，中文能力强',
    protocol: 'openai',
    defaultBase: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    icon: 'brain',
    color: 'text-primary'
  },
  {
    type: 'kimi',
    label: 'Kimi',
    description: '月之暗面 Kimi 开放平台，OpenAI 兼容接口，支持 256K 上下文',
    protocol: 'openai',
    defaultBase: 'https://api.moonshot.cn/v1',
    defaultModel: 'kimi-k2.6',
    icon: 'moon',
    color: 'text-warning'
  },
  {
    type: 'mimo',
    label: 'MiMo AI',
    description: '小米 MiMo 开放平台，支持普通 API（sk-）与 Token Plan 订阅（tp-），OpenAI 兼容',
    protocol: 'openai',
    defaultBase: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    icon: 'bolt',
    color: 'text-error'
  },
  {
    type: 'bailian',
    label: 'Bailian',
    description: '阿里云百炼 Model Studio，OpenAI 兼容接口，通义千问系列',
    protocol: 'openai',
    defaultBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    icon: 'globe',
    color: 'text-info'
  },
  {
    type: 'gemini',
    label: 'Google Gemini',
    description: 'Google 多模态大模型，支持长上下文',
    protocol: 'gemini',
    defaultBase: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-1.5-pro',
    icon: 'gem',
    color: 'text-secondary'
  },
  {
    type: 'openai',
    label: 'OpenAI',
    description: 'OpenAI 及所有兼容接口（第三方中转等）',
    protocol: 'openai',
    defaultBase: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    icon: 'robot',
    color: 'text-accent'
  },
  {
    type: 'anthropic',
    label: 'Anthropic',
    description: 'Claude 系列大语言模型',
    protocol: 'anthropic',
    defaultBase: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-20250514',
    icon: 'comment-dots',
    color: 'text-info'
  }
]

export const PROTOCOL_OPTIONS: { value: ProviderProtocol; label: string; defaultBase: string; defaultModel: string }[] = [
  { value: 'openai', label: 'OpenAI 兼容', defaultBase: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
  { value: 'gemini', label: 'Google Gemini', defaultBase: 'https://generativelanguage.googleapis.com', defaultModel: 'gemini-1.5-pro' },
  { value: 'anthropic', label: 'Anthropic', defaultBase: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-4-20250514' }
]

export function iconForProtocol(protocol: ProviderProtocol): string {
  if (protocol === 'gemini') return 'gem'
  if (protocol === 'anthropic') return 'comment-dots'
  return 'plug'
}

export function isCustomProviderType(modelType: string): boolean {
  return modelType.startsWith('custom_')
}

export function resolveProviderProtocol(modelType: string, storedProtocol?: string | null): ProviderProtocol {
  if (storedProtocol === 'openai' || storedProtocol === 'gemini' || storedProtocol === 'anthropic') {
    return storedProtocol
  }
  const builtin = BUILTIN_PROVIDERS.find(p => p.type === modelType)
  return builtin?.protocol ?? 'openai'
}

export function providerDisplayLabel(modelType: string, displayName?: string | null): string {
  if (displayName?.trim()) return displayName.trim()
  const builtin = BUILTIN_PROVIDERS.find(p => p.type === modelType)
  return builtin?.label ?? modelType
}

export function defaultBaseForProtocol(protocol: ProviderProtocol): string {
  return PROTOCOL_OPTIONS.find(p => p.value === protocol)?.defaultBase ?? 'https://api.openai.com/v1'
}

export function defaultModelForProtocol(protocol: ProviderProtocol): string {
  return PROTOCOL_OPTIONS.find(p => p.value === protocol)?.defaultModel ?? 'gpt-4o'
}

export function generateCustomProviderId(): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `custom_${Date.now().toString(36)}_${suffix}`
}
