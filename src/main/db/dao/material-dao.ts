import { BaseDAO } from './base-dao'

export interface MaterialRow {
  id: number
  work_id: number | null
  category: string
  title: string | null
  content: string
  create_time: string
}

export class MaterialDAO extends BaseDAO {
  listGlobal(): MaterialRow[] {
    return this.all<MaterialRow>(
      'SELECT * FROM materials WHERE work_id IS NULL ORDER BY category, create_time DESC'
    )
  }

  listByWork(workId: number): MaterialRow[] {
    return this.all<MaterialRow>(
      'SELECT * FROM materials WHERE work_id = ? OR work_id IS NULL ORDER BY category, create_time DESC',
      [workId]
    )
  }

  create(input: { work_id?: number; category: string; title?: string; content: string }): number {
    return this.insert(
      'INSERT INTO materials (work_id, category, title, content) VALUES (?, ?, ?, ?)',
      [input.work_id ?? null, input.category, input.title ?? null, input.content]
    )
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM materials WHERE id = ?', [id]).changes > 0
  }
}

export const materialDAO = new MaterialDAO()
