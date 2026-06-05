import type { IncubatorCandidateRow } from '../../db/dao/incubator'
import type { IncubatorScoreInput } from '../../db/dao/incubator/score-dao'
import {
  scoreTextAntiCliche,
  scoreTextTension,
  scoreTextUniqueness
} from './heuristic-tension'

/**
 * M1 启发式评分（无 LLM）。
 * 校准目标：符合 prompts 的扩写/变体（约 80–350 字摘要）落在 70–82，与入槽阈值 68 对齐。
 */
export function heuristicScoreCandidate(row: IncubatorCandidateRow): IncubatorScoreInput {
  const body = `${row.summary}\n${row.highlights ?? ''}\n${row.audience ?? ''}`
  const len = body.replace(/\s/g, '').length
  const hasDimension = !!row.dimension?.trim()
  const hasHighlights = !!row.highlights?.trim()
  const hasAudience = !!row.audience?.trim()
  const isExpand = row.source_step === 'expand'
  const isSlotAnalysis = ['role_engine_gen', 'world_rules_gen', 'emotion_curve_gen', 'ending_image_gen']
    .includes(row.source_step)

  /** 摘要有效长度：过短惩罚，80–350 字区间加分 */
  const lenBand = clamp(52 + Math.min(22, Math.floor(Math.max(0, len - 50) / 10)), 40, 74)
  if (len < 35) {
    // 信息过少，整体降档
  }

  const tension = scoreTextTension(body)
  const antiCliche = scoreTextAntiCliche(body)
  const uniqueness = scoreTextUniqueness(body)

  const attraction = clamp(
    Math.round(lenBand * 0.45 + tension * 0.35 + uniqueness * 0.2) + (row.title.trim().length >= 2 ? 4 : 0),
    0,
    100
  )
  const serializability = clamp(
    (isExpand || isSlotAnalysis ? 70 : 60) + (hasAudience ? 6 : 0) + ((isExpand || isSlotAnalysis) && hasHighlights ? 4 : 0),
    0,
    100
  )
  const differentiation = clamp(
    Math.round(
      40 + (hasDimension ? 16 : isSlotAnalysis ? 12 : 6) + (hasHighlights ? 6 : 0) + uniqueness * 0.35
    ),
    0,
    100
  )
  const conflictClosure = clamp(Math.round(lenBand * 0.4 + tension * 0.45 + antiCliche * 0.15), 0, 100)
  const executability = clamp(
    Math.round(lenBand * 0.5 + antiCliche * 0.25 + (hasHighlights ? 5 : isSlotAnalysis ? 4 : 0)),
    0,
    100
  )

  let systemTotal = Math.round(
    attraction * 0.25 +
    serializability * 0.15 +
    differentiation * 0.2 +
    conflictClosure * 0.25 +
    executability * 0.15
  )

  if (len < 35) systemTotal = clamp(systemTotal - 15, 0, 100)
  else if (len < 60) systemTotal = clamp(systemTotal - 8, 0, 100)
  if (antiCliche < 55) systemTotal = clamp(systemTotal - 10, 0, 100)

  return {
    candidateId: row.id,
    attractionScore: attraction,
    serializabilityScore: serializability,
    differentiationScore: differentiation,
    conflictClosureScore: conflictClosure,
    executabilityScore: executability,
    systemTotal,
    userAdjustment: 0,
    finalTotal: systemTotal,
    rationale: `启发式初评（长度/张力${tension}/反俗套${antiCliche}/独特性${uniqueness}）`
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
