import { toLocalFileUrl } from '../../../shared/local-file-url'

const IMAGE_EXT = /\.(jpe?g|png|webp|gif)$/i

export function isWorkCoverFile(file: File): boolean {
  return /^image\/(jpeg|png|webp|gif)/i.test(file.type) || IMAGE_EXT.test(file.name)
}

export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

export function workCoverSrc(coverPath: string | null | undefined): string | null {
  return toLocalFileUrl(coverPath)
}

export async function setWorkCoverFromFile(workId: number, file: File): Promise<string> {
  if (!isWorkCoverFile(file)) {
    throw new Error('请选择 JPG、PNG、WebP 或 GIF 图片')
  }
  const base64 = await fileToBase64(file)
  const result = await window.anovel.invoke('work:setCoverFromBase64', workId, base64, file.name) as {
    success: boolean
    coverPath?: string
    error?: string
  }
  if (!result.success || !result.coverPath) {
    throw new Error(result.error || '保存封面失败')
  }
  return result.coverPath
}

export async function pickWorkCover(workId: number): Promise<string | null> {
  const result = await window.anovel.invoke('work:pickCover', workId) as {
    success: boolean
    coverPath?: string
    error?: string
    cancelled?: boolean
  }
  if (result.cancelled) return null
  if (!result.success || !result.coverPath) {
    throw new Error(result.error || '设置封面失败')
  }
  return result.coverPath
}

export async function removeWorkCover(workId: number): Promise<void> {
  const result = await window.anovel.invoke('work:removeCover', workId) as { success: boolean; error?: string }
  if (!result.success) {
    throw new Error(result.error || '移除封面失败')
  }
}

export const WORK_COVER_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif'
