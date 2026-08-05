import { createHash } from 'node:crypto'
import { causalNovelDAO, volumeChapterDAO } from '../../db'
import { getDatabase } from '../../db/connection'
import { clearChapterNarrativeMemory } from '../memory-cleanup'
import { persistChapterExecutionContract } from '../chapter-execution-context'
import { countWords } from '../../../shared/body-word-target'
import { normalizeModelBodyOutput, stripDeterministicAiPatterns } from '../../../shared/normalize-body-text'
import { CAUSAL_OUTCOME_PROTOCOL_VERSION } from '../../../shared/causal-outcome-protocol'
import type { AtomicOutcomeClaim } from '../../../shared/causal-outcome-atomic'
import { repairNovelChapterByEvidencePatches } from './novel-chapter-evidence-repair'

export interface CausalBodyContractRepairResult {
  repaired: boolean
  reason: string
  contentVersionId?: number
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function repairBlockers(claims: AtomicOutcomeClaim[]): string[] {
  return claims.map((claim, index) => (
    `因果状态合同 ${index + 1}：正文必须用可定位的动作、选择或结果直接兑现“${claim.claim}”；`
    + '不得用旁白宣布、未来计划或含糊暗示代替已经发生的事实'
  ))
}

export async function repairCausalBodyContract(input: {
  workId: number
  chapterId: number
  contentVersionId: number
  bodyHash: string
  wordTarget?: number
  wordCountTolerance?: number
  signal?: AbortSignal
  onProgress?: (message: string) => void
}): Promise<CausalBodyContractRepairResult> {
  const source = causalNovelDAO.getCheckpoint(
    input.chapterId,
    input.contentVersionId,
    'outcome_body_contract',
    CAUSAL_OUTCOME_PROTOCOL_VERSION
  )
  const sourcePayload = source?.payload as {
    stateRevision?: number
    claims?: AtomicOutcomeClaim[]
  } | null
  const claims = sourcePayload?.claims
  if (source?.status !== 'failed' || !Array.isArray(claims) || claims.length === 0) {
    return { repaired: false, reason: '缺少可重放的正文合同失败制品' }
  }

  const attempt = causalNovelDAO.getCheckpoint(
    input.chapterId,
    input.contentVersionId,
    'body_contract_repair',
    CAUSAL_OUTCOME_PROTOCOL_VERSION
  )
  if (attempt) {
    return {
      repaired: false,
      reason: attempt.status === 'completed'
        ? '当前正文版本已经完成过合同修复'
        : '当前正文版本的单次合同修复已经失败'
    }
  }

  const chapter = volumeChapterDAO.getChapter(input.chapterId)
  if (!chapter?.content?.trim() || contentHash(chapter.content) !== input.bodyHash) {
    return { repaired: false, reason: '正文版本已经变化，拒绝在过期正文上修复' }
  }
  const contract = persistChapterExecutionContract(
    input.workId,
    input.chapterId,
    input.wordTarget,
    input.wordCountTolerance
  )
  if (!contract) {
    return { repaired: false, reason: '无法编译冻结章节执行合同' }
  }

  input.onProgress?.(
    `正文未兑现 ${claims.length} 个必要因果状态变更，正在对当前正文版本执行一次定向修复`
  )
  let repaired: Awaited<ReturnType<typeof repairNovelChapterByEvidencePatches>>
  try {
    repaired = await repairNovelChapterByEvidencePatches({
      workId: input.workId,
      chapterId: input.chapterId,
      content: chapter.content,
      kind: 'causal_body_contract',
      issues: repairBlockers(claims),
      contract,
      signal: input.signal
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    causalNovelDAO.saveCheckpoint({
      workId: input.workId,
      chapterId: input.chapterId,
      contentVersionId: input.contentVersionId,
      bodyHash: input.bodyHash,
      protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
      stage: 'body_contract_repair',
      status: 'failed',
      payload: { stateRevision: sourcePayload?.stateRevision, claimIds: claims.map(item => item.id) },
      errorMessage: reason
    })
    return { repaired: false, reason }
  }

  const normalized = repaired.success
    ? stripDeterministicAiPatterns(
        normalizeModelBodyOutput(repaired.content.trim(), 'body_generation')
      )
    : ''
  const repairedWordCount = countWords(normalized)
  const invalidReason = !repaired.success || !normalized
    ? repaired.error || '正文合同定向修复没有返回完整正文'
    : repairedWordCount < contract.wordMin || repairedWordCount > contract.wordMax
      ? `修复正文 ${repairedWordCount} 字，超出冻结合同 ${contract.wordMin}-${contract.wordMax} 字`
      : contentHash(normalized) === input.bodyHash
        ? '修复正文与原正文完全相同'
        : ''
  if (invalidReason) {
    causalNovelDAO.saveCheckpoint({
      workId: input.workId,
      chapterId: input.chapterId,
      contentVersionId: input.contentVersionId,
      bodyHash: input.bodyHash,
      protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
      stage: 'body_contract_repair',
      status: 'failed',
      payload: { stateRevision: sourcePayload?.stateRevision, claimIds: claims.map(item => item.id) },
      errorMessage: invalidReason
    })
    return { repaired: false, reason: invalidReason }
  }

  let nextContentVersionId: number | undefined
  getDatabase().transaction(() => {
    clearChapterNarrativeMemory(input.workId, input.chapterId)
    const updated = volumeChapterDAO.updateChapterWithVersion(input.chapterId, {
      content: normalized,
      word_count: repairedWordCount,
      status: 'draft',
      emotion_assessment_json: null,
      quality_assessment_json: null
    })
    if (!updated) throw new Error('正文合同修复结果写入失败')
    causalNovelDAO.saveCheckpoint({
      workId: input.workId,
      chapterId: input.chapterId,
      contentVersionId: input.contentVersionId,
      bodyHash: input.bodyHash,
      protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
      stage: 'body_contract_repair',
      status: 'completed',
      payload: {
        stateRevision: sourcePayload?.stateRevision,
        claimIds: claims.map(item => item.id),
        repairedBodyHash: contentHash(normalized)
      }
    })
    const nextVersion = causalNovelDAO.ensureCurrentContentVersion(
      input.workId,
      input.chapterId,
      'body_contract_repair',
      'structural'
    )
    causalNovelDAO.saveCheckpoint({
      workId: input.workId,
      chapterId: input.chapterId,
      contentVersionId: nextVersion.id,
      bodyHash: nextVersion.bodyHash,
      protocolVersion: CAUSAL_OUTCOME_PROTOCOL_VERSION,
      stage: 'body_contract_repair',
      status: 'completed',
      payload: {
        stateRevision: sourcePayload?.stateRevision,
        originContentVersionId: input.contentVersionId,
        claimIds: claims.map(item => item.id),
        inheritedRepairGuard: true
      }
    })
    nextContentVersionId = nextVersion.id
  })()
  if (nextContentVersionId == null) {
    throw new Error('正文合同修复没有建立新正文版本')
  }
  return {
    repaired: true,
    reason: '已生成新正文版本并保留原版本，下一轮将重新执行全部门禁',
    contentVersionId: nextContentVersionId
  }
}
