import { anchorDAO, anchorAlignmentDAO, volumeChapterDAO } from '../db'
import type { AnchorRow } from '../db'
import { filterAnchorsForChapter } from './anchor-scope'

export type AlignmentLevel = 0 | 1 | 2

export interface AnchorAlignmentReportItem {
  anchorId: number
  title: string
  content: string
  type: string
  aligned: AlignmentLevel | null
  detail: string
  skipped: boolean
  skipReason?: string
}

export interface AnchorAlignmentReport {
  items: AnchorAlignmentReportItem[]
  summary: {
    total: number
    applicable: number
    aligned: number
    partial: number
    missing: number
    skipped: number
  }
}

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

function scoreAnchor(anchor: AnchorRow, body: string): { aligned: AlignmentLevel; detail: string } {
  const corpus = `${anchor.title} ${anchor.content}`
  const keywords = extractKeywords(corpus)
  if (keywords.length === 0) {
    const hit = body.includes(anchor.title) || body.includes(anchor.content.slice(0, 8))
    return hit
      ? { aligned: 2, detail: '检测到锚点标题或核心描述' }
      : { aligned: 0, detail: '正文中未检测到锚点相关内容' }
  }

  const matched = keywords.filter(k => body.includes(k))
  const ratio = matched.length / keywords.length

  if (ratio >= 0.5 || matched.length >= 3) {
    return { aligned: 2, detail: `已对齐：${matched.slice(0, 5).join('、')}` }
  }
  if (matched.length >= 1) {
    return { aligned: 1, detail: `部分对齐：${matched.slice(0, 5).join('、')}` }
  }
  return { aligned: 0, detail: '正文中未检测到锚点关键词' }
}

const ALIGNED_LABELS: Record<AlignmentLevel, string> = {
  2: '已对齐',
  1: '部分对齐',
  0: '未对齐'
}

export function checkAnchorAlignment(
  workId: number,
  content: string,
  options?: { chapterId?: number; step?: string; persist?: boolean }
): AnchorAlignmentReport {
  const anchors = anchorDAO.listActiveByWork(workId)
  const body = content.trim()
  const items: AnchorAlignmentReportItem[] = []

  let toCheck = anchors
  let skippedEntries: { anchor: AnchorRow; reason: string }[] = []

  if (options?.chapterId) {
    const chapter = volumeChapterDAO.getChapter(options.chapterId)
    if (chapter) {
      const filtered = filterAnchorsForChapter(anchors, chapter)
      toCheck = filtered.applicable
      skippedEntries = filtered.skipped
    }
  }

  for (const anchor of toCheck) {
    const { aligned, detail } = scoreAnchor(anchor, body)
    if (options?.persist !== false) {
      anchorAlignmentDAO.log({
        anchor_id: anchor.id,
        chapter_id: options?.chapterId,
        step: options?.step ?? 'body_generation',
        aligned,
        detail: `${ALIGNED_LABELS[aligned]} — ${detail}`
      })
    }
    items.push({
      anchorId: anchor.id,
      title: anchor.title,
      content: anchor.content,
      type: anchor.type,
      aligned,
      detail,
      skipped: false
    })
  }

  for (const { anchor, reason } of skippedEntries) {
    items.push({
      anchorId: anchor.id,
      title: anchor.title,
      content: anchor.content,
      type: anchor.type,
      aligned: null,
      detail: reason,
      skipped: true,
      skipReason: reason
    })
  }

  const checked = items.filter(i => !i.skipped)

  return {
    items,
    summary: {
      total: items.length,
      applicable: checked.length,
      aligned: checked.filter(i => i.aligned === 2).length,
      partial: checked.filter(i => i.aligned === 1).length,
      missing: checked.filter(i => i.aligned === 0).length,
      skipped: items.filter(i => i.skipped).length
    }
  }
}
