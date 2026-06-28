/** 统计正文字数（包含标点，去空白，对齐网文平台口径） */
export function countWords(text: string): number {
  return text.replace(/[\s\p{Z}]/gu, '').length
}

/** 正文生成 / 稿件优化共用的 ±10% 字数容差 */
export const BODY_WORD_COUNT_TOLERANCE = 0.1

export function bodyWordCountBounds(target: number): { min: number; max: number } {
  return {
    min: Math.floor(target * (1 - BODY_WORD_COUNT_TOLERANCE)),
    max: Math.ceil(target * (1 + BODY_WORD_COUNT_TOLERANCE))
  }
}

/** 全篇目标总字数是否在 ±10% 容差内（target ≤ 0 表示不校验） */
export function isTotalWordCountInTargetRange(actual: number, target: number): boolean {
  if (target <= 0) return true
  const { min, max } = bodyWordCountBounds(target)
  return actual >= min && actual <= max
}

/** 正文生成 user prompt 中的目标字数行（精确中心值，避免区间下限锚定） */
export function formatBodyWordTargetLine(target: number): string {
  const { min, max } = bodyWordCountBounds(target)
  return (
    `目标字数：约 ${target} 字（允许 ±10%，即 ${min}–${max} 字）。` +
    `须完整覆盖本章大纲；写完后自然收束，禁止为凑字注水，亦勿明显短于 ${min} 字。` +
    `超过 ${max} 字视为不合格，必须在 ${max} 字内完成全部情节。`
  )
}
