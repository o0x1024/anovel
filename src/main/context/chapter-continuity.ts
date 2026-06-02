import { volumeChapterDAO } from '../db'

export interface ChapterContinuityContext {
  hasPrevious: boolean
  previousChapterId: number | null
  previousChapterTitle: string | null
  /** 上一章全文 */
  fullContent: string
}

/**
 * 获取上一章正文全文，供章节衔接注入
 */
export function getPreviousChapterContext(workId: number, chapterId: number): ChapterContinuityContext {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const idx = chapters.findIndex(c => c.id === chapterId)
  if (idx <= 0) {
    return { hasPrevious: false, previousChapterId: null, previousChapterTitle: null, fullContent: '' }
  }

  for (let i = idx - 1; i >= 0; i--) {
    const prev = chapters[i]
    const content = prev.content?.trim()
    if (content) {
      return {
        hasPrevious: true,
        previousChapterId: prev.id,
        previousChapterTitle: prev.title,
        fullContent: content
      }
    }
  }

  return { hasPrevious: false, previousChapterId: null, previousChapterTitle: null, fullContent: '' }
}

export function formatContinuityPrompt(ctx: ChapterContinuityContext): string {
  if (!ctx.hasPrevious || !ctx.fullContent) return ''
  return [
    '【上一章全文 - 本章须从此文自然延续】',
    `章节：${ctx.previousChapterTitle}`,
    ctx.fullContent,
    '（禁止重述上一章已写内容；从结尾情境、对话或动作直接承接往下写）'
  ].join('\n\n')
}

/** 预算紧张时保留上一章末尾 */
export function trimContinuityToTail(content: string, keepChars: number): string {
  if (content.length <= keepChars) return content
  return `…（前文已省略 ${content.length - keepChars} 字）\n\n${content.slice(-keepChars)}`
}
