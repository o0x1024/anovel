import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import axios from 'axios'
import {
  PERPLEXITY_MODELS,
  DEFAULT_MODEL_ID,
  getModelDef,
  getModelDir,
  getModelFilePath,
  type PerplexityModelDef
} from './constants'
import { appLogger } from '../logger/app-logger'
import { appPreferenceDAO } from '../db/dao/app-preference-dao'

export type DownloadProgressCallback = (progress: {
  phase: 'checking' | 'downloading' | 'ready' | 'error'
  percent: number
  downloadedBytes: number
  totalBytes: number
  message: string
}) => void

const ACTIVE_MODEL_PREF_KEY = 'perplexity_active_model'

let downloadInProgress = false
let activeModelId: string | null = null

function loadActiveModelId(): string {
  if (activeModelId) return activeModelId
  try {
    const saved = appPreferenceDAO.getPreference(ACTIVE_MODEL_PREF_KEY)
    if (saved && PERPLEXITY_MODELS.some(m => m.id === saved)) {
      activeModelId = saved
      return saved
    }
  } catch { /* DB not ready yet, use default */ }
  activeModelId = DEFAULT_MODEL_ID
  return activeModelId
}

export function getActiveModelId(): string {
  return loadActiveModelId()
}

export function isModelReady(modelId?: string): boolean {
  const id = modelId || loadActiveModelId()
  const def = getModelDef(id)
  const modelPath = getModelFilePath(app.getPath('userData'), id)
  if (!fs.existsSync(modelPath)) return false
  const stat = fs.statSync(modelPath)
  // 文件大于声明大小的 50% 即视为有效（声明大小可能偏大，实际以下载完成为准）
  return stat.size > def.sizeBytes * 0.5 && stat.size > 10_000_000
}

export async function ensureModelReady(
  onProgress?: DownloadProgressCallback,
  modelId?: string
): Promise<string> {
  const id = modelId || loadActiveModelId()
  const def = getModelDef(id)
  const userDataPath = app.getPath('userData')
  const modelPath = getModelFilePath(userDataPath, id)

  onProgress?.({
    phase: 'checking',
    percent: 0,
    downloadedBytes: 0,
    totalBytes: def.sizeBytes,
    message: '正在检查模型文件…'
  })

  if (isModelReady(id)) {
    onProgress?.({
      phase: 'ready',
      percent: 100,
      downloadedBytes: def.sizeBytes,
      totalBytes: def.sizeBytes,
      message: '模型已就绪'
    })
    return modelPath
  }

  if (downloadInProgress) {
    throw new Error('模型正在下载中，请稍候')
  }

  downloadInProgress = true
  try {
    await downloadModel(def, userDataPath, onProgress)
    return modelPath
  } finally {
    downloadInProgress = false
  }
}

async function downloadModel(
  def: PerplexityModelDef,
  userDataPath: string,
  onProgress?: DownloadProgressCallback
): Promise<void> {
  const modelDir = getModelDir(userDataPath, def.id)
  const modelPath = getModelFilePath(userDataPath, def.id)
  const tempPath = modelPath + '.downloading'

  fs.mkdirSync(modelDir, { recursive: true })

  let startByte = 0
  if (fs.existsSync(tempPath)) {
    const stat = fs.statSync(tempPath)
    startByte = stat.size
  }

  appLogger.info('perplexity', `开始下载模型: ${def.name} (${def.url}), 起始字节: ${startByte}`)

  onProgress?.({
    phase: 'downloading',
    percent: startByte > 0 ? Math.floor((startByte / def.sizeBytes) * 100) : 0,
    downloadedBytes: startByte,
    totalBytes: def.sizeBytes,
    message: startByte > 0 ? '正在续传下载…' : `正在下载 ${def.name}（约${Math.round(def.sizeBytes / 1e8) / 10}GB）…`
  })

  const headers: Record<string, string> = {}
  if (startByte > 0) {
    headers['Range'] = `bytes=${startByte}-`
  }

  const response = await axios.get(def.url, {
    responseType: 'stream',
    headers,
    timeout: 30000
  })

  const totalBytes = startByte + parseInt(String(response.headers['content-length'] || '0'), 10)
  let downloadedBytes = startByte

  const writer = fs.createWriteStream(tempPath, { flags: startByte > 0 ? 'a' : 'w' })

  return new Promise<void>((resolve, reject) => {
    const stream = response.data as NodeJS.ReadableStream

    stream.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length
      writer.write(chunk)
      const percent = Math.floor((downloadedBytes / totalBytes) * 100)
      onProgress?.({
        phase: 'downloading',
        percent,
        downloadedBytes,
        totalBytes,
        message: `正在下载 ${def.name}… ${percent}%`
      })
    })

    stream.on('end', () => {
      writer.end(() => {
        fs.renameSync(tempPath, modelPath)
        appLogger.info('perplexity', `模型下载完成: ${def.name} → ${modelPath}`)
        onProgress?.({
          phase: 'ready',
          percent: 100,
          downloadedBytes: totalBytes,
          totalBytes,
          message: '模型下载完成'
        })
        resolve()
      })
    })

    stream.on('error', (err: Error) => {
      writer.end()
      appLogger.error('perplexity', `模型下载失败: ${err.message}`)
      onProgress?.({
        phase: 'error',
        percent: Math.floor((downloadedBytes / totalBytes) * 100),
        downloadedBytes,
        totalBytes,
        message: `下载失败: ${err.message}`
      })
      reject(new Error(`模型下载失败: ${err.message}`))
    })
  })
}

export interface ModelInfo {
  id: string
  name: string
  description: string
  sizeBytes: number
  ready: boolean
  active: boolean
  localSizeBytes: number
}

export function listModels(): ModelInfo[] {
  const userDataPath = app.getPath('userData')
  return PERPLEXITY_MODELS.map(def => {
    const modelPath = getModelFilePath(userDataPath, def.id)
    let localSizeBytes = 0
    let ready = false
    if (fs.existsSync(modelPath)) {
      localSizeBytes = fs.statSync(modelPath).size
      ready = localSizeBytes > def.sizeBytes * 0.5 && localSizeBytes > 10_000_000
    }
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      sizeBytes: def.sizeBytes,
      ready,
      active: def.id === loadActiveModelId(),
      localSizeBytes
    }
  })
}

export function switchModel(modelId: string): { success: boolean; needsReload: boolean } {
  const def = PERPLEXITY_MODELS.find(m => m.id === modelId)
  if (!def) return { success: false, needsReload: false }

  const currentId = loadActiveModelId()
  const changed = currentId !== modelId
  activeModelId = modelId
  try {
    appPreferenceDAO.setPreference(ACTIVE_MODEL_PREF_KEY, modelId)
  } catch { /* ignore if DB not ready */ }
  appLogger.info('perplexity', `切换检测模型: ${def.name}`)
  return { success: true, needsReload: changed }
}

export function deleteModelById(modelId: string): void {
  const userDataPath = app.getPath('userData')
  const modelPath = getModelFilePath(userDataPath, modelId)
  const tempPath = modelPath + '.downloading'
  if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath)
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)

  const dir = getModelDir(userDataPath, modelId)
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
    fs.rmdirSync(dir)
  }
  appLogger.info('perplexity', `模型已删除: ${modelId}`)
}

export function deleteModel(): void {
  deleteModelById(loadActiveModelId())
}

export function getModelStatus(): { ready: boolean; sizeBytes: number; path: string } {
  const id = loadActiveModelId()
  const modelPath = getModelFilePath(app.getPath('userData'), id)
  const ready = isModelReady(id)
  let sizeBytes = 0
  if (fs.existsSync(modelPath)) {
    sizeBytes = fs.statSync(modelPath).size
  }
  return { ready, sizeBytes, path: modelPath }
}
