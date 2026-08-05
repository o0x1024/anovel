import { createHash } from 'node:crypto'

export const PLAN_AUTHORITY_STATE_MISMATCH = 'PLAN_AUTHORITY_STATE_MISMATCH'
export const PLAN_AUTHORITY_RECOVERY_EXHAUSTED = 'PLAN_AUTHORITY_RECOVERY_EXHAUSTED'
export const PLAN_REFINEMENT_EXHAUSTED = 'PLAN_REFINEMENT_EXHAUSTED'

export class CausalPlanningAuthorityMismatchError extends Error {
  readonly code = PLAN_AUTHORITY_STATE_MISMATCH
  readonly workId: number
  readonly chapterId: number
  readonly stateRevision: number
  readonly contractHash: string
  readonly evidenceFingerprint: string
  readonly reasons: string[]

  constructor(input: {
    workId: number
    chapterId: number
    stateRevision: number
    contractHash: string
    reasons: string[]
  }) {
    const reasons = input.reasons.map(item => item.trim()).filter(Boolean)
    super(`因果候选独立评审未通过：${reasons.join('；') || '章节计划与宏观合同不一致'}`)
    this.name = 'CausalPlanningAuthorityMismatchError'
    this.workId = input.workId
    this.chapterId = input.chapterId
    this.stateRevision = input.stateRevision
    this.contractHash = input.contractHash
    this.reasons = reasons
    this.evidenceFingerprint = createHash('sha256').update(JSON.stringify({
      chapterId: input.chapterId,
      stateRevision: input.stateRevision,
      contractHash: input.contractHash,
      reasons: [...new Set(reasons)].sort()
    })).digest('hex')
  }
}

export class CausalPlanRefinementExhaustedError extends Error {
  readonly code = PLAN_REFINEMENT_EXHAUSTED

  constructor(chapterId: number, reasons: string[]) {
    super(`章节 ${chapterId} 的候选与执行合同经过专用审计修订后仍未收敛：${reasons.join('；')}`)
    this.name = 'CausalPlanRefinementExhaustedError'
  }
}
