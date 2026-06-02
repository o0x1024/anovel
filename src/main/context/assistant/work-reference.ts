import { volumeChapterDAO, workDAO } from '../../db'
import { sampleDocumentText } from './document-sampling'
import type { AssistantWorkReference } from '../../../shared/assistant-types'

export function buildWorkReferenceTitle(workId: number, chapterId?: number | null): string {
  const work = workDAO.getById(workId)
  if (!work) return '未知作品'
  if (chapterId) {
    const chapter = volumeChapterDAO.getChapter(chapterId)
    return chapter ? `《${work.title}》·${chapter.title}` : `《${work.title}》`
  }
  return `《${work.title}》全文`
}

/** 读取作品章节或全书正文（纯文本，章节间以空行分隔） */
export function getWorkBodyText(workId: number, chapterId?: number | null): string {
  if (chapterId) {
    const chapter = volumeChapterDAO.getChapter(chapterId)
    return chapter?.content?.trim() ?? ''
  }

  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  return chapters
    .map(chapter => chapter.content?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n')
}

export function buildWorkReferenceMetadata(
  workReferences: AssistantWorkReference[]
): Record<string, unknown> | null {
  if (!workReferences.length) return null
  return {
    workReferences: workReferences.map(ref => ({
      workId: ref.workId,
      chapterId: ref.chapterId ?? null,
      title: ref.title || buildWorkReferenceTitle(ref.workId, ref.chapterId)
    }))
  }
}

export function buildWorkReferenceContext(workReferences: AssistantWorkReference[]): string {
  const parts: string[] = []
  for (const ref of workReferences) {
    const body = getWorkBodyText(ref.workId, ref.chapterId)
    if (!body) continue
    parts.push(sampleDocumentText(body))
  }
  return parts.join('\n\n')
}
