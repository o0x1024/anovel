import { BrowserWindow, type WebContents } from 'electron'
import { causalNovelDAO, goalRoutineDAO, volumeChapterDAO, workDAO } from '../../db'
import { getDatabase } from '../../db/connection'
import { loadWritingPlan } from '../writing-plan'
import { checkStoryGoal, DEFAULT_STORY_GOAL_CONFIG, type StoryGoalConfig } from './story-goal-checker'
import {
  commitPreparedNarrativeMemory,
  generateBeatBody,
  prepareNarrativeMemoryAfterGeneration,
  type PreparedNarrativeMemory
} from './story-goal-doer'
import { bindGoalLoopModelOpts, clearGoalLoopModelOpts } from './story-goal-model'
import { novelMemoryCommitBlockers, runChapterAcceptanceGate } from './novel-goal-routine'
import {
  extractCausalOutcome,
  causalPlanFailureCode,
  auditAndReplanCausalMacroArchitecture,
  initializeCausalNovelState,
  planNextCausalChapter,
  upgradeCausalNovelMacroArchitecture
} from './causal-novel-engine'
import { requireGoalTurnLimit } from '../../../shared/goal-turn-limit'
import {
  causalChapterCountBounds,
  registerCausalPlanFailure,
  type CausalPlanFailureEvent
} from '../../../shared/causal-novel-types'
import type { GoalProgressEvent, Phase } from './novel-goal-routine'
import { processPendingCausalReplay } from './causal-replay'
import {
  CausalOutcomeProtocolError,
  causalOutcomeFailureCode,
  type CausalOutcomeFailureCode
} from '../../../shared/causal-outcome-protocol'

const activeCausalLoops = new Map<number, AbortController>()
const MAX_IDENTICAL_FAILURES = 3
const MAX_PLAN_FAILURES_PER_REVISION = 3
const MAX_PLAN_FAILURES_PER_FAMILY = 2
const MAX_OUTCOME_FAILURES_PER_FAMILY = 3

function broadcast(payload: GoalProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('goal:progress', payload)
  }
}

export function isCausalNovelGoalLoopRunning(workId: number): boolean {
  return activeCausalLoops.has(workId)
}

export function cancelCausalNovelGoalLoop(workId: number): boolean {
  const controller = activeCausalLoops.get(workId)
  if (!controller) return false
  controller.abort()
  return true
}

export function cancelAllCausalNovelGoalLoops(): void {
  for (const [workId, controller] of activeCausalLoops) {
    controller.abort()
    goalRoutineDAO.setStatus(workId, 'paused')
  }
  activeCausalLoops.clear()
}

export async function runCausalNovelGoalLoop(
  workId: number,
  config: Partial<StoryGoalConfig> = {},
  _sender?: WebContents,
  resume = false
): Promise<void> {
  if (activeCausalLoops.has(workId)) throw new Error('该因果小说已有目标循环在运行')
  const work = workDAO.getById(workId)
  if (work?.work_type !== 'causal_novel') throw new Error('滚动因果运行器只接受小说管理（因果）中的作品')

  const existing = goalRoutineDAO.getByWork(workId)
  const saved = resume && existing?.goal_config_json
    ? JSON.parse(existing.goal_config_json) as Partial<StoryGoalConfig>
    : {}
  const fullConfig: StoryGoalConfig = { ...DEFAULT_STORY_GOAL_CONFIG, ...saved, ...config }
  fullConfig.maxTurns = requireGoalTurnLimit(fullConfig.maxTurns)
  // maxTurns 是单次“开始/继续”的调用预算，不是作品生命周期累计额度。
  // 历史 turn_count 只用于审计；沿用它会让长期作品在 59/60 恢复后立刻再次超时。
  let turn = 0
  let phase: Phase = causalNovelDAO.getState(workId) ? 'generate_beats' : 'materialize_settings'
  let lastFailure = ''
  let identicalFailures = 0
  let planFailureHistory: CausalPlanFailureEvent[] = []
  const outcomeFailureCounts = new Map<string, number>()
  const controller = new AbortController()
  activeCausalLoops.set(workId, controller)
  bindGoalLoopModelOpts(workId, fullConfig)
  goalRoutineDAO.update(workId, {
    status: 'running', max_turns: fullConfig.maxTurns, turn_count: turn,
    current_phase: phase, goal_met: false, goal_config_json: JSON.stringify(fullConfig)
  })

  const emit = (message: string, status: string): void => {
    const payload: GoalProgressEvent = {
      workId, turn, maxTurns: fullConfig.maxTurns, phase, status, message
    }
    broadcast(payload)
  }

  try {
    while (true) {
      if (controller.signal.aborted) {
        goalRoutineDAO.setStatus(workId, 'cancelled')
        emit('因果写作已取消，权威状态保持在最后一次成功提交', 'cancelled')
        return
      }
      if (turn >= fullConfig.maxTurns) {
        goalRoutineDAO.setStatus(workId, 'timeout')
        emit('本轮调用预算已用完，因果状态和章节决策已保存', 'timeout')
        return
      }

      turn++
      try {
        const state = causalNovelDAO.getState(workId)
        if (!state) {
          phase = 'materialize_settings'
          goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
          emit('正在从世界起点建立权威因果状态', 'running')
          const initialized = await initializeCausalNovelState(
            workId, fullConfig.goalDescription, controller.signal,
            progress => emit(progress, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'causal_state_init',
            summary: `建立 ${initialized.actors.length} 个人物、${initialized.activePressures.length} 个压力、${initialized.promises.length} 个读者承诺`
          })
          emit('权威因果状态已建立，不生成全书大纲；关系只记录已发生事实', 'running')
          continue
        }

        const pendingReplay = causalNovelDAO.getPendingReplay(workId)
        if (pendingReplay) {
          if (pendingReplay.status === 'blocked') {
            goalRoutineDAO.update(workId, { status: 'paused', current_phase: 'goal_check' })
            emit(`人工事实修改的因果重放存在冲突：${pendingReplay.errorMessage || '请在章节管理中处理冲突'}`, 'paused')
            return
          }
          phase = 'goal_check'
          goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
          const replayed = await processPendingCausalReplay(
            workId, fullConfig, controller.signal, message => emit(message, 'running')
          )
          if (replayed) {
            goalRoutineDAO.appendTurn({
              work_id: workId, turn_no: turn, phase, action: 'causal_manual_replay',
              target_chapter_id: pendingReplay.chapterId,
              summary: `重放任务 #${replayed.replayJobId} 已完成，重放 ${replayed.replayedChapters} 章，权威状态推进到 r${replayed.finalRevision}`
            })
            emit(`人工修改的因果重放已完成，权威状态更新到 r${replayed.finalRevision}`, 'running')
          }
          continue
        }

        const decisions = causalNovelDAO.listDecisions(workId)
        const decisionIds = new Set(decisions.map(item => item.chapterId))
        const unmanagedChapter = volumeChapterDAO.listChaptersByWork(workId).find(chapter => !decisionIds.has(chapter.id))
        if (unmanagedChapter) {
          throw new Error(`检测到非权威章节「${unmanagedChapter.title}」，为避免污染章节顺序与叙事记忆，删除该草稿后才能继续滚动`)
        }
        const pending = decisions.find(item => item.status === 'planned')
        if (!pending && !state.macroArchitectureReady) {
          phase = 'materialize_settings'
          goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
          const upgraded = await upgradeCausalNovelMacroArchitecture(
            workId,
            controller.signal,
            progress => emit(progress, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'causal_macro_upgrade',
            summary: `建立 ${upgraded.macroArcs.length} 个阶段锚点并写入状态修订版 ${upgraded.revision}`
          })
          emit(`阶段架构已升级为 ${upgraded.macroArcs.length} 个锚点`, 'running')
          continue
        }
        if (pending) {
          phase = 'draft_body'
          goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
          const chapter = volumeChapterDAO.getChapter(pending.chapterId)
          if (!chapter?.content?.trim()) {
            emit(`正在执行滚动决策「${pending.plan.decision.title}」`, 'running')
            const generated = await generateBeatBody(workId, pending.chapterId, {
              signal: controller.signal,
              goalDescription: fullConfig.goalDescription,
              workType: 'causal_novel',
              deferNarrativeMemory: true
            })
            if (!generated.success) {
              if (generated.requiresEscalation && generated.error?.includes('章节执行门禁连续 3 次未返回完整精确证据')) {
                goalRoutineDAO.appendTurn({
                  work_id: workId,
                  turn_no: turn,
                  phase,
                  action: 'causal_gate_evaluator_stalled',
                  target_chapter_id: pending.chapterId,
                  summary: generated.error
                })
                goalRoutineDAO.setStatus(workId, 'paused')
                emit(generated.error, 'paused')
                return
              }
              throw new Error(generated.error || '因果章节正文生成失败')
            }
          }
          let contentVersion = causalNovelDAO.ensureCurrentContentVersion(
            workId, pending.chapterId, 'generation', 'generated'
          )
          const acceptedCheckpoint = causalNovelDAO.getCheckpoint(
            pending.chapterId, contentVersion.id, 'acceptance'
          )
          if (acceptedCheckpoint?.status !== 'completed') {
            const acceptance = await runChapterAcceptanceGate(
              workId, pending.chapterId, fullConfig, controller.signal,
              message => emit(message, 'running')
            )
            if (!acceptance.passed) {
              causalNovelDAO.saveCheckpoint({
                workId, chapterId: pending.chapterId, contentVersionId: contentVersion.id,
                bodyHash: contentVersion.bodyHash, stage: 'acceptance', status: 'failed',
                errorMessage: acceptance.failedMetrics.join('；')
              })
              throw new Error(`因果章节质量门禁未通过：${acceptance.failedMetrics.join('；')}`)
            }
            contentVersion = causalNovelDAO.ensureCurrentContentVersion(
              workId, pending.chapterId, 'acceptance', 'generated'
            )
            causalNovelDAO.saveCheckpoint({
              workId, chapterId: pending.chapterId, contentVersionId: contentVersion.id,
              bodyHash: contentVersion.bodyHash, stage: 'acceptance', status: 'completed',
              payload: { passed: true }
            })
          } else {
            emit('已复用当前正文版本的质量验收检查点', 'running')
          }
          const finalChapter = volumeChapterDAO.getChapter(pending.chapterId)
          if (!finalChapter?.content?.trim()) throw new Error('因果章节最终正文不存在')
          contentVersion = causalNovelDAO.ensureCurrentContentVersion(
            workId, pending.chapterId, 'accepted_body', 'generated'
          )
          const memoryCheckpoint = causalNovelDAO.getCheckpoint(
            pending.chapterId, contentVersion.id, 'narrative_memory'
          )
          let preparedMemory: PreparedNarrativeMemory
          if (memoryCheckpoint?.status === 'completed' && memoryCheckpoint.payload) {
            preparedMemory = memoryCheckpoint.payload as PreparedNarrativeMemory
            emit('已复用当前正文版本的候选叙事记忆检查点', 'running')
          } else {
            emit(`正在从「${finalChapter.title}」准备候选叙事记忆`, 'running')
            preparedMemory = await prepareNarrativeMemoryAfterGeneration(
              workId,
              pending.chapterId,
              finalChapter.content,
              controller.signal,
              { requirePatternFingerprint: true, dropInvalidStateFactsAfterRetries: true }
            )
            causalNovelDAO.saveCheckpoint({
              workId, chapterId: pending.chapterId, contentVersionId: contentVersion.id,
              bodyHash: contentVersion.bodyHash, stage: 'narrative_memory', status: 'completed',
              payload: preparedMemory
            })
          }
          let extracted: Awaited<ReturnType<typeof extractCausalOutcome>>
          const outcomeCheckpoint = causalNovelDAO.getCheckpoint(
            pending.chapterId, contentVersion.id, 'causal_outcome'
          )
          const cachedOutcome = outcomeCheckpoint?.status === 'completed'
            ? outcomeCheckpoint.payload as Awaited<ReturnType<typeof extractCausalOutcome>> | null
            : null
          const currentStateRevision = causalNovelDAO.getState(workId)?.revision
          if (
            cachedOutcome?.bodyHash === contentVersion.bodyHash &&
            cachedOutcome.state?.revision === (currentStateRevision ?? -2) + 1
          ) {
            extracted = cachedOutcome
            emit('已复用当前正文版本的因果结果检查点', 'running')
          } else {
            try {
              extracted = await extractCausalOutcome(
                workId, pending.chapterId, controller.signal,
                progress => emit(progress, 'running')
              )
              causalNovelDAO.saveCheckpoint({
                workId, chapterId: pending.chapterId, contentVersionId: contentVersion.id,
                bodyHash: contentVersion.bodyHash, stage: 'causal_outcome', status: 'completed',
                payload: extracted
              })
            } catch (error) {
              causalNovelDAO.saveCheckpoint({
                workId, chapterId: pending.chapterId, contentVersionId: contentVersion.id,
                bodyHash: contentVersion.bodyHash, stage: 'causal_outcome', status: 'failed',
                errorMessage: error instanceof Error ? error.message : String(error)
              })
              throw error
            }
          }
          emit('正在原子提交正文完成状态、叙事记忆、情绪结果与因果状态修订', 'running')
          const committedMemory = getDatabase().transaction(() => {
            const memory = commitPreparedNarrativeMemory(workId, pending.chapterId, preparedMemory, {
              markChapterCompleted: false,
              validate: () => novelMemoryCommitBlockers(workId, pending.chapterId)
            })
            causalNovelDAO.commitDecision({
              workId,
              chapterId: pending.chapterId,
              expectedStateRevision: extracted.state.revision - 1,
              nextState: extracted.state,
              outcome: extracted.outcome,
              expectedBodyHash: extracted.bodyHash
            })
            volumeChapterDAO.updateChapter(pending.chapterId, { status: 'completed' })
            return memory
          })()
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'causal_commit',
            target_chapter_id: pending.chapterId,
            summary: `正文、情绪结果、${committedMemory.timelineEvents} 条时间线记忆与因果状态已提交到修订版 ${extracted.state.revision}：${extracted.outcome.summary}`
          })
          emit(`本章因果与情绪结果已提交：${extracted.outcome.summary}`, 'running')
          lastFailure = ''
          identicalFailures = 0
          planFailureHistory = []
          outcomeFailureCounts.clear()
          continue
        }

        if (state.completionStatus === 'completed' || state.completed) {
          goalRoutineDAO.update(workId, { status: 'goal_met', goal_met: true, current_phase: 'goal_check' })
          emit(`因果小说已经完成：${state.completionReason}`, 'goal_met')
          return
        }

        if (state.completionStatus === 'proposed') {
          phase = 'goal_check'
          goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
          emit('正文提议核心问题已经收束，正在执行独立整书终审', 'running')
          const check = await checkStoryGoal(workId, fullConfig, controller.signal, message => emit(message, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'causal_final_check',
            score: check.qualityScore >= 0 ? check.qualityScore : null,
            summary: check.met ? `因果小说完成：${state.completionReason}` : check.reasons.join('；')
          })
          if (check.met) {
            const release = getDatabase().transaction(() => {
              const completed = causalNovelDAO.confirmCompletion(workId, state.revision, state.completionReason)
              const snapshotId = causalNovelDAO.createReleaseSnapshot(
                workId,
                `causal_release_ready_r${completed.revision}`
              )
              return { completed, snapshotId }
            })()
            goalRoutineDAO.update(workId, { status: 'goal_met', goal_met: true })
            emit(
              `因果小说完成并冻结发布快照 #${release.snapshotId}（状态 r${release.completed.revision}）：${release.completed.completionReason}`,
              'goal_met'
            )
          } else {
            const reopened = causalNovelDAO.rejectProposedCompletion(workId, state.revision, check.reasons)
            goalRoutineDAO.update(workId, { status: 'paused', goal_met: false })
            emit(`完结提案未通过，已退回写作状态 r${reopened.revision}：${check.reasons.join('；')}`, 'paused')
          }
          return
        }

        const targetChapters = loadWritingPlan(workId).targetChapters
        const committedChapterCount = decisions.filter(item => item.status === 'committed').length
        const scaleBounds = causalChapterCountBounds(targetChapters)
        if (
          committedChapterCount > 0 &&
          (
            committedChapterCount - state.lastMacroAuditChapter >= 8 ||
            state.completionAuditFeedback.length > 0
          )
        ) {
          phase = 'materialize_settings'
          goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
          const replanned = await auditAndReplanCausalMacroArchitecture(
            workId,
            committedChapterCount,
            controller.signal,
            progress => emit(progress, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'causal_macro_replan',
            summary: `阶段架构完成审计，权威状态推进到 r${replanned.revision}`
          })
          emit(`阶段架构已按已提交事实重审到 r${replanned.revision}`, 'running')
          continue
        }
        if (committedChapterCount >= scaleBounds.max) {
          goalRoutineDAO.update(workId, { status: 'paused', current_phase: 'goal_check' })
          emit(
            `已达到弹性规模上限 ${scaleBounds.max} 章（目标 ${targetChapters} 章），但核心终止条件尚未满足；已停止继续扩写`,
            'paused'
          )
          return
        }

        phase = 'generate_beats'
        goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
        emit(`正在基于因果状态修订版 ${state.revision} 生成下一章候选事件`, 'running')
        const planned = await planNextCausalChapter(
          workId, fullConfig.goalDescription, controller.signal,
          progress => emit(progress, 'running')
        )
        goalRoutineDAO.appendTurn({
          work_id: workId, turn_no: turn, phase, action: 'causal_decision',
          target_chapter_id: planned.chapterId,
          summary: `从 ${planned.plan.candidates.length} 个候选中选择「${planned.plan.decision.title}」，情绪事务引用 ${planned.plan.emotionContract.grounding_refs.length} 项权威依据`
        })
        emit(`已选择下一章「${planned.plan.decision.title}」并冻结本章情绪事务，未创建远期大纲`, 'running')
        lastFailure = ''
        identicalFailures = 0
        planFailureHistory = []
        outcomeFailureCounts.clear()
      } catch (error) {
        if (controller.signal.aborted) continue
        const message = error instanceof Error ? error.message : String(error)
        identicalFailures = message === lastFailure ? identicalFailures + 1 : 1
        lastFailure = message
        const stateRevision = causalNovelDAO.getState(workId)?.revision ?? -1
        const planFailureCode = phase === 'generate_beats' ? causalPlanFailureCode(message) : null
        const pendingDecision = phase === 'draft_body'
          ? causalNovelDAO.listDecisions(workId).find(item => item.status === 'planned')
          : undefined
        const isOutcomeFailure = phase === 'draft_body' && (
          error instanceof CausalOutcomeProtocolError ||
          /章后结果|核心事件提取|人物变化提取|世界压力提取|情绪结果提取|因果结果|冻结决策中的.*承诺/.test(message)
        )
        const outcomeFailureCode: CausalOutcomeFailureCode | null = isOutcomeFailure
          ? causalOutcomeFailureCode(error)
          : null
        const outcomeFailureKey = outcomeFailureCode && pendingDecision
          ? `${stateRevision}:${pendingDecision.chapterId}:${outcomeFailureCode}`
          : null
        const outcomeFailureCount = outcomeFailureKey
          ? (outcomeFailureCounts.get(outcomeFailureKey) ?? 0) + 1
          : 0
        if (outcomeFailureKey) outcomeFailureCounts.set(outcomeFailureKey, outcomeFailureCount)
        const failureDecision = planFailureCode
          ? registerCausalPlanFailure(
              planFailureHistory,
              { revision: stateRevision, code: planFailureCode },
              MAX_PLAN_FAILURES_PER_REVISION,
              MAX_PLAN_FAILURES_PER_FAMILY
            )
          : null
        if (planFailureCode) {
          planFailureHistory = failureDecision?.history ?? planFailureHistory
        }
        goalRoutineDAO.appendTurn({
          work_id: workId,
          turn_no: turn,
          phase,
          action: 'error',
          summary: planFailureCode
            ? `[${planFailureCode}] ${message}`
            : outcomeFailureCode
              ? `[${outcomeFailureCode}] ${message}`
              : message
        })
        if (
          planFailureCode && failureDecision?.shouldPause
        ) {
          goalRoutineDAO.update(workId, { status: 'paused', current_phase: phase })
          emit(
            `因果规划在状态 r${stateRevision} 未收敛，已按错误族 ${planFailureCode} 熔断：${message}`,
            'paused'
          )
          return
        }
        if (outcomeFailureCode && outcomeFailureCount >= MAX_OUTCOME_FAILURES_PER_FAMILY) {
          goalRoutineDAO.update(workId, { status: 'paused', current_phase: phase })
          emit(
            `章后结果在状态 r${stateRevision} 连续 ${outcomeFailureCount} 次触发错误族 ${outcomeFailureCode}，已暂停且未提交权威状态：${message}`,
            'paused'
          )
          return
        }
        if (identicalFailures >= MAX_IDENTICAL_FAILURES) {
          goalRoutineDAO.update(workId, { status: 'paused', current_phase: phase })
          emit(`相同失败连续 ${identicalFailures} 次，已熔断且未推进权威状态：${message}`, 'paused')
          return
        }
        emit(
          outcomeFailureCode
            ? `章后结果 ${outcomeFailureCode} 重试 ${outcomeFailureCount}/${MAX_OUTCOME_FAILURES_PER_FAMILY}；本轮未提交权威状态：${message}`
            : `本轮未提交因果状态：${message}`,
          'running'
        )
      }
    }
  } finally {
    activeCausalLoops.delete(workId)
    clearGoalLoopModelOpts(workId)
  }
}
