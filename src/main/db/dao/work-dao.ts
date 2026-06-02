import { BaseDAO } from './base-dao'

export interface WorkRow {
  id: number
  title: string
  description: string | null
  cover_image: string | null
  create_time: string
  update_time: string
}

export interface WorkCreateInput {
  title: string
  description?: string
  cover_image?: string
}

export class WorkDAO extends BaseDAO {
  /** 获取所有作品（按更新时间倒序） */
  list(): WorkRow[] {
    return this.all<WorkRow>('SELECT * FROM works ORDER BY update_time DESC')
  }

  /** 根据 ID 获取作品 */
  getById(id: number): WorkRow | undefined {
    return this.get<WorkRow>('SELECT * FROM works WHERE id = ?', [id])
  }

  /** 创建新作品 */
  create(input: WorkCreateInput): number {
    return this.insert(
      'INSERT INTO works (title, description, cover_image) VALUES (?, ?, ?)',
      [input.title, input.description ?? null, input.cover_image ?? null]
    )
  }

  /** 更新作品 */
  update(id: number, input: Partial<WorkCreateInput>): boolean {
    const fields: string[] = []
    const values: unknown[] = []

    if (input.title !== undefined) { fields.push('title = ?'); values.push(input.title) }
    if (input.description !== undefined) { fields.push('description = ?'); values.push(input.description) }
    if (input.cover_image !== undefined) { fields.push('cover_image = ?'); values.push(input.cover_image) }

    if (fields.length === 0) return false

    fields.push("update_time = datetime('now')")
    values.push(id)

    const result = this.run(`UPDATE works SET ${fields.join(', ')} WHERE id = ?`, values)
    return result.changes > 0
  }

  /** 删除作品 */
  delete(id: number): boolean {
    const result = this.run('DELETE FROM works WHERE id = ?', [id])
    return result.changes > 0
  }
}

export const workDAO = new WorkDAO()
