import { BaseDAO } from './base-dao'

const MAX_VERSIONS = 10

export interface CoreSettingRow {
  id: number
  work_id: number
  type: string
  content: string
  create_time: string
  update_time?: string
}

export interface CoreSettingVersionRow {
  id: number
  work_id: number
  type: string
  content: string
  version_number: number
  create_time: string
}

export type CoreSettingType = 'character' | 'worldview' | 'conflict' | 'idea' | string

export class CoreSettingDAO extends BaseDAO {
  listByWork(workId: number): CoreSettingRow[] {
    return this.all<CoreSettingRow>(
      'SELECT * FROM core_settings WHERE work_id = ? ORDER BY type, create_time',
      [workId]
    )
  }

  getByType(workId: number, type: CoreSettingType): CoreSettingRow | undefined {
    return this.get<CoreSettingRow>(
      'SELECT * FROM core_settings WHERE work_id = ? AND type = ?', [workId, type]
    )
  }

  getMeta(workId: number, type: CoreSettingType): { updateTime: string | null; hasContent: boolean } {
    const row = this.getByType(workId, type)
    return {
      updateTime: row?.update_time ?? row?.create_time ?? null,
      hasContent: !!row?.content?.trim()
    }
  }

  listVersions(workId: number, type: CoreSettingType, limit = MAX_VERSIONS): CoreSettingVersionRow[] {
    return this.all<CoreSettingVersionRow>(
      `SELECT * FROM core_setting_versions
       WHERE work_id = ? AND type = ?
       ORDER BY version_number DESC
       LIMIT ?`,
      [workId, type, limit]
    )
  }

  /** 更新或插入（每种类型只保留一条）；变更前自动保存版本快照 */
  upsert(workId: number, type: CoreSettingType, content: string): void {
    const existing = this.getByType(workId, type)
    if (existing) {
      if (existing.content !== content) {
        this.createVersion(workId, type, existing.content)
      }
      this.run(
        'UPDATE core_settings SET content = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?',
        [content, existing.id]
      )
    } else {
      this.insert(
        'INSERT INTO core_settings (work_id, type, content, update_time) VALUES (?, ?, ?, CURRENT_TIMESTAMP)',
        [workId, type, content]
      )
    }
  }

  restoreVersion(workId: number, type: CoreSettingType, versionId: number): boolean {
    const version = this.get<CoreSettingVersionRow>(
      'SELECT * FROM core_setting_versions WHERE id = ? AND work_id = ? AND type = ?',
      [versionId, workId, type]
    )
    if (!version) return false
    this.upsert(workId, type, version.content)
    return true
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM core_settings WHERE id = ?', [id]).changes > 0
  }

  /** 删除指定 type 的设定及其版本快照 */
  deleteByWorkAndTypes(workId: number, types: string[]): number {
    if (!types.length) return 0
    let deleted = 0
    for (const type of types) {
      const row = this.getByType(workId, type)
      if (row && this.delete(row.id)) deleted++
      this.run(
        'DELETE FROM core_setting_versions WHERE work_id = ? AND type = ?',
        [workId, type]
      )
    }
    return deleted
  }

  private createVersion(workId: number, type: CoreSettingType, content: string): void {
    const latest = this.get<{ v: number }>(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS v FROM core_setting_versions WHERE work_id = ? AND type = ?',
      [workId, type]
    )
    this.insert(
      `INSERT INTO core_setting_versions (work_id, type, content, version_number)
       VALUES (?, ?, ?, ?)`,
      [workId, type, content, latest?.v ?? 1]
    )
    this.trimVersions(workId, type)
  }

  private trimVersions(workId: number, type: CoreSettingType): void {
    const overflow = this.all<{ id: number }>(
      `SELECT id FROM core_setting_versions
       WHERE work_id = ? AND type = ?
       ORDER BY version_number DESC
       LIMIT -1 OFFSET ?`,
      [workId, type, MAX_VERSIONS]
    )
    for (const row of overflow) {
      this.run('DELETE FROM core_setting_versions WHERE id = ?', [row.id])
    }
  }
}

export const coreSettingDAO = new CoreSettingDAO()
