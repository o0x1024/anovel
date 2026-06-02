import { app, dialog } from 'electron'
import path from 'path'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { workDAO } from '../db'

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])
const MAX_BYTES = 5 * 1024 * 1024

function coversDir(): string {
  const dir = path.join(app.getPath('userData'), 'covers')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function coverDestPath(workId: number, ext: string): string {
  return path.join(coversDir(), `work-${workId}${ext}`)
}

function normalizeExt(fileName: string): string | null {
  const ext = path.extname(fileName).toLowerCase()
  return ALLOWED_EXT.has(ext) ? ext : null
}

export function deleteWorkCoverFile(coverPath: string | null | undefined): void {
  if (!coverPath) return
  try {
    if (existsSync(coverPath)) unlinkSync(coverPath)
  } catch {
    // ignore missing or locked files
  }
}

function persistCover(workId: number, ext: string, data: Buffer): string {
  const work = workDAO.getById(workId)
  if (!work) throw new Error('作品不存在')

  const dest = coverDestPath(workId, ext)
  deleteWorkCoverFile(work.cover_image)
  writeFileSync(dest, data)
  workDAO.update(workId, { cover_image: dest })
  return dest
}

export async function pickAndSetWorkCover(workId: number): Promise<{ success: boolean; coverPath?: string; error?: string; cancelled?: boolean }> {
  const work = workDAO.getById(workId)
  if (!work) return { success: false, error: '作品不存在' }

  const result = await dialog.showOpenDialog({
    title: '选择封面图片',
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths[0]) return { success: false, cancelled: true }

  const src = result.filePaths[0]
  const ext = normalizeExt(src)
  if (!ext) return { success: false, error: '不支持的图片格式，请使用 JPG、PNG、WebP 或 GIF' }

  const data = readFileSync(src)
  if (data.length > MAX_BYTES) return { success: false, error: '图片不能超过 5MB' }

  const dest = persistCover(workId, ext, data)
  return { success: true, coverPath: dest }
}

export function setWorkCoverFromBase64(
  workId: number,
  base64: string,
  fileName: string
): { success: boolean; coverPath?: string; error?: string } {
  const ext = normalizeExt(fileName)
  if (!ext) return { success: false, error: '不支持的图片格式，请使用 JPG、PNG、WebP 或 GIF' }

  let data: Buffer
  try {
    data = Buffer.from(base64, 'base64')
  } catch {
    return { success: false, error: '图片数据无效' }
  }
  if (data.length === 0) return { success: false, error: '图片数据为空' }
  if (data.length > MAX_BYTES) return { success: false, error: '图片不能超过 5MB' }

  try {
    const dest = persistCover(workId, ext, data)
    return { success: true, coverPath: dest }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '保存封面失败' }
  }
}

export function removeWorkCover(workId: number): { success: boolean; error?: string } {
  const work = workDAO.getById(workId)
  if (!work) return { success: false, error: '作品不存在' }
  deleteWorkCoverFile(work.cover_image)
  workDAO.update(workId, { cover_image: null })
  return { success: true }
}
