import { BaseDAO } from '../base-dao'

export interface IncubatorVersionRow {
  id: number
  work_id: number
  version_no: number
  label: string
  snapshot_json: string
  base_version_id: number | null
  is_frozen: number
  create_time: string
}

export class IncubatorVersionDAO extends BaseDAO {
  listByWork(workId: number): IncubatorVersionRow[] {
    return this.all<IncubatorVersionRow>(
      `SELECT * FROM incubator_storyline_versions
       WHERE work_id = ?
       ORDER BY version_no DESC`,
      [workId]
    )
  }

  getLatestFrozen(workId: number): IncubatorVersionRow | undefined {
    return this.get<IncubatorVersionRow>(
      `SELECT * FROM incubator_storyline_versions
       WHERE work_id = ? AND is_frozen = 1
       ORDER BY version_no DESC
       LIMIT 1`,
      [workId]
    )
  }

  getById(id: number): IncubatorVersionRow | undefined {
    return this.get<IncubatorVersionRow>(
      'SELECT * FROM incubator_storyline_versions WHERE id = ?',
      [id]
    )
  }

  sanitizeInvalidBaseVersions(workId: number): void {
    this.run(
      `UPDATE incubator_storyline_versions
       SET base_version_id = NULL
       WHERE work_id = ?
         AND base_version_id IS NOT NULL
         AND base_version_id NOT IN (SELECT id FROM incubator_storyline_versions)`,
      [workId]
    )
  }

  create(input: {
    workId: number
    label: string
    snapshotJson: string
    baseVersionId?: number | null
    isFrozen?: boolean
  }): number {
    const latest = this.get<{ v: number }>(
      'SELECT COALESCE(MAX(version_no), 0) + 1 AS v FROM incubator_storyline_versions WHERE work_id = ?',
      [input.workId]
    )
    return this.insert(
      `INSERT INTO incubator_storyline_versions (
        work_id, version_no, label, snapshot_json, base_version_id, is_frozen
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.workId,
        latest?.v ?? 1,
        input.label,
        input.snapshotJson,
        input.baseVersionId ?? null,
        input.isFrozen ? 1 : 0
      ]
    )
  }
}

export const incubatorVersionDAO = new IncubatorVersionDAO()
