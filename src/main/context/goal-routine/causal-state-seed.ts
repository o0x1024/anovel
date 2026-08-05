export const CAUSAL_INITIAL_CHAPTER_WINDOW = 8

interface SeedVolume {
  id: number
  name: string
  description: string | null
  planned_start_chapter: number | null
  planned_end_chapter: number | null
}

interface SeedChapter {
  id: number
  volume_id: number
  title: string
  outline: string | null
  next_hook: string | null
  content: string | null
}

function bounded(value: string | null | undefined, limit: number): string {
  const text = value?.trim() ?? ''
  return text.length <= limit ? text : text.slice(0, limit)
}

/**
 * 权威状态只消费“全部卷级阶段 + 当前章节窗口”，禁止复制整本逐章规划。
 * 已发生正文事实由独立的基线投影提供。
 */
export function buildCausalStateSeedProjection(
  volumes: SeedVolume[],
  chapters: SeedChapter[],
  windowSize = CAUSAL_INITIAL_CHAPTER_WINDOW
): {
  volumeArcs: Array<{
    id: number
    name: string
    description: string
    startChapter: number | null
    endChapter: number | null
  }>
  activeWindow: Array<{
    id: number
    title: string
    outline: string
    nextHook: string
  }>
} {
  const firstPending = chapters.findIndex(chapter => !chapter.content?.trim())
  const windowStart = firstPending >= 0
    ? firstPending
    : Math.max(0, chapters.length - windowSize)
  const activeWindow = chapters
    .slice(windowStart, windowStart + Math.max(1, windowSize))
    .map(chapter => ({
      id: chapter.id,
      title: bounded(chapter.title, 160),
      outline: bounded(chapter.outline, 1_200),
      nextHook: bounded(chapter.next_hook, 400)
    }))

  return {
    volumeArcs: volumes.map(volume => ({
      id: volume.id,
      name: bounded(volume.name, 160),
      description: bounded(volume.description, 1_500),
      startChapter: volume.planned_start_chapter,
      endChapter: volume.planned_end_chapter
    })),
    activeWindow
  }
}
