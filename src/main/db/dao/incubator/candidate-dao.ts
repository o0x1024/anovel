import { BaseDAO } from '../base-dao'
import type { IncubatorCandidateSourceStep, IncubatorCandidateStatus } from '../../../../shared/incubator-types'

export interface IncubatorCandidateRow {
  id: number
  work_id: number
  source_step: string
  title: string
  summary: string
  dimension: string | null
  highlights: string | null
  audience: string | null
  status: string
  raw_json: string | null
  create_time: string
  update_time: string
}

export interface IncubatorCandidateCreateInput {
  workId: number
  sourceStep: IncubatorCandidateSourceStep
  title: string
  summary: string
  dimension?: string | null
  highlights?: string | null
  audience?: string | null
  rawJson?: string | null
  status?: IncubatorCandidateStatus
}

export class IncubatorCandidateDAO extends BaseDAO {
  listByWork(
    workId: number,
    filters?: { status?: IncubatorCandidateStatus; sourceStep?: string }
  ): IncubatorCandidateRow[] {
    const clauses = ['work_id = ?']
    const params: unknown[] = [workId]
    if (filters?.status) {
      clauses.push('status = ?')
      params.push(filters.status)
    }
    if (filters?.sourceStep) {
      clauses.push('source_step = ?')
      params.push(filters.sourceStep)
    }
    return this.all<IncubatorCandidateRow>(
      `SELECT * FROM incubator_candidates
       WHERE ${clauses.join(' AND ')}
       ORDER BY create_time DESC`,
      params
    )
  }

  getById(id: number): IncubatorCandidateRow | undefined {
    return super.get<IncubatorCandidateRow>(
      'SELECT * FROM incubator_candidates WHERE id = ?',
      [id]
    )
  }

  findByWorkSourceTitle(
    workId: number,
    sourceStep: IncubatorCandidateSourceStep,
    title: string
  ): IncubatorCandidateRow | undefined {
    const normalized = title.trim().replace(/\s+/g, ' ')
    const rows = this.listByWork(workId, { sourceStep })
    return rows.find(r => r.title.trim().replace(/\s+/g, ' ') === normalized)
  }

  updateContent(
    id: number,
    input: {
      summary: string
      dimension?: string | null
      highlights?: string | null
      audience?: string | null
    }
  ): void {
    this.run(
      `UPDATE incubator_candidates
       SET summary = ?, dimension = ?, highlights = ?, audience = ?,
           update_time = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        input.summary,
        input.dimension ?? null,
        input.highlights ?? null,
        input.audience ?? null,
        id
      ]
    )
  }

  deleteById(id: number): void {
    this.run('DELETE FROM incubator_candidates WHERE id = ?', [id])
  }

  deleteByIds(ids: number[]): number {
    if (!ids.length) return 0
    const placeholders = ids.map(() => '?').join(',')
    const info = this.run(
      `DELETE FROM incubator_candidates WHERE id IN (${placeholders})`,
      ids
    )
    return info.changes
  }

  deleteByWorkSourceSteps(workId: number, sourceSteps: string[]): number {
    if (!sourceSteps.length) return 0
    const placeholders = sourceSteps.map(() => '?').join(',')
    return this.run(
      `DELETE FROM incubator_candidates
       WHERE work_id = ? AND source_step IN (${placeholders})`,
      [workId, ...sourceSteps]
    ).changes
  }

  create(input: IncubatorCandidateCreateInput): number {
    return this.insert(
      `INSERT INTO incubator_candidates (
        work_id, source_step, title, summary, dimension, highlights, audience, status, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.workId,
        input.sourceStep,
        input.title,
        input.summary,
        input.dimension ?? null,
        input.highlights ?? null,
        input.audience ?? null,
        input.status ?? 'new',
        input.rawJson ?? null
      ]
    )
  }

  setStatus(id: number, status: IncubatorCandidateStatus): void {
    this.run(
      `UPDATE incubator_candidates SET status = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, id]
    )
  }
}

export const incubatorCandidateDAO = new IncubatorCandidateDAO()
