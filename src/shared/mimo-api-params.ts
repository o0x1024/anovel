/**
 * 小米 MiMo API
 * - 普通 API（按量计费 sk-）：https://api.xiaomimimo.com/v1
 * - Token Plan 订阅（tp-）：https://platform.xiaomimimo.com/docs/zh-CN/price/tokenplan/quick-access
 */

/** 普通按量计费 API */
export const MIMO_API_BASE = 'https://api.xiaomimimo.com/v1'

export const MIMO_TOKEN_PLAN_BASE_CN = 'https://token-plan-cn.xiaomimimo.com/v1'
export const MIMO_TOKEN_PLAN_BASE_SGP = 'https://token-plan-sgp.xiaomimimo.com/v1'
export const MIMO_TOKEN_PLAN_BASE_AMS = 'https://token-plan-ams.xiaomimimo.com/v1'

export type MimoAccessMode = 'api' | 'token_plan'
export type MimoTokenPlanCluster = 'cn' | 'sgp' | 'ams'

export interface MimoProviderOptions {
  /** 接入模式：普通 API 或 Token Plan 订阅 */
  accessMode: MimoAccessMode
  /** Token Plan 集群（仅 token_plan 模式生效） */
  tokenPlanCluster: MimoTokenPlanCluster
}

export const DEFAULT_MIMO_PROVIDER_OPTIONS: MimoProviderOptions = {
  accessMode: 'api',
  tokenPlanCluster: 'cn'
}

const TOKEN_PLAN_BASES: Record<MimoTokenPlanCluster, string> = {
  cn: MIMO_TOKEN_PLAN_BASE_CN,
  sgp: MIMO_TOKEN_PLAN_BASE_SGP,
  ams: MIMO_TOKEN_PLAN_BASE_AMS
}

/** Token Plan 常用模型（/models 不可用时供手动填写参考） */
export const MIMO_SUGGESTED_MODELS = [
  'mimo-v2.5-pro',
  'mimo-v2.5',
  'mimo-v2.5-flash'
]

export function isMimoProvider(modelType: string): boolean {
  return modelType === 'mimo'
}

export function isMimoModel(modelId: string): boolean {
  return /^mimo-/i.test(modelId.trim())
}

export function resolveMimoApiBase(options: MimoProviderOptions): string {
  if (options.accessMode === 'token_plan') {
    return TOKEN_PLAN_BASES[options.tokenPlanCluster] ?? MIMO_TOKEN_PLAN_BASE_CN
  }
  return MIMO_API_BASE
}

function normalizeMimoOptions(parsed: Partial<MimoProviderOptions>): MimoProviderOptions {
  const accessMode: MimoAccessMode = parsed.accessMode === 'token_plan' ? 'token_plan' : 'api'
  const cluster: MimoTokenPlanCluster =
    parsed.tokenPlanCluster === 'sgp' ? 'sgp'
      : parsed.tokenPlanCluster === 'ams' ? 'ams'
        : 'cn'
  return { accessMode, tokenPlanCluster: cluster }
}

export function inferMimoOptionsFromBase(apiBase?: string | null): MimoProviderOptions {
  const base = (apiBase ?? '').trim().toLowerCase()
  if (base.includes('token-plan-sgp')) {
    return { accessMode: 'token_plan', tokenPlanCluster: 'sgp' }
  }
  if (base.includes('token-plan-ams')) {
    return { accessMode: 'token_plan', tokenPlanCluster: 'ams' }
  }
  if (base.includes('token-plan')) {
    return { accessMode: 'token_plan', tokenPlanCluster: 'cn' }
  }
  if (base.includes('api.xiaomimimo.com')) {
    return { accessMode: 'api', tokenPlanCluster: 'cn' }
  }
  return { ...DEFAULT_MIMO_PROVIDER_OPTIONS }
}

export function parseMimoProviderOptions(
  raw: string | null | undefined,
  apiBase?: string | null
): MimoProviderOptions {
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw) as Partial<MimoProviderOptions>
      return normalizeMimoOptions(parsed)
    } catch {
      return inferMimoOptionsFromBase(apiBase)
    }
  }
  return inferMimoOptionsFromBase(apiBase)
}

/** MiMo OpenAI 兼容接口使用 api-key 头，而非 Authorization: Bearer */
export function mimoAuthHeaders(apiKey: string): Record<string, string> {
  return {
    'api-key': apiKey,
    'Content-Type': 'application/json'
  }
}

export function openAICompatibleAuthHeaders(
  modelType: string,
  apiKey: string
): Record<string, string> {
  if (isMimoProvider(modelType)) {
    return mimoAuthHeaders(apiKey)
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  }
}
