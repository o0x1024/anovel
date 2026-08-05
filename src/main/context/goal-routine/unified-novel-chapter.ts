import { createHash } from 'node:crypto'
import { causalNovelDAO, getDatabase, volumeChapterDAO } from '../../db'
import {
  commitPreparedNarrativeMemory,
  type PreparedNarrativeMemory
} from './story-goal-doer'
import type { StoryGoalConfig } from './story-goal-checker'
import {
  extractCausalOutcome,
  initializeCausalNovelState,
  planNextCausalChapter
} from './causal-novel-engine'
import { novelMemoryCommitBlockers } from './novel-memory-commit-blockers'
import {
  CAUSAL_OUTCOME_PROTOCOL_VERSION,
  CausalOutcomeProtocolError,
  causalOutcomeFailureCode
} from '../../../shared/causal-outcome-protocol'
import { repairCausalBodyContract } from './causal-body-contract-repair'
import {
  causalOutcomeFailurePolicy,
  registerCausalOutcomeFailure
} from './causal-outcome-failure-policy'

export interface UnifiedNovelCommitResult {
  revision: number
  summary: string
  timelineEvents: number
  planted: number
  snapshots: number
  foreshadowingResolved: number
}

const AUTHORITY_CONTRACT_MARKER = '## 章级权威因果合同'

function currentMacroOutlineHash(chapterId: number): string {
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!chapter) throw new Error('权威章节不存在')
  const macroOutline = (chapter.outline ?? '').split(AUTHORITY_CONTRACT_MARKER, 1)[0].trim()
  return createHash('sha256').update(macroOutline).digest('hex')
}

function storedMacroOutlineHash(chapterId: number): string | null {
  const diagnosis = volumeChapterDAO.getChapter(chapterId)?.outline_diagnosis
  if (!diagnosis) return null
  try {
    const parsed = JSON.parse(diagnosis) as {
      authority_transaction?: { macro_outline_hash?: unknown }
    }
    const value = parsed.authority_transaction?.macro_outline_hash
    return typeof value === 'string' && value.trim() ? value : null
  } catch {
    return null
  }
}

function hasStructuredAuthorityContract(chapterId: number): boolean {
  const diagnosis = volumeChapterDAO.getChapter(chapterId)?.outline_diagnosis
  if (!diagnosis) return false
  try {
    const parsed = JSON.parse(diagnosis) as {
      authority_transaction?: {
        protocol?: unknown
        execution_contract?: { required_outcomes?: unknown }
      }
    }
    return parsed.authority_transaction?.protocol === 'unified_novel_v2'
      && Array.isArray(parsed.authority_transaction.execution_contract?.required_outcomes)
      && parsed.authority_transaction.execution_contract.required_outcomes.length > 0
  } catch {
    return false
  }
}

export function assertCommittedNovelBindingCurrent(
  workId: number,
  chapterId: number
): void {
  causalNovelDAO.assertCommittedBindingCurrent(workId, chapterId)
}

export function isUnifiedNovelDecisionReady(
  workId: number,
  chapterId: number
): boolean {
  const existing = causalNovelDAO.getDecision(chapterId)
  if (!existing) return false
  if (existing.status === 'committed') return true
  if (existing.status !== 'planned') return false
  const stateRevision = causalNovelDAO.getState(workId)?.revision
  const storedHash = storedMacroOutlineHash(chapterId)
  return existing.stateRevision === stateRevision
    && storedHash !== null
    && storedHash === currentMacroOutlineHash(chapterId)
    && hasStructuredAuthorityContract(chapterId)
}

export function hasUnifiedNovelPrecommitArtifacts(workId: number, chapterId: number): boolean {
  const chapter = volumeChapterDAO.getChapter(chapterId)
  const binding = causalNovelDAO.getChapterBinding(chapterId)
  const version = binding ? causalNovelDAO.getContentVersion(binding.contentVersionId) : null
  if (!chapter?.content?.trim() || !version || version.content !== chapter.content) return false
  const memory = causalNovelDAO.getCheckpoint(chapterId, version.id, 'narrative_memory')
  const outcome = causalNovelDAO.getCheckpoint(
    chapterId,
    version.id,
    'causal_outcome',
    CAUSAL_OUTCOME_PROTOCOL_VERSION
  )
  const extracted = outcome?.payload as Awaited<ReturnType<typeof extractCausalOutcome>> | null
  const stateRevision = causalNovelDAO.getState(workId)?.revision
  return memory?.status === 'completed'
    && Boolean(memory.payload)
    && outcome?.status === 'completed'
    && extracted?.bodyHash === version.bodyHash
    && extracted?.state.revision === (stateRevision ?? -2) + 1
}

/**
 * 把传统宏观章节合同绑定到当前权威状态修订。
 * 规划成功后决策保持 planned；正文、记忆和状态都尚未提交。
 */
export async function ensureUnifiedNovelDecision(
  workId: number,
  chapterId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
  checkEmotionContract = true
): Promise<void> {
  if (!causalNovelDAO.getState(workId)) {
    onProgress?.('正在把全书规划与既有正文压缩为权威因果基线')
    await initializeCausalNovelState(workId, goal, signal, onProgress)
  }
  const existing = causalNovelDAO.getDecision(chapterId)
  if (existing?.status === 'committed') {
    assertCommittedNovelBindingCurrent(workId, chapterId)
    return
  }
  if (existing?.status === 'planned') {
    const stateRevision = causalNovelDAO.getState(workId)?.revision
    const storedHash = storedMacroOutlineHash(chapterId)
    if (
      existing.stateRevision === stateRevision
      && storedHash !== null
      && storedHash === currentMacroOutlineHash(chapterId)
      && hasStructuredAuthorityContract(chapterId)
    ) {
      return
    }
    causalNovelDAO.discardPlannedDecision(chapterId)
    onProgress?.('章节宏观合同或权威状态已变化，已废弃旧决策并重新规划')
  } else if (existing) {
    throw new Error('章节权威决策已被拒绝，必须重新建立章节规划后才能生成正文')
  }
  onProgress?.('正在为当前宏观章节生成有序候选与执行合同')
  await planNextCausalChapter(workId, goal, signal, onProgress, {
    existingChapterId: chapterId,
    checkEmotionContract
  })
}

export async function prepareUnifiedNovelNarrativeMemory(
  workId: number,
  chapterId: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<void> {
  const decision = causalNovelDAO.getDecision(chapterId)
  if (!decision || decision.status !== 'planned') throw new Error('当前章节缺少待提交权威因果决策')
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!chapter?.content?.trim()) throw new Error('当前章节缺少最终正文，禁止准备提交制品')

  const contentVersion = causalNovelDAO.ensureCurrentContentVersion(
    workId,
    chapterId,
    'accepted_body',
    'generated'
  )
  const memoryCheckpoint = causalNovelDAO.getCheckpoint(
    chapterId,
    contentVersion.id,
    'narrative_memory'
  )
  if (memoryCheckpoint?.status === 'completed' && memoryCheckpoint.payload) {
    onProgress?.('已复用当前正文哈希绑定的候选叙事记忆')
    return
  }
  const outcomeCheckpoint = causalNovelDAO.getCheckpoint(
    chapterId,
    contentVersion.id,
    'causal_outcome',
    CAUSAL_OUTCOME_PROTOCOL_VERSION
  )
  const extracted = outcomeCheckpoint?.status === 'completed'
    ? outcomeCheckpoint.payload as Awaited<ReturnType<typeof extractCausalOutcome>> | null
    : null
  if (!extracted || extracted.bodyHash !== contentVersion.bodyHash) {
    throw new Error('PRECOMMIT_ARTIFACT_MISSING：必须先完成携证章节状态事务才能投影叙事记忆')
  }
  onProgress?.('正在从携证章节状态事务本地投影叙事记忆，不再调用第二个提取模型')
  const actorNames = new Set([
    ...extracted.outcome.actorUpdates.map(item => item.actor),
    ...extracted.outcome.newActors.map(item => item.actor.name)
  ])
  const actorSnapshots = [...actorNames].map(name => {
    const update = extracted.outcome.actorUpdates.find(item => item.actor === name)
    const actor = extracted.state.actors.find(item => item.name === name)
    return {
      character_name: name,
      location: update?.location ?? actor?.location ?? '',
      mental_state: name === decision.plan.emotionContract.pov_character
        ? extracted.outcome.emotionalOutcome.readerEffectSummary
        : '',
      known_info: update?.knowledgeAdded?.join('；') ?? actor?.knowledge.join('；') ?? '',
      relationship_changes: [
        ...(update?.relationshipsAdded ?? []).map(item => `新增：${item}`),
        ...(update?.relationshipsRemoved ?? []).map(item => `移除：${item}`)
      ].join('；'),
      ability_changes: [
        ...(update?.resourcesAdded ?? []).map(item => `获得：${item}`),
        ...(update?.resourcesRemoved ?? []).map(item => `失去：${item}`),
        update?.physicalState ? `身体：${update.physicalState}` : ''
      ].filter(Boolean).join('；'),
      numeric_stats: []
    }
  })
  const decisionData = decision.plan.decision
  const emotion = extracted.outcome.emotionalOutcome
  const payoffType = emotion.emotionalDebtPaid
    ? 'major' as const
    : extracted.outcome.resolvedPromiseIds.length > 0
      ? 'partial' as const
      : emotion.emotionalDebtOpened
        ? 'debt' as const
        : 'aftertaste' as const
  const preparedMemory: PreparedNarrativeMemory = {
    sourceContent: chapter.content,
    extracted: {
      foreshadowing_planted: [],
      foreshadowing_resolved: [],
      character_snapshots: actorSnapshots,
      timeline_events: [{
        event_name: extracted.outcome.eventSignature || chapter.title,
        event_description: extracted.outcome.summary,
        relative_time: '承接上一章'
      }],
      state_facts: [],
      chapter_pattern: {
        conflictType: decisionData.opposition,
        protagonistMethod: decisionData.chosenAction,
        antagonistTactic: decisionData.opposition,
        antagonistOutcome: extracted.outcome.summary,
        opponentAdjustment: extracted.outcome.pressureUpdates
          .map(item => `${item.id}:${item.status}`)
          .join('；') || '无变化',
        locationType: actorSnapshots.map(item => item.location).filter(Boolean).join('、') || '延续场景',
        hookType: decisionData.newQuestion,
        costType: decisionData.cost,
        relationshipDelta: actorSnapshots
          .map(item => item.relationship_changes)
          .filter(Boolean)
          .join('；') || '无变化',
        volumeObjectiveDelta: extracted.outcome.summary,
        payoffType
      }
    },
    resolutions: { resolved: [], partial: [], pending: [] },
    warnings: []
  }
  causalNovelDAO.saveCheckpoint({
    workId,
    chapterId,
    contentVersionId: contentVersion.id,
    bodyHash: contentVersion.bodyHash,
    stage: 'narrative_memory',
    status: 'completed',
    payload: preparedMemory
  })
}

export async function prepareUnifiedNovelCausalOutcome(
  workId: number,
  chapterId: number,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<void> {
  const decision = causalNovelDAO.getDecision(chapterId)
  if (!decision || decision.status !== 'planned') throw new Error('当前章节缺少待提交权威因果决策')
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!chapter?.content?.trim()) throw new Error('当前章节缺少最终正文，禁止准备提交制品')
  const contentVersion = causalNovelDAO.ensureCurrentContentVersion(
    workId,
    chapterId,
    'accepted_body',
    'generated'
  )

  const outcomeCheckpoint = causalNovelDAO.getCheckpoint(
    chapterId,
    contentVersion.id,
    'causal_outcome',
    CAUSAL_OUTCOME_PROTOCOL_VERSION
  )
  const cachedOutcome = outcomeCheckpoint?.status === 'completed'
    ? outcomeCheckpoint.payload as Awaited<ReturnType<typeof extractCausalOutcome>> | null
    : null
  const stateRevision = causalNovelDAO.getState(workId)?.revision
  let extracted: Awaited<ReturnType<typeof extractCausalOutcome>>
  if (
    cachedOutcome?.bodyHash === contentVersion.bodyHash
    && cachedOutcome.state?.revision === (stateRevision ?? -2) + 1
  ) {
    extracted = cachedOutcome
  } else {
    try {
      extracted = await extractCausalOutcome(workId, chapterId, signal, onProgress)
    } catch (error) {
      const protocolError = error instanceof CausalOutcomeProtocolError
        ? error
        : new CausalOutcomeProtocolError(
            causalOutcomeFailureCode(error),
            error instanceof Error ? error.message : String(error)
          )
      registerCausalOutcomeFailure({
        workId,
        chapterId,
        contentVersionId: contentVersion.id,
        bodyHash: contentVersion.bodyHash,
        stateRevision: stateRevision ?? -1,
        code: protocolError.code,
        message: protocolError.message
      })
      if (
        causalOutcomeFailurePolicy(protocolError.code).disposition === 'body_contract_repair'
      ) {
        const repaired = await repairCausalBodyContract({
          workId,
          chapterId,
          contentVersionId: contentVersion.id,
          bodyHash: contentVersion.bodyHash,
          wordTarget: config.wordsPerChapter ?? undefined,
          wordCountTolerance: config.wordCountTolerance,
          signal,
          onProgress
        })
        if (repaired.repaired) {
          onProgress?.(`${repaired.reason}；新正文必须重新通过质量、情绪与执行合同门禁`)
          return
        }
        throw Object.assign(
          new Error(`BODY_CONTRACT_REPAIR_FAILED：${repaired.reason}`),
          { code: 'BODY_CONTRACT_REPAIR_FAILED' }
        )
      }
      throw protocolError
    }
  }

  if (extracted !== cachedOutcome) {
    causalNovelDAO.saveCheckpoint({
      workId,
      chapterId,
      contentVersionId: contentVersion.id,
      bodyHash: contentVersion.bodyHash,
      protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
      stage: 'causal_outcome',
      status: 'completed',
      payload: extracted
    })
  }
}

export async function prepareUnifiedNovelChapterCommit(
  workId: number,
  chapterId: number,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<void> {
  await prepareUnifiedNovelCausalOutcome(workId, chapterId, config, signal, onProgress)
  await prepareUnifiedNovelNarrativeMemory(workId, chapterId, signal, onProgress)
}

/**
 * 纯持久化提交边界：这里禁止调用模型。候选叙事记忆与因果结果必须已经由
 * 最终候选验收阶段生成，并同时绑定当前正文哈希和状态修订。
 */
export async function commitUnifiedNovelChapter(
  workId: number,
  chapterId: number,
  _config: StoryGoalConfig,
  _signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<UnifiedNovelCommitResult> {
  const decision = causalNovelDAO.getDecision(chapterId)
  if (!decision) throw new Error('当前章节缺少权威因果决策，禁止提交')
  if (decision.status === 'committed') {
    assertCommittedNovelBindingCurrent(workId, chapterId)
    return {
      revision: decision.stateRevision + 1,
      summary: decision.outcome?.summary ?? '已提交',
      timelineEvents: 0,
      planted: 0,
      snapshots: 0,
      foreshadowingResolved: 0
    }
  }
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!chapter?.content?.trim()) throw new Error('当前章节缺少最终正文，禁止提交')
  const contentVersion = causalNovelDAO.ensureCurrentContentVersion(
    workId,
    chapterId,
    'accepted_body',
    'generated'
  )
  const memoryCheckpoint = causalNovelDAO.getCheckpoint(
    chapterId,
    contentVersion.id,
    'narrative_memory'
  )
  if (memoryCheckpoint?.status !== 'completed' || !memoryCheckpoint.payload) {
    throw new Error('PRECOMMIT_ARTIFACT_MISSING：当前正文缺少已验证的叙事记忆制品')
  }
  const preparedMemory = memoryCheckpoint.payload as PreparedNarrativeMemory
  const outcomeCheckpoint = causalNovelDAO.getCheckpoint(
    chapterId,
    contentVersion.id,
    'causal_outcome',
    CAUSAL_OUTCOME_PROTOCOL_VERSION
  )
  const extracted = outcomeCheckpoint?.status === 'completed'
    ? outcomeCheckpoint.payload as Awaited<ReturnType<typeof extractCausalOutcome>> | null
    : null
  const stateRevision = causalNovelDAO.getState(workId)?.revision
  if (
    !extracted
    || extracted.bodyHash !== contentVersion.bodyHash
    || extracted.state.revision !== (stateRevision ?? -2) + 1
  ) {
    throw new Error('PRECOMMIT_ARTIFACT_STALE：因果结果与当前正文或权威状态不一致')
  }

  onProgress?.('正在原子提交正文哈希、叙事记忆、资源后果与权威状态修订')
  const committedMemory = getDatabase().transaction(() => {
    const memory = commitPreparedNarrativeMemory(workId, chapterId, preparedMemory, {
      markChapterCompleted: false,
      validate: () => novelMemoryCommitBlockers(workId, chapterId)
    })
    causalNovelDAO.commitDecision({
      workId,
      chapterId,
      expectedStateRevision: extracted.state.revision - 1,
      nextState: extracted.state,
      outcome: extracted.outcome,
      expectedBodyHash: extracted.bodyHash
    })
    volumeChapterDAO.updateChapter(chapterId, { status: 'completed' })
    return memory
  })()

  return {
    revision: extracted.state.revision,
    summary: extracted.outcome.summary,
    timelineEvents: committedMemory.timelineEvents,
    planted: committedMemory.planted,
    snapshots: committedMemory.snapshots,
    foreshadowingResolved: committedMemory.foreshadowingResolved
  }
}
