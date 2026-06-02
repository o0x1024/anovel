import { extractJsonText } from './parse-json-extract'

export interface ParsedChapter {
  title: string
  outline: string
  beat_role?: string | null
  foreshadow_target?: string | null
  next_hook?: string | null
  pov_mode?: string | null
  characters?: string | null
}

export interface ParsedSingleChapterOutline {
  outline: string
  beat_role?: string | null
  foreshadow_target?: string | null
  next_hook?: string | null
  pov_mode?: string | null
  characters?: string | null
}

/** 文档级标题，不应作为章节条目 */
const META_CHAPTER_TITLE = /^章节大纲|^分章|^分卷|^情节大纲|^章节列表|^目录|^大纲建议|^创作|^本卷/i

/** 字段标签被误当成章节名 */
const FIELD_LABEL_TITLE = /^(?:\*{0,2})?(?:章节结尾钩子|章末钩子|结尾钩子|情节节点|爽点链|核心情节|关键冲突|beat_role|foreshadow_target|next_hook)(?:\*{0,2})?[：:]/i

function isVolumeLevelChapterHeader(title: string): boolean {
  const t = title.trim()
  return /^卷[一二三四五六七八九十百千零\d]+[：:《]/.test(t)
    && /大纲|情节|目录|分章|章节列表/.test(t)
}

function isMetaChapterTitle(title: string): boolean {
  const t = title.trim().replace(/^\*+|\*+$/g, '')
  if (!t) return true
  if (META_CHAPTER_TITLE.test(t)) return true
  if (FIELD_LABEL_TITLE.test(t)) return true
  if (isVolumeLevelChapterHeader(t)) return true
  if (/^第?\s*[0-9一二三四五六七八九十百千]+章\s*$/.test(t)) return true
  return false
}

function isPlaceholderOutline(outline: string): boolean {
  const d = outline.trim()
  return !d || /^[-—–_=\s]+$/.test(d)
}

function isValidChapterEntry(chapter: ParsedChapter): boolean {
  if (isMetaChapterTitle(chapter.title)) return false
  if (isPlaceholderOutline(chapter.outline) && isVolumeLevelChapterHeader(chapter.title)) return false
  return chapter.title.trim().length > 0 && !isPlaceholderOutline(chapter.outline)
}

function filterValidChapters(chapters: ParsedChapter[]): ParsedChapter[] {
  return chapters.filter(isValidChapterEntry)
}

function normalizePlotPoints(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map(p => String(p).trim())
    .filter(p => p.length > 0 && !FIELD_LABEL_TITLE.test(p))
}

function buildOutlineFromParts(
  plotPoints: string[],
  outlineRaw: string,
  nextHook?: string | null
): string {
  const parts: string[] = []
  if (plotPoints.length > 0) {
    parts.push(
      ...plotPoints.map((p, i) => {
        const cleaned = p.replace(/^\d+[.)]\s*/, '').trim()
        return `${i + 1}. ${cleaned}`
      })
    )
  } else if (outlineRaw.trim()) {
    parts.push(stripOutlineFieldLabels(outlineRaw.trim()))
  }
  const hook = nextHook?.trim()
  if (hook && !parts.some(l => l.includes(hook))) {
    parts.push(`【章末钩子】${hook}`)
  }
  return parts.join('\n')
}

function stripOutlineFieldLabels(text: string): string {
  return text
    .split('\n')
    .filter(line => !FIELD_LABEL_TITLE.test(line.trim()))
    .join('\n')
    .trim()
}

/**
 * 从 AI 批量章节建议中解析（仅 JSON；Markdown 仅作兼容回退）
 */
export function parseChapterSuggestions(content: string, jsonOnly = true): ParsedChapter[] {
  const fromJson = parseChaptersFromJson(content)
  if (fromJson.length > 0) return filterValidChapters(fromJson)
  if (jsonOnly) return []
  return filterValidChapters(parseChaptersFromMarkdown(content))
}

function parseChaptersFromJson(content: string): ParsedChapter[] {
  const jsonText = extractJsonText(content)
  if (!jsonText) return []

  try {
    const parsed = JSON.parse(jsonText) as unknown
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.chapters)
        ? (parsed as Record<string, unknown>).chapters as unknown[]
        : []

    const list = arr
      .map(item => normalizeChapterItem(item))
      .filter((c): c is ParsedChapter => c !== null)
    return list
  } catch {
    return []
  }
}

function normalizeChapterItem(item: unknown): ParsedChapter | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>

  let title = String(row.title ?? row.name ?? row.章节名 ?? '').trim()
  title = title.replace(/^\*+|\*+$/g, '')
  if (!title || isMetaChapterTitle(title)) return null

  const plotPoints = normalizePlotPoints(row.plot_points ?? row.plotPoints ?? row.beats ?? row.nodes)
  const outlineRaw = String(
    row.outline ?? row.summary ?? row.plot ?? row.情节 ?? row.description ?? ''
  ).trim()

  const nextHook = row.next_hook != null ? String(row.next_hook) : null
  const outline = buildOutlineFromParts(plotPoints, outlineRaw, nextHook)

  if (isPlaceholderOutline(outline)) return null

  return {
    title,
    outline,
    beat_role: row.beat_role != null ? String(row.beat_role) : null,
    foreshadow_target: row.foreshadow_target != null ? String(row.foreshadow_target) : null,
    next_hook: nextHook,
    pov_mode: row.pov_mode != null ? String(row.pov_mode) : null,
    characters: normalizeCharactersField(row.characters)
  }
}

/** 单章 AI 大纲：仅 JSON */
export function parseSingleChapterOutline(content: string): ParsedSingleChapterOutline | null {
  const jsonText = extractJsonText(content)
  if (!jsonText) return null

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    const plotPoints = normalizePlotPoints(
      parsed.plot_points ?? parsed.plotPoints ?? parsed.beats ?? parsed.nodes
    )
    const outlineRaw = String(parsed.outline ?? parsed.summary ?? '').trim()
    const nextHook = parsed.next_hook != null ? String(parsed.next_hook) : null
    const outline = buildOutlineFromParts(plotPoints, outlineRaw, nextHook)
    if (isPlaceholderOutline(outline)) return null

    return {
      outline,
      beat_role: parsed.beat_role != null ? String(parsed.beat_role) : null,
      foreshadow_target: parsed.foreshadow_target != null ? String(parsed.foreshadow_target) : null,
      next_hook: nextHook,
      pov_mode: parsed.pov_mode != null ? String(parsed.pov_mode) : null,
      characters: normalizeCharactersField(parsed.characters)
    }
  } catch {
    return null
  }
}

function normalizeCharactersField(value: unknown): string | null {
  if (value == null) return null
  if (Array.isArray(value)) {
    const names = value.map(v => String(v).trim()).filter(Boolean)
    return names.length > 0 ? names.join(',') : null
  }
  const str = String(value).trim()
  return str || null
}

const METADATA_LINE = /^\s*[-*•]?\s*(?:\*{0,2})?(beat_role|foreshadow_target|next_hook|characters|pov_mode)(?:\*{0,2})?\s*[：:]\s*(.+)/i

function parseChaptersFromMarkdown(content: string): ParsedChapter[] {
  const chapters: ParsedChapter[] = []
  const lines = content.split('\n')
  let current: ParsedChapter | null = null

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s+(.+)$/)
    const numbered = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/)

    if (heading && /章|Chapter/i.test(line)) {
      const title = heading[1].trim().replace(/^\*+|\*+$/g, '')
      if (isMetaChapterTitle(title)) continue
      if (current) chapters.push(current)
      current = { title, outline: '' }
      continue
    }

    if (numbered && /第\s*[0-9一二三四五六七八九十]+章/.test(line)) {
      const title = numbered[1].trim().replace(/^\*+|\*+$/g, '')
      if (isMetaChapterTitle(title)) continue
      if (current) chapters.push(current)
      current = { title, outline: '' }
      continue
    }

    if (!current) continue
    const trimmed = line.trim()
    if (!trimmed) continue

    const metaMatch = trimmed.match(METADATA_LINE)
    if (metaMatch) {
      const key = metaMatch[1].toLowerCase()
      const val = metaMatch[2].trim()
      if (key === 'beat_role') current.beat_role = val
      else if (key === 'foreshadow_target') current.foreshadow_target = val
      else if (key === 'next_hook') current.next_hook = val
      else if (key === 'pov_mode') current.pov_mode = val
      else if (key === 'characters') current.characters = normalizeCharactersFromText(val)
      continue
    }

    if (FIELD_LABEL_TITLE.test(trimmed)) continue
    const detail = trimmed.replace(/^\s*[-*]\s*/, '').trim()
    current.outline = current.outline ? `${current.outline}\n${detail}` : detail
  }

  if (current) chapters.push(current)
  return chapters.filter(c => c.title.length > 0)
}

function normalizeCharactersFromText(text: string): string | null {
  const cleaned = text.replace(/^\[|\]$/g, '').replace(/["""]/g, '')
  const names = cleaned.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
  return names.length > 0 ? names.join(',') : null
}

export function parseChapterAbcFromAi(content: string): {
  beat_role?: string | null
  foreshadow_target?: string | null
  next_hook?: string | null
  characters?: string | null
} {
  const single = parseSingleChapterOutline(content)
  if (single) {
    return {
      beat_role: single.beat_role,
      foreshadow_target: single.foreshadow_target,
      next_hook: single.next_hook,
      characters: single.characters
    }
  }

  try {
    const jsonText = extractJsonText(content)
    if (!jsonText) return {}
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    return {
      beat_role: parsed.beat_role != null ? String(parsed.beat_role) : null,
      foreshadow_target: parsed.foreshadow_target != null ? String(parsed.foreshadow_target) : null,
      next_hook: parsed.next_hook != null ? String(parsed.next_hook) : null,
      characters: normalizeCharactersField(parsed.characters)
    }
  } catch {
    return {}
  }
}

/** 去掉 AI 输出中的 JSON 块（兼容旧数据清理展示） */
export function stripOutlineJsonFooter(content: string): string {
  const parsed = parseSingleChapterOutline(content)
  if (parsed?.outline) return parsed.outline
  return content.replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim()
}

export function outlineCharCount(outline: string | null | undefined): number {
  return (outline ?? '').replace(/\s/g, '').length
}
