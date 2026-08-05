import { causalNovelDAO, getDatabase, volumeChapterDAO } from '../../db'
import type { CausalEditKind } from '../../db/dao/causal-novel-dao'
import {
  commitPreparedNarrativeMemory,
  prepareNarrativeMemoryAfterGeneration
} from './story-goal-doer'
import {
  assertCommittedNovelBindingCurrent,
  commitUnifiedNovelChapter,
  type UnifiedNovelCommitResult
} from './unified-novel-chapter'
import {
  novelMemoryCommitBlockers,
  runChapterAcceptanceGate
} from './novel-chapter-acceptance'
import { processPendingCausalReplay } from './causal-replay'
import type { StoryGoalConfig } from './story-goal-checker'

export interface UnifiedNovelRepairContext {
  workId: number
  chapterId: number
  decisionStatus: 'planned' | 'committed'
  decisionStateRevision: number
  sourceVersionId: number
  sourceContent: string
  sourceWordCount: number
  sourceChapterStatus: string
  sourceQualityAssessmentJson: string | null
  sourceEmotionAssessmentJson: string | null
  affectedChapterIds: number[]
}

export interface UnifiedNovelRepairResult extends UnifiedNovelCommitResult {
  replayJobId: number | null
  replayedChapters: number
}

function zeroMemoryResult(
  revision: number,
  summary: string,
  replayJobId: number | null,
  replayedChapters: number
): UnifiedNovelRepairResult {
  return {
    revision,
    summary,
    timelineEvents: 0,
    planted: 0,
    snapshots: 0,
    foreshadowingResolved: 0,
    replayJobId,
    replayedChapters
  }
}

/**
 * 在任何自动正文修订前冻结权威输入。修订结束后只能把同一个上下文交给
 * commitUnifiedNovelRepair，禁止根据已经改变的正文反推“修改前”版本。
 */
export function captureUnifiedNovelRepair(
  workId: number,
  chapterId: number
): UnifiedNovelRepairContext {
  const decision = causalNovelDAO.getDecision(chapterId)
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!decision || decision.workId !== workId || !chapter) {
    throw new Error('统一修复缺少章节或权威决策')
  }
  if (decision.status !== 'planned' && decision.status !== 'committed') {
    throw new Error('被拒绝的章节决策不能进入自动修复')
  }
  if (decision.status === 'committed') {
    assertCommittedNovelBindingCurrent(workId, chapterId)
  }
  const sourceVersion = causalNovelDAO.ensureCurrentContentVersion(
    workId,
    chapterId,
    'repair_source',
    'generated'
  )
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const index = chapters.findIndex(item => item.id === chapterId)
  const committedIds = new Set(
    causalNovelDAO.listDecisions(workId)
      .filter(item => item.status === 'committed')
      .map(item => item.chapterId)
  )
  const affectedChapterIds = index < 0
    ? []
    : chapters.slice(index + 1).filter(item => committedIds.has(item.id)).map(item => item.id)
  return {
    workId,
    chapterId,
    decisionStatus: decision.status,
    decisionStateRevision: decision.stateRevision,
    sourceVersionId: sourceVersion.id,
    sourceContent: chapter.content ?? '',
    sourceWordCount: chapter.word_count ?? sourceVersion.wordCount,
    sourceChapterStatus: chapter.status,
    sourceQualityAssessmentJson: chapter.quality_assessment_json ?? null,
    sourceEmotionAssessmentJson: chapter.emotion_assessment_json ?? null,
    affectedChapterIds
  }
}

/**
 * 未通过全部门禁的修订只能作为候选证据存在，不能成为下一轮权威基线。
 * 这里原子恢复修订前正文、验收缓存和内容版本绑定。
 */
export function discardUnifiedNovelRepairCandidate(
  context: UnifiedNovelRepairContext
): void {
  const decision = causalNovelDAO.getDecision(context.chapterId)
  const sourceVersion = causalNovelDAO.getContentVersion(context.sourceVersionId)
  if (
    !decision
    || decision.workId !== context.workId
    || decision.status !== context.decisionStatus
    || decision.stateRevision !== context.decisionStateRevision
    || !sourceVersion
    || sourceVersion.chapterId !== context.chapterId
    || sourceVersion.content !== context.sourceContent
  ) {
    throw new Error('修复候选回滚时权威输入已变化，拒绝覆盖当前章节')
  }
  getDatabase().transaction(() => {
    volumeChapterDAO.updateChapter(context.chapterId, {
      content: context.sourceContent,
      word_count: context.sourceWordCount,
      status: context.sourceChapterStatus,
      quality_assessment_json: context.sourceQualityAssessmentJson,
      emotion_assessment_json: context.sourceEmotionAssessmentJson
    })
    causalNovelDAO.activateContentVersion({
      workId: context.workId,
      chapterId: context.chapterId,
      contentVersionId: context.sourceVersionId,
      stateBeforeRevision: context.decisionStateRevision,
      stateAfterRevision: context.decisionStatus === 'committed'
        ? context.decisionStateRevision + 1
        : null,
      decisionStatus: context.decisionStatus,
      bindingStatus: 'active'
    })
  })()
}

export function assertUnifiedStructuralRepairAllowed(
  workId: number,
  chapterIds: number[]
): void {
  const committed = chapterIds
    .map(chapterId => causalNovelDAO.getDecision(chapterId))
    .filter(decision => decision?.workId === workId && decision.status === 'committed')
  if (committed.length > 0) {
    throw new Error(
      `结构修复涉及 ${committed.length} 个已提交权威章节；禁止清空正文或覆盖大纲，`
      + '必须先进入显式因果分支重写'
    )
  }
}

export function discardUnifiedPlannedDecisions(chapterIds: number[]): void {
  for (const chapterId of chapterIds) {
    if (causalNovelDAO.getDecision(chapterId)?.status === 'planned') {
      causalNovelDAO.discardPlannedDecision(chapterId)
    }
  }
}

async function refreshCommittedDerivedMemory(
  context: UnifiedNovelRepairContext,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<UnifiedNovelRepairResult> {
  const chapter = volumeChapterDAO.getChapter(context.chapterId)
  if (!chapter?.content?.trim()) throw new Error('权威正文不存在，不能刷新派生记忆')
  assertCommittedNovelBindingCurrent(context.workId, context.chapterId)
  onProgress?.(`正在从「${chapter.title}」当前权威正文重建派生记忆`)
  const prepared = await prepareNarrativeMemoryAfterGeneration(
    context.workId,
    context.chapterId,
    chapter.content,
    signal,
    { requirePatternFingerprint: true, dropInvalidStateFactsAfterRetries: true }
  )
  const committed = getDatabase().transaction(() => commitPreparedNarrativeMemory(
    context.workId,
    context.chapterId,
    prepared,
    {
      markChapterCompleted: true,
      validate: () => novelMemoryCommitBlockers(context.workId, context.chapterId)
    }
  ))()
  return {
    revision: context.decisionStateRevision + 1,
    summary: '权威正文未变化，已刷新正文哈希绑定的派生记忆',
    timelineEvents: committed.timelineEvents,
    planted: committed.planted,
    snapshots: committed.snapshots,
    foreshadowingResolved: committed.foreshadowingResolved,
    replayJobId: null,
    replayedChapters: 0
  }
}

/**
 * 自动修复的唯一提交边界：
 * - planned 章节按普通统一事务提交；
 * - committed 章节正文未变时只重建派生记忆；
 * - committed 章节正文变化时创建不可变版本、失效下游并立即完成因果重放。
 */
export async function commitUnifiedNovelRepair(
  context: UnifiedNovelRepairContext,
  config: StoryGoalConfig,
  signal: AbortSignal,
  onProgress?: (message: string) => void,
  editKind: CausalEditKind = 'factual'
): Promise<UnifiedNovelRepairResult> {
  const chapter = volumeChapterDAO.getChapter(context.chapterId)
  const decision = causalNovelDAO.getDecision(context.chapterId)
  if (!chapter?.content?.trim() || !decision) {
    throw new Error('修复后的章节正文或权威决策不存在')
  }
  if (
    decision.status !== context.decisionStatus
    || decision.stateRevision !== context.decisionStateRevision
  ) {
    throw new Error('修复期间章节权威决策已变化，拒绝提交过期候选')
  }

  if (chapter.content === context.sourceContent) {
    if (context.decisionStatus === 'committed') {
      return refreshCommittedDerivedMemory(context, signal, onProgress)
    }
    const committed = await commitUnifiedNovelChapter(
      context.workId,
      context.chapterId,
      config,
      signal,
      onProgress
    )
    return { ...committed, replayJobId: null, replayedChapters: 0 }
  }

  if (context.decisionStatus === 'planned') {
    const committed = await commitUnifiedNovelChapter(
      context.workId,
      context.chapterId,
      config,
      signal,
      onProgress
    )
    return { ...committed, replayJobId: null, replayedChapters: 0 }
  }

  causalNovelDAO.invalidateCheckpoints(context.workId, context.chapterId)

  const existingReplay = causalNovelDAO.getPendingReplay(context.workId)
  if (existingReplay?.chapterId === context.chapterId) {
    const targetVersion = causalNovelDAO.getContentVersion(existingReplay.targetVersionId)
    if (
      existingReplay.sourceVersionId !== context.sourceVersionId
      || !targetVersion
      || targetVersion.content !== chapter.content
    ) {
      throw new Error('待恢复因果重放与冻结修复候选不一致，拒绝创建重复重放任务')
    }
    onProgress?.(`正在从因果重放任务 #${existingReplay.id} 的持久化检查点恢复`)
    const replayed = await processPendingCausalReplay(
      context.workId,
      config,
      signal,
      onProgress
    )
    if (!replayed) throw new Error('持久化因果重放任务当前不可执行')
    return zeroMemoryResult(
      replayed.finalRevision,
      `已恢复并完成 ${replayed.replayedChapters} 章因果重放`,
      replayed.replayJobId,
      replayed.replayedChapters
    )
  }
  if (existingReplay) {
    throw new Error(
      `作品已有章节 ${existingReplay.chapterId} 的因果重放任务 #${existingReplay.id}，禁止并发创建第二个重放事务`
    )
  }

  const targetVersion = getDatabase().transaction(() => {
    const version = causalNovelDAO.createContentVersion({
      workId: context.workId,
      chapterId: context.chapterId,
      parentVersionId: context.sourceVersionId,
      content: chapter.content!,
      source: 'goal_repair',
      editKind,
      status: 'candidate'
    })
    causalNovelDAO.activateContentVersion({
      workId: context.workId,
      chapterId: context.chapterId,
      contentVersionId: version.id,
      stateBeforeRevision: context.decisionStateRevision,
      stateAfterRevision: context.decisionStateRevision + 1,
      decisionStatus: 'committed',
      bindingStatus: 'pending_replay'
    })
    for (const downstreamId of context.affectedChapterIds) {
      causalNovelDAO.invalidateCheckpoints(context.workId, downstreamId)
    }
    causalNovelDAO.queueReplay({
      workId: context.workId,
      chapterId: context.chapterId,
      baseStateRevision: context.decisionStateRevision,
      sourceVersionId: context.sourceVersionId,
      targetVersionId: version.id,
      editKind,
      affectedChapterIds: context.affectedChapterIds
    })
    return version
  })()

  onProgress?.(
    `正文版本 #${targetVersion.id} 已冻结；正在重放本章及后续 `
    + `${context.affectedChapterIds.length} 个权威章节`
  )
  const replayed = await processPendingCausalReplay(
    context.workId,
    config,
    signal,
    onProgress
  )
  if (!replayed) throw new Error('已创建因果重放任务，但运行器没有取得待处理任务')
  return zeroMemoryResult(
    replayed.finalRevision,
    `已完成 ${replayed.replayedChapters} 章因果重放`,
    replayed.replayJobId,
    replayed.replayedChapters
  )
}
