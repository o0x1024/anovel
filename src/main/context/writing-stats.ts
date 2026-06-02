import { volumeChapterDAO, generationLogDAO } from '../db'

export interface WritingStats {
  totalWords: number
  chapterCount: number
  chaptersWithContent: number
  totalOutlineWords: number
  avgWordsPerChapter: number
  tokenUsage: { total_prompt: number; total_completion: number }
  modelCalls: { model_type: string; count: number }[]
  emotionCurve: { title: string; intensity: number; wordCount: number }[]
  recentActivity: { date: string; words: number }[]
}

export function getWritingStats(workId: number): WritingStats {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const withContent = chapters.filter(c => c.content?.trim())
  const totalWords = withContent.reduce((s, c) => s + (c.word_count || 0), 0)
  const totalOutlineWords = chapters.reduce((s, c) => s + (c.outline?.replace(/\s/g, '').length || 0), 0)

  const tokenUsage = generationLogDAO.getTokenUsage(workId)
  const modelCalls = generationLogDAO.getModelCallCount(workId)

  const emotionCurve = withContent.map(c => ({
    title: c.title,
    intensity: c.emotion_intensity ?? 5,
    wordCount: c.word_count
  }))

  const byDate = new Map<string, number>()
  for (const c of withContent) {
    const date = (c.update_time || c.create_time).slice(0, 10)
    byDate.set(date, (byDate.get(date) ?? 0) + c.word_count)
  }
  const recentActivity = [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 14)
    .map(([date, words]) => ({ date, words }))
    .reverse()

  return {
    totalWords,
    chapterCount: chapters.length,
    chaptersWithContent: withContent.length,
    totalOutlineWords,
    avgWordsPerChapter: withContent.length ? Math.round(totalWords / withContent.length) : 0,
    tokenUsage,
    modelCalls,
    emotionCurve,
    recentActivity
  }
}
