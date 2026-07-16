import { volumeChapterDAO, foreshadowingDAO, characterSnapshotDAO, storyStateDAO } from '../db'
import { extractMemoryKeywords } from './novel-memory-retrieval'

export interface RetrievedChapter {
  chapterId: number
  chapterTitle: string
  volumeName: string
  content: string
  reason: string
  score: number
}

/**
 * 按伏笔关联、角色名、大纲关键词检索历史章节摘录（不含上一章，上一章单独注入）
 */
export function retrieveRelevantChapters(
  workId: number,
  chapterId: number,
  outlineText: string,
  limit = 4
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
  const focusCharacterNames = characterNames.filter(name => name && outlineText.includes(name))
  const pending = foreshadowingDAO.listPending(workId)
  const memoryKeywords = extractMemoryKeywords(outlineText)
  const relevantPending = pending.filter(item => {
    const text = `${item.description ?? ''}\n${item.plant_location ?? ''}`
    return memoryKeywords.some(keyword => text.includes(keyword))
      || (item.description?.trim() ? outlineText.includes(item.description.trim().slice(0, 10)) : false)
  })
  const relevantFactReasons = new Map<number, string[]>()
  for (const fact of storyStateDAO.listFactsByWork(workId)) {
    const text = `${fact.entity}\n${fact.state_key}\n${fact.evidence ?? ''}`
    const relevant = outlineText.includes(fact.entity)
      || outlineText.includes(fact.state_key)
      || memoryKeywords.some(keyword => text.includes(keyword))
    if (!relevant) continue
    const reasons = relevantFactReasons.get(fact.chapter_id) ?? []
    reasons.push(`${fact.entity}.${fact.state_key}`)
    relevantFactReasons.set(fact.chapter_id, reasons)
  }

  const relevantForeshadowChapterIds = new Set(
    relevantPending.map(item => item.plant_chapter_id).filter((id): id is number => id != null)
  )
  const recentFloor = Math.max(0, idx - 80)
  const candidates = all
    .slice(0, idx)
    .filter((c, index) => {
      if (c.id === prevId || !c.content?.trim()) return false
      if (index >= recentFloor) return true
      if (relevantFactReasons.has(c.id) || relevantForeshadowChapterIds.has(c.id)) return true
      const metadata = `${c.title}\n${c.outline ?? ''}\n${c.characters ?? ''}`
      return keywords.some(keyword => metadata.includes(keyword))
        || focusCharacterNames.some(name => metadata.includes(name))
    })

  const scored: RetrievedChapter[] = []

  for (const ch of candidates) {
    const content = ch.content!.trim()
    let score = 0
    const reasons: string[] = []

    for (const name of focusCharacterNames) {
      if (content.includes(name)) {
        score += 4
        reasons.push(`角色「${name}」`)
      }
    }

    for (const kw of keywords) {
      if (content.includes(kw)) {
        score += 1
        reasons.push(`关键词「${kw}」`)
      }
    }

    for (const f of relevantPending) {
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

    const factReasons = relevantFactReasons.get(ch.id) ?? []
    if (factReasons.length > 0) {
      score += 6 + Math.min(6, factReasons.length * 2)
      reasons.push(`状态「${factReasons.slice(0, 2).join('、')}」`)
    }

    if (score > 0) {
      scored.push({
        chapterId: ch.id,
        chapterTitle: ch.title,
        volumeName: ch.volume_name,
        content: buildRelevantExcerpt(content, keywords, relevantPending.map(f => f.description)),
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
    '【相关历史章节摘录 - 仅供逻辑参照，禁止重复叙述或照搬旧章】',
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

function buildRelevantExcerpt(content: string, keywords: string[], foreshadowingDescriptions: string[]): string {
  const needles = [
    ...keywords,
    ...foreshadowingDescriptions
      .map(desc => desc.trim().slice(0, 12))
      .filter(Boolean)
  ].filter(Boolean)

  const spans: string[] = []
  for (const needle of needles) {
    const idx = content.indexOf(needle)
    if (idx < 0) continue
    const start = Math.max(0, idx - 280)
    const end = Math.min(content.length, idx + needle.length + 420)
    const snippet = content.slice(start, end).trim()
    if (snippet && !spans.some(existing => existing.includes(snippet.slice(0, 30)))) {
      spans.push(`${start > 0 ? '…' : ''}${snippet}${end < content.length ? '…' : ''}`)
    }
    if (spans.length >= 2) break
  }

  if (spans.length > 0) return spans.join('\n\n')

  const head = content.slice(0, 420).trim()
  const tail = content.length > 900 ? content.slice(-420).trim() : ''
  return tail ? `${head}\n\n…\n\n${tail}` : head
}
