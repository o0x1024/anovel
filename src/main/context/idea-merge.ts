import { coreSettingDAO, volumeChapterDAO, ideaFragmentDAO } from '../db'

export type IdeaMergeTarget =
  | { kind: 'setting'; type: string }
  | { kind: 'chapter'; chapterId: number; field: 'outline' | 'content' }

export function parseIdeaMergeTarget(target: string): IdeaMergeTarget | null {
  if (target.startsWith('setting:')) {
    return { kind: 'setting', type: target.slice('setting:'.length) }
  }
  const chapterMatch = target.match(/^chapter:(\d+):(outline|content)$/)
  if (chapterMatch) {
    return {
      kind: 'chapter',
      chapterId: Number(chapterMatch[1]),
      field: chapterMatch[2] as 'outline' | 'content'
    }
  }
  return null
}

export function mergeIdeaToTarget(ideaId: number, target: string): void {
  const idea = ideaFragmentDAO.getById(ideaId)
  if (!idea) throw new Error('灵感不存在')

  const parsed = parseIdeaMergeTarget(target)
  if (!parsed) throw new Error('无效的合龙目标')

  const block = `\n\n---\n【灵感合龙】${idea.content}`

  if (parsed.kind === 'setting') {
    if (!idea.work_id) throw new Error('灵感未关联作品')
    const existing = coreSettingDAO.getByType(idea.work_id, parsed.type)
    const next = existing?.content ? `${existing.content}${block}` : idea.content
    coreSettingDAO.upsert(idea.work_id, parsed.type, next)
  } else {
    const chapter = volumeChapterDAO.getChapter(parsed.chapterId)
    if (!chapter) throw new Error('章节不存在')

    if (parsed.field === 'outline') {
      const next = chapter.outline ? `${chapter.outline}${block}` : idea.content
      volumeChapterDAO.updateChapter(parsed.chapterId, { outline: next })
    } else {
      const next = chapter.content ? `${chapter.content}${block}` : idea.content
      const wordCount = next.replace(/\s/g, '').length
      volumeChapterDAO.updateChapter(parsed.chapterId, { content: next, word_count: wordCount })
    }
  }

  ideaFragmentDAO.markMerged(ideaId, target)
}
