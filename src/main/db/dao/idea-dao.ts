import { BaseDAO } from './base-dao'

export interface IdeaFragmentRow {
  id: number
  work_id: number | null
  type: string
  content: string
  tags: string | null
  is_merged: number
  merged_target: string | null
  create_time: string
}

export const IDEA_TYPES = ['scene', 'character', 'dialogue', 'plot_twist', 'image'] as const

export class IdeaFragmentDAO extends BaseDAO {
  /** 获取作品的所有灵感碎片 */
  listByWork(workId: number): IdeaFragmentRow[] {
    return this.all<IdeaFragmentRow>(
      'SELECT * FROM idea_fragments WHERE work_id = ? AND is_merged = 0 ORDER BY create_time DESC',
      [workId]
    )
  }

  /** 获取未关联作品的独立灵感 */
  listOrphan(): IdeaFragmentRow[] {
    return this.all<IdeaFragmentRow>(
      'SELECT * FROM idea_fragments WHERE work_id IS NULL AND is_merged = 0 ORDER BY create_time DESC'
    )
  }

  /** 按类型筛选 */
  listByType(workId: number | null, type: string): IdeaFragmentRow[] {
    const params: unknown[] = [type]
    let sql = 'SELECT * FROM idea_fragments WHERE type = ? AND is_merged = 0'
    if (workId !== null) {
      sql += ' AND work_id = ?'
      params.push(workId)
    }
    return this.all<IdeaFragmentRow>(sql, params)
  }

  getById(id: number): IdeaFragmentRow | undefined {
    return this.get<IdeaFragmentRow>('SELECT * FROM idea_fragments WHERE id = ?', [id])
  }

  create(input: {
    work_id?: number
    type: string
    content: string
    tags?: string
  }): number {
    return this.insert(
      'INSERT INTO idea_fragments (work_id, type, content, tags) VALUES (?, ?, ?, ?)',
      [input.work_id ?? null, input.type, input.content, input.tags ?? null]
    )
  }

  update(id: number, fields: { content?: string; tags?: string; type?: string }): boolean {
    const sets: string[] = []
    const vals: unknown[] = []
    if (fields.content !== undefined) { sets.push('content = ?'); vals.push(fields.content) }
    if (fields.tags !== undefined) { sets.push('tags = ?'); vals.push(fields.tags) }
    if (fields.type !== undefined) { sets.push('type = ?'); vals.push(fields.type) }
    if (sets.length === 0) return false
    vals.push(id)
    return this.run(`UPDATE idea_fragments SET ${sets.join(', ')} WHERE id = ?`, vals).changes > 0
  }

  /** 标记为已合龙 */
  markMerged(id: number, target: string): boolean {
    return this.run(
      'UPDATE idea_fragments SET is_merged = 1, merged_target = ? WHERE id = ?',
      [target, id]
    ).changes > 0
  }

  /** 关联到作品 */
  linkToWork(id: number, workId: number): boolean {
    return this.run('UPDATE idea_fragments SET work_id = ? WHERE id = ?', [workId, id]).changes > 0
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM idea_fragments WHERE id = ?', [id]).changes > 0
  }
}

export const ideaFragmentDAO = new IdeaFragmentDAO()
