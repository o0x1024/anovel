import { countWords } from '../../../shared/body-word-target'
import { normalizeBodyParagraphSpacing } from '../../../shared/normalize-body-text'

export interface SavedChapterDraft {
  content: string
  wordCount: number
  status: 'draft' | 'memory_pending'
  cleared: boolean
}

/** 只保存正文草稿和版本，不运行任何 AI 验收或叙事记忆提取。 */
export async function saveChapterDraft(
  chapterId: number,
  workType: string | null,
  content: string
): Promise<SavedChapterDraft> {
  const normalizedContent = normalizeBodyParagraphSpacing(content)
  const cleared = !normalizedContent.trim()
  const wordCount = countWords(normalizedContent)
  const status = !cleared && workType === 'novel' ? 'memory_pending' : 'draft'
  const updated = await window.anovel.invoke('chapter:update', chapterId, {
    content: normalizedContent,
    word_count: wordCount,
    status
  })
  if (updated !== true) throw new Error('章节正文未写入数据库')
  return { content: normalizedContent, wordCount, status, cleared }
}
