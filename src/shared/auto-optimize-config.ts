export interface AutoOptimizeConfig {
  enabled: boolean
  maxIterations: number
  targetTotalScore: number
  stopOnHardFail: boolean
}

export const DEFAULT_AUTO_OPTIMIZE_CONFIG: AutoOptimizeConfig = {
  enabled: false,
  maxIterations: 3,
  targetTotalScore: 80,
  stopOnHardFail: true
}
