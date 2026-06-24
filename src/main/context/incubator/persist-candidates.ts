import { incubatorStateDAO } from '../../db/dao/incubator'
import type { IncubatorCandidateSourceStep } from '../../../shared/incubator-types'
import { upsertIncubatorCandidate } from './candidate-dedup'
import { inferStateAfterCandidates } from './state-machine'
import { incubatorCandidateDAO } from '../../db/dao/incubator'
import { scoreCandidatesBatchAi } from './score-candidate'

export async function persistVariantsAsCandidates(
  workId: number,
  items: { title: string; summary: string; dimension?: string }[]
): Promise<number[]> {
  const ids: number[] = []
  for (const item of items) {
    ids.push(
      upsertIncubatorCandidate(workId, {
        sourceStep: 'variants',
        title: item.title,
        summary: item.summary,
        dimension: item.dimension ?? null
      })
    )
  }
  if (ids.length > 0) {
    await scoreCandidatesBatchAi(workId, ids)
  }
  bumpCandidateState(workId)
  return ids
}

export async function persistExpansionAsCandidates(
  workId: number,
  versions: { title: string; summary: string; highlights?: string; audience?: string }[]
): Promise<number[]> {
  const ids: number[] = []
  for (const ver of versions) {
    ids.push(
      upsertIncubatorCandidate(workId, {
        sourceStep: 'expand',
        title: ver.title,
        summary: ver.summary,
        highlights: ver.highlights ?? null,
        audience: ver.audience ?? null
      })
    )
  }
  if (ids.length > 0) {
    await scoreCandidatesBatchAi(workId, ids)
  }
  bumpCandidateState(workId)
  return ids
}

export async function persistSlotAnalysisAsCandidates(
  workId: number,
  sourceStep: IncubatorCandidateSourceStep,
  versions: { title: string; summary: string }[]
): Promise<number[]> {
  const ids: number[] = []
  for (const ver of versions) {
    ids.push(
      upsertIncubatorCandidate(workId, {
        sourceStep,
        title: ver.title,
        summary: ver.summary
      })
    )
  }
  if (ids.length > 0) {
    await scoreCandidatesBatchAi(workId, ids)
  }
  bumpCandidateState(workId)
  return ids
}

function bumpCandidateState(workId: number): void {
  const count = incubatorCandidateDAO.listByWork(workId).length
  incubatorStateDAO.setState(workId, inferStateAfterCandidates(count))
}

export async function ensureCandidateFromManual(
  workId: number,
  sourceStep: IncubatorCandidateSourceStep,
  payload: {
    title: string
    summary: string
    dimension?: string | null
    highlights?: string | null
    audience?: string | null
  }
): Promise<number> {
  const id = upsertIncubatorCandidate(workId, {
    sourceStep,
    title: payload.title,
    summary: payload.summary,
    dimension: payload.dimension ?? null,
    highlights: payload.highlights ?? null,
    audience: payload.audience ?? null
  })
  await scoreCandidatesBatchAi(workId, [id])
  return id
}
