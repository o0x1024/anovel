import { app } from 'electron'
import path from 'path'
import { copyFileSync, existsSync, mkdirSync } from 'fs'
import { closeDatabase } from '../db/connection'
import {
  workDAO, coreSettingDAO, volumeChapterDAO, anchorDAO, ideaFragmentDAO,
  foreshadowingDAO, timelineDAO, aiFavoriteDAO
} from '../db'
import type { WorkStepTemperatureConfig } from '../../shared/work-step-temperature'

export interface WorkBackupBundle {
  version: 1
  exportedAt: string
  work: { title: string; description: string | null }
  settings: { type: string; content: string }[]
  volumes: { name: string; description: string | null; sort: number; chapters: {
    title: string; outline: string | null; content: string | null; word_count: number
    sort: number; status: string; emotion_intensity: number | null
  }[] }[]
  anchors: { type: string; title: string; content: string; is_active: number }[]
  ideas: { type: string; content: string; tags: string | null }[]
  foreshadowing: { description: string; depth?: string | null; status: string; plant_location?: string | null }[]
  snapshots: { character_name: string; chapter_sort: number; volume_sort: number; location?: string | null; mental_state?: string | null; known_info?: string | null }[]
  timeline: { event_name: string; event_description?: string | null; absolute_time?: string | null; relative_time?: string | null }[]
  favorites: { source_step: string; source_label: string; title?: string | null; content: string }[]
  stepTemperature?: WorkStepTemperatureConfig
}

export function exportWorkBundle(workId: number): WorkBackupBundle {
  const work = workDAO.getById(workId)
  if (!work) throw new Error('作品不存在')

  const settings = coreSettingDAO.listByWork(workId).map(s => ({ type: s.type, content: s.content }))
  const volumes = volumeChapterDAO.listVolumes(workId)
  const allChapters = volumeChapterDAO.listChaptersByWork(workId)

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    work: { title: work.title, description: work.description },
    settings,
    volumes: volumes.map(vol => ({
      name: vol.name,
      description: vol.description,
      sort: vol.sort,
      chapters: allChapters
        .filter(c => c.volume_id === vol.id)
        .map(c => ({
          title: c.title,
          outline: c.outline,
          content: c.content,
          word_count: c.word_count,
          sort: c.sort,
          status: c.status,
          emotion_intensity: c.emotion_intensity
        }))
    })),
    anchors: anchorDAO.listByWork(workId).map(a => ({
      type: a.type, title: a.title, content: a.content, is_active: a.is_active
    })),
    ideas: ideaFragmentDAO.listByWork(workId).filter(i => !i.is_merged).map(i => ({
      type: i.type, content: i.content, tags: i.tags
    })),
    foreshadowing: foreshadowingDAO.listByWork(workId).map(f => ({
      description: f.description,
      depth: f.depth,
      status: f.status,
      plant_location: f.plant_location
    })),
    snapshots: [],
    timeline: timelineDAO.listByWork(workId).map(e => ({
      event_name: e.event_name,
      event_description: e.event_description,
      absolute_time: e.absolute_time,
      relative_time: e.relative_time
    })),
    favorites: aiFavoriteDAO.listByWork(workId).map(f => ({
      source_step: f.source_step,
      source_label: f.source_label,
      title: f.title,
      content: f.content
    })),
    stepTemperature: workDAO.getStepTemperature(workId)
  }
}

export function importWorkBundle(bundle: WorkBackupBundle): number {
  const workId = workDAO.create({
    title: `${bundle.work.title}（导入）`,
    description: bundle.work.description ?? undefined
  })

  for (const s of bundle.settings) {
    coreSettingDAO.upsert(workId, s.type, s.content)
  }

  for (const vol of bundle.volumes) {
    const volId = volumeChapterDAO.createVolume(workId, vol.name, vol.description ?? undefined, vol.sort)
    for (const ch of vol.chapters) {
      const chId = volumeChapterDAO.createChapter(volId, ch.title, ch.outline ?? undefined, ch.sort)
      volumeChapterDAO.updateChapter(chId, {
        content: ch.content ?? undefined,
        outline: ch.outline ?? undefined,
        word_count: ch.word_count,
        status: ch.status,
        emotion_intensity: ch.emotion_intensity ?? undefined
      })
    }
  }

  for (const a of bundle.anchors) {
    anchorDAO.create({ work_id: workId, type: a.type, title: a.title, content: a.content })
    const created = anchorDAO.listByWork(workId).slice(-1)[0]
    if (created && !a.is_active) anchorDAO.toggleActive(created.id, false)
  }

  for (const idea of bundle.ideas) {
    ideaFragmentDAO.create({ work_id: workId, type: idea.type, content: idea.content, tags: idea.tags ?? undefined })
  }

  for (const f of bundle.foreshadowing) {
    foreshadowingDAO.create({
      work_id: workId,
      description: f.description,
      plant_location: f.plant_location ?? undefined,
      depth: (f.depth as 'shallow' | 'normal' | 'deep') ?? 'normal'
    })
    if (f.status !== 'pending') {
      const row = foreshadowingDAO.listByWork(workId).slice(-1)[0]
      if (row) foreshadowingDAO.updateStatus(row.id, f.status as 'pending' | 'partial' | 'resolved' | 'abandoned')
    }
  }

  for (const e of bundle.timeline) {
    timelineDAO.create({ work_id: workId, ...e })
  }

  for (const fav of bundle.favorites) {
    aiFavoriteDAO.create({
      work_id: workId,
      source_step: fav.source_step,
      source_label: fav.source_label,
      content: fav.content,
      title: fav.title ?? undefined
    })
  }

  if (bundle.stepTemperature) {
    workDAO.setStepTemperature(workId, bundle.stepTemperature)
  }

  return workId
}

export function getDatabasePath(): string {
  return path.join(app.getPath('userData'), 'anovel.db')
}

export function backupDatabase(destPath: string): void {
  const src = getDatabasePath()
  if (!existsSync(src)) throw new Error('数据库文件不存在')
  copyFileSync(src, destPath)
}

export function restoreDatabase(srcPath: string): void {
  if (!existsSync(srcPath)) throw new Error('备份文件不存在')
  closeDatabase()
  copyFileSync(srcPath, getDatabasePath())
}

export function ensureBackupDir(): string {
  const dir = path.join(app.getPath('userData'), 'backups')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function createAutoBackup(): string {
  const dir = ensureBackupDir()
  const name = `anovel-${Date.now()}.db`
  const dest = path.join(dir, name)
  backupDatabase(dest)
  return dest
}
