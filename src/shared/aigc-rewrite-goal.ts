export interface AigcRewriteRiskItem {
  text: string
  risk: number
}

export interface AigcRewriteObjective {
  nonHumanCount: number
  maxRisk: number
  weightedRisk: number
}

export function computeAigcRewriteObjective(
  items: AigcRewriteRiskItem[],
  humanRiskCeiling: number
): AigcRewriteObjective {
  let weightedRisk = 0
  let totalWeight = 0
  let nonHumanCount = 0
  let maxRisk = 0
  for (const item of items) {
    const weight = Math.max(1, item.text.replace(/\s/g, '').length)
    weightedRisk += item.risk * weight
    totalWeight += weight
    if (item.risk >= humanRiskCeiling) nonHumanCount++
    maxRisk = Math.max(maxRisk, item.risk)
  }
  return {
    nonHumanCount,
    maxRisk: Math.round(maxRisk * 10) / 10,
    weightedRisk: totalWeight > 0 ? Math.round(weightedRisk / totalWeight * 10) / 10 : 0
  }
}

/** 仅接受全文不回退的渐进改善，再按非绿色句数、最高风险、加权风险判断。 */
export function isAigcRewriteObjectiveImproved(
  before: AigcRewriteObjective,
  after: AigcRewriteObjective
): boolean {
  if (after.maxRisk > before.maxRisk + 0.1) return false
  if (after.weightedRisk > before.weightedRisk + 0.1) return false
  if (after.nonHumanCount !== before.nonHumanCount) {
    return after.nonHumanCount < before.nonHumanCount
  }
  if (Math.abs(after.maxRisk - before.maxRisk) >= 0.1) {
    return after.maxRisk < before.maxRisk
  }
  return after.weightedRisk <= before.weightedRisk - 0.1
}
