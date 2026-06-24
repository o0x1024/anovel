import { normalizeBodyParagraphSpacing } from '../../../shared/normalize-body-text'

/** 章节正文草稿缓存（未保存到数据库的生成/编辑内容） */
const unsavedContentCache = new Map<number, string>()

/** 正文生成进行中：用于将 AI 会话与章节 ID 关联 */
let pendingBodyGeneration: { chapterId: number; workId: number } | null = null

const sessionChapterMap = new Map<string, number>()
const sessionContentMap = new Map<string, string>()

export type BodyContentListener = (chapterId: number, content: string) => void
const listeners = new Set<BodyContentListener>()

export function beginBodyGeneration(chapterId: number, workId: number): void {
  pendingBodyGeneration = { chapterId, workId }
}

export function endBodyGeneration(): void {
  pendingBodyGeneration = null
}

export function bindBodySession(sessionId: string): void {
  if (!pendingBodyGeneration) return
  sessionChapterMap.set(sessionId, pendingBodyGeneration.chapterId)
}

export function trackBodySessionContent(sessionId: string, content: string): void {
  if (!sessionChapterMap.has(sessionId)) return
  sessionContentMap.set(sessionId, content)
}

export function deliverBodySession(sessionId: string, success: boolean): void {
  const chapterId = sessionChapterMap.get(sessionId)
  sessionChapterMap.delete(sessionId)
  const content = sessionContentMap.get(sessionId)
  sessionContentMap.delete(sessionId)
  if (!success || chapterId == null || !content?.trim()) return
  cacheBodyContent(chapterId, content)
}

export function clearBodySession(sessionId: string): void {
  sessionChapterMap.delete(sessionId)
  sessionContentMap.delete(sessionId)
}

/** 仅写入缓存，不通知监听方（供编辑区 v-model 同步使用） */
export function setCachedBodyContent(chapterId: number, content: string): void {
  unsavedContentCache.set(chapterId, content)
}

/** 写入缓存并通知监听方（供 AI 生成完成投递使用） */
export function cacheBodyContent(chapterId: number, content: string): void {
  setCachedBodyContent(chapterId, content)
  const normalized = content ? normalizeBodyParagraphSpacing(content) : content
  for (const listener of listeners) {
    listener(chapterId, normalized)
  }
}

export function getCachedBodyContent(chapterId: number): string | undefined {
  return unsavedContentCache.get(chapterId)
}

export function clearCachedBodyContent(chapterId: number): void {
  unsavedContentCache.delete(chapterId)
}

export function onBodyContentDelivered(listener: BodyContentListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
