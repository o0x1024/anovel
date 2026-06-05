import { BaseDAO } from '../base-dao'

export interface IncubatorScoreRow {
  id: number
  candidate_id: number
  attraction_score: number
  serializability_score: number
  differentiation_score: number
  conflict_closure_score: number
  executability_score: number
  system_total: number
  user_adjustment: number
  final_total: number
  rationale: string | null
  create_time: string
}

export interface IncubatorScoreInput {
  candidateId: number
  attractionScore: number
  serializabilityScore: number
  differentiationScore: number
  conflictClosureScore: number
  executabilityScore: number
  systemTotal: number
  userAdjustment?: number
  finalTotal: number
  rationale?: string | null
}

export class IncubatorScoreDAO extends BaseDAO {
  getLatestByCandidate(candidateId: number): IncubatorScoreRow | undefined {
    return this.get<IncubatorScoreRow>(
      `SELECT * FROM incubator_candidate_scores
       WHERE candidate_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [candidateId]
    )
  }

  create(input: IncubatorScoreInput): number {
    return this.insert(
      `INSERT INTO incubator_candidate_scores (
        candidate_id, attraction_score, serializability_score, differentiation_score,
        conflict_closure_score, executability_score, system_total, user_adjustment,
        final_total, rationale
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.candidateId,
        input.attractionScore,
        input.serializabilityScore,
        input.differentiationScore,
        input.conflictClosureScore,
        input.executabilityScore,
        input.systemTotal,
        input.userAdjustment ?? 0,
        input.finalTotal,
        input.rationale ?? null
      ]
    )
  }
}

export const incubatorScoreDAO = new IncubatorScoreDAO()
