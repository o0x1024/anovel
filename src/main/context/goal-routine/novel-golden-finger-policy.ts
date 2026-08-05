export interface NovelGoldenFingerDecisionInput {
  userRequired: boolean
  goal: string
  mainline: string
}

/**
 * 用户显式选择是最高优先级创作合同；未选择时才根据作品目标判断是否存在特殊机制。
 */
export function shouldGenerateNovelGoldenFinger(input: NovelGoldenFingerDecisionInput): boolean {
  if (input.userRequired) return true

  const text = `${input.goal}\n${input.mainline}`.trim()
  if (!text) return true

  return /系统|属性面板|积分兑换|签到|抽奖|属性点|熟练度面板|随身空间|可调用空间|独立异能|超能力|金手指|外挂/.test(text)
}
