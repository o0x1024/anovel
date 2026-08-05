import { causalNovelDAO, goalRoutineDAO, volumeChapterDAO } from '../../db'
import type { GoalRoutinePhase } from '../../../shared/goal-routine-phases'
import { readNovelGoalState, updateNovelGoalState } from './novel-outline-pipeline'
import { CHAPTER_EXECUTION_CONTRACT_VERSION } from '../../../shared/chapter-execution-contract'
import { CAUSAL_OUTCOME_PROTOCOL_VERSION } from '../../../shared/causal-outcome-protocol'
import { shouldRecoverNovelChapterExecutionProtocol } from './novel-goal-policy'
import { normalizeNovelAuthorityStateOwnership } from './novel-authority-state'

export const NOVEL_WORKFLOW_DEFINITION_VERSION = 8
export const CAUSAL_STATE_INIT_PROTOCOL_VERSION = 7
export const CAUSAL_CHAPTER_DECISION_PROTOCOL_VERSION = 9
export const NOVEL_PACKAGING_PROTOCOL_VERSION = 7
export const NOVEL_REPAIR_EXECUTION_PROTOCOL_VERSION = 20
export const NOVEL_RELEASE_WINDOW_AUDIT_PROTOCOL_VERSION = 1

export function novelWorkflowStepProtocolVersion(stepKey: string): number {
  if (stepKey === 'precommit_artifacts') return CAUSAL_OUTCOME_PROTOCOL_VERSION
  if (stepKey === 'causal_state_init') return CAUSAL_STATE_INIT_PROTOCOL_VERSION
  if (stepKey === 'chapter_decision') return CAUSAL_CHAPTER_DECISION_PROTOCOL_VERSION
  if (stepKey === 'generate_character_cards' || stepKey === 'generate_title_hook') {
    return NOVEL_PACKAGING_PROTOCOL_VERSION
  }
  if (stepKey === 'repair_execute') return NOVEL_REPAIR_EXECUTION_PROTOCOL_VERSION
  if (stepKey === 'release_window_audit') return NOVEL_RELEASE_WINDOW_AUDIT_PROTOCOL_VERSION
  return CHAPTER_EXECUTION_CONTRACT_VERSION
}

export interface NovelWorkflowUpgradeResult {
  migrated: boolean
  phase: GoalRoutinePhase
  targetChapterId?: number
}

export function resolveNovelWorkflowDefinitionUpgrade(input: {
  resume: boolean
  phase: GoalRoutinePhase
  savedVersion?: number
  hasTargetBody: boolean
}): Pick<NovelWorkflowUpgradeResult, 'migrated' | 'phase'> {
  if (!input.resume || input.savedVersion === NOVEL_WORKFLOW_DEFINITION_VERSION) {
    return { migrated: false, phase: input.phase }
  }
  return {
    migrated: true,
    phase: input.hasTargetBody
      ? 'draft_body'
      : input.phase === 'repair_execute'
        ? 'goal_check'
        : input.phase
  }
}

/**
 * 运行断点属于某一版状态机，不能在代码升级后继续解释旧 repairPlan。
 * 升级只清理运行态并重新计算最早缺失步骤；作品正文、版本、决策和权威状态均不修改。
 */
export function reconcileNovelWorkflowDefinition(input: {
  workId: number
  resume: boolean
  phase: GoalRoutinePhase
  savedVersion?: number
  turn: number
}): NovelWorkflowUpgradeResult {
  const resolution = resolveNovelWorkflowDefinitionUpgrade({
    resume: input.resume,
    phase: input.phase,
    savedVersion: input.savedVersion,
    hasTargetBody: false
  })
  if (!resolution.migrated) {
    updateNovelGoalState(input.workId, {
      workflowDefinitionVersion: NOVEL_WORKFLOW_DEFINITION_VERSION
    })
    return { migrated: false, phase: input.phase }
  }

  const state = readNovelGoalState(input.workId)
  const repairPlan = state.repairPlan as { targetChapterIds?: number[] } | undefined
  const repairTarget = repairPlan?.targetChapterIds?.[0]
  const plannedTarget = causalNovelDAO.listDecisions(input.workId)
    .find(decision => decision.status === 'planned')?.chapterId
  const targetChapterId = repairTarget ?? plannedTarget
  const target = targetChapterId == null
    ? undefined
    : volumeChapterDAO.getChapter(targetChapterId)
  const phase = resolveNovelWorkflowDefinitionUpgrade({
    resume: input.resume,
    phase: input.phase,
    savedVersion: input.savedVersion,
    hasTargetBody: Boolean(target?.content?.trim())
  }).phase

  normalizeNovelAuthorityStateOwnership(input.workId)
  updateNovelGoalState(input.workId, {
    workflowDefinitionVersion: NOVEL_WORKFLOW_DEFINITION_VERSION,
    repairPlan: undefined,
    repairCommitPending: undefined,
    chapterTransactionBudgets: {},
    autonomousChapterEscalations: {},
    autonomousTerminal: undefined,
    causalPlanningRecovery: undefined,
    repairStall: undefined,
    checkedChapterVolumes: undefined,
    checkedBodyVolumes: undefined,
    chapterVolumeGateResults: undefined,
    pendingChapterVolumeGate: undefined,
    chapterVolumeGateCheckpoint: undefined,
    failure: undefined
  })
  goalRoutineDAO.update(input.workId, {
    current_phase: phase,
    status: 'running'
  })
  goalRoutineDAO.appendTurn({
    work_id: input.workId,
    turn_no: input.turn,
    phase,
    action: 'workflow_definition_migrated',
    target_chapter_id: targetChapterId ?? null,
    summary: `目标循环定义升级到 v${NOVEL_WORKFLOW_DEFINITION_VERSION}：已废弃旧修复路由，从权威正文重新计算最早缺失步骤`
  })
  return { migrated: true, phase, targetChapterId }
}

export function reconcileNovelChapterExecutionProtocol(input: {
  workId: number
  resume: boolean
  phase: GoalRoutinePhase
  turn: number
}): boolean {
  const savedVersion = readNovelGoalState(input.workId).chapterExecutionProtocolVersion
  if (!shouldRecoverNovelChapterExecutionProtocol({
    resume: input.resume,
    phase: input.phase,
    savedVersion,
    currentVersion: CHAPTER_EXECUTION_CONTRACT_VERSION
  })) return false
  updateNovelGoalState(input.workId, {
    chapterExecutionProtocolVersion: CHAPTER_EXECUTION_CONTRACT_VERSION,
    failure: undefined
  })
  goalRoutineDAO.appendTurn({
    work_id: input.workId,
    turn_no: input.turn,
    phase: input.phase,
    action: 'harness_recovery',
    summary: `章节执行协议升级到 v${CHAPTER_EXECUTION_CONTRACT_VERSION}：保留正式正文与候选版本，清除旧版证据协议失败计数并按结构化验收项重新验收`
  })
  return true
}
