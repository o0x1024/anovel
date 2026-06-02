import { extractJsonText } from './parse-json-extract'

export interface IncubatorVariant {
  title: string
  dimension?: string
  summary: string
}

const META_VARIANT_TITLE = /^变体探索|^变体列表|^变体维度|^说明|^摘要|^目录|^示例/i
const FIELD_LABEL_TITLE = /^(?:\*{0,2})?(?:变体维度|变体名|summary|dimension|title)(?:\*{0,2})?[：:]/i

function isMetaVariantTitle(title: string): boolean {
  const t = title.trim().replace(/^\*+|\*+$/g, '')
  if (!t) return true
  if (META_VARIANT_TITLE.test(t)) return true
  if (FIELD_LABEL_TITLE.test(t)) return true
  return false
}

function isValidVariant(v: IncubatorVariant): boolean {
  if (isMetaVariantTitle(v.title)) return false
  return v.summary.trim().length >= 20
}

/**
 * 解析孵化器「变体探索」（默认仅 JSON；legacyFallback 时兼容旧 Markdown）
 */
export function parseIncubatorVariants(content: string, jsonOnly = true): IncubatorVariant[] {
  const fromJson = parseVariantsJson(content)
  if (fromJson.length > 0) return fromJson
  if (jsonOnly) return []
  return parseVariantsMarkdown(content).filter(isValidVariant)
}

export function formatVariantAsIdea(variant: IncubatorVariant): string {
  const parts = [`【${variant.title}】`]
  if (variant.dimension?.trim() && variant.dimension !== variant.title) {
    parts.push(`变体维度：${variant.dimension.trim()}`)
  }
  parts.push(variant.summary.trim())
  return parts.join('\n\n')
}

function parseVariantsJson(content: string): IncubatorVariant[] {
  const jsonText = extractJsonText(content)
  if (!jsonText) return []

  try {
    const parsed = JSON.parse(jsonText) as unknown
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.variants)
        ? (parsed as Record<string, unknown>).variants as unknown[]
        : []

    return arr
      .map(item => normalizeVariantRow(item))
      .filter((v): v is IncubatorVariant => v !== null && isValidVariant(v))
  } catch {
    return []
  }
}

function normalizeVariantRow(item: unknown): IncubatorVariant | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const title = String(row.title ?? row.name ?? row.label ?? '').trim().replace(/^\*+|\*+$/g, '')
  const dimension = String(row.dimension ?? row.维度 ?? row.type ?? '').trim() || undefined
  const summary = String(row.summary ?? row.description ?? row.content ?? row.text ?? '').trim()
  if (!summary || summary.length < 15) return null
  if (title && isMetaVariantTitle(title)) return null
  return {
    title: title || dimension || summary.slice(0, 24),
    dimension,
    summary: summary || title
  }
}

function parseVariantsMarkdown(content: string): IncubatorVariant[] {
  const variants: IncubatorVariant[] = []
  const body = content.replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim()

  const headingParts = body.split(/^#{2,3}\s+/m).map(s => s.trim()).filter(Boolean)
  if (headingParts.length >= 2) {
    for (const part of headingParts) {
      const variant = parseHeadingBlock(part)
      if (variant) variants.push(variant)
    }
    if (variants.length > 0) return variants
  }

  const numbered = [...body.matchAll(/^\s*\d+[.)]\s*(.+)$/gm)]
  if (numbered.length >= 2) {
    const blocks = splitNumberedBlocks(body)
    for (const block of blocks) {
      const variant = parseNumberedBlock(block)
      if (variant) variants.push(variant)
    }
    if (variants.length > 0) return variants
  }

  const listItems = [...body.matchAll(/^\s*[-*]\s+\*{0,2}([^*\n]+)\*{0,2}[：:]\s*(.+)$/gm)]
  for (const match of listItems) {
    const title = match[1].trim()
    const summary = match[2].trim()
    if (title && summary.length >= 20 && !isMetaVariantTitle(title)) {
      variants.push({ title, summary })
    }
  }

  return variants
}

function parseHeadingBlock(part: string): IncubatorVariant | null {
  const lines = part.split('\n')
  const heading = lines[0]?.trim()
  if (!heading || isMetaVariantTitle(heading)) return null

  const { title, dimension } = splitTitleDimension(heading)
  const summary = lines.slice(1).join('\n').trim()
  if (!summary || summary.length < 15) return null

  return { title: title || dimension || heading, dimension, summary }
}

function splitNumberedBlocks(body: string): string[] {
  const matches = [...body.matchAll(/^\s*\d+[.)]\s+/gm)]
  if (matches.length < 2) return []

  const blocks: string[] = []
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? body.length) : body.length
    blocks.push(body.slice(start, end).trim())
  }
  return blocks
}

function parseNumberedBlock(block: string): IncubatorVariant | null {
  const lines = block.split('\n')
  const first = lines[0]?.replace(/^\s*\d+[.)]\s*/, '').trim()
  if (!first) return null

  const titleMatch = first.match(/^\*{0,2}([^*]+)\*{0,2}[：:]\s*(.*)$/)
  let title = ''
  let summaryStart = ''

  if (titleMatch) {
    title = titleMatch[1].trim()
    summaryStart = titleMatch[2].trim()
  } else {
    title = first.replace(/\*{2}/g, '').trim()
  }

  if (isMetaVariantTitle(title)) return null

  const rest = lines.slice(1).join('\n').trim()
  const summary = [summaryStart, rest].filter(Boolean).join('\n').trim()
  if (!summary || summary.length < 15) return null

  const { title: parsedTitle, dimension } = splitTitleDimension(title)
  return {
    title: parsedTitle || title,
    dimension,
    summary
  }
}

function splitTitleDimension(heading: string): { title: string; dimension?: string } {
  const cleaned = heading.replace(/\*{2}/g, '').trim()
  const colonMatch = cleaned.match(/^变体\s*\d+[：:]\s*(.+)$/)
  if (colonMatch) {
    return { title: colonMatch[1].trim(), dimension: colonMatch[1].trim() }
  }

  const parts = cleaned.split(/[：:|｜]/)
  if (parts.length >= 2) {
    const left = parts[0].replace(/^变体\s*\d+\s*/i, '').trim()
    const right = parts.slice(1).join('：').trim()
    if (left && right) {
      return { title: left || right, dimension: right }
    }
  }

  return { title: cleaned }
}
