import type { WordTableEntryInput, WordTableEntryRow } from '../../../shared/aigc-wordtable-types'
import { BaseDAO } from './base-dao'

export class AigcWordtableDAO extends BaseDAO {
  list(): WordTableEntryRow[] {
    return this.all<WordTableEntryRow>(
      'SELECT * FROM aigc_wordtable ORDER BY create_time DESC'
    )
  }

  listEnabled(): WordTableEntryRow[] {
    return this.all<WordTableEntryRow>(
      'SELECT * FROM aigc_wordtable WHERE enabled = 1 ORDER BY id'
    )
  }

  getById(id: number): WordTableEntryRow | undefined {
    return this.get<WordTableEntryRow>(
      'SELECT * FROM aigc_wordtable WHERE id = ?',
      [id]
    )
  }

  create(input: WordTableEntryInput): number {
    const source = input.source.trim()
    if (!source) throw new Error('匹配内容不能为空')
    return this.insert(
      `INSERT INTO aigc_wordtable (type, source, target, enabled, update_time)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [input.type, source, (input.target || '').trim(), input.enabled !== false ? 1 : 0]
    )
  }

  update(id: number, input: Partial<WordTableEntryInput>): boolean {
    const existing = this.getById(id)
    if (!existing) return false
    const type = input.type ?? existing.type
    const source = (input.source ?? existing.source).trim()
    const target = (input.target ?? existing.target).trim()
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled
    if (!source) throw new Error('匹配内容不能为空')
    this.run(
      `UPDATE aigc_wordtable SET type = ?, source = ?, target = ?, enabled = ?, update_time = datetime('now') WHERE id = ?`,
      [type, source, target, enabled, id]
    )
    return true
  }

  toggleEnabled(id: number, enabled: boolean): boolean {
    const result = this.run(
      'UPDATE aigc_wordtable SET enabled = ?, update_time = datetime(\'now\') WHERE id = ?',
      [enabled ? 1 : 0, id]
    )
    return result.changes > 0
  }

  delete(id: number): boolean {
    const result = this.run('DELETE FROM aigc_wordtable WHERE id = ?', [id])
    return result.changes > 0
  }

  batchDelete(ids: number[]): number {
    if (ids.length === 0) return 0
    let count = 0
    this.transaction(() => {
      for (const id of ids) {
        const result = this.run('DELETE FROM aigc_wordtable WHERE id = ?', [id])
        count += result.changes
      }
    })
    return count
  }

  deleteAll(): number {
    const result = this.run('DELETE FROM aigc_wordtable')
    return result.changes
  }

  batchCreate(entries: WordTableEntryInput[]): number {
    let count = 0
    this.transaction(() => {
      for (const entry of entries) {
        const source = entry.source.trim()
        if (!source) continue
        this.insert(
          `INSERT INTO aigc_wordtable (type, source, target, enabled, update_time)
           VALUES (?, ?, ?, 1, datetime('now'))`,
          [entry.type, source, (entry.target || '').trim()]
        )
        count++
      }
    })
    return count
  }
}

export const aigcWordtableDAO = new AigcWordtableDAO()
