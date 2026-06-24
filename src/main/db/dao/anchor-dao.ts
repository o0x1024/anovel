import { BaseDAO } from './base-dao'

export interface AnchorRow {
  id: number
  work_id: number
  type: string
  title: string
  content: string
  scope: string | null
  is_active: number
  created_step: string | null
  target_chapter_id: number | null
  target_volume_id: number | null
  create_time: string
}

export interface AnchorCreateInput {
  work_id: number
  type: string
  title: string
  content: string
  scope?: string | null
  created_step?: string
  target_chapter_id?: number | null
  target_volume_id?: number | null
}

/** 锚点类型常量 */
export const ANCHOR_TYPES = ['scene', 'character', 'plot', 'emotion', 'structure', 'memory', 'contrast'] as const

export class AnchorDAO extends BaseDAO {
  /** 获取作品的所有锚点（按类型分组） */
  listByWork(workId: number): AnchorRow[] {
    return this.all<AnchorRow>(
      'SELECT * FROM anchors WHERE work_id = ? ORDER BY type, create_time',
      [workId]
    )
  }

  /** 获取作品的有效锚点 */
  listActiveByWork(workId: number): AnchorRow[] {
    return this.all<AnchorRow>(
      'SELECT * FROM anchors WHERE work_id = ? AND is_active = 1 ORDER BY type, create_time',
      [workId]
    )
  }

  /** 按类型获取锚点 */
  listByType(workId: number, type: string): AnchorRow[] {
    return this.all<AnchorRow>(
      'SELECT * FROM anchors WHERE work_id = ? AND type = ? AND is_active = 1',
      [workId, type]
    )
  }

  getById(id: number): AnchorRow | undefined {
    return this.get<AnchorRow>('SELECT * FROM anchors WHERE id = ?', [id])
  }

  create(input: AnchorCreateInput): number {
    return this.insert(
      'INSERT INTO anchors (work_id, type, title, content, scope, created_step, target_chapter_id, target_volume_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        input.work_id,
        input.type,
        input.title,
        input.content,
        input.scope ?? null,
        input.created_step ?? null,
        input.target_chapter_id ?? null,
        input.target_volume_id ?? null
      ]
    )
  }

  update(id: number, fields: {
    title?: string
    content?: string
    type?: string
    scope?: string | null
    target_chapter_id?: number | null
    target_volume_id?: number | null
  }): boolean {
    const sets: string[] = []
    const vals: unknown[] = []
    if (fields.title !== undefined) { sets.push('title = ?'); vals.push(fields.title) }
    if (fields.content !== undefined) { sets.push('content = ?'); vals.push(fields.content) }
    if (fields.type !== undefined) { sets.push('type = ?'); vals.push(fields.type) }
    if (fields.scope !== undefined) { sets.push('scope = ?'); vals.push(fields.scope) }
    if (fields.target_chapter_id !== undefined) { sets.push('target_chapter_id = ?'); vals.push(fields.target_chapter_id) }
    if (fields.target_volume_id !== undefined) { sets.push('target_volume_id = ?'); vals.push(fields.target_volume_id) }
    if (sets.length === 0) return false
    vals.push(id)
    return this.run(`UPDATE anchors SET ${sets.join(', ')} WHERE id = ?`, vals).changes > 0
  }

  /** 开关锚点 */
  toggleActive(id: number, active: boolean): boolean {
    return this.run('UPDATE anchors SET is_active = ? WHERE id = ?', [active ? 1 : 0, id]).changes > 0
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM anchors WHERE id = ?', [id]).changes > 0
  }

  batchCreate(inputs: AnchorCreateInput[]): number[] {
    return inputs.map(input => this.create(input))
  }
}

export const anchorDAO = new AnchorDAO()
