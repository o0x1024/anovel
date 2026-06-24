import { BaseDAO } from './base-dao'

export interface TimelineEventRow {
  id: number
  work_id: number
  event_name: string
  event_description: string | null
  absolute_time: string | null
  relative_time: string | null
  chapter_id: number | null
  sort_order: number | null
  create_time: string
}

export class TimelineDAO extends BaseDAO {
  listByWork(workId: number): TimelineEventRow[] {
    return this.all<TimelineEventRow>(
      'SELECT * FROM story_timeline WHERE work_id = ? ORDER BY sort_order, create_time',
      [workId]
    )
  }

  getById(id: number): TimelineEventRow | undefined {
    return this.get<TimelineEventRow>('SELECT * FROM story_timeline WHERE id = ?', [id])
  }

  create(input: {
    work_id: number
    event_name: string
    event_description?: string
    absolute_time?: string
    relative_time?: string
    chapter_id?: number
    sort_order?: number
  }): number {
    return this.insert(
      `INSERT INTO story_timeline
       (work_id, event_name, event_description, absolute_time, relative_time, chapter_id, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.work_id, input.event_name,
        input.event_description ?? null, input.absolute_time ?? null,
        input.relative_time ?? null, input.chapter_id ?? null,
        input.sort_order ?? null
      ]
    )
  }

  update(id: number, fields: Partial<Omit<TimelineEventRow, 'id' | 'work_id' | 'create_time'>>): boolean {
    const sets: string[] = []
    const vals: unknown[] = []
    if (fields.event_name !== undefined) { sets.push('event_name = ?'); vals.push(fields.event_name) }
    if (fields.event_description !== undefined) { sets.push('event_description = ?'); vals.push(fields.event_description) }
    if (fields.absolute_time !== undefined) { sets.push('absolute_time = ?'); vals.push(fields.absolute_time) }
    if (fields.relative_time !== undefined) { sets.push('relative_time = ?'); vals.push(fields.relative_time) }
    if (fields.chapter_id !== undefined) { sets.push('chapter_id = ?'); vals.push(fields.chapter_id) }
    if (fields.sort_order !== undefined) { sets.push('sort_order = ?'); vals.push(fields.sort_order) }
    if (sets.length === 0) return false
    vals.push(id)
    return this.run(`UPDATE story_timeline SET ${sets.join(', ')} WHERE id = ?`, vals).changes > 0
  }

  reorder(workId: number, orderedIds: number[]): void {
    this.transaction(() => {
      orderedIds.forEach((id, index) => {
        this.run('UPDATE story_timeline SET sort_order = ? WHERE id = ? AND work_id = ?', [index + 1, id, workId])
      })
    })
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM story_timeline WHERE id = ?', [id]).changes > 0
  }

  deleteByWork(workId: number): number {
    const result = this.run('DELETE FROM story_timeline WHERE work_id = ?', [workId])
    return result.changes
  }
}

export const timelineDAO = new TimelineDAO()
