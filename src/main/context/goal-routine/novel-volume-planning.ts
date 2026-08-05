import { createHash } from 'node:crypto'
import {
  goalRoutineDAO,
  coreSettingDAO,
  novelOutlineDAO,
  resourceLedgerDAO,
  volumeChapterDAO,
  type ChapterResourceBudgetInput,
  type NovelOutlineBatchItem,
  type ChapterPatternFingerprintRow,
  type NovelChapterGateType
} from '../../db'
import { modelService } from '../../model'
import { buildWorkContext } from '../work-context'
import { extractJsonText } from '../parse-json-extract'
import { formatResourceConstraintsForPrompt, normalizeChapterResourceBudgets } from '../resource-ledger'
import { outlineConstraintsForWordTarget } from '../../../shared/outline-constraints'
import { DEFAULT_WORDS_PER_CHAPTER } from '../../../shared/writing-plan-presets'
import { loadWritingPlan } from '../writing-plan'
import { withGoalLoopModelOptions } from './story-goal-model'
import type { GoalCheckResult } from './story-goal-checker'
import { goldenOutlineContract } from '../../../shared/golden-opening'
import { retentionEvaluationRules, retentionPlanningRules } from './reader-retention'
import {
  formatNovelScaleContract,
  novelScaleFingerprint,
  validatePleasureEngineScale
} from './novel-scale-contract'
import { detectChapterPatternIssues } from './novel-systemic-gate'
import { requestStructuredModelOutput } from './structured-model-output'
import {
  readNovelPersistentState,
  updateNovelPersistentState
} from './novel-authority-state'
import type { UnifiedNovelRepairContext } from './unified-novel-repair'
import type { ChapterSkeletonAuthorityLedger } from './novel-chapter-skeleton-policy'

export const OUTLINE_BATCH_SIZE = 1
export const GOLDEN_OPENING_BATCH_SIZE = 3
export const MAX_GATE_REPAIR_ROUNDS = 4
// These values are retained for persisted-state compatibility. They are not
// termination conditions: a volume gate remains active until all evidence
// issues are repaired or the user explicitly cancels the run.
export const MAX_VOLUME_CHAPTER_GATE_REPAIR_ROUNDS = Number.MAX_SAFE_INTEGER
const TARGET_CHAPTERS_PER_VOLUME = 42
const MAX_CHAPTERS_PER_VOLUME = 50
export const VOLUME_CONTRACT_MAX_TOKENS = 3200
export const VOLUME_CONTEXT_CHAR_LIMIT = 8000
export const NOVEL_SINGLE_CHAPTER_MAX_TOKENS = 6000
export const NOVEL_VOLUME_GATE_MAX_WINDOW_SIZE = 8
export const NOVEL_VOLUME_GATE_MAX_REPAIR_CLUSTER = 2
export const NOVEL_VOLUME_GATE_MAX_REPAIR_TARGETS_PER_ISSUE = 4
export const NOVEL_VOLUME_GATE_MAX_REPAIRED_CHAPTERS = 6
// Kept as an effectively unbounded scheduling budget. The six-chapter wave
// size still bounds each individual model transaction.
export const NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER = Number.MAX_SAFE_INTEGER
export const NOVEL_VOLUME_GATE_ASSESS_MAX_TOKENS = 2400
// v5：所有分卷修复边界统一转入质量债务，不再终止整本生成。
// 升级会让旧 stalled 检查点在续跑时只失效诊断缓存，不删除章节或版本。
export const NOVEL_VOLUME_REPAIR_PROTOCOL_VERSION = 7

export const NOVEL_VOLUME_GATE_HARD_ISSUE_CODES = new Set([
  'STATE_CONTINUITY_BREAK',
  'RESOURCE_CONTINUITY_BREAK',
  'CAST_CONTINUITY_BREAK',
  'GEOGRAPHY_CONTINUITY_BREAK',
  'GEOGRAPHY_BOUNDARY_VIOLATION',
  'FORBIDDEN_BOUNDARY_VIOLATION',
  'SETUP_PAYOFF_MISMATCH'
])

export const NOVEL_VOLUME_GATE_REPAIR_FIELDS = [
  'outline',
  'next_hook',
  'dramatic_contract.scene_promise',
  'dramatic_contract.protagonist_want',
  'dramatic_contract.obstacle',
  'dramatic_contract.stakes',
  'dramatic_contract.info_gap',
  'dramatic_contract.pressure_escalation',
  'dramatic_contract.turn',
  'dramatic_contract.irreversible_change',
  'dramatic_contract.payoff_or_debt',
  'dramatic_contract.next_question',
  'tension_plan.payoff_type'
] as const

export const NOVEL_VOLUME_GATE_ASSESSMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'issues', 'summary'],
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    issues: {
      type: 'array', maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'code', 'problem', 'repairCandidates', 'evidence', 'requiredOutcome'],
        properties: {
          severity: { type: 'string', enum: ['hard', 'advisory'] },
          code: { type: 'string', minLength: 1, maxLength: 64 },
          problem: { type: 'string', minLength: 1, maxLength: 480 },
          repairCandidates: {
            type: 'array', minItems: 1, maxItems: NOVEL_VOLUME_GATE_MAX_WINDOW_SIZE,
            items: { type: 'integer', minimum: 1 }
          },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['chapterNumber', 'quote'],
              properties: {
                chapterNumber: { type: 'integer', minimum: 1 },
                quote: { type: 'string', minLength: 4, maxLength: 80 }
              }
            }
          },
          requiredOutcome: { type: 'string', minLength: 1, maxLength: 480 }
        }
      }
    },
    summary: { type: 'string', maxLength: 360 }
  }
}

export const NOVEL_VOLUME_GATE_REPAIR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['patches'],
  properties: {
    patches: {
      type: 'array',
      minItems: 1,
      maxItems: NOVEL_VOLUME_GATE_MAX_REPAIR_CLUSTER,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chapterNumber', 'operations'],
        properties: {
          chapterNumber: { type: 'integer', minimum: 1 },
          operations: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['field', 'oldText', 'newText'],
              properties: {
                field: { type: 'string', enum: [...NOVEL_VOLUME_GATE_REPAIR_FIELDS] },
                oldText: { type: 'string', minLength: 4, maxLength: 1200 },
                newText: { type: 'string', minLength: 1, maxLength: 1200 }
              }
            }
          }
        }
      }
    }
  }
}

const NOVEL_VOLUME_CONTRACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['volume'],
  properties: {
    volume: {
      type: 'object',
      additionalProperties: false,
      required: [
        'name', 'description', 'objective', 'midpoint', 'climax',
        'irreversibleCost', 'nextDebt', 'mustResolve', 'mayCarryForward',
        'forbiddenNewThreadsAfterChapter', 'protagonistEndState', 'antagonistEndState'
      ],
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        objective: { type: 'string' },
        midpoint: { type: 'string' },
        climax: { type: 'string' },
        irreversibleCost: { type: 'string' },
        nextDebt: { type: 'string' },
        mustResolve: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
        mayCarryForward: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
        forbiddenNewThreadsAfterChapter: { type: 'integer' },
        protagonistEndState: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
        antagonistEndState: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } }
      }
    }
  }
}

/**
 * 分卷门禁修订只允许返回创意字段补丁。
 *
 * 整份合同重写会把已经通过门禁的内容再次复制到输出中，导致模型在
 * 固定 completion budget 下以 finishReason=length 截断。补丁协议把模型
 * 的输出边界收敛到“问题字段”，章节范围和未命中的字段由本地保留。
 */
export const NOVEL_VOLUME_REVISE_PATCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['patches'],
  properties: {
    patches: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['volumeIndex', 'fields'],
        properties: {
          volumeIndex: { type: 'integer', minimum: 1 },
          fields: {
            type: 'object',
            additionalProperties: false,
            maxProperties: 6,
            properties: {
              name: { type: 'string', maxLength: 120 },
              description: { type: 'string', maxLength: 180 },
              objective: { type: 'string', maxLength: 120 },
              midpoint: { type: 'string', maxLength: 120 },
              climax: { type: 'string', maxLength: 120 },
              irreversibleCost: { type: 'string', maxLength: 100 },
              nextDebt: { type: 'string', maxLength: 100 },
              mustResolve: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 80 } },
              mayCarryForward: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 80 } },
              forbiddenNewThreadsAfterChapter: { type: 'integer' },
              protagonistEndState: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 80 } },
              antagonistEndState: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string', maxLength: 80 } }
            }
          }
        }
      }
    }
  }
}

type NovelVolumeContractPatchFields = Partial<Omit<NovelVolumeContract, 'startChapter' | 'endChapter'>>

function applyVolumeRevisionPatches(
  raw: unknown,
  plan: NovelVolumeContract[],
  plannedRanges: NovelVolumeRange[],
  targetChapters: number
): NovelVolumeContract[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new NovelPipelineError('CONTRACT_INVALID', '分卷修订必须返回 patches 对象')
  }
  const patches = (raw as { patches?: unknown }).patches
  if (!Array.isArray(patches) || patches.length === 0) {
    throw new NovelPipelineError('CONTRACT_INVALID', '分卷修订至少需要一个字段补丁')
  }
  const seen = new Set<number>()
  const nextPlan = plan.map(volume => ({ ...volume }))
  for (const item of patches) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new NovelPipelineError('CONTRACT_INVALID', '分卷修订补丁格式无效')
    }
    const patch = item as { volumeIndex?: unknown; fields?: unknown }
    if (!Number.isInteger(patch.volumeIndex) || Number(patch.volumeIndex) < 1 || Number(patch.volumeIndex) > plan.length) {
      throw new NovelPipelineError('CONTRACT_INVALID', `分卷修订索引无效：${String(patch.volumeIndex)}`)
    }
    const volumeIndex = Number(patch.volumeIndex)
    if (seen.has(volumeIndex)) throw new NovelPipelineError('CONTRACT_INVALID', `分卷 ${volumeIndex} 重复修订`)
    seen.add(volumeIndex)
    if (!patch.fields || typeof patch.fields !== 'object' || Array.isArray(patch.fields)) {
      throw new NovelPipelineError('CONTRACT_INVALID', `分卷 ${volumeIndex} 缺少修订字段`)
    }
    const fields = patch.fields as NovelVolumeContractPatchFields
    if (Object.keys(fields).length === 0) throw new NovelPipelineError('CONTRACT_INVALID', `分卷 ${volumeIndex} 修订字段为空`)
    nextPlan[volumeIndex - 1] = {
      ...nextPlan[volumeIndex - 1],
      ...fields,
      startChapter: plannedRanges[volumeIndex - 1].startChapter,
      endChapter: plannedRanges[volumeIndex - 1].endChapter
    }
  }
  return validateVolumePlan(nextPlan, targetChapters)
}

export type VolumeGenerationFailureKind = 'none' | 'timeout' | 'truncated' | 'invalid'

export function classifyVolumeGenerationFailure(message?: string): VolumeGenerationFailureKind {
  if (!message) return 'none'
  if (/timeout|timed out|超时/i.test(message)) return 'timeout'
  if (/VOLUME_OUTPUT_TRUNCATED|finishReason=length|Unterminated string|Unexpected end of JSON|JSON.*截断/i.test(message)) {
    return 'truncated'
  }
  return 'invalid'
}

export function volumeGenerationProfile(failureMessage?: string): {
  maxTokens: number
  contextChars: number
  compact: boolean
  failureKind: VolumeGenerationFailureKind
} {
  const failureKind = classifyVolumeGenerationFailure(failureMessage)
  if (failureKind === 'timeout') {
    return { maxTokens: VOLUME_CONTRACT_MAX_TOKENS, contextChars: 3500, compact: true, failureKind }
  }
  if (failureKind === 'truncated') {
    return { maxTokens: 5000, contextChars: 6000, compact: false, failureKind }
  }
  if (failureKind === 'invalid') {
    return { maxTokens: 4000, contextChars: 6000, compact: false, failureKind }
  }
  return {
    maxTokens: VOLUME_CONTRACT_MAX_TOKENS,
    contextChars: VOLUME_CONTEXT_CHAR_LIMIT,
    compact: false,
    failureKind
  }
}

export interface NovelVolumeContract {
  name: string
  description: string
  startChapter: number
  endChapter: number
  objective: string
  midpoint: string
  climax: string
  irreversibleCost: string
  nextDebt: string
  mustResolve: string[]
  mayCarryForward: string[]
  forbiddenNewThreadsAfterChapter: number
  protagonistEndState: string[]
  antagonistEndState: string[]
}

export interface NovelChapterSkeleton {
  chapterNumber: number
  title: string
  outline: string
  arcPhase: string
  payoffRole: string
  tensionLevel: number
  payoffType: 'debt' | 'partial' | 'major' | 'aftertaste'
  foreshadowTarget: string | null
  nextHook: string
  characters: string[]
  authorityLedger: ChapterSkeletonAuthorityLedger
}

export interface NovelOutlineProgressState {
  version: 2
  targetChapters: number
  volumePlan: NovelVolumeContract[]
}

export interface NovelVolumeRange {
  startChapter: number
  endChapter: number
}

export interface NovelVolumeGateIssue {
  source: 'model' | 'deterministic'
  severity?: 'hard' | 'advisory'
  code: string
  problem: string
  /** 只允许被修复器改写的章节；证据章节可以更多，也可以只读。 */
  repairChapterNumbers: number[]
  evidence: Array<{ chapterNumber: number; quote: string }>
  requiredFix: string
}

export interface NovelVolumeGateAssessment {
  key: string
  startChapter: number
  endChapter: number
  passed: boolean
  score: number
  summary: string
  issues: NovelVolumeGateIssue[]
  inputFingerprint?: string
}

export interface NovelVolumeGateRepairControl {
  changedChapterNumbers: number[]
  rewriteCounts: Record<string, number>
  previousIssueCount?: number
  previousIssueFingerprint?: string
  waveChapterNumbers?: number[]
  completedWaveCount?: number
  lastRoundVersions: Array<{ chapterId: number; versionId: number }>
}

export interface NovelVolumeGateCheckpoint {
  version: 2
  repairProtocolVersion?: number
  volume: string
  round: number
  snapshotFingerprint: string
  assessments: NovelVolumeGateAssessment[]
  aggregate?: NovelVolumeGateAssessment
  repairControl?: NovelVolumeGateRepairControl
  stalled?: { reason: string; createTime: string }
  repair?: {
    clusters: Array<{ chapterNumbers: number[]; issues: NovelVolumeGateIssue[] }>
    nextClusterIndex: number
  }
}

export interface NovelGoalPersistentState {
  workflowDefinitionVersion?: number
  chapterSkeletonProtocolVersion?: number
  chapterSkeletonAuthorityLedger?: ChapterSkeletonAuthorityLedger
  autonomousEpoch?: number
  causalPlanningRecovery?: {
    chapterId: number
    attempts: number
    contractHash: string
    sourceStateRevision: number
    recoveredStateRevision?: number
    strategy: 'state_rebase' | 'chapter_contract_replan'
    evidenceFingerprint: string
    at: string
  }
  autonomousChapterEscalations?: Record<string, {
    level: number
    attempts: number
    gateType: NovelChapterGateType
    evidenceFingerprint: string
  }>
  autonomousTerminal?: {
    phase: string
    code: string
    message: string
    at: string
  }
  repairCommitPending?: {
    context: UnifiedNovelRepairContext
    candidateBodyHash: string
    acceptedAt: string
  }
  lastCheck?: GoalCheckResult
  novelOutline?: NovelOutlineProgressState
  volumePlanChecked?: boolean
  volumeQualityReport?: string
  checkedChapterVolumes?: string[]
  pendingChapterVolumeGate?: string
  chapterVolumeGateCheckpoint?: NovelVolumeGateCheckpoint
  volumeGateDeferredIssues?: Array<{
    volume: string
    score: number
    rounds: number
    reason: string
    deferredAt: string
    issues: Array<Pick<NovelVolumeGateIssue, 'source' | 'code' | 'problem' | 'repairChapterNumbers' | 'requiredFix'>>
  }>
  chapterVolumeGateResults?: Array<{
    volume: string
    status: 'passed' | 'deferred'
    score: number
    rounds: number
    completedAt: string
    snapshotFingerprint: string
    reason?: string
    issues: Array<Pick<NovelVolumeGateIssue, 'source' | 'code' | 'problem' | 'repairChapterNumbers' | 'requiredFix'>>
  }>
  checkedBodyVolumes?: string[]
  pleasureVolumeFingerprint?: string
  pendingChapterSkeletonBatch?: {
    protocolVersion: number
    authorityLedger: ChapterSkeletonAuthorityLedger
    volumeName: string
    volumeFingerprint: string
    start: number
    end: number
    skeletons: NovelChapterSkeleton[]
    items?: NovelOutlineBatchItem[]
  }
  repairPlan?: unknown
  overallRepairRounds?: number
  repairStall?: { signature: string; issueFingerprint?: string; blockerCount?: number; count: number }
  titleHookCandidates?: Array<{ title: string; hook: string; summary?: string }>
  titleHookPreferredIndex?: number
  titleHookApplied?: boolean
  finalAudit?: {
    passed: boolean
    auditedAt: string
    reasons: string[]
    outcome?: 'released' | 'complete_with_debt'
  }
  chapterExecutionProtocolVersion?: number
  chapterExecutionDeferredIssues?: Array<{
    chapterId: number
    chapterTitle: string
    sourceVersionNumber: number
    blockers: string[]
    deferredAt: string
  }>
  chapterAcceptanceDeferredIssues?: Array<{
    chapterId: number
    chapterTitle: string
    qualityScore: number
    emotionScore?: number
    failedMetrics: string[]
    deferredAt: string
  }>
  chapterEditorialDebts?: Array<{
    chapterId: number
    chapterTitle: string
    contentHash: string
    kind: 'quality' | 'emotion' | 'style'
    score?: number
    issues: string[]
    recordedAt: string
  }>
  chapterTransactionBudgets?: Record<string, {
    chapterId: number
    contractHash: string
    baseContentHash: string
    patchesUsed: number
    maxPatches: number
    lastFailureKind: string
    lane: 'length_normalization' | 'semantic_repair' | 'structural_replan'
    updatedAt: string
  }>
  failure?: {
    phase: string
    step?: string
    signature: string
    count: number
    message: string
  }
}

export interface NovelOutlineBatchResult {
  created: number
  reused: number
  remaining: number
  complete: boolean
  range?: { start: number; end: number }
  volumeGate?: { volume: string; score: number; rounds: number; deferredIssues?: number }
  volumeReadyForDraft?: string
}

export type NovelVolumeWorkflowCheckpoint =
  | {
      kind: 'generate_outline' | 'outline_gate' | 'draft_body' | 'body_gate'
      volume: NovelVolumeContract
      outlinedChapters: number
      expectedChapters: number
      nextChapter?: number
    }
  | { kind: 'complete' }

/**
 * 从持久化作品数据重建按卷流水线的唯一合法交接点。
 *
 * 运行状态中的 pendingChapterVolumeGate 只是断点加速信息，不能决定正确性；
 * 即使用户误点“启动新一轮”或应用在门禁中退出，也必须先处理最早一个未冻结卷，
 * 不能越过它生成后续卷或正文。
 */
export function resolveNovelVolumeWorkflowCheckpoint(
  volumePlan: NovelVolumeContract[],
  chapters: Array<{ volume_name: string; content?: string | null }>,
  checkedChapterVolumes: string[] = [],
  checkedBodyVolumes: string[] = []
): NovelVolumeWorkflowCheckpoint {
  const plannedNames = new Set(volumePlan.map(volume => volume.name))
  const unknownChapter = chapters.find(chapter => !plannedNames.has(chapter.volume_name))
  if (unknownChapter) {
    throw new NovelPipelineError(
      'CONTRACT_INVALID',
      `章节所属分卷「${unknownChapter.volume_name}」不在当前分卷合同中`
    )
  }

  const checkedOutlines = new Set(checkedChapterVolumes)
  const checkedBodies = new Set(checkedBodyVolumes)
  for (let index = 0; index < volumePlan.length; index++) {
    const volume = volumePlan[index]
    const expectedChapters = volume.endChapter - volume.startChapter + 1
    const volumeChapters = chapters.filter(chapter => chapter.volume_name === volume.name)
    const outlinedChapters = volumeChapters.length
    if (outlinedChapters > expectedChapters) {
      throw new NovelPipelineError(
        'CONTRACT_INVALID',
        `分卷「${volume.name}」已有 ${outlinedChapters} 章，超过合同上限 ${expectedChapters} 章`
      )
    }

    if (outlinedChapters < expectedChapters) {
      const laterNames = new Set(volumePlan.slice(index + 1).map(item => item.name))
      const laterChapter = chapters.find(chapter => laterNames.has(chapter.volume_name))
      if (laterChapter) {
        throw new NovelPipelineError(
          'CONTRACT_INVALID',
          `分卷「${volume.name}」章节大纲尚未完整，不能存在后续分卷「${laterChapter.volume_name}」的章节`
        )
      }
      if (checkedOutlines.has(volume.name) || checkedBodies.has(volume.name)) {
        throw new NovelPipelineError(
          'CONTRACT_INVALID',
          `分卷「${volume.name}」章节数量不完整，但仍带有已冻结标记`
        )
      }
      return {
        kind: 'generate_outline',
        volume,
        outlinedChapters,
        expectedChapters,
        nextChapter: volume.startChapter + outlinedChapters
      }
    }

    if (!checkedOutlines.has(volume.name)) {
      return { kind: 'outline_gate', volume, outlinedChapters, expectedChapters }
    }

    const bodyComplete = volumeChapters.every(chapter => Boolean(chapter.content?.trim()))
    if (!bodyComplete) {
      return { kind: 'draft_body', volume, outlinedChapters, expectedChapters }
    }
    if (!checkedBodies.has(volume.name)) {
      return { kind: 'body_gate', volume, outlinedChapters, expectedChapters }
    }
  }
  return { kind: 'complete' }
}

export function planNovelChapterBatch(
  start: number,
  volumeEnd: number,
  failureMessage?: string
): { end: number; maxTokens: number; contextChars: number; compact: boolean } {
  const count = start === 1 ? GOLDEN_OPENING_BATCH_SIZE : OUTLINE_BATCH_SIZE
  const timeout = /timeout|timed out|超时/i.test(failureMessage ?? '')
  return {
    end: Math.min(volumeEnd, start + count - 1),
    maxTokens: start === 1 ? 6000 : NOVEL_SINGLE_CHAPTER_MAX_TOKENS,
    contextChars: timeout ? 3500 : 6000,
    compact: timeout
  }
}

/** 将整卷均匀拆成不超过 8 章的连续窗口，避免末尾出现仅 1 章的小窗口。 */
export function planNovelVolumeGateWindows(
  startChapter: number,
  endChapter: number,
  maxWindowSize = NOVEL_VOLUME_GATE_MAX_WINDOW_SIZE
): NovelVolumeRange[] {
  if (!Number.isInteger(startChapter) || !Number.isInteger(endChapter) || startChapter <= 0 || endChapter < startChapter) {
    throw new NovelPipelineError('CONTRACT_INVALID', `整卷门禁章节范围非法：${startChapter}-${endChapter}`)
  }
  if (!Number.isInteger(maxWindowSize) || maxWindowSize <= 0) {
    throw new NovelPipelineError('CONTRACT_INVALID', `整卷门禁窗口大小非法：${maxWindowSize}`)
  }
  const total = endChapter - startChapter + 1
  const windowCount = Math.ceil(total / maxWindowSize)
  const baseSize = Math.floor(total / windowCount)
  const largerWindows = total % windowCount
  const ranges: NovelVolumeRange[] = []
  let cursor = startChapter
  for (let index = 0; index < windowCount; index++) {
    const size = baseSize + (index < largerWindows ? 1 : 0)
    ranges.push({ startChapter: cursor, endChapter: cursor + size - 1 })
    cursor += size
  }
  return ranges
}

export class NovelPipelineError extends Error {
  constructor(
    public readonly code:
      | 'OUTPUT_INVALID'
      | 'OUTPUT_TRUNCATED'
      | 'CHAPTER_SKELETON_PROTOCOL_EXHAUSTED'
      | 'CONTRACT_INVALID'
      | 'PREREQUISITE_MISSING'
      | 'VOLUME_HARD_GATE_BLOCKED'
      | 'REPAIR_BOUNDARY'
      | 'REPAIR_STALL'
      | 'EVALUATOR_PROTOCOL'
      | 'QUALITY_EVALUATOR_UNAVAILABLE'
      | 'QUALITY_EVALUATOR_PROTOCOL'
      | 'QUALITY_NON_CONVERGENT'
      | 'EMOTION_NON_CONVERGENT'
      | 'EXECUTION_CONTRACT_NON_CONVERGENT',
    message: string
  ) {
    super(message)
    this.name = 'NovelPipelineError'
  }
}

export function readNovelGoalState(workId: number): NovelGoalPersistentState {
  return readNovelPersistentState(workId)
}

export function updateNovelGoalState(workId: number, patch: Partial<NovelGoalPersistentState>): void {
  updateNovelPersistentState(workId, patch)
}

/**
 * 自治周期重开 stalled 分卷门禁时，只重开只读诊断；累计改写章节和单章次数仍保留，
 * 因而不会通过周期滚动绕过每卷 6 章、每章 1 次的安全边界。
 */
export function reopenStalledNovelVolumeGate(workId: number): boolean {
  const state = readNovelGoalState(workId)
  const checkpoint = state.chapterVolumeGateCheckpoint
  if (!checkpoint?.stalled) return false
  updateNovelGoalState(workId, {
    failure: undefined,
    chapterVolumeGateCheckpoint: {
      ...checkpoint,
      round: 1,
      assessments: [],
      aggregate: undefined,
      repair: undefined,
      stalled: undefined,
      repairControl: checkpoint.repairControl
        ? { ...checkpoint.repairControl, lastRoundVersions: [] }
        : undefined
    }
  })
  return true
}

/** 从分卷规划重新开始时，所有由分卷、章节和正文派生的运行检查点都必须失效。 */
export function resetNovelGoalStateFromVolumePlan(workId: number): void {
  goalRoutineDAO.ensure(workId)
  updateNovelGoalState(workId, {
    lastCheck: undefined,
    novelOutline: undefined,
    volumePlanChecked: undefined,
    volumeQualityReport: undefined,
    checkedChapterVolumes: undefined,
    pendingChapterVolumeGate: undefined,
    chapterVolumeGateCheckpoint: undefined,
    volumeGateDeferredIssues: undefined,
    chapterVolumeGateResults: undefined,
    checkedBodyVolumes: undefined,
    pleasureVolumeFingerprint: undefined,
    pendingChapterSkeletonBatch: undefined,
    chapterSkeletonProtocolVersion: undefined,
    chapterSkeletonAuthorityLedger: undefined,
    repairPlan: undefined,
    overallRepairRounds: 0,
    repairStall: undefined,
    titleHookCandidates: undefined,
    titleHookPreferredIndex: undefined,
    titleHookApplied: undefined,
    finalAudit: undefined,
    chapterExecutionDeferredIssues: undefined,
    chapterAcceptanceDeferredIssues: undefined,
    failure: undefined
  })
}

/** 删除分卷后同步失效运行态；删除到空结构时，下次必须重新生成整套分卷合同。 */
export function invalidateNovelGoalStateAfterVolumeDeletion(
  workId: number,
  deletedVolumeName: string
): void {
  goalRoutineDAO.ensure(workId)
  const remainingVolumes = volumeChapterDAO.listVolumes(workId)
  const remainingChapters = volumeChapterDAO.listChaptersByWork(workId)
  if (remainingVolumes.length === 0 && remainingChapters.length === 0) {
    resetNovelGoalStateFromVolumePlan(workId)
    return
  }

  const state = readNovelGoalState(workId)
  updateNovelGoalState(workId, {
    lastCheck: undefined,
    checkedChapterVolumes: (state.checkedChapterVolumes ?? []).filter(name => name !== deletedVolumeName),
    checkedBodyVolumes: (state.checkedBodyVolumes ?? []).filter(name => name !== deletedVolumeName),
    pendingChapterVolumeGate: state.pendingChapterVolumeGate === deletedVolumeName
      ? undefined
      : state.pendingChapterVolumeGate,
    chapterVolumeGateCheckpoint: state.chapterVolumeGateCheckpoint?.volume === deletedVolumeName
      ? undefined
      : state.chapterVolumeGateCheckpoint,
    volumeGateDeferredIssues: (state.volumeGateDeferredIssues ?? []).filter(item => item.volume !== deletedVolumeName),
    chapterVolumeGateResults: (state.chapterVolumeGateResults ?? []).filter(item => item.volume !== deletedVolumeName),
    repairPlan: undefined,
    repairStall: undefined,
    finalAudit: undefined,
    failure: undefined
  })
}

/**
 * 章节/正文是事实源，冻结数组只是缓存。缓存声称已冻结但事实源不完整时自动降级，
 * 防止旧版本、手工删除或异常退出把目标循环锁死在不可能状态。
 */
export function reconcileNovelWorkflowState(workId: number): {
  changed: boolean
  invalidatedChapterVolumes: string[]
  invalidatedBodyVolumes: string[]
} {
  const state = readNovelGoalState(workId)
  const plan = state.novelOutline?.volumePlan ?? []
  if (plan.length === 0) {
    return { changed: false, invalidatedChapterVolumes: [], invalidatedBodyVolumes: [] }
  }

  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const completeOutlineNames = new Set<string>()
  const completeBodyNames = new Set<string>()
  for (const volume of plan) {
    const expected = volume.endChapter - volume.startChapter + 1
    const rows = chapters.filter(chapter => chapter.volume_name === volume.name)
    if (rows.length === expected) completeOutlineNames.add(volume.name)
    if (rows.length === expected && rows.every(chapter => Boolean(chapter.content?.trim()))) {
      completeBodyNames.add(volume.name)
    }
  }

  const previousChapterVolumes = state.checkedChapterVolumes ?? []
  const previousBodyVolumes = state.checkedBodyVolumes ?? []
  const nextChapterVolumes = previousChapterVolumes.filter(name => completeOutlineNames.has(name))
  const nextBodyVolumes = previousBodyVolumes.filter(name => completeBodyNames.has(name))
  const invalidatedChapterVolumes = previousChapterVolumes.filter(name => !completeOutlineNames.has(name))
  const invalidatedBodyVolumes = previousBodyVolumes.filter(name => !completeBodyNames.has(name))
  const checkpointInvalid = Boolean(
    state.chapterVolumeGateCheckpoint
    && !completeOutlineNames.has(state.chapterVolumeGateCheckpoint.volume)
  )
  const pendingInvalid = Boolean(
    state.pendingChapterVolumeGate
    && !completeOutlineNames.has(state.pendingChapterVolumeGate)
  )
  const changed = invalidatedChapterVolumes.length > 0
    || invalidatedBodyVolumes.length > 0
    || checkpointInvalid
    || pendingInvalid
  if (changed) {
    updateNovelGoalState(workId, {
      lastCheck: undefined,
      checkedChapterVolumes: nextChapterVolumes,
      checkedBodyVolumes: nextBodyVolumes,
      chapterVolumeGateResults: (state.chapterVolumeGateResults ?? [])
        .filter(item => completeOutlineNames.has(item.volume)),
      pendingChapterVolumeGate: pendingInvalid ? undefined : state.pendingChapterVolumeGate,
      chapterVolumeGateCheckpoint: checkpointInvalid ? undefined : state.chapterVolumeGateCheckpoint,
      repairPlan: undefined,
      repairStall: undefined,
      finalAudit: undefined,
      failure: undefined
    })
  }
  return { changed, invalidatedChapterVolumes, invalidatedBodyVolumes }
}

export function parseObject(content: string, label: string): Record<string, unknown> {
  const json = extractJsonText(content.trim()) ?? content.trim()
  try {
    const parsed = JSON.parse(json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('根节点必须是对象')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    const tail = content.trim().slice(-160).replace(/\s+/g, ' ')
    throw new NovelPipelineError(
      'OUTPUT_INVALID',
      `${label}解析失败：${error instanceof Error ? error.message : String(error)}；回复末尾：${tail}`
    )
  }
}

export function textField(row: Record<string, unknown>, key: string, label: string): string {
  const value = String(row[key] ?? '').trim()
  if (!value) throw new NovelPipelineError('CONTRACT_INVALID', `${label}缺少字段 ${key}`)
  return value
}

export function intField(row: Record<string, unknown>, key: string, label: string): number {
  const value = Number(row[key])
  if (!Number.isInteger(value) || value <= 0) {
    throw new NovelPipelineError('CONTRACT_INVALID', `${label}.${key} 必须是正整数`)
  }
  return value
}

function expectedVolumeCount(targetChapters: number): number {
  return Math.max(
    1,
    Math.round(targetChapters / TARGET_CHAPTERS_PER_VOLUME),
    Math.ceil(targetChapters / MAX_CHAPTERS_PER_VOLUME)
  )
}

/**
 * 章节边界由程序确定，模型只负责设计每卷剧情。
 * 余数从前往后每卷多分配一章，使任意两卷的长度差不超过 1。
 */
export function planNovelVolumeRanges(targetChapters: number): NovelVolumeRange[] {
  if (!Number.isInteger(targetChapters) || targetChapters <= 0) {
    throw new NovelPipelineError('CONTRACT_INVALID', '目标章节数必须是正整数')
  }
  const volumeCount = expectedVolumeCount(targetChapters)
  const baseSize = Math.floor(targetChapters / volumeCount)
  const remainder = targetChapters % volumeCount
  let startChapter = 1
  return Array.from({ length: volumeCount }, (_, index) => {
    const size = baseSize + (index < remainder ? 1 : 0)
    const range = { startChapter, endChapter: startChapter + size - 1 }
    startChapter = range.endChapter + 1
    return range
  })
}

function normalizeVolumeContract(
  item: unknown,
  index: number,
  expected: NovelVolumeRange
): NovelVolumeContract {
    if (!item || typeof item !== 'object') {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${index + 1} 个分卷合同不是对象`)
    }
    const row = item as Record<string, unknown>
    const label = `第 ${index + 1} 个分卷合同`
    const startChapter = intField(row, 'startChapter', label)
    const endChapter = intField(row, 'endChapter', label)
    const stringList = (key: string, fallback: string[]): string[] => {
      const value = row[key]
      if (value == null) return fallback
      if (!Array.isArray(value)) throw new NovelPipelineError('CONTRACT_INVALID', `${label}.${key} 必须是字符串数组`)
      const items = value.map(String).map(item => item.trim()).filter(Boolean)
      if (items.length === 0) throw new NovelPipelineError('CONTRACT_INVALID', `${label}.${key} 不能为空`)
      return items
    }
    const objective = textField(row, 'objective', label)
    const nextDebt = textField(row, 'nextDebt', label)
    const forbiddenRaw = Number(row.forbiddenNewThreadsAfterChapter)
    const forbiddenNewThreadsAfterChapter = Number.isInteger(forbiddenRaw)
      ? forbiddenRaw
      : Math.max(startChapter, endChapter - Math.max(2, Math.ceil((endChapter - startChapter + 1) * 0.15)))
    if (forbiddenNewThreadsAfterChapter < startChapter || forbiddenNewThreadsAfterChapter > endChapter) {
      throw new NovelPipelineError('CONTRACT_INVALID', `${label}.forbiddenNewThreadsAfterChapter 必须落在本卷章节范围内`)
    }
    const contract = {
      name: textField(row, 'name', label),
      description: textField(row, 'description', label),
      startChapter,
      endChapter,
      objective,
      midpoint: textField(row, 'midpoint', label),
      climax: textField(row, 'climax', label),
      irreversibleCost: textField(row, 'irreversibleCost', label),
      nextDebt,
      mustResolve: stringList('mustResolve', [objective]),
      mayCarryForward: stringList('mayCarryForward', [nextDebt]),
      forbiddenNewThreadsAfterChapter,
      protagonistEndState: stringList('protagonistEndState', [`完成阶段目标：${objective}`]),
      antagonistEndState: stringList('antagonistEndState', ['因本卷高潮产生不可逆状态变化'])
    }
    if (contract.startChapter !== expected.startChapter || contract.endChapter !== expected.endChapter) {
      throw new NovelPipelineError(
        'CONTRACT_INVALID',
        `第 ${index + 1} 个分卷章节范围必须是 ${expected.startChapter}-${expected.endChapter}，实际为 ${contract.startChapter}-${contract.endChapter}`
      )
    }
    return contract
}

export function validatePartialVolumePlan(raw: unknown, targetChapters: number): NovelVolumeContract[] {
  if (!Array.isArray(raw)) {
    throw new NovelPipelineError('CONTRACT_INVALID', '分卷合同必须是 volumes 数组')
  }
  const expectedRanges = planNovelVolumeRanges(targetChapters)
  if (raw.length > expectedRanges.length) {
    throw new NovelPipelineError('CONTRACT_INVALID', `分卷合同最多包含 ${expectedRanges.length} 卷，实际 ${raw.length} 卷`)
  }
  const plan = raw.map((item, index) => normalizeVolumeContract(item, index, expectedRanges[index]))

  const names = new Set<string>()
  for (let index = 0; index < plan.length; index++) {
    const volume = plan[index]
    if (names.has(volume.name)) throw new NovelPipelineError('CONTRACT_INVALID', `分卷名称重复：${volume.name}`)
    names.add(volume.name)
  }
  return plan
}

export function validateVolumePlan(raw: unknown, targetChapters: number): NovelVolumeContract[] {
  const plan = validatePartialVolumePlan(raw, targetChapters)
  const expectedVolumes = planNovelVolumeRanges(targetChapters).length
  if (plan.length !== expectedVolumes) {
    throw new NovelPipelineError('CONTRACT_INVALID', `分卷合同必须包含 ${expectedVolumes} 卷，实际 ${plan.length} 卷`)
  }
  return plan
}

export async function generateNextVolumeContract(
  workId: number,
  goal: string,
  targetChapters: number,
  completed: NovelVolumeContract[],
  signal?: AbortSignal
): Promise<NovelVolumeContract> {
  const ctx = buildWorkContext(workId, { includeVolumes: false, includeCoreSettings: true })
  const plannedRanges = planNovelVolumeRanges(targetChapters)
  const suggestedVolumes = plannedRanges.length
  const index = completed.length
  const range = plannedRanges[index]
  if (!range) throw new NovelPipelineError('CONTRACT_INVALID', '所有分卷合同均已生成')
  const previous = completed.at(-1)
  const nextRange = plannedRanges[index + 1]
  const failure = readNovelGoalState(workId).failure
  const profile = volumeGenerationProfile(failure?.phase === 'generate_volumes' ? failure.message : undefined)
  return requestStructuredModelOutput<NovelVolumeContract>({
    workId,
    label: `第 ${index + 1} 卷合同`,
    attempts: 2,
    signal,
    schema: NOVEL_VOLUME_CONTRACT_SCHEMA,
    request: (attempt, lastError) => modelService.chat(
      {
        ...withGoalLoopModelOptions(workId, {
          workId,
          step: 'goal_novel_volume_plan',
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          maxTokens: attempt === 1 ? profile.maxTokens : Math.max(profile.maxTokens, 5000),
          thinkingEnabled: false,
          forceThinkingDisabled: true,
          responseSchema: {
            name: 'novel_volume_contract',
            strict: true,
            schema: NOVEL_VOLUME_CONTRACT_SCHEMA
          },
          structuredOutputMode: 'prompt_json',
          systemPrompt: [
            '你是长篇小说总架构师。只输出合法 JSON 对象，不要 markdown、前言或解释。',
            `全书共 ${suggestedVolumes} 卷；本次只设计第 ${index + 1} 卷，禁止输出其他卷。`,
            '本卷必须形成阶段闭环，同时留下因果驱动下一卷的新债务；终卷必须完成全书主线清算。',
            previous ? '本卷 objective 必须由上一卷 nextDebt 直接驱动，不能另起无关主线。' : '首卷必须建立核心冲突并完成首个阶段兑现。',
            `章节范围 ${range.startChapter}-${range.endChapter} 由系统绑定，禁止输出 startChapter 或 endChapter。`,
            '严格控制篇幅：description 不超过180字；objective、midpoint、climax各不超过120字；其余字符串不超过100字；每个数组1-3项且每项不超过80字。',
            '优先保证 JSON 完整闭合；不得把章节级事件清单塞进字段，不得在一个字符串中使用编号长篇扩写。',
            `格式：{"volume":{"name":"第${index + 1}卷 名称","description":"核心冲突与升级路径","objective":"阶段目标","midpoint":"中点反转","climax":"卷高潮与兑现","irreversibleCost":"永久代价","nextDebt":"${nextRange ? '留给下一卷的未偿债务' : '终卷清算后不可逆余波'}","mustResolve":["本卷必须闭环的承诺"],"mayCarryForward":["${nextRange ? '允许跨卷的债务' : '终卷余波'}"],"forbiddenNewThreadsAfterChapter":${Math.max(range.startChapter, range.endChapter - 5)},"protagonistEndState":["卷末主角状态"],"antagonistEndState":["卷末对手状态"]}}`
          ].join('\n'),
          prompt: [
            `【用户目标】\n${goal.trim() || '自动策划一部长篇小说'}`,
            `【目标章节数】${targetChapters}`,
            `【当前任务】第 ${index + 1}/${suggestedVolumes} 卷，章节 ${range.startChapter}-${range.endChapter}`,
            previous ? `【上一卷合同（必须承接）】\n${JSON.stringify(previous)}` : '',
            completed.length > 1 ? `【此前各卷因果摘要】\n${JSON.stringify(completed.map(volume => ({ name: volume.name, objective: volume.objective, climax: volume.climax, nextDebt: volume.nextDebt })))}` : '',
            `【核心设定（${profile.compact ? '超时降级摘要' : '已压缩'}）】\n${ctx.text.slice(0, profile.contextChars)}`,
            attempt > 1 ? `【上次协议错误】\n${lastError}` : ''
          ].filter(Boolean).join('\n\n')
        }),
        thinkingEnabled: false,
        forceThinkingDisabled: true
      },
      { stream: false, signal }
    ),
    validate: parsed => normalizeVolumeContract({
      ...(parsed.volume && typeof parsed.volume === 'object' && !Array.isArray(parsed.volume)
        ? parsed.volume as Record<string, unknown>
        : {}),
      startChapter: range.startChapter,
      endChapter: range.endChapter
    }, index, range)
  })
}

export async function diagnoseVolumePlan(
  workId: number,
  goal: string,
  plan: NovelVolumeContract[],
  signal?: AbortSignal
): Promise<{ passed: boolean; report: string }> {
  return requestStructuredModelOutput<{ passed: boolean; report: string }>({
    workId,
    label: '分卷质量门禁',
    attempts: 2,
    signal,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_novel_volume_gate',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        systemPrompt: [
          '你是长篇小说分卷架构门禁。只输出合法 JSON，不要 markdown 或解释。',
          '逐卷检查阶段目标、冲突升级、中点转折、卷高潮、不可逆代价和跨卷债务。',
          '重点检查上一卷 nextDebt 是否因果驱动下一卷 objective，禁止冲突降级、高潮重复、成长停滞、代价重置和终卷未闭环。',
          '格式：{"passed":true,"score":90,"issues":[{"volumes":"第一卷→第二卷","problem":"问题","requiredFix":"必须如何修复"}]}'
        ].join('\n'),
        prompt: [
          `【创作目标】\n${goal.trim() || '完成一部长篇小说'}\n\n【全书分卷合同】\n${JSON.stringify(plan, null, 2)}`,
          attempt > 1 ? `【上次协议错误】\n${lastError}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    ),
    validate: parsed => {
      if (typeof parsed.passed !== 'boolean' || !Array.isArray(parsed.issues)) {
        throw new NovelPipelineError('OUTPUT_INVALID', '分卷质量门禁缺少 passed 或 issues')
      }
      return { passed: parsed.passed, report: JSON.stringify(parsed) }
    }
  })
}

export async function reviseVolumePlan(
  workId: number,
  goal: string,
  targetChapters: number,
  plan: NovelVolumeContract[],
  report: string,
  signal?: AbortSignal
): Promise<NovelVolumeContract[]> {
  const plannedRanges = planNovelVolumeRanges(targetChapters)
  return requestStructuredModelOutput<NovelVolumeContract[]>({
    workId,
    label: '分卷合同修订',
    attempts: 2,
    signal,
    schema: NOVEL_VOLUME_REVISE_PATCH_SCHEMA,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_novel_volume_revise',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0.1,
        thinkingEnabled: false,
        forceThinkingDisabled: true,
        maxTokens: 3600,
        responseSchema: {
          name: 'novel_volume_revision_patches',
          strict: true,
          schema: NOVEL_VOLUME_REVISE_PATCH_SCHEMA
        },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是长篇小说总架构修订师。只输出合法 JSON，不要 markdown 或解释。',
          `全书已有 ${plannedRanges.length} 卷；只返回确实需要改动的分卷字段补丁，不要重写整份合同。`,
          '分卷章节范围由系统绑定，禁止修改或输出 startChapter/endChapter；不得重新分配、合并或拆分卷。',
          '每个补丁只写门禁报告要求修复的字段；没有问题的字段不要复制。未返回的字段由系统原样保留。',
          '上一卷 nextDebt 必须直接驱动下一卷 objective；冲突、高潮、成长和不可逆代价必须逐卷升级。',
          '输出格式：{"patches":[{"volumeIndex":1,"fields":{"objective":"修订后的阶段目标"}}]}；至少一个补丁，每个补丁至少一个字段。'
        ].join('\n'),
        prompt: [
          `【创作目标】\n${goal.trim() || '完成一部长篇小说'}`,
          `【不可修改的分卷章节范围】\n${JSON.stringify(plannedRanges, null, 2)}`,
          `【当前分卷合同摘要】\n${JSON.stringify(plan.map((volume, index) => ({
            volumeIndex: index + 1,
            name: volume.name,
            objective: volume.objective,
            midpoint: volume.midpoint,
            climax: volume.climax,
            irreversibleCost: volume.irreversibleCost,
            nextDebt: volume.nextDebt,
            mustResolve: volume.mustResolve,
            mayCarryForward: volume.mayCarryForward,
            protagonistEndState: volume.protagonistEndState,
            antagonistEndState: volume.antagonistEndState
          })), null, 2)}`,
          `【门禁报告】\n${report}`,
          attempt > 1 ? `【上次协议错误】\n${lastError}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    ),
    validate: parsed => applyVolumeRevisionPatches(parsed, plan, plannedRanges, targetChapters)
  })
}

export function materializeVolumePlan(workId: number, plan: NovelVolumeContract[]): void {
  const existing = volumeChapterDAO.listVolumes(workId)
  const canReconcileByPosition = volumeChapterDAO.listChaptersByWork(workId).length === 0
  for (let index = 0; index < plan.length; index++) {
    const contract = plan[index]
    const description = [
      contract.description,
      `【阶段目标】${contract.objective}`,
      `【中点转折】${contract.midpoint}`,
      `【卷高潮】${contract.climax}`,
      `【不可逆代价】${contract.irreversibleCost}`,
      `【跨卷债务】${contract.nextDebt}`,
      `【本卷必须闭环】${contract.mustResolve.join('；')}`,
      `【允许跨卷】${contract.mayCarryForward.join('；')}`,
      `【停止新增一级主线】第${contract.forbiddenNewThreadsAfterChapter}章起`,
      `【卷末主角状态】${contract.protagonistEndState.join('；')}`,
      `【卷末对手状态】${contract.antagonistEndState.join('；')}`,
      `【章节范围】${contract.startChapter}-${contract.endChapter}`
    ].join('\n')
    // 尚未生成章节时复用原有空卷，避免规划版本升级后残留旧卷或重复建卷。
    // 已有章节时仍按名称匹配，绝不静默搬迁或删除用户内容。
    const row = canReconcileByPosition
      ? existing[index]
      : existing.find(item => item.name === contract.name)
    if (row) {
      volumeChapterDAO.updateVolume(row.id, {
        name: contract.name,
        description,
        sort: index + 1,
        plannedStartChapter: contract.startChapter,
        plannedEndChapter: contract.endChapter
      })
    } else {
      volumeChapterDAO.createVolume(workId, contract.name, description, index + 1, {
        startChapter: contract.startChapter,
        endChapter: contract.endChapter
      })
    }
  }
  if (canReconcileByPosition) {
    for (const obsolete of existing.slice(plan.length)) {
      volumeChapterDAO.deleteVolume(obsolete.id)
    }
  }
}

export function pleasureVolumeFingerprint(workId: number, plan: NovelVolumeContract[]): string {
  return [
    novelScaleFingerprint(loadWritingPlan(workId)),
    ...plan.map(volume => `${volume.name}:${volume.startChapter}-${volume.endChapter}`)
  ].join('|')
}

export async function ensurePleasureEngineMatchesVolumePlan(
  workId: number,
  goal: string,
  plan: NovelVolumeContract[],
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<void> {
  const fingerprint = pleasureVolumeFingerprint(workId, plan)
  const state = readNovelGoalState(workId)
  const current = coreSettingDAO.getByType(workId, 'pleasure_engine')?.content?.trim() ?? ''
  const scaleGate = validatePleasureEngineScale(workId, current)
  const coversVolumes = plan.every(volume => current.includes(volume.name))
  if (state.pleasureVolumeFingerprint === fingerprint && scaleGate.valid && coversVolumes) return

  for (let round = 1; round <= MAX_GATE_REPAIR_ROUNDS; round++) {
    if (signal?.aborted) throw new Error('已取消')
    onProgress?.(`正在执行爽点机制与分卷大纲映射门禁（第 ${round} 轮）`)
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_pleasure_volume_alignment',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        systemPrompt: [
          '你是长篇小说爽点架构师。根据已经冻结的分卷合同，重写完整爽点机制 Markdown，不要解释。',
          '必须保留合理的爽点类型与对抗设计，但所有阶段锚点必须逐卷映射到实际卷名和章节范围。',
          '每一卷至少给出一个小高潮或大高潮锚点；最终清算只能位于目标末章。',
          '输出结构：## 主要爽点类型 / ## 频率设计 / ## 分卷爽点锚点 / ## 终极清算。'
        ].join('\n'),
        prompt: [
          formatNovelScaleContract(workId),
          `【用户创作目标】\n${goal.trim() || '完成一部长篇小说'}`,
          `【冻结分卷合同】\n${JSON.stringify(plan, null, 2)}`,
          `【当前爽点机制】\n${current || '尚未生成'}`
        ].join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) {
      onProgress?.(`爽点映射第 ${round} 轮未返回有效内容，正在继续重试`)
      continue
    }
    const revised = response.content.trim()
    const revisedScaleGate = validatePleasureEngineScale(workId, revised)
    const missingVolumes = plan.filter(volume => !revised.includes(volume.name)).map(volume => volume.name)
    if (!revisedScaleGate.valid || missingVolumes.length > 0) {
      onProgress?.(
        `爽点映射门禁未通过：${revisedScaleGate.reason || `缺少分卷 ${missingVolumes.join('、')}`}，正在继续修订`
      )
      continue
    }
    coreSettingDAO.upsert(workId, 'pleasure_engine', revised)
    updateNovelGoalState(workId, { pleasureVolumeFingerprint: fingerprint })
    onProgress?.(`爽点机制已覆盖 ${plan.length} 卷并对齐目标末章`)
    return
  }
  throw new NovelPipelineError(
    'CONTRACT_INVALID',
    `爽点机制与分卷大纲连续 ${MAX_GATE_REPAIR_ROUNDS} 轮未能对齐，请调整设定或模型后重试`
  )
}
