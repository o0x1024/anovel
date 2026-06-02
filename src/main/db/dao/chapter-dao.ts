import { BaseDAO } from './base-dao'
import { normalizeBodyParagraphSpacing } from '../../../shared/normalize-body-text'

export interface VolumeRow {
  id: number
  work_id: number
  name: string
  description: string | null
  sort: number
  create_time: string
}

export interface ChapterRow {
  id: number
  volume_id: number
  title: string
  outline: string | null
  content: string | null
  word_count: number
  sort: number
  status: string
  emotion_intensity: number | null
  beat_role: string | null
  foreshadow_target: string | null
  next_hook: string | null
  pov_mode: string | null
  characters: string | null
  create_time: string
  update_time: string
}

export interface ChapterVersionRow {
  id: number
  chapter_id: number
  version_number: number
  outline: string | null
  content: string | null
  word_count: number
  model_type: string | null
  style_id: number | null
  generation_round: number
  create_time: string
}

export class VolumeChapterDAO extends BaseDAO {
  // ==================== 分卷 ====================

  listVolumes(workId: number): VolumeRow[] {
    return this.all<VolumeRow>('SELECT * FROM volumes WHERE work_id = ? ORDER BY sort', [workId])
  }

  createVolume(workId: number, name: string, description?: string, sort?: number): number {
    const maxSort = this.get<{ m: number }>(
      'SELECT COALESCE(MAX(sort), 0) + 1 AS m FROM volumes WHERE work_id = ?', [workId]
    )
    return this.insert(
      'INSERT INTO volumes (work_id, name, description, sort) VALUES (?, ?, ?, ?)',
      [workId, name, description ?? null, sort ?? maxSort?.m ?? 1]
    )
  }

  updateVolume(id: number, fields: { name?: string; description?: string }): boolean {
    const sets: string[] = []
    const vals: unknown[] = []
    if (fields.name !== undefined) { sets.push('name = ?'); vals.push(fields.name) }
    if (fields.description !== undefined) { sets.push('description = ?'); vals.push(fields.description) }
    if (sets.length === 0) return false
    vals.push(id)
    return this.run(`UPDATE volumes SET ${sets.join(', ')} WHERE id = ?`, vals).changes > 0
  }

  deleteVolume(id: number): boolean {
    return this.run('DELETE FROM volumes WHERE id = ?', [id]).changes > 0
  }

  /**
   * 批量写入分卷建议
   * replace 会删除作品下现有分卷（含章节，级联删除）
   */
  batchUpsertVolumes(
    workId: number,
    items: { name: string; description?: string }[],
    mode: 'append' | 'replace' = 'append'
  ): number[] {
    if (items.length === 0) return []

    return this.transaction(() => {
      if (mode === 'replace') {
        this.run('DELETE FROM volumes WHERE work_id = ?', [workId])
      }

      let nextSort = this.get<{ m: number }>(
        'SELECT COALESCE(MAX(sort), 0) AS m FROM volumes WHERE work_id = ?',
        [workId]
      )?.m ?? 0

      const ids: number[] = []
      for (const item of items) {
        nextSort += 1
        ids.push(this.createVolume(workId, item.name, item.description, nextSort))
      }
      return ids
    })
  }

  // ==================== 章节 ====================

  listChapters(volumeId: number): ChapterRow[] {
    return this.all<ChapterRow>('SELECT * FROM chapters WHERE volume_id = ? ORDER BY sort', [volumeId])
  }

  getChapter(id: number): ChapterRow | undefined {
    return this.get<ChapterRow>('SELECT * FROM chapters WHERE id = ?', [id])
  }

  createChapter(volumeId: number, title: string, outline?: string, sort?: number): number {
    const maxSort = this.get<{ m: number }>(
      'SELECT COALESCE(MAX(sort), 0) + 1 AS m FROM chapters WHERE volume_id = ?', [volumeId]
    )
    return this.insert(
      'INSERT INTO chapters (volume_id, title, outline, sort) VALUES (?, ?, ?, ?)',
      [volumeId, title, outline ?? null, sort ?? maxSort?.m ?? 1]
    )
  }

  updateChapter(id: number, fields: {
    title?: string; outline?: string; content?: string; word_count?: number; status?: string
    emotion_intensity?: number
    beat_role?: string | null
    foreshadow_target?: string | null
    next_hook?: string | null
    pov_mode?: string | null
    characters?: string | null
  }): boolean {
    const sets: string[] = []
    const vals: unknown[] = []
    if (fields.title !== undefined) { sets.push('title = ?'); vals.push(fields.title) }
    if (fields.outline !== undefined) { sets.push('outline = ?'); vals.push(fields.outline) }
    if (fields.content !== undefined) {
      sets.push('content = ?')
      vals.push(normalizeBodyParagraphSpacing(fields.content))
    }
    if (fields.word_count !== undefined) { sets.push('word_count = ?'); vals.push(fields.word_count) }
    if (fields.status !== undefined) { sets.push('status = ?'); vals.push(fields.status) }
    if (fields.emotion_intensity !== undefined) { sets.push('emotion_intensity = ?'); vals.push(fields.emotion_intensity) }
    if (fields.beat_role !== undefined) { sets.push('beat_role = ?'); vals.push(fields.beat_role) }
    if (fields.foreshadow_target !== undefined) { sets.push('foreshadow_target = ?'); vals.push(fields.foreshadow_target) }
    if (fields.next_hook !== undefined) { sets.push('next_hook = ?'); vals.push(fields.next_hook) }
    if (fields.pov_mode !== undefined) { sets.push('pov_mode = ?'); vals.push(fields.pov_mode) }
    if (fields.characters !== undefined) { sets.push('characters = ?'); vals.push(fields.characters) }
    if (sets.length === 0) return false
    sets.push("update_time = datetime('now')")
    vals.push(id)
    return this.run(`UPDATE chapters SET ${sets.join(', ')} WHERE id = ?`, vals).changes > 0
  }

  deleteChapter(id: number): boolean {
    return this.run('DELETE FROM chapters WHERE id = ?', [id]).changes > 0
  }

  batchCreateChapters(
    volumeId: number,
    items: {
      title: string
      outline?: string
      beat_role?: string | null
      foreshadow_target?: string | null
      next_hook?: string | null
      pov_mode?: string | null
      characters?: string | null
    }[],
    mode: 'append' | 'replace' = 'append'
  ): number[] {
    if (items.length === 0) return []

    return this.transaction(() => {
      if (mode === 'replace') {
        this.run('DELETE FROM chapters WHERE volume_id = ?', [volumeId])
      }

      let nextSort = this.get<{ m: number }>(
        'SELECT COALESCE(MAX(sort), 0) AS m FROM chapters WHERE volume_id = ?',
        [volumeId]
      )?.m ?? 0

      const ids: number[] = []
      for (const item of items) {
        nextSort += 1
        const id = this.createChapter(volumeId, item.title, item.outline, nextSort)
        this.updateChapter(id, {
          beat_role: item.beat_role ?? undefined,
          foreshadow_target: item.foreshadow_target ?? undefined,
          next_hook: item.next_hook ?? undefined,
          pov_mode: item.pov_mode ?? undefined,
          characters: item.characters ?? undefined
        })
        ids.push(id)
      }
      return ids
    })
  }

  /** 获取作品下所有章节（跨分卷，按排序） */
  listChaptersByWork(workId: number): (ChapterRow & { volume_name: string })[] {
    return this.all(
      `SELECT c.*, v.name AS volume_name
       FROM chapters c
       JOIN volumes v ON c.volume_id = v.id
       WHERE v.work_id = ?
       ORDER BY v.sort, c.sort`,
      [workId]
    )
  }

  // ==================== 章节版本 ====================

  listVersions(chapterId: number): ChapterVersionRow[] {
    return this.all<ChapterVersionRow>(
      'SELECT * FROM chapter_versions WHERE chapter_id = ? ORDER BY version_number DESC',
      [chapterId]
    )
  }

  createVersion(chapterId: number, data: {
    outline?: string; content?: string; word_count?: number
    model_type?: string; style_id?: number; generation_round?: number
  }): number {
    const latest = this.get<{ v: number }>(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS v FROM chapter_versions WHERE chapter_id = ?',
      [chapterId]
    )
    return this.insert(
      `INSERT INTO chapter_versions (chapter_id, version_number, outline, content, word_count, model_type, style_id, generation_round)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [chapterId, latest?.v ?? 1, data.outline ?? null, data.content ?? null,
        data.word_count ?? 0, data.model_type ?? null, data.style_id ?? null, data.generation_round ?? 1]
    )
  }

  restoreVersion(chapterId: number, versionId: number): boolean {
    const version = this.get<ChapterVersionRow>(
      'SELECT * FROM chapter_versions WHERE id = ? AND chapter_id = ?',
      [versionId, chapterId]
    )
    if (!version) return false
    this.updateChapter(chapterId, {
      outline: version.outline ?? undefined,
      content: version.content ?? undefined,
      word_count: version.word_count
    })
    return true
  }
}

export const volumeChapterDAO = new VolumeChapterDAO()
