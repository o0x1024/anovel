/** 估算文本 Token 数（中英混合，无需调用 tokenizer） */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}

export const DEFAULT_MAX_CONTEXT_TOKENS = 256_000
export const MESSAGE_OVERHEAD_TOKENS = 16
