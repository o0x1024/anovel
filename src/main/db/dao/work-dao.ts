import { BaseDAO } from './base-dao'
import {
  mergeWorkStepTemperature,
  parseWorkStepTemperatureJson,
  type WorkStepTemperatureConfig
} from '../../../shared/work-step-temperature'

export interface WorkRow {
  id: number
  title: string
  description: string | null
  cover_image: string | null
  novel_length: string | null
  target_total_words: number | null
  words_per_chapter: number | null
  step_temperature_json: string | null
  work_type: string | null
  status: string | null
  genre: string | null
  tags: string | null
  deleted: number
  deleted_time: string | null
  create_time: string
  update_time: string
}

export interface WorkCreateInput {
  title: string
  description?: string
  cover_image?: string
  novelLength?: string
  targetTotalWords?: number
  wordsPerChapter?: number
  workType?: string
  status?: string
  genre?: string
  tags?: string
}

/** 列表展示用的作品行 —— 在 WorkRow 基础上附带写作进度聚合 */
export interface WorkListRow extends WorkRow {
  /** 已写正文字数（仅统计有内容的章节） */
  stat_total_words: number
  /** 章节总数 */
  stat_chapter_count: number
  /** 已完成章节数（status != 'draft'） */
  stat_completed_count: number
}

const LIST_WITH_STATS_SQL = `
  SELECT w.*,
    COALESCE(s.total_words, 0)      AS stat_total_words,
    COALESCE(s.chapter_count, 0)    AS stat_chapter_count,
    COALESCE(s.completed_count, 0)  AS stat_completed_count
  FROM works w
  LEFT JOIN (
    SELECT v.work_id AS work_id,
      SUM(CASE WHEN c.content IS NOT NULL AND c.content != '' THEN c.word_count ELSE 0 END) AS total_words,
      COUNT(c.id) AS chapter_count,
      SUM(CASE WHEN c.status != 'draft' THEN 1 ELSE 0 END)                                  AS completed_count
    FROM chapters c
    JOIN volumes v ON c.volume_id = v.id
    GROUP BY v.work_id
  ) s ON s.work_id = w.id
`

export class WorkDAO extends BaseDAO {
  /** 获取所有作品（按更新时间倒序），附带写作进度聚合 */
  list(workType?: string): WorkListRow[] {
    if (workType) {
      return this.all<WorkListRow>(
        `${LIST_WITH_STATS_SQL} WHERE w.work_type = ? AND w.deleted = 0 ORDER BY w.update_time DESC`,
        [workType]
      )
    }
    return this.all<WorkListRow>(
      `${LIST_WITH_STATS_SQL} WHERE w.deleted = 0 ORDER BY w.update_time DESC`
    )
  }

  /** 根据 ID 获取作品 */
  getById(id: number): WorkRow | undefined {
    return this.get<WorkRow>('SELECT * FROM works WHERE id = ?', [id])
  }

  /** 创建新作品 */
  create(input: WorkCreateInput): number {
    return this.insert(
      `INSERT INTO works (title, description, cover_image, novel_length, target_total_words, words_per_chapter, work_type)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.title, input.description ?? null, input.cover_image ?? null,
        input.novelLength ?? 'medium', input.targetTotalWords ?? null, input.wordsPerChapter ?? null, input.workType ?? 'novel']
    )
  }

  /** 更新作品 */
  update(id: number, input: Partial<WorkCreateInput>): boolean {
    const fields: string[] = []
    const values: unknown[] = []

    if (input.title !== undefined) { fields.push('title = ?'); values.push(input.title) }
    if (input.description !== undefined) { fields.push('description = ?'); values.push(input.description) }
    if (input.cover_image !== undefined) { fields.push('cover_image = ?'); values.push(input.cover_image) }
    if (input.novelLength !== undefined) { fields.push('novel_length = ?'); values.push(input.novelLength) }
    if (input.targetTotalWords !== undefined) { fields.push('target_total_words = ?'); values.push(input.targetTotalWords) }
    if (input.wordsPerChapter !== undefined) { fields.push('words_per_chapter = ?'); values.push(input.wordsPerChapter) }
    if (input.workType !== undefined) { fields.push('work_type = ?'); values.push(input.workType) }
    if (input.status !== undefined) { fields.push('status = ?'); values.push(input.status) }
    if (input.genre !== undefined) { fields.push('genre = ?'); values.push(input.genre) }
    if (input.tags !== undefined) { fields.push('tags = ?'); values.push(input.tags) }

    if (fields.length === 0) return false

    fields.push("update_time = datetime('now')")
    values.push(id)

    const result = this.run(`UPDATE works SET ${fields.join(', ')} WHERE id = ?`, values)
    return result.changes > 0
  }

  /** 删除作品（硬删除，级联清除所有关联数据；仅回收站「彻底删除」使用） */
  delete(id: number): boolean {
    const result = this.run('DELETE FROM works WHERE id = ?', [id])
    return result.changes > 0
  }

  /** 软删除：标记进回收站，可恢复，不清理关联文件与数据 */
  softDelete(id: number): boolean {
    const result = this.run(
      `UPDATE works SET deleted = 1, deleted_time = datetime('now'), update_time = datetime('now') WHERE id = ? AND deleted = 0`,
      [id]
    )
    return result.changes > 0
  }

  /** 从回收站恢复作品 */
  restore(id: number): boolean {
    const result = this.run(
      `UPDATE works SET deleted = 0, deleted_time = NULL, update_time = datetime('now') WHERE id = ? AND deleted = 1`,
      [id]
    )
    return result.changes > 0
  }

  /** 回收站列表（已软删除的作品，按删除时间倒序） */
  listTrash(workType?: string): WorkListRow[] {
    if (workType) {
      return this.all<WorkListRow>(
        `${LIST_WITH_STATS_SQL} WHERE w.work_type = ? AND w.deleted = 1 ORDER BY w.deleted_time DESC`,
        [workType]
      )
    }
    return this.all<WorkListRow>(
      `${LIST_WITH_STATS_SQL} WHERE w.deleted = 1 ORDER BY w.deleted_time DESC`
    )
  }

  getStepTemperature(workId: number): WorkStepTemperatureConfig {
    const row = this.getById(workId)
    if (!row) return mergeWorkStepTemperature(null)
    return parseWorkStepTemperatureJson(row.step_temperature_json)
  }

  setStepTemperature(
    workId: number,
    partial: Partial<WorkStepTemperatureConfig>
  ): WorkStepTemperatureConfig {
    const merged = mergeWorkStepTemperature({
      ...this.getStepTemperature(workId),
      ...partial
    })
    this.run(
      `UPDATE works SET step_temperature_json = ?, update_time = datetime('now') WHERE id = ?`,
      [JSON.stringify(merged), workId]
    )
    return merged
  }

  resetStepTemperature(workId: number): WorkStepTemperatureConfig {
    this.run(
      `UPDATE works SET step_temperature_json = NULL, update_time = datetime('now') WHERE id = ?`,
      [workId]
    )
    return mergeWorkStepTemperature(null)
  }
}

export const workDAO = new WorkDAO()
