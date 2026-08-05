import { createHash } from 'node:crypto'
import { getDatabase } from '../../db/connection'
import {
  goalRoutineDAO,
  novelChapterAcceptanceDAO,
  volumeChapterDAO
} from '../../db'
import type { NovelChapterGateType } from '../../db'
import {
  readNovelGoalState,
  updateNovelGoalState
} from './novel-outline-pipeline'
import type { RepairPlan } from './novel-repair-plan'
import type { NovelChapterAcceptanceSummary } from './novel-chapter-acceptance-ledger'
import {
  CHAPTER_TRANSACTION_MAX_PATCHES,
  readChapterTransactionBudget
} from './novel-chapter-transaction-policy'
import type { ChapterWordRangeFailure } from './novel-chapter-acceptance'
import { novelChapterContentHash } from './novel-chapter-acceptance-policy'
import { classifyWorkflowError } from '../../workflow/workflow-errors'

export const DEFAULT_AUTONOMOUS_MAX_EPOCHS = 20
export const LOCAL_WORD_NORMALIZATION_MAX_RATIO = 0.2

export function classifyWordRangeRepairAction(
  wordRange: ChapterWordRangeFailure
): 'normalize_length' | 'expand' | 'compress' {
  const deviation = wordRange.direction === 'expand'
    ? Math.max(0, wordRange.min - wordRange.actual)
    : Math.max(0, wordRange.actual - wordRange.max)
  if (deviation / Math.max(1, wordRange.actual) <= LOCAL_WORD_NORMALIZATION_MAX_RATIO) {
    return 'normalize_length'
  }
  return wordRange.direction
}

export function buildNarrativeMemoryRepairPlan(
  chapterId: number,
  blockers: string[]
): RepairPlan {
  const failedMetrics = [
    'NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED',
    ...blockers.map(item => item.trim()).filter(Boolean)
  ]
  const requiresOutlineReplan = blockers.some(item =>
    item.includes('跨章状态/模式[REPEATED_HOOK]')
  )
  const fingerprint = evidenceFingerprint(undefined, failedMetrics)
  return {
    action: requiresOutlineReplan ? 'cluster' : 'systemic',
    scope: requiresOutlineReplan ? 'cluster' : 'chapter',
    targetChapterIds: [chapterId],
    hint: requiresOutlineReplan
      ? [
          '当前未提交章节的大纲把重复章末钩子冻结进 next_hook、dramatic_contract.next_question 与 pattern_contract.hook_type；正文修订不能违背该执行合同。',
          '只重规划当前未提交章节：必须实质改变章末悬念的目标、阻力、执行方式或结果，并让 next_hook、dramatic_contract.next_question、pattern_contract.hook_type 与新大纲一致。不得改写任何已完成章节。',
          ...blockers
        ].join('\n')
      : [
          '跨章叙事记忆门禁拒绝当前候选；必须修改当前章节化解长期承诺或状态冲突后重新验收。',
          ...blockers
        ].join('\n'),
    issueCodes: failedMetrics,
    evidenceFingerprint: fingerprint
  }
}

export function recoverNovelBodyContractRevalidation(input: {
  workId: number
  turn: number
  chapterId: number
  emit: (message: string, status: 'running') => void
}): void {
  updateNovelGoalState(input.workId, {
    repairPlan: undefined,
    repairCommitPending: undefined,
    failure: undefined
  })
  goalRoutineDAO.update(input.workId, { status: 'running', current_phase: 'draft_body' })
  goalRoutineDAO.appendTurn({
    work_id: input.workId,
    turn_no: input.turn,
    phase: 'draft_body',
    action: 'body_contract_revalidation',
    target_chapter_id: input.chapterId,
    summary: '因果正文合同已通过精确补丁形成新版本，返回章节联合门禁重新验收'
  })
  input.emit('因果正文补丁已原子应用，正在对新正文重新执行质量、情绪与执行合同门禁', 'running')
}

/**
 * 正文已通过章节验收、但跨章叙事记忆门禁拒绝提交时，原候选不能继续提交，
 * 也不能回滚已完成的字数归一化。验收账本与当前正文哈希共同证明候选身份；
 * repairCommitPending 只是在修复提交路径上的附加检查点，不能成为普通正文提交
 * 进入记忆域自治修复的前置条件。
 */
export function recoverNarrativeMemoryCommitGate(input: {
  workId: number
  chapterId: number
  blockers: string[]
}): RepairPlan {
  const state = readNovelGoalState(input.workId)
  const pending = state.repairCommitPending
  const acceptance = novelChapterAcceptanceDAO.latestForWork(input.workId)
  if (
    !acceptance
    || acceptance.chapter_id !== input.chapterId
    || acceptance.status !== 'accepted'
  ) {
    throw new Error(`章节 ${input.chapterId} 缺少已接受验收事件，禁止绕过验收恢复`)
  }
  const chapter = volumeChapterDAO.getChapter(input.chapterId)
  const currentContent = chapter?.content?.trim() ?? ''
  const currentContentHash = novelChapterContentHash(currentContent)
  const acceptedCandidate = acceptance.best_candidate_id == null
    ? undefined
    : novelChapterAcceptanceDAO.getCandidate(acceptance.best_candidate_id)
  if (
    !currentContent
    || !acceptedCandidate
    || acceptedCandidate.episode_id !== acceptance.id
    || acceptedCandidate.content_hash !== currentContentHash
  ) {
    throw new Error(`章节 ${input.chapterId} 当前正文与已接受候选不一致，禁止猜测恢复`)
  }
  if (pending && (
    pending.context.chapterId !== input.chapterId
    || pending.candidateBodyHash !== currentContentHash
  )) {
    throw new Error(`章节 ${input.chapterId} 修复提交检查点与已接受候选不一致`)
  }
  const plan = buildNarrativeMemoryRepairPlan(input.chapterId, input.blockers)
  const fingerprint = plan.evidenceFingerprint!
  getDatabase().transaction(() => {
    novelChapterAcceptanceDAO.supersedeEpisode(acceptance.id)
    updateNovelGoalState(input.workId, {
      repairPlan: plan,
      repairCommitPending: undefined,
      failure: undefined,
      autonomousChapterEscalations: {
        ...(state.autonomousChapterEscalations ?? {}),
        [String(input.chapterId)]: {
          level: 1,
          attempts: 1,
          gateType: 'quality',
          evidenceFingerprint: fingerprint
        }
      }
    })
    goalRoutineDAO.update(input.workId, {
      status: 'running',
      current_phase: 'repair_execute'
    })
  })()
  return plan
}

export function handleNarrativeMemoryCommitGate(input: {
  workId: number
  turn: number
  chapterId: number
  blockers: string[]
  emit: (message: string, status: 'running' | 'error') => void
}): boolean {
  try {
    const plan = recoverNarrativeMemoryCommitGate(input)
    goalRoutineDAO.appendTurn({
      work_id: input.workId,
      turn_no: input.turn,
      phase: 'repair_execute',
      action: plan.action === 'cluster'
        ? 'narrative_memory_outline_replan'
        : 'narrative_memory_semantic_repair',
      target_chapter_id: input.chapterId,
      summary: plan.action === 'cluster'
        ? `跨章叙事记忆门禁已路由到当前未提交章节结构重规划：${input.blockers.join('；')}`
        : `跨章叙事记忆门禁已路由到独立语义修复：${input.blockers.join('；')}`
    })
    input.emit(
      plan.action === 'cluster'
        ? '重复章末钩子来自当前章节结构合同，正在重规划该未提交章节'
        : '跨章叙事记忆门禁要求修改当前章节，正在执行一次独立语义修复',
      'running'
    )
    return true
  } catch (error) {
    const failure = classifyWorkflowError(error)
    const message = error instanceof Error ? error.message : String(error)
    markNovelAutonomousTerminal({
      workId: input.workId,
      phase: 'repair_execute',
      code: failure.code,
      message
    })
    goalRoutineDAO.appendTurn({
      work_id: input.workId,
      turn_no: input.turn,
      phase: 'repair_execute',
      action: 'narrative_memory_repair_terminal',
      target_chapter_id: input.chapterId,
      summary: message
    })
    input.emit(`跨章叙事记忆语义修复无法安全启动：${message}`, 'error')
    return false
  }
}

function evidenceFingerprint(
  gateType: NovelChapterGateType | undefined,
  failedMetrics: string[]
): string {
  return createHash('sha256').update(JSON.stringify({
    gateType: gateType ?? 'quality',
    failedMetrics: [...new Set(failedMetrics)].sort()
  })).digest('hex')
}

function gateAction(input: {
  gateType: NovelChapterGateType | undefined
  failureCode?: string
  wordRange?: ChapterWordRangeFailure
}): RepairPlan['action'] {
  if (input.gateType === 'emotion') return 'emotion'
  if (input.failureCode === 'BODY_WORD_RANGE_NON_CONVERGENT') {
    if (!input.wordRange) throw new Error('字数合同失败缺少结构化范围，禁止通过错误文本猜测修复方向')
    return classifyWordRangeRepairAction(input.wordRange)
  }
  if (input.gateType === 'execution_contract') return 'execution_contract'
  return 'quality'
}

/**
 * 字数归一化与语义修复是两个正交事务车道，各自只有一次补丁额度。
 * 字数补丁完成后首次暴露章节执行合同阻断，不属于同一车道重入。
 */
export function shouldRouteLengthNormalizationToSemanticRepair(input: {
  attemptedPhase: string
  attemptedAction?: RepairPlan['action']
  blockedGate?: NovelChapterGateType
}): boolean {
  return input.attemptedPhase === 'repair_execute'
    && input.attemptedAction === 'normalize_length'
    && input.blockedGate === 'execution_contract'
}

/**
 * 一次章节合同定点补丁后，如果复验暴露的是另一组合同证据，根因已经不是
 * “正文遗漏一个局部动作”，而是当前未提交章节的执行合同无法承载这组约束。
 * 这时只能进入独立的结构重规划车道；禁止把新证据伪装成第二次正文补丁。
 */
export function shouldRouteExecutionContractRepairToStructuralReplan(input: {
  attemptedPhase: string
  attemptedAction?: RepairPlan['action']
  blockedGate?: NovelChapterGateType
  previousEvidenceFingerprint?: string
  failedMetrics: string[]
}): boolean {
  return input.attemptedPhase === 'repair_execute'
    && input.attemptedAction === 'execution_contract'
    && input.blockedGate === 'execution_contract'
    && Boolean(input.previousEvidenceFingerprint)
    && input.previousEvidenceFingerprint !== evidenceFingerprint(input.blockedGate, input.failedMetrics)
}

/**
 * 结构重规划不是语义补丁的重试：它废弃当前未提交章节的合同与正文候选，
 * 从已提交因果状态重新生成本章。预算单独绑定 structural_replan 车道。
 */
export function buildExecutionContractStructuralReplan(input: {
  workId: number
  chapterId: number
  failedMetrics: string[]
}): RepairPlan {
  const metrics = [...new Set(input.failedMetrics.map(item => item.trim()).filter(Boolean))]
  if (metrics.length === 0) {
    throw new Error(`章节 ${input.chapterId} 的执行合同重规划缺少可审计失败指标`)
  }
  const fingerprint = evidenceFingerprint('execution_contract', metrics)
  const state = readNovelGoalState(input.workId)
  updateNovelGoalState(input.workId, {
    autonomousChapterEscalations: {
      ...(state.autonomousChapterEscalations ?? {}),
      [String(input.chapterId)]: {
        level: 2,
        attempts: 1,
        gateType: 'execution_contract',
        evidenceFingerprint: fingerprint
      }
    }
  })
  return {
    action: 'cluster',
    scope: 'cluster',
    targetChapterIds: [input.chapterId],
    hint: [
      '当前未提交章节的执行合同在一次定点正文补丁后暴露新的边界证据；禁止再次修订正文。',
      '只重规划当前章节：以已提交因果状态为唯一权威，重建章节目标、允许推进边界、禁止越界范围、required_outcomes 与结尾落点。',
      '重规划后必须废弃当前正文候选并从新合同生成正文；不得修改任何已提交章节。',
      ...metrics
    ].join('\n'),
    issueCodes: ['EXECUTION_CONTRACT_STRUCTURAL_REPLAN', ...metrics],
    evidenceFingerprint: fingerprint
  }
}

/**
 * 进程在“语义补丁已用、执行合同仍未通过”之后退出时，恢复入口必须继续
 * 同一架构决策，不能把旧 repairPlan 当成可再次执行的正文修订。
 */
export function recoverInterruptedExecutionContractRepairOnResume(workId: number): RepairPlan | null {
  const state = readNovelGoalState(workId)
  const plan = state.repairPlan as RepairPlan | undefined
  if (plan?.action !== 'execution_contract' || plan.scope !== 'chapter') return null
  const chapterId = plan.targetChapterIds.length === 1 ? plan.targetChapterIds[0] : undefined
  if (chapterId == null) return null
  const semanticBudget = readChapterTransactionBudget({
    workId,
    chapterId,
    lane: 'semantic_repair'
  })
  if ((semanticBudget?.patchesUsed ?? 0) < CHAPTER_TRANSACTION_MAX_PATCHES) return null
  return buildExecutionContractStructuralReplan({
    workId,
    chapterId,
    failedMetrics: plan.issueCodes ?? []
  })
}

/**
 * 恢复时以持久化步骤账本为权威：若 chapter_commit 的记忆门禁
 * 被旧路由误分到通用正文修订，必须回到记忆域自己的结构修复边界。
 */
export function recoverInterruptedNarrativeMemoryGateOnResume(
  workId: number
): RepairPlan | null {
  const state = readNovelGoalState(workId)
  const currentPlan = state.repairPlan as RepairPlan | undefined
  if (
    currentPlan?.action === 'cluster'
    && currentPlan.scope === 'cluster'
    && currentPlan.issueCodes?.includes('NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED')
  ) return null

  const steps = goalRoutineDAO.listSteps(workId, 50)
  const memoryFailure = steps.find(step =>
    step.status === 'failed'
    && step.step_key === 'chapter_commit'
    && step.error_code === 'NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED'
  )
  if (!memoryFailure?.error_message) return null
  const scopeMatch = /^chapter:(\d+)$/.exec(memoryFailure.scope_key)
  if (!scopeMatch) return null
  const chapterId = Number(scopeMatch[1])
  if (!Number.isSafeInteger(chapterId) || chapterId <= 0) return null

  const resolvedByLaterCommit = steps.some(step =>
    step.id > memoryFailure.id
    && step.step_key === 'chapter_commit'
    && step.scope_key === memoryFailure.scope_key
    && step.status === 'completed'
  )
  if (resolvedByLaterCommit) return null
  const recoveredByLaterRepair = steps.some(step =>
    step.id > memoryFailure.id
    && step.step_key === 'repair_execute'
    && step.scope_key === memoryFailure.scope_key
    && step.status === 'completed'
  )
  if (recoveredByLaterRepair) return null
  const latestFailed = steps.find(step => step.status === 'failed')
  if (
    !latestFailed
    || latestFailed.id < memoryFailure.id
    || latestFailed.scope_key !== memoryFailure.scope_key
  ) return null

  return buildNarrativeMemoryRepairPlan(chapterId, [memoryFailure.error_message])
}

/**
 * 章节硬合同失败只允许一次单章定点补丁。
 * 禁止把同一章的失败扩大成章节簇或整卷重写，也禁止候选变化后重置预算。
 */
export function buildAutonomousChapterRepairPlan(input: {
  workId: number
  chapterId: number
  gateType?: NovelChapterGateType
  failureCode?: string
  wordRange?: ChapterWordRangeFailure
  failedMetrics: string[]
}): { plan: RepairPlan; level: number; attempts: number } {
  const chapters = volumeChapterDAO.listChaptersByWork(input.workId)
  const chapterIndex = chapters.findIndex(chapter => chapter.id === input.chapterId)
  if (chapterIndex < 0) throw new Error(`自治修复章节不存在：${input.chapterId}`)
  const fingerprint = evidenceFingerprint(input.gateType, input.failedMetrics)
  const gateType = input.gateType ?? 'quality'
  const action = gateAction({
    gateType: input.gateType,
    failureCode: input.failureCode,
    wordRange: input.wordRange
  })
  const state = readNovelGoalState(input.workId)
  const attempts = 1
  const level = 1
  const scope: RepairPlan['scope'] = 'chapter'
  const targetChapterIds = [input.chapterId]
  const repairHint = input.wordRange
    ? input.wordRange.direction === 'compress'
      ? `当前正文 ${input.wordRange.actual} 字，压缩到 ${input.wordRange.target}-${input.wordRange.max} 字；至少删除 ${input.wordRange.actual - input.wordRange.max} 个不推进情节的字，不新增事实`
      : `当前正文 ${input.wordRange.actual} 字，扩写到 ${input.wordRange.min}-${input.wordRange.target} 字；只补充合同要求的行动、因果与场景反馈`
    : [
        `章节事务唯一硬合同补丁：${input.gateType ?? 'quality'}`,
        ...input.failedMetrics
      ].join('\n')

  const escalations = {
    ...(state.autonomousChapterEscalations ?? {}),
    [String(input.chapterId)]: {
      level,
      attempts,
      gateType,
      evidenceFingerprint: fingerprint
    }
  }
  updateNovelGoalState(input.workId, { autonomousChapterEscalations: escalations })

  return {
    level,
    attempts,
    plan: {
      action,
      scope,
      targetChapterIds,
      hint: repairHint,
      issueCodes: input.failedMetrics,
      evidenceFingerprint: fingerprint,
      wordRange: input.wordRange
    }
  }
}

export function clearAutonomousChapterEscalation(workId: number, chapterId: number): void {
  const state = readNovelGoalState(workId)
  if (!state.autonomousChapterEscalations?.[String(chapterId)]) return
  const next = { ...state.autonomousChapterEscalations }
  delete next[String(chapterId)]
  updateNovelGoalState(workId, { autonomousChapterEscalations: next })
}

export function reconcileAutonomousRepairGate(
  workId: number,
  chapterId: number,
  gateType: NovelChapterGateType,
  failedMetrics: string[]
): void {
  const state = readNovelGoalState(workId)
  const plan = state.repairPlan as RepairPlan | undefined
  if (!plan?.targetChapterIds.includes(chapterId)) return
  if (plan.issueCodes?.includes('NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED')) return
  const metrics = [...new Set(failedMetrics.map(item => item.trim()).filter(Boolean))]
  if (metrics.length === 0) {
    throw new Error(`章节 ${chapterId} 的 ${gateType} 门禁缺少可审计失败指标`)
  }
  const previous = state.autonomousChapterEscalations?.[String(chapterId)]
  if (!previous || previous.gateType !== gateType) {
    updateNovelGoalState(workId, {
      repairPlan: {
        action: gateAction({ gateType }),
        scope: 'chapter',
        targetChapterIds: [chapterId],
        hint: [
          `恢复章节门禁证据：${gateType}`,
          ...metrics
        ].join('\n'),
        issueCodes: metrics,
        evidenceFingerprint: evidenceFingerprint(gateType, metrics)
      }
    })
    return
  }
  const fingerprint = evidenceFingerprint(gateType, metrics)
  updateNovelGoalState(workId, {
    repairPlan: {
      ...plan,
      action: plan.action === 'normalize_length'
        ? plan.action
        : gateAction({ gateType }),
      hint: [
        `自治门禁修复 L${previous.level}：${gateType}`,
        ...metrics
      ].join('\n'),
      issueCodes: metrics,
      evidenceFingerprint: fingerprint
    },
    autonomousChapterEscalations: {
      ...(state.autonomousChapterEscalations ?? {}),
      [String(chapterId)]: {
        level: previous.level,
        attempts: previous.attempts,
        gateType,
        evidenceFingerprint: fingerprint
      }
    }
  })
}

export function reconcileAutonomousRepairFromAcceptance(
  workId: number,
  chapterId: number,
  acceptance: NovelChapterAcceptanceSummary
): void {
  if (acceptance.chapterId !== chapterId || !acceptance.blockedGate) return
  const blockedGate = acceptance.gates.find(
    gate => gate.gateType === acceptance.blockedGate
  )
  reconcileAutonomousRepairGate(
    workId,
    chapterId,
    acceptance.blockedGate,
    [
      blockedGate?.failureCode,
      blockedGate?.failureReason,
      ...acceptance.blockingFailures
    ].filter((item): item is string => Boolean(item?.trim()))
  )
}

export function normalizeAutonomousMaxEpochs(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTONOMOUS_MAX_EPOCHS
  return Math.max(1, Math.min(100, Math.round(value!)))
}

export function markNovelAutonomousTerminal(input: {
  workId: number
  phase: string
  code: string
  message: string
}): void {
  updateNovelGoalState(input.workId, {
    autonomousTerminal: {
      phase: input.phase,
      code: input.code,
      message: input.message,
      at: new Date().toISOString()
    }
  })
  goalRoutineDAO.update(input.workId, {
    status: 'error',
    current_phase: input.phase
  })
}
