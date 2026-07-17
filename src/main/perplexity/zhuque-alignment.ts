import type { AigcCategory, AigcDistribution, AigcSegment } from '../../shared/aigc-detect-types'
import { getDetectThresholds } from './constants'

export const ZHUQUE_MIN_TEXT_LENGTH = 350
export const ZHUQUE_TARGET_SEGMENT_LENGTH = 240
export const ZHUQUE_MAX_SEGMENT_LENGTH = 320

export interface ZhuqueMetricInput {
  ppl: number
  tokenCount: number
  top5Rate: number
  avgProb: number
}

export interface ZhuqueFingerprintEvidence {
  filmShot: number
  connector: number
  emotionTemplate: number
  summaryClosure: number
  penalty: number
  primaryReason?: string
}

export interface ZhuqueScoredSegment {
  text: string
  score: number
  category: AigcCategory
  reason: string
  evidence: ZhuqueFingerprintEvidence
}

const SENTENCE_BOUNDARY_CHARS = new Set([
  '。', '！', '？', '!', '?', '；', ';', '…', '\n'
])

const FILM_SHOT_PATTERNS = [
  /(?:目光|视线|眼神)(?:落在|扫过|越过|移到|停在|掠过).{0,18}(?:上|脸|身|窗|门|手|眼)/g,
  /嘴角微微(?:上扬|勾起|一弯|扬起)/g,
  /脚步(?:微微)?顿了顿/g,
  /缓缓(?:回过头|转过身|抬起头|开口)/g,
  /视线从.{0,18}(?:移到|转向).{0,18}(?:又|再).{0,12}(?:收回|移开)/g
]

const CONNECTOR_PATTERN = /(然而|因此|此外|与此同时|值得注意的是|不难发现|由此可见|换言之|总而言之|不仅如此|尽管如此)/g
const EMOTION_TEMPLATE_PATTERN = /(心中|心里|心头)(?:涌起|泛起|升起)一股|眼中闪过一丝|一股.{0,12}(?:涌上|涌入)心头/g
const SUMMARY_CLOSURE_PATTERN = /(这一刻[，,]?(?:他|她|它)?(?:忽然|终于)?明白了|或许这便是|对于.{0,18}而言|直到此刻[，,]?(?:他|她)?才明白)/g

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value))
}

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.reduce((total, pattern) => total + (text.match(pattern)?.length ?? 0), 0)
}

/**
 * 朱雀实验显示其检测粒度约为 200-300 字，并且会保留短对话等低概率锚点。
 * 此分段器不丢弃任何字符，只在自然句界附近切分。
 */
export function segmentTextForZhuque(
  text: string,
  targetLength = ZHUQUE_TARGET_SEGMENT_LENGTH,
  maxLength = ZHUQUE_MAX_SEGMENT_LENGTH
): Array<{ id: number; text: string }> {
  if (!text) return []

  const minLength = Math.max(80, Math.floor(targetLength * 0.62))
  const chunks: string[] = []
  let start = 0
  let latestBoundary = -1

  for (let i = 0; i < text.length; i++) {
    if (SENTENCE_BOUNDARY_CHARS.has(text[i])) latestBoundary = i + 1

    const currentLength = i - start + 1
    const hasUsableBoundary = latestBoundary - start >= minLength
    if (currentLength >= targetLength && hasUsableBoundary) {
      chunks.push(text.slice(start, latestBoundary))
      start = latestBoundary
      i = start - 1
      latestBoundary = -1
      continue
    }

    if (currentLength >= maxLength) {
      const end = hasUsableBoundary ? latestBoundary : i + 1
      chunks.push(text.slice(start, end))
      start = end
      i = start - 1
      latestBoundary = -1
    }
  }

  if (start < text.length) {
    const tail = text.slice(start)
    const previous = chunks[chunks.length - 1]
    if (previous && tail.length < minLength && previous.length + tail.length <= maxLength * 1.15) {
      chunks[chunks.length - 1] = previous + tail
    } else {
      chunks.push(tail)
    }
  }

  return chunks.filter(Boolean).map((chunk, id) => ({ id, text: chunk }))
}

export function detectZhuqueFingerprints(text: string): ZhuqueFingerprintEvidence {
  const filmShot = countMatches(text, FILM_SHOT_PATTERNS)
  const connector = text.match(CONNECTOR_PATTERN)?.length ?? 0
  const emotionTemplate = text.match(EMOTION_TEMPLATE_PATTERN)?.length ?? 0
  const summaryClosure = text.match(SUMMARY_CLOSURE_PATTERN)?.length ?? 0

  // 权重来自 F6/F4/F1/F5 注入实验的相对下降幅度。比喻、微动作和句长不加罚。
  const penalty = Math.min(58,
    Math.min(42, filmShot * 18) +
    Math.min(18, connector * 4.5) +
    Math.min(15, emotionTemplate * 6) +
    Math.min(15, summaryClosure * 6)
  )

  const primaryReason = filmShot > 0
    ? `电影镜头链×${filmShot}`
    : connector > 0
      ? `书面连接词×${connector}`
      : emotionTemplate > 0
        ? `模板情感句×${emotionTemplate}`
        : summaryClosure > 0
          ? `总结收束句×${summaryClosure}`
          : undefined

  return { filmShot, connector, emotionTemplate, summaryClosure, penalty, primaryReason }
}

/**
 * 将本地语言模型指标映射为朱雀方向的风险分。
 * 朱雀实验已经证明：低概率/乱序 n-gram 会被判得更“人工”，因此这里只惩罚
 * 高可预测方向，不再把极高困惑度反向判成 AI。
 */
export function computeZhuqueTokenRisk(metric: ZhuqueMetricInput, modelId?: string): number {
  if (!metric || metric.tokenCount < 2 || metric.ppl <= 0 || !Number.isFinite(metric.ppl)) return 50

  const baseline = getDetectThresholds(modelId).baseline
  const pplDirection = clamp((baseline.ppl - metric.ppl) / Math.max(1, baseline.ppl), -1.25, 1.25)
  const top5Direction = clamp((metric.top5Rate - baseline.top5) / 0.32, -1.25, 1.25)
  const probabilityDirection = clamp((metric.avgProb - baseline.avgProb) / 0.16, -1.25, 1.25)

  // 人工基线附近落在人工/疑似边界下方；三个指标都更可预测时才进入 AI 区。
  return clamp(28 + pplDirection * 30 + top5Direction * 24 + probabilityDirection * 18)
}

export function scoreZhuqueSegment(
  text: string,
  metric: ZhuqueMetricInput,
  modelId?: string
): Omit<ZhuqueScoredSegment, 'category'> {
  const tokenRisk = computeZhuqueTokenRisk(metric, modelId)
  const evidence = detectZhuqueFingerprints(text)
  const score = clamp(tokenRisk + evidence.penalty)

  let reason = evidence.primaryReason
  if (!reason) {
    if (score >= 65) reason = '相邻词组过于可预测'
    else if (score >= 38) reason = '词组分布接近AI区间'
    else if (metric.ppl > getDetectThresholds(modelId).baseline.ppl * 1.35) reason = '低概率词组较多'
    else reason = '词组预测分布偏人工'
  }

  return { text, score, reason, evidence }
}

export function classifyZhuqueSegments(
  scored: Array<Omit<ZhuqueScoredSegment, 'category'>>,
  modelId?: string
): ZhuqueScoredSegment[] {
  const thresholds = getDetectThresholds(modelId).classify
  return scored.map((item, index) => {
    const previousRisk = scored[index - 1]?.score
    const nextRisk = scored[index + 1]?.score
    const hasAiNeighbour = [previousRisk, nextRisk].some(score =>
      typeof score === 'number' && score >= thresholds.aiFloor - 8
    )

    let category: AigcCategory
    if (item.score <= thresholds.humanCeiling) {
      category = 'human'
    } else if (item.score >= thresholds.aiFloor) {
      // K4/K5 实验证明，孤立 AI 段被人工段打断时通常降为“疑似AI”。
      category = hasAiNeighbour || item.evidence.filmShot >= 2 ? 'ai' : 'suspected_ai'
    } else {
      category = 'suspected_ai'
    }

    return { ...item, category }
  })
}

function positionWeight(index: number, count: number): number {
  if (count <= 1) return 1
  // Q6/K2 表明首部权重明显高于尾部；线性权重近似该位置效应。
  return 1.45 - (index / (count - 1)) * 0.55
}

export function computeZhuqueDistribution(segments: ZhuqueScoredSegment[]): AigcDistribution {
  if (segments.length === 0) return { human: 0, suspected_ai: 0, ai: 0 }

  const weighted = { human: 0, suspected_ai: 0, ai: 0 }
  let total = 0
  segments.forEach((segment, index) => {
    const weight = Math.max(1, segment.text.length) * positionWeight(index, segments.length)
    weighted[segment.category] += weight
    total += weight
  })

  const human = Math.round((weighted.human / total) * 10000) / 100
  const ai = Math.round((weighted.ai / total) * 10000) / 100
  const suspected_ai = Math.round((100 - human - ai) * 100) / 100
  return { human, suspected_ai, ai }
}

export function toAigcSegments(segments: ZhuqueScoredSegment[]): AigcSegment[] {
  return segments.map(({ text, category, reason }) => ({ text, category, reason }))
}

