import type { AnchorRow, ChapterRow } from '../db'

/** 默认全书级、不做逐章检测的锚点类型 */
const WORK_LEVEL_TYPES = new Set(['structure'])

function extractKeywords(text: string): string[] {
  const parts = text
    .split(/[\s,，。；;、：:\n]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 2)

  const keywords = new Set<string>()
  for (const part of parts) {
    if (part.length <= 8) keywords.add(part)
    if (/[\u4e00-\u9fa5]/.test(part)) {
      for (let len = 2; len <= Math.min(4, part.length); len++) {
        for (let i = 0; i <= part.length - len; i++) {
          keywords.add(part.slice(i, i + len))
        }
      }
    }
  }
  return [...keywords].slice(0, 12)
}

function corpusMatches(corpus: string, anchor: AnchorRow): boolean {
  const keywords = extractKeywords(`${anchor.title} ${anchor.content}`)
  if (keywords.length === 0) {
    return corpus.includes(anchor.title) || corpus.includes(anchor.content.slice(0, 8))
  }
  const matched = keywords.filter(k => corpus.includes(k))
  return matched.length >= 1
}

export interface AnchorApplicability {
  applicable: boolean
  reason: string
}

/** 判断锚点是否应纳入当前章节的逐章对齐检测 */
export function isAnchorApplicableToChapter(
  anchor: AnchorRow,
  chapter: ChapterRow
): AnchorApplicability {
  if (anchor.target_chapter_id != null) {
    if (anchor.target_chapter_id === chapter.id) {
      return { applicable: true, reason: '绑定本章' }
    }
    return { applicable: false, reason: '已绑定其他章节' }
  }

  if (anchor.target_volume_id != null) {
    if (chapter.volume_id !== anchor.target_volume_id) {
      return { applicable: false, reason: '已绑定其他分卷' }
    }
    return { applicable: true, reason: '绑定本分卷' }
  }

  if (WORK_LEVEL_TYPES.has(anchor.type)) {
    return { applicable: false, reason: '全书级锚点，本章跳过' }
  }

  const chapterCorpus = [chapter.title, chapter.outline, chapter.characters]
    .filter(Boolean)
    .join('\n')

  if (chapterCorpus.trim() && corpusMatches(chapterCorpus, anchor)) {
    return { applicable: true, reason: '本章大纲相关' }
  }

  return { applicable: false, reason: '与本章大纲无关，跳过' }
}

export function filterAnchorsForChapter(
  anchors: AnchorRow[],
  chapter: ChapterRow
): { applicable: AnchorRow[]; skipped: { anchor: AnchorRow; reason: string }[] } {
  const applicable: AnchorRow[] = []
  const skipped: { anchor: AnchorRow; reason: string }[] = []

  for (const anchor of anchors) {
    const { applicable: ok, reason } = isAnchorApplicableToChapter(anchor, chapter)
    if (ok) applicable.push(anchor)
    else skipped.push({ anchor, reason })
  }

  return { applicable, skipped }
}

/** 按分卷过滤锚点：排除绑定到其他分卷的锚点 */
export function filterAnchorsForVolume(
  anchors: AnchorRow[],
  volumeId: number
): { applicable: AnchorRow[]; skipped: { anchor: AnchorRow; reason: string }[] } {
  const applicable: AnchorRow[] = []
  const skipped: { anchor: AnchorRow; reason: string }[] = []

  for (const anchor of anchors) {
    if (anchor.target_volume_id != null && anchor.target_volume_id !== volumeId) {
      skipped.push({ anchor, reason: '已绑定其他分卷' })
      continue
    }
    if (anchor.target_chapter_id != null) {
      skipped.push({ anchor, reason: '已绑定特定章节，分卷级跳过' })
      continue
    }
    if (WORK_LEVEL_TYPES.has(anchor.type)) {
      applicable.push(anchor)
      continue
    }
    applicable.push(anchor)
  }

  return { applicable, skipped }
}
