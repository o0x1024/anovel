import { incubatorCandidateDAO, incubatorScoreDAO } from '../../db/dao/incubator'
import type { IncubatorCandidateSourceStep } from '../../../shared/incubator-types'
import { normalizeCandidateTitle } from '../../../shared/incubator-candidate'

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
