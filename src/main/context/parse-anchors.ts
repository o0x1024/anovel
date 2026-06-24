import { ANCHOR_TYPES } from '../db'
import { extractJsonCandidates } from './settings-quality-json'

export type AnchorScope = 'work' | 'volume' | 'chapter'

export interface ParsedAnchor {
  type: string
  title: string
  content: string
  scope?: AnchorScope
}

export interface RevisedAnchor extends ParsedAnchor {
  id?: number
}

const SCOPE_ALIASES: Record<string, AnchorScope> = {
  '全书级': 'work',
  '全書級': 'work',
  '分卷级': 'volume',
  '分捲級': 'volume',
  '章节级': 'chapter',
  '章節級': 'chapter',
  'work': 'work',
  'volume': 'volume',
  'chapter': 'chapter'
}

function normalizeScope(raw: string): AnchorScope | undefined {
  const key = raw.trim()
  return SCOPE_ALIASES[key]
}

/** 从类型标签中分离 scope，如 "scene][章节级" → {type:"scene", scope:"chapter"} */
function splitTypeAndScope(raw: string): { type: string; scope?: AnchorScope } {
  // 格式: "类型" 或 "类型][范围"
  const withScope = raw.match(/^(\w+)\]\[([^\]]+)\]$/)
  if (withScope) {
    return { type: withScope[1], scope: normalizeScope(withScope[2]) }
  }
  // 格式: "类型][范围" (没有尾部])
  const partial = raw.match(/^(\w+)\]\[(.+)$/)
  if (partial) {
    return { type: partial[1], scope: normalizeScope(partial[2]) }
  }
  return { type: raw }
}

const TYPE_ALIASES: Record<string, string> = {
  场景: 'scene',
  角色: 'character',
  情节: 'plot',
  情感: 'emotion',
  结构: 'structure',
  记忆: 'memory',
  反差: 'contrast',
  scene: 'scene',
  character: 'character',
  plot: 'plot',
  emotion: 'emotion',
  structure: 'structure',
  memory: 'memory',
  contrast: 'contrast'
}

const VALID_TYPES = new Set<string>(ANCHOR_TYPES)

/**
 * 从孵化器「提炼锚点」结果中解析锚点条目
 */
export function parseAnchorSuggestions(content: string): ParsedAnchor[] {
  const fromJson = parseAnchorsFromJson(content)
  if (fromJson.length > 0) return fromJson

  const anchors: ParsedAnchor[] = []
  const lines = content.split('\n')

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const tagged = trimmed.match(/^[-*•]\s*(?:\d+[.)]\s*)?(?:\[([^\]]+)\])?\s*(.+)$/)
    if (!tagged) continue

    const typeRaw = tagged[1]?.trim() ?? 'plot'
    const body = tagged[2].trim()
    if (!body) continue

    const split = splitTypeAndScope(typeRaw)
    const type = normalizeType(split.type)
    const colon = body.match(/^([^：:]+)[：:]\s*(.+)$/)
    if (colon) {
      anchors.push({ type, title: colon[1].trim(), content: colon[2].trim(), scope: split.scope })
    } else {
      anchors.push({ type, title: body.slice(0, 30), content: body, scope: split.scope })
    }
  }

  return dedupeAnchors(anchors)
}

export function parseRevisedAnchorsFromAi(content: string): RevisedAnchor[] {
  for (const raw of extractJsonCandidates(content)) {
    try {
      const parsed = JSON.parse(raw) as unknown
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as Record<string, unknown>)?.anchors)
          ? (parsed as Record<string, unknown>).anchors as unknown[]
          : []

      const result = dedupeAnchors(
        arr
          .map(item => {
            if (!item || typeof item !== 'object') return null
            const row = item as Record<string, unknown>
            const title = String(row.title ?? row.name ?? '').trim()
            const body = String(row.content ?? row.description ?? '').trim()
            if (!title && !body) return null
            const idRaw = row.id
            const id = idRaw == null || idRaw === '' ? undefined : Number(idRaw)
            const typeRaw = String(row.type ?? 'plot')
            const split = splitTypeAndScope(typeRaw)
            const scope = row.scope ? normalizeScope(String(row.scope)) : split.scope
            return {
              id: Number.isFinite(id) ? id : undefined,
              type: normalizeType(split.type),
              title: title || body.slice(0, 30),
              content: body || title,
              scope
            }
          })
          .filter((a): a is NonNullable<typeof a> => a !== null) as RevisedAnchor[]
      )
      if (result.length > 0) return result
    } catch {
      // try next candidate
    }
  }

  return parseAnchorSuggestions(content).map(a => ({ ...a }))
}

function parseAnchorsFromJson(content: string): ParsedAnchor[] {
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (!jsonMatch) return []

  try {
    const parsed = JSON.parse(jsonMatch[1].trim()) as unknown
    const arr = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as Record<string, unknown>)?.anchors)
        ? (parsed as Record<string, unknown>).anchors as unknown[]
        : []

    return dedupeAnchors(
      arr
        .map(item => {
          if (!item || typeof item !== 'object') return null
          const row = item as Record<string, unknown>
          const title = String(row.title ?? row.name ?? '').trim()
          const body = String(row.content ?? row.description ?? '').trim()
          if (!title && !body) return null
          const typeRaw = String(row.type ?? 'plot')
          const split = splitTypeAndScope(typeRaw)
          const scope = row.scope ? normalizeScope(String(row.scope)) : split.scope
          return {
            type: normalizeType(split.type),
            title: title || body.slice(0, 30),
            content: body || title,
            scope
          }
        })
        .filter((a): a is NonNullable<typeof a> => a !== null) as ParsedAnchor[]
    )
  } catch {
    return []
  }
}

function normalizeType(raw: string): string {
  const key = raw.replace(/锚点/g, '').trim()
  const mapped = TYPE_ALIASES[key] ?? TYPE_ALIASES[key.toLowerCase()] ?? key
  return VALID_TYPES.has(mapped) ? mapped : 'plot'
}

function dedupeAnchors(anchors: ParsedAnchor[]): ParsedAnchor[] {
  const seen = new Set<string>()
  return anchors.filter(a => {
    const key = `${a.type}:${a.title}:${a.content}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
