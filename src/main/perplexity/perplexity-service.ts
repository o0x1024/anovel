import { Worker } from 'worker_threads'
import path from 'path'
import type { AigcDetectResult, AigcSegment, AigcDistribution, AigcCategory, PerplexityApiConfig } from '../../shared/aigc-detect-types'
import { ensureModelReady, isModelReady, type DownloadProgressCallback } from './model-manager'
import { DETECT_THRESHOLDS, getDetectThresholds, MODEL_THRESHOLD_OVERRIDES, resolveDetectModelId } from './constants'
import { appLogger } from '../logger/app-logger'
import { getActiveModelId } from './model-manager'
import { computeViaApi, computeWholeViaApi, isDegenerateApiLogprobs, type TokenMetric } from './api-perplexity'
import { runHeuristicDetect } from './heuristic-detect'
import { appPreferenceDAO } from '../db'
import {
  classifyZhuqueSegments,
  computeZhuqueDistribution,
  computeZhuqueTokenRisk,
  scoreZhuqueSegment,
  segmentTextForZhuque,
  toAigcSegments
} from './zhuque-alignment'

export interface LabModelOverride {
  modelType?: string
  modelName?: string
}

function resolveApiConfig(): PerplexityApiConfig {
  return appPreferenceDAO.getPerplexityApiConfig()
}

/** 通过本机 OpenAI 兼容 API 计算困惑度（优先整文 echo，失败则逐段） */
async function computePplViaLocalApi(
  text: string,
  segments: Array<{ id: number; text: string }>,
  segmentBoundaries: Array<{ start: number; end: number }>,
  apiConfig: PerplexityApiConfig,
  onProgress?: (msg: string) => void
): Promise<SegmentPPLResult[]> {
  onProgress?.(`正在通过本地 API 检测 (${apiConfig.apiBase})…`)
  appLogger.info('perplexity', `使用本地 API 模式: ${apiConfig.apiBase}, 模型: ${apiConfig.modelName || '(默认)'}`)

  try {
    const tokenMetrics = await computeWholeViaApi(
      text,
      apiConfig.apiBase,
      apiConfig.modelName,
      onProgress,
      apiConfig.apiKey
    )
    if (tokenMetrics.length > 0) {
      return aggregateTokensBySegments(tokenMetrics, segmentBoundaries, segments)
    }
  } catch {
    // /completions 可能不可用（如 MLX），退回逐段探测
  }

  return computeViaApi(
    segments,
    apiConfig.apiBase,
    apiConfig.modelName,
    onProgress,
    apiConfig.apiKey
  )
}

interface SegmentPPLResult {
  id: number
  ppl: number
  tokenCount: number
  top5Rate: number
  avgProb: number
}

interface WorkerResponse {
  type: 'ready' | 'result' | 'wholeResult' | 'error' | 'progress'
  results?: SegmentPPLResult[]
  tokenMetrics?: TokenMetric[]
  message?: string
  progress?: number
}

let worker: Worker | null = null
let workerReady = false
let loadedModelPath: string | null = null

/**
 * 困惑度 worker 串行锁：worker 是单例，computeWhole/compute 通过在同一个
 * worker 上挂 message handler 等待结果，本身没有并发保护。任意重入（如自动
 * 重写循环里对每段/候选分别打分）会让 handler 错配，触发 native eval 在脏
 * 上下文执行 → "Eval has failed"。此锁强制所有 worker 计算串行排队。
 */
let workerChain: Promise<unknown> = Promise.resolve()
function withWorkerLock<T>(task: () => Promise<T>): Promise<T> {
  const run = workerChain.then(task, task)
  workerChain = run.then(() => undefined, () => undefined)
  return run
}

function getWorkerPath(): string {
  return path.join(__dirname, 'perplexity-worker.js')
}

async function ensureWorker(modelPath: string): Promise<void> {
  // If already loaded with same model, reuse
  if (worker && workerReady && loadedModelPath === modelPath) return

  // Model changed or worker not ready — rebuild
  if (worker) {
    await terminateWorker()
  }

  return new Promise<void>((resolve, reject) => {
    worker = new Worker(getWorkerPath(), {
      workerData: { modelPath }
    })

    const timeout = setTimeout(() => {
      reject(new Error('模型加载超时（60秒）'))
    }, 60000)

    worker.on('message', (msg: WorkerResponse) => {
      if (msg.type === 'ready') {
        clearTimeout(timeout)
        workerReady = true
        loadedModelPath = modelPath
        resolve()
      } else if (msg.type === 'error') {
        clearTimeout(timeout)
        reject(new Error(msg.message || '工作线程错误'))
      }
    })

    worker.on('error', (err) => {
      clearTimeout(timeout)
      workerReady = false
      reject(err)
    })

    worker.on('exit', () => {
      workerReady = false
      worker = null
    })
  })
}

async function terminateWorker(): Promise<void> {
  if (!worker) return
  worker.postMessage({ type: 'dispose' })
  await worker.terminate()
  worker = null
  workerReady = false
  loadedModelPath = null
}

function segmentText(text: string): Array<{ id: number; text: string }> {
  return segmentTextForZhuque(text)
}

/**
 * 计算单个段落的 AI 评分（0-100，越高越像 AI）
 * 综合 PPL（反转方向）和 Top-5 命中率
 */
/**
 * V3 评分：双向偏离 + 方向一致性
 * 
 * 原理：AI 文本的 PPL/Top5/AvgProb 三指标同时偏向同一方向
 * - 模仿型AI: 三指标全部偏"可预测"方向（PPL低、Top5高、Prob高）
 * - 创意型AI: 三指标全部偏"不可预测"方向（PPL高、Top5低、Prob低）
 * - 人类文本: 三指标方向不一致，自然散落在基线附近
 */
function computeSegmentAiScore(ppl: number, top5Rate: number, avgProb: number, modelId?: string): number {
  return computeZhuqueTokenRisk({ ppl, top5Rate, avgProb, tokenCount: 2 }, modelId)
}

/**
 * 基于 AI 评分分类段落
 * 阈值从 constants.ts 读取，默认 aiFloor=58 / humanCeiling=22
 */
/** 科普/资讯自媒体体特征词（朱雀对 A3 类敏感，4B 困惑度易低估） */
const EXPLAINER_PATTERNS = /(你以为|说真的|很多人|换个角度|认知还停留在|千万别|记住|赶紧|提醒|黑产|精准诈骗|导出上千条|你想想看|渗透测试|防不胜防|半分钟|划重点)/g

function classifyByScore(
  score: number,
  modelId?: string,
  opts?: { aiFloor?: number }
): AigcCategory {
  const T = getDetectThresholds(modelId).classify
  const aiFloor = opts?.aiFloor ?? T.aiFloor
  if (score >= aiFloor) return 'ai'
  if (score <= T.humanCeiling) return 'human'
  return 'suspected_ai'
}

function generateReason(ppl: number, top5Rate: number, category: AigcCategory): string {
  if (category === 'ai') {
    if (ppl > 300) return '困惑度极高，表达模式异常，AI特征明显'
    if (top5Rate < 0.25) return 'Token预测命中率极低，非典型人类用词'
    return '困惑度偏高且命中率低，疑似AI生成'
  }
  if (category === 'human') {
    if (top5Rate > 0.55) return '表达自然，符合常见写作模式'
    return '困惑度低，用词符合人类写作习惯'
  }
  if (ppl > 150) return '困惑度较高，有AI生成嫌疑'
  if (top5Rate < 0.40) return '命中率偏低，用词模式有AI倾向'
  return '困惑度中等，疑似AI辅助'
}

/**
 * 计算文本启发式特征（补充 PPL 检测）
 * 返回 heuristicAiBoost: 0-15 的 AI 倾向加分
 */
function computeHeuristicFeatures(text: string): {
  sentLenStd: number
  connectorDensity: number
  heuristicAiBoost: number
  explainerHits: number
  details: string
} {
  const sentences = text.split(/[。！？；…]+/).filter(s => s.trim().length > 2)
  if (sentences.length < 3) {
    return { sentLenStd: 0, connectorDensity: 0, heuristicAiBoost: 0, explainerHits: 0, details: '句子过少' }
  }

  const lengths = sentences.map(s => s.trim().length)
  const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length
  const sentLenStd = Math.sqrt(lengths.reduce((s, l) => s + Math.pow(l - avgLen, 2), 0) / lengths.length)

  const connectors = ['然而', '此时', '紧接着', '随即', '与此同时', '不过', '只见', '顿时', '但是', '因此', '于是', '而后']
  let connectorCount = 0
  for (const c of connectors) {
    const matches = text.match(new RegExp(c, 'g'))
    if (matches) connectorCount += matches.length
  }
  const connectorDensity = connectorCount / sentences.length

  let boost = 0
  const markers: string[] = []

  // 1. 词汇多样性（TTR）: 极低 TTR 可能是模板化 AI
  const chars = text.replace(/[，。！？、；：""''（）\s\n]/g, '')
  const uniqueChars = new Set(chars).size
  const ttr = uniqueChars / Math.min(chars.length, 500)
  if (ttr < 0.40 && chars.length > 200) {
    boost += 4
    markers.push(`TTR极低=${ttr.toFixed(3)}`)
  }

  // 2. 句首重复率: AI 倾向用相似的句式开头
  const openings = sentences.map(s => s.trim().slice(0, 2))
  const uniqueOpenings = new Set(openings).size
  const openingDiversity = uniqueOpenings / openings.length
  if (openingDiversity < 0.55 && sentences.length >= 8) {
    boost += 5
    markers.push(`句首重复=${(1 - openingDiversity).toFixed(2)}`)
  }

  // 3. 短长句刻意交替: AI 模仿人类时常刻意插入短句制造"节奏感"
  if (sentences.length >= 6) {
    let alternationCount = 0
    for (let i = 1; i < lengths.length; i++) {
      const prev = lengths[i - 1]
      const curr = lengths[i]
      if ((prev < 8 && curr > 30) || (prev > 30 && curr < 8)) {
        alternationCount++
      }
    }
    const alternationRate = alternationCount / (lengths.length - 1)
    if (alternationRate > 0.12) {
      boost += 8
      markers.push(`短长交替=${alternationRate.toFixed(2)}`)
    }
  }

  // 4. 句长两极化: 大量极短句(< 8字) + 大量长句(> 40字) 同时存在
  const shortSents = lengths.filter(l => l < 8).length
  const longSents = lengths.filter(l => l > 40).length
  const shortRatio = shortSents / sentences.length
  const longRatio = longSents / sentences.length
  if (shortRatio > 0.18 && longRatio > 0.12 && sentences.length >= 8) {
    boost += 6
    markers.push(`句长两极化: 短${(shortRatio * 100).toFixed(0)}%+长${(longRatio * 100).toFixed(0)}%`)
  }

  // 5. 对话密度过高: AI小说倾向使用大量短对话推动情节
  const dialogueLines = text.split('\n').filter(l => /^["「『"]/.test(l.trim()) || /^["""]/.test(l.trim()))
  const allLines = text.split('\n').filter(l => l.trim().length > 0)
  if (allLines.length >= 10) {
    const dialogueRatio = dialogueLines.length / allLines.length
    if (dialogueRatio > 0.35) {
      boost += 6
      markers.push(`对话密度=${(dialogueRatio * 100).toFixed(0)}%`)
    }
  }

  // 6. 短对话回复模式: 大量极短台词（"嗯"、"什么？"等）
  const veryShortSents = sentences.filter(s => s.trim().length <= 4)
  if (veryShortSents.length >= 5 && veryShortSents.length / sentences.length > 0.10) {
    boost += 5
    markers.push(`极短句=${veryShortSents.length}`)
  }

  // 7. 情感/动作描写模板密度
  const templatePatterns = /[她他](?:愣|笑|叹|呆|抖|站|蹲|转身|低头|抬头|皱眉|摇头|点头|放下|拿起|走到)|声音很[轻小低哑]|猛地|突然|像是|忽然|半天没/g
  const templateCount = (text.match(templatePatterns) || []).length
  if (templateCount >= 8 && sentences.length >= 15) {
    boost += 6
    markers.push(`模板化描写=${templateCount}`)
  }

  // 8. 科普/资讯自媒体体（朱雀对 A3 类敏感，4B 困惑度易低估）
  const explainerHits = (text.match(EXPLAINER_PATTERNS) || []).length
  if (explainerHits >= 3 && sentences.length >= 10) {
    boost += 12 + Math.min(6, explainerHits - 3)
    markers.push(`科普资讯体=${explainerHits}`)
  }

  const details = markers.length > 0 ? markers.join(', ') : '无明显AI特征'
  return {
    sentLenStd,
    connectorDensity,
    heuristicAiBoost: Math.min(30, boost),
    explainerHits,
    details,
  }
}

export async function runPerplexityDetect(
  text: string,
  onProgress?: (msg: string) => void,
  onDownloadProgress?: DownloadProgressCallback,
  labModel?: LabModelOverride
): Promise<AigcDetectResult> {
  const apiConfig = resolveApiConfig()
  const useApi = apiConfig.mode === 'api'
  const detectModelId = resolveDetectModelId({
    useApi,
    apiModelName: apiConfig.modelName,
    localModelId: getActiveModelId()
  })

  const segments = segmentText(text)
  if (segments.length === 0) {
    return {
      segments: [{ text, category: 'human', reason: '文本过短，无法判定' }],
      distribution: { human: 100, suspected_ai: 0, ai: 0 },
      summary: '文本过短'
    }
  }

  // 计算每个段落的字符起止偏移
  const segmentBoundaries = computeSegmentBoundaries(segments, text)

  let pplResults: SegmentPPLResult[]

  if (useApi) {
    pplResults = await computePplViaLocalApi(
      text,
      segments,
      segmentBoundaries,
      apiConfig,
      onProgress
    )
  } else {
    onProgress?.('正在准备困惑度检测模型…')
    const modelPath = await ensureModelReady(onDownloadProgress)

    onProgress?.('正在加载模型…')
    await ensureWorker(modelPath)

    onProgress?.('正在对全文进行连续困惑度计算…')
    let tokenMetrics = await computeWholeInWorker(text)

    if (tokenMetrics.length === 0 && text.trim().length > 20) {
      appLogger.info('perplexity', '整文计算无结果，重建 worker 重试…')
      await terminateWorker()
      await ensureWorker(modelPath)
      tokenMetrics = await computeWholeInWorker(text)
    }

    pplResults = aggregateTokensBySegments(tokenMetrics, segmentBoundaries, segments)
  }

  if (useApi && isDegenerateApiLogprobs(pplResults)) {
    appLogger.warn(
      'perplexity',
      `API logprobs 退化，切换启发式检测: ${apiConfig.modelName || detectModelId || 'unknown'}`
    )
    onProgress?.('云端 logprobs 无效，使用启发式检测（已针对朱雀校准）…')
    return runHeuristicDetect(text, segments, detectModelId)
  }

  // 过滤有效结果
  const validResults = pplResults.filter(r => r.ppl > 0 && r.ppl < 400 && r.tokenCount >= 2)
  const pplValues = validResults.map(r => r.ppl)
  const top5Values = validResults.map(r => r.top5Rate)

  const avgPPL = pplValues.length > 0
    ? pplValues.reduce((a, b) => a + b, 0) / pplValues.length : 100
  const avgTop5 = top5Values.length > 0
    ? top5Values.reduce((a, b) => a + b, 0) / top5Values.length : 0.4

  const zeroCount = pplResults.filter(r => r.ppl === 0).length
  const totalTokenCount = pplResults.reduce((s, r) => s + r.tokenCount, 0)
  appLogger.info('perplexity', `PPL统计: 段落数=${segments.length}, 有效=${validResults.length}, 零值=${zeroCount}, 总tokens=${totalTokenCount}, 平均PPL=${avgPPL.toFixed(2)}, 平均Top5=${(avgTop5 * 100).toFixed(1)}%`)

  const sortedPPL = [...pplValues].sort((a, b) => a - b)
  const p25 = sortedPPL[Math.floor(sortedPPL.length * 0.25)] || avgPPL
  const p50 = sortedPPL[Math.floor(sortedPPL.length * 0.5)] || avgPPL
  const p75 = sortedPPL[Math.floor(sortedPPL.length * 0.75)] || avgPPL

  appLogger.info('perplexity', `PPL分布: min=${sortedPPL[0]?.toFixed(2)}, p25=${p25.toFixed(2)}, median=${p50.toFixed(2)}, p75=${p75.toFixed(2)}, max=${sortedPPL[sortedPPL.length - 1]?.toFixed(2)}`)

  const sampleDetails = pplResults.slice(0, 10).map((r, i) =>
    `[${i}]PPL=${r.ppl.toFixed(1)},T5=${(r.top5Rate * 100).toFixed(0)}%,tc=${r.tokenCount}`
  ).join(', ')
  appLogger.info('perplexity', `段落明细(前10): ${sampleDetails}`)

  const scoredDrafts = segments.map((seg, i) => {
    const metric = pplResults[i] ?? { id: seg.id, ppl: 0, tokenCount: 0, top5Rate: 0, avgProb: 0 }
    return scoreZhuqueSegment(seg.text, metric, detectModelId)
  })
  const classified = classifyZhuqueSegments(scoredDrafts, detectModelId)
  const distribution = computeZhuqueDistribution(classified)
  const resultSegments = toAigcSegments(classified)
  const validScores = classified
    .filter((_, i) => (pplResults[i]?.tokenCount ?? 0) >= 2)
    .map(segment => segment.score)
  const rawDocScore = validScores.length > 0
    ? validScores.reduce((a, b) => a + b, 0) / validScores.length
    : 50
  const fingerprintHits = classified.reduce(
    (sum, segment) => sum + segment.evidence.filmShot + segment.evidence.connector +
      segment.evidence.emotionTemplate + segment.evidence.summaryClosure,
    0
  )

  appLogger.info('perplexity', '朱雀对齐检测', {
    modelId: detectModelId,
    segmentCount: segments.length,
    avgScore: Math.round(rawDocScore * 10) / 10,
    fingerprintHits,
    distribution
  })

  const summary = `朱雀实验对齐估计：人工 ${distribution.human}%，疑似AI ${distribution.suspected_ai}%，AI特征 ${distribution.ai}%` +
    (fingerprintHits > 0 ? `；命中特征短语 ${fingerprintHits} 处` : '')

  return { segments: resultSegments, distribution, summary }
}

/**
 * 计算每个段落在原文中的字符起止偏移
 */
function computeSegmentBoundaries(
  segments: Array<{ id: number; text: string }>,
  _fullText: string
): Array<{ start: number; end: number }> {
  const boundaries: Array<{ start: number; end: number }> = []
  let offset = 0
  for (const seg of segments) {
    boundaries.push({ start: offset, end: offset + seg.text.length })
    offset += seg.text.length
  }
  return boundaries
}

/**
 * 将 token 级别指标按段落边界聚合为段落级 PPL 结果
 */
function aggregateTokensBySegments(
  tokenMetrics: TokenMetric[],
  boundaries: Array<{ start: number; end: number }>,
  segments: Array<{ id: number; text: string }>
): SegmentPPLResult[] {
  return segments.map((seg, idx) => {
    const { start, end } = boundaries[idx]

    // 找出落在此段落范围内的 token
    const segTokens = tokenMetrics.filter(t =>
      t.charOffset >= start && t.charOffset < end
    )

    if (segTokens.length === 0) {
      return { id: seg.id, ppl: 0, tokenCount: 0, top5Rate: 0, avgProb: 0 }
    }

    const sumLogProb = segTokens.reduce((s, t) => s + t.logProb, 0)
    const ppl = Math.exp(-sumLogProb / segTokens.length)
    const top5Rate = segTokens.filter(t => t.inTop5).length / segTokens.length
    const avgProb = segTokens.reduce((s, t) => s + t.prob, 0) / segTokens.length

    return { id: seg.id, ppl, tokenCount: segTokens.length, top5Rate, avgProb }
  })
}

/**
 * 通过 worker 执行整文连续计算（串行，避免重入触发 native eval 失败）
 */
function computeWholeInWorker(text: string): Promise<TokenMetric[]> {
  return withWorkerLock(() => new Promise<TokenMetric[]>((resolve, reject) => {
    if (!worker) {
      reject(new Error('工作线程未就绪'))
      return
    }

    const handler = (msg: WorkerResponse) => {
      if (msg.type === 'wholeResult' && msg.tokenMetrics) {
        worker?.off('message', handler)
        resolve(msg.tokenMetrics)
      } else if (msg.type === 'error') {
        worker?.off('message', handler)
        reject(new Error(msg.message || '计算失败'))
      }
    }

    worker.on('message', handler)
    worker.postMessage({ type: 'computeWhole', text })
  }))
}

function computeInWorker(segments: Array<{ id: number; text: string }>): Promise<SegmentPPLResult[]> {
  return withWorkerLock(() => new Promise<SegmentPPLResult[]>((resolve, reject) => {
    if (!worker) {
      reject(new Error('工作线程未就绪'))
      return
    }

    const handler = (msg: WorkerResponse) => {
      if (msg.type === 'result' && msg.results) {
        worker?.off('message', handler)
        resolve(msg.results)
      } else if (msg.type === 'error') {
        worker?.off('message', handler)
        reject(new Error(msg.message || '计算失败'))
      }
    }

    worker.on('message', handler)
    worker.postMessage({ type: 'compute', segments })
  }))
}

function computeDistribution(segments: AigcSegment[]): AigcDistribution {
  const total = segments.reduce((sum, s) => sum + s.text.length, 0)
  if (total === 0) return { human: 0, suspected_ai: 0, ai: 0 }

  let humanLen = 0, suspectedLen = 0, aiLen = 0
  for (const seg of segments) {
    if (seg.category === 'human') humanLen += seg.text.length
    else if (seg.category === 'suspected_ai') suspectedLen += seg.text.length
    else aiLen += seg.text.length
  }

  return {
    human: Math.round((humanLen / total) * 10000) / 100,
    suspected_ai: Math.round((suspectedLen / total) * 10000) / 100,
    ai: Math.round((aiLen / total) * 10000) / 100
  }
}

function buildSummary(avgPPL: number, avgTop5: number, category: AigcCategory, dist: AigcDistribution): string {
  const B = DETECT_THRESHOLDS.baseline
  const pplDev = Math.abs(avgPPL - B.ppl) / B.ppl
  const pplDesc = pplDev < 0.3 ? '正常' : pplDev < 0.7 ? '偏离' : '异常'
  const top5Dev = Math.abs(avgTop5 - B.top5) / B.top5
  const top5Desc = top5Dev < 0.15 ? '正常' : top5Dev < 0.3 ? '偏离' : '异常'
  if (category === 'ai') return `困惑度${pplDesc}(${avgPPL.toFixed(0)})，Token命中率${top5Desc}(${(avgTop5 * 100).toFixed(0)}%)，AI生成特征明显`
  if (category === 'human') return `困惑度${pplDesc}(${avgPPL.toFixed(0)})，Token命中率${top5Desc}(${(avgTop5 * 100).toFixed(0)}%)，人工写作特征明显`
  return `困惑度${pplDesc}(${avgPPL.toFixed(0)})，Token命中率${top5Desc}(${(avgTop5 * 100).toFixed(0)}%)，疑似AI生成`
}

export function isPerplexityModelReady(): boolean {
  return isModelReady()
}

export async function disposePerplexityWorker(): Promise<void> {
  await terminateWorker()
}

/** 段落级检测详情，供改写引导使用 */
export interface SegmentDetectDetail {
  text: string
  aiScore: number
  ppl: number
  top5Rate: number
  avgProb: number
  category: AigcCategory
}

/**
 * 快速检测并返回段落级指标详情（供改写引导使用）
 * 使用整文连续计算获得基于完整上下文的可靠评分
 */
export async function getSegmentMetrics(
  text: string,
  onProgress?: (msg: string) => void,
  labModel?: LabModelOverride
): Promise<{ segments: SegmentDetectDetail[]; docScore: number }> {
  const apiConfig = resolveApiConfig()
  const useApi = apiConfig.mode === 'api'
  const detectModelId = resolveDetectModelId({
    useApi,
    apiModelName: apiConfig.modelName,
    localModelId: getActiveModelId()
  })

  const segments = segmentText(text)
  if (segments.length === 0) return { segments: [], docScore: 0 }

  const segmentBoundaries = computeSegmentBoundaries(segments, text)
  let pplResults: SegmentPPLResult[]

  if (useApi) {
    pplResults = await computePplViaLocalApi(
      text,
      segments,
      segmentBoundaries,
      apiConfig,
      onProgress
    )
  } else {
    const modelPath = await ensureModelReady()
    await ensureWorker(modelPath)
    onProgress?.('正在计算困惑度…')
    const tokenMetrics = await computeWholeInWorker(text)
    pplResults = aggregateTokensBySegments(tokenMetrics, segmentBoundaries, segments)
  }

  if (useApi && isDegenerateApiLogprobs(pplResults)) {
    const heuristicResult = runHeuristicDetect(text, segments, detectModelId)
    const details: SegmentDetectDetail[] = heuristicResult.segments.map(seg => ({
      text: seg.text,
      aiScore: seg.category === 'ai' ? 85 : seg.category === 'human' ? 20 : 55,
      ppl: 0,
      top5Rate: 0,
      avgProb: 0,
      category: seg.category
    }))
    const validScores = details.map(d => d.aiScore)
    const docScore = validScores.length > 0
      ? validScores.reduce((a, b) => a + b, 0) / validScores.length
      : 50
    return { segments: details, docScore }
  }

  const scored = classifyZhuqueSegments(segments.map((seg, i) => {
    const r = pplResults[i] ?? { id: seg.id, ppl: 0, tokenCount: 0, top5Rate: 0, avgProb: 0 }
    return scoreZhuqueSegment(seg.text, r, detectModelId)
  }), detectModelId)

  const details: SegmentDetectDetail[] = scored.map((segment, i) => {
    const r = pplResults[i]
    return {
      text: segment.text,
      aiScore: segment.score,
      ppl: r?.ppl ?? 0,
      top5Rate: r?.top5Rate ?? 0,
      avgProb: r?.avgProb ?? 0,
      category: segment.category
    }
  })

  const validScores = details.filter(d => d.ppl > 0 && d.ppl < 400).map(d => d.aiScore)
  const docScore = validScores.length > 0
    ? validScores.reduce((a, b) => a + b, 0) / validScores.length : 50

  return { segments: details, docScore }
}
