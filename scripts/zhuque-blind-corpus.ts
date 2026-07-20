export interface ZhuqueBlindSample {
  name: string
  file: string
  externalLabel: 'human' | 'suspected_ai' | 'ai'
  provenance: string
  regression: string
}

/**
 * 独立盲测集：不得用于阈值或权重拟合，只用于发布前回归。
 * 新增样本必须记录外部检测结果与来源，不能从校准集复制。
 */
export const ZHUQUE_BLIND_SAMPLES: ZhuqueBlindSample[] = [
  {
    name: 'B1铁壁镇',
    file: 'B1-zhuque-ai100-local-human100.txt',
    externalLabel: 'ai',
    provenance: '2026-07-17 用户完整文本实测：朱雀AI特征50.61%、疑似AI49.39%，本地Qwen3.5 4B人工100%；2026-07-18 同文前531字实测朱雀AI特征100%、本地人工100%',
    regression: '完整版和531字前缀的多维证据均不得再次输出人工100%'
  }
]
