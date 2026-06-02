import { BaseDAO } from './base-dao'

export interface AiFavoriteRow {
  id: number
  work_id: number
  source_step: string
  source_label: string
  title: string | null
  content: string
  source_input: string | null
  create_time: string
}

export class AiFavoriteDAO extends BaseDAO {
  listByWork(workId: number): AiFavoriteRow[] {
    return this.all<AiFavoriteRow>(
      'SELECT * FROM ai_favorites WHERE work_id = ? ORDER BY create_time DESC',
      [workId]
    )
  }

  getById(id: number): AiFavoriteRow | undefined {
    return this.get<AiFavoriteRow>('SELECT * FROM ai_favorites WHERE id = ?', [id])
  }

  create(input: {
    work_id: number
    source_step: string
    source_label: string
    content: string
    title?: string
    source_input?: string
  }): number {
    const title = input.title?.trim() || deriveTitle(input.source_label, input.content)
    return this.insert(
      `INSERT INTO ai_favorites (work_id, source_step, source_label, title, content, source_input)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.work_id,
        input.source_step,
        input.source_label,
        title,
        input.content,
        input.source_input ?? null
      ]
    )
  }

  update(id: number, fields: { title?: string }): boolean {
    if (fields.title === undefined) return false
    return this.run('UPDATE ai_favorites SET title = ? WHERE id = ?', [fields.title, id]).changes > 0
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM ai_favorites WHERE id = ?', [id]).changes > 0
  }
}

function deriveTitle(sourceLabel: string, content: string): string {
  const plain = content
    .replace(/^#+\s+/gm, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const excerpt = plain.slice(0, 40)
  return excerpt ? `${sourceLabel} · ${excerpt}${plain.length > 40 ? '…' : ''}` : sourceLabel
}

export const aiFavoriteDAO = new AiFavoriteDAO()
