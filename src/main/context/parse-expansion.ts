import { extractJsonText } from './parse-json-extract'

export interface ExpansionVersion {
  title: string
  summary: string
  highlights?: string
  audience?: string
}

const META_EXPANSION_TITLE = /^方向扩写|^扩写版本|^版本列表|^说明|^摘要|^目录|^示例/i
const FIELD_LABEL_TITLE = /^(?:\*{0,2})?(?:核心亮点|受众定位|highlights|audience|summary|title)(?:\*{0,2})?[：:]/i

function isMetaExpansionTitle(title: string): boolean {
  const t = title.trim().replace(/^\*+|\*+$/g, '')
  if (!t) return true
  if (META_EXPANSION_TITLE.test(t)) return true
  if (FIELD_LABEL_TITLE.test(t)) return true
  return false
}

function isValidExpansion(v: ExpansionVersion): boolean {
  if (isMetaExpansionTitle(v.title)) return false
  return v.summary.trim().length >= 40
}

/**
 * 解析孵化器「方向扩写」（默认仅 JSON）
 */
export function parseExpansionVersions(content: string, jsonOnly = true): ExpansionVersion[] {
  const fromJson = parseExpansionJson(content)
  if (fromJson.length > 0) return fromJson
  if (jsonOnly) return []
  return []
}

export function formatExpansionAsIdea(version: ExpansionVersion): string {
  const parts = [`【${version.title}】`, version.summary]
  if (version.highlights) parts.push(`核心亮点：${version.highlights}`)
  if (version.audience) parts.push(`受众定位：${version.audience}`)
  return parts.join('\n\n')
}

function parseExpansionJson(content: string): ExpansionVersion[] {
  const jsonText = extractJsonText(content)
  if (!jsonText) return []

  try {
    const parsed = JSON.parse(jsonText) as unknown
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.versions)
        ? (parsed as Record<string, unknown>).versions as unknown[]
        : []

    return arr
      .map(item => normalizeExpansionRow(item))
      .filter((v): v is ExpansionVersion => v !== null && isValidExpansion(v))
  } catch {
    return []
  }
}

function normalizeExpansionRow(item: unknown): ExpansionVersion | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const title = String(row.title ?? row.name ?? '').trim().replace(/^\*+|\*+$/g, '')
  const summary = String(row.summary ?? row.description ?? row.content ?? '').trim()
  if (!summary || summary.length < 20) return null
  if (title && isMetaExpansionTitle(title)) return null

  const highlights = String(row.highlights ?? row.亮点 ?? '').trim() || undefined
  const audience = String(row.audience ?? row.受众 ?? row.受众定位 ?? '').trim() || undefined

  return {
    title: title || summary.slice(0, 20),
    summary,
    highlights,
    audience
  }
}
