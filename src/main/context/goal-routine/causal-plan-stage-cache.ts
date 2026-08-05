import { createHash } from 'node:crypto'
import { causalNovelDAO } from '../../db'

const CAUSAL_PLAN_STAGE_CACHE_PROTOCOL = 'causal_plan_stage_cache_v1'

interface CachedStageEnvelope {
  protocol: typeof CAUSAL_PLAN_STAGE_CACHE_PROTOCOL
  inputHash: string
  content: string
}

export function causalPlanStageInputHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function readCausalPlanStage(
  workId: number,
  stateRevision: number,
  stage: string,
  inputHash: string
): string | null {
  for (const attempt of causalNovelDAO.listPlanAttempts(workId, 200)) {
    if (
      attempt.stateRevision !== stateRevision
      || attempt.stage !== stage
      || attempt.status !== 'accepted'
      || !attempt.responseJson
    ) continue
    try {
      const parsed = JSON.parse(attempt.responseJson) as CachedStageEnvelope
      if (
        parsed.protocol === CAUSAL_PLAN_STAGE_CACHE_PROTOCOL
        && parsed.inputHash === inputHash
        && typeof parsed.content === 'string'
        && parsed.content.trim()
      ) return parsed.content
    } catch { /* 损坏制品不可复用 */ }
  }
  return null
}

export function saveCausalPlanStage(input: {
  workId: number
  stateRevision: number
  stage: string
  inputHash: string
  content: string
}): void {
  causalNovelDAO.recordPlanAttempt({
    workId: input.workId,
    stateRevision: input.stateRevision,
    stage: input.stage,
    status: 'accepted',
    responseJson: JSON.stringify({
      protocol: CAUSAL_PLAN_STAGE_CACHE_PROTOCOL,
      inputHash: input.inputHash,
      content: input.content
    } satisfies CachedStageEnvelope)
  })
}
