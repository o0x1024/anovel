import type { AigcDistribution } from '../src/shared/aigc-detect-types'

type CompleteExpectation = {
  coverage: 'complete'
  distribution: AigcDistribution
}

type PartialExpectation = {
  coverage: 'partial'
  distribution: Partial<AigcDistribution>
  missingReason: string
}

export type ZhuqueCalibrationSample = {
  name: string
  file: string
  expected: CompleteExpectation | PartialExpectation
}

export const ZHUQUE_CALIBRATION_SAMPLES: ZhuqueCalibrationSample[] = [
  { name: 'A1人工', file: 'A1-human.txt', expected: { coverage: 'complete', distribution: { human: 100, suspected_ai: 0, ai: 0 } } },
  { name: 'A2纯AI', file: 'A2-ai.txt', expected: { coverage: 'complete', distribution: { human: 0, suspected_ai: 0, ai: 100 } } },
  { name: 'H1低频词', file: 'H1-ai-lowfreq-vocab-only.txt', expected: { coverage: 'complete', distribution: { human: 0, suspected_ai: 100, ai: 0 } } },
  {
    name: 'F6镜头链',
    file: 'F6-inject-filmshot.txt',
    expected: { coverage: 'partial', distribution: { human: 19 }, missingReason: '原实验只记录人工占比' }
  },
  {
    name: 'F4连接词',
    file: 'F4-inject-connector.txt',
    expected: { coverage: 'partial', distribution: { human: 61 }, missingReason: '原实验只记录人工占比' }
  },
  { name: 'F8均匀句长', file: 'F8-inject-uniform-sentlen.txt', expected: { coverage: 'complete', distribution: { human: 100, suspected_ai: 0, ai: 0 } } },
  { name: 'G1修仙', file: 'G1-genre-xianxia.txt', expected: { coverage: 'complete', distribution: { human: 0, suspected_ai: 100, ai: 0 } } },
  { name: 'G3推理', file: 'G3-genre-mystery.txt', expected: { coverage: 'complete', distribution: { human: 0, suspected_ai: 0, ai: 100 } } },
  { name: 'M4DeepSeek', file: 'M4-deepseek.txt', expected: { coverage: 'complete', distribution: { human: 0, suspected_ai: 100, ai: 0 } } },
  { name: 'Q6前置混合', file: 'Q6-50human-50ai.txt', expected: { coverage: 'complete', distribution: { human: 57.37, suspected_ai: 0, ai: 42.63 } } },
  { name: 'K4交替混合', file: 'K4-50mix-interleave.txt', expected: { coverage: 'complete', distribution: { human: 28.09, suspected_ai: 71.91, ai: 0 } } },
  { name: 'WS4词对交换', file: 'WS4-swap-A2-ai.txt', expected: { coverage: 'complete', distribution: { human: 100, suspected_ai: 0, ai: 0 } } }
]

export function validateZhuqueCalibrationCorpus(samples = ZHUQUE_CALIBRATION_SAMPLES): string[] {
  const errors: string[] = []
  const seenFiles = new Set<string>()

  for (const sample of samples) {
    if (seenFiles.has(sample.file)) errors.push(`${sample.file} 重复`)
    seenFiles.add(sample.file)

    const entries = Object.entries(sample.expected.distribution)
    if (sample.expected.coverage === 'complete') {
      const total = entries.reduce((sum, [, value]) => sum + value, 0)
      if (entries.length !== 3 || Math.abs(total - 100) > 0.01) {
        errors.push(`${sample.file} 完整标注必须包含三分类且总和为100`)
      }
    } else if (entries.length !== 1 || entries[0][0] !== 'human') {
      errors.push(`${sample.file} 部分标注只能保留原始实验已知的人工占比`)
    }
  }

  return errors
}
