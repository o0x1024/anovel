import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import axios from 'axios'
import crypto from 'crypto'
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

interface VerifiedModelManifest {
  modelId: string
  filename: string
  sizeBytes: number
  mtimeMs: number
  sha256: string
}

function verifiedManifestPath(userDataPath: string, modelId: string): string {
  return path.join(getModelDir(userDataPath, modelId), 'verified.json')
}

function readVerifiedManifest(userDataPath: string, modelId: string): VerifiedModelManifest | null {
  try {
    return JSON.parse(fs.readFileSync(verifiedManifestPath(userDataPath, modelId), 'utf8')) as VerifiedModelManifest
  } catch {
    return null
  }
}

function modelArtifactReady(userDataPath: string, def: PerplexityModelDef): boolean {
  const modelPath = getModelFilePath(userDataPath, def.id)
  if (!fs.existsSync(modelPath)) return false
  const stat = fs.statSync(modelPath)
  if (stat.size !== def.sizeBytes) return false
  if (!def.sha256) return true
  const manifest = readVerifiedManifest(userDataPath, def.id)
  return manifest?.modelId === def.id &&
    manifest.filename === def.filename &&
    manifest.sizeBytes === stat.size &&
    manifest.mtimeMs === stat.mtimeMs &&
    manifest.sha256 === def.sha256
}

async function sha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  return hash.digest('hex')
}

async function verifyModelArtifact(
  userDataPath: string,
  def: PerplexityModelDef,
  modelPath: string
): Promise<void> {
  if (!fs.existsSync(modelPath)) throw new Error(`缺少模型文件 ${def.filename}`)
  const stat = fs.statSync(modelPath)
  if (stat.size !== def.sizeBytes) {
    throw new Error(`${def.filename} 大小校验失败：${stat.size}/${def.sizeBytes}`)
  }
  const actualHash = def.sha256 ? await sha256(modelPath) : ''
  if (def.sha256 && actualHash !== def.sha256) {
    throw new Error(`${def.filename} SHA-256 校验失败，文件可能损坏或来源已变化`)
  }
  if (def.sha256) {
    const manifest: VerifiedModelManifest = {
      modelId: def.id,
      filename: def.filename,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: actualHash
    }
    fs.writeFileSync(verifiedManifestPath(userDataPath, def.id), JSON.stringify(manifest, null, 2), 'utf8')
  }
}

function loadActiveModelId(): string {
  if (activeModelId) return activeModelId
  try {
    const saved = appPreferenceDAO.getPreference(ACTIVE_MODEL_PREF_KEY)
    if (saved && PERPLEXITY_MODELS.some(m => m.id === saved)) {
      activeModelId = saved
      return saved
    }
    if (saved) {
      appPreferenceDAO.setPreference(ACTIVE_MODEL_PREF_KEY, DEFAULT_MODEL_ID)
      appLogger.info('perplexity', `已移除检测模型 ${saved}，切换为 ${DEFAULT_MODEL_ID}`)
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
  return modelArtifactReady(app.getPath('userData'), def)
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

  // 兼容升级前已完整下载但尚无验证清单的正式模型：首次使用时补做一次摘要校验。
  if (fs.existsSync(modelPath) && fs.statSync(modelPath).size === def.sizeBytes) {
    onProgress?.({
      phase: 'checking',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: def.sizeBytes,
      message: `正在校验 ${def.name} 完整性…`
    })
    try {
      await verifyModelArtifact(userDataPath, def, modelPath)
      return modelPath
    } catch (error) {
      appLogger.warn(
        'perplexity',
        `模型完整性校验失败，将重新下载: ${error instanceof Error ? error.message : String(error)}`
      )
      fs.unlinkSync(modelPath)
      const manifestPath = verifiedManifestPath(userDataPath, def.id)
      if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath)
    }
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
    if (stat.size < def.sizeBytes) {
      startByte = stat.size
    } else {
      fs.unlinkSync(tempPath)
    }
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

  const resumed = startByte > 0 && response.status === 206
  if (startByte > 0 && !resumed) {
    appLogger.warn('perplexity', '下载源未接受断点续传，将从头下载模型')
    startByte = 0
  }
  const totalBytes = def.sizeBytes
  let downloadedBytes = startByte

  const writer = fs.createWriteStream(tempPath, { flags: resumed ? 'a' : 'w' })

  return new Promise<void>((resolve, reject) => {
    const stream = response.data as NodeJS.ReadableStream

    stream.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length
      writer.write(chunk)
      const percent = Math.min(99, Math.floor((downloadedBytes / totalBytes) * 100))
      onProgress?.({
        phase: 'downloading',
        percent,
        downloadedBytes,
        totalBytes,
        message: `正在下载 ${def.name}… ${percent}%`
      })
    })

    stream.on('end', () => {
      writer.end(async () => {
        try {
          await verifyModelArtifact(userDataPath, def, tempPath)
          fs.renameSync(tempPath, modelPath)
          // rename 会改变路径但不改变 mtime；以最终路径重写清单，便于后续精确命中。
          await verifyModelArtifact(userDataPath, def, modelPath)
          appLogger.info('perplexity', `模型下载并校验完成: ${def.name} → ${modelPath}`)
          onProgress?.({
            phase: 'ready',
            percent: 100,
            downloadedBytes: def.sizeBytes,
            totalBytes: def.sizeBytes,
            message: '模型下载并校验完成'
          })
          resolve()
        } catch (error) {
          if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
          reject(error instanceof Error ? error : new Error(String(error)))
        }
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
      ready = modelArtifactReady(userDataPath, def)
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
  const manifestPath = verifiedManifestPath(userDataPath, modelId)
  if (fs.existsSync(modelPath)) fs.unlinkSync(modelPath)
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath)

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
