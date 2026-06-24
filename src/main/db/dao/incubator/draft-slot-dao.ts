import { BaseDAO } from '../base-dao'
import type { IncubatorSlotKey } from '../../../../shared/incubator-slots'
import { incubatorCandidateDAO } from './candidate-dao'

export interface IncubatorDraftSlotRow {
  id: number
  work_id: number
  slot_key: string
  content: string
  source_candidate_id: number | null
  status: string
  version_tag: string
  create_time: string
  update_time: string
}

export class IncubatorDraftSlotDAO extends BaseDAO {
  listActiveByWork(workId: number): IncubatorDraftSlotRow[] {
    return this.all<IncubatorDraftSlotRow>(
      `SELECT * FROM incubator_storyline_draft_slots
       WHERE work_id = ? AND status = 'active' AND version_tag = 'draft-current'
       ORDER BY slot_key`,
      [workId]
    )
  }

  getActiveSlot(workId: number, slotKey: IncubatorSlotKey): IncubatorDraftSlotRow | undefined {
    return this.get<IncubatorDraftSlotRow>(
      `SELECT * FROM incubator_storyline_draft_slots
       WHERE work_id = ? AND slot_key = ? AND status = 'active' AND version_tag = 'draft-current'
       ORDER BY update_time DESC, id DESC
       LIMIT 1`,
      [workId, slotKey]
    )
  }

  upsertActiveSlot(input: {
    workId: number
    slotKey: IncubatorSlotKey
    content: string
    sourceCandidateId?: number | null
  }): IncubatorDraftSlotRow {
    const sourceId = this.resolveSourceCandidateId(input.workId, input.sourceCandidateId)
    const existing = this.getActiveSlot(input.workId, input.slotKey)
    if (existing) {
      this.run(
        `UPDATE incubator_storyline_draft_slots
         SET content = ?, source_candidate_id = ?, update_time = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [input.content, sourceId, existing.id]
      )
      return { ...existing, content: input.content, source_candidate_id: sourceId }
    }
    const id = this.insert(
      `INSERT INTO incubator_storyline_draft_slots (
        work_id, slot_key, content, source_candidate_id, status, version_tag
      ) VALUES (?, ?, ?, ?, 'active', 'draft-current')`,
      [input.workId, input.slotKey, input.content, sourceId]
    )
    return this.get<IncubatorDraftSlotRow>(
      'SELECT * FROM incubator_storyline_draft_slots WHERE id = ?',
      [id]
    )!
  }

  clearActiveSlot(workId: number, slotKey: IncubatorSlotKey): void {
    this.run(
      `DELETE FROM incubator_storyline_draft_slots
       WHERE work_id = ? AND slot_key = ? AND status = 'active' AND version_tag = 'draft-current'`,
      [workId, slotKey]
    )
  }

  countFilledSlots(workId: number): number {
    const rows = this.listActiveByWork(workId)
    return rows.filter(r => r.content.trim().length > 0).length
  }

  listFilledSlotKeys(workId: number): IncubatorSlotKey[] {
    const rows = this.listActiveByWork(workId)
    return rows
      .filter(r => r.content.trim().length > 0)
      .map(r => r.slot_key as IncubatorSlotKey)
  }

  /** 清除指向已删除候选的 source_candidate_id，避免 FK 写入失败 */
  private resolveSourceCandidateId(workId: number, candidateId: number | null | undefined): number | null {
    if (candidateId == null) return null
    const row = incubatorCandidateDAO.getById(candidateId)
    return row && row.work_id === workId ? candidateId : null
  }

  sanitizeInvalidSourceCandidates(workId: number): void {
    this.run(
      `UPDATE incubator_storyline_draft_slots
       SET source_candidate_id = NULL
       WHERE work_id = ?
         AND source_candidate_id IS NOT NULL
         AND source_candidate_id NOT IN (SELECT id FROM incubator_candidates)`,
      [workId]
    )
  }
}

export const incubatorDraftSlotDAO = new IncubatorDraftSlotDAO()
