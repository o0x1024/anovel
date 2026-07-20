import assert from 'node:assert/strict'
import {
  attributeTokenWindowsToSpans,
  splitZhuqueDisplaySentences,
  type ZhuqueTokenWindow
} from '../src/main/perplexity/zhuque-token-windows'
import { computeZhuqueSentenceDistribution } from '../src/main/perplexity/zhuque-alignment'

const text = '甲乙。“丙丁！”\n戊己；庚辛'
const spans = splitZhuqueDisplaySentences(text)
assert.deepEqual(
  spans.map(span => span.text),
  ['甲乙。', '“丙丁！”\n', '戊己；', '庚辛'],
  '句号、问号、感叹号、分号和回车必须生成稳定边界，闭合引号必须归入当前句'
)
assert.deepEqual(
  spans.map(span => [span.start, span.end]),
  [[0, 3], [3, 9], [9, 12], [12, 14]],
  '切分结果必须完整覆盖原文且保留字符偏移'
)

const windows: ZhuqueTokenWindow[] = [{
  startToken: 0,
  endToken: 6,
  start: 0,
  end: 6,
  metric: { ppl: 10, tokenCount: 4, top5Rate: 0.5, avgProb: 0.3 },
  tokenMetrics: [
    { charOffset: 0, charLen: 1, logProb: Math.log(0.05), prob: 0.05, inTop5: false },
    { charOffset: 1, charLen: 1, logProb: Math.log(0.1), prob: 0.1, inTop5: false },
    { charOffset: 3, charLen: 1, logProb: Math.log(0.8), prob: 0.8, inTop5: true },
    { charOffset: 4, charLen: 1, logProb: Math.log(0.9), prob: 0.9, inTop5: true }
  ]
}]
const attributed = attributeTokenWindowsToSpans(spans.slice(0, 2), windows)
assert.equal(attributed[0].tokenCount, 2)
assert.equal(attributed[1].tokenCount, 2)
assert.ok(attributed[0].ppl > attributed[1].ppl * 5,
  '逐句指标必须只使用目标句 token，不能继续复用相同的整窗平均值')

const distribution = computeZhuqueSentenceDistribution([
  {
    text: '甲。',
    score: 20,
    category: 'human',
    probabilities: { human: 55, suspected_ai: 25, ai: 20 },
    reason: '人工',
    evidence: {
      filmShot: 0, connector: 0, emotionTemplate: 0, summaryClosure: 0,
      domainTerms: 0, deepseekStyleTerms: 0, penalty: 0, styleReduction: 0
    }
  },
  {
    text: '乙乙乙乙。',
    score: 80,
    category: 'ai',
    probabilities: { human: 5, suspected_ai: 46, ai: 49 },
    reason: 'AI',
    evidence: {
      filmShot: 0, connector: 0, emotionTemplate: 0, summaryClosure: 0,
      domainTerms: 0, deepseekStyleTerms: 0, penalty: 0, styleReduction: 0
    }
  }
])
assert.deepEqual(distribution, { human: 28.57, suspected_ai: 0, ai: 71.43 },
  '全文比例必须按最终句级类别和有效字符数汇总，不能重新累加软概率')

console.log('朱雀逐句切分、token归因和全文汇总测试通过')
