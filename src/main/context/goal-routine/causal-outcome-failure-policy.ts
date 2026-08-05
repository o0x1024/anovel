import { createHash } from 'node:crypto'
import { causalNovelDAO } from '../../db'
import {
  CAUSAL_OUTCOME_PROTOCOL_VERSION,
  causalOutcomeFailureIssues,
  type CausalOutcomeFailureCode
} from '../../../shared/causal-outcome-protocol'

export type CausalOutcomeFailureDisposition =
  | 'transient_retry'
  | 'checkpoint_resume'
  | 'body_contract_repair'
  | 'deterministic_pause'

export interface RegisteredCausalOutcomeFailure {
  count: number
  maxAttempts: number
  disposition: CausalOutcomeFailureDisposition
  shouldPause: boolean
}

export function causalOutcomeFailurePolicy(code: CausalOutcomeFailureCode): {
  disposition: CausalOutcomeFailureDisposition
  maxAttempts: number
} {
  if (code === 'OUTCOME_TRANSPORT') {
    return { disposition: 'transient_retry', maxAttempts: 3 }
  }
  if (code === 'OUTCOME_BUDGET') {
    return { disposition: 'checkpoint_resume', maxAttempts: 3 }
  }
  if (code === 'OUTCOME_BODY_CONTRACT') {
    return { disposition: 'body_contract_repair', maxAttempts: 1 }
  }
  return { disposition: 'deterministic_pause', maxAttempts: 1 }
}

export function registerCausalOutcomeFailure(input: {
  workId: number
  chapterId: number
  contentVersionId: number
  bodyHash: string
  stateRevision: number
  code: CausalOutcomeFailureCode
  message: string
}): RegisteredCausalOutcomeFailure {
  const policy = causalOutcomeFailurePolicy(input.code)
  const stage = `failure_${input.code.toLowerCase().replace(/^outcome_/, '')}`.slice(0, 40)
  const fingerprint = createHash('sha256')
    .update(`${input.stateRevision}\u0000${input.code}`)
    .digest('hex')
  const cached = causalNovelDAO.getCheckpoint(
    input.chapterId,
    input.contentVersionId,
    stage,
    CAUSAL_OUTCOME_PROTOCOL_VERSION
  )
  const payload = cached?.payload as {
    fingerprint?: string
    count?: number
  } | null
  const count = payload?.fingerprint === fingerprint
    ? Math.max(0, Math.round(payload.count ?? 0)) + 1
    : 1
  causalNovelDAO.saveCheckpoint({
    workId: input.workId,
    chapterId: input.chapterId,
    contentVersionId: input.contentVersionId,
    bodyHash: input.bodyHash,
    protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
    stage,
    status: 'failed',
    payload: {
      stateRevision: input.stateRevision,
      code: input.code,
      fingerprint,
      count,
      disposition: policy.disposition,
      maxAttempts: policy.maxAttempts,
      issues: causalOutcomeFailureIssues(input.message)
    },
    errorMessage: input.message
  })
  return {
    count,
    maxAttempts: policy.maxAttempts,
    disposition: policy.disposition,
    shouldPause: count >= policy.maxAttempts
  }
}
