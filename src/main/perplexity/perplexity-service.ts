import { Worker } from 'worker_threads'
import path from 'path'
import type { AigcDetectResult, AigcCategory, PerplexityApiConfig } from '../../shared/aigc-detect-types'
import { ensureModelReady, isModelReady, type DownloadProgressCallback } from './model-manager'
import { resolveDetectModelId } from './constants'
import { appLogger } from '../logger/app-logger'
import { getActiveModelId } from './model-manager'
import { computeViaApi, computeWholeViaApi, isDegenerateApiLogprobs, type TokenMetric } from './api-perplexity'
import { appPreferenceDAO } from '../db'
import {
  classifyZhuqueSegments,
  computeZhuqueDistribution,
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
    throw new Error(
      `模型 ${apiConfig.modelName || detectModelId || 'unknown'} 未返回有效 logprobs，无法执行朱雀对齐检测`
    )
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
    throw new Error(
      `模型 ${apiConfig.modelName || detectModelId || 'unknown'} 未返回有效 logprobs，无法计算朱雀对齐段落指标`
    )
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
