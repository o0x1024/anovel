import { foreshadowingDAO, characterSnapshotDAO, timelineDAO, volumeChapterDAO } from '../db'

export interface MemoryCleanupResult {
  snapshotsRemoved: number
  foreshadowingRemoved: number
  payoffsReverted: number
  timelineRemoved?: number
}

function normalizeDesc(desc: string): string {
  return desc.replace(/\s/g, '').slice(0, 16)
}

export function resolveWorkIdForChapter(chapterId: number): number | null {
  const ch = volumeChapterDAO.getChapter(chapterId)
  if (!ch) return null
  const row = volumeChapterDAO.get<{ work_id: number }>(
    'SELECT work_id FROM volumes WHERE id = ?',
    [ch.volume_id]
  )
  return row?.work_id ?? null
}

export function isEmptyChapterContent(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

/**
 * 再次提取某章记忆前：撤销本章对伏笔的回收、删除本章埋设的伏笔、删除本章角色快照。
 */
export function clearChapterMemoryBeforeExtract(workId: number, chapterId: number): MemoryCleanupResult {
  const payoffsReverted = foreshadowingDAO.revertPayoffsByChapter(workId, chapterId)
  const foreshadowingRemoved = foreshadowingDAO.deleteByPlantChapter(workId, chapterId)
  const snapshotsRemoved = characterSnapshotDAO.deleteByChapter(chapterId)
  return { snapshotsRemoved, foreshadowingRemoved, payoffsReverted }
}

/**
 * 清空某章正文时：撤销本章伏笔回收、删除本章埋设的伏笔与角色快照、删除本章时间线事件。
 */
export function clearChapterNarrativeMemory(workId: number, chapterId: number): MemoryCleanupResult {
  const timelineRemoved = timelineDAO.deleteByChapter(workId, chapterId)
  const result = clearChapterMemoryBeforeExtract(workId, chapterId)
  return { ...result, timelineRemoved }
}

/**
 * 清理作品中重复的叙事记忆（保留每章每角色最新快照、同章相似伏笔只保留一条）。
 */
export function cleanupDuplicateNarrativeMemory(workId: number): MemoryCleanupResult {
  let snapshotsRemoved = 0
  let foreshadowingRemoved = 0

  const snapshots = characterSnapshotDAO.listByWork(workId)
  const snapshotGroups = new Map<string, typeof snapshots>()
  for (const row of snapshots) {
    const key = `${row.character_name}\0${row.chapter_id}`
    const group = snapshotGroups.get(key) ?? []
    group.push(row)
    snapshotGroups.set(key, group)
  }
  for (const group of snapshotGroups.values()) {
    if (group.length <= 1) continue
    group.sort((a, b) => {
      const ta = new Date(a.snapshot_time).getTime()
      const tb = new Date(b.snapshot_time).getTime()
      if (tb !== ta) return tb - ta
      return b.id - a.id
    })
    for (const row of group.slice(1)) {
      if (characterSnapshotDAO.delete(row.id)) snapshotsRemoved++
    }
  }

  const allForeshadowing = foreshadowingDAO.listByWork(workId)
  const pendingGroups = new Map<string, typeof allForeshadowing>()
  for (const row of allForeshadowing) {
    if (row.status !== 'pending' && row.status !== 'partial') continue
    const key = `${row.plant_chapter_id ?? 'null'}\0${normalizeDesc(row.description)}`
    const group = pendingGroups.get(key) ?? []
    group.push(row)
    pendingGroups.set(key, group)
  }
  for (const group of pendingGroups.values()) {
    if (group.length <= 1) continue
    group.sort((a, b) => b.id - a.id)
    for (const row of group.slice(1)) {
      if (foreshadowingDAO.delete(row.id)) foreshadowingRemoved++
    }
  }

  return { snapshotsRemoved, foreshadowingRemoved, payoffsReverted: 0 }
}

export function cleanupDuplicateNarrativeMemoryForAllWorks(workIds: number[]): MemoryCleanupResult {
  const total: MemoryCleanupResult = { snapshotsRemoved: 0, foreshadowingRemoved: 0, payoffsReverted: 0 }
  for (const workId of workIds) {
    const r = cleanupDuplicateNarrativeMemory(workId)
    total.snapshotsRemoved += r.snapshotsRemoved
    total.foreshadowingRemoved += r.foreshadowingRemoved
  }
  return total
}
