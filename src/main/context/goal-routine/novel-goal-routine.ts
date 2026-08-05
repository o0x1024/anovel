import type { WebContents } from 'electron'
import { appLogger } from '../../logger/app-logger'
import {
  causalNovelDAO,
  volumeChapterDAO,
  goalRoutineDAO,
  coreSettingDAO,
  storyStateDAO,
  workDAO
} from '../../db'
import { getSettingsQualityStatus } from '../settings-quality'
import { loadWritingPlan } from '../writing-plan'
import { bodyWordCountBounds } from '../../../shared/body-word-target'
import { CHAPTER_EXECUTION_CONTRACT_VERSION } from '../../../shared/chapter-execution-contract'
import { extractJsonText } from '../parse-json-extract'
import {
  checkStoryGoal,
  DEFAULT_STORY_GOAL_CONFIG,
  type StoryGoalConfig,
  type GoalCheckResult
} from './story-goal-checker'
import { generateBeatBody, NarrativeMemoryCommitGateError } from './story-goal-doer'
import { incubateStoryline, runStorylineGate, freezeStoryline } from './story-goal-routine'
import { refreshResourceConstraints } from '../resource-ledger'
import { clearChapterNarrativeMemory } from '../memory-cleanup'
import { bindGoalLoopModelOpts, clearGoalLoopModelOpts, getGoalLoopModelOpts, storyGoalModelOpts } from './story-goal-model'
import {
  generateNextNovelOutlineBatch,
  reconcileNovelWorkflowState,
  prepareNovelVolumePlan,
  NovelPipelineError,
  readNovelGoalState,
  reopenStalledNovelVolumeGate,
  resetNovelGoalStateFromVolumePlan,
  resolveNovelVolumeWorkflowCheckpoint,
  updateNovelGoalState,
} from './novel-outline-pipeline'
import { parseStoredEmotionAssessment } from './emotion-gate'
import { parseCachedQualityAssessment } from './chapter-assessment-cache'
import { assessNovelSystemics } from './novel-systemic-gate'
import {
  MAX_NOVEL_PHASE_FAILURES,
  MAX_NOVEL_REPAIR_STALLS,
  isNovelHardBudgetExhausted,
  isTerminalNovelRepairError,
  isNovelChapterCheckpointFailure,
  classifyNovelConstructionOutputTerminal,
  nextPhaseAfterNovelOutlineCheckpoint,
  novelPhaseFailureSignature,
  resolveNovelChapterRecoveryAction,
  shouldPauseForNovelConstructionOutputFailure
} from './novel-goal-policy'
import { requireGoalTurnLimit } from '../../../shared/goal-turn-limit'
import {
  invalidateDownstreamBodiesAfterAcceptedChapterRewrite,
  isStrictCachedQualityReady,
  nextPendingDraftChapter,
  phaseAfterCurrentDraftWindow,
  runChapterAcceptanceGate,
  runChapterConvergenceGate,
  strictChapterTransitionBlockers
} from './novel-chapter-acceptance'
import { buildNovelRepairPlan, type RepairPlan } from './novel-repair-plan'
import { isResumableNovelGoalStatus } from './novel-goal-resume'
import { repairEvidenceSnapshot, repairReasonSignature } from './novel-repair-evidence'
import { assertNovelGoalNotAborted as assertNotAborted, countNovelWords as countWords } from './novel-runtime-utils'
import { runNovelEmotionEnginePreparation, safeNovelPreparationPhase } from './novel-preparation'
import {
  commitUnifiedNovelChapter,
  ensureUnifiedNovelDecision,
  hasUnifiedNovelPrecommitArtifacts,
  isUnifiedNovelDecisionReady,
  prepareUnifiedNovelChapterCommit
} from './unified-novel-chapter'
import {
  executeNovelRepairPlan,
  NovelRepairGateError,
  NovelRepairGenerationRequiredError,
  NovelRepairRevalidationRequiredError,
  runVolumeBodyCheckpoint
} from './novel-repair-execution'
import {
  broadcastNovelGoalProgress,
  cancelAllNovelGoalLoops,
  cancelNovelGoalLoop,
  isNovelGoalLoopRunning,
  registerNovelGoalLoop,
  unregisterNovelGoalLoop
} from './novel-loop-lifecycle'
import { generateNovelCharacterCards, generateNovelTitleHook } from './novel-packaging'
import { freezeUnifiedNovelRelease, requireUnifiedNovelAuthorityCompletion } from './unified-novel-release'
import { resolvePendingNovelReleaseWindow } from './novel-release-window-audit'
import { runNovelReleaseWindowAuditPhase } from './novel-release-window-phase'
import { classifyWorkflowError, waitForWorkflowRetry, type ClassifiedWorkflowError } from '../../workflow/workflow-errors'
import {
  leafFailureContinuationDelay,
  shouldContinueNovelRunAfterLeafFailure
} from './novel-run-continuation-policy'
import { clearWorkflowExecutionContext, setWorkflowExecutionContext } from '../../workflow/workflow-execution-context'
import { processPendingCausalReplay } from './causal-replay'
import { ensureWorkflowModelContract } from '../../workflow/workflow-model-contract'
import {
  novelDraftWorkflowStepLabel,
  resolveNovelDraftWorkflowStep,
  type NovelDraftWorkflowStep
} from './novel-draft-step'
import { buildNovelWorkflowStepInput } from './novel-workflow-step-input'
import { ensureNovelAuthorityState } from './novel-authority-state'
import {
  reconcileNovelChapterExecutionProtocol,
  reconcileNovelWorkflowDefinition,
  novelWorkflowStepProtocolVersion
} from './novel-workflow-definition'
import { initializeCausalNovelState } from './causal-novel-engine'
import { recoverCausalPlanningAuthorityMismatch } from './causal-planning-recovery'
import { getNovelChapterAcceptanceSummary, resolveNovelChapterAcceptanceIdentity } from './novel-chapter-acceptance-ledger'
import { CHAPTER_ACCEPTANCE_PROTOCOL_VERSION } from './novel-chapter-acceptance-policy'
import { stopNovelOnHardGate } from './novel-hard-gate-terminal'
import {
  repairNovelSettingsFromOverallCheck,
  runNovelOverallSelfCheck
} from './novel-overall-self-check'
import { materializeNovelSettings } from './novel-settings-materialization'
import {
  buildAutonomousChapterRepairPlan,
  clearAutonomousChapterEscalation,
  markNovelAutonomousTerminal,
  normalizeAutonomousMaxEpochs,
  reconcileAutonomousRepairFromAcceptance,
  handleNarrativeMemoryCommitGate,
  recoverNovelBodyContractRevalidation,
  buildExecutionContractStructuralReplan,
  recoverInterruptedExecutionContractRepairOnResume,
  recoverInterruptedNarrativeMemoryGateOnResume,
  shouldRouteExecutionContractRepairToStructuralReplan,
  shouldRouteLengthNormalizationToSemanticRepair
} from './novel-autonomous-control'
export { shouldResumeNovelGoalLoop } from './novel-goal-resume'
export {
  novelMemoryCommitBlockers,
  runChapterAcceptanceGate
} from './novel-chapter-acceptance'
import { NOVEL_GOAL_ROUTINE_PHASE_ORDER, isGoalRoutinePhase, type GoalRoutinePhase } from '../../../shared/goal-routine-phases'
export type Phase = GoalRoutinePhase
export interface GoalProgressEvent {
  workId: number
  turn: number
  maxTurns: number
  phase: Phase
  status: string
  check?: GoalCheckResult
  message: string
}
const MAX_REPAIR_STALL_ROUNDS = 3
export { cancelAllNovelGoalLoops, cancelNovelGoalLoop, isNovelGoalLoopRunning }
const VALID_PHASES: Phase[] = NOVEL_GOAL_ROUTINE_PHASE_ORDER

export async function runNovelGoalLoop(
  workId: number,
  config: Partial<StoryGoalConfig> = {},
  sender?: WebContents,
  resume = false,
  forcePhase?: Phase
): Promise<void> {
  if (isNovelGoalLoopRunning(workId)) {
    throw new Error('该作品已有目标循环在运行')
  }

  const existing = goalRoutineDAO.getByWork(workId)
  let fullConfig: StoryGoalConfig
  let turn: number
  let phase: Phase
  const explicitPhase = forcePhase && isGoalRoutinePhase(forcePhase) ? forcePhase : undefined

  if (resume && existing && isResumableNovelGoalStatus(existing.status)) {
    const saved = existing.goal_config_json
      ? { ...DEFAULT_STORY_GOAL_CONFIG, ...JSON.parse(existing.goal_config_json) as Partial<StoryGoalConfig> }
      : { ...DEFAULT_STORY_GOAL_CONFIG }
    fullConfig = { ...saved, ...config }
    turn = existing.turn_count ?? 0
    const savedPhase = existing.current_phase as Phase
    const defaultStart: Phase = fullConfig.incubatorEnabled ? 'incubate_outline' : 'materialize_settings'
    phase = explicitPhase ?? (VALID_PHASES.includes(savedPhase) ? savedPhase : defaultStart)
    if (existing.status === 'timeout' || turn >= fullConfig.maxTurns) {
      turn = 0
    }
  } else if (explicitPhase && existing) {
    const saved = existing.goal_config_json
      ? { ...DEFAULT_STORY_GOAL_CONFIG, ...JSON.parse(existing.goal_config_json) as Partial<StoryGoalConfig> }
      : { ...DEFAULT_STORY_GOAL_CONFIG }
    fullConfig = { ...saved, ...config }
    turn = 0
    phase = explicitPhase
  } else {
    fullConfig = { ...DEFAULT_STORY_GOAL_CONFIG, ...config }
    turn = 0
    phase = explicitPhase ?? (fullConfig.incubatorEnabled ? 'incubate_outline' : 'materialize_settings')
  }

  fullConfig.maxTurns = requireGoalTurnLimit(fullConfig.maxTurns)

  const authorityState = ensureNovelAuthorityState(workId)
  const savedWorkflowDefinitionVersion = readNovelGoalState(workId).workflowDefinitionVersion
  const run = goalRoutineDAO.beginRun({
    workId,
    workflowType: 'novel',
    resume,
    maxTurns: fullConfig.maxTurns,
    currentPhase: phase,
    goalConfigJson: JSON.stringify(fullConfig),
    resetTurnCount: resume && Boolean(existing && (
      existing.status === 'timeout' || existing.turn_count >= fullConfig.maxTurns
    ))
  })
  turn = run.turn_count
  phase = (run.current_phase as Phase) || phase
  if (resume) {
    const narrativeMemoryPlan = recoverInterruptedNarrativeMemoryGateOnResume(workId)
    if (narrativeMemoryPlan) {
      updateNovelGoalState(workId, {
        repairPlan: narrativeMemoryPlan,
        repairCommitPending: undefined,
        failure: undefined,
        autonomousTerminal: undefined
      })
      goalRoutineDAO.update(workId, { status: 'running', current_phase: 'repair_execute' })
      goalRoutineDAO.appendTurn({
        work_id: workId,
        turn_no: turn,
        phase: 'repair_execute',
        action: 'narrative_memory_outline_replan_resume',
        target_chapter_id: narrativeMemoryPlan.targetChapterIds[0],
        summary: '断点账本显示章节提交的跨章记忆门禁被误路由；已回到当前未提交章节的结构重规划'
      })
      phase = 'repair_execute'
    }
  }
  if (resume && phase === 'repair_execute') {
    const structuralReplan = recoverInterruptedExecutionContractRepairOnResume(workId)
    if (structuralReplan) {
      updateNovelGoalState(workId, {
        repairPlan: structuralReplan,
        failure: undefined,
        autonomousTerminal: undefined
      })
      goalRoutineDAO.update(workId, { status: 'running', current_phase: 'repair_execute' })
      goalRoutineDAO.appendTurn({
        work_id: workId,
        turn_no: turn,
        phase: 'repair_execute',
        action: 'execution_contract_structural_replan_resume',
        target_chapter_id: structuralReplan.targetChapterIds[0],
        summary: '断点恢复发现章节合同正文补丁已耗尽，恢复一次性当前章节结构重规划而非重复修订正文'
      })
      phase = 'repair_execute'
    }
  }
  if (authorityState.created) {
    goalRoutineDAO.appendTurn({
      work_id: workId,
      turn_no: turn,
      phase,
      action: 'authority_state_materialized',
      summary: authorityState.sourceRunId == null
        ? '已建立作品级小说权威状态'
        : `已从历史运行 #${authorityState.sourceRunId} 迁移作品级小说权威状态`
    })
  }

  try {
    const frozen = ensureWorkflowModelContract(
      run.id,
      storyGoalModelOpts(fullConfig)
    )
    if (frozen.created) {
      goalRoutineDAO.appendTurn({
        work_id: workId,
        turn_no: turn,
        phase,
        action: 'model_contract_frozen',
        summary: `已冻结本次运行的模型、协议与生成参数合同 ${frozen.hash.slice(0, 12)}`
      })
    }
  } catch (error) {
    markNovelAutonomousTerminal({
      workId,
      phase,
      code: 'MODEL_CONTRACT_PREFLIGHT',
      message: error instanceof Error ? error.message : String(error)
    })
    goalRoutineDAO.appendTurn({
      work_id: workId,
      turn_no: turn,
      phase,
      action: 'model_contract_preflight_failed',
      summary: error instanceof Error ? error.message : String(error)
    })
    throw error
  }

  const controller = new AbortController()
  registerNovelGoalLoop(workId, controller)
  bindGoalLoopModelOpts(workId, fullConfig)

  const workflowUpgrade = reconcileNovelWorkflowDefinition({
    workId,
    resume,
    phase,
    savedVersion: savedWorkflowDefinitionVersion,
    turn
  })
  phase = workflowUpgrade.phase

  if (resume && phase === 'generate_beats' && reopenStalledNovelVolumeGate(workId)) {
    goalRoutineDAO.appendTurn({
      work_id: workId,
      turn_no: turn,
      phase,
      action: 'repair_stall_resume',
      summary: '自治恢复：保留章节、候选版本和累计改写预算，重新执行只读分卷诊断'
    })
  }
  const hasNoNovelStructure = volumeChapterDAO.listVolumes(workId).length === 0
    && volumeChapterDAO.listChaptersByWork(workId).length === 0
  if (!resume && explicitPhase === 'generate_volumes' && hasNoNovelStructure) {
    resetNovelGoalStateFromVolumePlan(workId)
  }
  reconcileNovelChapterExecutionProtocol({ workId, resume, phase, turn })
  updateNovelGoalState(workId, {
    chapterExecutionProtocolVersion: CHAPTER_EXECUTION_CONTRACT_VERSION,
    autonomousTerminal: undefined,
    ...(!resume && !explicitPhase
      ? {
          titleHookCandidates: undefined,
          titleHookPreferredIndex: undefined,
          titleHookApplied: undefined,
          finalAudit: undefined
        }
      : {}),
    ...(!resume ? {
      autonomousEpoch: 1,
      autonomousChapterEscalations: {},
      chapterTransactionBudgets: {},
      failure: undefined,
      repairStall: undefined
    } : {})
  })
  const persistedRepairTarget = readNovelGoalState(workId).repairPlan?.targetChapterIds[0]
  if (persistedRepairTarget != null) {
    const acceptance = getNovelChapterAcceptanceSummary(workId)
    if (acceptance) {
      reconcileAutonomousRepairFromAcceptance(workId, persistedRepairTarget, acceptance)
    }
  }
  if (!resume && !explicitPhase && volumeChapterDAO.listChaptersByWork(workId).length === 0) {
    updateNovelGoalState(workId, {
      novelOutline: undefined,
      volumePlanChecked: undefined,
      volumeQualityReport: undefined,
      repairPlan: undefined,
      failure: undefined,
      overallRepairRounds: 0,
      repairStall: undefined,
      checkedChapterVolumes: undefined,
      pendingChapterVolumeGate: undefined,
      chapterVolumeGateCheckpoint: undefined,
      checkedBodyVolumes: undefined,
      titleHookCandidates: undefined,
      titleHookPreferredIndex: undefined,
      titleHookApplied: undefined,
      finalAudit: undefined
    })
  }
  goalRoutineDAO.update(workId, {
    status: 'running',
    max_turns: fullConfig.maxTurns,
    turn_count: turn,
    current_phase: phase,
    goal_met: false,
    goal_config_json: JSON.stringify(fullConfig)
  })

  let lastCheck: GoalCheckResult | undefined = readNovelGoalState(workId).lastCheck

  const emit = (message: string, status: string) => {
    const ev: GoalProgressEvent = {
      workId, turn, maxTurns: fullConfig.maxTurns, phase, status, check: lastCheck, message
    }
    broadcastNovelGoalProgress('goal:progress', ev)
  }

  // 单次模型调用可能超过租约时长；没有后台心跳时，运行会在仍有请求
  // 进行的情况下失去租约，界面看起来像卡在“1 / 600”，并允许其他执行器
  // 错误接管同一个检查点。心跳只续期仍由本执行器持有且用户未取消的运行。
  const heartbeat = setInterval(() => {
    if (controller.signal.aborted) return
    const current = goalRoutineDAO.getByWork(workId)
    if (!current || current.status !== 'running' || current.desired_state !== 'running') return
    if (goalRoutineDAO.heartbeat(workId, phase)) {
      emit(`正在执行「${phase}」，后台仍在处理`, 'running')
    }
  }, 15_000)

  try {
    while (true) {
      if (controller.signal.aborted) {
        goalRoutineDAO.setStatus(workId, 'cancelled')
        emit('已取消', 'cancelled')
        return
      }

      const requestedPhase = phase
      const prerequisitePhase = safeNovelPreparationPhase(
        workId,
        requestedPhase,
        fullConfig.goalDescription,
        fullConfig.goldenFingerRequired,
        fullConfig.checkEmotionContract
      )
      if (prerequisitePhase !== requestedPhase) {
        phase = prerequisitePhase
        updateNovelGoalState(workId, { failure: undefined })
        goalRoutineDAO.update(workId, { status: 'running', current_phase: phase })
        goalRoutineDAO.appendTurn({
          work_id: workId,
          turn_no: turn,
          phase,
          action: 'prerequisite_redirect',
          summary: `「${requestedPhase}」前置条件未完成，自动回退到「${prerequisitePhase}」；保留已有正文、章节与版本`
        })
        emit(`检测到「${requestedPhase}」前置条件未完成，已无损回退到「${prerequisitePhase}」`, 'running')
        continue
      }

      if (isNovelHardBudgetExhausted(turn, fullConfig.maxTurns)) {
        const runtime = readNovelGoalState(workId)
        const epoch = runtime.autonomousEpoch ?? 1
        const maxEpochs = normalizeAutonomousMaxEpochs(fullConfig.autonomousMaxEpochs)
        if (epoch < maxEpochs) {
          turn = 0
          updateNovelGoalState(workId, {
            autonomousEpoch: epoch + 1,
            failure: undefined
          })
          goalRoutineDAO.update(workId, {
            status: 'running',
            turn_count: 0,
            current_phase: phase
          })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: 0,
            phase,
            action: 'autonomous_epoch_rollover',
            summary: `自治执行周期 ${epoch}/${maxEpochs} 已完成；从持久化检查点自动开启周期 ${epoch + 1}`
          })
          emit(`自治周期 ${epoch + 1}/${maxEpochs} 已自动开始，无需人工续跑`, 'running')
          continue
        }
        goalRoutineDAO.appendTurn({
          work_id: workId,
          turn_no: turn,
          phase,
          action: 'budget_exhausted',
          summary: `已用完 ${maxEpochs} 个自治周期，保存全部正文、候选、检查点和权威状态`
        })
        goalRoutineDAO.setStatus(workId, 'timeout')
        emit(`自治总预算已用完（${maxEpochs} 周期），运行进入明确预算终态`, 'timeout')
        return
      }

      turn++
      goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
      const attemptedPhase = phase
      goalRoutineDAO.appendTurn({
        work_id: workId,
        turn_no: turn,
        phase: attemptedPhase,
        action: 'phase_start',
        summary: `开始执行「${attemptedPhase}」阶段`
      })
      const runtimeBeforeStep = readNovelGoalState(workId)
      const scopedChapter = attemptedPhase === 'draft_body'
        ? nextPendingDraftChapter(workId, fullConfig)
        : null
      const scopedChapterId = scopedChapter?.id
        ?? (attemptedPhase === 'repair_execute'
          ? runtimeBeforeStep.repairPlan?.targetChapterIds?.[0]
          : undefined)
      const attemptedStepKey = attemptedPhase === 'draft_body' && scopedChapter
        ? resolveNovelDraftWorkflowStep({
            hasCausalState: Boolean(causalNovelDAO.getState(workId)),
            decisionReady: isUnifiedNovelDecisionReady(workId, scopedChapter.id),
            needsGeneration: scopedChapter.needsGeneration,
            needsAcceptance: scopedChapter.needsAcceptance,
            precommitReady: hasUnifiedNovelPrecommitArtifacts(workId, scopedChapter.id)
          })
        : attemptedPhase === 'repair_execute'
          ? 'repair_execute'
          : attemptedPhase
      const acceptanceIdentity = attemptedStepKey === 'body_acceptance' && scopedChapter
        ? resolveNovelChapterAcceptanceIdentity(workId, scopedChapter.id, fullConfig)
        : null
      const stepInstance = goalRoutineDAO.beginStep({
        workId,
        stepKey: attemptedStepKey,
        phaseKey: attemptedPhase,
        scopeKey: attemptedStepKey === 'causal_state_init'
          ? `work:${workId}`
          : scopedChapterId ? `chapter:${scopedChapterId}` : `work:${workId}`,
        input: acceptanceIdentity
          ? {
              phase: attemptedPhase,
              operation: attemptedStepKey,
              chapterId: scopedChapterId,
              episodeKey: acceptanceIdentity.episodeKey,
              baseContentHash: acceptanceIdentity.baseContentHash,
              contractHash: acceptanceIdentity.contractHash,
              protocolVersion: acceptanceIdentity.protocolVersion
            }
          : buildNovelWorkflowStepInput({
              phase: attemptedPhase,
              operation: attemptedStepKey,
              stateRevision: causalNovelDAO.getState(workId)?.revision ?? null,
              pendingReplayJobId: causalNovelDAO.getPendingReplay(workId)?.id ?? null,
              repairPlan: runtimeBeforeStep.repairPlan ?? null,
              chapters: volumeChapterDAO.listChaptersByWork(workId),
              scopedChapterId
            }),
        protocolVersion: acceptanceIdentity
          ? CHAPTER_ACCEPTANCE_PROTOCOL_VERSION
          : novelWorkflowStepProtocolVersion(attemptedStepKey)
      })
      const attemptedStepLabel = attemptedStepKey === attemptedPhase
        ? attemptedPhase
        : novelDraftWorkflowStepLabel(attemptedStepKey as NovelDraftWorkflowStep)
      if (attemptedStepKey !== attemptedPhase) {
        goalRoutineDAO.appendTurn({
          work_id: workId,
          turn_no: turn,
          phase: attemptedPhase,
          action: 'substep_start',
          target_chapter_id: scopedChapterId ?? null,
          summary: `开始执行可恢复子步骤「${attemptedStepLabel}」`
        })
      }
      setWorkflowExecutionContext({
        runId: stepInstance.run_id,
        stepInstanceId: stepInstance.id,
        workId,
        stepKey: attemptedStepKey
      })
      let workflowStepFailure: ClassifiedWorkflowError | undefined
      let workflowStepDisposition: 'completed' | 'needs_repair' = 'completed'
      try {
        const pendingReplay = causalNovelDAO.getPendingReplay(workId)
        if (pendingReplay?.status === 'blocked') {
          const replayTargets = [...new Set([
            pendingReplay.chapterId,
            ...pendingReplay.affectedChapterIds
          ])]
          causalNovelDAO.cancelReplay(pendingReplay.id)
          updateNovelGoalState(workId, {
            repairPlan: {
              action: 'cluster',
              scope: 'cluster',
              targetChapterIds: replayTargets,
              hint: [
                '因果重放冲突已自动升级为依赖闭包结构重规划。',
                pendingReplay.errorMessage ?? '重放前置状态与后续章节不再蕴含'
              ].join('\n'),
              issueCodes: ['CAUSAL_REPLAY_CONFLICT']
            } satisfies RepairPlan,
            failure: undefined
          })
          phase = 'repair_execute'
          goalRoutineDAO.update(workId, { status: 'running', current_phase: phase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'causal_replay_autonomous_replan',
            target_chapter_id: pendingReplay.chapterId,
            summary: `因果重放冲突已原子恢复到源版本，自动重规划 ${replayTargets.length} 章依赖闭包`
          })
          emit(
            `因果重放冲突已升级为 ${replayTargets.length} 章依赖闭包重规划`,
            'running'
          )
          continue
        }
        if (pendingReplay) {
          const replayed = await processPendingCausalReplay(
            workId,
            fullConfig,
            controller.signal,
            message => emit(message, 'running')
          )
          if (!replayed) throw new Error('待处理因果重放任务没有产生重放结果')
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'causal_replay_complete',
            target_chapter_id: pendingReplay.chapterId,
            summary: `因果重放 #${replayed.replayJobId} 完成，`
              + `${replayed.replayedChapters} 章已提交到 r${replayed.finalRevision}`
          })
          emit(`因果重放完成，下一轮恢复「${attemptedPhase}」`, 'running')
          continue
        }
        if (phase === 'incubate_outline') {
          const count = await incubateStoryline(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'incubate', summary: `完成 ${count} 个孵化槽位`
          })
          emit(`完成 ${count} 个孵化槽位`, 'running')
          phase = 'incubator_gate'
        } else if (phase === 'incubator_gate') {
          const res = await runStorylineGate(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'gate',
            score: Math.min(res.serializabilityScore, res.conflictClosureScore),
            summary: res.repairRounds > 0
              ? `门禁通过：自动修复 ${res.repairRounds} 轮 · 可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`
              : `门禁通过：可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`
          })
          emit(res.repairRounds > 0
            ? `门禁通过：已自动修复 ${res.repairRounds} 轮 · 可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`
            : `门禁通过：可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`, 'running')
          phase = 'freeze_storyline'
        } else if (phase === 'freeze_storyline') {
          const versionId = await freezeStoryline(workId, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'freeze',
            summary: `冻结孵化版本 #${versionId}`
          })
          emit(`冻结孵化版本 #${versionId}`, 'running')
          phase = 'materialize_settings'
        } else if (phase === 'materialize_settings') {
          const count = await materializeNovelSettings(
            workId,
            fullConfig.goalDescription,
            fullConfig.goldenFingerRequired,
            controller.signal,
            msg => emit(msg, 'running')
          )
          emit('正在抽取资源约束账本', 'running')
          const resourceCount = await refreshResourceConstraints(workId, controller.signal)
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'settings', summary: `生成 ${count} 项核心设定，抽取 ${resourceCount} 项资源约束`
          })
          emit(`生成 ${count} 项核心设定，抽取 ${resourceCount} 项资源约束`, 'running')
          phase = 'generate_character_cards'
        } else if (phase === 'generate_character_cards') {
          emit('正在生成主角人设卡片', 'running')
          const count = await generateNovelCharacterCards(workId, controller.signal)
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'character_cards', summary: `生成 ${count} 张主角人设卡片`
          })
          emit(`生成 ${count} 张主角人设卡片`, 'running')
          phase = fullConfig.checkEmotionContract ? 'emotion_engine_gate' : 'overall_self_check'
        } else if (phase === 'emotion_engine_gate') {
          await runNovelEmotionEnginePreparation({
            workId,
            turn,
            enabled: fullConfig.checkEmotionContract,
            goal: fullConfig.goalDescription,
            signal: controller.signal,
            emit
          })
          phase = 'overall_self_check'
        } else if (phase === 'generate_title_hook') {
          emit('正在生成书名和导语', 'running')
          const selection = await generateNovelTitleHook(workId, fullConfig.goalDescription, controller.signal)
          const picked = selection.preferred
          workDAO.update(workId, { title: picked.title, description: picked.hook || undefined })
          updateNovelGoalState(workId, {
            titleHookCandidates: selection.candidates,
            titleHookPreferredIndex: selection.preferredIndex,
            titleHookApplied: true
          })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'title_hook_auto_selected',
            summary: `AI 从 ${selection.candidates.length} 套候选中自动选择并应用书名「${picked.title}」`
          })
          emit(`AI 已自动选择并应用书名「${picked.title}」`, 'running')
          phase = 'draft_body'
        } else if (phase === 'overall_self_check') {
          emit('正在运行整体自检', 'running')
          const report = await runNovelOverallSelfCheck(workId, controller.signal)
          const conclusionText = report.match(/(PASS|FAIL|REVISE|通过|不通过|需修订).{0,40}/i)?.[0] ?? '自检完成'
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'overall_check', summary: conclusionText
          })
          const qualityStatus = getSettingsQualityStatus(workId)
          if (!qualityStatus.canProceed) {
            if (qualityStatus.blockingCount === 0) {
              throw new Error(
                `SETTINGS_QUALITY_REVIEW_REQUIRED: 整体自检无 blocking 项，但总分 ${qualityStatus.overallScore ?? '-'} 未达到放行条件；停止自动重写，等待复核自检协议或人工审阅`
              )
            }
            const runtime = readNovelGoalState(workId)
            const repairRound = runtime.overallRepairRounds ?? 0
            const revised = await repairNovelSettingsFromOverallCheck(
              workId,
              report,
              controller.signal,
              message => emit(message, 'running')
            )
            updateNovelGoalState(workId, { overallRepairRounds: repairRound + 1 })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'settings_repair',
              summary: `整体自检未通过，自动修订 ${revised} 项设定（第 ${repairRound + 1} 轮，达标前持续修订）`
            })
            coreSettingDAO.deleteByWorkAndTypes(workId, ['emotion_engine'])
            phase = 'generate_character_cards'
          } else {
            updateNovelGoalState(workId, { overallRepairRounds: 0 })
            emit(`整体自检通过：${conclusionText}`, 'running')
            phase = 'generate_volumes'
          }
        } else if (phase === 'generate_volumes') {
          const result = await prepareNovelVolumePlan(
            workId,
            fullConfig.goalDescription,
            controller.signal,
            msg => emit(msg, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'volumes',
            summary: `分卷大纲已冻结：${result.volumes} 卷${result.revised ? '，经门禁整体修订' : ''}`
          })
          emit(`分卷大纲完成：${result.volumes} 卷，进入章节大纲`, 'running')
          phase = 'generate_beats'
        } else if (phase === 'generate_beats') {
          const reconciled = reconcileNovelWorkflowState(workId)
          if (reconciled.changed) {
            emit(
              `检测到分卷事实数据与冻结检查点不一致，已自动失效章节门禁 ${reconciled.invalidatedChapterVolumes.length} 卷、正文门禁 ${reconciled.invalidatedBodyVolumes.length} 卷`,
              'running'
            )
          }
          const outlinedChapters = volumeChapterDAO.listChaptersByWork(workId)
          const outlineState = readNovelGoalState(workId)
          const workflow = outlineState.novelOutline
            ? resolveNovelVolumeWorkflowCheckpoint(
                outlineState.novelOutline.volumePlan,
                outlinedChapters,
                outlineState.checkedChapterVolumes,
                outlineState.checkedBodyVolumes
              )
            : undefined
          if (workflow?.kind === 'body_gate') {
            const volumeChapters = outlinedChapters.filter(chapter => chapter.volume_name === workflow.volume.name)
            const lastVolumeChapter = volumeChapters.at(-1)
            if (!lastVolumeChapter) {
              throw new NovelPipelineError('CONTRACT_INVALID', `分卷「${workflow.volume.name}」缺少正文检查点章节`)
            }
            const checkpoint = await runVolumeBodyCheckpoint(
              workId,
              lastVolumeChapter.id,
              fullConfig.goalDescription,
              fullConfig,
              controller.signal,
              msg => emit(msg, 'running')
            )
            if (!checkpoint.passed) {
              emit(`恢复分卷检查点后需要重写尾部窗口：${checkpoint.summary}`, 'running')
              phase = 'draft_body'
              continue
            }
            emit(`「${workflow.volume.name}」正文检查点已冻结，允许规划下一卷`, 'running')
            continue
          }
          if (workflow?.kind === 'draft_body') {
            phase = outlineState.titleHookApplied ? 'draft_body' : 'generate_title_hook'
            emit(
              outlineState.titleHookApplied
                ? '当前分卷章节大纲已冻结，转入该卷正文生成'
                : '首卷章节大纲已冻结，先生成书名导语再写正文',
              'running'
            )
            continue
          }
          if (workflow?.kind === 'complete') {
            phase = 'goal_check'
            emit('全部分卷章节大纲、正文及卷末检查点均已冻结，进入整书目标验收', 'running')
            continue
          }
          const res = await generateNextNovelOutlineBatch(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'beats',
            summary: res.created > 0
              ? `生成章节大纲 ${res.range?.start}-${res.range?.end}，剩余 ${res.remaining} 章${res.volumeGate ? `；「${res.volumeGate.volume}」整卷门禁${res.volumeGate.deferredIssues ? `安全冻结并延后 ${res.volumeGate.deferredIssues} 项模型问题` : '通过'}（${res.volumeGate.score}分，${res.volumeGate.rounds}轮）` : ''}`
              : `章节大纲完整，复用 ${res.reused} 章`
          })
          if (res.volumeGate) {
            emit(
              res.volumeGate.deferredIssues
                ? `「${res.volumeGate.volume}」已安全冻结：${res.volumeGate.score}分，${res.volumeGate.deferredIssues} 项模型问题转入延后修复账本`
                : `「${res.volumeGate.volume}」章节大纲门禁通过：${res.volumeGate.score}分`,
              'running'
            )
          }
          emit(res.volumeReadyForDraft
            ? `「${res.volumeReadyForDraft}」章节大纲已冻结，转入该卷正文；全书剩余 ${res.remaining} 章待滚动规划`
            : res.complete
              ? `章节大纲已完整生成，共 ${res.created + res.reused} 章`
              : `本批生成 ${res.created} 章，剩余 ${res.remaining} 章`, 'running')
          const state = readNovelGoalState(workId)
          phase = nextPhaseAfterNovelOutlineCheckpoint({
            volumeReadyForDraft: Boolean(res.volumeReadyForDraft),
            titleHookApplied: Boolean(state.titleHookApplied),
            allOutlinesComplete: res.complete
          })
        } else if (phase === 'draft_body') {
          const reconciled = reconcileNovelWorkflowState(workId)
          if (reconciled.changed) {
            emit(
              `检测到正文事实数据与冻结检查点不一致，已自动回退到最早未完成分卷`,
              'running'
            )
          }
          const draftState = readNovelGoalState(workId)
          const draftChapters = volumeChapterDAO.listChaptersByWork(workId)
          const workflow = draftState.novelOutline
            ? resolveNovelVolumeWorkflowCheckpoint(
                draftState.novelOutline.volumePlan,
                draftChapters,
                draftState.checkedChapterVolumes,
                draftState.checkedBodyVolumes
              )
            : undefined
          if (workflow && workflow.kind !== 'draft_body') {
            phase = workflow.kind === 'complete' ? 'goal_check' : 'generate_beats'
            emit(
              workflow.kind === 'outline_gate'
                ? `「${workflow.volume.name}」章节门禁尚未通过，禁止生成正文`
                : workflow.kind === 'generate_outline'
                  ? `「${workflow.volume.name}」章节大纲尚未完整，禁止生成正文`
                  : workflow.kind === 'body_gate'
                    ? `「${workflow.volume.name}」正文完整，先执行卷末检查点`
                    : '全部分卷已冻结，进入整书目标验收',
              'running'
            )
            continue
          }
          const chapter = nextPendingDraftChapter(workId, fullConfig)
          if (!chapter) {
            phase = phaseAfterCurrentDraftWindow(workId)
            emit(
              phase === 'generate_beats'
                ? '当前分卷正文已冻结，开始滚动规划下一卷章节大纲'
                : '正文已全部生成，进入只读整书目标验收',
              'running'
            )
          } else {
            const chapterRow = draftChapters.find(item => item.id === chapter.id)
            if (!chapterRow || !workflow || chapterRow.volume_name !== workflow.volume.name) {
              throw new NovelPipelineError(
                'CONTRACT_INVALID',
                `正文目标章节不属于当前已冻结分卷「${workflow?.kind === 'draft_body' ? workflow.volume.name : '未知'}」`
              )
            }
            if (attemptedStepKey === 'causal_state_init') {
              await initializeCausalNovelState(
                workId,
                fullConfig.goalDescription,
                controller.signal,
                msg => emit(msg, 'running'),
                fullConfig.checkEmotionContract
              )
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'causal_state_initialized',
                summary: '已从卷级阶段、当前章节窗口与当前事实投影建立权威因果状态'
              })
              emit('权威因果状态初始化完成，下一轮生成当前章因果决策', 'running')
              phase = 'draft_body'
              continue
            }
            if (attemptedStepKey === 'chapter_decision') {
              await ensureUnifiedNovelDecision(
                workId,
                chapter.id,
                fullConfig.goalDescription,
                controller.signal,
                msg => emit(msg, 'running'),
                fullConfig.checkEmotionContract
              )
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'chapter_decision_planned',
                target_chapter_id: chapter.id,
                summary: `「${chapter.title}」权威因果决策已独立持久化`
              })
              emit(`「${chapter.title}」因果决策已建立，下一轮生成正文`, 'running')
              phase = 'draft_body'
              continue
            }
            await ensureUnifiedNovelDecision(
              workId,
              chapter.id,
              fullConfig.goalDescription,
              controller.signal,
              msg => emit(msg, 'running'),
              fullConfig.checkEmotionContract
            )

            if (attemptedStepKey === 'body_generation') {
              clearChapterNarrativeMemory(workId, chapter.id)
              volumeChapterDAO.updateChapter(chapter.id, { status: 'draft' })
              emit(`正在生成正文「${chapter.title}」`, 'running')
              const gen = await generateBeatBody(workId, chapter.id, {
                signal: controller.signal,
                goalDescription: fullConfig.goalDescription,
                workType: 'novel',
                deferNarrativeMemory: true,
                checkEmotionContract: fullConfig.checkEmotionContract
              })
              if (!gen.success) {
                throw new Error(gen.error || '正文生成失败')
              }
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'draft',
                target_chapter_id: chapter.id,
                summary: `生成候选正文「${chapter.title}」${gen.wordCount}字，叙事记忆尚未提交`
              })
              emit(`生成候选正文「${chapter.title}」${gen.wordCount}字；下一轮执行章节硬合同验收`, 'running')
              phase = 'draft_body'
              continue
            }

            if (attemptedStepKey === 'body_acceptance') {
              clearChapterNarrativeMemory(workId, chapter.id)
              volumeChapterDAO.updateChapter(chapter.id, { status: 'draft' })
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'diagnose_resume',
                target_chapter_id: chapter.id,
                summary: `检测到「${chapter.title}」已有正文但缺少完整验收，恢复章节硬合同验收`
              })
              emit(`「${chapter.title}」正文已存在但尚未完整验收，正在补跑章节硬合同验收`, 'running')
              const acceptance = await runChapterConvergenceGate(
                workId,
                chapter.id,
                fullConfig,
                controller.signal,
                msg => emit(msg, 'running')
              )
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'diagnose_fix',
                target_chapter_id: chapter.id,
                score: acceptance.qualityScore >= 0 ? acceptance.qualityScore : null,
                summary: acceptance.passed
                  ? `「${chapter.title}」章节硬合同通过；质量与情绪已进入卷级编辑债务`
                  : `「${chapter.title}」章节硬合同未通过：${acceptance.failedMetrics.join('、')}`
              })
              if (!acceptance.passed) {
                workflowStepDisposition = 'needs_repair'
                clearChapterNarrativeMemory(workId, chapter.id)
                volumeChapterDAO.updateChapter(chapter.id, {
                  status: 'draft', emotion_assessment_json: null
                })
                const escalation = buildAutonomousChapterRepairPlan({
                  workId,
                  chapterId: chapter.id,
                  gateType: acceptance.blockedGate,
                  failureCode: acceptance.failureCode,
                  wordRange: acceptance.wordRange,
                  failedMetrics: acceptance.failedMetrics
                })
                updateNovelGoalState(workId, {
                  repairPlan: escalation.plan,
                  failure: undefined
                })
                goalRoutineDAO.appendTurn({
                  work_id: workId,
                  turn_no: turn,
                  phase,
                  action: 'autonomous_gate_escalation',
                  target_chapter_id: chapter.id,
                  summary: `「${chapter.title}」门禁未通过，自动升级到 L${escalation.level} ${escalation.plan.scope} 修复`
                })
                emit(
                  `「${chapter.title}」门禁未收敛，正在自动执行 L${escalation.level} ${escalation.plan.scope} 修复`,
                  'running'
                )
                phase = 'repair_execute'
                continue
              }
              emit(`「${chapter.title}」章节硬合同通过；下一轮生成一次携证状态事务并原子提交`, 'running')
              phase = 'draft_body'
              continue
            }

            if (attemptedStepKey === 'precommit_artifacts') {
              emit(`「${chapter.title}」正文已冻结，正在准备哈希绑定的叙事记忆与因果结果`, 'running')
              await prepareUnifiedNovelChapterCommit(
                workId, chapter.id, fullConfig, controller.signal, msg => emit(msg, 'running')
              )
              phase = 'draft_body'
              continue
            }

            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'memory_resume',
              target_chapter_id: chapter.id,
              summary: `「${chapter.title}」章节硬合同已完成，仅执行携证状态事务和原子提交`
            })
            emit(`「${chapter.title}」验收结果完整，正在提交章级记忆与因果后果`, 'running')
            const resumed = volumeChapterDAO.getChapter(chapter.id)
            const cachedQuality = parseCachedQualityAssessment(
              resumed?.quality_assessment_json,
              resumed?.content ?? ''
            )
            const cachedEmotion = parseStoredEmotionAssessment(resumed?.emotion_assessment_json)
            const acceptance: Awaited<ReturnType<typeof runChapterAcceptanceGate>> = {
              passed: isStrictCachedQualityReady(cachedQuality)
                && cachedEmotion?.passed === true
                && cachedEmotion.outcome_meta?.accepted_deferred !== true,
              deferred: false,
              qualityScore: cachedQuality?.scoreTotal ?? -1,
              emotionScore: cachedEmotion?.score,
              rounds: 0,
              failedMetrics: []
            }

            const transitionBlockers = strictChapterTransitionBlockers(
              workId,
              chapter.id,
              fullConfig
            )
            if (transitionBlockers.length > 0) {
              clearChapterNarrativeMemory(workId, chapter.id)
              volumeChapterDAO.updateChapter(chapter.id, {
                status: 'draft',
                emotion_assessment_json: null
              })
              throw new Error(
                `「${chapter.title}」最终提交前确定性复核未通过，禁止进入下一章：${transitionBlockers.join('；')}`
              )
            }
            const previousBinding = causalNovelDAO.getChapterBinding(chapter.id)
            const previousBoundContent = previousBinding
              ? causalNovelDAO.getContentVersion(previousBinding.contentVersionId)?.content.trim() ?? ''
              : ''
            const acceptedChapter = volumeChapterDAO.getChapter(chapter.id)
            if (acceptedChapter && acceptedChapter.word_count !== countWords(acceptedChapter.content ?? '')) {
              volumeChapterDAO.updateChapter(chapter.id, {
                word_count: countWords(acceptedChapter.content ?? '')
              })
            }
            if (
              previousBoundContent
              && acceptedChapter?.content?.trim()
              && acceptedChapter.content.trim() !== previousBoundContent
            ) {
              const invalidated = invalidateDownstreamBodiesAfterAcceptedChapterRewrite(
                workId,
                chapter.id
              )
              if (invalidated > 0) {
                goalRoutineDAO.appendTurn({
                  work_id: workId,
                  turn_no: turn,
                  phase,
                  action: 'downstream_body_invalidate',
                  target_chapter_id: chapter.id,
                  summary: `「${chapter.title}」严格复验后正文发生变化，已为后续 ${invalidated} 章保留版本并失效正文，防止沿用旧连续性`
                })
                emit(`「${chapter.title}」已改写，后续 ${invalidated} 章正文已留版本并等待重新生成`, 'running')
              }
            }

            const committed = await commitUnifiedNovelChapter(
              workId,
              chapter.id,
              fullConfig,
              controller.signal,
              msg => emit(msg, 'running')
            )
            goalRoutineDAO.appendTurn({
              work_id: workId, turn_no: turn, phase, action: 'unified_chapter_commit',
              target_chapter_id: chapter.id,
              summary: `「${chapter.title}」正文哈希、记忆、资源后果与权威状态已原子提交到 r${committed.revision}：${committed.summary}`
            })

            const volumeCheckpoint = await runVolumeBodyCheckpoint(
              workId,
              chapter.id,
              fullConfig.goalDescription,
              fullConfig,
              controller.signal,
              msg => emit(msg, 'running')
            )
            if (!volumeCheckpoint.passed) {
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'volume',
                target_chapter_id: chapter.id,
                summary: `分卷正文检查点未通过，${volumeCheckpoint.summary}`
              })
              emit(`分卷正文检查点未通过，${volumeCheckpoint.summary}`, 'running')
              phase = 'draft_body'
              continue
            }
            if (volumeCheckpoint.summary) emit(`分卷正文检查点通过：${volumeCheckpoint.summary}`, 'running')

            const nextChapter = nextPendingDraftChapter(workId, fullConfig)
            if (nextChapter?.id === chapter.id) {
              throw new Error(
                `「${chapter.title}」提交完成后仍被识别为待处理章节，拒绝写入虚假的 acceptance_complete`
              )
            }
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'acceptance_complete',
              target_chapter_id: chapter.id,
              score: acceptance.qualityScore >= 0 ? acceptance.qualityScore : null,
              summary: `「${chapter.title}」全部门禁完成，可进入下一章`
            })
            clearAutonomousChapterEscalation(workId, chapter.id)
            phase = resolvePendingNovelReleaseWindow(workId)
              ? 'release_window_audit'
              : nextChapter
                ? 'draft_body'
                : phaseAfterCurrentDraftWindow(workId)
          }
        } else if (phase === 'release_window_audit') {
          const releaseWindow = await runNovelReleaseWindowAuditPhase({
            workId,
            turn,
            config: fullConfig,
            signal: controller.signal,
            emit
          })
          phase = releaseWindow.phase
          if (releaseWindow.stop) return
        } else if (phase === 'goal_check') {
          emit('正在进行完整性、权威状态与一次性整书编辑审读', 'running')
          lastCheck = await checkStoryGoal(
            workId,
            fullConfig,
            controller.signal,
            msg => emit(msg, 'running')
          )
          lastCheck = requireUnifiedNovelAuthorityCompletion(workId, lastCheck)
          updateNovelGoalState(workId, { lastCheck })
          goalRoutineDAO.update(workId, {
            last_quality_score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : null,
            goal_met: lastCheck.met
          })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'check',
            score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : lastCheck.goalMatchScore,
            summary: lastCheck.met ? '目标达成' : lastCheck.reasons.join('；')
          })

          const expectedChapters = loadWritingPlan(workId).targetChapters
          if (expectedChapters > 0 && lastCheck.totalBeats < expectedChapters) {
            emit(`章节数量不完整：${lastCheck.totalBeats}/${expectedChapters}，返回章节大纲生成`, 'running')
            phase = 'generate_beats'
            continue
          }
          if (lastCheck.contentBeats < lastCheck.totalBeats) {
            emit(`正文未全部完成：${lastCheck.contentBeats}/${lastCheck.totalBeats}，返回正文生成`, 'running')
            phase = 'draft_body'
            continue
          }

          if (lastCheck.met) {
            const release = freezeUnifiedNovelRelease(workId, lastCheck)
            if (release) {
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'unified_release',
                summary: `独立整书终审与因果终止条件同时通过，冻结发布快照 #${release.snapshotId}（状态 r${release.revision}）`
              })
            }
            updateNovelGoalState(workId, {
              repairPlan: undefined,
              repairStall: undefined,
              finalAudit: { passed: true, auditedAt: new Date().toISOString(), reasons: [] }
            })
            goalRoutineDAO.setStatus(workId, 'goal_met')
            emit(`目标达成：质量${lastCheck.qualityScore} · 情绪盲读${lastCheck.emotionScore} · 目标匹配${lastCheck.goalMatchScore} · 章节${lastCheck.contentBeats}/${lastCheck.totalBeats} · 字数${lastCheck.totalWords}${release ? ` · 发布快照#${release.snapshotId}` : ''}`, 'goal_met')
            return
          }

          if (
            (expectedChapters <= 0 || lastCheck.totalBeats === expectedChapters)
            && lastCheck.contentBeats === lastCheck.totalBeats
          ) {
            updateNovelGoalState(workId, {
              finalAudit: {
                passed: false,
                auditedAt: new Date().toISOString(),
                reasons: lastCheck.reasons
              }
            })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'audit_autonomous_repair',
              summary: `整书终审未通过，自动进入证据修复：${lastCheck.reasons.join('；')}`
            })
            emit(`整书终审未通过，正在自动制定依赖修复计划`, 'running')
            phase = 'repair_plan'
            continue
          }

          emit(`未达标：${lastCheck.reasons.join('；')}`, 'running')
          phase = 'repair_plan'
        } else if (phase === 'repair_plan') {
          if (!lastCheck) {
            throw new NovelPipelineError('PREREQUISITE_MISSING', '缺少最近一次整书终审结果，不能制定修复计划')
          }
          const signature = repairReasonSignature(lastCheck!.reasons)
          const evidence = repairEvidenceSnapshot(lastCheck!)
          const previousStall = readNovelGoalState(workId).repairStall
          const noEvidenceImprovement = previousStall?.signature === signature
            && previousStall.issueFingerprint === evidence.fingerprint
            && evidence.count >= (previousStall.blockerCount ?? evidence.count)
          const stallCount = noEvidenceImprovement ? previousStall.count + 1 : 1
          updateNovelGoalState(workId, {
            repairStall: {
              signature,
              issueFingerprint: evidence.fingerprint,
              blockerCount: evidence.count,
              count: stallCount
            }
          })
          const basePlan = buildNovelRepairPlan(workId, lastCheck!, fullConfig)
          const existingIds = new Set(
            volumeChapterDAO.listChaptersByWork(workId).map(chapter => chapter.id)
          )
          const boundedTargets = [...new Set(basePlan.targetChapterIds)]
            .filter(chapterId => existingIds.has(chapterId))
          if (boundedTargets.length === 0) {
            throw new NovelPipelineError('CONTRACT_INVALID', '终审证据没有可解析的章节修复目标')
          }
          const plan: RepairPlan = stallCount >= MAX_REPAIR_STALL_ROUNDS
            ? {
                action: stallCount >= MAX_NOVEL_REPAIR_STALLS ? 'volume' : 'cluster',
                scope: stallCount >= MAX_NOVEL_REPAIR_STALLS ? 'volume' : 'cluster',
                targetChapterIds: boundedTargets,
                hint: [
                  `同一验收证据连续 ${stallCount} 轮未改善，自动升级为${stallCount >= MAX_NOVEL_REPAIR_STALLS ? '卷级依赖' : '章节簇'}结构修复。`,
                  basePlan.hint,
                  ...lastCheck!.reasons
                ].join('\n'),
                issueCodes: basePlan.issueCodes,
                evidenceFingerprint: basePlan.evidenceFingerprint
              }
            : { ...basePlan, targetChapterIds: boundedTargets }
          if (stallCount >= MAX_REPAIR_STALL_ROUNDS) {
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'repair_escalate',
              summary: `相同验收问题连续 ${stallCount} 轮未改善，已升级为尾部 ${boundedTargets.length} 章结构修复`
            })
            emit(`相同验收问题未改善，已升级到尾部 ${boundedTargets.length} 章结构修复`, 'running')
          }
          updateNovelGoalState(workId, { repairPlan: plan })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: plan.action,
            target_chapter_id: plan.targetChapterIds[0] ?? null,
            summary: `修复计划：${plan.action} · ${plan.hint}`
          })
          emit(`修复计划：${plan.action}`, 'running')
          phase = 'repair_execute'
        } else if (phase === 'repair_execute') {
          const parsed = readNovelGoalState(workId)
          const plan = (parsed.repairPlan as RepairPlan | undefined)
            ?? buildNovelRepairPlan(workId, lastCheck!, fullConfig)
          emit(`正在执行修复：${plan.action}`, 'running')
          const summary = await executeNovelRepairPlan(
            workId,
            plan,
            fullConfig.goalDescription,
            fullConfig,
            controller.signal,
            msg => emit(msg, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: plan.action,
            target_chapter_id: plan.targetChapterIds[0] ?? null,
            summary
          })
          for (const chapterId of plan.targetChapterIds) {
            clearAutonomousChapterEscalation(workId, chapterId)
          }
          // repairPlan 是一次性命令，不是长期状态。尤其结构重规划会主动
          // 失效正文；若成功后保留旧命令，后续恢复会把空正文重新送入修订。
          updateNovelGoalState(workId, { repairPlan: undefined, failure: undefined })
          emit(`执行修复：${summary}`, 'running')
          phase = resolvePendingNovelReleaseWindow(workId) ? 'release_window_audit' : 'draft_body'
        } else {
          phase = 'materialize_settings'
        }
        updateNovelGoalState(workId, { failure: undefined })
      } catch (e) {
        const protocolAttemptNo = goalRoutineDAO.getProtocolStepAttemptCount(stepInstance)
        workflowStepFailure = classifyWorkflowError(e, protocolAttemptNo)
        goalRoutineDAO.failStep(stepInstance.id, {
          errorClass: workflowStepFailure.errorClass,
          errorCode: workflowStepFailure.code,
          message: workflowStepFailure.message
        })
        const classifiedFailureCount = goalRoutineDAO.getConsecutiveWorkflowFailureCount(
          stepInstance,
          workflowStepFailure.errorClass,
          workflowStepFailure.code
        )
        if (controller.signal.aborted) {
          goalRoutineDAO.setStatus(workId, 'cancelled')
          emit('已取消', 'cancelled')
          return
        }
        const msg = e instanceof Error ? e.message : String(e)
        appLogger.error('goal_routine', '小说目标循环轮次异常', { workId, turn, error: msg })
        goalRoutineDAO.appendTurn({
          work_id: workId, turn_no: turn, phase, action: 'error', summary: msg
        })
        emit(`轮次异常：${msg}`, 'running')
        const planningRecovery = await recoverCausalPlanningAuthorityMismatch({
          workId, turn, error: e, classified: workflowStepFailure,
          goal: fullConfig.goalDescription, signal: controller.signal,
          onProgress: message => emit(message, 'running')
        })
        if (planningRecovery === 'terminal') return
        if (planningRecovery) {
          phase = planningRecovery === 'contract_replan' ? 'repair_execute' : 'draft_body'
          continue
        }
        const currentFailure = readNovelGoalState(workId).failure
        const causalProgressCode = [
          'MACRO_ARC_STAGNATION',
          'CHAPTER_NO_MATERIAL_PROGRESS',
          'REPEATED_EVENT_SIGNATURE'
        ].find(code => msg.includes(code))
        const errorCode = causalProgressCode
          ?? (attemptedPhase === 'draft_body' && msg.includes('AI 诊断未达到')
            ? 'QUALITY_GATE_NOT_MET'
            : e instanceof NovelPipelineError
              ? e.code
              : workflowStepFailure.code)
        if (
          scopedChapterId != null
          && ['MACRO_ARC_STAGNATION', 'CHAPTER_NO_MATERIAL_PROGRESS', 'REPEATED_EVENT_SIGNATURE']
            .some(code => errorCode === code || msg.includes(code))
        ) {
          const structuralPlan = buildExecutionContractStructuralReplan({
            workId,
            chapterId: scopedChapterId,
            failedMetrics: [errorCode, msg]
          })
          updateNovelGoalState(workId, {
            repairPlan: structuralPlan,
            repairCommitPending: undefined,
            failure: undefined,
            autonomousTerminal: undefined
          })
          phase = 'repair_execute'
          goalRoutineDAO.update(workId, { status: 'running', current_phase: phase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'causal_progress_structural_replan',
            target_chapter_id: scopedChapterId,
            summary: `${errorCode} 已识别为结构合同阻断，转入当前章节结构重规划，不再重试同一因果提交`
          })
          emit('检测到宏观因果推进停滞，正在重规划当前章节的阶段推进合同', 'running')
          continue
        }
        if (
          workflowStepFailure.errorClass === 'transient_transport'
          || workflowStepFailure.errorClass === 'provider_rate_limit'
        ) {
          if (classifiedFailureCount === 1) {
            turn = Math.max(0, turn - 1)
            goalRoutineDAO.update(workId, { turn_count: turn, status: 'running' })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase: attemptedPhase,
              action: 'transport_retry',
              summary: `${workflowStepFailure.code}：${msg}；`
                + `${workflowStepFailure.retryDelayMs}ms 后执行唯一一次网络重试，不消耗内容轮次`
            })
            emit(
              `模型服务暂时不可用，`
              + `${Math.ceil(workflowStepFailure.retryDelayMs / 1000)} 秒后执行唯一一次网络重试`,
              'running'
            )
            await waitForWorkflowRetry(workflowStepFailure.retryDelayMs, controller.signal)
            continue
          }
          const continuationDelay = leafFailureContinuationDelay(workflowStepFailure)
          goalRoutineDAO.update(workId, { status: 'running', current_phase: attemptedPhase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'transport_supervisor_continue',
            summary: `模型服务仍不可用；运行监督器保留同一检查点，${continuationDelay}ms 后继续，不升级整轮终态：${msg}`
          })
          emit(`模型服务暂时不可用，已保留检查点并由运行监督器继续等待`, 'running')
          await waitForWorkflowRetry(continuationDelay, controller.signal)
          continue
        }
        if (shouldPauseForNovelConstructionOutputFailure({
          phase: attemptedPhase,
          errorCode,
          message: msg
        })) {
          const terminal = classifyNovelConstructionOutputTerminal({ errorCode, message: msg })
          markNovelAutonomousTerminal({
            workId, phase: attemptedPhase,
            code: errorCode,
            message: msg
          })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: terminal.action,
            summary: msg
          })
          emit(`${terminal.progress}：${msg}`, 'error')
          return
        }
        if (workflowStepFailure.errorClass === 'response_protocol') {
          updateNovelGoalState(workId, { autonomousTerminal: undefined })
          goalRoutineDAO.update(workId, { status: 'running', current_phase: attemptedPhase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'response_protocol_supervisor_continue',
            target_chapter_id: scopedChapterId ?? null,
            summary: `叶子步骤结构化响应不满足合同，已拒绝候选并保留原始制品；运行监督器继续同一持久化阶段：${msg}`
          })
          emit(`结构化候选已拒绝并保存证据，整轮运行继续`, 'running')
          continue
        }
        if (e instanceof NovelRepairRevalidationRequiredError) {
          phase = 'draft_body'
          recoverNovelBodyContractRevalidation({
            workId, turn, chapterId: e.chapterId, emit
          })
          continue
        }
        if (
          e instanceof NovelRepairGenerationRequiredError
          || (
            e instanceof NovelRepairGateError
            && e.failedMetrics.some(metric => /最终正文为空/.test(metric))
          )
        ) {
          const chapterId = e.chapterId
          updateNovelGoalState(workId, {
            repairPlan: undefined,
            repairCommitPending: undefined,
            failure: undefined,
            autonomousTerminal: undefined
          })
          phase = 'draft_body'
          goalRoutineDAO.update(workId, { status: 'running', current_phase: phase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'empty_body_regeneration_required',
            target_chapter_id: chapterId,
            summary: `章节 ${chapterId} 的旧修订命令已失效：正文为空，已清除命令并按冻结章节合同重新生成`
          })
          emit(`章节 ${chapterId} 的旧正文已失效，正在按新合同重新生成`, 'running')
          continue
        }
        if (
          workflowStepFailure.code === 'NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED'
          && e instanceof NarrativeMemoryCommitGateError
        ) {
          const acceptedSummary = getNovelChapterAcceptanceSummary(workId)
          if (!acceptedSummary || acceptedSummary.chapterId !== e.chapterId || acceptedSummary.status !== 'accepted') {
            const resourceBlocker = e.blockers.some(blocker => /资源|resource_budget/i.test(blocker))
            if (resourceBlocker) {
              const structuralPlan = buildExecutionContractStructuralReplan({
                workId,
                chapterId: e.chapterId,
                failedMetrics: [
                  workflowStepFailure.code,
                  ...e.blockers,
                  'NARRATIVE_MEMORY_REACCEPT_REQUIRES_RESOURCE_STRUCTURAL_REPLAN'
                ]
              })
              updateNovelGoalState(workId, {
                repairPlan: structuralPlan,
                repairCommitPending: undefined,
                failure: undefined,
                autonomousTerminal: undefined
              })
              phase = 'repair_execute'
              goalRoutineDAO.update(workId, { status: 'running', current_phase: phase })
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'narrative_memory_resource_structural_replan',
                target_chapter_id: e.chapterId,
                summary: `章节 ${e.chapterId} 尚无可绑定验收事件且资源合同阻断，已转入结构重规划，不再重复完整验收`
              })
              emit(`章节 ${e.chapterId} 的资源合同未建立，先重规划资源预算再重新生成`, 'running')
              continue
            }
            updateNovelGoalState(workId, {
              repairPlan: undefined,
              repairCommitPending: undefined,
              failure: undefined,
              autonomousTerminal: undefined
            })
            phase = 'draft_body'
            goalRoutineDAO.update(workId, { status: 'running', current_phase: phase })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'narrative_memory_reaccept_required',
              target_chapter_id: e.chapterId,
              summary: `章节 ${e.chapterId} 没有可绑定的已接受验收事件，已清除旧提交恢复计划并返回完整章节验收`
            })
            emit(`章节 ${e.chapterId} 缺少有效验收事件，先重新执行完整章节验收`, 'running')
            continue
          }
          phase = 'repair_execute'
          if (!handleNarrativeMemoryCommitGate({
            workId, turn, chapterId: e.chapterId, blockers: e.blockers, emit
          })) return
          continue
        }
        if (
          workflowStepFailure.code === 'CHAPTER_TRANSACTION_PATCH_EXHAUSTED'
          && attemptedPhase === 'repair_execute'
          && scopedChapterId != null
        ) {
          const runtime = readNovelGoalState(workId)
          const exhaustedPlan = runtime.repairPlan as RepairPlan | undefined
          const retryMarker = `STRUCTURAL_REPLAN_RETRY_TURN_${turn}`
          const structuralPlan = buildExecutionContractStructuralReplan({
            workId,
            chapterId: scopedChapterId,
            failedMetrics: [
              ...(exhaustedPlan?.issueCodes ?? []),
              workflowStepFailure.code,
              msg,
              retryMarker
            ]
          })
          updateNovelGoalState(workId, {
            repairPlan: structuralPlan,
            repairCommitPending: undefined,
            failure: undefined,
            autonomousTerminal: undefined
          })
          phase = 'repair_execute'
          goalRoutineDAO.update(workId, { status: 'running', current_phase: phase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'leaf_failure_reroute_structural_replan',
            target_chapter_id: scopedChapterId,
            summary: `章节 ${scopedChapterId} 修复车道已耗尽，已转入第 ${turn} 轮独立结构重规划，不再把同一章节放回普通正文队列`
          })
          emit(`章节 ${scopedChapterId} 修复车道已耗尽，转入独立结构重规划`, 'running')
          continue
        }
        const attemptedRepairPlan = readNovelGoalState(workId).repairPlan as RepairPlan | undefined
        const previousEscalation = scopedChapterId == null
          ? undefined
          : readNovelGoalState(workId).autonomousChapterEscalations?.[String(scopedChapterId)]
        if (
          e instanceof NovelRepairGateError
          && shouldRouteExecutionContractRepairToStructuralReplan({
            attemptedPhase,
            attemptedAction: attemptedRepairPlan?.action,
            blockedGate: e.blockedGate,
            previousEvidenceFingerprint: previousEscalation?.evidenceFingerprint,
            failedMetrics: e.failedMetrics
          })
        ) {
          const replan = buildExecutionContractStructuralReplan({
            workId,
            chapterId: e.chapterId,
            failedMetrics: e.failedMetrics
          })
          updateNovelGoalState(workId, {
            repairPlan: replan,
            failure: undefined,
            autonomousTerminal: undefined
          })
          phase = 'repair_execute'
          goalRoutineDAO.update(workId, { status: 'running', current_phase: phase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'execution_contract_structural_replan',
            target_chapter_id: e.chapterId,
            summary: '章节合同定点补丁后出现新的边界证据，已转入一次性当前章节结构重规划'
          })
          emit('章节合同补丁未重试正文；正在重规划当前未提交章节的执行合同', 'running')
          continue
        }
        if (
          e instanceof NovelRepairGateError
          && shouldRouteLengthNormalizationToSemanticRepair({
            attemptedPhase,
            attemptedAction: attemptedRepairPlan?.action,
            blockedGate: e.blockedGate
          })
        ) {
          const escalation = buildAutonomousChapterRepairPlan({
            workId,
            chapterId: e.chapterId,
            gateType: 'execution_contract',
            failureCode: e.code,
            failedMetrics: e.failedMetrics
          })
          updateNovelGoalState(workId, {
            repairPlan: escalation.plan,
            failure: undefined
          })
          phase = 'repair_execute'
          goalRoutineDAO.update(workId, { status: 'running', current_phase: phase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'orthogonal_semantic_repair',
            target_chapter_id: e.chapterId,
            summary: '字数归一化完成后首次暴露执行合同阻断，转入独立语义修复车道'
          })
          emit('字数补丁已完成；执行合同阻断正在使用独立的唯一语义补丁修复', 'running')
          continue
        }
        if (
          (workflowStepFailure.route === 'repair_upstream'
            || workflowStepFailure.route === 'replan_upstream')
          && (
            e instanceof NovelRepairGateError
            || scopedChapterId != null
            || readNovelGoalState(workId).repairPlan
          )
        ) {
          const runtime = readNovelGoalState(workId)
          const existingPlan = runtime.repairPlan as RepairPlan | undefined
          const targetChapterId = e instanceof NovelRepairGateError
            ? e.chapterId
            : scopedChapterId ?? existingPlan?.targetChapterIds?.[0]
          if (targetChapterId != null) {
            const escalation = buildAutonomousChapterRepairPlan({
              workId,
              chapterId: targetChapterId,
              gateType: e instanceof NovelRepairGateError
                ? e.blockedGate
                : workflowStepFailure.route === 'replan_upstream'
                  ? 'execution_contract'
                  : undefined,
              failedMetrics: e instanceof NovelRepairGateError
                ? e.failedMetrics
                : [workflowStepFailure.code, msg]
            })
            updateNovelGoalState(workId, {
              repairPlan: escalation.plan,
              failure: undefined
            })
            phase = 'repair_execute'
            goalRoutineDAO.update(workId, { status: 'running', current_phase: phase })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'autonomous_failure_escalation',
              target_chapter_id: targetChapterId,
              summary: `${workflowStepFailure.code} 已自动升级到 L${escalation.level} ${escalation.plan.scope} 修复`
            })
            emit(
              `「${attemptedStepLabel}」失败已自动升级到 L${escalation.level} ${escalation.plan.scope} 修复`,
              'running'
            )
            continue
          }
        }
        if (shouldContinueNovelRunAfterLeafFailure({
          failure: workflowStepFailure,
          chapterId: scopedChapterId,
          phase: attemptedPhase
        })) {
          const continuationDelay = leafFailureContinuationDelay(workflowStepFailure)
          updateNovelGoalState(workId, { autonomousTerminal: undefined })
          goalRoutineDAO.update(workId, { status: 'running', current_phase: attemptedPhase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'leaf_failure_supervisor_continue',
            target_chapter_id: scopedChapterId ?? null,
            summary: `${workflowStepFailure.errorClass}/${workflowStepFailure.code} 仅拒绝当前叶子事务，整轮继续：${msg}`
          })
          emit(`「${attemptedStepLabel}」候选失败已隔离，整轮运行继续`, 'running')
          if (continuationDelay > 0) {
            await waitForWorkflowRetry(continuationDelay, controller.signal)
          }
          continue
        }
        if (workflowStepFailure.errorClass === 'user_action_required') {
          markNovelAutonomousTerminal({
            workId, phase: attemptedPhase,
            code: workflowStepFailure.code,
            message: msg
          })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: [
              'QUALITY_NON_CONVERGENT',
              'EMOTION_NON_CONVERGENT',
              'EXECUTION_CONTRACT_NON_CONVERGENT'
            ].includes(workflowStepFailure.code)
              ? 'quality_non_convergent'
              : 'autonomous_external_terminal',
            summary: `需要用户提供新的外部事实或权限：${workflowStepFailure.errorClass}/${workflowStepFailure.code}：${msg}`
          })
          emit(`运行需要新的用户输入或授权，已安全停在当前检查点：${msg}`, 'error')
          return
        }
        if (attemptedPhase === 'release_window_audit') {
          markNovelAutonomousTerminal({
            workId,
            phase: attemptedPhase,
            code: workflowStepFailure.code,
            message: msg
          })
          goalRoutineDAO.setStatus(workId, 'paused')
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'release_window_audit_terminal',
            target_chapter_id: null,
            summary: `首发窗口审读失败，已冻结同一正文哈希并暂停：${workflowStepFailure.errorClass}/${workflowStepFailure.code}：${msg}`
          })
          emit(`首发窗口审读失败，已冻结正文并暂停：${msg}`, 'error')
          return
        }
        if (
          scopedChapterId == null
          && (
            workflowStepFailure.errorClass === 'budget_exhausted'
            || workflowStepFailure.errorClass === 'response_protocol'
            || workflowStepFailure.errorClass === 'deterministic_invariant'
          )
        ) {
          markNovelAutonomousTerminal({
            workId,
            phase: attemptedPhase,
            code: workflowStepFailure.code,
            message: msg
          })
          goalRoutineDAO.setStatus(workId, 'paused')
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'work_level_protocol_terminal',
            target_chapter_id: null,
            summary: `工作级阶段失败，已保留检查点并暂停：${workflowStepFailure.errorClass}/${workflowStepFailure.code}：${msg}`
          })
          emit(`工作级阶段失败，已保留检查点并暂停：${msg}`, 'error')
          return
        }
        const signature = novelPhaseFailureSignature(
          attemptedPhase,
          errorCode,
          msg,
          attemptedStepKey === attemptedPhase ? undefined : attemptedStepKey
        )
        const failureCount = currentFailure?.phase === attemptedPhase
          && currentFailure.step === attemptedStepKey
          && currentFailure.signature === signature
          ? currentFailure.count + 1
          : 1
        updateNovelGoalState(workId, {
          failure: {
            phase: attemptedPhase,
            step: attemptedStepKey,
            signature,
            count: failureCount,
            message: msg
          }
        })
        const pendingChapterGate = attemptedPhase === 'generate_beats'
          ? readNovelGoalState(workId).pendingChapterVolumeGate
          : undefined
        if (errorCode === 'PREREQUISITE_MISSING') {
          const prerequisitePhase = safeNovelPreparationPhase(
            workId,
            attemptedPhase,
            fullConfig.goalDescription,
            fullConfig.goldenFingerRequired,
            fullConfig.checkEmotionContract
          )
          if (prerequisitePhase !== attemptedPhase) {
            phase = prerequisitePhase
            updateNovelGoalState(workId, { failure: undefined })
            goalRoutineDAO.update(workId, { status: 'running', current_phase: phase })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'prerequisite_redirect',
              summary: `前置条件缺失，已从「${attemptedPhase}」无损回退到「${phase}」：${msg}`
            })
            emit(`前置条件缺失，已回退到「${phase}」继续：${msg}`, 'running')
            continue
          }
          markNovelAutonomousTerminal({
            workId, phase: attemptedPhase,
            code: errorCode,
            message: msg
          })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'prerequisite_terminal',
            summary: `前置条件无法由自治规划恢复，运行终止：${msg}`
          })
          emit(`前置条件无法由自治规划恢复，已进入明确失败终态：${msg}`, 'error')
          return
        }
        if (errorCode === 'EVALUATOR_PROTOCOL') {
          markNovelAutonomousTerminal({
            workId, phase: attemptedPhase,
            code: errorCode,
            message: msg
          })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'evaluator_protocol_terminal',
            summary: msg
          })
          emit(`章节候选已保留；评估器协议重试耗尽，已进入外部故障终态：${msg}`, 'error')
          return
        }
        if (
          isNovelChapterCheckpointFailure(errorCode)
          && errorCode.startsWith('EMOTION_LEDGER_')
        ) {
          markNovelAutonomousTerminal({
            workId, phase: attemptedPhase,
            code: errorCode,
            message: msg
          })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'emotion_ledger_terminal',
            summary: msg
          })
          emit(
            `情绪账本事务失败，已保留正文、质量结果和已完成情绪检查点；不会进入通用施工重试：${msg}`,
            'error'
          )
          return
        }
        if (
          isNovelChapterCheckpointFailure(errorCode)
          && errorCode.startsWith('MEMORY_EXTRACT_')
        ) {
          markNovelAutonomousTerminal({
            workId, phase: attemptedPhase,
            code: errorCode,
            message: msg
          })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'memory_extract_terminal',
            summary: msg
          })
          emit(
            `叙事记忆事务失败，已保留正文及全部前序验收检查点；恢复时只重试记忆阶段：${msg}`,
            'error'
          )
          return
        }
        if (
          errorCode === 'QUALITY_EVALUATOR_UNAVAILABLE'
          || errorCode === 'QUALITY_EVALUATOR_PROTOCOL'
        ) {
          markNovelAutonomousTerminal({
            workId, phase: attemptedPhase,
            code: errorCode,
            message: msg
          })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: errorCode === 'QUALITY_EVALUATOR_PROTOCOL'
              ? 'quality_evaluator_protocol_terminal'
              : 'quality_evaluator_unavailable_terminal',
            summary: msg
          })
          emit(
            errorCode === 'QUALITY_EVALUATOR_PROTOCOL'
              ? `质量评估器响应协议失败，已保留正文并进入外部协议故障终态；不会计入质量轮次或触发正文改写：${msg}`
              : `质量评估器连续调用失败，已保留正文并进入外部服务故障终态；不会计入质量轮次或触发正文改写：${msg}`,
            'error'
          )
          return
        }
        if (
          errorCode === 'VOLUME_HARD_GATE_BLOCKED'
          || errorCode === 'CAUSAL_PROGRESS_GATE_BLOCKED'
        ) {
          stopNovelOnHardGate({
            workId,
            phase: attemptedPhase,
            errorCode,
            message: msg,
            turn,
            emit
          })
          return
        }
        if (isTerminalNovelRepairError(errorCode)) {
          updateNovelGoalState(workId, {
            autonomousTerminal: undefined,
            failure: undefined
          })
          goalRoutineDAO.update(workId, { status: 'running', current_phase: attemptedPhase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'repair_supervisor_continue',
            target_chapter_id: scopedChapterId ?? null,
            summary: `当前修复层级未收敛；拒绝当前候选并保留检查点，整轮监督器继续下一内容轮次：${msg}`
          })
          emit(`当前修复候选未收敛，已隔离候选并继续整轮运行`, 'running')
          continue
        }
        if (failureCount >= MAX_NOVEL_PHASE_FAILURES) {
          updateNovelGoalState(workId, {
            failure: undefined,
            autonomousTerminal: undefined
          })
          goalRoutineDAO.update(workId, { status: 'running', current_phase: attemptedPhase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'phase_failure_supervisor_continue',
            target_chapter_id: scopedChapterId ?? null,
            summary: `相同叶子失败连续 ${failureCount} 次；已清空失败窗口但保留阶段检查点，整轮继续：${msg}`
          })
          emit(`「${attemptedStepLabel}」失败窗口已隔离，整轮继续`, 'running')
          continue
        }
        if (failureCount >= MAX_REPAIR_STALL_ROUNDS) {
          // 分卷生成保存逐卷检查点；保留失败详情，成功进入下一阶段后统一清除。
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'failure_escalate',
            summary: attemptedPhase === 'generate_beats'
              ? pendingChapterGate
                ? `分卷「${pendingChapterGate}」章节窗口门禁连续 ${failureCount} 次失败，已保留卷内窗口检查点；下一轮仅重试未完成窗口：${msg}`
                : `章节大纲生成连续 ${failureCount} 次失败，已切换为单章检查点、关闭思考并压缩上下文后继续：${msg}`
              : attemptedPhase === 'generate_volumes'
              ? /VOLUME_OUTPUT_TRUNCATED|Unterminated string|Unexpected end of JSON/i.test(msg)
                ? `分卷生成连续 ${failureCount} 次发生输出截断，下一轮将从已保存分卷继续，提高输出预算并强制精简字段：${msg}`
                : `分卷生成连续 ${failureCount} 次失败，下一轮将从已保存分卷继续；若为超时则仅压缩输入上下文：${msg}`
              : `「${attemptedStepLabel}」连续 ${failureCount} 次执行失败，将保留检查点继续重试：${msg}`
          })
          emit(
            attemptedPhase === 'generate_beats'
              ? pendingChapterGate
                ? `分卷「${pendingChapterGate}」窗口门禁失败，已保存卷内检查点并仅重试未完成窗口`
                : '章节大纲连续失败，已切换单章检查点策略并从断点继续'
              : attemptedPhase === 'generate_volumes'
              ? /VOLUME_OUTPUT_TRUNCATED|Unterminated string|Unexpected end of JSON/i.test(msg)
                ? '分卷输出被截断，已提高输出预算并从当前卷继续'
                : '分卷生成连续失败，已按错误类型调整请求并从断点继续'
              : `「${attemptedStepLabel}」连续失败，已保留检查点并继续重试`,
            'running'
          )
        } else {
          emit(`「${attemptedStepLabel}」第 ${failureCount} 次执行失败，将在下一轮继续自动重试：${msg}`, 'running')
        }
      } finally {
        if (!workflowStepFailure) {
          goalRoutineDAO.completeStep(stepInstance.id, phase, {
            turn,
            nextPhase: phase,
            authorityRevision: causalNovelDAO.getState(workId)?.revision ?? null,
            runStatus: goalRoutineDAO.getByWork(workId)?.status
          }, workflowStepDisposition)
        }
        clearWorkflowExecutionContext(workId, stepInstance.id)
      }
    }
  } finally {
    clearInterval(heartbeat)
    clearGoalLoopModelOpts(workId)
    unregisterNovelGoalLoop(workId)
  }
}
