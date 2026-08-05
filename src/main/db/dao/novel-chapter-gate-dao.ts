import { BaseDAO } from './base-dao'

export type NovelChapterGateType = 'quality' | 'emotion' | 'execution_contract'
export type NovelChapterGateStatus =
  | 'pending'
  | 'deferred'
  | 'passed_model'
  | 'passed_author'
  | 'failed'
  | 'stale'

export interface NovelChapterGateStateRow {
  id: number
  episode_id: number
  candidate_id: number
  gate_type: NovelChapterGateType
  status: NovelChapterGateStatus
  score: number | null
  failure_code: string | null
  failure_reason: string | null
  blockers_json: string
  evidence_json: string
  assessment_count: number
  repair_count: number
  create_time: string
  update_time: string
}

export interface NovelChapterGateDecisionRow {
  id: number
  episode_id: number
  candidate_id: number
  gate_type: NovelChapterGateType
  decision_type: 'approved_by_author'
  content_hash: string
  contract_hash: string
  assessment_id: number | null
  note: string
  actor: string
  decision_revision: number
  create_time: string
}

export class NovelChapterGateDAO extends BaseDAO {
  ensureStates(episodeId: number, candidateId: number): void {
    this.transaction(() => {
      for (const gateType of ['quality', 'emotion', 'execution_contract'] as const) {
        this.run(
          `INSERT OR IGNORE INTO novel_chapter_gate_states (
             episode_id, candidate_id, gate_type, status,
             blockers_json, evidence_json
           ) VALUES (?, ?, ?, 'pending', '[]', '[]')`,
          [episodeId, candidateId, gateType]
        )
      }
    })
  }

  getState(
    episodeId: number,
    candidateId: number,
    gateType: NovelChapterGateType
  ): NovelChapterGateStateRow | undefined {
    return this.get<NovelChapterGateStateRow>(
      `SELECT * FROM novel_chapter_gate_states
       WHERE episode_id = ? AND candidate_id = ? AND gate_type = ?`,
      [episodeId, candidateId, gateType]
    )
  }

  listStates(episodeId: number, candidateId: number): NovelChapterGateStateRow[] {
    this.ensureStates(episodeId, candidateId)
    return this.all<NovelChapterGateStateRow>(
      `SELECT * FROM novel_chapter_gate_states
       WHERE episode_id = ? AND candidate_id = ?
       ORDER BY CASE gate_type
         WHEN 'quality' THEN 1
         WHEN 'emotion' THEN 2
         ELSE 3
       END`,
      [episodeId, candidateId]
    )
  }

  setState(input: {
    episodeId: number
    candidateId: number
    gateType: NovelChapterGateType
    status: NovelChapterGateStatus
    score?: number | null
    failureCode?: string | null
    failureReason?: string | null
    blockers?: string[]
    evidence?: unknown[]
    incrementAssessment?: boolean
    incrementRepair?: boolean
  }): NovelChapterGateStateRow {
    this.ensureStates(input.episodeId, input.candidateId)
    this.run(
      `UPDATE novel_chapter_gate_states
       SET status = ?, score = ?, failure_code = ?, failure_reason = ?,
           blockers_json = ?, evidence_json = ?,
           assessment_count = assessment_count + ?,
           repair_count = repair_count + ?,
           update_time = CURRENT_TIMESTAMP
       WHERE episode_id = ? AND candidate_id = ? AND gate_type = ?`,
      [
        input.status,
        input.score ?? null,
        input.failureCode ?? null,
        input.failureReason ?? null,
        JSON.stringify(input.blockers ?? []),
        JSON.stringify(input.evidence ?? []),
        input.incrementAssessment ? 1 : 0,
        input.incrementRepair ? 1 : 0,
        input.episodeId,
        input.candidateId,
        input.gateType
      ]
    )
    return this.getState(input.episodeId, input.candidateId, input.gateType)!
  }

  findAuthorDecision(input: {
    episodeId: number
    candidateId: number
    gateType: NovelChapterGateType
    contentHash: string
    contractHash: string
  }): NovelChapterGateDecisionRow | undefined {
    return this.get<NovelChapterGateDecisionRow>(
      `SELECT * FROM novel_chapter_gate_decisions
       WHERE episode_id = ? AND candidate_id = ? AND gate_type = ?
         AND decision_type = 'approved_by_author'
         AND content_hash = ? AND contract_hash = ?
       ORDER BY decision_revision DESC LIMIT 1`,
      [
        input.episodeId,
        input.candidateId,
        input.gateType,
        input.contentHash,
        input.contractHash
      ]
    )
  }

  listDecisions(episodeId: number): NovelChapterGateDecisionRow[] {
    return this.all<NovelChapterGateDecisionRow>(
      `SELECT * FROM novel_chapter_gate_decisions
       WHERE episode_id = ? ORDER BY id`,
      [episodeId]
    )
  }

}

export const novelChapterGateDAO = new NovelChapterGateDAO()
