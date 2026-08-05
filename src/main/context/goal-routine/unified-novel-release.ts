import { createHash } from 'node:crypto'
import { causalNovelDAO, getDatabase, volumeChapterDAO } from '../../db'
import { runResourceConstraintGate } from '../resource-ledger'
import { readNovelGoalState } from './novel-outline-pipeline'
import type { GoalCheckResult } from './story-goal-checker'

export interface UnifiedNovelRelease {
  snapshotId: number
  revision: number
}

export interface UnifiedNovelReleaseProof {
  protocol: 'unified_novel_release_proof_v2'
  auditedAt: string
  authorityRevision: number
  chapterBindings: Array<{
    chapterId: number
    bodyHash: string
    stateAfterRevision: number
  }>
  resolvedPromiseCount: number
  archivedResolvedPromiseCount: number
  completedMacroArcIds: string[]
  balancedResourceChapterIds: number[]
  checkedVolumeNames: string[]
  qualityScore: number
  goalMatchScore: number
}

export function requireUnifiedNovelAuthorityCompletion(
  workId: number,
  check: GoalCheckResult
): GoalCheckResult {
  if (!check.met) return check
  const state = causalNovelDAO.getState(workId)
  const unresolvedPromises = state?.promises.filter(item => item.status !== 'resolved') ?? []
  const incompleteArcs = state?.macroArcs.filter(item => item.status !== 'completed') ?? []
  if (
    (state?.completionStatus === 'proposed' || state?.completionStatus === 'completed')
    && unresolvedPromises.length === 0
    && incompleteArcs.length === 0
    && state.completionAuditFeedback.length === 0
  ) {
    return check
  }
  return {
    ...check,
    met: false,
    reasons: [
      ...check.reasons,
      state
        ? [
            state.completionStatus === 'writing'
              ? '章后权威事实尚未满足核心问题的不可逆终止条件'
              : '',
            unresolvedPromises.length > 0
              ? `仍有 ${unresolvedPromises.length} 个读者承诺未兑现`
              : '',
            incompleteArcs.length > 0
              ? `仍有 ${incompleteArcs.length} 个宏观阶段未闭合`
              : '',
            state.completionAuditFeedback.length > 0
              ? `仍有 ${state.completionAuditFeedback.length} 项完结审计反馈`
              : ''
          ].filter(Boolean).join('；')
        : '小说尚未建立权威因果状态'
    ]
  }
}

export function buildUnifiedNovelReleaseProof(
  workId: number,
  check: GoalCheckResult
): UnifiedNovelReleaseProof {
  const state = causalNovelDAO.getState(workId)
  if (!state) throw new Error('小说尚未建立权威因果状态')
  const runtime = readNovelGoalState(workId)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const volumes = volumeChapterDAO.listVolumes(workId)
  const unresolvedPromises = state.promises.filter(item => item.status !== 'resolved')
  const incompleteArcs = state.macroArcs.filter(item => item.status !== 'completed')
  const blockers: string[] = []
  if (!check.met) blockers.push('整书目标终审尚未通过')
  if (state.completionStatus !== 'proposed') blockers.push('权威因果状态尚未提议完结')
  if (state.completionAuditFeedback.length > 0) {
    blockers.push(`完结审计仍有 ${state.completionAuditFeedback.length} 项反馈`)
  }
  if (unresolvedPromises.length > 0) {
    blockers.push(`仍有 ${unresolvedPromises.length} 个读者承诺未兑现`)
  }
  if (incompleteArcs.length > 0) {
    blockers.push(`仍有 ${incompleteArcs.length} 个宏观阶段未完成`)
  }
  if (!runtime.titleHookApplied) blockers.push('书名与开篇导语尚未形成冻结版本')

  if ((runtime.volumeGateDeferredIssues ?? []).length > 0) {
    blockers.push(`仍有 ${runtime.volumeGateDeferredIssues!.length} 卷硬门禁债务未清零`)
  }

  const activeEditorialDebts = (runtime.chapterEditorialDebts ?? []).filter(debt => {
    const chapter = chapters.find(item => item.id === debt.chapterId)
    if (!chapter?.content?.trim()) return false
    const hash = createHash('sha256').update(chapter.content.trim()).digest('hex')
    return hash === debt.contentHash
  })
  if (activeEditorialDebts.length > 0) {
    blockers.push(`仍有 ${activeEditorialDebts.length} 项绑定当前正文的章节编辑债务未清零`)
  }

  const unfinishedChapters = chapters.filter(chapter => chapter.status !== 'completed')
  if (unfinishedChapters.length > 0) {
    blockers.push(`仍有 ${unfinishedChapters.length} 章不是已完成状态`)
  }

  const checkedVolumes = new Set(runtime.checkedBodyVolumes ?? [])
  const missingVolumeChecks = volumes.filter(volume => !checkedVolumes.has(volume.name))
  if (missingVolumeChecks.length > 0) {
    blockers.push(`仍有 ${missingVolumeChecks.length} 卷未通过正文检查点`)
  }

  const chapterBindings: UnifiedNovelReleaseProof['chapterBindings'] = []
  const balancedResourceChapterIds: number[] = []
  for (const chapter of chapters) {
    try {
      causalNovelDAO.assertCommittedBindingCurrent(workId, chapter.id)
      const binding = causalNovelDAO.getChapterBinding(chapter.id)!
      const version = causalNovelDAO.getContentVersion(binding.contentVersionId)!
      chapterBindings.push({
        chapterId: chapter.id,
        bodyHash: version.bodyHash,
        stateAfterRevision: binding.stateAfterRevision!
      })
    } catch (error) {
      blockers.push(
        `「${chapter.title}」权威正文绑定无效：`
        + (error instanceof Error ? error.message : String(error))
      )
    }
    const resource = runResourceConstraintGate(workId, chapter.id)
    if (resource.blockers.length > 0) {
      blockers.push(`「${chapter.title}」资源账本不平：${resource.blockers.join('；')}`)
    } else {
      balancedResourceChapterIds.push(chapter.id)
    }
  }
  if (blockers.length > 0) {
    throw new Error(`发布证明未通过：${blockers.join('；')}`)
  }
  return {
    protocol: 'unified_novel_release_proof_v2',
    auditedAt: new Date().toISOString(),
    authorityRevision: state.revision,
    chapterBindings,
    resolvedPromiseCount: state.promises.filter(item => item.status === 'resolved').length,
    archivedResolvedPromiseCount: state.archivedPromiseIds.length,
    completedMacroArcIds: state.macroArcs.map(item => item.id),
    balancedResourceChapterIds,
    checkedVolumeNames: volumes.map(volume => volume.name),
    qualityScore: check.qualityScore,
    goalMatchScore: check.goalMatchScore
  }
}

export function freezeUnifiedNovelRelease(
  workId: number,
  check: GoalCheckResult
): UnifiedNovelRelease | null {
  const state = causalNovelDAO.getState(workId)
  if (!state || state.completionStatus === 'completed') return null
  const proof = buildUnifiedNovelReleaseProof(workId, check)
  return getDatabase().transaction(() => {
    const completed = causalNovelDAO.confirmCompletion(
      workId,
      state.revision,
      state.completionReason
    )
    const snapshotId = causalNovelDAO.createReleaseSnapshot(
      workId,
      `unified_novel_release_r${completed.revision}`,
      proof
    )
    return { snapshotId, revision: completed.revision }
  })()
}
