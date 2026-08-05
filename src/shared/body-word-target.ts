/** 统计正文字数（包含标点，去空白，对齐网文平台口径） */
export function countWords(text: string): number {
  return text.replace(/[\s\p{Z}]/gu, '').length
}

/**
 * 正文生成 / 执行合同 / 稿件优化共用的默认字数容差。
 * 默认 ±25%；用户可按作品需要放宽，最高 ±100%。
 */
export const BODY_WORD_COUNT_TOLERANCE = 0.25
export const BODY_WORD_COUNT_TOLERANCE_MIN = 0.05
export const BODY_WORD_COUNT_TOLERANCE_MAX = 1

export function clampWordCountTolerance(tolerance?: number | null): number {
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance)) {
    return BODY_WORD_COUNT_TOLERANCE
  }
  return Math.min(
    BODY_WORD_COUNT_TOLERANCE_MAX,
    Math.max(BODY_WORD_COUNT_TOLERANCE_MIN, tolerance)
  )
}

export function formatWordCountTolerancePercent(tolerance?: number | null): string {
  return `${Math.round(clampWordCountTolerance(tolerance) * 100)}%`
}

export function bodyWordCountBounds(
  target: number,
  tolerance?: number | null
): { min: number; max: number } {
  const ratio = clampWordCountTolerance(tolerance)
  return {
    min: Math.floor(target * (1 - ratio)),
    max: Math.ceil(target * (1 + ratio))
  }
}

/** 全篇目标总字数是否在容差内（target ≤ 0 表示不校验） */
export function isTotalWordCountInTargetRange(
  actual: number,
  target: number,
  tolerance?: number | null
): boolean {
  if (target <= 0) return true
  const { min, max } = bodyWordCountBounds(target, tolerance)
  return actual >= min && actual <= max
}

/** 正文生成 user prompt 中的目标字数行（精确中心值，避免区间下限锚定） */
export function formatBodyWordTargetLine(target: number, tolerance?: number | null): string {
  const ratio = clampWordCountTolerance(tolerance)
  const { min, max } = bodyWordCountBounds(target, ratio)
  const pct = formatWordCountTolerancePercent(ratio)
  return (
    `目标字数：约 ${target} 字（允许 ±${pct}，即 ${min}–${max} 字）。` +
    `须完整覆盖本章大纲；写完后自然收束，禁止为凑字注水，亦勿明显短于 ${min} 字。` +
    `超过 ${max} 字视为不合格，必须在 ${max} 字内完成全部情节。`
  )
}
