import { app } from 'electron'
import axios from 'axios'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Transform } from 'stream'
import type { DownloadProgressCallback } from '../perplexity/model-manager'
import { appLogger } from '../logger/app-logger'
import {
  SUPERVISED_AIGC_MODEL,
  getSupervisedAigcModelDir,
  getSupervisedAigcModelPath,
  getSupervisedAigcTokenizerPath
} from './constants'

type Artifact = typeof SUPERVISED_AIGC_MODEL.model | typeof SUPERVISED_AIGC_MODEL.tokenizer

interface VerifiedManifest {
  revision: string
  files: Record<string, { sizeBytes: number; mtimeMs: number; sha256: string }>
}

let downloadPromise: Promise<{ modelPath: string; tokenizerPath: string }> | null = null

function manifestPath(userDataPath: string): string {
  return path.join(getSupervisedAigcModelDir(userDataPath), 'verified.json')
}

function readManifest(userDataPath: string): VerifiedManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(userDataPath), 'utf8')) as VerifiedManifest
    return parsed.revision === SUPERVISED_AIGC_MODEL.revision ? parsed : null
  } catch {
    return null
  }
}

function artifactReady(filePath: string, artifact: Artifact, manifest: VerifiedManifest | null): boolean {
  if (!fs.existsSync(filePath)) return false
  const stat = fs.statSync(filePath)
  const verified = manifest?.files[artifact.filename]
  return stat.size === artifact.sizeBytes &&
    verified?.sizeBytes === stat.size &&
    verified.mtimeMs === stat.mtimeMs &&
    verified.sha256 === artifact.sha256
}

export function isSupervisedAigcModelReady(): boolean {
  const userDataPath = app.getPath('userData')
  const manifest = readManifest(userDataPath)
  return artifactReady(getSupervisedAigcModelPath(userDataPath), SUPERVISED_AIGC_MODEL.model, manifest) &&
    artifactReady(getSupervisedAigcTokenizerPath(userDataPath), SUPERVISED_AIGC_MODEL.tokenizer, manifest)
}

export function getSupervisedAigcModelInfo() {
  const userDataPath = app.getPath('userData')
  const modelPath = getSupervisedAigcModelPath(userDataPath)
  return {
    id: SUPERVISED_AIGC_MODEL.id,
    name: SUPERVISED_AIGC_MODEL.name,
    description: SUPERVISED_AIGC_MODEL.description,
    sizeBytes: SUPERVISED_AIGC_MODEL.model.sizeBytes + SUPERVISED_AIGC_MODEL.tokenizer.sizeBytes,
    ready: isSupervisedAigcModelReady(),
    localSizeBytes: fs.existsSync(modelPath) ? fs.statSync(modelPath).size : 0,
    sourceModel: SUPERVISED_AIGC_MODEL.sourceModel
  }
}

async function sha256(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  await pipeline(fs.createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function verifyArtifact(filePath: string, artifact: Artifact): Promise<void> {
  if (!fs.existsSync(filePath)) throw new Error(`缺少模型文件 ${artifact.filename}`)
  const stat = fs.statSync(filePath)
  if (stat.size !== artifact.sizeBytes) {
    throw new Error(`${artifact.filename} 大小校验失败：${stat.size}/${artifact.sizeBytes}`)
  }
  const actualHash = await sha256(filePath)
  if (actualHash !== artifact.sha256) {
    throw new Error(`${artifact.filename} SHA-256 校验失败，文件可能损坏或来源已变化`)
  }
}

async function downloadArtifact(
  targetPath: string,
  artifact: Artifact,
  completedBefore: number,
  totalBytes: number,
  onProgress?: DownloadProgressCallback
): Promise<void> {
  const tempPath = `${targetPath}.downloading`
  let startByte = fs.existsSync(tempPath) ? fs.statSync(tempPath).size : 0
  if (startByte === artifact.sizeBytes) {
    try {
      await verifyArtifact(tempPath, artifact)
      fs.renameSync(tempPath, targetPath)
      return
    } catch {
      fs.unlinkSync(tempPath)
      startByte = 0
    }
  }
  if (startByte > artifact.sizeBytes) {
    fs.truncateSync(tempPath, 0)
    startByte = 0
  }
  const headers = startByte > 0 ? { Range: `bytes=${startByte}-` } : undefined
  const response = await axios.get(artifact.url, {
    responseType: 'stream',
    headers,
    timeout: 30_000,
    maxRedirects: 8
  })
  const resumed = startByte > 0 && response.status === 206
  if (startByte > 0 && !resumed) startByte = 0
  let artifactDownloaded = startByte
  const progressStream = new Transform({
    transform(chunk, _encoding, callback) {
      artifactDownloaded += chunk.length
      const downloadedBytes = completedBefore + artifactDownloaded
      const percent = Math.min(99, Math.floor(downloadedBytes / totalBytes * 100))
      onProgress?.({
        phase: 'downloading',
        percent,
        downloadedBytes,
        totalBytes,
        message: `正在下载中文检测模型… ${percent}%`
      })
      callback(null, chunk)
    }
  })
  await pipeline(
    response.data as NodeJS.ReadableStream,
    progressStream,
    fs.createWriteStream(tempPath, { flags: resumed ? 'a' : 'w' })
  )
  try {
    await verifyArtifact(tempPath, artifact)
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
    throw error
  }
  fs.renameSync(tempPath, targetPath)
}

async function prepareModel(onProgress?: DownloadProgressCallback) {
  const userDataPath = app.getPath('userData')
  const directory = getSupervisedAigcModelDir(userDataPath)
  const modelPath = getSupervisedAigcModelPath(userDataPath)
  const tokenizerPath = getSupervisedAigcTokenizerPath(userDataPath)
  fs.mkdirSync(directory, { recursive: true })
  const artifacts: Array<{ path: string; artifact: Artifact }> = [
    { path: tokenizerPath, artifact: SUPERVISED_AIGC_MODEL.tokenizer },
    { path: modelPath, artifact: SUPERVISED_AIGC_MODEL.model }
  ]
  const totalBytes = artifacts.reduce((sum, item) => sum + item.artifact.sizeBytes, 0)
  onProgress?.({ phase: 'checking', percent: 0, downloadedBytes: 0, totalBytes, message: '正在校验中文监督检测模型…' })

  let completed = 0
  for (const item of artifacts) {
    let valid = false
    try {
      await verifyArtifact(item.path, item.artifact)
      valid = true
    } catch {
      valid = false
    }
    if (!valid) {
      appLogger.info('supervised-aigc', `下载模型工件: ${item.artifact.filename}`)
      await downloadArtifact(item.path, item.artifact, completed, totalBytes, onProgress)
    }
    completed += item.artifact.sizeBytes
  }

  const manifest: VerifiedManifest = { revision: SUPERVISED_AIGC_MODEL.revision, files: {} }
  for (const item of artifacts) {
    const stat = fs.statSync(item.path)
    manifest.files[item.artifact.filename] = {
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      sha256: item.artifact.sha256
    }
  }
  fs.writeFileSync(manifestPath(userDataPath), JSON.stringify(manifest, null, 2), 'utf8')
  onProgress?.({ phase: 'ready', percent: 100, downloadedBytes: totalBytes, totalBytes, message: '中文监督检测模型已就绪' })
  return { modelPath, tokenizerPath }
}

export async function ensureSupervisedAigcModelReady(onProgress?: DownloadProgressCallback) {
  if (isSupervisedAigcModelReady()) {
    const userDataPath = app.getPath('userData')
    return {
      modelPath: getSupervisedAigcModelPath(userDataPath),
      tokenizerPath: getSupervisedAigcTokenizerPath(userDataPath)
    }
  }
  if (!downloadPromise) {
    downloadPromise = prepareModel(onProgress).finally(() => { downloadPromise = null })
  }
  return downloadPromise
}

export function deleteSupervisedAigcModel(): void {
  const directory = getSupervisedAigcModelDir(app.getPath('userData'))
  for (const filename of [
    SUPERVISED_AIGC_MODEL.model.filename,
    SUPERVISED_AIGC_MODEL.tokenizer.filename,
    `${SUPERVISED_AIGC_MODEL.model.filename}.downloading`,
    `${SUPERVISED_AIGC_MODEL.tokenizer.filename}.downloading`,
    'verified.json'
  ]) {
    const filePath = path.join(directory, filename)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
}
