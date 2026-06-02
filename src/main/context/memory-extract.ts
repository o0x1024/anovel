import { foreshadowingDAO, characterSnapshotDAO } from '../db'
import type { ForeshadowingDepth } from '../db'

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
  }[]
}

export interface MemoryExtractResult {
  planted: number
  resolved: number
  snapshots: number
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

  const pending = foreshadowingDAO.listPending(workId)
  for (const item of extracted.foreshadowing_resolved ?? []) {
    if (!item.description?.trim()) continue
    const match = pending.find(p =>
      p.description.includes(item.description.slice(0, 8)) ||
      item.description.includes(p.description.slice(0, 8))
    )
    if (match) {
      foreshadowingDAO.resolve(match.id, chapterId, item.location)
      resolved++
    }
  }

  for (const snap of extracted.character_snapshots ?? []) {
    if (!snap.character_name?.trim()) continue
    characterSnapshotDAO.create({
      work_id: workId,
      character_name: snap.character_name.trim(),
      chapter_id: chapterId,
      location: snap.location,
      mental_state: snap.mental_state,
      known_info: snap.known_info,
      relationship_changes: snap.relationship_changes,
      ability_changes: snap.ability_changes
    })
    snapshots++
  }

  return { planted, resolved, snapshots }
}

export const MEMORY_EXTRACT_SYSTEM_PROMPT = [
  '从章节正文中提取叙事记忆体更新信息。',
  '识别：新埋设的伏笔（标注 depth: shallow/normal/deep）、本章回收的伏笔、出场角色的状态变化。',
  '输出 JSON：',
  '```json',
  '{"foreshadowing_planted":[{"description":"","depth":"normal","location":""}],"foreshadowing_resolved":[{"description":"","location":""}],"character_snapshots":[{"character_name":"","location":"","mental_state":"","known_info":"","relationship_changes":"","ability_changes":""}]}',
  '```',
  '若无某项则留空数组。'
].join('\n')
