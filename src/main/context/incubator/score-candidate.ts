import { incubatorCandidateDAO, incubatorScoreDAO, type IncubatorCandidateRow } from '../../db/dao/incubator'
import { incubatorStateDAO } from '../../db/dao/incubator'
import { heuristicScoreCandidate } from './heuristic-score'
import { modelService } from '../../model'
import { INCUBATOR_AI_SCORE_SYSTEM } from '../../../shared/incubator-analysis-prompts'

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

export async function scoreCandidatesBatchAi(workId: number, candidateIds: number[]): Promise<number> {
  if (candidateIds.length === 0) return 0
  const rows: IncubatorCandidateRow[] = []
  for (const id of candidateIds) {
    const row = incubatorCandidateDAO.getById(id)
    if (row && row.work_id === workId) rows.push(row)
  }
  if (rows.length === 0) return 0

  const promptBody = rows.map(r => {
    return `{"id": ${r.id}, "title": ${JSON.stringify(r.title)}, "dimension": ${JSON.stringify(r.dimension ?? '')}, "summary": ${JSON.stringify(r.summary)}}`
  }).join('\n')

  const res = await modelService.chat({
    workId,
    systemPrompt: INCUBATOR_AI_SCORE_SYSTEM,
    prompt: `【待评估方案列表】\n${promptBody}\n\n请返回符合要求的 JSON。`,
    step: 'incubator_score_candidates',
    enrichNarrativeMemory: false,
    enrichWorkContext: false
  })

  let scoredCount = 0
  const fallbackScore = (row: IncubatorCandidateRow) => {
     const previous = incubatorScoreDAO.getLatestByCandidate(row.id)
     const h = heuristicScoreCandidate(row)
     if (previous?.user_adjustment) {
       const adj = clamp(Math.round(previous.user_adjustment), -30, 30)
       incubatorScoreDAO.create({
         ...h,
         userAdjustment: adj,
         finalTotal: clamp(h.systemTotal + adj, 0, 100),
         rationale: `${h.rationale ?? ''}；保留用户修正 ${adj >= 0 ? '+' : ''}${adj}`
       })
     } else {
       incubatorScoreDAO.create(h)
     }
     incubatorCandidateDAO.setStatus(row.id, 'evaluated')
  }

  if (!res.success) {
    rows.forEach(fallbackScore)
    incubatorStateDAO.setState(workId, 'CandidatesEvaluated')
    return 0
  }

  try {
    const match = res.content.match(/\{[\s\S]*"scores"[\s\S]*\}/)
    const jsonStr = match ? match[0] : res.content
    const parsed = JSON.parse(jsonStr)
    const scoresArray: any[] = parsed.scores || []
    
    for (const row of rows) {
      const aiScore = scoresArray.find(s => s.id === row.id)
      if (aiScore) {
        const attraction = clamp(aiScore.attractionScore || 0, 0, 100)
        const serial = clamp(aiScore.serializabilityScore || 0, 0, 100)
        const diff = clamp(aiScore.differentiationScore || 0, 0, 100)
        const conflict = clamp(aiScore.conflictClosureScore || 0, 0, 100)
        const exec = clamp(aiScore.executabilityScore || 0, 0, 100)
        const systemTotal = Math.round(
          attraction * 0.25 +
          serial * 0.15 +
          diff * 0.2 +
          conflict * 0.25 +
          exec * 0.15
        )
        const previous = incubatorScoreDAO.getLatestByCandidate(row.id)
        let adj = 0
        if (previous?.user_adjustment) {
           adj = clamp(Math.round(previous.user_adjustment), -30, 30)
        }
        incubatorScoreDAO.create({
          candidateId: row.id,
          attractionScore: attraction,
          serializabilityScore: serial,
          differentiationScore: diff,
          conflictClosureScore: conflict,
          executabilityScore: exec,
          systemTotal,
          userAdjustment: adj,
          finalTotal: clamp(systemTotal + adj, 0, 100),
          rationale: (aiScore.rationale || 'AI 综合评估').substring(0, 50) + (adj ? `；保留用户修正 ${adj >= 0 ? '+' : ''}${adj}` : '')
        })
        incubatorCandidateDAO.setStatus(row.id, 'evaluated')
        scoredCount++
      } else {
        fallbackScore(row)
      }
    }
  } catch (e) {
    console.error('Failed to parse AI scores:', e)
    rows.forEach(fallbackScore)
  }

  incubatorStateDAO.setState(workId, 'CandidatesEvaluated')
  return scoredCount
}

export async function rescoreCandidate(candidateId: number): Promise<void> {
  const row = incubatorCandidateDAO.getById(candidateId)
  if (!row) throw new Error('候选不存在')
  await scoreCandidatesBatchAi(row.work_id, [candidateId])
}

/** 将修正分应用到系统总分上（修正范围 ±30，不是直接填目标总分） */
export async function applyUserScoreAdjustment(
  workId: number,
  candidateId: number,
  userAdjustment: number
): Promise<{ finalTotal: number; userAdjustment: number; systemTotal: number }> {
  const row = incubatorCandidateDAO.getById(candidateId)
  if (!row || row.work_id !== workId) throw new Error('候选不存在')

  let latest = incubatorScoreDAO.getLatestByCandidate(candidateId)
  if (!latest) {
    await rescoreCandidate(candidateId)
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

/** 旧版启发式分档过低，加载时一次性重算。现已弃用（不自动转换存量数据以节省 token） */
export async function recalibrateLegacyHeuristicScores(workId: number): Promise<number> {
  return 0
}

export async function rescoreAllCandidates(workId: number): Promise<number> {
  const rows = incubatorCandidateDAO.listByWork(workId)
  const ids = rows.map(r => r.id)
  if (ids.length > 0) {
    return await scoreCandidatesBatchAi(workId, ids)
  }
  return 0
}
