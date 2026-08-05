import { createHash } from 'node:crypto'
import type { QualityAiPatch } from '../../../shared/quality-ai-score'

export const CHAPTER_ACCEPTANCE_PROTOCOL_VERSION = 3
export const CHAPTER_ACCEPTANCE_MAX_ASSESSMENTS = 1
export const CHAPTER_QUALITY_MAX_REPAIRS = 0
export const CHAPTER_EMOTION_MAX_REPAIRS = 0
export const CHAPTER_EXECUTION_CONTRACT_MAX_REPAIRS = 1
export const CHAPTER_ACCEPTANCE_MAX_REPAIRS =
  CHAPTER_QUALITY_MAX_REPAIRS
  + CHAPTER_EMOTION_MAX_REPAIRS
  + CHAPTER_EXECUTION_CONTRACT_MAX_REPAIRS

export interface AcceptanceProgressPoint {
  contentHash: string
  blockingFailures: string[]
  scoreTotal: number
}

export interface AcceptanceStall {
  code: 'REPEATED_BODY' | 'TWO_CYCLE' | 'PLATEAU'
  message: string
}

export interface ExactPatchResult {
  success: boolean
  content: string
  applied: QualityAiPatch[]
  error?: string
}

export function novelChapterContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function novelChapterAcceptanceKey(input: {
  workId: number
  chapterId: number
  baseContentHash: string
  contractHash: string
  protocolVersion?: number
}): string {
  return createHash('sha256').update(JSON.stringify({
    workId: input.workId,
    chapterId: input.chapterId,
    baseContentHash: input.baseContentHash,
    contractHash: input.contractHash,
    protocolVersion: input.protocolVersion ?? CHAPTER_ACCEPTANCE_PROTOCOL_VERSION
  })).digest('hex')
}

function countOccurrences(content: string, find: string): number {
  if (!find) return 0
  let count = 0
  let offset = 0
  while (offset <= content.length - find.length) {
    const index = content.indexOf(find, offset)
    if (index < 0) break
    count++
    offset = index + find.length
  }
  return count
}

/**
 * 质量修复只能应用评估报告中绑定到当前正文的精确片段。
 * 任一补丁无法唯一定位时整批拒绝，禁止模糊匹配或全文替换。
 */
export function applyExactQualityPatches(
  source: string,
  patches: QualityAiPatch[]
): ExactPatchResult {
  if (!source.trim()) {
    return { success: false, content: source, applied: [], error: '待修正文为空' }
  }
  const bounded = patches
    .filter(patch => patch.find.trim())
    .slice(0, 12)
  if (bounded.length === 0) {
    return { success: false, content: source, applied: [], error: '诊断报告没有可执行的原文证据补丁' }
  }

  let content = source
  const applied: QualityAiPatch[] = []
  for (const patch of bounded) {
    const occurrences = countOccurrences(content, patch.find)
    if (occurrences !== 1) {
      return {
        success: false,
        content: source,
        applied: [],
        error: occurrences === 0
          ? `补丁原文无法定位：${patch.find.slice(0, 48)}`
          : `补丁原文不唯一：${patch.find.slice(0, 48)}`
      }
    }
    content = content.replace(patch.find, patch.replace)
    applied.push(patch)
  }

  if (!content.trim() || content === source) {
    return { success: false, content: source, applied: [], error: '证据补丁没有产生有效正文变更' }
  }
  return { success: true, content, applied }
}

function noImprovement(
  previous: AcceptanceProgressPoint,
  current: AcceptanceProgressPoint
): boolean {
  return current.blockingFailures.length >= previous.blockingFailures.length
    && current.scoreTotal <= previous.scoreTotal + 1
}

export function detectChapterAcceptanceStall(
  history: AcceptanceProgressPoint[]
): AcceptanceStall | null {
  if (history.length < 2) return null
  const current = history[history.length - 1]
  const priorHashes = history.slice(0, -1).map(point => point.contentHash)
  if (priorHashes.includes(current.contentHash)) {
    const twoBack = history.at(-3)
    if (twoBack?.contentHash === current.contentHash) {
      return { code: 'TWO_CYCLE', message: '正文候选出现 A→B→A 二周期振荡' }
    }
    return { code: 'REPEATED_BODY', message: '正文候选与已评估版本重复' }
  }
  if (
    history.length >= 3
    && noImprovement(history[history.length - 3], history[history.length - 2])
    && noImprovement(history[history.length - 2], current)
  ) {
    return { code: 'PLATEAU', message: '连续两次修订没有减少阻塞项或提高有效质量' }
  }
  return null
}
