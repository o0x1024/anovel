import { extractJsonText } from './parse-json-extract'

export interface ParsedVolume {
  name: string
  description: string
}

/** 文档级标题，不应作为分卷条目 */
const META_VOLUME_TITLE = /^分卷大纲|^总体|^概述|^作品名|^书名|^说明|^摘要|^目录|^大纲建议|^创作/i

/** 字段标签被误当成卷名 */
const FIELD_LABEL_NAME = /^(?:\*{0,2})?(?:卷末钩子|结尾钩子|核心冲突|核心主题|主题|分卷说明|description|theme|end_hook)(?:\*{0,2})?[：:]/i

/** 名称是否像真实分卷（卷一 / 第一卷 / Volume 1 等） */
function looksLikeVolumeTitle(name: string): boolean {
  const n = name.trim().replace(/^\*+|\*+$/g, '')
  if (!n) return false
  if (/^卷[一二三四五六七八九十百千零\d]|第\s*[0-9一二三四五六七八九十百千]+卷|^Volume\s*\d/i.test(n)) {
    return true
  }
  if (/卷/.test(n) && !META_VOLUME_TITLE.test(n)) return true
  return false
}

function isMetaVolumeName(name: string): boolean {
  const n = name.trim().replace(/^\*+|\*+$/g, '')
  if (!n) return true
  if (META_VOLUME_TITLE.test(n)) return true
  if (FIELD_LABEL_NAME.test(n)) return true
  return false
}

function isPlaceholderDescription(description: string): boolean {
  const d = description.trim()
  return !d || /^[-—–_=\s]+$/.test(d)
}

function buildVolumeDescription(row: Record<string, unknown>): string {
  const direct = String(
    row.description ?? row.summary ?? row.描述 ?? ''
  ).trim()
  if (direct) return direct

  const theme = String(row.theme ?? row.核心主题 ?? row.主题 ?? '').trim()
  const conflict = String(row.core_conflict ?? row.conflict ?? row.核心冲突 ?? '').trim()
  const hook = String(row.end_hook ?? row.volume_hook ?? row.卷末钩子 ?? row.结尾钩子 ?? '').trim()

  const parts: string[] = []
  if (theme) parts.push(`【主题】${theme}`)
  if (conflict) parts.push(`【冲突】${conflict}`)
  if (hook) parts.push(`【卷末钩子】${hook}`)
  return parts.join('\n')
}

function isValidVolumeEntry(v: ParsedVolume): boolean {
  const name = v.name.trim()
  if (!name || isMetaVolumeName(name)) return false
  if (!looksLikeVolumeTitle(name)) return false
  if (isPlaceholderDescription(v.description)) return false
  return true
}

function filterValidVolumes(volumes: ParsedVolume[]): ParsedVolume[] {
  return volumes.filter(isValidVolumeEntry)
}

/**
 * 从 AI 分卷建议中解析（默认仅 JSON；Markdown 仅作兼容回退）
 */
export function parseVolumeSuggestions(content: string, jsonOnly = true): ParsedVolume[] {
  const fromJson = parseVolumesFromJson(content)
  if (fromJson.length > 0) return filterValidVolumes(fromJson)
  if (jsonOnly) return []
  return filterValidVolumes(parseVolumesFromMarkdown(content))
}

function parseVolumesFromJson(content: string): ParsedVolume[] {
  const jsonText = extractJsonText(content)
  if (!jsonText) return []

  try {
    const parsed = JSON.parse(jsonText) as unknown
    return extractVolumeArray(parsed)
  } catch {
    return []
  }
}

function extractVolumeArray(parsed: unknown): ParsedVolume[] {
  if (!parsed || typeof parsed !== 'object') return []

  const root = parsed as Record<string, unknown>
  const arr = Array.isArray(root.volumes)
    ? root.volumes
    : Array.isArray(parsed)
      ? parsed
      : []

  return arr
    .map(item => normalizeVolumeItem(item))
    .filter((v): v is ParsedVolume => v !== null)
}

function normalizeVolumeItem(item: unknown): ParsedVolume | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const name = String(row.name ?? row.title ?? row.卷名 ?? '').trim().replace(/^\*+|\*+$/g, '')
  if (!name || isMetaVolumeName(name)) return null

  const description = buildVolumeDescription(row)
  if (isPlaceholderDescription(description) && !looksLikeVolumeTitle(name)) return null
  return { name, description }
}

function parseVolumesFromMarkdown(content: string): ParsedVolume[] {
  const lines = content.split('\n')
  const volumes: ParsedVolume[] = []
  let current: ParsedVolume | null = null

  for (const line of lines) {
    const heading = line.match(/^#{1,3}\s*(?:第?\s*[0-9一二三四五六七八九十百千]+卷[：:\s-]*)?(.+)$/)
    const numbered = line.match(/^\s*(?:[-*]|\d+[.)])\s*(?:第?\s*[0-9一二三四五六七八九十]+卷[：:\s-]*)?(.+)$/)

    if (heading) {
      const name = heading[1].trim()
      if (!looksLikeVolumeTitle(name) || isMetaVolumeName(name)) continue
      if (current) volumes.push(current)
      current = { name, description: '' }
      continue
    }

    if (numbered && /卷|Volume/i.test(line)) {
      const name = numbered[1].trim()
      if (isMetaVolumeName(name)) continue
      if (current) volumes.push(current)
      current = { name, description: '' }
      continue
    }

    if (current && line.trim()) {
      if (FIELD_LABEL_NAME.test(line.trim())) continue
      const detail = line.replace(/^\s*[-*]\s*/, '').trim()
      current.description = current.description
        ? `${current.description}\n${detail}`
        : detail
    }
  }

  if (current) volumes.push(current)
  return volumes.filter(v => v.name.length > 0)
}
