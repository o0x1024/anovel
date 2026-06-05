/**
 * 阿里云百炼 Model Studio（DashScope OpenAI 兼容模式）
 * @see https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope
 * @see https://bailian.console.aliyun.com/cn-beijing?tab=api#/api
 */

export const BAILIAN_API_BASE_CN = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const BAILIAN_API_BASE_INTL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
export const BAILIAN_API_BASE_US = 'https://dashscope-us.aliyuncs.com/compatible-mode/v1'
export const BAILIAN_API_BASE_HK = 'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1'

/** 各地域 OpenAI 兼容 Base URL，API Key 不通用 */
export type BailianRegion = 'cn' | 'intl' | 'us' | 'hk'

export interface BailianProviderOptions {
  region: BailianRegion
}

export const DEFAULT_BAILIAN_PROVIDER_OPTIONS: BailianProviderOptions = {
  region: 'cn'
}

export const BAILIAN_REGION_LABELS: Record<BailianRegion, string> = {
  cn: '华北2（北京）',
  intl: '新加坡（国际）',
  us: '美国（弗吉尼亚）',
  hk: '中国香港'
}

const REGION_BASES: Record<BailianRegion, string> = {
  cn: BAILIAN_API_BASE_CN,
  intl: BAILIAN_API_BASE_INTL,
  us: BAILIAN_API_BASE_US,
  hk: BAILIAN_API_BASE_HK
}

/** 常用模型（/models 不可用时供手动填写参考） */
export const BAILIAN_SUGGESTED_MODELS = [
  'qwen-plus',
  'qwen-max',
  'qwen-turbo',
  'qwen3.6-plus'
]

export function isBailianProvider(modelType: string): boolean {
  return modelType === 'bailian'
}

export function resolveBailianApiBase(options: BailianProviderOptions): string {
  return REGION_BASES[options.region] ?? BAILIAN_API_BASE_CN
}

function normalizeBailianOptions(parsed: Partial<BailianProviderOptions>): BailianProviderOptions {
  const region: BailianRegion =
    parsed.region === 'intl' ? 'intl'
      : parsed.region === 'us' ? 'us'
        : parsed.region === 'hk' ? 'hk'
          : 'cn'
  return { region }
}

export function inferBailianOptionsFromBase(apiBase?: string | null): BailianProviderOptions {
  const base = (apiBase ?? '').trim().toLowerCase()
  if (base.includes('dashscope-intl')) return { region: 'intl' }
  if (base.includes('dashscope-us')) return { region: 'us' }
  if (base.includes('cn-hongkong.dashscope')) return { region: 'hk' }
  if (base.includes('dashscope.aliyuncs.com')) return { region: 'cn' }
  return { ...DEFAULT_BAILIAN_PROVIDER_OPTIONS }
}

export function parseBailianProviderOptions(
  raw: string | null | undefined,
  apiBase?: string | null
): BailianProviderOptions {
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw) as Partial<BailianProviderOptions>
      return normalizeBailianOptions(parsed)
    } catch {
      return inferBailianOptionsFromBase(apiBase)
    }
  }
  return inferBailianOptionsFromBase(apiBase)
}
