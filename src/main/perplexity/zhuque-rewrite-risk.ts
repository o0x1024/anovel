import type { AigcCategory, AigcDistribution } from '../../shared/aigc-detect-types'

export const ZHUQUE_REWRITE_RISK_THRESHOLD = 45
export const ZHUQUE_HUMAN_RISK_CEILING = 35
export const ZHUQUE_AI_RISK_THRESHOLD = 65
export const ZHUQUE_REWRITE_TARGET_SCORE = 30
export const ZHUQUE_REWRITE_MIN_IMPROVEMENT = 1.5

/**
 * 改写优先级不是“AI概率”的别名：疑似AI同样需要处理，但证据强度低于AI。
 */
export function computeZhuqueRewriteRisk(probabilities: AigcDistribution): number {
  return Math.round((probabilities.ai + probabilities.suspected_ai * 0.65) * 10) / 10
}

export function isZhuqueRewriteTarget(rewriteRisk: number): boolean {
  return rewriteRisk >= ZHUQUE_REWRITE_RISK_THRESHOLD
}

export function categorizeZhuqueSentenceRisk(rewriteRisk: number): AigcCategory {
  if (rewriteRisk < ZHUQUE_HUMAN_RISK_CEILING) return 'human'
  if (rewriteRisk < ZHUQUE_AI_RISK_THRESHOLD) return 'suspected_ai'
  return 'ai'
}

export function isMeaningfulRewriteImprovement(baseline: number, candidate: number): boolean {
  return candidate <= baseline - ZHUQUE_REWRITE_MIN_IMPROVEMENT
}
