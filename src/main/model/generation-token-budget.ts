const FALLBACK_MAX_TOKENS = 4096

function normalizePositiveTokenCount(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value == null || value <= 0) return fallback
  return Math.max(1, Math.floor(value))
}

/**
 * 每个步骤可以声明自己的建议输出预算，但「AI 服务 > 高级配置」中的
 * Max Tokens 是所有运行时 LLM 请求不可突破的全局上限。
 */
export function resolveGenerationMaxTokens(
  requestedMaxTokens: number | undefined,
  globalMaxTokens: number | undefined,
  fallback = FALLBACK_MAX_TOKENS
): number {
  const safeFallback = normalizePositiveTokenCount(fallback, FALLBACK_MAX_TOKENS)
  const safeGlobalMax = normalizePositiveTokenCount(globalMaxTokens, safeFallback)
  const safeRequestedMax = normalizePositiveTokenCount(requestedMaxTokens, safeGlobalMax)
  return Math.min(safeRequestedMax, safeGlobalMax)
}
