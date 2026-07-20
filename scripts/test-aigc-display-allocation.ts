import assert from 'node:assert/strict'
import type { AigcSegment } from '../src/shared/aigc-detect-types'
import type { AigcSentencePatch } from '../src/shared/aigc-sentence-rewrite-types'
import {
  resolveAigcDisplayCategories,
  summarizeAigcDisplayDistribution
} from '../src/shared/aigc-display-allocation'

const segments: AigcSegment[] = [
  {
    text: '第一句。',
    category: 'suspected_ai',
    probabilities: { human: 0, suspected_ai: 70, ai: 30 }
  },
  {
    text: '第二句。',
    category: 'ai',
    probabilities: { human: 0, suspected_ai: 40, ai: 60 }
  },
  {
    text: '第三句。',
    category: 'human',
    probabilities: { human: 80, suspected_ai: 15, ai: 5 }
  }
]

assert.deepEqual(
  resolveAigcDisplayCategories(segments),
  ['suspected_ai', 'ai', 'human'],
  '没有逐句证据时必须展示句子自身主类别，不能按全文分布强制配额染色'
)

assert.deepEqual(
  summarizeAigcDisplayDistribution(segments),
  { human: 33.33, suspected_ai: 33.34, ai: 33.33 },
  '顶部覆盖率必须与当前绿黄红句子使用同一套类别和字符权重'
)

function patch(overrides: Partial<AigcSentencePatch>): AigcSentencePatch {
  return {
    id: 'sentence:0:4',
    start: 0,
    end: 4,
    segmentIndex: 0,
    paragraphIndex: 0,
    sentenceIndex: 0,
    originalText: '第一句。',
    status: 'unchanged',
    sceneTypes: ['environment'],
    aiSymptoms: [],
    evidence: '',
    referenceTitles: [],
    issues: [],
    windowScoreBefore: 70,
    ...overrides
  }
}

assert.deepEqual(
  resolveAigcDisplayCategories(segments, [patch({})]),
  ['suspected_ai', 'ai', 'human'],
  '只有窗口风险、没有句内证据的句子必须保持黄色'
)

assert.deepEqual(
  resolveAigcDisplayCategories(segments, [patch({
    status: 'rewriting',
    aiSymptoms: ['shot_chain'],
    evidence: '连续使用同构动作推进'
  })]),
  ['ai', 'ai', 'human'],
  '具备症状和具体句内证据的改写目标才允许标红'
)

assert.deepEqual(
  resolveAigcDisplayCategories(segments, [patch({
    status: 'rewriting',
    aiSymptoms: ['shot_chain'],
    evidence: ''
  })]),
  ['suspected_ai', 'ai', 'human'],
  '缺少具体证据时，即使状态异常地进入改写中也不能标红'
)

assert.deepEqual(
  resolveAigcDisplayCategories(segments, [patch({
    id: 'block:0:8',
    scope: 'block',
    sentenceCount: 2,
    start: 0,
    end: 8,
    status: 'rewriting',
    aiSymptoms: ['regular_sentence_rhythm'],
    evidence: '两句句法组织和节奏连续同构'
  })]),
  ['ai', 'ai', 'human'],
  '语义块诊断证据必须覆盖块内全部检测句，不能只附着第一句'
)

console.log('AIGC 句级证据显示测试通过')
