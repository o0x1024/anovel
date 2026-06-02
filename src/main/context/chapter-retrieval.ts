import { volumeChapterDAO, foreshadowingDAO, characterSnapshotDAO } from '../db'

export interface RetrievedChapter {
  chapterId: number
  chapterTitle: string
  volumeName: string
  content: string
  reason: string
  score: number
}

/**
 * 按伏笔关联、角色名、大纲关键词检索历史章节全文（不含上一章，上一章单独注入）
 */
export function retrieveRelevantChapters(
  workId: number,
  chapterId: number,
  outlineText: string,
  limit = 5
): RetrievedChapter[] {
  const all = volumeChapterDAO.listChaptersByWork(workId)
  const idx = all.findIndex(c => c.id === chapterId)
  if (idx <= 0) return []

  const prevId = (() => {
    for (let i = idx - 1; i >= 0; i--) {
      if (all[i].content?.trim()) return all[i].id
    }
    return null
  })()

  const keywords = extractKeywords(outlineText)
  const characterNames = characterSnapshotDAO.listCharacterNames(workId)
  const pending = foreshadowingDAO.listPending(workId)

  const candidates = all
    .slice(0, idx)
    .filter(c => c.id !== prevId && c.content?.trim())

  const scored: RetrievedChapter[] = []

  for (const ch of candidates) {
    const content = ch.content!.trim()
    let score = 0
    const reasons: string[] = []

    for (const name of characterNames) {
      if (name && (outlineText.includes(name) || content.includes(name))) {
        score += 2
        if (outlineText.includes(name)) reasons.push(`角色「${name}」`)
      }
    }

    for (const kw of keywords) {
      if (content.includes(kw)) {
        score += 1
        reasons.push(`关键词「${kw}」`)
      }
    }

    for (const f of pending) {
      const loc = f.plant_location || ''
      if (loc && (loc.includes(ch.title) || ch.title.includes(loc.slice(0, 6)))) {
        score += 4
        reasons.push(`伏笔「${f.description.slice(0, 20)}…」`)
      }
      if (f.plant_chapter_id === ch.id) {
        score += 5
        reasons.push('伏笔埋设章')
      }
    }

    if (score > 0) {
      scored.push({
        chapterId: ch.id,
        chapterTitle: ch.title,
        volumeName: ch.volume_name,
        content,
        reason: [...new Set(reasons)].slice(0, 3).join('；') || '相关',
        score
      })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export function formatRetrievedChapters(chapters: RetrievedChapter[]): string {
  if (chapters.length === 0) return ''
  return [
    '【相关历史章节全文 - 仅供逻辑参照，禁止重复叙述】',
    ...chapters.map(c => [
      `--- ${c.volumeName} · ${c.chapterTitle}（关联：${c.reason}）---`,
      c.content
    ].join('\n'))
  ].join('\n\n')
}

function extractKeywords(text: string): string[] {
  if (!text) return []
  const words = text.match(/[\u4e00-\u9fff]{2,6}/g) ?? []
  const stop = new Set(['本章', '章节', '情节', '故事', '主角', '之后', '然后', '但是', '因为', '所以', '一个', '他们', '我们', '没有', '开始', '继续', '进行'])
  const freq = new Map<string, number>()
  for (const w of words) {
    if (stop.has(w) || w.length < 2) continue
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w)
}
