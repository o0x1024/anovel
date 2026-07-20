import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  classifyZhuqueSegments,
  computeZhuqueDistribution,
  computeZhuqueTokenRisk,
  detectZhuqueFingerprints,
  scoreZhuqueSegment,
  segmentTextForZhuque,
  toAigcSegments
} from '../src/main/perplexity/zhuque-alignment'
import { analyzeZhuqueDistribution } from '../src/main/perplexity/zhuque-distribution-features'
import {
  attributeTokenWindowsToSpans,
  buildZhuqueTokenWindows,
  splitZhuqueDisplaySentences
} from '../src/main/perplexity/zhuque-token-windows'
import {
  computeZhuqueRewriteRisk,
  isMeaningfulRewriteImprovement,
  isZhuqueRewriteTarget
} from '../src/main/perplexity/zhuque-rewrite-risk'
import { ZHUQUE_BLIND_SAMPLES } from './zhuque-blind-corpus'
import {
  validateZhuqueCalibrationCorpus,
  ZHUQUE_CALIBRATION_SAMPLES
} from './zhuque-calibration-corpus'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readExperiment = (name: string): string =>
  fs.readFileSync(path.join(projectRoot, 'docs/experiments', name), 'utf8')

function testTokenWindows(text: string) {
  // Qwen 中文实测约 1 token = 1.28 个 UTF-16 字符；逻辑测试只模拟边界，
  // 真正校准仍使用模型 tokenizer 返回的偏移。
  const tokenCount = Math.ceil(text.length / 1.28)
  return buildZhuqueTokenWindows(text, Array.from({ length: tokenCount }, (_, tokenIndex) => {
    const charOffset = Math.floor(tokenIndex * 1.28)
    const nextOffset = Math.min(text.length, Math.floor((tokenIndex + 1) * 1.28))
    return {
      charOffset,
      charLen: Math.max(1, nextOffset - charOffset),
      logProb: -Math.log(83),
      prob: 0.183,
      inTop5: tokenIndex % 2 === 0
    }
  }))
}

function analyzeForTest(text: string) {
  return analyzeZhuqueDistribution(text, testTokenWindows(text))
}

assert.deepEqual(validateZhuqueCalibrationCorpus(), [], '朱雀校准语料的完整/部分标注契约必须有效')
assert.equal(ZHUQUE_CALIBRATION_SAMPLES.filter(sample => sample.expected.coverage === 'complete').length, 10)
assert.deepEqual(
  ZHUQUE_CALIBRATION_SAMPLES
    .filter(sample => sample.expected.coverage === 'partial')
    .map(sample => sample.file),
  ['F6-inject-filmshot.txt', 'F4-inject-connector.txt'],
  '只有缺失原始三分类记录的 F4/F6 可以使用部分标注'
)

const humanText = readExperiment('A1-human.txt')
const segmented = segmentTextForZhuque(humanText)
assert.equal(segmented.map(segment => segment.text).join(''), humanText, '分段不得丢失短句、空行或标点')
assert.ok(segmented.length >= 3 && segmented.length <= 7, `千字样本应接近朱雀分段粒度，实际 ${segmented.length} 段`)
assert.ok(segmented.slice(0, -1).every(segment => segment.text.length >= 140 && segment.text.length <= 320))

const displaySentences = splitZhuqueDisplaySentences(humanText)
assert.equal(displaySentences.map(sentence => sentence.text).join(''), humanText, '句级展示不得改变原文')
assert.ok(displaySentences.length > segmented.length, '展示粒度必须是完整句子，不再复用240字符计算段')
const tokenWindows = testTokenWindows(humanText)
assert.ok(tokenWindows.every(window => window.endToken - window.startToken <= 384), '计算窗口不得超过384 tokens')
assert.ok(
  tokenWindows.slice(1).every((window, index) => window.startToken < tokenWindows[index].endToken),
  '相邻计算窗口必须重叠，避免边界句证据突变'
)
assert.equal(tokenWindows[tokenWindows.length - 1].end, humanText.length, '最后一个token窗口必须覆盖全文尾部')
assert.equal(attributeTokenWindowsToSpans(displaySentences, tokenWindows).length, displaySentences.length)

const predictable = computeZhuqueTokenRisk({ ppl: 24, top5Rate: 0.78, avgProb: 0.34, tokenCount: 80 })
const humanBaseline = computeZhuqueTokenRisk({ ppl: 83, top5Rate: 0.505, avgProb: 0.183, tokenCount: 80 })
const disrupted = computeZhuqueTokenRisk({ ppl: 260, top5Rate: 0.16, avgProb: 0.025, tokenCount: 80 })
assert.ok(predictable > humanBaseline, '高可预测 n-gram 应提高 AI 风险')
assert.ok(humanBaseline > disrupted, '低概率/乱序 n-gram 应降低风险，不能再反向判 AI')
assert.equal(
  computeZhuqueRewriteRisk({ human: 7.7, suspected_ai: 51.2, ai: 41.1 }),
  74.4,
  '改写优先级必须使用三分类融合，不能退回原始token分'
)
assert.ok(isZhuqueRewriteTarget(74.4), '截图中的高融合风险段必须进入自动改写')
assert.ok(!isZhuqueRewriteTarget(40), '低于改写阈值的段落必须保留原文')
assert.ok(isMeaningfulRewriteImprovement(74.4, 72.8), '下降超过1.5分的候选可以进入下一轮')
assert.ok(!isMeaningfulRewriteImprovement(74.4, 73.2), '下降不足1.5分的候选不得覆盖上一版')

const filmShot = detectZhuqueFingerprints(readExperiment('F6-inject-filmshot.txt'))
const connectors = detectZhuqueFingerprints(readExperiment('F4-inject-connector.txt'))
const emotion = detectZhuqueFingerprints(readExperiment('F1-inject-emotion-template.txt'))
const uniformSentence = detectZhuqueFingerprints(readExperiment('F8-inject-uniform-sentlen.txt'))
const simile = detectZhuqueFingerprints(readExperiment('F3-inject-simile.txt'))
assert.ok(filmShot.penalty > connectors.penalty, '电影镜头链权重应高于连接词')
assert.ok(connectors.penalty > 0 && emotion.penalty > 0, '已验证的连接词和情感模板必须参与评分')
assert.equal(uniformSentence.penalty, 0, '句长均匀化已被朱雀实验排除，不得加罚')
assert.equal(simile.penalty, 0, '比喻/仿佛已被朱雀实验排除，不得加罚')

const neutralMetric = { ppl: 83, top5Rate: 0.505, avgProb: 0.183, tokenCount: 80 }
const highMetric = { ppl: 22, top5Rate: 0.82, avgProb: 0.38, tokenCount: 80 }
const humanDraft = scoreZhuqueSegment('口语跳跃、低概率词组较多的一段人工文本。'.repeat(12), neutralMetric)
const aiDraft = scoreZhuqueSegment('结构稳定且高度可预测的一段文本。'.repeat(15), highMetric)
const structuredText = [
  '寒风穿过破庙，他靠在墙边，指尖反复摩挲暖玉。',
  '因为寿数只剩八十天，所以胸口的痒意一天比一天更重。',
  '那是浊灵气侵体留下的本能，意味着他的神智随时可能崩溃。',
  '镇丁踹开庙门，把木牌扔在地上，为了逼他接任务，又把镇长的规矩解释了一遍。',
  '他弯腰捡起木牌，等脚步彻底消失才起身，因为他必须确认外面没人盯梢。',
  '他摸出破灵弩，检查箭头，确认药膜完好，这才把胸口的痒意压回去。',
  '每一个动作都有原因，每一个原因都立即得到说明，段落稳定地向前推进。',
  '环境引出反应，反应引出解释，解释补足背景，背景再推动下一步行动。'
].join('\n')
const structuredFeatures = analyzeForTest(structuredText)
assert.ok(structuredFeatures.causalClosure >= 58, `即时因果闭合应形成文档证据，实际 ${structuredFeatures.causalClosure}`)
assert.ok(structuredFeatures.documentRisk >= 48, `多维文档风险不应被高困惑度直接清零，实际 ${structuredFeatures.documentRisk}`)

const structuredSegments = segmentTextForZhuque(structuredText).map(segment =>
  scoreZhuqueSegment(segment.text, neutralMetric)
)
const structuredResult = classifyZhuqueSegments(structuredSegments, structuredFeatures)
assert.ok(
  structuredResult.some(segment => segment.category !== 'human'),
  `结构、信息和因果证据必须进入最终分类，不能再仅凭token指标判100%人工：${JSON.stringify({ structuredFeatures, structuredResult })}`
)

const unevenHumanText = [
  '风挺大，味道也怪，反正一进鼻子就难受。',
  '沈彻缩在庙里。冷。',
  '那块玉他摸了又摸，为什么来着？忘了，可能就是手闲不住。',
  '外头有人骂了一句，很远，后面的话没听清。',
  '他本来想出去。算了。',
  '过了一会儿又站起来，先找鞋，鞋还少了一只。',
  '命只剩八十来天这事倒没想，至少这会儿没想，他在墙角翻了半天。',
  '弩还在。箭呢？箭压在破布下面，差点硌了手。'
].join('\n')
const unevenFeatures = analyzeForTest(unevenHumanText)
assert.ok(
  unevenFeatures.documentRisk < structuredFeatures.documentRisk,
  '自然的注意力跳跃和信息失衡应比工整闭合文本风险更低'
)

const b1FullText = readExperiment('B1-zhuque-ai100-local-human100.txt')
const b1ShortEnd = b1FullText.indexOf('破灵弩。') + '破灵弩。'.length
const b1ShortText = b1FullText.slice(0, b1ShortEnd)
assert.equal(b1ShortText.replace(/\s/g, '').length, 531, '截图中的铁壁镇前缀必须保持531个有效字符')
const b1ShortFeatures = analyzeForTest(b1ShortText)
assert.ok(
  b1ShortFeatures.documentRisk >= 38 && b1ShortFeatures.peakWindowRisk < 40,
  `短文本回归必须覆盖“整篇结构风险成立、局部峰值未过硬门槛”的情况：${JSON.stringify(b1ShortFeatures)}`
)
const b1ShortDrafts = segmentTextForZhuque(b1ShortText).map(segment => ({
  ...scoreZhuqueSegment(segment.text, neutralMetric),
  score: 40
}))
const b1ShortDistribution = computeZhuqueDistribution(
  classifyZhuqueSegments(b1ShortDrafts, b1ShortFeatures)
)
assert.ok(
  b1ShortDistribution.human < 35 && b1ShortDistribution.suspected_ai + b1ShortDistribution.ai > 65,
  `531字截图反例的整篇结构证据不得再次被窗口硬门槛清零：${JSON.stringify({ b1ShortFeatures, b1ShortDistribution })}`
)

for (const sample of ZHUQUE_BLIND_SAMPLES) {
  const text = readExperiment(sample.file)
  const features = analyzeForTest(text)
  const drafts = segmentTextForZhuque(text).map(segment => scoreZhuqueSegment(segment.text, neutralMetric))
  const result = classifyZhuqueSegments(drafts, features)
  const distribution = computeZhuqueDistribution(result)
  console.log(`盲测 ${sample.name}: ${JSON.stringify({ features, scores: result.map(item => item.score), distribution })}`)
  assert.ok(
    distribution.human < 35 && distribution.suspected_ai + distribution.ai > 65,
    `${sample.name} 是独立外部反例，多维主链不得再次判成人工主导：${JSON.stringify({ features, distribution })}`
  )
  const screenshotRiskDrafts = drafts.map(draft => ({ ...draft, score: 40 }))
  const screenshotDistribution = computeZhuqueDistribution(
    classifyZhuqueSegments(screenshotRiskDrafts, features)
  )
  console.log(`截图风险40融合结果: ${JSON.stringify(screenshotDistribution)}`)
  assert.ok(
    screenshotDistribution.human < 35 &&
      screenshotDistribution.ai > 0 && screenshotDistribution.suspected_ai > 0 &&
      screenshotDistribution.ai + screenshotDistribution.suspected_ai > 65,
    `截图所示token风险40应与结构证据连续融合，不能退回人工主导：${JSON.stringify(screenshotDistribution)}`
  )
  const renderedSegments = toAigcSegments(classifyZhuqueSegments(screenshotRiskDrafts, features))
  assert.ok(
    renderedSegments.every(segment => (segment.probabilities?.ai ?? 0) > 0),
    'AI概率必须传到渲染层，不能只保留疑似AI主类别导致正文没有红色标记'
  )
  const localHumanProbabilities = renderedSegments.map(segment =>
    Math.round((segment.probabilities?.human ?? 100) * 10) / 10
  )
  assert.ok(
    new Set(localHumanProbabilities).size > 1,
    `段落悬停概率必须来自局部窗口，不能全部复用整篇人工概率：${JSON.stringify(localHumanProbabilities)}`
  )
}

const frontHuman = computeZhuqueDistribution([
  { ...humanDraft, category: 'human' },
  { ...humanDraft, category: 'human' },
  { ...aiDraft, category: 'ai' },
  { ...aiDraft, category: 'ai' }
])
const tailHuman = computeZhuqueDistribution([
  { ...aiDraft, category: 'ai' },
  { ...aiDraft, category: 'ai' },
  { ...humanDraft, category: 'human' },
  { ...humanDraft, category: 'human' }
])
assert.ok(frontHuman.human > tailHuman.human, '同等比例下，人类文本前置的人工权重应更高')

console.log('朱雀对齐检测回归测试通过')
