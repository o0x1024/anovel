import { createHash } from 'node:crypto'
import { BaseDAO } from './base-dao'

export interface NovelAuthorityStateRow {
  work_id: number
  revision: number
  state_hash: string
  state_json: string
  source_run_id: number | null
  create_time: string
  update_time: string
}

export interface LegacyNovelStateRow {
  runId: number
  stateJson: string
}

function stateHash(stateJson: string): string {
  return createHash('sha256').update(stateJson).digest('hex')
}

export class NovelAuthorityStateDAO extends BaseDAO {
  get(workId: number): NovelAuthorityStateRow | undefined {
    const row = super.get<NovelAuthorityStateRow>(
      'SELECT * FROM novel_authority_states WHERE work_id = ?',
      [workId]
    )
    if (row && stateHash(row.state_json) !== row.state_hash) {
      throw new Error(`作品 ${workId} 的小说权威状态校验失败`)
    }
    return row
  }

  findLatestLegacyState(workId: number): LegacyNovelStateRow | undefined {
    return super.get<LegacyNovelStateRow>(
      `SELECT id AS runId, state_json AS stateJson
       FROM workflow_runs
       WHERE work_id = ?
         AND workflow_type = 'novel'
         AND json_valid(state_json) = 1
         AND json_type(state_json, '$.novelOutline') = 'object'
       ORDER BY id DESC
       LIMIT 1`,
      [workId]
    )
  }

  create(workId: number, stateJson: string, sourceRunId: number | null): NovelAuthorityStateRow {
    this.run(
      `INSERT INTO novel_authority_states (
         work_id, revision, state_hash, state_json, source_run_id
       ) VALUES (?, 1, ?, ?, ?)`,
      [workId, stateHash(stateJson), stateJson, sourceRunId]
    )
    return this.get(workId)!
  }

  update(workId: number, expectedRevision: number, stateJson: string): NovelAuthorityStateRow {
    const result = this.run(
      `UPDATE novel_authority_states
       SET revision = revision + 1,
           state_hash = ?,
           state_json = ?,
           update_time = CURRENT_TIMESTAMP
       WHERE work_id = ? AND revision = ?`,
      [stateHash(stateJson), stateJson, workId, expectedRevision]
    )
    if (result.changes !== 1) {
      throw new Error(`作品 ${workId} 的小说权威状态修订冲突`)
    }
    return this.get(workId)!
  }
}

export const novelAuthorityStateDAO = new NovelAuthorityStateDAO()
