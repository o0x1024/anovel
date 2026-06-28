import { BaseDAO } from './base-dao'

export interface KnowledgeNoteRow {
  id: number
  title: string
  content: string
  tags_json: string | null
  pinned: number
  create_time: string
  update_time: string
}

export interface KnowledgeNoteCreateInput {
  title?: string
  content: string
  tags?: string[]
  pinned?: boolean
}

export interface KnowledgeNoteUpdateInput {
  title?: string
  content?: string
  tags?: string[]
  pinned?: boolean
}

export class KnowledgeNoteDAO extends BaseDAO {
  list(): KnowledgeNoteRow[] {
    return this.all<KnowledgeNoteRow>(
      'SELECT * FROM knowledge_notes ORDER BY pinned DESC, update_time DESC'
    )
  }

  getById(id: number): KnowledgeNoteRow | undefined {
    return this.get<KnowledgeNoteRow>(
      'SELECT * FROM knowledge_notes WHERE id = ?',
      [id]
    )
  }

  search(keyword: string): KnowledgeNoteRow[] {
    const pattern = `%${keyword}%`
    return this.all<KnowledgeNoteRow>(
      `SELECT * FROM knowledge_notes
       WHERE title LIKE ? OR content LIKE ? OR tags_json LIKE ?
       ORDER BY pinned DESC, update_time DESC`,
      [pattern, pattern, pattern]
    )
  }

  listByTag(tag: string): KnowledgeNoteRow[] {
    const pattern = `%"${tag}"%`
    return this.all<KnowledgeNoteRow>(
      `SELECT * FROM knowledge_notes WHERE tags_json LIKE ?
       ORDER BY pinned DESC, update_time DESC`,
      [pattern]
    )
  }

  create(input: KnowledgeNoteCreateInput): number {
    const content = input.content.trim()
    if (!content) throw new Error('笔记内容不能为空')
    return this.insert(
      `INSERT INTO knowledge_notes (title, content, tags_json, pinned)
       VALUES (?, ?, ?, ?)`,
      [
        input.title?.trim() || '',
        content,
        input.tags?.length ? JSON.stringify(input.tags) : null,
        input.pinned ? 1 : 0
      ]
    )
  }

  update(id: number, input: KnowledgeNoteUpdateInput): boolean {
    const fields: string[] = []
    const params: unknown[] = []

    if (input.title !== undefined) {
      fields.push('title = ?')
      params.push(input.title.trim())
    }
    if (input.content !== undefined) {
      const content = input.content.trim()
      if (!content) throw new Error('笔记内容不能为空')
      fields.push('content = ?')
      params.push(content)
    }
    if (input.tags !== undefined) {
      fields.push('tags_json = ?')
      params.push(input.tags.length ? JSON.stringify(input.tags) : null)
    }
    if (input.pinned !== undefined) {
      fields.push('pinned = ?')
      params.push(input.pinned ? 1 : 0)
    }

    if (fields.length === 0) return false

    fields.push('update_time = CURRENT_TIMESTAMP')
    params.push(id)

    return this.run(
      `UPDATE knowledge_notes SET ${fields.join(', ')} WHERE id = ?`,
      params
    ).changes > 0
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM knowledge_notes WHERE id = ?', [id]).changes > 0
  }

  togglePin(id: number): boolean {
    return this.run(
      `UPDATE knowledge_notes SET pinned = CASE WHEN pinned = 1 THEN 0 ELSE 1 END, update_time = CURRENT_TIMESTAMP WHERE id = ?`,
      [id]
    ).changes > 0
  }

  allTags(): string[] {
    const rows = this.all<{ tags_json: string }>(
      `SELECT DISTINCT tags_json FROM knowledge_notes WHERE tags_json IS NOT NULL`
    )
    const tagSet = new Set<string>()
    for (const row of rows) {
      try {
        const arr = JSON.parse(row.tags_json) as string[]
        arr.forEach(t => tagSet.add(t))
      } catch { /* skip malformed */ }
    }
    return [...tagSet].sort()
  }
}

export const knowledgeNoteDAO = new KnowledgeNoteDAO()
