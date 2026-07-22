import { applyCausalChapterOutcome, type CausalChapterOutcome, type CausalNarrativeState } from '../../../shared/causal-novel-types'
import { causalNovelDAO, getDatabase, volumeChapterDAO } from '../../db'
import { commitPreparedNarrativeMemory, prepareNarrativeMemoryAfterGeneration } from './story-goal-doer'
import { novelMemoryCommitBlockers, runChapterAcceptanceGate } from './novel-goal-routine'
import type { StoryGoalConfig } from './story-goal-checker'
import { extractCausalOutcome } from './causal-novel-engine'

interface ReplayTransition {
  chapterId: number
  contentVersionId: number
  stateBeforeRevision: number
  nextState: CausalNarrativeState
  outcome: CausalChapterOutcome
}

export async function processPendingCausalReplay(
  workId: number,
  config: StoryGoalConfig,
  signal: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ replayJobId: number; finalRevision: number; replayedChapters: number } | null> {
  const job = causalNovelDAO.getPendingReplay(workId)
  if (!job || job.status === 'blocked') return null
  causalNovelDAO.updateReplayStatus(job.id, 'running')
  let activeChapterId = job.chapterId
  try {
    const currentHead = causalNovelDAO.getState(workId)
    const baseSnapshot = causalNovelDAO.getStateRevision(workId, job.baseStateRevision)
    let targetVersion = causalNovelDAO.getContentVersion(job.targetVersionId)
    const editedChapter = volumeChapterDAO.getChapter(job.chapterId)
    if (!currentHead || !baseSnapshot || !targetVersion || !editedChapter?.content?.trim()) {
      throw new Error('重放缺少当前状态、基础状态修订或目标正文版本')
    }
    if (targetVersion.content !== editedChapter.content) {
      throw new Error('当前正文已偏离重放目标版本，请重新提交编辑')
    }

    onProgress?.(`重放 1/4：重新验收人工修改章节「${editedChapter.title}」`)
    const acceptance = await runChapterAcceptanceGate(
      workId, job.chapterId, config, signal, message => onProgress?.(`重放验收：${message}`)
    )
    if (!acceptance.passed) {
      throw new Error(`人工修改正文质量门禁未通过：${acceptance.failedMetrics.join('；')}`)
    }
    const acceptedChapter = volumeChapterDAO.getChapter(job.chapterId)
    if (!acceptedChapter?.content?.trim()) throw new Error('正文验收后章节内容为空')
    if (acceptedChapter.content !== targetVersion.content) {
      targetVersion = causalNovelDAO.createContentVersion({
        workId,
        chapterId: job.chapterId,
        parentVersionId: targetVersion.id,
        content: acceptedChapter.content,
        source: 'acceptance_repair',
        editKind: 'factual',
        status: 'candidate'
      })
      causalNovelDAO.activateContentVersion({
        workId,
        chapterId: job.chapterId,
        contentVersionId: targetVersion.id,
        stateBeforeRevision: job.baseStateRevision,
        stateAfterRevision: null,
        decisionStatus: 'committed',
        bindingStatus: 'pending_replay'
      })
      causalNovelDAO.updateReplayTargetVersion(job.id, targetVersion.id)
    }

    const allChapters = volumeChapterDAO.listChaptersByWork(workId)
    const ordinalOf = (chapterId: number): number => {
      const index = allChapters.findIndex(item => item.id === chapterId)
      if (index < 0) throw new Error(`重放章节不存在：${chapterId}`)
      return index + 1
    }
    let workingState: CausalNarrativeState = { ...baseSnapshot.state, revision: currentHead.revision }
    onProgress?.('重放 2/4：从新正文重新提取章后事实与情绪结果')
    const edited = await extractCausalOutcome(
      workId,
      job.chapterId,
      signal,
      message => onProgress?.(`重放提取：${message}`),
      { baseState: workingState, allowCommittedDecision: true, ordinal: ordinalOf(job.chapterId) }
    )
    const transitions: ReplayTransition[] = [{
      chapterId: job.chapterId,
      contentVersionId: targetVersion.id,
      stateBeforeRevision: workingState.revision,
      nextState: edited.state,
      outcome: edited.outcome
    }]
    workingState = edited.state

    onProgress?.(`重放 3/4：逐章验证 ${job.affectedChapterIds.length} 个后续章节`)
    for (const chapterId of job.affectedChapterIds) {
      activeChapterId = chapterId
      const decision = causalNovelDAO.getDecision(chapterId)
      const chapter = volumeChapterDAO.getChapter(chapterId)
      if (!decision?.outcome || !chapter?.content?.trim()) {
        throw new Error(`后续章节 ${chapterId} 缺少已提交结果或正文`)
      }
      const contentVersion = causalNovelDAO.ensureCurrentContentVersion(
        workId, chapterId, 'replay_rebind', 'generated'
      )
      const nextState = applyCausalChapterOutcome(
        workingState, decision.outcome, ordinalOf(chapterId), chapter.content
      )
      transitions.push({
        chapterId,
        contentVersionId: contentVersion.id,
        stateBeforeRevision: workingState.revision,
        nextState,
        outcome: decision.outcome
      })
      workingState = nextState
    }

    const preparedMemories = []
    for (const transition of transitions) {
      activeChapterId = transition.chapterId
      const chapter = volumeChapterDAO.getChapter(transition.chapterId)
      if (!chapter?.content?.trim()) throw new Error(`重放章节 ${transition.chapterId} 正文不存在`)
      preparedMemories.push({
        chapterId: transition.chapterId,
        prepared: await prepareNarrativeMemoryAfterGeneration(
          workId, transition.chapterId, chapter.content, signal,
          { requirePatternFingerprint: true, dropInvalidStateFactsAfterRetries: true }
        )
      })
    }

    onProgress?.('重放 4/4：原子提交新状态分支、叙事记忆与正文绑定')
    getDatabase().transaction(() => {
      for (const item of preparedMemories) {
        commitPreparedNarrativeMemory(workId, item.chapterId, item.prepared, {
          markChapterCompleted: false,
          validate: () => novelMemoryCommitBlockers(workId, item.chapterId)
        })
      }
      for (const transition of transitions) {
        causalNovelDAO.applyReplayTransition({
          replayJobId: job.id,
          workId,
          chapterId: transition.chapterId,
          contentVersionId: transition.contentVersionId,
          expectedStateRevision: transition.stateBeforeRevision,
          nextState: transition.nextState,
          outcome: transition.outcome
        })
      }
      causalNovelDAO.completeReplay(job.id)
    })()
    return { replayJobId: job.id, finalRevision: workingState.revision, replayedChapters: transitions.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    causalNovelDAO.blockReplay(job.id, activeChapterId, message)
    throw new Error(`因果重放在章节 ${activeChapterId} 停止：${message}`)
  }
}
