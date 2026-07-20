import { Worker } from 'worker_threads'
import path from 'path'
import type { AigcDetectResult, AigcCategory, AigcDistribution, AigcSegment } from '../../shared/aigc-detect-types'
import { ensureModelReady, isModelReady, type DownloadProgressCallback } from './model-manager'
import { PRODUCTION_DETECT_MODEL_ID } from './constants'
import { appLogger } from '../logger/app-logger'
import {
  classifyZhuqueSegments,
  computeZhuqueSentenceDistribution,
  computeZhuqueTokenRisk,
  detectZhuqueFingerprints,
  scoreZhuqueSegment,
} from './zhuque-alignment'
import { analyzeZhuqueDistribution } from './zhuque-distribution-features'
import { categorizeZhuqueSentenceRisk } from './zhuque-rewrite-risk'
import {
  attributeTokenWindowsToSpans,
  splitZhuqueDisplaySentences,
  type ZhuqueTextSpan,
  type ZhuqueTokenWindow
} from './zhuque-token-windows'

export interface LabModelOverride {
  modelType?: string
  modelName?: string
}

interface WorkerResponse {
  type: 'ready' | 'windowResult' | 'error' | 'progress' | 'disposed'
  windows?: ZhuqueTokenWindow[]
  message?: string
  progress?: number
}

let worker: Worker | null = null
let workerReady = false
let loadedModelPath: string | null = null

// AIGC 检测和紧随其后的一键改写会使用同一篇文本。保留有限时间的窗口证据，
// 避免为了取得句级指标再次执行一整轮 4B 模型推理。
const TOKEN_WINDOW_CACHE_TTL_MS = 5 * 60 * 1000
const TOKEN_WINDOW_CACHE_MAX_METRICS = 24_000
let recentTokenWindowCache: { text: string; windows: ZhuqueTokenWindow[]; timestamp: number } | null = null

function cacheTokenWindows(text: string, windows: ZhuqueTokenWindow[]): void {
  const metricCount = windows.reduce((sum, window) => sum + (window.tokenMetrics?.length ?? 0), 0)
  if (metricCount > TOKEN_WINDOW_CACHE_MAX_METRICS) return
  recentTokenWindowCache = { text, windows, timestamp: Date.now() }
}

function getCachedTokenWindows(text: string): ZhuqueTokenWindow[] | null {
  const cached = recentTokenWindowCache
  if (!cached) return null
  if (Date.now() - cached.timestamp > TOKEN_WINDOW_CACHE_TTL_MS) {
    recentTokenWindowCache = null
    return null
  }
  return cached.text === text ? cached.windows : null
}

/**
 * 困惑度 worker 生命周期锁：模型加载、窗口计算、重建和释放必须作为一个
 * 原子序列串行执行。否则切换模型可能在 native eval/init 尚未结束时终止线程，
 * 或让多个 message handler 共享已经释放的 llama context，导致进程级崩溃。
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

async function ensureWorkerUnlocked(modelPath: string): Promise<void> {
  // If already loaded with same model, reuse
  if (worker && workerReady && loadedModelPath === modelPath) return

  // Model changed or worker not ready — rebuild
  if (worker) {
    await terminateWorkerUnlocked()
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

async function terminateWorkerUnlocked(): Promise<void> {
  const target = worker
  if (!target) return

  worker = null
  workerReady = false
  loadedModelPath = null

  const disposed = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      target.off('message', onMessage)
      target.off('error', onError)
      target.off('exit', onExit)
    }
    const onMessage = (message: WorkerResponse) => {
      if (message.type !== 'disposed') return
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onExit = () => {
      cleanup()
      resolve()
    }
    target.on('message', onMessage)
    target.once('error', onError)
    target.once('exit', onExit)
  })

  target.postMessage({ type: 'dispose' })
  await disposed
  if (target.threadId !== -1) await target.terminate()
}

function segmentText(text: string): ZhuqueTextSpan[] {
  return splitZhuqueDisplaySentences(text)
}

function segmentProbabilities(category: AigcCategory, probabilities?: AigcDistribution): AigcDistribution {
  return probabilities ?? {
    human: category === 'human' ? 100 : 0,
    suspected_ai: category === 'suspected_ai' ? 100 : 0,
    ai: category === 'ai' ? 100 : 0
  }
}

function classifySentences(
  sentences: ZhuqueTextSpan[],
  sentenceMetrics: ReturnType<typeof attributeTokenWindowsToSpans>,
  documentFeatures: ReturnType<typeof analyzeZhuqueDistribution>,
  detectModelId?: string
) {
  const scored = sentences.map((sentence, index) =>
    scoreZhuqueSegment(sentence.text, sentenceMetrics[index], detectModelId)
  )
  return classifyZhuqueSegments(scored, documentFeatures, sentences)
}

export async function runPerplexityDetect(
  text: string,
  onProgress?: (msg: string) => void,
  onDownloadProgress?: DownloadProgressCallback,
  _labModel?: LabModelOverride
): Promise<AigcDetectResult> {
  const detectModelId = PRODUCTION_DETECT_MODEL_ID

  const segments = segmentText(text)
  if (segments.length === 0) {
    return {
      segments: [{ text, category: 'human', reason: '文本过短，无法判定' }],
      distribution: { human: 100, suspected_ai: 0, ai: 0 },
      summary: '文本过短'
    }
  }

  let tokenWindows: ZhuqueTokenWindow[]
  let uniqueTokenCount = 0

  onProgress?.('正在准备固定版本 Qwen3.5 4B 检测模型…')
  const modelPath = await ensureModelReady(onDownloadProgress, PRODUCTION_DETECT_MODEL_ID)

  onProgress?.('正在加载模型…')
  onProgress?.('正在建立重叠 token 证据窗口…')
  tokenWindows = await computeWindowsWithModel(modelPath, text, onProgress)
  cacheTokenWindows(text, tokenWindows)
  uniqueTokenCount = Math.max(...tokenWindows.map(window => window.endToken), 0)

  if (tokenWindows.length === 0) {
    throw new Error('模型没有生成可用的 token 证据窗口')
  }

  // 过滤有效结果
  const validResults = tokenWindows.map(window => window.metric)
    .filter(metric => metric.ppl > 0 && metric.ppl < 400 && metric.tokenCount >= 2)
  const pplValues = validResults.map(r => r.ppl)
  const top5Values = validResults.map(r => r.top5Rate)

  const avgPPL = pplValues.length > 0
    ? pplValues.reduce((a, b) => a + b, 0) / pplValues.length : 100
  const avgTop5 = top5Values.length > 0
    ? top5Values.reduce((a, b) => a + b, 0) / top5Values.length : 0.4

  const zeroCount = tokenWindows.filter(window => window.metric.ppl === 0).length
  appLogger.info('perplexity', `PPL统计: 句子数=${segments.length}, token窗=${tokenWindows.length}, 有效窗=${validResults.length}, 零值=${zeroCount}, 唯一tokens=${uniqueTokenCount}, 平均PPL=${avgPPL.toFixed(2)}, 平均Top5=${(avgTop5 * 100).toFixed(1)}%`)

  const sortedPPL = [...pplValues].sort((a, b) => a - b)
  const p25 = sortedPPL[Math.floor(sortedPPL.length * 0.25)] || avgPPL
  const p50 = sortedPPL[Math.floor(sortedPPL.length * 0.5)] || avgPPL
  const p75 = sortedPPL[Math.floor(sortedPPL.length * 0.75)] || avgPPL

  appLogger.info('perplexity', `PPL分布: min=${sortedPPL[0]?.toFixed(2)}, p25=${p25.toFixed(2)}, median=${p50.toFixed(2)}, p75=${p75.toFixed(2)}, max=${sortedPPL[sortedPPL.length - 1]?.toFixed(2)}`)

  const sampleDetails = tokenWindows.slice(0, 10).map(({ metric: r }, i) =>
    `[${i}]PPL=${r.ppl.toFixed(1)},T5=${(r.top5Rate * 100).toFixed(0)}%,tc=${r.tokenCount}`
  ).join(', ')
  appLogger.info('perplexity', `token窗口明细(前10): ${sampleDetails}`)

  const documentFeatures = analyzeZhuqueDistribution(text, tokenWindows)
  const sentenceMetrics = attributeTokenWindowsToSpans(segments, tokenWindows)
  const classifiedSentences = classifySentences(segments, sentenceMetrics, documentFeatures, detectModelId)
  const displaySentences = classifiedSentences.map(segment => {
    const riskScore = continuousSentenceRisk(segment.score, documentFeatures.documentRisk)
    const category = categorizeZhuqueSentenceRisk(riskScore)
    return { ...segment, category, probabilities: undefined, riskScore }
  })
  const distribution = computeZhuqueSentenceDistribution(displaySentences)
  const resultSegments: AigcSegment[] = displaySentences.map(segment => ({
    text: segment.text,
    category: segment.category,
    riskScore: segment.riskScore,
    reason: segment.reason,
    probabilities: segmentProbabilities(segment.category)
  }))
  const validScores = classifiedSentences
    .filter((_, i) => sentenceMetrics[i].tokenCount >= 2)
    .map(segment => segment.score)
  const rawDocScore = validScores.length > 0
    ? validScores.reduce((a, b) => a + b, 0) / validScores.length
    : 50
  const tokenPredictability = Math.round(
    medianScore(classifiedSentences.map(segment =>
      segment.score - segment.evidence.penalty + segment.evidence.styleReduction
    )) * 10
  ) / 10
  const documentFingerprints = detectZhuqueFingerprints(text)
  const fingerprintHits = documentFingerprints.filmShot + documentFingerprints.connector + documentFingerprints.emotionTemplate + documentFingerprints.summaryClosure
  appLogger.info('perplexity', '朱雀对齐检测', {
    modelId: detectModelId,
    sentenceCount: segments.length,
    tokenWindowCount: tokenWindows.length,
    avgScore: Math.round(rawDocScore * 10) / 10,
    documentFeatures, fingerprintHits, distribution
  })
  const summary = `逐句文本覆盖率：人工 ${distribution.human}%，疑似AI ${distribution.suspected_ai}%，AI特征 ${distribution.ai}%`

  return {
    segments: resultSegments,
    distribution,
    summary,
    diagnostics: {
      statisticalModelId: detectModelId,
      policyVersion: 'aigc-fusion-v1',
      tokenPredictability,
      sequenceRegularity: documentFeatures.sequenceRegularity,
      informationUniformity: documentFeatures.informationUniformity,
      causalClosure: documentFeatures.causalClosure,
      voiceStability: documentFeatures.voiceStability,
      templateDensity: documentFeatures.templateDensity,
      windowRiskP75: documentFeatures.windowRiskP75,
      peakWindowRisk: documentFeatures.peakWindowRisk,
      highRiskWindowShare: documentFeatures.highRiskWindowShare,
      documentRisk: documentFeatures.documentRisk,
      reasons: documentFeatures.reasons
    }
  }
}

function medianScore(values: number[]): number {
  if (values.length === 0) return 50
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle]
}

function continuousSentenceRisk(tokenAndFingerprintRisk: number, documentRisk: number): number {
  return Math.round((tokenAndFingerprintRisk * 0.75 + documentRisk * 0.25) * 10) / 10
}

function weightedSentenceRisk(
  segments: Array<{ text: string; score: number }>,
  documentRisk: number
): number {
  let weighted = 0
  let total = 0
  for (const segment of segments) {
    const weight = Math.max(1, segment.text.replace(/\s/g, '').length)
    weighted += continuousSentenceRisk(segment.score, documentRisk) * weight
    total += weight
  }
  return total > 0 ? Math.round(weighted / total * 10) / 10 : 0
}

function computeWindowsInWorkerUnlocked(
  text: string,
  onProgress?: (message: string) => void
): Promise<ZhuqueTokenWindow[]> {
  return new Promise<ZhuqueTokenWindow[]>((resolve, reject) => {
    if (!worker) {
      reject(new Error('工作线程未就绪'))
      return
    }
    const handler = (msg: WorkerResponse) => {
      if (msg.type === 'progress') {
        if (msg.message) onProgress?.(msg.message)
      } else if (msg.type === 'windowResult' && msg.windows) {
        worker?.off('message', handler)
        resolve(msg.windows)
      } else if (msg.type === 'error') {
        worker?.off('message', handler)
        reject(new Error(msg.message || '窗口计算失败'))
      }
    }
    worker.on('message', handler)
    worker.postMessage({ type: 'computeWindows', text })
  })
}

function computeWindowsWithModel(
  modelPath: string,
  text: string,
  onProgress?: (message: string) => void
): Promise<ZhuqueTokenWindow[]> {
  return withWorkerLock(async () => {
    await ensureWorkerUnlocked(modelPath)
    let windows = await computeWindowsInWorkerUnlocked(text, onProgress)
    if (windows.length === 0 && text.trim().length > 20) {
      appLogger.info('perplexity', '窗口计算无结果，重建 worker 重试…')
      await terminateWorkerUnlocked()
      await ensureWorkerUnlocked(modelPath)
      windows = await computeWindowsInWorkerUnlocked(text, onProgress)
    }
    return windows
  })
}

export function isPerplexityModelReady(): boolean {
  return isModelReady(PRODUCTION_DETECT_MODEL_ID)
}

export async function disposePerplexityWorker(): Promise<void> {
  await withWorkerLock(() => terminateWorkerUnlocked())
}

/** 句级检测详情，供逐句改写引导使用。 */
export interface SegmentDetectDetail {
  text: string
  /** 三分类融合后的改写优先级；不再等同于原始 token 分。 */
  aiScore: number
  tokenScore: number
  structuralRisk: number
  ppl: number
  top5Rate: number
  avgProb: number
  category: AigcCategory
  probabilities: AigcDistribution
  reason: string
}

/**
 * 返回句级指标详情：检测在重叠 token 窗完成，随后把窗口概率归因到句子。
 */
export async function getSegmentMetrics(
  text: string,
  onProgress?: (msg: string) => void,
  _labModel?: LabModelOverride
): Promise<{ segments: SegmentDetectDetail[]; docScore: number }> {
  const detectModelId = PRODUCTION_DETECT_MODEL_ID

  const segments = segmentText(text)
  if (segments.length === 0) return { segments: [], docScore: 0 }

  let tokenWindows: ZhuqueTokenWindow[]

  const cachedWindows = getCachedTokenWindows(text)
  if (cachedWindows) {
    onProgress?.('复用本次检测的重叠 token 证据窗口…')
    tokenWindows = cachedWindows
  } else {
    const modelPath = await ensureModelReady(undefined, PRODUCTION_DETECT_MODEL_ID)
    onProgress?.('正在按回车分段计算 Qwen3.5 4B 证据…')
    tokenWindows = await computeParagraphWindows(modelPath, segments, onProgress)
    cacheTokenWindows(text, tokenWindows)
  }

  if (tokenWindows.length === 0) {
    throw new Error('模型没有生成可用的 token 证据窗口')
  }
  const sentenceMetrics = attributeTokenWindowsToSpans(segments, tokenWindows)


  const documentFeatures = analyzeZhuqueDistribution(text, tokenWindows)
  const classifiedSentences = classifySentences(
    segments,
    sentenceMetrics,
    documentFeatures,
    detectModelId
  )

  const details: SegmentDetectDetail[] = classifiedSentences.map((segment, i) => {
    const metric = sentenceMetrics[i]
    const aiScore = continuousSentenceRisk(segment.score, documentFeatures.documentRisk)
    const category = categorizeZhuqueSentenceRisk(aiScore)
    const probabilities = segmentProbabilities(category)
    return {
      text: segment.text,
      aiScore,
      tokenScore: computeZhuqueTokenRisk(metric, detectModelId),
      structuralRisk: Math.round((100 - probabilities.human) * 10) / 10,
      ppl: metric.ppl,
      top5Rate: metric.top5Rate,
      avgProb: metric.avgProb,
      category,
      probabilities,
      reason: segment.reason ?? ''
    }
  })

  const docScore = weightedSentenceRisk(classifiedSentences, documentFeatures.documentRisk)

  return { segments: details, docScore }
}
