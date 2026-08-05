import { goalRoutineDAO } from '../../db'
import type { GoalRoutinePhase } from '../../../shared/goal-routine-phases'
import type { StoryGoalConfig } from './story-goal-checker'
import { nextPendingDraftChapter, phaseAfterCurrentDraftWindow } from './novel-chapter-acceptance'
import { updateNovelGoalState } from './novel-outline-pipeline'
import { auditPendingNovelReleaseWindow } from './novel-release-window-audit'
import type { RepairPlan } from './novel-repair-plan'

export interface NovelReleaseWindowPhaseResult {
  phase: GoalRoutinePhase
  stop: boolean
}

export async function runNovelReleaseWindowAuditPhase(input: {
  workId: number
  turn: number
  config: StoryGoalConfig
  signal?: AbortSignal
  emit: (message: string, status: string) => void
}): Promise<NovelReleaseWindowPhaseResult> {
  const { workId, turn, config, signal, emit } = input
  const audited = await auditPendingNovelReleaseWindow(
    workId,
    config.goalDescription,
    signal,
    message => emit(message, 'running')
  )
  if (!audited) {
    emit('当前没有待审读的连续八章首发窗口，返回正文工作流', 'running')
    return {
      phase: nextPendingDraftChapter(workId, config) ? 'draft_body' : phaseAfterCurrentDraftWindow(workId),
      stop: false
    }
  }

  goalRoutineDAO.appendTurn({
    work_id: workId,
    turn_no: turn,
    phase: 'release_window_audit',
    action: audited.passed ? 'release_window_frozen' : 'release_window_blocked',
    target_chapter_id: audited.range.endChapterId,
    score: audited.score.overall,
    summary: audited.passed
      ? `第 ${audited.range.startIndex}-${audited.range.endIndex} 章首发窗口通过并冻结快照 #${audited.snapshotId}：${audited.summary}`
      : `第 ${audited.range.startIndex}-${audited.range.endIndex} 章首发窗口未通过：${audited.blockers.join('；')}`
  })
  if (audited.passed) {
    emit(
      `第 ${audited.range.startIndex}-${audited.range.endIndex} 章首发窗口达到 ${audited.score.overall} 分并冻结发布快照 #${audited.snapshotId}`,
      'running'
    )
    return {
      phase: nextPendingDraftChapter(workId, config) ? 'draft_body' : phaseAfterCurrentDraftWindow(workId),
      stop: false
    }
  }

  const hardIssues = audited.issues.filter(issue => issue.severity === 'blocker')
  if (hardIssues.some(issue => issue.code === 'SCORE_EVIDENCE_MISSING')) {
    goalRoutineDAO.setStatus(workId, 'paused')
    emit('首发窗口低分但缺少可定位正文证据，已冻结正文并暂停；禁止无证据自动改写', 'error')
    return { phase: 'release_window_audit', stop: true }
  }
  const targetChapterIds = [...new Set(hardIssues.flatMap(issue => issue.chapterIds))]
  if (targetChapterIds.length === 0) {
    goalRoutineDAO.setStatus(workId, 'paused')
    emit('首发窗口存在发布阻塞但没有合法章节修复范围，已冻结正文并暂停', 'error')
    return { phase: 'release_window_audit', stop: true }
  }
  updateNovelGoalState(workId, {
    repairPlan: {
      action: 'cluster',
      scope: 'cluster',
      targetChapterIds,
      hint: [
        `第 ${audited.range.startIndex}-${audited.range.endIndex} 章首发窗口综合分 ${audited.score.overall}。`,
        ...hardIssues.map(issue => `${issue.code}：${issue.message}；验收结果：${issue.requiredFix}`)
      ].join('\n'),
      issueCodes: hardIssues.map(issue => issue.code),
      evidenceFingerprint: audited.range.sourceHash
    } satisfies RepairPlan,
    failure: undefined
  })
  emit(`首发窗口未达发布线，正在按 ${targetChapterIds.length} 章证据依赖簇修复`, 'running')
  return { phase: 'repair_execute', stop: false }
}
