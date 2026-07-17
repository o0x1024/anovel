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
  segmentTextForZhuque
} from '../src/main/perplexity/zhuque-alignment'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readExperiment = (name: string): string =>
  fs.readFileSync(path.join(projectRoot, 'docs/experiments', name), 'utf8')

const humanText = readExperiment('A1-human.txt')
const segmented = segmentTextForZhuque(humanText)
assert.equal(segmented.map(segment => segment.text).join(''), humanText, '分段不得丢失短句、空行或标点')
assert.ok(segmented.length >= 3 && segmented.length <= 7, `千字样本应接近朱雀分段粒度，实际 ${segmented.length} 段`)
assert.ok(segmented.slice(0, -1).every(segment => segment.text.length >= 140 && segment.text.length <= 320))

const predictable = computeZhuqueTokenRisk({ ppl: 24, top5Rate: 0.78, avgProb: 0.34, tokenCount: 80 })
const humanBaseline = computeZhuqueTokenRisk({ ppl: 83, top5Rate: 0.505, avgProb: 0.183, tokenCount: 80 })
const disrupted = computeZhuqueTokenRisk({ ppl: 260, top5Rate: 0.16, avgProb: 0.025, tokenCount: 80 })
assert.ok(predictable > humanBaseline, '高可预测 n-gram 应提高 AI 风险')
assert.ok(humanBaseline > disrupted, '低概率/乱序 n-gram 应降低风险，不能再反向判 AI')

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
const interleaved = classifyZhuqueSegments([humanDraft, aiDraft, humanDraft, aiDraft])
assert.equal(interleaved[1].category, 'suspected_ai', '被人工段打断的孤立 AI 段应降为疑似AI')

const contiguous = classifyZhuqueSegments([aiDraft, aiDraft, aiDraft])
assert.ok(contiguous.every(segment => segment.category === 'ai'), '连续高风险段应保留 AI 特征分类')

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
