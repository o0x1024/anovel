import { causalNovelDAO, goalRoutineDAO } from '../../db'
import type { ClassifiedWorkflowError } from '../../workflow/workflow-errors'
import {
  CausalPlanningAuthorityMismatchError,
  PLAN_AUTHORITY_RECOVERY_EXHAUSTED
} from './causal-planning-failure'
import { rebaseCausalNovelAuthorityToChapter } from './causal-novel-engine'
import {
  clearAutonomousChapterEscalation,
  markNovelAutonomousTerminal
} from './novel-autonomous-control'
import { readNovelGoalState, updateNovelGoalState } from './novel-outline-pipeline'
import type { RepairPlan } from './novel-repair-plan'

export type CausalPlanningRecoveryResult = 'state_rebased' | 'contract_replan' | 'terminal' | null

/**
 * 规划权威错位只能修复一次：
 * - 尚无已提交事实：把当前状态重建到章节开场前；
 * - 已有已提交事实：保留状态，重规划当前章节合同。
 * 同一章节再次错位即确定性终止，禁止重新进入正文质量修复。
 */
export async function recoverCausalPlanningAuthorityMismatch(input: {
  workId: number
  turn: number
  error: unknown
  classified: ClassifiedWorkflowError
  goal: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
}): Promise<CausalPlanningRecoveryResult> {
  if (
    input.classified.route !== 'rebase_authority'
    || !(input.error instanceof CausalPlanningAuthorityMismatchError)
  ) return null

  const mismatch = input.error
  const previous = readNovelGoalState(input.workId).causalPlanningRecovery
  if (previous?.chapterId === mismatch.chapterId) {
    const message = [
      `章节 ${mismatch.chapterId} 的规划权威错位在一次专用恢复后仍未收敛。`,
      `前次策略：${previous.strategy}；当前状态修订：${mismatch.stateRevision}。`,
      '已禁止再次调用模型或转入正文质量修复。'
    ].join('')
    markNovelAutonomousTerminal({
      workId: input.workId,
      phase: 'draft_body',
      code: PLAN_AUTHORITY_RECOVERY_EXHAUSTED,
      message
    })
    goalRoutineDAO.appendTurn({
      work_id: input.workId,
      turn_no: input.turn,
      phase: 'draft_body',
      action: 'causal_authority_recovery_terminal',
      target_chapter_id: mismatch.chapterId,
      summary: message
    })
    input.onProgress?.(message)
    return 'terminal'
  }

  const committedCount = causalNovelDAO.listDecisions(input.workId)
    .filter(item => item.status === 'committed').length
  if (committedCount > 0) {
    const plan: RepairPlan = {
      action: 'cluster',
      scope: 'cluster',
      targetChapterIds: [mismatch.chapterId],
      hint: [
        '规划权威错位：已提交因果状态优先，重建当前章节宏观合同。',
        ...mismatch.reasons
      ].join('\n'),
      issueCodes: [mismatch.code],
      evidenceFingerprint: mismatch.evidenceFingerprint
    }
    updateNovelGoalState(input.workId, {
      causalPlanningRecovery: {
        chapterId: mismatch.chapterId,
        attempts: 1,
        contractHash: mismatch.contractHash,
        sourceStateRevision: mismatch.stateRevision,
        strategy: 'chapter_contract_replan',
        evidenceFingerprint: mismatch.evidenceFingerprint,
        at: new Date().toISOString()
      },
      repairPlan: plan,
      failure: undefined,
      autonomousTerminal: undefined
    })
    clearAutonomousChapterEscalation(input.workId, mismatch.chapterId)
    goalRoutineDAO.update(input.workId, { status: 'running', current_phase: 'repair_execute' })
    goalRoutineDAO.appendTurn({
      work_id: input.workId,
      turn_no: input.turn,
      phase: 'repair_execute',
      action: 'causal_chapter_contract_replan',
      target_chapter_id: mismatch.chapterId,
      summary: '已保留全部已提交事实，当前章节合同进入一次性结构重规划'
    })
    input.onProgress?.('因果状态已有已提交事实，正在重规划当前章节合同')
    return 'contract_replan'
  }

  try {
    const rebased = await rebaseCausalNovelAuthorityToChapter(
      input.workId,
      mismatch.chapterId,
      input.goal,
      input.signal,
      input.onProgress
    )
    updateNovelGoalState(input.workId, {
      causalPlanningRecovery: {
        chapterId: mismatch.chapterId,
        attempts: 1,
        contractHash: mismatch.contractHash,
        sourceStateRevision: mismatch.stateRevision,
        recoveredStateRevision: rebased.revision,
        strategy: 'state_rebase',
        evidenceFingerprint: mismatch.evidenceFingerprint,
        at: new Date().toISOString()
      },
      repairPlan: undefined,
      failure: undefined,
      autonomousTerminal: undefined
    })
    clearAutonomousChapterEscalation(input.workId, mismatch.chapterId)
    goalRoutineDAO.update(input.workId, { status: 'running', current_phase: 'draft_body' })
    goalRoutineDAO.appendTurn({
      work_id: input.workId,
      turn_no: input.turn,
      phase: 'draft_body',
      action: 'causal_authority_rebased',
      target_chapter_id: mismatch.chapterId,
      summary: `权威因果状态已从 r${mismatch.stateRevision} 重建到 r${rebased.revision}；旧修订的规划缓存自动失效`
    })
    input.onProgress?.('权威状态已重建，下一轮将基于新修订重新生成章节决策')
    return 'state_rebased'
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const message = `权威因果状态专用重建失败，已安全终止：${detail}`
    markNovelAutonomousTerminal({
      workId: input.workId,
      phase: 'draft_body',
      code: 'PLAN_AUTHORITY_REBASE_FAILED',
      message
    })
    goalRoutineDAO.appendTurn({
      work_id: input.workId,
      turn_no: input.turn,
      phase: 'draft_body',
      action: 'causal_authority_rebase_failed',
      target_chapter_id: mismatch.chapterId,
      summary: message
    })
    input.onProgress?.(message)
    return 'terminal'
  }
}
