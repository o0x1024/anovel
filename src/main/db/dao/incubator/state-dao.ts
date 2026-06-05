import { BaseDAO } from '../base-dao'
import type { IncubatorWorkflowState } from '../../../../shared/incubator-types'
import { incubatorVersionDAO } from './version-dao'

export interface IncubatorWorkflowStateRow {
  work_id: number
  state: string
  last_gate_report_json: string | null
  last_adopt_json: string | null
  branch_base_version_id: number | null
  update_time: string
}

export class IncubatorStateDAO extends BaseDAO {
  /** 勿命名为 get，会与 BaseDAO.get(sql) 冲突导致无限递归 */
  getByWork(workId: number): IncubatorWorkflowStateRow | undefined {
    return super.get<IncubatorWorkflowStateRow>(
      'SELECT * FROM incubator_workflow_states WHERE work_id = ?',
      [workId]
    )
  }

  ensure(workId: number, initial: IncubatorWorkflowState = 'SeedReady'): IncubatorWorkflowStateRow {
    const existing = this.getByWork(workId)
    if (existing) return existing
    this.insert(
      'INSERT INTO incubator_workflow_states (work_id, state) VALUES (?, ?)',
      [workId, initial]
    )
    return this.getByWork(workId)!
  }

  setState(workId: number, state: IncubatorWorkflowState): void {
    this.ensure(workId)
    this.run(
      `UPDATE incubator_workflow_states
       SET state = ?, update_time = CURRENT_TIMESTAMP
       WHERE work_id = ?`,
      [state, workId]
    )
  }

  setLastGateReport(workId: number, json: string | null): void {
    this.ensure(workId)
    this.run(
      `UPDATE incubator_workflow_states
       SET last_gate_report_json = ?, update_time = CURRENT_TIMESTAMP
       WHERE work_id = ?`,
      [json, workId]
    )
  }

  setLastAdopt(workId: number, json: string | null): void {
    this.ensure(workId)
    this.run(
      `UPDATE incubator_workflow_states
       SET last_adopt_json = ?, update_time = CURRENT_TIMESTAMP
       WHERE work_id = ?`,
      [json, workId]
    )
  }

  sanitizeInvalidBranchBase(workId: number): void {
    this.run(
      `UPDATE incubator_workflow_states
       SET branch_base_version_id = NULL
       WHERE work_id = ?
         AND branch_base_version_id IS NOT NULL
         AND branch_base_version_id NOT IN (SELECT id FROM incubator_storyline_versions)`,
      [workId]
    )
  }

  setBranchBaseVersion(workId: number, versionId: number | null): void {
    this.ensure(workId)
    let resolved: number | null = versionId
    if (versionId != null) {
      const v = incubatorVersionDAO.getById(versionId)
      if (!v || v.work_id !== workId) resolved = null
    }
    this.run(
      `UPDATE incubator_workflow_states
       SET branch_base_version_id = ?, update_time = CURRENT_TIMESTAMP
       WHERE work_id = ?`,
      [resolved, workId]
    )
  }

  getBranchBaseVersion(workId: number): number | null {
    const row = this.getByWork(workId)
    return row?.branch_base_version_id ?? null
  }
}

export const incubatorStateDAO = new IncubatorStateDAO()
