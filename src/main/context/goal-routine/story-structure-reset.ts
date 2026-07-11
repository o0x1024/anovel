import { volumeChapterDAO } from '../../db'
import { clearChapterNarrativeMemory } from '../memory-cleanup'

export function resetFailedStoryStructure(workId: number): number {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  for (const chapter of chapters) {
    clearChapterNarrativeMemory(workId, chapter.id)
    volumeChapterDAO.deleteChapter(chapter.id)
  }
  return chapters.length
}
