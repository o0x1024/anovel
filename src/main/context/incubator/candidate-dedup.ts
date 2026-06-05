import { incubatorCandidateDAO, incubatorScoreDAO } from '../../db/dao/incubator'
import type { IncubatorCandidateSourceStep } from '../../../shared/incubator-types'
import { normalizeCandidateTitle } from '../../../shared/incubator-candidate'
import { heuristicScoreCandidate } from './heuristic-score'

export { normalizeCandidateTitle }

export function candidateDedupKey(sourceStep: string, title: string): string {
  return `${sourceStep}\0${normalizeCandidateTitle(title)}`
}

/** 同作品 + 来源 + 标题 视为同一条，更新内容并重新评分 */
export function upsertIncubatorCandidate(
  workId: number,
  input: {
    sourceStep: IncubatorCandidateSourceStep
    title: string
    summary: string
    dimension?: string | null
    highlights?: string | null
    audience?: string | null
  }
): number {
  const title = normalizeCandidateTitle(input.title)
  const existing = incubatorCandidateDAO.findByWorkSourceTitle(workId, input.sourceStep, title)

  if (existing) {
    incubatorCandidateDAO.updateContent(existing.id, {
      summary: input.summary.trim(),
      dimension: input.dimension ?? null,
      highlights: input.highlights ?? null,
      audience: input.audience ?? null
    })
    const row = incubatorCandidateDAO.getById(existing.id)!
    const previous = incubatorScoreDAO.getLatestByCandidate(existing.id)
    const scoreInput = heuristicScoreCandidate(row)
    if (previous?.user_adjustment) {
      const adj = Math.max(-30, Math.min(30, Math.round(previous.user_adjustment)))
      incubatorScoreDAO.create({
        ...scoreInput,
        userAdjustment: adj,
        finalTotal: Math.max(0, Math.min(100, scoreInput.systemTotal + adj)),
        rationale: `${scoreInput.rationale ?? ''}；保留用户修正 ${adj >= 0 ? '+' : ''}${adj}`
      })
    } else {
      incubatorScoreDAO.create(scoreInput)
    }
    return existing.id
  }

  const id = incubatorCandidateDAO.create({
    workId,
    sourceStep: input.sourceStep,
    title,
    summary: input.summary.trim(),
    dimension: input.dimension ?? null,
    highlights: input.highlights ?? null,
    audience: input.audience ?? null,
    status: 'new'
  })
  const row = incubatorCandidateDAO.getById(id)!
  incubatorScoreDAO.create(heuristicScoreCandidate(row))
  return id
}

/** 保留同键最新一条（id 最大），删除其余重复候选 */
export function pruneDuplicateCandidates(workId: number): number {
  const rows = incubatorCandidateDAO.listByWork(workId)
  const keepIdByKey = new Map<string, number>()

  for (const row of rows) {
    const key = candidateDedupKey(row.source_step, row.title)
    const prev = keepIdByKey.get(key)
    if (prev == null || row.id > prev) {
      keepIdByKey.set(key, row.id)
    }
  }

  const keepIds = new Set(keepIdByKey.values())
  let removed = 0
  for (const row of rows) {
    if (!keepIds.has(row.id)) {
      incubatorCandidateDAO.deleteById(row.id)
      removed++
    }
  }
  return removed
}
