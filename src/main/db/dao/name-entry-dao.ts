import { BaseDAO } from './base-dao'
import type {
  NameCategory,
  NameEntryCreateInput,
  NameEntryRow,
  NameEntryStatus
} from '../../../shared/name-registry-types'

export class NameEntryDAO extends BaseDAO {
  listByWork(workId: number, category?: NameCategory, status?: NameEntryStatus): NameEntryRow[] {
    let sql = 'SELECT * FROM name_entries WHERE work_id = ?'
    const params: unknown[] = [workId]
    if (category) {
      sql += ' AND category = ?'
      params.push(category)
    }
    if (status) {
      sql += ' AND status = ?'
      params.push(status)
    }
    sql += " ORDER BY CASE status WHEN 'adopted' THEN 0 WHEN 'candidate' THEN 1 ELSE 2 END, create_time DESC"
    return this.all<NameEntryRow>(sql, params)
  }

  getById(id: number): NameEntryRow | undefined {
    return this.get<NameEntryRow>('SELECT * FROM name_entries WHERE id = ?', [id])
  }

  findByName(workId: number, name: string, excludeId?: number): NameEntryRow | undefined {
    const trimmed = name.trim()
    if (!trimmed) return undefined
    let sql = 'SELECT * FROM name_entries WHERE work_id = ? AND name = ? COLLATE NOCASE'
    const params: unknown[] = [workId, trimmed]
    if (excludeId != null) {
      sql += ' AND id != ?'
      params.push(excludeId)
    }
    return this.get<NameEntryRow>(sql, params)
  }

  create(input: NameEntryCreateInput): number {
    return this.insert(
      `INSERT INTO name_entries (
        work_id, category, name, meaning, constraints_json, status, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.work_id,
        input.category,
        input.name.trim(),
        input.meaning?.trim() || null,
        input.constraints_json ?? null,
        input.status ?? 'candidate',
        input.source ?? 'manual'
      ]
    )
  }

  createMany(inputs: NameEntryCreateInput[]): number[] {
    return this.transaction(() => {
      const ids: number[] = []
      for (const row of inputs) {
        ids.push(this.create(row))
      }
      return ids
    })
  }

  updateStatus(id: number, status: NameEntryStatus, linkedEntity?: string | null): boolean {
    return this.run(
      'UPDATE name_entries SET status = ?, linked_entity = COALESCE(?, linked_entity) WHERE id = ?',
      [status, linkedEntity ?? null, id]
    ).changes > 0
  }

  update(id: number, patch: { name?: string; meaning?: string | null; status?: NameEntryStatus }): boolean {
    const sets: string[] = []
    const vals: unknown[] = []
    if (patch.name != null) {
      sets.push('name = ?')
      vals.push(patch.name.trim())
    }
    if (patch.meaning !== undefined) {
      sets.push('meaning = ?')
      vals.push(patch.meaning?.trim() || null)
    }
    if (patch.status != null) {
      sets.push('status = ?')
      vals.push(patch.status)
    }
    if (sets.length === 0) return false
    vals.push(id)
    return this.run(`UPDATE name_entries SET ${sets.join(', ')} WHERE id = ?`, vals).changes > 0
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM name_entries WHERE id = ?', [id]).changes > 0
  }

  listAdoptedNames(workId: number): string[] {
    const rows = this.all<{ name: string }>(
      'SELECT name FROM name_entries WHERE work_id = ? AND status = ? ORDER BY name',
      [workId, 'adopted']
    )
    return rows.map(r => r.name)
  }
}

export const nameEntryDAO = new NameEntryDAO()
