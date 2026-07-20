import type { WebContents } from 'electron'
import { modelService } from '../../model'
import { aiSessionManager, type AiSessionHandle } from '../../ai/ai-session-manager'
import type {
  AigcDetectResult,
  AigcSegment,
  AigcDistribution,
  AigcRewriteSelectionView
} from '../../../shared/aigc-detect-types'
import { normalizeModelBodyOutput } from '../../../shared/normalize-body-text'
import { appLogger } from '../../logger/app-logger'
import { aigcWordtableDAO, appPreferenceDAO, humanRewriteReferenceDAO } from '../../db'
import {
  runPerplexityDetect,
  getSegmentMetrics,
  isMeaningfulRewriteImprovement,
  isZhuqueRewriteTarget,
  ZHUQUE_REWRITE_TARGET_SCORE,
  type SegmentDetectDetail,
  type LabModelOverride
} from '../../perplexity'
import { applyWordTable } from './aigc-wordtable-engine'
import { BUILTIN_ANTI_AI_VOCAB } from './builtin-anti-ai-vocab'
import {
  computeChangeRatio,
  computeDialogueRetention,
  computeNumberAnchorRetention,
  evaluateRewriteCandidates,
  type RewriteCandidateInput
} from './aigc-rewrite-quality'
import type { WorkModelOptions } from '../../../shared/work-model-options'
import { ZHUQUE_MIN_TEXT_LENGTH } from '../../perplexity/zhuque-alignment'
import {
  HUMAN_REWRITE_AI_SYMPTOMS,
  HUMAN_REWRITE_SCENE_TYPES,
  type HumanRewritePlan,
  type HumanRewriteReference
} from '../../../shared/human-rewrite-reference-types'
import {
  findCopiedReferencePhrase,
  formatHumanRewriteReferences,
  parseHumanRewriteAssessments,
  selectHumanRewriteReferences
} from './human-rewrite-reference'
import type { AigcSentenceRewriteResult } from '../../../shared/aigc-sentence-rewrite-types'
import { runBlockRewrite } from './aigc-block-rewrite'
import { requiresFullDocumentSceneRewrite } from './aigc-scene-rewrite-quality'
import {
  evaluateAigcRewriteVerification,
  markAiAssistedRewrite,
  runBoundedRewriteAttempts
} from '../../../shared/aigc-rewrite-verification'
import { runSupervisedAigcDetect } from '../../supervised-aigc'
import { fuseAigcDetection } from './aigc-detect-fusion'

const activeRuns = new Map<string, AiSessionHandle>()
const activeRewriteRuns = new Map<string, AiSessionHandle>()
const MAX_LOCAL_REWRITE_ATTEMPTS = 3
const MAX_SENTENCE_REWRITE_ATTEMPTS = 4

interface CachedSegmentMetrics {
  textHash: number
  segments: SegmentDetectDetail[]
  docScore: number
  timestamp: number
}

let lastDetectMetricsCache: CachedSegmentMetrics | null = null
const METRICS_CACHE_TTL_MS = 5 * 60 * 1000

function simpleTextHash(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0
  }
  return h
}

function cacheSegmentMetrics(text: string, segments: SegmentDetectDetail[], docScore: number): void {
  lastDetectMetricsCache = {
    textHash: simpleTextHash(text),
    segments,
    docScore,
    timestamp: Date.now()
  }
}

function getCachedSegmentMetrics(text: string): { segments: SegmentDetectDetail[]; docScore: number } | null {
  if (!lastDetectMetricsCache) return null
  if (Date.now() - lastDetectMetricsCache.timestamp > METRICS_CACHE_TTL_MS) {
    lastDetectMetricsCache = null
    return null
  }
  if (simpleTextHash(text) !== lastDetectMetricsCache.textHash) return null
  return { segments: lastDetectMetricsCache.segments, docScore: lastDetectMetricsCache.docScore }
}
const AIGC_DETECT_FUSION_DEBUG = process.env.ANOVEL_AIGC_DETECT_FUSION_DEBUG === '1'

const AIGC_DETECT_SYSTEM_PROMPT = `你是 AIGC 文本检测器。

输入是一个 JSON 数组 segments，每项包含：
- id: 片段编号
- text: 片段原文

判定要求（必须遵守）：
1) 只对每个 id 做分类，不要改写 text，不要返回 text。
2) 先看局部证据再给分：句长波动、短句/口语噪声、连接词密度、段落节奏、模板化表达重复。
3) score 必须真实区分，不允许整篇大量重复同一分值和同一理由。
4) 仅当片段同时满足至少2项“人类噪声证据”（口语跳跃、断裂、不均匀节奏、非常规表达）且无明显模板痕迹时才可判 human。
5) reason 必须是该片段可观察证据，12字内，禁止整篇复用同一句话。
6) 禁止整篇几乎全部判为同一类别；若确实同类，必须体现显著的 score 与证据差异。

输出必须是纯 JSON，不要 Markdown，不要解释：
{
  "items": [
    { "id": 1, "category": "human|suspected_ai|ai", "score": 0-100, "reason": "12字内理由" }
  ],
  "summary": "一句话结论"
}`


type DraftSegment = {
  id: number
  text: string
}

type ModelDetectItem = {
  id: number
  category?: AigcSegment['category']
  score?: number
  reason?: string
}

type DocMetrics = {
  sentenceStd: number
  adjacentChangeRate: number
  paragraphCv: number
}

type ModelScoreSemantics = 'ai_risk' | 'human_confidence' | 'unknown'
type ScoreThresholds = {
  humanUpper: number
  aiLower: number
}

const DEFAULT_SCORE_THRESHOLDS: ScoreThresholds = {
  humanUpper: 38,
  aiLower: 82
}

const STRICT_SCORE_THRESHOLDS: ScoreThresholds = {
  humanUpper: 42,
  aiLower: 76
}

const CONNECTOR_REGEX = /(然而|因此|此外|同时|不禁|仿佛|与此同时|值得注意的是|不难发现|由此可见|换言之|总而言之|不仅如此|尽管如此)/g
const SENTENCE_BREAK_CHARS = new Set(['。', '！', '？', '!', '?', ';', '；', '\n'])
const TRAILING_QUOTE_CHARS = new Set(['"', "'", '”', '’', '）', '】', '》', '」', '』'])

function clampScore(score: number): number {
  if (score < 0) return 0
  if (score > 100) return 100
  return score
}

function uniqueCount(values: string[]): number {
  return new Set(values.filter(Boolean)).size
}

function categoryToScore(category: AigcSegment['category']): number {
  if (category === 'ai') return 85
  if (category === 'suspected_ai') return 55
  return 20
}

function scoreToCategory(score: number, thresholds: ScoreThresholds = DEFAULT_SCORE_THRESHOLDS): AigcSegment['category'] {
  if (score >= thresholds.aiLower) return 'ai'
  if (score >= thresholds.humanUpper) return 'suspected_ai'
  return 'human'
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
  if (start < text.length) {
    units.push(text.slice(start))
  }
  return units.filter((u) => u.length > 0)
}

function buildDraftSegments(text: string): DraftSegment[] {
  const units = splitSentenceUnits(text)
  if (units.length === 0) return [{ id: 1, text }]

  const drafts: DraftSegment[] = []
  let id = 1
  let i = 0

  while (i < units.length) {
    let count = 0
    let totalChars = 0
    let segText = ''

    while (i < units.length) {
      const next = units[i]
      count += 1
      totalChars += next.length
      segText += next
      i += 1

      if (count >= 4) break
      if (count >= 3 && totalChars >= 180) break
      if (count >= 2 && /\n\n/.test(segText)) break
    }
    drafts.push({ id: id++, text: segText })
  }

  if (drafts.length > 1) {
    const last = drafts[drafts.length - 1]
    if (last.text.trim().length < 20) {
      drafts[drafts.length - 2].text += last.text
      drafts.pop()
    }
  }

  return drafts.map((seg, idx) => ({ id: idx + 1, text: seg.text }))
}

function computeStd(values: number[]): number {
  if (values.length <= 1) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function computeDocMetrics(text: string): DocMetrics {
  const sentenceUnits = splitSentenceUnits(text).map((u) => u.trim()).filter(Boolean)
  const sentenceLens = sentenceUnits.map((s) => s.length)
  const sentenceStd = computeStd(sentenceLens)

  let adjacentChangeRate = 0
  if (sentenceLens.length > 1) {
    let changed = 0
    for (let i = 1; i < sentenceLens.length; i += 1) {
      const prev = sentenceLens[i - 1]
      const curr = sentenceLens[i]
      const maxLen = Math.max(prev, curr, 1)
      const ratio = Math.abs(curr - prev) / maxLen
      if (ratio >= 0.5) changed += 1
    }
    adjacentChangeRate = changed / (sentenceLens.length - 1)
  }

  const paragraphs = text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const paragraphLens = paragraphs.map((p) => p.length)
  const paragraphMean = paragraphLens.length ? paragraphLens.reduce((a, b) => a + b, 0) / paragraphLens.length : 0
  const paragraphCv = paragraphMean > 0 ? computeStd(paragraphLens) / paragraphMean : 0

  return { sentenceStd, adjacentChangeRate, paragraphCv }
}

function computeHeuristicScore(text: string, docMetrics: DocMetrics): number {
  const sentences = splitSentenceUnits(text).map((u) => u.trim()).filter(Boolean)
  const sentenceLens = sentences.map((s) => s.length)
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
    for (let i = 1; i < sentenceLens.length; i += 1) {
      const prev = sentenceLens[i - 1]
      const curr = sentenceLens[i]
      const maxLen = Math.max(prev, curr, 1)
      const ratio = Math.abs(curr - prev) / maxLen
      if (ratio >= 0.5) changed += 1
    }
    localAdjacentChangeRate = changed / (sentenceLens.length - 1)
  }
  const shortSentenceRatio = sentenceLens.filter((len) => len <= 10).length / sentenceCount
  const oralNoiseHits = (text.match(/[？！…—]|(嗯|啊|诶|欸|唉|哈)\b/g) || []).length

  // 基线偏高：中文小说默认"有嫌疑"，需强证据才判 human。
  let score = 58

  if (connectorDensity > 0.2) score += 14
  else if (connectorDensity > 0.1) score += 8
  else if (connectorDensity > 0.05) score += 3

  if (avgLen >= 20 && avgLen <= 42) score += 4
  else if (avgLen < 10) score -= 2

  // 引号/对话密集不应大幅减分——AI 小说同样产出大量对话。
  if (quoteRatio < 0.004) score += 4
  else if (quoteRatio > 0.035) score -= 3

  if (/(仿佛|宛如|犹如|与此同时|值得注意的是|不难发现|由此可见|总而言之)/.test(text)) {
    score += 10
  }

  // 句长均匀性是最强 AI 信号。
  if (localStd < 5) score += 8
  else if (localStd < 8) score += 4
  else if (localStd > 18) score -= 5

  if (localAdjacentChangeRate < 0.2) score += 6
  else if (localAdjacentChangeRate > 0.5) score -= 5

  // 短句/口语噪声仅微弱减分：AI 生成小说也有大量短句对话和语气词。
  if (shortSentenceRatio > 0.55) score -= 3
  else if (shortSentenceRatio < 0.08) score += 4

  if (oralNoiseHits >= 4) score -= 2

  // 全文基线仅作轻微校准。
  if (docMetrics.sentenceStd < 7) score += 2
  if (docMetrics.adjacentChangeRate < 0.18) score += 2
  if (docMetrics.paragraphCv < 0.3) score += 2

  if (docMetrics.sentenceStd > 14) score -= 3
  if (docMetrics.adjacentChangeRate > 0.4) score -= 3
  if (docMetrics.paragraphCv > 0.6) score -= 3

  return clampScore(Math.round(score))
}

function heuristicReason(text: string, score: number, category: AigcSegment['category']): string {
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

function inferModelScoreSemantics(itemsMap: Map<number, ModelDetectItem>): ModelScoreSemantics {
  const paired = Array.from(itemsMap.values()).filter(
    (item) => typeof item.score === 'number' && !!item.category
  )
  if (paired.length < 6) return 'unknown'

  const byCategory: Record<AigcSegment['category'], number[]> = {
    human: [],
    suspected_ai: [],
    ai: []
  }
  for (const item of paired) {
    const category = item.category as AigcSegment['category']
    byCategory[category].push(item.score as number)
  }

  const avg = (arr: number[]): number | null =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null

  const humanAvg = avg(byCategory.human)
  const suspectAvg = avg(byCategory.suspected_ai)
  const aiAvg = avg(byCategory.ai)
  const presentKinds = [humanAvg, suspectAvg, aiAvg].filter(v => v !== null).length

  if (presentKinds >= 2 && humanAvg !== null && aiAvg !== null) {
    if (humanAvg > aiAvg + 6) return 'human_confidence'
    if (aiAvg > humanAvg + 6) return 'ai_risk'
  }
  if (presentKinds >= 2 && humanAvg !== null && suspectAvg !== null) {
    if (humanAvg > suspectAvg + 4) return 'human_confidence'
    if (suspectAvg > humanAvg + 4) return 'ai_risk'
  }

  // 单类输出时：仅作弱推断，避免误判方向。
  if (presentKinds === 1 && byCategory.human.length >= 6 && humanAvg !== null && humanAvg >= 60) {
    return 'human_confidence'
  }
  if (presentKinds === 1 && byCategory.ai.length >= 6 && aiAvg !== null && aiAvg >= 60) {
    return 'ai_risk'
  }

  return 'unknown'
}

function normalizeModelScore(
  rawScore: number,
  category: AigcSegment['category'] | undefined,
  semantics: ModelScoreSemantics
): number {
  if (semantics === 'ai_risk') return clampScore(rawScore)
  if (semantics === 'human_confidence') return clampScore(100 - rawScore)

  // 语义未知时，若有 category，则选与 category 语义更一致的方向。
  if (category) {
    const expected = categoryToScore(category)
    const direct = clampScore(rawScore)
    const inverted = clampScore(100 - rawScore)
    return Math.abs(direct - expected) <= Math.abs(inverted - expected) ? direct : inverted
  }
  return clampScore(rawScore)
}

type ModelHumanBias = 'collapse' | 'biased' | 'normal'

function detectModelHumanBias(
  itemsMap: Map<number, ModelDetectItem>,
  expectedCount: number,
  scoreSemantics: ModelScoreSemantics
): ModelHumanBias {
  if (scoreSemantics !== 'human_confidence') return 'normal'
  if (expectedCount < 8) return 'normal'

  const categories: AigcSegment['category'][] = []
  for (const item of itemsMap.values()) {
    if (item.category) categories.push(item.category)
  }
  if (categories.length < Math.floor(expectedCount * 0.6)) return 'normal'

  const humanCount = categories.filter(c => c === 'human').length
  const humanRatio = humanCount / categories.length

  if (humanRatio >= 0.88) {
    const humanScores = Array.from(itemsMap.values())
      .filter(item => item.category === 'human' && typeof item.score === 'number')
      .map(item => item.score as number)
    const humanMean = humanScores.length > 0
      ? humanScores.reduce((a, b) => a + b, 0) / humanScores.length
      : 0
    if (humanMean >= 72) return 'collapse'
  }

  if (humanRatio >= 0.75) return 'biased'

  return 'normal'
}

function buildDetectUserPrompt(segments: DraftSegment[]): string {
  return [
    '请对以下 segments 执行 AIGC 检测分类。',
    '注意：只返回每个 id 的判定，不要改写 text。',
    '',
    JSON.stringify(segments, null, 2)
  ].join('\n')
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  try {
    JSON.parse(trimmed)
    return trimmed
  } catch { /* ignore */ }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    const candidate = fenced[1].trim()
    try {
      JSON.parse(candidate)
      return candidate
    } catch { /* ignore */ }
  }

  const first = trimmed.indexOf('{')
  if (first === -1) return null
  for (let end = trimmed.lastIndexOf('}'); end > first; end -= 1) {
    const candidate = trimmed.slice(first, end + 1)
    try {
      JSON.parse(candidate)
      return candidate
    } catch { /* keep trying */ }
  }

  return null
}

function isDegenerateModelOutput(itemsMap: Map<number, ModelDetectItem>, expectedCount: number): boolean {
  if (itemsMap.size < Math.max(6, Math.floor(expectedCount * 0.6))) {
    return true
  }

  const categories: string[] = []
  const reasons: string[] = []
  const scores: number[] = []
  for (const item of itemsMap.values()) {
    if (item.category) categories.push(item.category)
    if (item.reason) reasons.push(item.reason)
    if (typeof item.score === 'number') scores.push(item.score)
  }

  if (categories.length === 0) return true
  const categoryKinds = uniqueCount(categories)
  const reasonKinds = uniqueCount(reasons)
  const scoreStd = scores.length > 1 ? computeStd(scores) : 0
  const scoreRange = scores.length > 0 ? Math.max(...scores) - Math.min(...scores) : 0
  const scoreMean = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 50
  const categoryCountMap = categories.reduce<Record<string, number>>((acc, c) => {
    acc[c] = (acc[c] || 0) + 1
    return acc
  }, {})
  const dominantCategoryRatio = categories.length > 0
    ? Math.max(...Object.values(categoryCountMap)) / categories.length
    : 1
  const dominantReasonRatio = reasons.length > 0
    ? Math.max(...Object.values(reasons.reduce<Record<string, number>>((acc, r) => {
      acc[r] = (acc[r] || 0) + 1
      return acc
    }, {}))) / reasons.length
    : 1

  // 单类不等于退化：只有“单类 + 分散度低 + 理由复用高”才判退化。
  if (expectedCount >= 10 && categoryKinds === 1) {
    const lowScoreDiversity = scoreStd < 4 || scoreRange < 12
    const lowReasonDiversity = reasonKinds <= 3 || dominantReasonRatio > 0.58
    if (lowScoreDiversity && lowReasonDiversity) return true
  }

  // 近似单类塌缩：类别极度集中且证据分散性不足。
  if (expectedCount >= 12 && dominantCategoryRatio >= 0.92) {
    const lowScoreDiversity = scoreStd < 3.2 || scoreRange < 10
    const lowReasonDiversity = reasonKinds <= 4 || dominantReasonRatio > 0.68
    if (lowScoreDiversity && lowReasonDiversity) return true
  }

  if (categoryKinds === 1 && (scoreMean <= 20 || scoreMean >= 80) && scoreStd < 2.5 && dominantReasonRatio > 0.75) return true
  if (categoryKinds === 1 && reasonKinds <= 2 && scoreStd < 4) return true
  if (categoryKinds <= 2 && scoreStd < 2 && dominantReasonRatio > 0.8) return true
  return false
}

function parseDetectResult(
  rawContent: string,
  drafts: DraftSegment[],
  originalText: string,
  debugCtx?: { runId: string; modelType?: string; modelName?: string }
): AigcDetectResult {
  const jsonPayload = extractJsonObject(rawContent)
  if (!jsonPayload) throw new Error('模型未返回有效 JSON')

  const parsed = JSON.parse(jsonPayload) as {
    items?: unknown[]
    summary?: string
  }

  const validCategories = new Set(['human', 'suspected_ai', 'ai'])
  const itemsMap = new Map<number, ModelDetectItem>()

  if (Array.isArray(parsed.items)) {
    for (const raw of parsed.items) {
      if (typeof raw !== 'object' || raw === null) continue
      const item = raw as Record<string, unknown>
      const id = Number(item.id)
      if (!Number.isInteger(id) || id <= 0) continue
      const categoryRaw = typeof item.category === 'string' ? item.category : undefined
      const category = categoryRaw && validCategories.has(categoryRaw)
        ? (categoryRaw as AigcSegment['category'])
        : undefined
      const score = typeof item.score === 'number' && Number.isFinite(item.score)
        ? clampScore(Math.round(item.score))
        : undefined
      const reason = typeof item.reason === 'string' ? item.reason.trim() : undefined
      itemsMap.set(id, { id, category, score, reason })
    }
  }

  const degenerateOutput = isDegenerateModelOutput(itemsMap, drafts.length)
  const scoreSemantics = inferModelScoreSemantics(itemsMap)
  const humanBias = detectModelHumanBias(itemsMap, drafts.length, scoreSemantics)
  const docMetrics = computeDocMetrics(originalText)
  const modelCoverage = drafts.length > 0 ? itemsMap.size / drafts.length : 0

  // 核心策略：当模型输出有明显人工偏置时，完全依赖启发式分类。
  const heuristicOnly = humanBias === 'collapse' || humanBias === 'biased'
  let modelWeight: number
  if (heuristicOnly) {
    modelWeight = 0
  } else if (degenerateOutput) {
    modelWeight = 0.22
  } else {
    modelWeight = modelCoverage >= 0.9 ? 0.55 : 0.45
    if (scoreSemantics === 'unknown') modelWeight = Math.max(0.2, modelWeight - 0.08)
  }
  const heuristicWeight = 1 - modelWeight
  const scoreThresholds = heuristicOnly ? STRICT_SCORE_THRESHOLDS : DEFAULT_SCORE_THRESHOLDS
  const modelScoreTrace: number[] = []
  const heuristicScoreTrace: number[] = []
  const blendedScoreTrace: number[] = []
  const segments: AigcSegment[] = drafts.map((draft) => {
    const modelItem = itemsMap.get(draft.id)
    const categoryScore = categoryToScore(modelItem?.category ?? 'suspected_ai')
    const normalizedRawScore = typeof modelItem?.score === 'number'
      ? normalizeModelScore(modelItem.score, modelItem?.category, scoreSemantics)
      : undefined
    const modelScore = typeof normalizedRawScore === 'number'
      ? Math.round(categoryScore * 0.7 + normalizedRawScore * 0.3)
      : categoryScore
    const heuristicScore = computeHeuristicScore(draft.text, docMetrics)
    const blendedScore = Math.round(modelScore * modelWeight + heuristicScore * heuristicWeight)
    modelScoreTrace.push(modelScore)
    heuristicScoreTrace.push(heuristicScore)
    blendedScoreTrace.push(blendedScore)
    const category = scoreToCategory(blendedScore, scoreThresholds)
    const reason = (!heuristicOnly && modelItem?.reason && !degenerateOutput)
      ? modelItem.reason
      : heuristicReason(draft.text, blendedScore, category)
    return {
      text: draft.text,
      category,
      reason
    }
  })

  const totalChars = segments.reduce((sum, s) => sum + s.text.length, 0)
  const distribution: AigcDistribution = { human: 0, suspected_ai: 0, ai: 0 }
  for (const seg of segments) {
    distribution[seg.category] += seg.text.length
  }

  if (totalChars > 0) {
    distribution.human = Math.round((distribution.human / totalChars) * 10000) / 100
    distribution.ai = Math.round((distribution.ai / totalChars) * 10000) / 100
    distribution.suspected_ai = Math.round((100 - distribution.human - distribution.ai) * 100) / 100
  }

  // 原始模型分类分布（按字符长度加权）用于诊断融合是否出现方向性偏差。
  const rawModelWeighted: AigcDistribution = { human: 0, suspected_ai: 0, ai: 0 }
  let rawCoveredChars = 0
  for (const draft of drafts) {
    const cat = itemsMap.get(draft.id)?.category
    if (!cat) continue
    rawModelWeighted[cat] += draft.text.length
    rawCoveredChars += draft.text.length
  }
  if (rawCoveredChars > 0) {
    rawModelWeighted.human = Math.round((rawModelWeighted.human / rawCoveredChars) * 10000) / 100
    rawModelWeighted.suspected_ai = Math.round((rawModelWeighted.suspected_ai / rawCoveredChars) * 10000) / 100
    rawModelWeighted.ai = Math.round((rawModelWeighted.ai / rawCoveredChars) * 10000) / 100
  }

  if (debugCtx) {
    const scoreStd = blendedScoreTrace.length > 1 ? computeStd(blendedScoreTrace) : 0
    const scoreMean = blendedScoreTrace.length > 0
      ? Math.round(blendedScoreTrace.reduce((a, b) => a + b, 0) / blendedScoreTrace.length)
      : 0

    const anomalyByDirection =
      rawCoveredChars > 0 &&
      ((rawModelWeighted.human >= 80 && distribution.human <= 10) ||
        (rawModelWeighted.ai >= 40 && distribution.ai <= 10))

    if (AIGC_DETECT_FUSION_DEBUG || anomalyByDirection) {
      const level: 'info' | 'warn' = anomalyByDirection ? 'warn' : 'info'
      appLogger[level]('llm', 'AIGC 检测融合诊断', {
        runId: debugCtx.runId,
        modelType: debugCtx.modelType,
        modelName: debugCtx.modelName,
        drafts: drafts.length,
        modelItems: itemsMap.size,
        modelCoverage: Math.round(modelCoverage * 10000) / 10000,
        degenerateOutput,
        humanBias,
        heuristicOnly,
        scoreSemantics,
        modelWeight: Math.round(modelWeight * 10000) / 10000,
        heuristicWeight: Math.round(heuristicWeight * 10000) / 10000,
        scoreThresholds,
        rawModelDistribution: rawModelWeighted,
        finalDistribution: distribution,
        blendedScoreMean: scoreMean,
        blendedScoreStd: Math.round(scoreStd * 100) / 100,
        modelScoreMean: modelScoreTrace.length
          ? Math.round(modelScoreTrace.reduce((a, b) => a + b, 0) / modelScoreTrace.length)
          : 0,
        heuristicScoreMean: heuristicScoreTrace.length
          ? Math.round(heuristicScoreTrace.reduce((a, b) => a + b, 0) / heuristicScoreTrace.length)
          : 0
      })
    }
  }

  const summary = typeof parsed.summary === 'string' && parsed.summary.trim()
    ? parsed.summary.trim()
    : `检测完成：人工 ${distribution.human}%，疑似AI ${distribution.suspected_ai}%，AI特征 ${distribution.ai}%。`

  return {
    segments,
    distribution,
    summary
  }
}

function buildRewriteSelectionView(
  runId: string,
  baselineDocScore: number | undefined,
  selection: Awaited<ReturnType<typeof evaluateRewriteCandidates>>
): AigcRewriteSelectionView {
  return {
    runId,
    selectedKey: selection.selected.key,
    selectedDocScore: selection.selected.docScore,
    baselineDocScore: typeof baselineDocScore === 'number'
      ? Math.round(baselineDocScore * 10) / 10
      : undefined,
    evaluations: selection.evaluations.map(item => ({
      key: item.key,
      docScore: item.docScore,
      changeRatio: item.changeRatio,
      numberAnchorRetention: item.numberAnchorRetention,
      objectiveScore: item.objectiveScore,
      issues: item.issues,
      valid: item.valid
    }))
  }
}

function extractRewriteContent(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  const fenced = trimmed.match(/```(?:text|markdown)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  return trimmed
}

/**
 * 词汇级后处理：替换 AI 高频词为低频同义词，从 token 级别改变分布。
 * 
 * 这是对抗外部检测器（朱雀等）的关键步骤：
 * - LLM 改写只改句式结构，token 分布不变 → 外部 classifier 仍能识别
 * - 词汇替换直接改变 token 序列 → 偏离 AI 概率峰值
 */
function applyVocabDiversification(text: string): string {
  const userEntries = aigcWordtableDAO.listEnabled()
  const allEntries = [...BUILTIN_ANTI_AI_VOCAB, ...userEntries]
  if (allEntries.length === 0) return text
  return applyWordTable(text, allEntries)
}

/**
 * 确定性伪随机数生成器，保证相同输入产生相同输出。
 * 基于线性同余，每次调用推进状态。
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1103515245 + 12345) >>> 0
    return state
  }
}

/**
 * 句子级打乱：在段落内部对句子做合并、拆分、重排等操作，
 * 改变句长分布和相邻句长变化率。
 */
function disruptSentences(paragraph: string, rand: () => number): string {
  const sentenceBreak = /(?<=[。！？；…])/g
  const sentences = paragraph.split(sentenceBreak).filter(s => s.trim())
  if (sentences.length < 2) return paragraph

  const result: string[] = []
  let i = 0
  while (i < sentences.length) {
    const s = sentences[i].trim()
    const r = rand()

    // 两个短句（各<=12字）合并为一个复合句，用逗号连接
    if (s.length <= 12 && i + 1 < sentences.length && sentences[i + 1].trim().length <= 12) {
      if (r % 3 === 0) {
        const next = sentences[i + 1].trim()
        const merged = s.replace(/[。]$/, '，') + next
        result.push(merged)
        i += 2
        continue
      }
    }

    // 长句（>35字）在逗号处拆分为两个独立句子
    if (s.length > 35 && r % 3 === 0) {
      const commaIdx = s.indexOf('，', Math.floor(s.length * 0.3))
      if (commaIdx > 6 && commaIdx < s.length - 6) {
        result.push(s.slice(0, commaIdx) + '。')
        result.push(s.slice(commaIdx + 1))
        i++
        continue
      }
    }

    // 删除纯过渡句（以"他/她+转身/抬头/走到/转过身"开头，且<=15字）
    if (s.length <= 15 && /^[她他它](?:转身|抬头|走到|转过身|站起|蹲下|弯腰)/.test(s)) {
      if (r % 2 === 0) {
        i++
        continue
      }
    }

    result.push(s)
    i++
  }

  return result.join('')
}

/**
 * 对称结构打散：检测"A做X，B做Y，C做Z"的三段并列结构，
 * 随机删掉其中一个分句或用"都"概括。
 */
function breakSymmetry(text: string, rand: () => number): string {
  // 匹配三个以上逗号分隔的并列短句（每句含主语+动词）
  return text.replace(
    /([^，。！？]{3,15}，)([^，。！？]{3,15}，)([^，。！？]{3,15}[。！？；])/g,
    (match, a: string, b: string, c: string) => {
      // 只处理三段结构看起来像并列的情况
      if (rand() % 3 !== 0) return match
      const r = rand() % 3
      if (r === 0) return a + c  // 删掉中间
      if (r === 1) return a + b.replace(/，$/, '。')  // 删掉最后，提前断句
      return match
    }
  )
}

/**
 * 微动作密度削减：当一段中微动作描写超过2处时，删除多余的。
 */
function reduceMicroActions(text: string, rand: () => number): string {
  const microRe = /[她他](?:的)?(?:眼睫|指尖|耳根|视线|目光|嘴角|眼底|面色|神色|脸色)(?:一垂|僵在|泛红|滑开|掠过|上扬|微勾|一变|深了|闪过|凝重)[^，。！？]*[，。！？]/g
  let count = 0
  return text.replace(microRe, (match) => {
    count++
    if (count > 2 && rand() % 2 === 0) return ''
    return match
  })
}

/**
 * 【致命级】消除电影镜头链——朱雀实验 F6 证实：注入镜头链使人工特征↓81%。
 * 
 * 将"目光落在…上""视线扫过…""嘴角微微上扬"等逐帧分镜描写
 * 替换为更自然的复合表达或直接删除。
 */
function eliminateFilmShotChains(text: string): string {
  let result = text

  result = result.replace(/(?:目光|视线|眼神)(?:落在|扫过|越过|移到|停在|掠过)([^，。！？]{1,15})上/g,
    (_m, target: string) => `看了眼${target}`)
  result = result.replace(/嘴角微微(?:上扬|勾起|一弯)/g, '咧了咧嘴')
  result = result.replace(/(?:缓缓|慢慢)(?:回过头|转过身|站起身|抬起头)/g, (m) => {
    const action = m.replace(/缓缓|慢慢/, '')
    return action
  })
  result = result.replace(/脚步(?:一顿|顿了顿|微微一顿)/g, '停了一下')
  result = result.replace(/四目相对[^，。]{0,6}[。，]/g, '互相看了一眼，')

  return result
}

/**
 * 【高危级】消除书面连接词——朱雀实验 F4 证实：注入连接词使人工特征↓39%。
 * 
 * 将"然而""因此""与此同时"等高频书面连接词替换为口语化表达或直接删除。
 */
function eliminateConnectors(text: string, rand: () => number): string {
  const connectorMap: Array<{ pattern: RegExp; replacements: string[] }> = [
    { pattern: /然而[，,]?/g, replacements: ['可', '但', '不过，', ''] },
    { pattern: /因此[，,]?/g, replacements: ['所以', '这才', ''] },
    { pattern: /此外[，,]?/g, replacements: ['另外', '还有', ''] },
    { pattern: /与此同时[，,]?/g, replacements: ['这会儿', '这当口', ''] },
    { pattern: /不仅如此[，,]?/g, replacements: ['', '不光这样'] },
    { pattern: /尽管如此[，,]?/g, replacements: ['话虽这么说，', '即便这样，', ''] },
    { pattern: /值得注意的是[，,]?/g, replacements: [''] },
    { pattern: /不难发现[，,]?/g, replacements: [''] },
    { pattern: /由此可见[，,]?/g, replacements: [''] },
    { pattern: /总而言之[，,]?/g, replacements: [''] },
  ]

  let result = text
  for (const { pattern, replacements } of connectorMap) {
    result = result.replace(pattern, () => {
      const pick = replacements[rand() % replacements.length]
      return pick
    })
  }
  return result
}

/**
 * 【中危级】消除模板情感句和总结收束句。
 * 
 * 朱雀实验 F1 证实：注入模板情感句使人工特征↓26%。
 * 朱雀实验 F5 证实：注入总结句使人工特征↓27%。
 */
function eliminateTemplateEmotions(text: string): string {
  let result = text
  result = result.replace(/(?:心中|内心|胸口)(?:涌起|泛起|升起|掠过)(?:一股|一阵|一丝)[^，。]{1,15}[，。]/g, '')
  result = result.replace(/(?:这一刻[，,]?(?:他|她)?(?:明白|懂得|知道|意识到了?))[^。]{0,20}。/g, '')
  result = result.replace(/(?:或许[，,]?这(?:便|就)是)[^。]{0,20}。/g, '')
  result = result.replace(/(?:对于[^，。]{2,8}而言)[^。]{0,15}。/g, '')
  return result
}

/**
 * 程序化后处理：注入人类写作中的"不规则性"以实质性改变统计特征。
 * 
 * 处理优先级（基于朱雀实验权重）：
 * 1. 【致命】消除电影镜头链（F6: ↓81%）
 * 2. 【高危】消除书面连接词（F4: ↓39%）
 * 3. 【中危】消除模板情感/总结句（F1: ↓26%, F5: ↓27%）
 * 4. 段落级合并/拆分
 * 5. 句子级节奏打乱
 * 6. 模板级对称/微动作削减
 */
function injectHumanNoise(text: string): string {
  const rand = lcg(text.length * 31 + text.charCodeAt(0))

  let output = text
  output = eliminateFilmShotChains(output)
  output = eliminateConnectors(output, rand)
  output = eliminateTemplateEmotions(output)

  const paragraphs = output.split('\n').filter(line => line.trim() !== '')
  const result: string[] = []

  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i].trim()
    if (!p) continue

    const isDialogue = p.startsWith('"') || p.startsWith('\u201c') || p.startsWith('\u2018')

    if (isDialogue) {
      result.push(p)
      continue
    }

    const r = rand()

    // 极短段落（≤8字）向前合并到上一段——结论/断言句（如"不动了。"）不应独占一段
    const pureLen = p.replace(/[^\u4e00-\u9fff\w]/g, '').length
    if (pureLen <= 8 && result.length > 0) {
      const prevP = result[result.length - 1]
      if (!prevP.startsWith('"') && !prevP.startsWith('\u201c') && !prevP.startsWith('\u2018')) {
        result[result.length - 1] = prevP + p
        continue
      }
    }

    if (p.length <= 15 && (r % 3 !== 0)) {
      const next = paragraphs[i + 1]?.trim()
      if (next && !next.startsWith('"') && !next.startsWith('\u201c')) {
        result.push(`${p}${next}`)
        i++
        continue
      }
    }

    if (p.length > 40 && (r % 3 === 0)) {
      const periodIdx = p.indexOf('\u3002', Math.floor(p.length * 0.3))
      if (periodIdx > 8 && periodIdx < p.length - 8) {
        result.push(p.slice(0, periodIdx + 1))
        result.push(p.slice(periodIdx + 1))
        continue
      }
    }

    if (p.length > 25 && p.length <= 50 && (r % 5 === 0)) {
      const commaIdx = p.indexOf('\uff0c', Math.floor(p.length * 0.35))
      if (commaIdx > 8 && commaIdx < p.length - 8) {
        result.push(p.slice(0, commaIdx + 1))
        result.push(p.slice(commaIdx + 1))
        continue
      }
    }

    if (p.length >= 20 && p.length <= 35 && (r % 4 === 0)) {
      const next = paragraphs[i + 1]?.trim()
      if (next && next.length >= 15 && next.length <= 40
        && !next.startsWith('"') && !next.startsWith('\u201c')) {
        result.push(`${p}${next}`)
        i++
        continue
      }
    }

    const disrupted = disruptSentences(p, rand)
    result.push(disrupted)
  }

  output = result.join('\n')

  output = breakSymmetry(output, rand)
  output = reduceMicroActions(output, rand)

  return output
}

export async function runAigcDetect(
  sender: WebContents,
  runId: string,
  text: string,
  modelOpts?: WorkModelOptions
): Promise<AigcDetectResult> {
  if (!text.trim()) throw new Error('待检测内容不能为空')
  const effectiveLength = text.replace(/\s/g, '').length
  if (effectiveLength < ZHUQUE_MIN_TEXT_LENGTH) {
    throw new Error(`为对齐朱雀检测口径，文本至少需要 ${ZHUQUE_MIN_TEXT_LENGTH} 个非空白字符（当前 ${effectiveLength}）`)
  }
  if (text.length > 50000) throw new Error('文本超出 50000 字符限制')

  const prev = activeRuns.get(runId)
  if (prev) {
    prev.complete(false, '已取消')
  }

  const session = aiSessionManager.create(sender, 'AI 实验室 · AIGC检测')
  activeRuns.set(runId, session)

  const reportProgress = (msg: string, append = true) => {
    sender.send('lab:aigc-detect:delta', { runId, delta: msg, content: msg })
    session.emitPhase(msg)
    if (append) {
      session.emitDelta(`${msg}\n`)
    } else {
      session.clearStream()
      session.emitDelta(msg)
    }
  }

  try {
    reportProgress('正在准备朱雀对齐检测模型…', false)

    const labModel: LabModelOverride | undefined = modelOpts?.modelType
      ? { modelType: modelOpts.modelType, modelName: modelOpts.modelName }
      : undefined
    const statisticalResult = await runPerplexityDetect(
      text,
      (msg) => {
        reportProgress(msg)
      },
      (progress) => {
        sender.send('perplexity:download-progress', progress)
        if (progress.phase === 'downloading' || progress.phase === 'checking') {
          reportProgress(progress.message)
        }
      },
      labModel
    )
    const supervisedResult = await runSupervisedAigcDetect(text, statisticalResult.segments, message => reportProgress(message))
    const result = fuseAigcDetection(statisticalResult, supervisedResult)

    const { human, suspected_ai, ai } = result.distribution
    reportProgress(
      `检测完成\n${result.summary}\n人工 ${human.toFixed(1)}% · 疑似 ${suspected_ai.toFixed(1)}% · AI ${ai.toFixed(1)}%`
    )

    // 模型已热，顺手缓存段落级 metrics 供后续改写复用，避免重复计算困惑度
    getSegmentMetrics(text, undefined, labModel)
      .then(metrics => cacheSegmentMetrics(text, metrics.segments, metrics.docScore))
      .catch(() => { /* 缓存失败不影响检测结果 */ })

    session.complete(true)
    sender.send('lab:aigc-detect:end', { runId, success: true, result })
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AIGC 检测失败'
    if (message !== '已取消') {
      session.complete(false, message)
      sender.send('lab:aigc-detect:end', { runId, success: false, error: message })
    }
    throw error
  } finally {
    activeRuns.delete(runId)
  }
}

function mergeFusedDetectionRisk(
  metrics: SegmentDetectDetail[],
  detectResult: AigcDetectResult
): SegmentDetectDetail[] {
  if (metrics.length !== detectResult.segments.length) return metrics
  return metrics.map((metric, index) => {
    const fused = detectResult.segments[index]
    const fallbackRisk = fused.category === 'ai' ? 82 : fused.category === 'suspected_ai' ? 52 : 20
    return {
      ...metric,
      aiScore: Math.max(metric.aiScore, fused.riskScore ?? fallbackRisk),
      reason: fused.reason || metric.reason
    }
  })
}

async function runLocalRewriteVerification(
  sender: WebContents,
  runId: string,
  text: string,
  labModel: LabModelOverride | undefined
): Promise<AigcDetectResult> {
  const report = (message: string) => sender.send('lab:aigc-rewrite:progress', { runId, message })
  const statisticalResult = await runPerplexityDetect(
    text,
    report,
    progress => {
      sender.send('perplexity:download-progress', progress)
      if (progress.phase === 'downloading' || progress.phase === 'checking') report(progress.message)
    },
    labModel
  )
  const supervisedResult = await runSupervisedAigcDetect(text, statisticalResult.segments, report)
  return fuseAigcDetection(statisticalResult, supervisedResult)
}

function preserveSentenceWhitespace(original: string, rewritten: string): string {
  const leading = original.match(/^\s*/)?.[0] ?? ''
  const trailing = original.match(/\s*$/)?.[0] ?? ''
  return `${leading}${rewritten.trim()}${trailing}`
}

function extractSentenceRewriteTexts(content: string): string[] {
  const json = extractJsonObject(content)
  if (!json) return []
  try {
    const parsed = JSON.parse(json) as { text?: unknown; candidates?: unknown[] }
    const values = Array.isArray(parsed.candidates)
      ? parsed.candidates.flatMap(item => {
          if (!item || typeof item !== 'object') return []
          const text = (item as { text?: unknown }).text
          return typeof text === 'string' && text.trim() ? [text.trim()] : []
        })
      : typeof parsed.text === 'string' && parsed.text.trim() ? [parsed.text.trim()] : []
    return Array.from(new Set(values)).slice(0, 2)
  } catch {
    return []
  }
}

export async function runAigcSentenceRewrite(
  sender: WebContents,
  runId: string,
  text: string,
  detectResult: AigcDetectResult,
  segmentIndex: number,
  modelOpts?: WorkModelOptions
): Promise<{ text: string; result: AigcDetectResult; segmentIndex: number; applied: boolean; reason?: string }> {
  const originalText = detectResult.segments.map(segment => segment.text).join('')
  if (originalText.trim() !== text.trim()) throw new Error('当前文本与检测结果不一致，请先重新检测')
  const target = detectResult.segments[segmentIndex]
  if (!target) throw new Error('目标句不存在，请重新检测后再试')
  if (target.category === 'human') throw new Error('人工特征句无需句级改写')

  const session = aiSessionManager.create(sender, 'AI 实验室 · 句级人工化改写')
  activeRewriteRuns.set(runId, session)
  const labModel: LabModelOverride | undefined = modelOpts?.modelType
    ? { modelType: modelOpts.modelType, modelName: modelOpts.modelName }
    : undefined
  const targetStart = detectResult.segments.slice(0, segmentIndex).reduce((sum, segment) => sum + segment.text.length, 0)
  const targetEnd = targetStart + target.text.length
  let lastReason = '没有生成可用候选'

  try {
    for (let attempt = 1; attempt <= MAX_SENTENCE_REWRITE_ATTEMPTS; attempt++) {
      sender.send('lab:aigc-rewrite:progress', {
        runId,
        message: `句级改写第 ${attempt}/${MAX_SENTENCE_REWRITE_ATTEMPTS} 轮：生成候选…`
      })
      const minLength = Math.ceil(target.text.length * 0.7)
      const maxLength = Math.floor(target.text.length * 1.35)
      const response = await modelService.chat({
        prompt: [
          `【原句】\n${target.text}`,
          `【当前检测依据】\n${target.reason || '句级统计与中文监督模型判为高风险'}`,
          '【改写要求】\n保持事实、人物、数字、因果和引号内对白不变。改变信息起点、句法骨架和叙述落点；避免整齐排比、对称对照、书面连接词、总结升华、比喻收束、设问与感叹。不要只做同义词替换。',
          `每个候选必须在${minLength}-${maxLength}个字符之间。`,
          '生成两个结构明显不同的候选。只返回 JSON：{"candidates":[{"text":"候选一"},{"text":"候选二"}]}。不得输出原句、解释或 Markdown。',
          lastReason === '没有生成可用候选' ? '' : `【上一轮未通过】\n${lastReason}`
        ].filter(Boolean).join('\n\n'),
        systemPrompt: '你是专业中文小说编辑。严格只返回合法 JSON；每个 text 只能包含一个改写后的目标句，不得夹带原句、分析或其他版本。',
        step: 'lab_aigc_rewrite',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0.8,
        maxTokens: Math.max(300, target.text.length * 3),
        modelType: modelOpts?.modelType as import('../../model/types').ModelType | undefined,
        modelName: modelOpts?.modelName,
        thinkingEnabled: modelOpts?.thinkingEnabled
      }, { sessionHandle: session, keepSession: true, stream: false })
      if (response.cancelled) throw new Error('已取消')
      if (!response.success || !response.content?.trim()) {
        lastReason = response.error || '模型未返回改写内容'
        continue
      }

      const extractedCandidates = extractSentenceRewriteTexts(response.content)
      if (extractedCandidates.length === 0) {
        lastReason = '模型未按多候选 JSON 契约返回'
        continue
      }
      const candidateFailures: string[] = []
      for (let candidateIndex = 0; candidateIndex < extractedCandidates.length; candidateIndex++) {
        const candidate = preserveSentenceWhitespace(
          target.text,
          normalizeModelBodyOutput(extractedCandidates[candidateIndex], 'lab_deai')
        )
        const changeRatio = computeChangeRatio(target.text, candidate)
        const lengthRatio = candidate.length / Math.max(1, target.text.length)
        if (changeRatio < 0.15) {
          candidateFailures.push(`候选${candidateIndex + 1}改写幅度不足（${Math.round(changeRatio * 100)}%）`)
          continue
        }
        if (lengthRatio < 0.7 || lengthRatio > 1.35) {
          candidateFailures.push(`候选${candidateIndex + 1}长度比例不合规（${lengthRatio.toFixed(2)}）`)
          continue
        }
        if (computeNumberAnchorRetention(target.text, candidate) < 1) {
          candidateFailures.push(`候选${candidateIndex + 1}数字事实未完整保留`)
          continue
        }
        if (computeDialogueRetention(target.text, candidate) < 1) {
          candidateFailures.push(`候选${candidateIndex + 1}引号内对白未逐字保留`)
          continue
        }

        const rewrittenText = `${text.slice(0, targetStart)}${candidate}${text.slice(targetEnd)}`
        sender.send('lab:aigc-rewrite:progress', {
          runId,
          message: `句级改写第 ${attempt}/${MAX_SENTENCE_REWRITE_ATTEMPTS} 轮：复检候选 ${candidateIndex + 1}/${extractedCandidates.length}…`
        })
        const verification = await runLocalRewriteVerification(sender, runId, rewrittenText, labModel)
        const gate = evaluateAigcRewriteVerification(verification)
        if (gate.passed) {
          const verifiedDetection = markAiAssistedRewrite(verification, 'sentence')
          session.complete(true)
          sender.send('lab:aigc-rewrite:progress', {
            runId,
            message: '句级改写通过生成质量与本地风险门禁；结果已标记为AI辅助改写'
          })
          return { text: rewrittenText, result: verifiedDetection, segmentIndex, applied: true }
        }
        const { human, suspected_ai, ai } = verification.distribution
        candidateFailures.push(
          `候选${candidateIndex + 1}本地复检为人工特征${human}%、疑似AI${suspected_ai}%、AI${ai}%（${gate.reasons.join('；')}）`
        )
      }
      lastReason = candidateFailures.join('；') || '没有候选通过本地融合检测'
    }
    const reason = `句级改写未通过生成质量与本地风险门禁：${lastReason}`
    sender.send('lab:aigc-rewrite:progress', { runId, message: reason, level: 'warn' })
    session.complete(false, reason)
    return { text, result: detectResult, segmentIndex, applied: false, reason }
  } catch (error) {
    session.complete(false, error instanceof Error ? error.message : '句级改写失败')
    throw error
  } finally {
    activeRewriteRuns.delete(runId)
  }
}

/** 基于冻结检测证据生成场景块补丁，以生成质量与本地风险双门禁作为自动应用条件。 */
export async function runAigcRewrite(
  sender: WebContents,
  runId: string,
  text: string,
  detectResult?: AigcDetectResult | null,
  modelOpts?: WorkModelOptions,
  seedOpts?: { mode: 'fast' | 'strong' }
): Promise<AigcSentenceRewriteResult> {
  const input = text.trim()
  if (!input) throw new Error('待改写文本不能为空')
  if (input.length > 50000) throw new Error('文本超出 50000 字符限制')
  if (!detectResult) throw new Error('一键改写需要当前文本的完整检测结果，请先重新检测')
  const detectedText = detectResult.segments.map(segment => segment.text).join('').trim()
  if (detectedText !== input) throw new Error('当前文本与检测结果不一致，请先重新检测')

  const prev = activeRewriteRuns.get(runId)
  if (prev) {
    prev.complete(false, '已取消')
  }

  const session = aiSessionManager.create(sender, 'AI 实验室 · 一键去AI味', [
    '准备检测证据',
    '生成改写候选',
    '本地融合复检'
  ])
  activeRewriteRuns.set(runId, session)
  session.setStepRunning(0)

  // 预检测阶段尚未发起 LLM 请求；此处先展示用户选择或全局默认，实际调用时会由 modelService
  // 以最终解析到的模型覆盖，避免浮窗在等待检测证据时长期只显示“准备中”。
  const globalModel = appPreferenceDAO.getGlobalLlmDefault()
  const initialModelType = modelOpts?.modelType ?? globalModel.provider
  const initialModelName = modelOpts?.modelName ?? globalModel.modelName ?? undefined
  if (initialModelType) session.setModelInfo(initialModelType, initialModelName)
  const reportProgress = (message: string, level?: 'info' | 'warn') => {
    session.emitPhase(message)
    sender.send('lab:aigc-rewrite:progress', { runId, message, level })
  }
  reportProgress('正在准备改写任务与检测证据…')

  try {
    const isStrongMode = seedOpts?.mode === 'strong'
    const referenceExamples = isStrongMode ? humanRewriteReferenceDAO.listEnabled() : []
    if (isStrongMode && referenceExamples.length === 0) {
      throw new Error('案例增强模式需要至少一条已启用的人工化改写案例')
    }
    const initialGate = evaluateAigcRewriteVerification(detectResult)
    if (initialGate.passed) {
      const result: AigcSentenceRewriteResult = {
        originalText: input,
        finalText: input,
        patches: [],
        goal: {
          status: 'achieved',
          humanPercent: detectResult.distribution.human,
          suspectedAiPercent: detectResult.distribution.suspected_ai,
          aiPercent: detectResult.distribution.ai,
          iterations: 0,
          remainingSentenceIds: [],
          targetCoveragePercent: 0,
          passedCoveragePercent: 100,
          fullDocumentRewrite: false,
          localVerification: {
            attempts: 0,
            distribution: detectResult.distribution,
            passed: true,
            reasons: []
          }
        },
        verifiedDetection: detectResult
      }
      session.setStepDone(0)
      reportProgress('当前文本已经通过本地风险门禁，无需AI改写')
      session.complete(true)
      return result
    }
    const rewriteLabModel: LabModelOverride | undefined = modelOpts?.modelType
      ? { modelType: modelOpts.modelType, modelName: modelOpts.modelName }
      : undefined
    let baselineDocScore: number | undefined

    // Step 1: 复用已有的困惑度检测结果，避免重复计算
    let segMetrics: SegmentDetectDetail[] | undefined
    let detectionAvailable = false

    const cached = getCachedSegmentMetrics(input)
    if (cached) {
      segMetrics = cached.segments
      baselineDocScore = cached.docScore
      detectionAvailable = true
      const aiCount = segMetrics.filter(s => isZhuqueRewriteTarget(s.aiScore)).length
      appLogger.info('aigc-rewrite', `复用检测缓存: ${segMetrics.length}段, AI段落=${aiCount}, docScore=${cached.docScore.toFixed(1)}`)
      reportProgress(`复用检测结果：${aiCount}/${segMetrics.length} 段有AI特征`)
    } else {
      reportProgress('正在分析文本AI特征分布…')
      try {
        const metrics = await getSegmentMetrics(input, (msg) => {
          reportProgress(msg)
        }, rewriteLabModel)
        segMetrics = metrics.segments
        baselineDocScore = metrics.docScore
        detectionAvailable = true
        cacheSegmentMetrics(input, segMetrics, metrics.docScore)
        const aiCount = segMetrics.filter(s => isZhuqueRewriteTarget(s.aiScore)).length
        appLogger.info('aigc-rewrite', `困惑度预检测: ${segMetrics.length}段, AI段落=${aiCount}, docScore=${metrics.docScore.toFixed(1)}`)
        reportProgress(`检测完成：${aiCount}/${segMetrics.length} 段有AI特征`)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        appLogger.warn('aigc-rewrite', `闭环检测失败: ${reason}`)
        throw new Error(`自动去AI味需要可用的检测引擎：${reason}`)
      }
    }

    // Step 2: 根据检测结果选择改写策略
    if (!detectionAvailable || !segMetrics || segMetrics.length === 0 || baselineDocScore === undefined) {
      throw new Error('自动去AI味没有取得有效的段落检测证据')
    }
    segMetrics = mergeFusedDetectionRisk(segMetrics, detectResult)
    const loop = await runBoundedRewriteAttempts(MAX_LOCAL_REWRITE_ATTEMPTS, async attempt => {
      session.setStepDone(0)
      session.setStepRunning(1)
      reportProgress(`第 ${attempt}/${MAX_LOCAL_REWRITE_ATTEMPTS} 轮：生成改写候选…`)
      const candidate = await runBlockRewrite({
        sender,
        runId,
        session,
        input,
        segments: segMetrics,
        initialDistribution: detectResult.distribution,
        fullDocumentRewrite: requiresFullDocumentSceneRewrite(detectResult.distribution),
        strongMode: isStrongMode,
        references: referenceExamples,
        modelOpts,
        onProgress: reportProgress
      })

      if (candidate.goal.status !== 'awaiting_recheck') {
        const value: AigcSentenceRewriteResult = {
          ...candidate,
          goal: {
            ...candidate.goal,
            status: 'not_achieved',
            localVerification: {
              attempts: attempt,
              distribution: detectResult.distribution,
              passed: false,
              reasons: ['没有足够候选通过生成质量与覆盖门禁']
            }
          }
        }
        return { accepted: false, value }
      }

      session.setStepDone(1)
      session.setStepRunning(2)
      reportProgress(`第 ${attempt}/${MAX_LOCAL_REWRITE_ATTEMPTS} 轮：正在对全文执行本地融合检测复检…`)
      const verification = await runLocalRewriteVerification(sender, runId, candidate.finalText, rewriteLabModel)
      const gate = evaluateAigcRewriteVerification(verification)
      if (gate.passed) {
        const verifiedDetection = markAiAssistedRewrite(verification, 'full_document')
        const result: AigcSentenceRewriteResult = {
          ...candidate,
          goal: {
            ...candidate.goal,
            status: 'achieved',
            humanPercent: verification.distribution.human,
            suspectedAiPercent: verification.distribution.suspected_ai,
            aiPercent: verification.distribution.ai,
            iterations: attempt,
            localVerification: {
              attempts: attempt,
              distribution: verification.distribution,
              passed: true,
              reasons: []
            }
          },
          verifiedDetection
        }
        session.setStepDone(2)
        reportProgress(`生成质量与本地风险门禁通过：人工特征 ${verification.distribution.human}% · 疑似AI ${verification.distribution.suspected_ai}% · AI ${verification.distribution.ai}%；已标记为AI辅助改写`)
        return { accepted: true, value: result }
      }

      const value: AigcSentenceRewriteResult = {
        ...candidate,
        goal: {
          ...candidate.goal,
          status: 'not_achieved',
          humanPercent: verification.distribution.human,
          suspectedAiPercent: verification.distribution.suspected_ai,
          aiPercent: verification.distribution.ai,
          iterations: attempt,
          localVerification: {
            attempts: attempt,
            distribution: verification.distribution,
            passed: false,
            reasons: gate.reasons
          }
        }
      }
      reportProgress(`第 ${attempt} 轮未通过本地风险门禁：${gate.reasons.join('；')}，继续生成候选`, 'warn')
      session.setStepDone(2)
      return { accepted: false, value }
    })

    if (loop.accepted) {
      session.complete(true)
      return loop.value
    }
    reportProgress(`已完成 ${loop.attempts} 轮，仍未同时通过生成质量与本地风险门禁；未应用任何改写`, 'warn')
    session.complete(false, '改写未通过双重门禁')
    return loop.value
  } catch (error) {
    const message = error instanceof Error ? error.message : '一键改写失败'
    session.complete(false, message)
    throw error
  } finally {
    activeRewriteRuns.delete(runId)
  }
}

// ─── 逐段精准改写 ───────────────────────────────────────────────────────────

const SEGMENT_REWRITE_SYSTEM = [
  '你是专业的文本编辑。只修复指定段落中已定位的问题，不做统一风格润色。',
  '',
  '规则：',
  '1. 只改写标记为【需改写】的段落。【上文】【下文】仅供理解语境，不要输出。',
  '2. 保持人物、事件、因果关系不变。',
  '3. 只处理命中的模板、即时解释闭合或段落功能过满；其他句子原样保留。',
  '4. 故事因果保持成立，但可以只保留动作或结果，把原因留给后文。',
  '5. 对话只有在目标被判断为 dialogue 且案例明确展示对话改写时才允许修改；其他情况保持原样。',
  '6. 返回 JSON：{"items":[{"id":目标编号,"text":"修复后的目标文本"}]}，不得输出其他内容。',
  '',
  '★ 检测器最敏感的AI指纹（必须消除）：',
  '- 【致命】禁止"电影镜头链"：不要逐帧写动作（"目光落在→嘴角上扬→缓缓开口"），用一句复合句概括或省略中间过程。',
  '- 【高危】删除书面连接词：然而/因此/此外/与此同时/不仅如此/尽管如此→直接删掉或换口语词。',
  '- 【中危】删除模板情感句："心中涌起…""眼中闪过一丝…"→删掉或改为具体动作。',
  '- 【中危】删除总结收束句："这一刻他明白了…""或许这便是…"→直接删除。',
  '- 不随机加入口语、方言、生僻词、病句、错字或机械长短句。',
].join('\n')

interface RewriteBatch {
  targetIndices: number[]
  contextStart: number
  contextEnd: number
}

type RewriteVariant = 'precise' | 'structural'

const MAX_REWRITE_ROUNDS = 3

function rewriteVariantLabel(variant: RewriteVariant): string {
  return variant === 'precise' ? '精确修复' : '结构重组'
}

function segmentRewriteHint(segment: SegmentDetectDetail): string {
  const reason = segment.reason || '局部生成轨迹偏强'
  const probability = `人工${segment.probabilities.human.toFixed(0)}%/疑似${segment.probabilities.suspected_ai.toFixed(0)}%/AI${segment.probabilities.ai.toFixed(0)}%`
  if (reason.includes('因果')) return `${probability}；${reason}。删减即时解释，允许原因延后出现`
  if (reason.includes('信息')) return `${probability}；${reason}。只保留人物当下真正注意到的一条信息路径`
  if (reason.includes('序列')) return `${probability}；${reason}。打断环境—反应—解释—推进的固定顺序`
  if (reason.includes('语气') || reason.includes('距离')) return `${probability}；${reason}。让叙述距离服从人物当下感知`
  if (reason.includes('模板') || reason.includes('镜头') || reason.includes('连接')) return `${probability}；${reason}。删除对应模板，不做同义词替换`
  return `${probability}；${reason}。只处理这项可观察证据`
}

const HUMAN_REWRITE_CLASSIFY_SYSTEM = [
  '你是人工化改写前置分类器。你只判断目标片段的叙事场景和可观察的 AI 痕迹，不改写文本。',
  `sceneTypes 只能从以下枚举选择 1-2 项：${HUMAN_REWRITE_SCENE_TYPES.join(', ')}`,
  `aiSymptoms 只能从以下枚举选择 1-3 项：${HUMAN_REWRITE_AI_SYMPTOMS.join(', ')}`,
  'reason 必须说明片段中的具体证据，不能写空泛结论。',
  '只返回 JSON：{"items":[{"id":0,"sceneTypes":["dialogue"],"aiSymptoms":["dialogue_template"],"reason":"具体证据"}]}'
].join('\n')

async function resolveHumanRewritePlans(
  targetIndices: number[],
  segMetrics: SegmentDetectDetail[],
  references: HumanRewriteReference[],
  cache: Map<string, HumanRewritePlan>,
  session: AiSessionHandle,
  modelOpts: WorkModelOptions | undefined
): Promise<Map<number, HumanRewritePlan>> {
  const plans = new Map<number, HumanRewritePlan>()
  const uncached = targetIndices.filter(index => {
    const cached = cache.get(segMetrics[index].text)
    if (cached) plans.set(index, cached)
    return !cached
  })

  if (uncached.length > 0) {
    const promptItems = uncached.map(index => ({
      id: index,
      detectorEvidence: segmentRewriteHint(segMetrics[index]),
      text: segMetrics[index].text.trim()
    }))
    const response = await modelService.chat(
      {
        prompt: JSON.stringify({ items: promptItems }, null, 2),
        systemPrompt: HUMAN_REWRITE_CLASSIFY_SYSTEM,
        step: 'lab_aigc_rewrite',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0.1,
        maxTokens: 1200,
        modelType: modelOpts?.modelType as import('../../model/types').ModelType | undefined,
        modelName: modelOpts?.modelName,
        thinkingEnabled: false
      },
      { sessionHandle: session, keepSession: true, stream: false }
    )
    if (response.cancelled) throw new Error('已取消')
    if (!response.success || !response.content?.trim()) {
      throw new Error(response.error || '人工化改写场景分类失败')
    }
    const json = extractJsonObject(response.content)
    if (!json) throw new Error('人工化改写场景分类未返回有效 JSON')
    const assessments = parseHumanRewriteAssessments(json, uncached)
    for (const index of uncached) {
      const assessment = assessments.get(index)!
      const matched = selectHumanRewriteReferences(assessment, references)
      if (matched.length === 0) {
        throw new Error(
          `案例库没有匹配目标片段的案例：场景 ${assessment.sceneTypes.join('/')}，AI 痕迹 ${assessment.aiSymptoms.join('/')}`
        )
      }
      const plan: HumanRewritePlan = { ...assessment, references: matched }
      cache.set(segMetrics[index].text, plan)
      plans.set(index, plan)
    }
  }

  return plans
}

async function runDetectedRewriteLoop(
  sender: WebContents,
  runId: string,
  session: AiSessionHandle,
  input: string,
  initialSegments: SegmentDetectDetail[],
  initialDocScore: number,
  isStrongMode: boolean,
  modelOpts: WorkModelOptions | undefined,
  labModel: LabModelOverride | undefined,
  referenceExamples: HumanRewriteReference[]
): Promise<string> {
  let currentText = input
  let currentSegments = initialSegments
  let currentDocScore = initialDocScore
  const referencePlanCache = new Map<string, HumanRewritePlan>()

  for (let round = 1; round <= MAX_REWRITE_ROUNDS; round++) {
    const targetCount = currentSegments.filter(segment => isZhuqueRewriteTarget(segment.aiScore)).length
    if (targetCount === 0 || currentDocScore <= ZHUQUE_REWRITE_TARGET_SCORE) {
      sender.send('lab:aigc-rewrite:progress', {
        runId,
        message: `闭环完成：剩余高风险段 ${targetCount}，复检评分 ${currentDocScore.toFixed(1)}`
      })
      break
    }

    sender.send('lab:aigc-rewrite:progress', {
      runId,
      message: `第 ${round}/${MAX_REWRITE_ROUNDS} 轮：为 ${targetCount} 个高风险段生成候选…`
    })
    const candidates: RewriteCandidateInput[] = []
    for (const variant of ['precise', 'structural'] as RewriteVariant[]) {
      const candidateText = await runSegmentBySegmentRewrite(
        sender,
        runId,
        session,
        currentSegments,
        isStrongMode,
        modelOpts,
        variant,
        referenceExamples,
        referencePlanCache
      )
      candidates.push({ key: `第${round}轮·${rewriteVariantLabel(variant)}`, text: candidateText })
    }

    const selection = await evaluateRewriteCandidates({
      runId,
      originalText: currentText,
      candidates,
      baselineDocScore: currentDocScore,
      labModel,
      evaluateWithMetrics: true,
      minimumChangeRatio: 0.01,
      allowDialogueChanges: isStrongMode && Array.from(referencePlanCache.values()).some(
        plan => plan.sceneTypes.includes('dialogue')
      ),
      onProgress: message => sender.send('lab:aigc-rewrite:progress', { runId, message })
    })
    const accepted = selection.evaluations.find(candidate =>
      candidate.valid && isMeaningfulRewriteImprovement(currentDocScore, candidate.docScore)
    )

    if (!accepted) {
      sender.send('lab:aigc-rewrite:progress', {
        runId,
        message: `第 ${round} 轮没有候选使评分至少下降1.5分，保留上一版`,
        level: 'warn'
      })
      break
    }

    const acceptedSelection = { ...selection, selected: accepted }
    sender.send('lab:aigc-rewrite:selection', buildRewriteSelectionView(runId, currentDocScore, acceptedSelection))
    sender.send('lab:aigc-rewrite:progress', {
      runId,
      message: `第 ${round} 轮采用「${accepted.key}」：${currentDocScore.toFixed(1)} → ${accepted.docScore.toFixed(1)}`
    })
    currentText = accepted.text
    currentDocScore = accepted.docScore

    if (round < MAX_REWRITE_ROUNDS && currentDocScore > ZHUQUE_REWRITE_TARGET_SCORE) {
      const nextMetrics = await getSegmentMetrics(currentText, undefined, labModel)
      currentSegments = nextMetrics.segments
      currentDocScore = nextMetrics.docScore
    }
  }

  return currentText
}

/**
 * 逐段精准改写：只对 AI 特征分数高的段落发起改写，保留"人工"段落原文
 */
async function runSegmentBySegmentRewrite(
  sender: WebContents,
  runId: string,
  session: AiSessionHandle,
  segMetrics: SegmentDetectDetail[],
  isStrongMode: boolean,
  modelOpts: WorkModelOptions | undefined,
  variant: RewriteVariant,
  referenceExamples: HumanRewriteReference[],
  referencePlanCache: Map<string, HumanRewritePlan>
): Promise<string> {
  const segmentsToRewrite = segMetrics.filter(s => isZhuqueRewriteTarget(s.aiScore))
  const totalSegs = segMetrics.length
  const rewriteCount = segmentsToRewrite.length

  if (rewriteCount === 0) {
    sender.send('lab:aigc-rewrite:progress', {
      runId, message: '所有段落AI特征评分较低，无需改写'
    })
    return normalizeModelBodyOutput(segMetrics.map(s => s.text).join(''), 'lab_deai')
  }

  appLogger.info('aigc-rewrite', `逐段改写: 方案=${variant}, 总段落=${totalSegs}, 需改写=${rewriteCount}`)
  sender.send('lab:aigc-rewrite:progress', {
    runId, message: `${rewriteVariantLabel(variant)}：${rewriteCount}/${totalSegs} 段需要改写`
  })

  const resultSegments = segMetrics.map(s => s.text)
  const batches = buildRewriteBatches(segMetrics)

  let completedBatches = 0
  for (const batch of batches) {
    completedBatches++
    sender.send('lab:aigc-rewrite:progress', {
      runId, message: `正在改写第 ${completedBatches}/${batches.length} 批（${batch.targetIndices.length} 段）…`
    })

    const rewritten = await rewriteBatch(
      segMetrics,
      batch,
      isStrongMode,
      session,
      modelOpts,
      variant,
      referenceExamples,
      referencePlanCache,
      message => sender.send('lab:aigc-rewrite:progress', { runId, message })
    )

    for (let i = 0; i < batch.targetIndices.length; i++) {
      const idx = batch.targetIndices[i]
      if (rewritten[i] && rewritten[i].trim()) {
        resultSegments[idx] = rewritten[i]
      }
    }
  }

  const finalText = normalizeModelBodyOutput(resultSegments.join(''), 'lab_deai')

  sender.send('lab:aigc-rewrite:progress', {
    runId, message: `改写完成：${rewriteCount} 段已精准改写，${totalSegs - rewriteCount} 段保留原文`
  })

  return finalText
}

function buildRewriteBatches(segMetrics: SegmentDetectDetail[]): RewriteBatch[] {
  const batches: RewriteBatch[] = []

  let i = 0
  while (i < segMetrics.length) {
    if (!isZhuqueRewriteTarget(segMetrics[i].aiScore)) { i++; continue }

    const targets: number[] = []
    while (i < segMetrics.length && isZhuqueRewriteTarget(segMetrics[i].aiScore) && targets.length < 5) {
      targets.push(i)
      i++
    }

    const contextStart = Math.max(0, targets[0] - 2)
    const contextEnd = Math.min(segMetrics.length - 1, targets[targets.length - 1] + 2)
    batches.push({ targetIndices: targets, contextStart, contextEnd })
  }

  return batches
}

async function rewriteBatch(
  segMetrics: SegmentDetectDetail[],
  batch: RewriteBatch,
  isStrongMode: boolean,
  session: AiSessionHandle,
  modelOpts: WorkModelOptions | undefined,
  variant: RewriteVariant,
  referenceExamples: HumanRewriteReference[],
  referencePlanCache: Map<string, HumanRewritePlan>,
  onReferencePlan: (message: string) => void
): Promise<string[]> {
  const { targetIndices, contextStart, contextEnd } = batch

  const referencePlans = isStrongMode
    ? await resolveHumanRewritePlans(
        targetIndices,
        segMetrics,
        referenceExamples,
        referencePlanCache,
        session,
        modelOpts
      )
    : new Map<number, HumanRewritePlan>()

  if (referencePlans.size > 0) {
    const summary = targetIndices.map(index => {
      const plan = referencePlans.get(index)!
      return `目标${index + 1}=${plan.sceneTypes.join('/')}，案例：${plan.references.map(item => item.title).join('、')}`
    }).join('；')
    onReferencePlan(`案例匹配完成：${summary}`)
  }

  const lines: string[] = []
  for (let idx = contextStart; idx <= contextEnd; idx++) {
    const seg = segMetrics[idx]
    const isTarget = targetIndices.includes(idx)
    const segText = seg.text.replace(/\n+$/, '').trim()

    if (isTarget) {
      const plan = referencePlans.get(idx)
      if (plan) {
        lines.push([
          `【目标 ${idx} 的人工化改写依据】`,
          `场景：${plan.sceneTypes.join(', ')}`,
          `AI 痕迹：${plan.aiSymptoms.join(', ')}`,
          `判断证据：${plan.reason}`,
          formatHumanRewriteReferences(plan.references),
          `【需改写｜id=${idx}｜${segmentRewriteHint(seg)}】\n${segText}`
        ].join('\n'))
      } else {
        lines.push(`【需改写｜id=${idx}｜${segmentRewriteHint(seg)}】\n${segText}`)
      }
    } else if (idx < targetIndices[0]) {
      lines.push(`【上文】: ${segText}`)
    } else {
      lines.push(`【下文】: ${segText}`)
    }
  }

  let systemPrompt = SEGMENT_REWRITE_SYSTEM
  if (isStrongMode) {
    systemPrompt += '\n9. 案例只用于学习人类作者如何取舍信息，不得复制案例原句；必须应用案例中的改写原则。'
  }
  systemPrompt += variant === 'precise'
    ? '\n10. 本候选采用精确修复：尽量少改，只删除或改写证据直接命中的句子。'
    : '\n10. 本候选采用结构重组：允许重排命中段内部的信息顺序，但不得扩大到上下文段。'
  let content = ''
  const response = await modelService.chat(
    {
      prompt: lines.join('\n'),
      systemPrompt,
      step: 'lab_aigc_rewrite',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.65,
      modelType: modelOpts?.modelType as import('../../model/types').ModelType | undefined,
      modelName: modelOpts?.modelName,
      thinkingEnabled: modelOpts?.thinkingEnabled
    },
    {
      sessionHandle: session,
      keepSession: true,
      stream: true,
      onDelta: (delta) => { content += delta },
      onThinkingDelta: () => {}
    }
  )

  if (response.cancelled) throw new Error('已取消')
  if (!response.success) throw new Error(response.error || '改写失败')

  const raw = response.content?.trim() || content.trim()
  if (!raw) throw new Error('改写模型没有返回内容')
  const json = extractJsonObject(raw)
  if (!json) throw new Error('改写模型未返回有效 JSON')
  const parsed = JSON.parse(json) as { items?: unknown[] }
  if (!Array.isArray(parsed.items)) throw new Error('改写结果没有返回 items 数组')

  const rewrittenById = new Map<number, string>()
  const targetSet = new Set(targetIndices)
  for (const rawItem of parsed.items) {
    if (!rawItem || typeof rawItem !== 'object') continue
    const item = rawItem as Record<string, unknown>
    const id = Number(item.id)
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (!Number.isInteger(id) || !targetSet.has(id) || !text || rewrittenById.has(id)) continue
    rewrittenById.set(id, text)
  }
  if (rewrittenById.size !== targetIndices.length) {
    throw new Error(`改写结果不完整：需要 ${targetIndices.length} 项，实际 ${rewrittenById.size} 项`)
  }

  return targetIndices.map(index => {
    const original = segMetrics[index].text
    const leading = original.match(/^\s*/)?.[0] ?? ''
    const trailing = original.match(/\s*$/)?.[0] ?? ''
    const rewritten = rewrittenById.get(index)!
    const plan = referencePlans.get(index)
    if (plan) {
      const copied = findCopiedReferencePhrase(rewritten, plan.references)
      if (copied) {
        throw new Error(`改写结果复制了案例“${copied.referenceTitle}”中的连续原句，已拒绝采用`)
      }
    }
    return `${leading}${rewritten}${trailing}`
  })
}

export function cancelAigcDetect(runId: string): boolean {
  const session = activeRuns.get(runId) || activeRewriteRuns.get(runId)
  if (!session) return false
  aiSessionManager.cancel(session.id)
  activeRuns.delete(runId)
  activeRewriteRuns.delete(runId)
  return true
}
