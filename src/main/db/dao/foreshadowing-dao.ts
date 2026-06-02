import { BaseDAO } from './base-dao'

export interface ForeshadowingRow {
  id: number
  work_id: number
  description: string
  plant_chapter_id: number | null
  plant_location: string | null
  payoff_chapter_id: number | null
  payoff_location: string | null
  status: 'pending' | 'partial' | 'resolved' | 'abandoned'
  depth: 'shallow' | 'normal' | 'deep' | null
  create_time: string
}

export type ForeshadowingDepth = 'shallow' | 'normal' | 'deep'

export type ForeshadowingStatus = 'pending' | 'partial' | 'resolved' | 'abandoned'

export class ForeshadowingDAO extends BaseDAO {
  listByWork(workId: number): ForeshadowingRow[] {
    return this.all<ForeshadowingRow>(
      'SELECT * FROM foreshadowing WHERE work_id = ? ORDER BY create_time',
      [workId]
    )
  }

  listPending(workId: number): ForeshadowingRow[] {
    return this.all<ForeshadowingRow>(
      "SELECT * FROM foreshadowing WHERE work_id = ? AND status IN ('pending', 'partial') ORDER BY create_time",
      [workId]
    )
  }

  getById(id: number): ForeshadowingRow | undefined {
    return this.get<ForeshadowingRow>('SELECT * FROM foreshadowing WHERE id = ?', [id])
  }

  create(input: {
    work_id: number
    description: string
    plant_chapter_id?: number
    plant_location?: string
    depth?: ForeshadowingDepth
  }): number {
    return this.insert(
      'INSERT INTO foreshadowing (work_id, description, plant_chapter_id, plant_location, depth) VALUES (?, ?, ?, ?, ?)',
      [input.work_id, input.description, input.plant_chapter_id ?? null, input.plant_location ?? null, input.depth ?? 'normal']
    )
  }

  resolve(id: number, payoff_chapter_id: number, payoff_location?: string): boolean {
    return this.run(
      "UPDATE foreshadowing SET status = 'resolved', payoff_chapter_id = ?, payoff_location = ? WHERE id = ?",
      [payoff_chapter_id, payoff_location ?? null, id]
    ).changes > 0
  }

  updateStatus(id: number, status: ForeshadowingStatus): boolean {
    return this.run('UPDATE foreshadowing SET status = ? WHERE id = ?', [status, id]).changes > 0
  }

  update(id: number, fields: Partial<Omit<ForeshadowingRow, 'id' | 'work_id' | 'create_time'>>): boolean {
    const sets: string[] = []
    const vals: unknown[] = []
    if (fields.description !== undefined) { sets.push('description = ?'); vals.push(fields.description) }
    if (fields.plant_chapter_id !== undefined) { sets.push('plant_chapter_id = ?'); vals.push(fields.plant_chapter_id) }
    if (fields.plant_location !== undefined) { sets.push('plant_location = ?'); vals.push(fields.plant_location) }
    if (fields.payoff_chapter_id !== undefined) { sets.push('payoff_chapter_id = ?'); vals.push(fields.payoff_chapter_id) }
    if (fields.payoff_location !== undefined) { sets.push('payoff_location = ?'); vals.push(fields.payoff_location) }
    if (fields.status !== undefined) { sets.push('status = ?'); vals.push(fields.status) }
    if (fields.depth !== undefined) { sets.push('depth = ?'); vals.push(fields.depth) }
    if (sets.length === 0) return false
    vals.push(id)
    return this.run(`UPDATE foreshadowing SET ${sets.join(', ')} WHERE id = ?`, vals).changes > 0
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM foreshadowing WHERE id = ?', [id]).changes > 0
  }

  deleteByPlantChapter(workId: number, chapterId: number): number {
    return this.run(
      'DELETE FROM foreshadowing WHERE work_id = ? AND plant_chapter_id = ?',
      [workId, chapterId]
    ).changes
  }

  revertPayoffsByChapter(workId: number, chapterId: number): number {
    return this.run(
      `UPDATE foreshadowing
       SET status = 'pending', payoff_chapter_id = NULL, payoff_location = NULL
       WHERE work_id = ? AND payoff_chapter_id = ? AND status = 'resolved'`,
      [workId, chapterId]
    ).changes
  }
}

export const foreshadowingDAO = new ForeshadowingDAO()
