import { createHash } from 'node:crypto'
import { volumeChapterDAO } from '../../db'
import {
  readNovelGoalState,
  updateNovelGoalState
} from './novel-outline-pipeline'
import { compileChapterExecutionContract } from '../chapter-execution-context'

export const CHAPTER_TRANSACTION_MAX_PATCHES = 1
// v3 reserves only after all local candidate preflights pass, in the same DB
// transaction that writes the chapter version.
export const CHAPTER_TRANSACTION_PROTOCOL_VERSION = 3
export type ChapterTransactionLane = 'length_normalization' | 'semantic_repair' | 'structural_replan'

export type ChapterEditorialDebtKind = 'quality' | 'emotion' | 'style'

export interface ChapterEditorialDebt {
  chapterId: number
  chapterTitle: string
  contentHash: string
  kind: ChapterEditorialDebtKind
  score?: number
  issues: string[]
  recordedAt: string
}

export interface ChapterTransactionBudget {
  chapterId: number
  contractHash: string
  baseContentHash: string
  patchesUsed: number
  maxPatches: number
  lastFailureKind: string
  lane: ChapterTransactionLane
  updatedAt: string
}

export function chapterTransactionBudgetKey(input: {
  workId: number
  chapterId: number
  lane: ChapterTransactionLane
}): string {
  const contract = compileChapterExecutionContract(input.workId, input.chapterId)
  if (!contract) throw new Error(`章节 ${input.chapterId} 缺少可绑定修复事务的执行合同`)
  const contractHash = createHash('sha256').update(JSON.stringify(contract)).digest('hex')
  return `${input.chapterId}:v${CHAPTER_TRANSACTION_PROTOCOL_VERSION}:${contractHash}:${input.lane}`
}

export function readChapterTransactionBudget(input: {
  workId: number
  chapterId: number
  lane: ChapterTransactionLane
}): ChapterTransactionBudget | undefined {
  const state = readNovelGoalState(input.workId)
  return state.chapterTransactionBudgets?.[chapterTransactionBudgetKey(input)]
}

export class ChapterTransactionPatchExhaustedError extends Error {
  readonly code = 'CHAPTER_TRANSACTION_PATCH_EXHAUSTED'

  constructor(chapterId: number, lane: ChapterTransactionLane) {
    const label = lane === 'length_normalization'
      ? '字数归一化'
      : lane === 'structural_replan'
        ? '结构重规划'
        : '语义修复'
    super(`章节 ${chapterId} 的${label}已使用唯一一次补丁，禁止再次进入修复循环`)
    this.name = 'ChapterTransactionPatchExhaustedError'
  }
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function recordChapterEditorialDebt(input: {
  workId: number
  chapterId: number
  kind: ChapterEditorialDebtKind
  score?: number
  issues: string[]
}): void {
  const chapter = volumeChapterDAO.getChapter(input.chapterId)
  const content = chapter?.content?.trim() ?? ''
  if (!chapter || !content) return
  const issues = [...new Set(input.issues.map(item => item.trim()).filter(Boolean))]
  const debt: ChapterEditorialDebt = {
    chapterId: input.chapterId,
    chapterTitle: chapter.title,
    contentHash: contentHash(content),
    kind: input.kind,
    score: input.score,
    issues,
    recordedAt: new Date().toISOString()
  }
  const state = readNovelGoalState(input.workId)
  const previous = state.chapterEditorialDebts ?? []
  const retained = previous.filter(item => !(
    item.chapterId === debt.chapterId
    && item.contentHash === debt.contentHash
    && item.kind === debt.kind
  ))
  updateNovelGoalState(input.workId, {
    chapterEditorialDebts: [...retained, debt]
  })
}

export function clearChapterEditorialDebt(input: {
  workId: number
  chapterId: number
  kinds: ChapterEditorialDebtKind[]
}): void {
  const chapter = volumeChapterDAO.getChapter(input.chapterId)
  const bodyHash = contentHash(chapter?.content?.trim() ?? '')
  const kinds = new Set(input.kinds)
  const state = readNovelGoalState(input.workId)
  const previous = state.chapterEditorialDebts ?? []
  const retained = previous.filter(item => !(
    item.chapterId === input.chapterId
    && item.contentHash === bodyHash
    && kinds.has(item.kind)
  ))
  if (retained.length !== previous.length) {
    updateNovelGoalState(input.workId, { chapterEditorialDebts: retained })
  }
}

/**
 * 章节修复预算绑定冻结执行合同，而不是候选正文或验收 episode。
 * 同一合同下正文哈希变化不会重置预算；结构重规划产生新合同后自然进入新事务。
 */
export function reserveChapterTransactionPatch(input: {
  workId: number
  chapterId: number
  failureKind: string
  lane: ChapterTransactionLane
}): ChapterTransactionBudget {
  const chapter = volumeChapterDAO.getChapter(input.chapterId)
  const body = chapter?.content?.trim() ?? ''
  if (!chapter || !body) {
    throw new Error(`章节 ${input.chapterId} 没有可执行定点补丁的正文`)
  }
  const state = readNovelGoalState(input.workId)
  const key = chapterTransactionBudgetKey(input)
  const contractHash = key.split(':')[2]
  const previous = state.chapterTransactionBudgets?.[key]
  if ((previous?.patchesUsed ?? 0) >= CHAPTER_TRANSACTION_MAX_PATCHES) {
    throw new ChapterTransactionPatchExhaustedError(input.chapterId, input.lane)
  }
  const budget: ChapterTransactionBudget = {
    chapterId: input.chapterId,
    contractHash,
    baseContentHash: previous?.baseContentHash ?? contentHash(body),
    patchesUsed: (previous?.patchesUsed ?? 0) + 1,
    maxPatches: CHAPTER_TRANSACTION_MAX_PATCHES,
    lastFailureKind: input.failureKind,
    lane: input.lane,
    updatedAt: new Date().toISOString()
  }
  updateNovelGoalState(input.workId, {
    chapterTransactionBudgets: {
      ...(state.chapterTransactionBudgets ?? {}),
      [key]: budget
    }
  })
  return budget
}
