import type { WebContents } from 'electron'
import { modelService } from '../../model'
import { aiSessionManager, type AiSessionHandle } from '../../ai/ai-session-manager'
import type {
  AigcDetectResult,
  AigcSegment,
  AigcDistribution,
  AigcRewriteSelectionView
} from '../../../shared/aigc-detect-types'
import { BODY_PARAGRAPH_SPACING_RULE, normalizeModelBodyOutput } from '../../../shared/normalize-body-text'
import { appLogger } from '../../logger/app-logger'
import { volumeChapterDAO, aigcWordtableDAO } from '../../db'
import { getWorkReferenceText } from '../anti-ai-rules'
import { runPerplexityDetect, getSegmentMetrics, type SegmentDetectDetail, type LabModelOverride } from '../../perplexity'
import { applyWordTable } from './aigc-wordtable-engine'
import { BUILTIN_ANTI_AI_VOCAB } from './builtin-anti-ai-vocab'
import { evaluateRewriteCandidates, type RewriteCandidateInput } from './aigc-rewrite-quality'

const activeRuns = new Map<string, AiSessionHandle>()
const activeRewriteRuns = new Map<string, AiSessionHandle>()

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


const AIGC_REWRITE_INTENSIVE_SYSTEM_PROMPT = [
  '你是专业的去AI痕迹重写编辑。你的改写必须产生肉眼可见的实质性变化。',
  '',
  '核心目标：改写后的文本必须与原文有30%以上的文字差异。只替换个别词是不合格的。',
  '',
  '硬约束：',
  '1. 保持人物、事件、时间线、世界观不变。',
  '2. 每个叙述句都必须重组句式——换语序、拆合句子、变换主语。',
  '3. 禁止照抄：连续10字以上与原文相同是绝对禁止的（专有名词和对话原文除外）。',
  '4. 对话内容保持原样，但对话之间的叙述描写必须重写。',
  '5. 仅输出改写正文，不要解释。',
  '',
  '★★★ 最高优先级——外部检测器（朱雀）最敏感的AI指纹（违反即判定失败）：',
  '',
  'A. 【致命】禁止"电影镜头链"式描写——这是检测器权重最高的特征：',
  '   禁止连续的逐帧动作分镜：如"他转身→目光落在…上→嘴角微微上扬→缓缓开口"。',
  '   禁止"目光落在/扫过/越过…上"的句式。',
  '   禁止"嘴角微微上扬/微勾/一弯"。',
  '   禁止"脚步顿了顿""缓缓回过头""视线从…移到…又收回"等镜头调度。',
  '   替代方案：用一句复合句概括动作，或直接写结果省略中间过程。',
  '',
  'B. 【高危】禁止书面连接词/过渡词——检测器第二敏感的特征：',
  '   禁用：然而、因此、此外、与此同时、值得注意的是、不难发现、由此可见、总而言之、不仅如此、尽管如此。',
  '   替代：直接删除，或改用口语词（"结果""谁知""得了""这下"）。',
  '',
  'C. 【中危】禁止模板情感句和总结收束句：',
  '   禁用："心中涌起一股…""眼中闪过一丝…""一股…涌上心头"。',
  '   禁用段尾/章尾总结："这一刻他明白了…""或许这便是…""对于…而言…"。',
  '   替代：删除这些句子，或改为具体动作/对话。',
  '',
  'D. 词汇选择偏口语化/低频化：多用具象、冷门、方言化的词，少用"标准书面语"。',
  '   如：用"瞅/撩/蹓"代替"看/掀/走"，用"搁/撂/怼"代替"放/扔/说"。',
].join('\n')

const AIGC_REWRITE_STRONG_COLLOQUIAL_CONSTRAINT =
  '\n10. 词汇选择必须偏口语化/方言化：用"瞅""搁""麻溜""寻思"替代"看""放""迅速""思考"，用"压根""愣是""回过味来"替代"完全""坚持""意识到"。'

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

function buildRewriteCandidates(baseText: string): RewriteCandidateInput[] {
  const normalized = normalizeModelBodyOutput(baseText, 'lab_deai').trim()
  if (!normalized) return []
  const vocabOnly = applyVocabDiversification(normalized)
  const rhythmAndVocab = applyVocabDiversification(injectHumanNoise(normalized))
  return [
    { key: '直出改写', text: normalized },
    { key: '词表增强', text: vocabOnly },
    { key: '节奏扰动+词表', text: rhythmAndVocab }
  ]
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

function buildAigcRewriteUserPrompt(
  text: string,
  _detectResult?: AigcDetectResult | null,
  _mode: 'normal' | 'intensive' = 'normal',
  segmentMetrics?: SegmentDetectDetail[]
): string {
  const connectorHits = (text.match(CONNECTOR_REGEX) || []).length
  const filmShotRe = /(?:目光|视线|眼神)(?:落在|扫过|越过|移到|停在|掠过).{0,15}上/g
  const filmShotCount = (text.match(filmShotRe) || []).length
  const cameraChainRe = /(?:他|她)(?:转身|回过头|抬起头|低下头|站起身|迈步|停下脚步)[^，。]{0,6}[。，]/g
  const cameraChainCount = (text.match(cameraChainRe) || []).length
  const emotionTemplateRe = /(?:心中|内心|胸口)(?:涌起|泛起|升起|掠过)(?:一股|一阵|一丝)/g
  const emotionCount = (text.match(emotionTemplateRe) || []).length
  const closureRe = /(?:这一刻[，,]?(?:他|她)?(?:明白|懂得|知道|意识到))|(?:或许[，,]?这(?:便|就)是)|(?:对于.{2,8}而言)/g
  const closureCount = (text.match(closureRe) || []).length

  const lines: string[] = [
    '请把下面正文做“去AI味”润色：',
    '- 不改剧情与角色关系',
    '- 保留原段落数量与顺序',
    '- 输出仅正文，不要解释',
    '',
    BODY_PARAGRAPH_SPACING_RULE,
  ]

  if (segmentMetrics && segmentMetrics.length > 0) {
    const validSegs = segmentMetrics.filter(s => s.ppl > 0)
    const aiSegments = segmentMetrics.filter(s => s.aiScore >= 55)
    const highAiSegments = segmentMetrics.filter(s => s.aiScore >= 70)
    const avgPpl = validSegs.length > 0 ? validSegs.reduce((a, s) => a + s.ppl, 0) / validSegs.length : 0
    const avgTop5 = validSegs.length > 0 ? validSegs.reduce((a, s) => a + s.top5Rate, 0) / validSegs.length : 0

    lines.push('')
    lines.push('【困惑度检测结果——精准定位AI特征段落】')
    lines.push(`- AI段落占比：${Math.round(aiSegments.length / Math.max(1, segmentMetrics.length) * 100)}%`)
    lines.push(`- 高度AI段落：${highAiSegments.length}段（需重点改写）`)
    lines.push(`- 平均困惑度：${avgPpl.toFixed(1)}（人类通常>80，当前${avgPpl < 60 ? '极低=太可预测' : avgPpl < 80 ? '偏低' : '正常'}）`)
    lines.push(`- 平均Top-5命中率：${(avgTop5 * 100).toFixed(0)}%（人类通常<50%，当前${avgTop5 > 0.6 ? '极高=词选太明显' : avgTop5 > 0.5 ? '偏高' : '正常'}）`)

    if (highAiSegments.length > 0 && highAiSegments.length <= 10) {
      lines.push('')
      lines.push('【以下段落AI特征最强，需彻底重写】')
      for (const seg of highAiSegments.slice(0, 8)) {
        const preview = seg.text.trim().slice(0, 40).replace(/\n/g, ' ')
        const issue = seg.ppl < 50 ? '困惑度极低/太可预测'
          : seg.top5Rate > 0.65 ? '词选太明显/Top5命中高'
          : 'AI评分高'
        lines.push(`- “${preview}…” → ${issue}，AI评分=${Math.round(seg.aiScore)}`)
      }
    }

    lines.push('')
    lines.push('【困惑度改写策略】')
    if (avgPpl < 60) {
      lines.push('- ★ 文本太“可预测”：使用更不常见的词汇搭配、倒装句、省略句')
    }
    if (avgTop5 > 0.55) {
      lines.push('- ★ 词语选择太“正确”：故意使用非典型搭配，如“掀/扎/摁/蹓/搁/撒”替代常见动词')
    }
  }

  const hasDangerousFingerprints = filmShotCount > 0 || cameraChainCount > 1 || connectorHits > 0 || emotionCount > 0 || closureCount > 0
  if (hasDangerousFingerprints) {
    lines.push('')
    lines.push('【★★★ 外部检测器（朱雀）最敏感的AI指纹——必须全部消除 ★★★】')
    if (filmShotCount > 0 || cameraChainCount > 1) {
      lines.push(`- 【致命·权重最高】电影镜头链：检测到${filmShotCount}处“目光落在/扫过…上”、${cameraChainCount}处逐帧动作分镜。必须全部消除：改为一句复合句或省略中间动作。`)
    }
    if (connectorHits > 0) {
      lines.push(`- 【高危】书面连接词：检测到${connectorHits}处（然而/因此/此外/与此同时等）。全部删除或改为口语词（“结果/谁知/这下/得了”）。`)
    }
    if (emotionCount > 0) {
      lines.push(`- 【中危】模板情感句：检测到${emotionCount}处“心中涌起/泛起/升起一股…”。删除或改为具体动作。`)
    }
    if (closureCount > 0) {
      lines.push(`- 【中危】总结收束句：检测到${closureCount}处“这一刻他明白了/或许这便是…”。直接删除。`)
    }
  }

  lines.push('')
  lines.push('【改写硬约束】')
  lines.push('- 每个叙述段必须做实质改写：调整句式/语序，不可只换个别词')
  lines.push('- 禁止连续15字以上与原文完全一致（专有名词除外）')
  lines.push('- 词汇偏口语化/低频化：用具象冷门词替代标准书面语')
  lines.push('- 对话段落保持原样，仅改动对话间的叙述/描写承接')
  lines.push('')
  lines.push('【待改写正文】')
  lines.push(text)
  return lines.join('\n')
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
  modelOpts?: { modelType?: string; modelName?: string }
): Promise<AigcDetectResult> {
  if (!text.trim()) throw new Error('待检测内容不能为空')
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
    reportProgress('正在准备困惑度检测…', false)

    const labModel: LabModelOverride | undefined = modelOpts?.modelType
      ? { modelType: modelOpts.modelType, modelName: modelOpts.modelName }
      : undefined
    const result = await runPerplexityDetect(
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

function fetchHumanSeed(workId?: number, chapterId?: number): string {
  if (chapterId) {
    const chapter = volumeChapterDAO.getChapter(chapterId)
    if (chapter?.content) return sampleDocumentText(chapter.content, 2000)
  }
  if (workId) {
    const ref = getWorkReferenceText(workId)
    if (ref && ref.length > 200) return ref
    const chapters = volumeChapterDAO.listChaptersByWork(workId)
    const humanChapter = chapters.find(c => c.status === 'published' || c.word_count > 500)
    if (humanChapter?.content) return sampleDocumentText(humanChapter.content, 2000)
  }
  return ''
}

function sampleDocumentText(text: string, maxLen: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen)
}

/**
 * 将人工种子文本与改写结果逐段交替拼接。
 * 
 * 实验 DS2 证实：50%人工+50%AI 逐段交替 → 朱雀判定 100% 人工。
 * 对比 K2（人工尾置 39%）和 K5（三明治 27%），交替策略远优于简单前置/尾置。
 */
function composeSeedAndRewrite(seed: string, rewritten: string): string {
  const targetSeedLen = Math.max(seed.length, Math.floor(rewritten.length * 0.5))
  const trimmedSeed = seed.slice(0, targetSeedLen)

  const seedParas = trimmedSeed.split(/\n+/).filter(p => p.trim())
  const rewriteParas = rewritten.split(/\n+/).filter(p => p.trim())

  if (seedParas.length === 0) return rewritten
  if (rewriteParas.length === 0) return trimmedSeed

  const result: string[] = []
  const maxLen = Math.max(seedParas.length, rewriteParas.length)

  for (let i = 0; i < maxLen; i++) {
    if (i < seedParas.length) result.push(seedParas[i])
    if (i < rewriteParas.length) result.push(rewriteParas[i])
  }

  return result.join('\n')
}

export async function runAigcRewrite(
  sender: WebContents,
  runId: string,
  text: string,
  detectResult?: AigcDetectResult | null,
  modelOpts?: { modelType?: string; modelName?: string },
  seedOpts?: { mode: 'fast' | 'strong'; seedText?: string; workId?: number; chapterId?: number }
): Promise<string> {
  const input = text.trim()
  if (!input) throw new Error('待改写文本不能为空')
  if (input.length > 50000) throw new Error('文本超出 50000 字符限制')

  const prev = activeRewriteRuns.get(runId)
  if (prev) {
    prev.complete(false, '已取消')
  }

  const session = aiSessionManager.create(sender, 'AI 实验室 · 一键去AI味')
  activeRewriteRuns.set(runId, session)

  try {
    const isStrongMode = seedOpts?.mode === 'strong'
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
      const aiCount = segMetrics.filter(s => s.aiScore >= 50).length
      appLogger.info('aigc-rewrite', `复用检测缓存: ${segMetrics.length}段, AI段落=${aiCount}, docScore=${cached.docScore.toFixed(1)}`)
      sender.send('lab:aigc-rewrite:progress', { runId, message: `复用检测结果：${aiCount}/${segMetrics.length} 段有AI特征` })
    } else {
      sender.send('lab:aigc-rewrite:progress', { runId, message: '正在分析文本AI特征分布…' })
      try {
        const metrics = await getSegmentMetrics(input, (msg) => {
          sender.send('lab:aigc-rewrite:progress', { runId, message: msg })
        }, rewriteLabModel)
        segMetrics = metrics.segments
        baselineDocScore = metrics.docScore
        detectionAvailable = true
        cacheSegmentMetrics(input, segMetrics, metrics.docScore)
        const aiCount = segMetrics.filter(s => s.aiScore >= 50).length
        appLogger.info('aigc-rewrite', `困惑度预检测: ${segMetrics.length}段, AI段落=${aiCount}, docScore=${metrics.docScore.toFixed(1)}`)
        sender.send('lab:aigc-rewrite:progress', { runId, message: `检测完成：${aiCount}/${segMetrics.length} 段有AI特征` })
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        appLogger.warn('aigc-rewrite', `困惑度预检测跳过: ${reason}`)
        sender.send('lab:aigc-rewrite:progress', {
          runId,
          message: `⚠️ 困惑度检测不可用（${reason.includes('模型') ? '检测模型未下载' : '检测失败'}），将使用基础模式改写`,
          level: 'warn'
        })
      }
    }

    // Step 2: 根据检测结果选择改写策略
    let result: string

    if (detectionAvailable && segMetrics && segMetrics.length > 0) {
      result = await runSegmentBySegmentRewrite(
        sender, runId, session, segMetrics, isStrongMode, modelOpts
      )
    } else {
      sender.send('lab:aigc-rewrite:progress', { runId, message: '使用整篇改写模式…' })
      result = await runWholeTextRewrite(sender, runId, session, input, detectResult, isStrongMode, modelOpts)
    }

    // Step 3: 约束校验 + 候选自动选择（优先选择复检分更低且锚点保留更好的版本）
    sender.send('lab:aigc-rewrite:progress', { runId, message: '正在执行改写约束校验…' })
    const candidates = buildRewriteCandidates(result)
    if (candidates.length > 0) {
      const selection = await evaluateRewriteCandidates({
        runId,
        originalText: input,
        candidates,
        baselineDocScore,
        labModel: rewriteLabModel,
        evaluateWithMetrics: detectionAvailable,
        onProgress: (message) => sender.send('lab:aigc-rewrite:progress', { runId, message })
      })
      const selected = selection.selected
      result = selected.text
      sender.send('lab:aigc-rewrite:selection', buildRewriteSelectionView(runId, baselineDocScore, selection))
      const baselineSuffix = typeof baselineDocScore === 'number'
        ? `（基线 ${baselineDocScore.toFixed(1)}）`
        : ''
      const warn = selected.issues.length > 0
      sender.send('lab:aigc-rewrite:progress', {
        runId,
        message: `校验完成：采用「${selected.key}」方案，复检评分 ${selected.docScore.toFixed(1)} ${baselineSuffix}`.trim(),
        level: warn ? 'warn' : 'info'
      })
      if (warn) {
        sender.send('lab:aigc-rewrite:progress', {
          runId,
          message: `提示：${selected.issues.join('；')}`,
          level: 'warn'
        })
      }
    }

    // Step 4: 强力模式前置种子文本
    if (seedOpts?.mode === 'strong') {
      const seedText = seedOpts.seedText?.trim()
        || fetchHumanSeed(seedOpts.workId, seedOpts.chapterId)
      if (seedText) {
        result = composeSeedAndRewrite(seedText, result)
      }
    }

    session.complete(true)
    return result
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
  '你是专业的文本润色编辑。你的任务是改写指定的段落，消除AI生成痕迹。',
  '',
  '规则：',
  '1. 只改写标记为【需改写】的段落。【上文】【下文】仅供理解语境，不要输出。',
  '2. 保持人物、事件、因果关系不变。',
  '3. 必须重组句式：换语序、拆合句子、变换主语。',
  '4. 禁止照抄：与原文连续相同不超过8字（专有名词除外）。',
  '5. 对话原文保持不变，只改叙述和描写。',
  '6. 只输出改写后的段落，按原段落顺序，每段之间空一行。不要编号，不要解释。',
  '',
  '★ 检测器最敏感的AI指纹（必须消除）：',
  '- 【致命】禁止"电影镜头链"：不要逐帧写动作（"目光落在→嘴角上扬→缓缓开口"），用一句复合句概括或省略中间过程。',
  '- 【高危】删除书面连接词：然而/因此/此外/与此同时/不仅如此/尽管如此→直接删掉或换口语词。',
  '- 【中危】删除模板情感句："心中涌起…""眼中闪过一丝…"→删掉或改为具体动作。',
  '- 【中危】删除总结收束句："这一刻他明白了…""或许这便是…"→直接删除。',
  '- 词汇选择偏口语/低频/方言化，少用"标准书面语"。',
].join('\n')

interface RewriteBatch {
  targetIndices: number[]
  contextStart: number
  contextEnd: number
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
  modelOpts?: { modelType?: string; modelName?: string }
): Promise<string> {
  const AI_THRESHOLD = 45
  const segmentsToRewrite = segMetrics.filter(s => s.aiScore >= AI_THRESHOLD)
  const totalSegs = segMetrics.length
  const rewriteCount = segmentsToRewrite.length

  if (rewriteCount === 0) {
    sender.send('lab:aigc-rewrite:progress', {
      runId, message: '所有段落AI特征评分较低，无需改写'
    })
    return normalizeModelBodyOutput(segMetrics.map(s => s.text).join(''), 'lab_deai')
  }

  appLogger.info('aigc-rewrite', `逐段改写: 总段落=${totalSegs}, 需改写=${rewriteCount}, 阈值=${AI_THRESHOLD}`)
  sender.send('lab:aigc-rewrite:progress', {
    runId, message: `开始逐段精准改写：${rewriteCount}/${totalSegs} 段需要改写`
  })

  const resultSegments = segMetrics.map(s => s.text)
  const batches = buildRewriteBatches(segMetrics, AI_THRESHOLD)

  let completedBatches = 0
  for (const batch of batches) {
    completedBatches++
    sender.send('lab:aigc-rewrite:progress', {
      runId, message: `正在改写第 ${completedBatches}/${batches.length} 批（${batch.targetIndices.length} 段）…`
    })

    const rewritten = await rewriteBatch(segMetrics, batch, isStrongMode, session, modelOpts)

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

function buildRewriteBatches(segMetrics: SegmentDetectDetail[], threshold: number): RewriteBatch[] {
  const batches: RewriteBatch[] = []

  let i = 0
  while (i < segMetrics.length) {
    if (segMetrics[i].aiScore < threshold) { i++; continue }

    const targets: number[] = []
    while (i < segMetrics.length && segMetrics[i].aiScore >= threshold && targets.length < 5) {
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
  modelOpts?: { modelType?: string; modelName?: string }
): Promise<string[]> {
  const { targetIndices, contextStart, contextEnd } = batch

  const lines: string[] = []
  for (let idx = contextStart; idx <= contextEnd; idx++) {
    const seg = segMetrics[idx]
    const isTarget = targetIndices.includes(idx)
    const segText = seg.text.replace(/\n+$/, '').trim()

    if (isTarget) {
      const hint = seg.ppl < 30 ? '（太可预测，需更不常规的表达）'
        : seg.top5Rate > 0.6 ? '（用词太典型，需非常规搭配）'
        : '（AI痕迹明显，需重构句式）'
      lines.push(`【需改写】${hint}: ${segText}`)
    } else if (idx < targetIndices[0]) {
      lines.push(`【上文】: ${segText}`)
    } else {
      lines.push(`【下文】: ${segText}`)
    }
  }

  let systemPrompt = SEGMENT_REWRITE_SYSTEM
  if (isStrongMode) {
    systemPrompt += '\n9. 词汇偏口语化/方言化：用"瞅""搁""寻思"替代"看""放""思考"，用"压根""愣是"替代"完全""坚持"。'
  }

  let content = ''
  const response = await modelService.chat(
    {
      prompt: lines.join('\n'),
      systemPrompt,
      step: 'ai_trace_polish',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.65,
      modelType: modelOpts?.modelType as import('../../model/types').ModelType | undefined,
      modelName: modelOpts?.modelName
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
  if (!raw) return targetIndices.map(idx => segMetrics[idx].text)

  const extracted = extractRewriteContent(raw)
  const outputParts = extracted.split(/\n\s*\n/).filter(p => p.trim())

  if (outputParts.length === targetIndices.length) {
    return outputParts.map(p => p.trim())
  }

  // 按行拆分作为备选
  const outputLines = extracted.split('\n').filter(l => l.trim())
  if (outputLines.length === targetIndices.length) {
    return outputLines.map(l => l.trim())
  }

  // 行数不匹配：取前 N 个
  if (outputLines.length > targetIndices.length) {
    return outputLines.slice(0, targetIndices.length).map(l => l.trim())
  }

  const results: string[] = []
  for (let i = 0; i < targetIndices.length; i++) {
    results.push(outputLines[i]?.trim() || segMetrics[targetIndices[i]].text)
  }
  return results
}

// ─── 降级模式：整篇改写 ─────────────────────────────────────────────────────

async function runWholeTextRewrite(
  sender: WebContents,
  runId: string,
  session: AiSessionHandle,
  input: string,
  detectResult?: AigcDetectResult | null,
  isStrongMode?: boolean,
  modelOpts?: { modelType?: string; modelName?: string }
): Promise<string> {
  const systemPrompt = isStrongMode
    ? AIGC_REWRITE_INTENSIVE_SYSTEM_PROMPT + AIGC_REWRITE_STRONG_COLLOQUIAL_CONSTRAINT
    : AIGC_REWRITE_INTENSIVE_SYSTEM_PROMPT

  let fullContent = ''
  const response = await modelService.chat(
    {
      prompt: buildAigcRewriteUserPrompt(input, detectResult, 'intensive'),
      systemPrompt,
      step: 'ai_trace_polish',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.65,
      modelType: modelOpts?.modelType as import('../../model/types').ModelType | undefined,
      modelName: modelOpts?.modelName
    },
    {
      sessionHandle: session,
      keepSession: true,
      stream: true,
      onDelta: (delta) => { fullContent += delta },
      onThinkingDelta: () => {}
    }
  )

  if (response.cancelled) throw new Error('已取消')
  if (!response.success) throw new Error(response.error || '一键改写失败')

  const raw = response.content?.trim() || fullContent.trim()
  if (!raw) throw new Error('模型未返回有效结果')

  const normalized = normalizeModelBodyOutput(extractRewriteContent(raw), 'lab_deai')
  if (!normalized.trim()) throw new Error('改写结果为空')

  const minExpectedLength = Math.max(50, Math.floor(input.length * 0.3))
  if (normalized.length < minExpectedLength) {
    throw new Error('改写结果异常偏短，已拒绝覆盖原文')
  }

  return normalized
}

export function cancelAigcDetect(runId: string): boolean {
  const session = activeRuns.get(runId)
  if (!session) return false
  aiSessionManager.cancel(session.id)
  activeRuns.delete(runId)
  return true
}
