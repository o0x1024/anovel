import { foreshadowingDAO, characterSnapshotDAO } from '../db'
import type { ForeshadowingDepth } from '../db/dao/foreshadowing-dao'

interface ExtractedMemory {
  foreshadowing_planted?: {
    description: string
    depth?: ForeshadowingDepth
    location?: string
  }[]
  foreshadowing_resolved?: {
    description: string
    location?: string
  }[]
  character_snapshots?: {
    character_name: string
    location?: string
    mental_state?: string
    known_info?: string
    relationship_changes?: string
    ability_changes?: string
    numeric_stats?: { name: string; value: string; unit?: string }[]
  }[]
}

export interface MemoryExtractResult {
  planted: number
  resolved: number
  snapshots: number
}

export interface ForeshadowingResolutionResult {
  resolved: { id: number; evidence: string }[]
  partial: { id: number; evidence: string }[]
  pending: number[]
}

export function parseMemoryExtract(content: string): ExtractedMemory {
  const match = content.match(/```json\s*([\s\S]*?)```/)
  try {
    return JSON.parse(match?.[1] ?? content) as ExtractedMemory
  } catch {
    return {}
  }
}

export function applyMemoryExtract(
  workId: number,
  chapterId: number,
  extracted: ExtractedMemory
): MemoryExtractResult {
  let planted = 0
  let resolved = 0
  let snapshots = 0

  for (const item of extracted.foreshadowing_planted ?? []) {
    if (!item.description?.trim()) continue
    foreshadowingDAO.create({
      work_id: workId,
      description: item.description.trim(),
      plant_chapter_id: chapterId,
      plant_location: item.location,
      depth: item.depth ?? 'normal'
    })
    planted++
  }

  // 硬编码匹配已移除 — 回收检测改用 AI 语义判断（foreshadowing:detectResolutions）
  for (const snap of extracted.character_snapshots ?? []) {
    if (!snap.character_name?.trim()) continue
    const numericStats = snap.numeric_stats && snap.numeric_stats.length > 0
      ? JSON.stringify(snap.numeric_stats)
      : undefined
    characterSnapshotDAO.create({
      work_id: workId,
      character_name: snap.character_name.trim(),
      chapter_id: chapterId,
      location: snap.location,
      mental_state: snap.mental_state,
      known_info: snap.known_info,
      relationship_changes: snap.relationship_changes,
      ability_changes: snap.ability_changes,
      numeric_stats: numericStats
    })
    snapshots++
  }

  return { planted, resolved, snapshots }
}

export const FORESHADOWING_RESOLVE_SYSTEM_PROMPT = [
  '你是伏笔回收分析器。根据章节内容，判断每条待回收伏笔的回收状态。',
  '',
  '判断标准：',
  '- resolved：本章明确揭示了伏笔的真相/结果，读者能感知到"这个伏笔已经回收了"',
  '- partial：本章推进了该伏笔（给出线索、暗示、部分揭示），但未完全回收',
  '- pending：本章未涉及该伏笔',
  '',
  '注意：',
  '- 只看本章内容，不要推测未来章节',
  '- 伏笔回收可能是隐晦的——比如通过角色的行为、对话暗示，不一定是明说',
  '- evidence 字段摘录文中支持你判断的关键句子（不超过 50 字）',
  '',
  '输出严格 JSON：',
  '{"results":[{"id":1,"status":"resolved","evidence":"文中关键句"},{"id":2,"status":"pending","evidence":""}]}',
  '不要输出其他文字。'
].join('\n')

export function parseForeshadowingResolutions(content: string): ForeshadowingResolutionResult {
  const trimmed = content.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fenced ? fenced[1].trim() : trimmed

  let data: unknown
  try {
    data = JSON.parse(jsonText)
  } catch {
    const bare = jsonText.match(/\{[\s\S]*"results"[\s\S]*\}/)
    if (!bare) return { resolved: [], partial: [], pending: [] }
    try { data = JSON.parse(bare[0]) } catch { return { resolved: [], partial: [], pending: [] } }
  }

  if (!data || typeof data !== 'object') return { resolved: [], partial: [], pending: [] }
  const results = (data as Record<string, unknown>).results
  if (!Array.isArray(results)) return { resolved: [], partial: [], pending: [] }

  const resolved: ForeshadowingResolutionResult['resolved'] = []
  const partial: ForeshadowingResolutionResult['partial'] = []
  const pending: number[] = []

  for (const item of results) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'number' ? row.id : parseInt(String(row.id ?? ''), 10)
    if (!Number.isFinite(id)) continue
    const status = String(row.status ?? '').toLowerCase()
    const evidence = typeof row.evidence === 'string' ? row.evidence.trim() : ''
    if (status === 'resolved') resolved.push({ id, evidence })
    else if (status === 'partial') partial.push({ id, evidence })
    else pending.push(id)
  }

  return { resolved, partial, pending }
}

export function applyForeshadowingResolutions(
  workId: number,
  chapterId: number,
  result: ForeshadowingResolutionResult
): { resolved: number; partial: number } {
  let resolvedCount = 0
  let partialCount = 0

  for (const item of result.resolved) {
    const row = foreshadowingDAO.getById(item.id)
    if (!row || row.work_id !== workId) continue
    if (row.status === 'resolved') continue
    foreshadowingDAO.resolve(item.id, chapterId, item.evidence || undefined)
    resolvedCount++
  }

  for (const item of result.partial) {
    const row = foreshadowingDAO.getById(item.id)
    if (!row || row.work_id !== workId) continue
    if (row.status === 'resolved' || row.status === 'abandoned') continue
    foreshadowingDAO.updateStatus(item.id, 'partial')
    partialCount++
  }

  return { resolved: resolvedCount, partial: partialCount }
}

export const MEMORY_EXTRACT_SYSTEM_PROMPT = [
  '从章节正文中提取叙事记忆体更新信息。',
  '识别：新埋设的伏笔（标注 depth: shallow/normal/deep）、本章回收的伏笔、出场角色的状态变化。',
  '',
  '角色快照的 numeric_stats 字段（极重要）：',
  '提取角色在本章结束时的所有数值类状态，包括但不限于：体力/气血/法力/灵力、等级/境界、积分/贡献点/信用度、金钱/资源数量、装备耐久度等。',
  '每项格式：{"name":"属性名","value":"数值或状态","unit":"单位（可选）"}',
  '必须记录本章中发生变化的数值，以及与后续剧情可能产生冲突的关键数值。',
  '示例：[{"name":"体力","value":"50","unit":""},{"name":"信用度","value":"87","unit":"点"},{"name":"境界","value":"练气三层","unit":""}]',
  '若本章无数值类状态变化，numeric_stats 留空数组。',
  '',
  '输出 JSON：',
  '```json',
  '{"foreshadowing_planted":[{"description":"","depth":"normal","location":""}],"foreshadowing_resolved":[{"description":"","location":""}],"character_snapshots":[{"character_name":"","location":"","mental_state":"","known_info":"","relationship_changes":"","ability_changes":"","numeric_stats":[{"name":"","value":"","unit":""}]}]}',
  '```',
  '若无某项则留空数组。'
].join('\n')
