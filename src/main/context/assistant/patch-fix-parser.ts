import type { PatchFixPatch, PatchFixResult, PatchFixSectionRewrite } from './types'

const MAX_PATCHES = 20
const MAX_SECTION_REWRITES = 3

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function extractJsonCandidates(content: string): string[] {
  const candidates: string[] = []
  const fenced = content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)
  for (const match of fenced) {
    const inner = match[1]?.trim()
    if (inner?.startsWith('{')) candidates.push(inner)
  }

  let searchFrom = 0
  while (searchFrom < content.length) {
    const openIdx = content.indexOf('{', searchFrom)
    if (openIdx === -1) break

    let depth = 1
    let i = openIdx + 1
    let inString = false
    let escaped = false
    while (i < content.length && depth > 0) {
      const ch = content[i]
      if (escaped) {
        escaped = false
      } else if (ch === '\\' && inString) {
        escaped = true
      } else if (ch === '"') {
        inString = !inString
      } else if (!inString) {
        if (ch === '{') depth++
        else if (ch === '}') depth--
      }
      i++
    }

    if (depth === 0) {
      const candidate = content.slice(openIdx, i).trim()
      if (candidate.includes('"patches"') || candidate.includes('"section_rewrites"')) {
        candidates.push(candidate)
      }
    }
    searchFrom = openIdx + 1
  }

  return candidates
}

function parsePatch(item: unknown): PatchFixPatch | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const find = readString(row.find)
  const replace = typeof row.replace === 'string' ? row.replace : ''
  const reason = readString(row.reason)
  if (!find) return null
  return { find, replace, ...(reason ? { reason } : {}) }
}

function parseSectionRewrite(item: unknown): PatchFixSectionRewrite | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  const title = readString(row.title)
  const find_start = readString(row.find_start ?? row.findStart)
  const find_end = readString(row.find_end ?? row.findEnd)
  const replacement = typeof row.replacement === 'string' ? row.replacement : ''
  const reason = readString(row.reason)
  if (!find_start || !find_end || !replacement.trim()) return null
  return {
    title: title || '段落重写',
    find_start,
    find_end,
    replacement,
    ...(reason ? { reason } : {})
  }
}

export function extractPatchFixFromReply(content: string): PatchFixResult | null {
  for (const candidate of extractJsonCandidates(content)) {
    let data: unknown
    try {
      data = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!data || typeof data !== 'object') continue
    const row = data as Record<string, unknown>
    const patches = Array.isArray(row.patches)
      ? row.patches.map(parsePatch).filter((item): item is PatchFixPatch => item != null).slice(0, MAX_PATCHES)
      : []
    const rewritesRaw = row.section_rewrites ?? row.sectionRewrites
    const section_rewrites = Array.isArray(rewritesRaw)
      ? rewritesRaw
          .map(parseSectionRewrite)
          .filter((item): item is PatchFixSectionRewrite => item != null)
          .slice(0, MAX_SECTION_REWRITES)
      : []
    if (patches.length || section_rewrites.length) {
      return { patches, section_rewrites }
    }
  }
  return null
}
