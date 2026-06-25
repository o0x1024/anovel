export interface AutoOptimizeConfig {
  enabled: boolean
  maxIterations: number
  targetTotalScore: number
  stopOnHardFail: boolean
  /** 每个小项的最低比率（0-1），达标检查时所有小项 ratio 均需 >= 此值 */
  minSubScoreRatio: number
}

export const DEFAULT_AUTO_OPTIMIZE_CONFIG: AutoOptimizeConfig = {
  enabled: false,
  maxIterations: 3,
  targetTotalScore: 80,
  stopOnHardFail: true,
  minSubScoreRatio: 0.85
}
