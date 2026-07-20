import type { AigcDistribution } from '../src/shared/aigc-detect-types'

export type ZhuqueExperimentUsage = 'calibration' | 'holdout' | 'blind' | 'robustness_only'

export interface ZhuqueExperimentSample {
  name: string
  file: string
  usage: ZhuqueExperimentUsage
  expected: AigcDistribution
  readable: boolean
  provenance: string
}

const historical = 'docs/zhuque-test-results.md 历史朱雀手工实测'

export const ZHUQUE_EXPERIMENT_SAMPLES: ZhuqueExperimentSample[] = [
  { name: 'A1人工', file: 'A1-human.txt', usage: 'calibration', expected: { human: 100, suspected_ai: 0, ai: 0 }, readable: true, provenance: historical },
  { name: 'A2纯AI', file: 'A2-ai.txt', usage: 'calibration', expected: { human: 0, suspected_ai: 0, ai: 100 }, readable: true, provenance: historical },
  { name: 'H1低频词', file: 'H1-ai-lowfreq-vocab-only.txt', usage: 'calibration', expected: { human: 0, suspected_ai: 100, ai: 0 }, readable: true, provenance: historical },
  { name: 'F8均匀句长', file: 'F8-inject-uniform-sentlen.txt', usage: 'calibration', expected: { human: 100, suspected_ai: 0, ai: 0 }, readable: true, provenance: historical },
  { name: 'G1修仙', file: 'G1-genre-xianxia.txt', usage: 'calibration', expected: { human: 0, suspected_ai: 100, ai: 0 }, readable: true, provenance: historical },
  { name: 'G3推理', file: 'G3-genre-mystery.txt', usage: 'calibration', expected: { human: 0, suspected_ai: 0, ai: 100 }, readable: true, provenance: historical },
  { name: 'M4 DeepSeek', file: 'M4-deepseek.txt', usage: 'calibration', expected: { human: 0, suspected_ai: 100, ai: 0 }, readable: true, provenance: historical },
  { name: 'Q6前置混合', file: 'Q6-50human-50ai.txt', usage: 'calibration', expected: { human: 57.37, suspected_ai: 0, ai: 42.63 }, readable: true, provenance: historical },
  { name: 'K4交替混合', file: 'K4-50mix-interleave.txt', usage: 'calibration', expected: { human: 28.09, suspected_ai: 71.91, ai: 0 }, readable: true, provenance: historical },

  { name: 'Q4七成人工', file: 'Q4-70human-30ai.txt', usage: 'holdout', expected: { human: 100, suspected_ai: 0, ai: 0 }, readable: true, provenance: historical },
  { name: 'Q8三成人工', file: 'Q8-30human-70ai.txt', usage: 'holdout', expected: { human: 27.18, suspected_ai: 27.28, ai: 45.54 }, readable: true, provenance: historical },
  { name: 'Q10一成人工', file: 'Q10-10human-90ai.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 27.61, ai: 72.39 }, readable: true, provenance: historical },
  { name: 'K2人工后置', file: 'K2-50mix-human-tail.txt', usage: 'holdout', expected: { human: 39.63, suspected_ai: 30.71, ai: 29.66 }, readable: true, provenance: historical },
  { name: 'K5三明治', file: 'K5-50mix-sandwich.txt', usage: 'holdout', expected: { human: 27.78, suspected_ai: 72.22, ai: 0 }, readable: true, provenance: historical },
  { name: 'E1口语改写', file: 'E1-ai-colloquial-rewrite.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 69, ai: 31 }, readable: true, provenance: historical },
  { name: 'D5双重翻译', file: 'D5-double-translate.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 100, ai: 0 }, readable: true, provenance: historical },
  { name: 'D7级联改写', file: 'D7-cascade-claude-to-deepseek.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 100, ai: 0 }, readable: true, provenance: historical },
  { name: 'G4硬科幻', file: 'G4-genre-scifi.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 0, ai: 100 }, readable: true, provenance: historical },
  { name: 'G5恐怖', file: 'G5-genre-horror.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 100, ai: 0 }, readable: true, provenance: historical },
  { name: 'G7散文', file: 'G7-genre-essay.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 0, ai: 100 }, readable: true, provenance: historical },
  { name: 'G10小白文', file: 'G10-genre-baiwenxue.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 100, ai: 0 }, readable: true, provenance: historical },
  { name: 'M2 Claude', file: 'M2-claude.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 0, ai: 100 }, readable: true, provenance: historical },
  { name: 'M3豆包', file: 'M3-doubao.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 0, ai: 100 }, readable: true, provenance: historical },
  { name: 'M6 GLM', file: 'M6-glm.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 0, ai: 100 }, readable: true, provenance: historical },
  { name: 'F1 AI小说', file: 'F1-ai-novel.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 85.03, ai: 14.97 }, readable: true, provenance: historical },
  { name: 'SR30选择改写', file: 'SR30-F1-ai-novel.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 100, ai: 0 }, readable: true, provenance: historical },
  { name: 'SR50选择改写', file: 'SR50-F1-ai-novel.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 100, ai: 0 }, readable: true, provenance: historical },
  { name: 'SR70选择改写', file: 'SR70-F1-ai-novel.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 84.68, ai: 15.32 }, readable: true, provenance: historical },
  { name: 'SR100全文改写', file: 'SR100-F1-ai-novel.txt', usage: 'holdout', expected: { human: 0, suspected_ai: 85.95, ai: 14.05 }, readable: true, provenance: historical },

  { name: 'B1铁壁镇', file: 'B1-zhuque-ai100-local-human100.txt', usage: 'blind', expected: { human: 0, suspected_ai: 49.39, ai: 50.61 }, readable: true, provenance: '2026-07-17 用户完整文本朱雀实测' },

  { name: 'WS4打乱AI', file: 'WS4-swap-A2-ai.txt', usage: 'robustness_only', expected: { human: 100, suspected_ai: 0, ai: 0 }, readable: false, provenance: historical },
  { name: 'RE7高强度打乱', file: 'RE7-swap52-repair-minimal.txt', usage: 'robustness_only', expected: { human: 84.86, suspected_ai: 15.14, ai: 0 }, readable: false, provenance: historical }
]

export function validateZhuqueExperimentCorpus(samples = ZHUQUE_EXPERIMENT_SAMPLES): string[] {
  const errors: string[] = []
  const files = new Set<string>()
  for (const sample of samples) {
    if (files.has(sample.file)) errors.push(`${sample.file} 重复`)
    files.add(sample.file)
    const total = sample.expected.human + sample.expected.suspected_ai + sample.expected.ai
    if (Math.abs(total - 100) > 0.01) errors.push(`${sample.file} 三分类总和不是100`)
    if (sample.usage !== 'robustness_only' && !sample.readable) {
      errors.push(`${sample.file} 不可读样本只能用于鲁棒性观察`)
    }
  }
  return errors
}
