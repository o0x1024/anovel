import type { AigcCategory, AigcDetectResult, AigcSegment } from '../../shared/aigc-detect-types'
import { getDetectThresholds } from './constants'

const CONNECTOR_REGEX = /(然而|因此|此外|同时|不禁|仿佛|与此同时|值得注意的是|不难发现|由此可见|换言之|总而言之|不仅如此|尽管如此)/g
const SENTENCE_BREAK_CHARS = new Set(['。', '！', '？', '!', '?', ';', '；', '\n'])
const TRAILING_QUOTE_CHARS = new Set(['"', "'", '”', '’', '）', '】', '》', '」', '』'])

export type DocMetrics = {
  sentenceStd: number
  adjacentChangeRate: number
  paragraphCv: number
}

function clampScore(score: number): number {
  if (score < 0) return 0
  if (score > 100) return 100
  return score
}

function splitSentenceUnits(text: string): string[] {
  if (!text) return []
  const units: string[] = []
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (SENTENCE_BREAK_CHARS.has(ch)) {
      let end = i + 1
      while (end < text.length && TRAILING_QUOTE_CHARS.has(text[end])) end++
      while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++
      units.push(text.slice(start, end))
      start = end
      i = end
      continue
    }
    i++
  }
  if (start < text.length) units.push(text.slice(start))
  return units.filter(u => u.length > 0)
}

function computeStd(values: number[]): number {
  if (values.length <= 1) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

export function computeDocMetrics(text: string): DocMetrics {
  const sentenceUnits = splitSentenceUnits(text).map(u => u.trim()).filter(Boolean)
  const sentenceLens = sentenceUnits.map(s => s.length)
  const sentenceStd = computeStd(sentenceLens)

  let adjacentChangeRate = 0
  if (sentenceLens.length > 1) {
    let changed = 0
    for (let i = 1; i < sentenceLens.length; i++) {
      const prev = sentenceLens[i - 1]
      const curr = sentenceLens[i]
      const maxLen = Math.max(prev, curr, 1)
      const ratio = Math.abs(curr - prev) / maxLen
      if (ratio >= 0.5) changed += 1
    }
    adjacentChangeRate = changed / (sentenceLens.length - 1)
  }

  const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(Boolean)
  const paragraphLens = paragraphs.map(p => p.length)
  const paragraphMean = paragraphLens.length ? paragraphLens.reduce((a, b) => a + b, 0) / paragraphLens.length : 0
  const paragraphCv = paragraphMean > 0 ? computeStd(paragraphLens) / paragraphMean : 0

  return { sentenceStd, adjacentChangeRate, paragraphCv }
}

/**
 * 启发式 AI 风险评分（0-100，越高越像 AI）
 * 校准来源：mix-ai 朱雀样本，MAE≈19.8%
 */
export function computeHeuristicAiScore(text: string, docMetrics: DocMetrics, baseScore = 52): number {
  const sentences = splitSentenceUnits(text).map(u => u.trim()).filter(Boolean)
  const sentenceLens = sentences.map(s => s.length)
  const sentenceCount = Math.max(1, sentences.length)
  const avgLen = sentenceLens.length ? sentenceLens.reduce((a, b) => a + b, 0) / sentenceLens.length : text.length
  const connectorHits = (text.match(CONNECTOR_REGEX) || []).length
  const connectorDensity = connectorHits / sentenceCount
  const quoteHits = (text.match(/[“”"'‘’]/g) || []).length
  const quoteRatio = quoteHits / Math.max(1, text.length)
  const localStd = computeStd(sentenceLens)

  let localAdjacentChangeRate = 0
  if (sentenceLens.length > 1) {
    let changed = 0
    for (let i = 1; i < sentenceLens.length; i++) {
      const prev = sentenceLens[i - 1]
      const curr = sentenceLens[i]
      const maxLen = Math.max(prev, curr, 1)
      const ratio = Math.abs(curr - prev) / maxLen
      if (ratio >= 0.5) changed += 1
    }
    localAdjacentChangeRate = changed / (sentenceLens.length - 1)
  }

  const shortSentenceRatio = sentenceLens.filter(len => len <= 10).length / sentenceCount
  const oralNoiseHits = (text.match(/[？！…—]|(嗯|啊|诶|欸|唉|哈)\b/g) || []).length

  let score = baseScore

  if (connectorDensity > 0.2) score += 14
  else if (connectorDensity > 0.1) score += 8
  else if (connectorDensity > 0.05) score += 3

  if (avgLen >= 20 && avgLen <= 42) score += 4
  else if (avgLen < 10) score -= 2

  if (quoteRatio < 0.004) score += 4
  else if (quoteRatio > 0.035) score -= 3

  if (/(仿佛|宛如|犹如|与此同时|值得注意的是|不难发现|由此可见|总而言之)/.test(text)) {
    score += 10
  }

  if (localStd < 5) score += 8
  else if (localStd < 8) score += 4
  else if (localStd > 18) score -= 5

  if (localAdjacentChangeRate < 0.2) score += 6
  else if (localAdjacentChangeRate > 0.5) score -= 5

  if (shortSentenceRatio > 0.55) score -= 3
  else if (shortSentenceRatio < 0.08) score += 4

  if (oralNoiseHits >= 4) score -= 2

  if (docMetrics.sentenceStd < 7) score += 2
  if (docMetrics.adjacentChangeRate < 0.18) score += 2
  if (docMetrics.paragraphCv < 0.3) score += 2

  if (docMetrics.sentenceStd > 14) score -= 3
  if (docMetrics.adjacentChangeRate > 0.4) score -= 3
  if (docMetrics.paragraphCv > 0.6) score -= 3

  return clampScore(Math.round(score))
}

function heuristicReason(text: string, score: number, category: AigcCategory): string {
  if (category === 'human') return '节奏/句长差异大'

  const sentences = splitSentenceUnits(text).map(u => u.trim()).filter(Boolean)
  const sentenceLens = sentences.map(s => s.length)
  const localStd = sentenceLens.length > 1 ? computeStd(sentenceLens) : 0
  const connectorHits = (text.match(CONNECTOR_REGEX) || []).length
  const avgLen = sentenceLens.length ? sentenceLens.reduce((a, b) => a + b, 0) / sentenceLens.length : text.length

  if (connectorHits > 0) return '含模板连接词'
  if (localStd < 5) return '句长过于均匀'
  if (localStd < 8) return '句长波动偏小'
  if (avgLen >= 20 && avgLen <= 30 && localStd < 10) return '句长集中在20-30字'
  if (score >= 76) return '结构高度模板化'
  return '节奏偏工整'
}

function classifyByHeuristicScore(score: number, modelId?: string): AigcCategory {
  const T = getDetectThresholds(modelId).classify
  if (score >= T.aiFloor) return 'ai'
  if (score <= T.humanCeiling) return 'human'
  return 'suspected_ai'
}

function computeDistribution(segments: AigcSegment[]) {
  const totalChars = segments.reduce((sum, s) => sum + s.text.length, 0)
  const distribution = { human: 0, suspected_ai: 0, ai: 0 }
  for (const seg of segments) {
    distribution[seg.category] += seg.text.length
  }
  if (totalChars > 0) {
    distribution.human = Math.round((distribution.human / totalChars) * 10000) / 100
    distribution.ai = Math.round((distribution.ai / totalChars) * 10000) / 100
    distribution.suspected_ai = Math.round((100 - distribution.human - distribution.ai) * 100) / 100
  }
  return distribution
}

/**
 * API logprobs 退化时的启发式检测路径（deepseek-v4-flash 等云端复述模式）
 */
export function runHeuristicDetect(
  text: string,
  segments: Array<{ id: number; text: string }>,
  modelId?: string
): AigcDetectResult {
  const thresholds = getDetectThresholds(modelId)
  const baseScore = thresholds.heuristicBaseScore ?? 52
  const docMetrics = computeDocMetrics(text)

  const rawScores = segments.map(seg => computeHeuristicAiScore(seg.text, docMetrics, baseScore))
  const docScore = rawScores.length > 0
    ? rawScores.reduce((a, b) => a + b, 0) / rawScores.length
    : 50

  const bias = thresholds.docBias
  const resultSegments: AigcSegment[] = segments.map((seg, i) => {
    let adjustedScore = rawScores[i]
    if (docScore >= bias.boostThreshold) {
      const boost = Math.min(bias.boostMax, (docScore - bias.boostThreshold) * bias.boostFactor)
      adjustedScore = Math.min(100, adjustedScore + boost)
    } else if (docScore <= bias.reduceThreshold) {
      const reduction = Math.min(bias.reduceMax, (bias.reduceThreshold - docScore) * bias.reduceFactor)
      adjustedScore = Math.max(0, adjustedScore - reduction)
    }

    const category = classifyByHeuristicScore(adjustedScore, modelId)
    return {
      text: seg.text,
      category,
      reason: heuristicReason(seg.text, adjustedScore, category)
    }
  })

  const distribution = computeDistribution(resultSegments)
  const summary = `检测完成（启发式模式）：人工 ${distribution.human}%，疑似AI ${distribution.suspected_ai}%，AI特征 ${distribution.ai}%。`

  return { segments: resultSegments, distribution, summary }
}
