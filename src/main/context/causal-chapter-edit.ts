import { createHash } from 'node:crypto'
import {
  causalNovelDAO,
  getDatabase,
  goalRoutineDAO,
  volumeChapterDAO,
  type CausalEditKind
} from '../db'
import { auditCausalManualExpressionEdit } from './causal-chapter-style-rewrite'
import { countWords as wordCount } from '../../shared/body-word-target'

export type CausalManualEditKind = Extract<CausalEditKind, 'expression' | 'factual'>

export interface CausalChapterEditPreview {
  chapterId: number
  editKind: CausalManualEditKind
  decisionStatus: 'planned' | 'committed'
  currentVersionId: number
  affectedChapterIds: number[]
  affectedChapterTitles: string[]
  requiresReplay: boolean
  warnings: string[]
  auditReasons: string[]
  expectedUpdateTime: string
  validationToken: string
}

export interface CausalChapterEditApplyResult {
  applied: boolean
  contentVersionId: number
  replayJobId: number | null
  replayStatus: string | null
  affectedChapterIds: number[]
}

const approvedEditTokens = new Map<string, { workId: number; chapterId: number; expiresAt: number }>()

export function buildCausalChapterEditToken(input: {
  workId: number
  chapterId: number
  currentVersionId: number
  expectedUpdateTime: string
  editKind: CausalManualEditKind
  candidateContent: string
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function loadEditContext(workId: number, chapterId: number) {
  if (volumeChapterDAO.getWorkIdForChapter(chapterId) !== workId) {
    throw new Error('章节不属于当前小说')
  }
  const chapter = volumeChapterDAO.getChapter(chapterId)
  const decision = causalNovelDAO.getDecision(chapterId)
  if (!chapter || !decision) throw new Error('因果章节或决策不存在')
  if (decision.status !== 'planned' && decision.status !== 'committed') {
    throw new Error('已拒绝的因果章节不能直接编辑')
  }
  const currentVersion = causalNovelDAO.ensureCurrentContentVersion(
    workId, chapterId, decision.status === 'committed' ? 'committed_backfill' : 'draft_backfill'
  )
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const chapterIndex = chapters.findIndex(item => item.id === chapterId)
  const decisions = new Map(causalNovelDAO.listDecisions(workId).map(item => [item.chapterId, item]))
  const affected = chapterIndex < 0 ? [] : chapters
    .slice(chapterIndex + 1)
    .filter(item => decisions.get(item.id)?.status === 'committed')
  return { chapter, decision, currentVersion, affected }
}

export async function previewCausalChapterEdit(input: {
  workId: number
  chapterId: number
  candidateContent: string
  editKind: CausalManualEditKind
}): Promise<CausalChapterEditPreview> {
  if (!input.candidateContent.trim()) throw new Error('章节正文不能为空；删除章节请使用结构重放流程')
  const context = loadEditContext(input.workId, input.chapterId)
  if (input.candidateContent === (context.chapter.content ?? '')) throw new Error('正文没有发生变化')
  let editKind = input.editKind
  let auditReasons: string[] = []
  const warnings: string[] = []
  if (context.decision.status === 'planned') {
    editKind = input.editKind
    warnings.push('本章尚未提交；保存后只废弃本章旧检查点，并从正文验收阶段继续。')
  } else if (editKind === 'expression') {
    const audit = await auditCausalManualExpressionEdit(
      input.workId, input.chapterId, input.candidateContent
    )
    auditReasons = audit.auditReasons
    warnings.push(`表达等价审计已通过，并保留 ${audit.evidenceAnchors.length} 条权威证据。`)
  } else {
    warnings.push('本次修改会改变已提交事实；原正文和原因果状态会保留为历史版本。')
    if (context.affected.length) {
      warnings.push(`后续 ${context.affected.length} 个已提交章节将标记为待重放，生成循环会保持暂停。`)
    }
  }
  const validationToken = buildCausalChapterEditToken({
    workId: input.workId,
    chapterId: input.chapterId,
    currentVersionId: context.currentVersion.id,
    expectedUpdateTime: context.chapter.update_time,
    editKind,
    candidateContent: input.candidateContent
  })
  approvedEditTokens.set(validationToken, {
    workId: input.workId,
    chapterId: input.chapterId,
    expiresAt: Date.now() + 15 * 60 * 1000
  })
  return {
    chapterId: input.chapterId,
    editKind,
    decisionStatus: context.decision.status as 'planned' | 'committed',
    currentVersionId: context.currentVersion.id,
    affectedChapterIds: context.affected.map(item => item.id),
    affectedChapterTitles: context.affected.map(item => item.title),
    requiresReplay: context.decision.status === 'committed' && editKind === 'factual',
    warnings,
    auditReasons,
    expectedUpdateTime: context.chapter.update_time,
    validationToken
  }
}

export function applyCausalChapterEdit(input: {
  workId: number
  chapterId: number
  candidateContent: string
  editKind: CausalManualEditKind
  currentVersionId: number
  expectedUpdateTime: string
  validationToken: string
}): CausalChapterEditApplyResult {
  if (!input.candidateContent.trim()) throw new Error('章节正文不能为空')
  const context = loadEditContext(input.workId, input.chapterId)
  if (context.chapter.update_time !== input.expectedUpdateTime) {
    throw new Error('章节已被其他操作修改，请重新预览影响')
  }
  if (context.currentVersion.id !== input.currentVersionId) {
    throw new Error('正文版本已变化，请重新预览影响')
  }
  const expectedToken = buildCausalChapterEditToken({
    workId: input.workId,
    chapterId: input.chapterId,
    currentVersionId: input.currentVersionId,
    expectedUpdateTime: input.expectedUpdateTime,
    editKind: input.editKind,
    candidateContent: input.candidateContent
  })
  if (expectedToken !== input.validationToken) throw new Error('编辑内容或类型已变化，请重新执行影响预览')
  const approval = approvedEditTokens.get(input.validationToken)
  approvedEditTokens.delete(input.validationToken)
  if (!approval || approval.expiresAt < Date.now() || approval.workId !== input.workId || approval.chapterId !== input.chapterId) {
    throw new Error('编辑预览已失效，请重新执行影响预览')
  }
  const affectedChapterIds = context.affected.map(item => item.id)
  return getDatabase().transaction(() => {
    const updated = volumeChapterDAO.updateChapterWithVersion(input.chapterId, {
      content: input.candidateContent,
      word_count: wordCount(input.candidateContent),
      expectedUpdateTime: input.expectedUpdateTime
    }, { model_type: `causal_manual_${input.editKind}` })
    if (!updated) throw new Error('章节已被其他操作修改，请重新预览影响')
    const persisted = volumeChapterDAO.getChapter(input.chapterId)
    if (!persisted?.content?.trim()) throw new Error('编辑后的持久化正文为空')
    const targetVersion = causalNovelDAO.createContentVersion({
      workId: input.workId,
      chapterId: input.chapterId,
      parentVersionId: context.currentVersion.id,
      content: persisted.content,
      source: 'manual',
      editKind: input.editKind,
      status: 'candidate'
    })

    const requiresReplay = context.decision.status === 'committed' && input.editKind === 'factual'
    causalNovelDAO.activateContentVersion({
      workId: input.workId,
      chapterId: input.chapterId,
      contentVersionId: targetVersion.id,
      stateBeforeRevision: context.decision.stateRevision,
      stateAfterRevision: context.decision.status === 'committed' ? context.decision.stateRevision + 1 : null,
      decisionStatus: context.decision.status,
      bindingStatus: requiresReplay ? 'pending_replay' : 'active'
    })
    causalNovelDAO.invalidateCheckpoints(input.workId, input.chapterId)

    if (!requiresReplay) {
      return {
        applied: true,
        contentVersionId: targetVersion.id,
        replayJobId: null,
        replayStatus: null,
        affectedChapterIds: []
      }
    }

    for (const downstreamId of affectedChapterIds) {
      causalNovelDAO.invalidateCheckpoints(input.workId, downstreamId)
    }
    const replay = causalNovelDAO.queueReplay({
      workId: input.workId,
      chapterId: input.chapterId,
      baseStateRevision: context.decision.stateRevision,
      sourceVersionId: context.currentVersion.id,
      targetVersionId: targetVersion.id,
      editKind: input.editKind,
      affectedChapterIds
    })
    goalRoutineDAO.setStatus(input.workId, 'paused')
    return {
      applied: true,
      contentVersionId: targetVersion.id,
      replayJobId: replay.id,
      replayStatus: replay.status,
      affectedChapterIds
    }
  })()
}

export function cancelCausalChapterReplay(workId: number, replayJobId: number): boolean {
  const job = causalNovelDAO.getReplayJob(replayJobId)
  if (!job || job.workId !== workId) throw new Error('因果重放任务不存在')
  if (job.status === 'running') throw new Error('因果重放正在运行，请先暂停生成')
  if (job.status === 'completed' || job.status === 'cancelled') throw new Error('因果重放任务已经结束')
  const sourceVersion = causalNovelDAO.getContentVersion(job.sourceVersionId)
  const decision = causalNovelDAO.getDecision(job.chapterId)
  if (!sourceVersion || !decision) throw new Error('无法找到修改前的正文版本或章节决策')
  return getDatabase().transaction(() => {
    const updated = volumeChapterDAO.updateChapterWithVersion(job.chapterId, {
      content: sourceVersion.content,
      word_count: sourceVersion.wordCount
    }, { model_type: 'causal_replay_cancel_restore' })
    if (!updated) throw new Error('恢复修改前正文失败')
    causalNovelDAO.activateContentVersion({
      workId,
      chapterId: job.chapterId,
      contentVersionId: sourceVersion.id,
      stateBeforeRevision: decision.stateRevision,
      stateAfterRevision: decision.status === 'committed' ? decision.stateRevision + 1 : null,
      decisionStatus: decision.status,
      bindingStatus: 'active'
    })
    causalNovelDAO.cancelReplay(job.id)
    return true
  })()
}
