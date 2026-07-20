import path from 'path'
import { Worker } from 'worker_threads'
import type { AigcSegment } from '../../shared/aigc-detect-types'
import type { DownloadProgressCallback } from '../perplexity/model-manager'
import { appLogger } from '../logger/app-logger'
import { ensureSupervisedAigcModelReady } from './model-manager'
import { buildSupervisedTextWindows } from './text-windows'

export interface SupervisedAigcSegmentScore {
  text: string
  humanProbability: number
  aiProbability: number
}

export interface SupervisedAigcResult {
  modelId: 'aigc-detector-zh-v3-int8'
  segments: SupervisedAigcSegmentScore[]
  documentAiProbability: number
  windowCount: number
}

interface WorkerMessage {
  type: 'ready' | 'result' | 'error'
  requestId?: number
  scores?: Array<{ human: number; ai: number; tokenCount: number }>
  message?: string
}

let worker: Worker | null = null
let workerReady: Promise<void> | null = null
let requestId = 0
let inferenceChain: Promise<unknown> = Promise.resolve()

function workerPath(): string {
  return path.join(__dirname, 'supervised-aigc-worker.js')
}

async function ensureWorker(modelPath: string, tokenizerPath: string): Promise<void> {
  if (worker && workerReady) return workerReady
  worker = new Worker(workerPath(), { workerData: { modelPath, tokenizerPath } })
  const readiness = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('中文监督模型加载超时（60秒）')), 60_000)
    const onMessage = (message: WorkerMessage) => {
      if (message.type === 'ready') {
        clearTimeout(timeout)
        worker?.off('message', onMessage)
        resolve()
      } else if (message.type === 'error' && message.requestId === 0) {
        clearTimeout(timeout)
        worker?.off('message', onMessage)
        reject(new Error(message.message || '中文监督模型加载失败'))
      }
    }
    worker?.on('message', onMessage)
    worker?.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    worker?.once('exit', () => {
      worker = null
      workerReady = null
    })
  })
  workerReady = readiness
  try {
    await readiness
  } catch (error) {
    if (worker) await worker.terminate()
    worker = null
    workerReady = null
    throw error
  }
}

function locateSegments(text: string, segments: Pick<AigcSegment, 'text'>[]) {
  let cursor = 0
  return segments.map(segment => {
    const found = text.indexOf(segment.text, cursor)
    const start = found >= 0 ? found : cursor
    const end = Math.min(text.length, start + segment.text.length)
    cursor = end
    return { start, end }
  })
}

function inferWindows(texts: string[]): Promise<Array<{ human: number; ai: number; tokenCount: number }>> {
  const currentId = ++requestId
  return new Promise((resolve, reject) => {
    const onMessage = (message: WorkerMessage) => {
      if (message.requestId !== currentId) return
      worker?.off('message', onMessage)
      if (message.type === 'result' && message.scores) resolve(message.scores)
      else reject(new Error(message.message || '中文监督模型推理失败'))
    }
    worker?.on('message', onMessage)
    worker?.postMessage({ type: 'detect', requestId: currentId, texts })
  })
}

export async function runSupervisedAigcDetect(
  text: string,
  segments: Pick<AigcSegment, 'text'>[],
  onProgress?: (message: string) => void,
  onDownloadProgress?: DownloadProgressCallback
): Promise<SupervisedAigcResult> {
  const execute = async () => {
    onProgress?.('正在准备中文监督检测模型…')
    const paths = await ensureSupervisedAigcModelReady(onDownloadProgress)
    await ensureWorker(paths.modelPath, paths.tokenizerPath)
    const windows = buildSupervisedTextWindows(text)
    onProgress?.(`正在执行中文监督检测… 0/${windows.length}`)
    const scores = await inferWindows(windows.map(window => window.text))
    const locations = locateSegments(text, segments)
    const segmentScores = segments.map((segment, index) => {
      const location = locations[index]
      let weightedAi = 0
      let totalWeight = 0
      windows.forEach((window, windowIndex) => {
        const overlap = Math.max(0, Math.min(location.end, window.end) - Math.max(location.start, window.start))
        if (overlap > 0) {
          weightedAi += scores[windowIndex].ai * overlap
          totalWeight += overlap
        }
      })
      const aiProbability = totalWeight > 0 ? weightedAi / totalWeight : 0.5
      return { text: segment.text, aiProbability, humanProbability: 1 - aiProbability }
    })
    const weightedDocument = segmentScores.reduce((sum, score) => sum + score.aiProbability * Math.max(1, score.text.length), 0)
    const documentChars = segmentScores.reduce((sum, score) => sum + Math.max(1, score.text.length), 0)
    const documentAiProbability = weightedDocument / Math.max(1, documentChars)
    appLogger.info('supervised-aigc', '中文监督检测完成', {
      windowCount: windows.length,
      segmentCount: segmentScores.length,
      documentAiProbability: Math.round(documentAiProbability * 1000) / 1000
    })
    onProgress?.(`中文监督检测完成：AI证据 ${(documentAiProbability * 100).toFixed(1)}%`)
    return {
      modelId: 'aigc-detector-zh-v3-int8' as const,
      segments: segmentScores,
      documentAiProbability,
      windowCount: windows.length
    }
  }
  const run = inferenceChain.then(execute, execute)
  inferenceChain = run.then(() => undefined, () => undefined)
  return run
}

export async function disposeSupervisedAigcWorker(): Promise<void> {
  if (worker) await worker.terminate()
  worker = null
  workerReady = null
}
