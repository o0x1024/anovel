import type { AigcCategory, AigcDistribution, AigcSegment } from '../../shared/aigc-detect-types'
import { getDetectThresholds } from './constants'
import type { ZhuqueDistributionFeatures } from './zhuque-distribution-features'

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
  domainTerms: number
  deepseekStyleTerms: number
  penalty: number
  styleReduction: number
  primaryReason?: string
}

export interface ZhuqueScoredSegment {
  text: string
  score: number
  category: AigcCategory
  reason: string
  evidence: ZhuqueFingerprintEvidence
  probabilities?: AigcDistribution
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
const LOW_PREDICTABILITY_DOMAIN_PATTERN = /(灵力|丹田|筑基|炼气|灵石|灵根|宗门|洞府|符箓|法器|修士|仙门|魔修|签到系统|宿主|隐藏副本|声控灯|纸人|棺材|阴气|香火)/g
const DEEPSEEK_STYLE_PATTERN = /(酒旗|斜矗|鸬鹚|黑黢黢|龇(?:牙|了牙)|金箔|跑堂|一扬下巴|借过借过|麻溜|踅摸|打怵|搁在|不晓得)/g

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value))
}

function median(values: number[]): number {
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle]
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value))
}

function localWindowRisk(
  features: ZhuqueDistributionFeatures,
  start: number,
  end: number
): number {
  let weightedRisk = 0
  let totalOverlap = 0
  for (const window of features.windowEvidence) {
    const overlap = Math.max(0, Math.min(end, window.end) - Math.max(start, window.start))
    if (overlap <= 0) continue
    weightedRisk += window.risk * overlap
    totalOverlap += overlap
  }
  return totalOverlap > 0 ? weightedRisk / totalOverlap : features.documentRisk
}

/**
 * 把文档级结构信号分配到各局部段落。二分求出的偏置保证按最终展示权重
 * 汇总后仍等于文档级信号，局部窗口只负责决定风险在段落间如何分布。
 */
function calibrateLocalStructuralSignals(
  scored: Array<Omit<ZhuqueScoredSegment, 'category'>>,
  features: ZhuqueDistributionFeatures,
  documentSignal: number,
  boundaries?: Array<{ start: number; end: number }>
): number[] {
  if (documentSignal <= 0 || scored.length === 0) return scored.map(() => 0)
  if (documentSignal >= 1) return scored.map(() => 1)

  let cursor = 0
  const localRisks = scored.map((item, index) => {
    const boundary = boundaries?.[index]
    if (boundary) return localWindowRisk(features, boundary.start, boundary.end)
    const start = cursor
    cursor += item.text.length
    return localWindowRisk(features, start, cursor)
  })
  const weights = scored.map((item, index) =>
    Math.max(1, item.text.length) * positionWeight(index, scored.length)
  )
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const averageRisk = localRisks.reduce(
    (sum, risk, index) => sum + risk * weights[index],
    0
  ) / totalWeight
  const localOffsets = localRisks.map(risk => (risk - averageRisk) / 7)

  let lower = -16
  let upper = 16
  for (let iteration = 0; iteration < 64; iteration++) {
    const bias = (lower + upper) / 2
    const averageSignal = localOffsets.reduce(
      (sum, offset, index) => sum + sigmoid(bias + offset) * weights[index],
      0
    ) / totalWeight
    if (averageSignal < documentSignal) lower = bias
    else upper = bias
  }
  const bias = (lower + upper) / 2
  return localOffsets.map(offset => sigmoid(bias + offset))
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
  const domainTerms = text.match(LOW_PREDICTABILITY_DOMAIN_PATTERN)?.length ?? 0
  const deepseekStyleTerms = text.match(DEEPSEEK_STYLE_PATTERN)?.length ?? 0

  // 权重来自 F6/F4/F1/F5 注入实验的相对下降幅度。比喻、微动作和句长不加罚。
  const penalty = Math.min(58,
    Math.min(42, filmShot * 18) +
    Math.min(18, connector * 4.5) +
    Math.min(15, emotionTemplate * 6) +
    Math.min(15, summaryClosure * 6)
  )
  const styleReduction = Math.min(26,
    (domainTerms >= 2 ? 8 + domainTerms * 3 : 0) +
    (deepseekStyleTerms >= 2 ? 8 + deepseekStyleTerms * 3 : 0)
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

  return {
    filmShot,
    connector,
    emotionTemplate,
    summaryClosure,
    domainTerms,
    deepseekStyleTerms,
    penalty,
    styleReduction,
    primaryReason
  }
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
  const score = clamp(tokenRisk + evidence.penalty - evidence.styleReduction)

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
  features: ZhuqueDistributionFeatures,
  boundaries?: Array<{ start: number; end: number }>
): ZhuqueScoredSegment[] {
  if (scored.length === 0) return []

  const orderedScores = scored.map(item => item.score).sort((a, b) => a - b)
  const documentMedian = median(orderedScores)
  const tokenMedian = median(scored.map(item => clamp(
    item.score - item.evidence.penalty + item.evidence.styleReduction
  )))
  const documentDomainTerms = scored.reduce((sum, item) => sum + item.evidence.domainTerms, 0)
  const documentDeepseekStyleTerms = scored.reduce(
    (sum, item) => sum + item.evidence.deepseekStyleTerms,
    0
  )
  const hasLowPredictabilityDocumentStyle = documentDomainTerms >= 5 || documentDeepseekStyleTerms >= 4

  let largestGap = 0
  let splitIndex = -1
  for (let i = 1; i < orderedScores.length; i++) {
    const gap = orderedScores[i] - orderedScores[i - 1]
    if (gap > largestGap) {
      largestGap = gap
      splitIndex = i
    }
  }
  const lowerCount = splitIndex
  const upperCount = orderedScores.length - splitIndex
  const mixedThreshold = splitIndex > 0
    ? (orderedScores[splitIndex - 1] + orderedScores[splitIndex]) / 2
    : 0
  const hasMixedClusters = scored.length >= 4 && largestGap >= 12 &&
    lowerCount >= 2 && upperCount >= 2 &&
    orderedScores[splitIndex - 1] <= 52 && orderedScores[splitIndex] >= 55
  const upperWithoutMinimum = orderedScores.slice(1)
  const upperSpread = upperWithoutMinimum.length > 1
    ? upperWithoutMinimum[upperWithoutMinimum.length - 1] - upperWithoutMinimum[0]
    : 0
  const hasHumanAnchorInSuspectDoc = documentMedian > 52 && documentMedian < 68 &&
    orderedScores[0] <= 38 && upperSpread >= 8
  const concentratedWindowSignal = clamp(
    clamp((features.documentRisk - 32) / 10, 0, 1) *
    clamp((features.peakWindowRisk - 34) / 10, 0, 1) *
    (0.4 + 0.6 * clamp(features.highRiskWindowShare / 15, 0, 1)),
    0,
    1
  )
  // 文档级多维证据和局部窗口集中度是两条独立证据链。不能相乘成硬门槛，
  // 否则 350-600 字文本会因窗口数量少而把已成立的整篇结构风险直接清零。
  const documentStructureSignal = clamp((features.documentRisk - 30) / 14, 0, 1)
  const structuralSignal = Math.max(documentStructureSignal, concentratedWindowSignal)
  const localStructuralSignals = calibrateLocalStructuralSignals(
    scored,
    features,
    structuralSignal,
    boundaries
  )

  return scored.map((item, index) => {
    const previousRisk = scored[index - 1]?.score
    const nextRisk = scored[index + 1]?.score
    const hasUpperClusterNeighbour = [previousRisk, nextRisk].some(score =>
      typeof score === 'number' && score > mixedThreshold
    )
    const followsFilmShotWindow = (scored[index - 1]?.evidence.filmShot ?? 0) >= 2
    let category: AigcCategory

    if (hasLowPredictabilityDocumentStyle) {
      category = 'suspected_ai'
    } else if (hasMixedClusters) {
      if (item.score <= mixedThreshold) category = 'human'
      else category = hasUpperClusterNeighbour ? 'ai' : 'suspected_ai'
    } else if (tokenMedian <= 52) {
      const hasVerifiedFingerprint = item.evidence.penalty >= 4 && item.score > 60
      category = hasVerifiedFingerprint ? 'suspected_ai' : 'human'
      if (item.evidence.filmShot >= 2 && item.score >= 68) category = 'ai'
      if (followsFilmShotWindow && category === 'human') category = 'suspected_ai'
    } else if (documentMedian < 68) {
      category = hasHumanAnchorInSuspectDoc && item.score <= 38 ? 'human' : 'suspected_ai'
    } else {
      category = 'ai'
    }

    let reason = item.reason
    let probabilities: AigcDistribution | undefined
    // 结构证据连续削减“人工”权重，不再受 tokenMedian<=52 一票否决。
    if (category === 'human' && structuralSignal > 0) {
      const localStructuralSignal = localStructuralSignals[index]
      const itemTokenRisk = clamp(
        item.score - item.evidence.penalty + item.evidence.styleReduction
      )
      const aiShare = localStructuralSignal * clamp((itemTokenRisk - 30) / 20, 0, 1)
      const suspectedShare = localStructuralSignal - aiShare
      probabilities = {
        human: (1 - localStructuralSignal) * 100,
        suspected_ai: suspectedShare * 100,
        ai: aiShare * 100
      }
      if (probabilities.ai >= probabilities.suspected_ai && probabilities.ai > probabilities.human) {
        category = 'ai'
      } else if (probabilities.suspected_ai > probabilities.human) {
        category = 'suspected_ai'
      }
      reason = `${features.reasons[0] ?? '局部窗口结构风险偏高'}；${item.reason}`
    }
    return { ...item, category, reason, probabilities }
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
    const probabilities = segment.probabilities ?? {
      human: segment.category === 'human' ? 100 : 0,
      suspected_ai: segment.category === 'suspected_ai' ? 100 : 0,
      ai: segment.category === 'ai' ? 100 : 0
    }
    weighted.human += weight * probabilities.human / 100
    weighted.suspected_ai += weight * probabilities.suspected_ai / 100
    weighted.ai += weight * probabilities.ai / 100
    total += weight
  })

  const human = Math.round((weighted.human / total) * 10000) / 100
  const ai = Math.round((weighted.ai / total) * 10000) / 100
  const suspected_ai = Math.round((100 - human - ai) * 100) / 100
  return { human, suspected_ai, ai }
}

/**
 * 句级最终类别按有效字符数汇总全文覆盖率。
 * 顶部百分比必须与绿/黄/红正文面积使用同一个硬分类口径，不能继续累加软概率，
 * 否则会再次出现“AI百分比非零但没有任何红句”的语义冲突。
 */
export function computeZhuqueSentenceDistribution(
  segments: ZhuqueScoredSegment[]
): AigcDistribution {
  if (segments.length === 0) return { human: 0, suspected_ai: 0, ai: 0 }

  const weighted = { human: 0, suspected_ai: 0, ai: 0 }
  let total = 0
  for (const segment of segments) {
    const weight = Math.max(1, segment.text.replace(/\s/g, '').length)
    weighted[segment.category] += weight
    total += weight
  }

  const human = Math.round(weighted.human / total * 10000) / 100
  const ai = Math.round(weighted.ai / total * 10000) / 100
  return {
    human,
    suspected_ai: Math.round((100 - human - ai) * 100) / 100,
    ai
  }
}

export function toAigcSegments(segments: ZhuqueScoredSegment[]): AigcSegment[] {
  return segments.map(({ text, category, reason, probabilities }) => ({
    text,
    category,
    reason,
    probabilities
  }))
}
