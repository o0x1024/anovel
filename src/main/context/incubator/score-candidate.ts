import { incubatorCandidateDAO, incubatorScoreDAO } from '../../db/dao/incubator'
import { incubatorStateDAO } from '../../db/dao/incubator'
import { heuristicScoreCandidate } from './heuristic-score'

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function preserveUserAdjustmentOnRescore(
  input: ReturnType<typeof heuristicScoreCandidate>,
  previous: { system_total: number; user_adjustment: number } | undefined
): ReturnType<typeof heuristicScoreCandidate> {
  if (!previous?.user_adjustment) return input
  const adj = clamp(Math.round(previous.user_adjustment), -30, 30)
  const finalTotal = clamp(input.systemTotal + adj, 0, 100)
  return {
    ...input,
    userAdjustment: adj,
    finalTotal,
    rationale: `${input.rationale ?? ''}；保留用户修正 ${adj >= 0 ? '+' : ''}${adj}`
  }
}

export function rescoreCandidate(candidateId: number): number {
  const row = incubatorCandidateDAO.getById(candidateId)
  if (!row) throw new Error('候选不存在')
  const previous = incubatorScoreDAO.getLatestByCandidate(candidateId)
  const input = preserveUserAdjustmentOnRescore(heuristicScoreCandidate(row), previous)
  return incubatorScoreDAO.create(input)
}

/** 将修正分应用到系统总分上（修正范围 ±30，不是直接填目标总分） */
export function applyUserScoreAdjustment(
  workId: number,
  candidateId: number,
  userAdjustment: number
): { finalTotal: number; userAdjustment: number; systemTotal: number } {
  const row = incubatorCandidateDAO.getById(candidateId)
  if (!row || row.work_id !== workId) throw new Error('候选不存在')

  let latest = incubatorScoreDAO.getLatestByCandidate(candidateId)
  if (!latest) {
    rescoreCandidate(candidateId)
    latest = incubatorScoreDAO.getLatestByCandidate(candidateId)!
  }

  const adj = clamp(Math.round(userAdjustment), -30, 30)
  const finalTotal = clamp(latest.system_total + adj, 0, 100)

  incubatorScoreDAO.create({
    candidateId,
    attractionScore: latest.attraction_score,
    serializabilityScore: latest.serializability_score,
    differentiationScore: latest.differentiation_score,
    conflictClosureScore: latest.conflict_closure_score,
    executabilityScore: latest.executability_score,
    systemTotal: latest.system_total,
    userAdjustment: adj,
    finalTotal,
    rationale: `用户修正 ${adj >= 0 ? '+' : ''}${adj}`
  })

  incubatorCandidateDAO.setStatus(candidateId, 'evaluated')
  incubatorStateDAO.setState(workId, 'CandidatesEvaluated')

  return { finalTotal, userAdjustment: adj, systemTotal: latest.system_total }
}

const LEGACY_HEURISTIC_RATIONALE = '启发式初评（基于摘要长度与来源类型）'

/** 旧版启发式分档过低，加载时一次性重算 */
export function recalibrateLegacyHeuristicScores(workId: number): number {
  const rows = incubatorCandidateDAO.listByWork(workId)
  let count = 0
  for (const row of rows) {
    const latest = incubatorScoreDAO.getLatestByCandidate(row.id)
    if (latest?.rationale === LEGACY_HEURISTIC_RATIONALE) {
      rescoreCandidate(row.id)
      count++
    }
  }
  if (count > 0) {
    incubatorStateDAO.setState(workId, 'CandidatesEvaluated')
  }
  return count
}

export function rescoreAllCandidates(workId: number): number {
  const rows = incubatorCandidateDAO.listByWork(workId)
  let count = 0
  for (const row of rows) {
    rescoreCandidate(row.id)
    incubatorCandidateDAO.setStatus(row.id, 'evaluated')
    count++
  }
  if (count > 0) {
    incubatorStateDAO.setState(workId, 'CandidatesEvaluated')
  }
  return count
}
