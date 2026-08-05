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
  prepareNovelAuthorityStateUpdate,
  readNovelPersistentState,
  updateNovelPersistentState
} from './novel-authority-state'
import type { UnifiedNovelRepairContext } from './unified-novel-repair'

import {
  GOLDEN_OPENING_BATCH_SIZE,
  MAX_GATE_REPAIR_ROUNDS,
  NOVEL_SINGLE_CHAPTER_MAX_TOKENS,
  OUTLINE_BATCH_SIZE,
  NovelPipelineError,
  diagnoseVolumePlan,
  ensurePleasureEngineMatchesVolumePlan,
  generateNextVolumeContract,
  materializeVolumePlan,
  planNovelChapterBatch,
  planNovelVolumeRanges,
  readNovelGoalState,
  reviseVolumePlan,
  validateVolumePlan,
  updateNovelGoalState,
  validatePartialVolumePlan,
  pleasureVolumeFingerprint,
  resolveNovelVolumeWorkflowCheckpoint,
  intField,
  textField,
  type NovelGoalPersistentState,
  type NovelChapterSkeleton,
  type NovelOutlineBatchResult,
  type NovelOutlineProgressState,
  type NovelVolumeContract
} from './novel-volume-planning'
import {
  GOLDEN_THREE_GATE_MAX_ATTEMPTS,
  goldenThreeGateTokenBudget
} from './novel-golden-three-gate-policy'
import {
  CHAPTER_SKELETON_BEAT_MAX_CHARS,
  CHAPTER_AUTHORITY_FIELDS,
  CHAPTER_SKELETON_COMPILED_MAX_CHARS,
  CHAPTER_SKELETON_CONSTRAINT_MAX_CHARS,
  CHAPTER_SKELETON_ENDING_MAX_CHARS,
  CHAPTER_SKELETON_FORESHADOW_MAX_CHARS,
  CHAPTER_SKELETON_MAX_ATTEMPTS,
  CHAPTER_SKELETON_OPENING_MAX_CHARS,
  CHAPTER_SKELETON_PROTOCOL_VERSION,
  RECENT_SKELETON_CONTEXT_CHAPTERS,
  chapterSkeletonRequestTokenBudget,
  compactOutlineForSkeletonContext,
  compactPatternForSkeletonContext,
  formatChapterSkeletonAuthorityRegistry,
  materializeChapterSkeletonAuthorityLedger,
  projectChapterSkeletonDelta,
  validateChapterSkeletonAuthorityLedger,
  type ChapterSkeletonAuthorityLedger
} from './novel-chapter-skeleton-policy'
import {
  budgetKey,
  isNumericConstraint,
  normalizeCharacters,
  previousResourceBudgetContext,
  resourceBudgetExample,
  runVolumeChapterGate,
  validateDramaticContract,
  validatePatternContract,
  validateResourceBudgets,
  volumeGateSnapshotFingerprint
} from './novel-volume-chapter-gate'

export * from './novel-volume-planning'
export * from './novel-volume-chapter-gate'

const DRAMATIC_CONTRACT_KEYS = [
  'scene_promise', 'protagonist_want', 'obstacle', 'stakes', 'info_gap',
  'pressure_escalation', 'turn', 'irreversible_change', 'payoff_or_debt', 'next_question'
] as const

const PATTERN_CONTRACT_KEYS = [
  'conflict_type', 'protagonist_method', 'antagonist_tactic', 'anticipated_opponent_adjustment',
  'location_type', 'hook_type', 'cost_type', 'relationship_delta', 'volume_objective_delta'
] as const

export function chapterSkeletonBatchSchema(
  start: number,
  end: number
): Record<string, unknown> {
  void start
  void end
  return {
    type: 'object',
    additionalProperties: false,
    required: ['chapters'],
    properties: {
      chapters: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'title', 'opening_state', 'required_beats', 'ending_state',
            'fact_changes', 'resolved_constraints',
            'arc_phase', 'payoff_role',
            'tension_level', 'payoff_type', 'foreshadow_target', 'next_hook', 'characters'
          ],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 80 },
            opening_state: { type: 'string', minLength: 1, maxLength: CHAPTER_SKELETON_OPENING_MAX_CHARS },
            required_beats: {
              type: 'array', minItems: 2, maxItems: 6,
              items: { type: 'string', minLength: 1, maxLength: CHAPTER_SKELETON_BEAT_MAX_CHARS }
            },
            ending_state: { type: 'string', minLength: 1, maxLength: CHAPTER_SKELETON_ENDING_MAX_CHARS },
            fact_changes: {
              type: 'array', minItems: 1, maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['subject', 'field', 'after', 'beat_index'],
                properties: {
                  subject: { type: 'string', minLength: 1, maxLength: 80 },
                  field: { type: 'string', enum: [...CHAPTER_AUTHORITY_FIELDS] },
                  after: { type: 'string', minLength: 1, maxLength: CHAPTER_SKELETON_CONSTRAINT_MAX_CHARS },
                  beat_index: { type: 'integer', minimum: 1, maximum: 6 }
                }
              }
            },
            resolved_constraints: {
              type: 'array', minItems: 0, maxItems: 12,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['constraint_id', 'beat_index'],
                properties: {
                  constraint_id: { type: 'string', pattern: '^K[0-9a-f]{12}$' },
                  beat_index: { type: 'integer', minimum: 1, maximum: 6 }
                }
              }
            },
            arc_phase: { type: 'string', minLength: 1, maxLength: 80 },
            payoff_role: { type: 'string', enum: ['A', 'B', 'C'] },
            tension_level: { type: 'integer', minimum: 1, maximum: 10 },
            payoff_type: { type: 'string', enum: ['debt', 'partial', 'major', 'aftertaste'] },
            foreshadow_target: { type: 'string', maxLength: CHAPTER_SKELETON_FORESHADOW_MAX_CHARS },
            next_hook: { type: 'string', minLength: 1, maxLength: 240 },
            characters: {
              type: 'array', minItems: 1, maxItems: 12,
              items: { type: 'string', minLength: 1, maxLength: 80 }
            }
          }
        }
      }
    }
  }
}

const CHAPTER_TITLE_REPAIR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['titles'],
  properties: {
    titles: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['chapterNumber', 'title'],
        properties: {
          chapterNumber: { type: 'integer', minimum: 1 },
          title: { type: 'string', minLength: 1, maxLength: 80 }
        }
      }
    }
  }
}

function normalizeChapterTitleForUniqueness(title: string): string {
  return title
    .trim()
    .replace(/^第\s*\d+\s*章[：:：.。\s_-]*/u, '')
    .replace(/[\s“”‘’'"《》【】]/gu, '')
}

export function validateUniqueChapterTitles(
  skeletons: Array<{ chapterNumber: number; title: string }>,
  existingTitles: string[] = []
): void {
  const seen = new Map<string, number>()
  for (const title of existingTitles) {
    const normalized = normalizeChapterTitleForUniqueness(title)
    if (normalized) seen.set(normalized, 0)
  }
  const duplicateChapterNumbers: number[] = []
  for (const skeleton of skeletons) {
    const normalized = normalizeChapterTitleForUniqueness(skeleton.title)
    if (!normalized) continue
    if (seen.has(normalized)) duplicateChapterNumbers.push(skeleton.chapterNumber)
    else seen.set(normalized, skeleton.chapterNumber)
  }
  if (duplicateChapterNumbers.length > 0) {
    throw new ChapterTitleUniquenessError(duplicateChapterNumbers)
  }
}

class ChapterTitleUniquenessError extends NovelPipelineError {
  readonly chapterNumbers: number[]

  constructor(chapterNumbers: number[]) {
    super('CONTRACT_INVALID', `章节标题重复，需只修订标题字段：第 ${chapterNumbers.join('、')} 章`)
    this.name = 'ChapterTitleUniquenessError'
    this.chapterNumbers = chapterNumbers
  }
}

const CHAPTER_STRUCTURE_FIELD_MAX_LENGTH = 240
const CHAPTER_STRUCTURE_BASE_MAX_TOKENS = 3200
const CHAPTER_STRUCTURE_MAX_TOKENS = 12800

export function chapterStructureContractTokenBudget(attempt: number): number {
  const safeAttempt = Math.max(1, Math.floor(attempt))
  return Math.min(
    CHAPTER_STRUCTURE_MAX_TOKENS,
    CHAPTER_STRUCTURE_BASE_MAX_TOKENS * 2 ** (safeAttempt - 1)
  )
}

export function chapterStructureContractSchema(chapterNumber: number): Record<string, unknown> {
  void chapterNumber
  const stringProperties = (keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, {
    type: 'string',
    minLength: 1,
    maxLength: CHAPTER_STRUCTURE_FIELD_MAX_LENGTH
  }]))
  return {
    type: 'object',
    additionalProperties: false,
    required: ['dramatic_contract', 'pattern_contract', 'resource_budget'],
    properties: {
      dramatic_contract: {
        type: 'object',
        additionalProperties: false,
        required: [...DRAMATIC_CONTRACT_KEYS],
        properties: stringProperties(DRAMATIC_CONTRACT_KEYS)
      },
      pattern_contract: {
        type: 'object',
        additionalProperties: false,
        required: [...PATTERN_CONTRACT_KEYS],
        properties: stringProperties(PATTERN_CONTRACT_KEYS)
      },
      resource_budget: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'owner', 'resource', 'unit', 'start_min', 'start_max', 'end_min', 'end_max',
            'allowed_events', 'forbidden_events', 'reason'
          ],
          properties: {
            owner: { type: ['string', 'null'] },
            resource: { type: 'string' },
            unit: { type: ['string', 'null'] },
            start_min: { type: ['number', 'null'] },
            start_max: { type: ['number', 'null'] },
            end_min: { type: ['number', 'null'] },
            end_max: { type: ['number', 'null'] },
            allowed_events: { type: ['string', 'null'] },
            forbidden_events: { type: ['string', 'null'] },
            reason: { type: ['string', 'null'] }
          }
        }
      }
    }
  }
}

export function missingChapterStructureFields(parsed: Record<string, unknown>): string[] {
  const missing: string[] = []
  const dramatic = parsed.dramatic_contract && typeof parsed.dramatic_contract === 'object'
    && !Array.isArray(parsed.dramatic_contract)
    ? parsed.dramatic_contract as Record<string, unknown>
    : {}
  const pattern = parsed.pattern_contract && typeof parsed.pattern_contract === 'object'
    && !Array.isArray(parsed.pattern_contract)
    ? parsed.pattern_contract as Record<string, unknown>
    : {}
  for (const key of DRAMATIC_CONTRACT_KEYS) {
    if (typeof dramatic[key] !== 'string' || !dramatic[key].trim()) missing.push(`dramatic_contract.${key}`)
  }
  for (const key of PATTERN_CONTRACT_KEYS) {
    if (typeof pattern[key] !== 'string' || !pattern[key].trim()) missing.push(`pattern_contract.${key}`)
  }
  if (!Array.isArray(parsed.resource_budget)) missing.push('resource_budget')
  return missing
}

function chapterStructurePatchSchema(chapterNumber: number, missingFields: string[]): Record<string, unknown> {
  void missingFields
  const full = chapterStructureContractSchema(chapterNumber)
  const fullProperties = (full.properties ?? {}) as Record<string, Record<string, unknown>>
  const contractPatchSchema = (keys: readonly string[]) => ({
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(keys.map(key => [key, {
      type: 'string', minLength: 1, maxLength: CHAPTER_STRUCTURE_FIELD_MAX_LENGTH
    }]))
  })
  return {
    type: 'object',
    additionalProperties: false,
    required: ['patch'],
    properties: {
      patch: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dramatic_contract: contractPatchSchema(DRAMATIC_CONTRACT_KEYS),
          pattern_contract: contractPatchSchema(PATTERN_CONTRACT_KEYS),
          resource_budget: fullProperties.resource_budget
        }
      }
    }
  }
}

function assertChapterStructurePatchBoundary(
  patchResponse: Record<string, unknown>,
  chapterNumber: number,
  missingFields: string[]
): void {
  void chapterNumber
  const patch = patchResponse.patch && typeof patchResponse.patch === 'object' && !Array.isArray(patchResponse.patch)
    ? patchResponse.patch as Record<string, unknown>
    : null
  if (!patch || Object.keys(patch).length === 0) {
    throw new NovelPipelineError('OUTPUT_INVALID', '结构合同补丁不能为空')
  }
  const allowed = new Set(missingFields)
  const returned: string[] = []
  for (const key of ['dramatic_contract', 'pattern_contract'] as const) {
    const value = patch[key]
    if (value == null) continue
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new NovelPipelineError('OUTPUT_INVALID', `结构合同补丁 ${key} 必须是对象`)
    }
    for (const field of Object.keys(value)) returned.push(`${key}.${field}`)
  }
  if ('resource_budget' in patch) returned.push('resource_budget')
  if (returned.length === 0 || returned.some(field => !allowed.has(field))) {
    throw new NovelPipelineError(
      'OUTPUT_INVALID',
      `结构合同补丁只能返回当前缺失字段：${missingFields.join('、')}`
    )
  }
}

function mergeChapterStructurePatch(
  base: Record<string, unknown>,
  patchResponse: Record<string, unknown>
): Record<string, unknown> {
  const patch = patchResponse.patch && typeof patchResponse.patch === 'object' && !Array.isArray(patchResponse.patch)
    ? patchResponse.patch as Record<string, unknown>
    : {}
  const mergeObject = (key: string): Record<string, unknown> => ({
    ...(base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? base[key] as Record<string, unknown>
      : {}),
    ...(patch[key] && typeof patch[key] === 'object' && !Array.isArray(patch[key])
      ? patch[key] as Record<string, unknown>
      : {})
  })
  return {
    ...base,
    chapterNumber: base.chapterNumber,
    dramatic_contract: mergeObject('dramatic_contract'),
    pattern_contract: mergeObject('pattern_contract'),
    resource_budget: patch.resource_budget ?? base.resource_budget
  }
}

function validateChapterSkeletonBatch(input: {
  parsed: Record<string, unknown>
  start: number
  end: number
  outlineMin: number
  outlineMax: number
  existingTitles?: string[]
}): NovelChapterSkeleton[] {
  if (Number(input.parsed.startChapter) !== input.start || Number(input.parsed.endChapter) !== input.end) {
    throw new NovelPipelineError('CONTRACT_INVALID', `章节批次范围不匹配，期望 ${input.start}-${input.end}`)
  }
  const raw = input.parsed.chapters
  if (!Array.isArray(raw) || raw.length !== input.end - input.start + 1) {
    throw new NovelPipelineError('CONTRACT_INVALID', `章节批次数量不匹配，期望 ${input.end - input.start + 1} 章，实际 ${Array.isArray(raw) ? raw.length : 0} 章`)
  }

  const skeletons = raw.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new NovelPipelineError('CONTRACT_INVALID', `章节批次第 ${index + 1} 项不是对象`)
    }
    const row = value as Record<string, unknown>
    const chapterNumber = intField(row, 'chapterNumber', `章节批次第 ${index + 1} 项`)
    const expected = input.start + index
    if (chapterNumber !== expected) {
      throw new NovelPipelineError('CONTRACT_INVALID', `章节编号不连续：期望第 ${expected} 章，实际第 ${chapterNumber} 章`)
    }
    const outline = textField(row, 'outline', `第 ${chapterNumber} 章`)
    if (outline.replace(/\s/g, '').length < Math.max(120, Math.floor(input.outlineMin * 0.7))) {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章大纲过短，无法作为正文执行蓝图`)
    }
    if (Array.from(outline).length > input.outlineMax) {
      throw new NovelPipelineError(
        'CONTRACT_INVALID',
        `第 ${chapterNumber} 章大纲超过 ${input.outlineMax} 字，禁止把历史大纲递归复制到当前章`
      )
    }
    const payoffRole = textField(row, 'payoff_role', `第 ${chapterNumber} 章`)
    if (!['A', 'B', 'C'].includes(payoffRole)) {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章 payoff_role 必须是 A/B/C`)
    }
    const tensionLevel = intField(row, 'tension_level', `第 ${chapterNumber} 章`)
    if (tensionLevel > 10) throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章 tension_level 必须在 1-10`)
    const payoffType = textField(row, 'payoff_type', `第 ${chapterNumber} 章`)
    if (!['debt', 'partial', 'major', 'aftertaste'].includes(payoffType)) {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章 payoff_type 非法`)
    }
    return {
      chapterNumber,
      title: textField(row, 'title', `第 ${chapterNumber} 章`),
      outline,
      arcPhase: textField(row, 'arc_phase', `第 ${chapterNumber} 章`),
      payoffRole,
      tensionLevel,
      payoffType: payoffType as NovelChapterSkeleton['payoffType'],
      foreshadowTarget: String(row.foreshadow_target ?? '').trim() || null,
      nextHook: textField(row, 'next_hook', `第 ${chapterNumber} 章`),
      characters: normalizeCharacters(row.characters, chapterNumber),
      authorityLedger: validateChapterSkeletonAuthorityLedger(row.authorityLedger, chapterNumber)
    }
  })
  validateUniqueChapterTitles(skeletons, input.existingTitles)
  return skeletons
}

function validateChapterStructureContract(
  parsed: Record<string, unknown>,
  chapterNumber: number
): {
  dramaticContract: Record<string, unknown>
  patternContract: Record<string, string>
  resourceBudgets: ChapterResourceBudgetInput[]
} {
  if (Number(parsed.chapterNumber) !== chapterNumber) {
    throw new NovelPipelineError('CONTRACT_INVALID', `章节结构合同编号不匹配，期望第 ${chapterNumber} 章`)
  }
  const dramaticContract = validateDramaticContract(parsed.dramatic_contract, chapterNumber)
  for (const key of DRAMATIC_CONTRACT_KEYS) {
    textField(dramaticContract, key, `第 ${chapterNumber} 章 dramatic_contract`)
  }
  const patternContract = validatePatternContract(parsed.pattern_contract, chapterNumber)
  const resourceBudgets = normalizeChapterResourceBudgets(parsed.resource_budget).filter(budget =>
    budget.start_min != null && budget.start_max != null && budget.end_min != null && budget.end_max != null
  )
  return { dramaticContract, patternContract, resourceBudgets }
}

function validateChapterResourceBudgetCompleteness(
  workId: number,
  chapterNumber: number,
  previousBudgets: Map<string, ChapterResourceBudgetInput>,
  budgets: ChapterResourceBudgetInput[]
): void {
  const required = resourceLedgerDAO.listConstraints(workId).filter(isNumericConstraint)
  if (required.length === 0) {
    if (budgets.length > 0) {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章没有数值资源约束，resource_budget 必须为空数组`)
    }
    return
  }
  const current = new Map(budgets.map(budget => [budgetKey(budget), budget]))
  for (const constraint of required) {
    const key = budgetKey(constraint)
    const budget = current.get(key)
    if (!budget) throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章缺少资源预算 ${key}`)
    if (budget.start_min == null || budget.start_max == null || budget.end_min == null || budget.end_max == null) {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章资源 ${key} 缺少完整起止区间`)
    }
    const previous = previousBudgets.get(key)
    if (previous?.end_min != null && previous.end_max != null) {
      budget.start_min = previous.end_min
      budget.start_max = previous.end_max
    }
  }
}

function formatRecentOutlineContext(
  workId: number,
  maxChapters = RECENT_SKELETON_CONTEXT_CHAPTERS,
  includePattern = true
): string {
  return volumeChapterDAO.listChaptersByWork(workId)
    .slice(-Math.max(1, maxChapters))
    .map((chapter, index, rows) => {
      let pattern = ''
      if (includePattern) {
        try {
          pattern = JSON.stringify(compactPatternForSkeletonContext(
            JSON.parse(chapter.outline_diagnosis ?? '{}').pattern_contract
          ))
        } catch { /* 忽略旧大纲 */ }
      }
      return [
        `第 ${rows.length - index} 个最近章节：${chapter.title}`,
        compactOutlineForSkeletonContext(chapter.outline ?? ''),
        includePattern ? `模式指纹：${pattern}` : ''
      ].filter(Boolean).join('\n')
    })
    .join('\n\n')
}

async function generateChapterSkeletonBatch(input: {
  workId: number
  goal: string
  volume: NovelVolumeContract
  start: number
  end: number
  sourceLedger: ChapterSkeletonAuthorityLedger
  correction?: string
  priorSkeletons?: NovelChapterSkeleton[]
  signal?: AbortSignal
}): Promise<{ skeletons: NovelChapterSkeleton[]; authorityLedger: ChapterSkeletonAuthorityLedger }> {
  // 黄金前三章仍然需要联合门禁，但不应把三个完整骨架塞进一次结构化响应。
  // 每章独立提交、按权威账本顺序串联，最后再把结果交给同一个联合门禁；
  // 这样重试只扩大单章预算，不会把整个批次再次推到输出上限。
  if (input.start === 1 && input.end > input.start) {
    const skeletons: NovelChapterSkeleton[] = []
    let authorityLedger = input.sourceLedger
    for (let chapterNumber = input.start; chapterNumber <= input.end; chapterNumber++) {
      const generated = await generateChapterSkeletonBatch({
        ...input,
        start: chapterNumber,
        end: chapterNumber,
        sourceLedger: authorityLedger,
        correction: input.correction,
        priorSkeletons: skeletons
      })
      skeletons.push(...generated.skeletons)
      authorityLedger = generated.authorityLedger
    }
    return { skeletons, authorityLedger }
  }

  const plan = loadWritingPlan(input.workId)
  const constraints = outlineConstraintsForWordTarget(plan.wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER)
  const outputExample = {
    chapters: [{
      title: `第${input.start}章 标题`,
      opening_state: '本章开始时人物、地点与即时压力',
      required_beats: ['主角采取可执行行动', '行动造成不可逆状态变化'],
      ending_state: '章末已发生的新状态与钩子',
      fact_changes: [{ subject: '主角', field: 'location', after: '新地点', beat_index: 2 }],
      resolved_constraints: [],
      arc_phase: 'setup',
      payoff_role: 'B',
      tension_level: 6,
      payoff_type: 'debt',
      foreshadow_target: '',
      next_hook: '下一章钩子',
      characters: ['主角']
    }]
  }
  const ctx = buildWorkContext(input.workId, { includeVolumes: true, includeCoreSettings: true })
  const failure = readNovelGoalState(input.workId).failure
  const profile = planNovelChapterBatch(
    input.start,
    input.volume.endChapter,
    failure?.phase === 'generate_beats' ? failure.message : undefined
  )
  const recentOutlineContext = formatRecentOutlineContext(input.workId)
  const authorityConstraintText = formatChapterSkeletonAuthorityRegistry(input.sourceLedger)
  const occupiedTitles = volumeChapterDAO
    .listChaptersByWork(input.workId)
    .filter(chapter => chapter.sort < input.start)
    .map(chapter => chapter.title)
  if (input.priorSkeletons?.length) occupiedTitles.push(...input.priorSkeletons.map(skeleton => skeleton.title))
  let titleRepairContext: {
    parsed: Record<string, unknown>
    projectedChapters: Record<string, unknown>[]
    authorityLedger: ChapterSkeletonAuthorityLedger
    chapterNumbers: number[]
  } | null = null
  try {
    return await requestStructuredModelOutput<{
      skeletons: NovelChapterSkeleton[]
      authorityLedger: ChapterSkeletonAuthorityLedger
    }>({
    workId: input.workId,
    label: `第 ${input.start}-${input.end} 章骨架批次`,
    attempts: CHAPTER_SKELETON_MAX_ATTEMPTS,
    schema: chapterSkeletonBatchSchema(input.start, input.end),
    signal: input.signal,
    request: async (attempt, lastError) => modelService.chat(
      {
        ...withGoalLoopModelOptions(input.workId, {
          workId: input.workId,
          step: 'goal_novel_chapter_batch',
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          temperature: 0.2,
          maxTokens: chapterSkeletonRequestTokenBudget(attempt, lastError),
          thinkingEnabled: false,
          forceThinkingDisabled: true,
          responseSchema: {
            name: 'novel_chapter_skeleton_batch',
            schema: chapterSkeletonBatchSchema(input.start, input.end),
            strict: true
          },
          structuredOutputMode: 'prompt_json',
          systemPrompt: [
            '你是长篇小说章节骨架编辑。只输出严格 Schema 要求的 JSON，不要合同、情绪分析、资源预算、markdown 或解释。',
            `只生成第 ${input.start}-${input.end} 章，不得生成范围外章节。`,
            input.start === input.end
              ? '本次只规划一章剧情骨架。'
              : '本次联合规划黄金前三章，只负责连续剧情骨架，形成“立钩子→扩承诺→首兑现”。',
            goldenOutlineContract('novel', input.start, input.end),
            retentionPlanningRules('novel'),
            `章节骨架状态增量协议版本 ${CHAPTER_SKELETON_PROTOCOL_VERSION}。`,
            'title 必须是本章核心事件的短标题，禁止复用分卷名、作品名或前序章节标题；同一部作品内每章标题主体必须唯一。',
            '标题只写事件/冲突/选择/发现，不要只写“第N章”；章节编号由系统显示，标题中可以带编号但编号不算标题主体。',
            '只输出本章新增事件和结构化状态操作；已有权威事实与约束由本地继承，禁止在响应中复述。',
            'required_beats 是按发生顺序排列的原子事件；所有状态变化统一输出 fact_changes 的 subject/field/after，禁止输出旧值或自行区分新建与更新。',
            '本地根据 subject+field 的权威事实身份自动判断更新或创建，并从账本读取旧值；模型只负责给出本章事件后的新值。beat_index 指向造成变化的事件。',
            'resolved_constraints 只引用本章事件已经解除的已有约束；未列出的约束由本地自动保留。',
            '本章产生的连续性由 fact_changes 自动写入事实账本；foreshadow_target 自动写入承诺账本，模型不得另行输出约束。',
            `本地将权威约束、状态迁移和新增约束确定性编译为五段大纲，总长度硬上限 ${CHAPTER_SKELETON_COMPILED_MAX_CHARS} 字。`,
            'payoff_role 只允许 A/B/C；payoff_type 只允许 debt/partial/major/aftertaste；tension_level 为1-10。',
            '不得输出 dramatic_contract、pattern_contract、emotion_contract 或 resource_budget；这些由后续独立阶段生成。',
            `最小结构示例：${JSON.stringify(outputExample)}`
          ].join('\n'),
          prompt: [
            `【用户目标】\n${input.goal.trim() || '自动策划一部长篇小说'}`,
            `【当前分卷合同】\n${JSON.stringify(input.volume, null, 2)}`,
            `【作品章节权威账本】\n${authorityConstraintText}`,
            input.correction && !/timeout|timed out|超时/i.test(input.correction)
              ? `【上一轮骨架问题】\n${input.correction}`
              : '',
            lastError !== '未知结构化输出错误' ? `【上一轮 JSON 错误】\n${lastError}` : '',
            input.priorSkeletons?.length
              ? `【本批次前序骨架（只读，必须承接）】\n${JSON.stringify(input.priorSkeletons.map(skeleton => ({
                chapterNumber: skeleton.chapterNumber,
                title: skeleton.title,
                outline: skeleton.outline,
                next_hook: skeleton.nextHook
              })), null, 2)}`
              : '',
            occupiedTitles.length
              ? `【已占用章节标题（标题主体不得重复）】\n${JSON.stringify(occupiedTitles)}`
              : '',
            recentOutlineContext ? `【最近章节，必须连续承接】\n${recentOutlineContext}` : '',
            `【作品上下文（${profile.compact ? '超时后压缩' : '必要摘要'}）】\n${ctx.text.slice(0, profile.contextChars)}`
          ].filter(Boolean).join('\n\n')
        }),
        thinkingEnabled: false,
        forceThinkingDisabled: true
      },
      { stream: false, signal: input.signal }
    ),
    validate: parsed => {
      let projectedLedger = input.sourceLedger
      const projectedChapters = Array.isArray(parsed.chapters)
        ? parsed.chapters.map((chapter, index) => {
            const projection = projectChapterSkeletonDelta(
              chapter,
              projectedLedger,
              input.start + index
            )
            projectedLedger = projection.ledger
            return {
              ...(chapter && typeof chapter === 'object' && !Array.isArray(chapter)
                ? chapter as Record<string, unknown>
                : {}),
              chapterNumber: input.start + index,
              outline: projection.outline,
              authorityLedger: projection.ledger
            }
          })
        : parsed.chapters
      const projectedParsed = {
        ...parsed,
        startChapter: input.start,
        endChapter: input.end,
        chapters: projectedChapters
      }
      try {
        const skeletons = validateChapterSkeletonBatch({
          parsed: projectedParsed,
          start: input.start,
          end: input.end,
          outlineMin: constraints.charsMin,
          outlineMax: CHAPTER_SKELETON_COMPILED_MAX_CHARS,
          existingTitles: occupiedTitles
        })
        titleRepairContext = null
        return { skeletons, authorityLedger: projectedLedger }
      } catch (error) {
        if (error instanceof ChapterTitleUniquenessError) {
          titleRepairContext = {
            parsed: projectedParsed,
            projectedChapters: projectedChapters as Record<string, unknown>[],
            authorityLedger: projectedLedger,
            chapterNumbers: error.chapterNumbers
          }
        }
        throw error
      }
    },
    shouldRepairValidationError: error => error instanceof ChapterTitleUniquenessError,
    repairValidationError: async ({ error }) => {
      if (!(error instanceof ChapterTitleUniquenessError) || !titleRepairContext) throw error
      const context = titleRepairContext
      const repaired = await requestStructuredModelOutput<Array<{ chapterNumber: number; title: string }>>({
        workId: input.workId,
        label: `第 ${input.start}-${input.end} 章标题补丁`,
        attempts: 2,
        signal: input.signal,
        schema: CHAPTER_TITLE_REPAIR_SCHEMA,
        request: (attempt, lastError) => modelService.chat(
          withGoalLoopModelOptions(input.workId, {
            workId: input.workId,
            step: 'goal_novel_chapter_title_revise',
            enrichWorkContext: false,
            enrichNarrativeMemory: false,
            temperature: 0,
            maxTokens: 1200,
            thinkingEnabled: false,
            forceThinkingDisabled: true,
            responseSchema: {
              name: 'novel_chapter_title_repair',
              schema: CHAPTER_TITLE_REPAIR_SCHEMA,
              strict: true
            },
            structuredOutputMode: 'prompt_json',
            systemPrompt: [
              '你是章节标题修订器，只输出合法 JSON，不要 markdown 或解释。',
              '只返回待修订章节的 title 字段，不得修改章节正文、提纲、钩子、人物或状态。',
              '标题必须概括本章独有的事件、冲突、选择或发现；禁止复用已占用标题主体，禁止使用分卷名或作品名。',
              '每个待修订章必须返回一条，chapterNumber 不得改变。',
              '格式：{"titles":[{"chapterNumber":1,"title":"新的短标题"}]}'
            ].join('\n'),
            prompt: [
              `【待修订章节】\n${JSON.stringify(context.projectedChapters
                .filter(chapter => context.chapterNumbers.includes(Number(chapter.chapterNumber)))
                .map(chapter => ({
                  chapterNumber: chapter.chapterNumber,
                  title: chapter.title,
                  outline: String(chapter.outline ?? '').slice(0, 700)
                })), null, 2)}`,
              `【已占用标题】\n${JSON.stringify(occupiedTitles)}`,
              `【必须修订章号】${JSON.stringify(context.chapterNumbers)}`,
              attempt > 1 ? `【上次协议错误】\n${lastError}` : ''
            ].filter(Boolean).join('\n\n')
          }),
          { stream: false, signal: input.signal }
        ),
        validate: parsed => {
          if (!Array.isArray(parsed.titles)) throw new NovelPipelineError('CONTRACT_INVALID', '标题补丁缺少 titles')
          const allowed = new Set(context.chapterNumbers)
          const seen = new Set<number>()
          const titles = parsed.titles.map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
              throw new NovelPipelineError('CONTRACT_INVALID', '标题补丁项不是对象')
            }
            const row = item as Record<string, unknown>
            const chapterNumber = Number(row.chapterNumber)
            const title = String(row.title ?? '').trim()
            if (!allowed.has(chapterNumber) || seen.has(chapterNumber) || !title) {
              throw new NovelPipelineError('CONTRACT_INVALID', `标题补丁章号或标题无效：${chapterNumber}`)
            }
            seen.add(chapterNumber)
            return { chapterNumber, title }
          })
          if (seen.size !== allowed.size) {
            throw new NovelPipelineError('CONTRACT_INVALID', '标题补丁必须覆盖全部重复章节')
          }
          validateUniqueChapterTitles(
            context.projectedChapters.map(chapter => ({
              chapterNumber: Number(chapter.chapterNumber),
              title: titles.find(item => item.chapterNumber === Number(chapter.chapterNumber))?.title
                ?? String(chapter.title ?? '')
            })),
            occupiedTitles
          )
          return titles
        }
      })
      const titleMap = new Map(repaired.map(item => [item.chapterNumber, item.title]))
      const patchedChapters = context.projectedChapters.map(chapter => ({
        ...chapter,
        title: titleMap.get(Number(chapter.chapterNumber)) ?? chapter.title
      }))
      const skeletons = validateChapterSkeletonBatch({
        parsed: {
          ...context.parsed,
          startChapter: input.start,
          endChapter: input.end,
          chapters: patchedChapters
        },
        start: input.start,
        end: input.end,
        outlineMin: constraints.charsMin,
        outlineMax: CHAPTER_SKELETON_COMPILED_MAX_CHARS,
        existingTitles: occupiedTitles
      })
      return { skeletons, authorityLedger: context.authorityLedger }
    }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/连续\s+3\s+次结构化输出无效/i.test(message)) {
      if (/OUTPUT_TRUNCATED|finishReason=length|达到长度上限|输出.*截断/i.test(message)) {
        throw new NovelPipelineError('OUTPUT_TRUNCATED', message)
      }
      throw new NovelPipelineError('CHAPTER_SKELETON_PROTOCOL_EXHAUSTED', message)
    }
    throw error
  }
}

async function generateChapterStructureContract(input: {
  workId: number
  goal: string
  volume: NovelVolumeContract
  skeleton: NovelChapterSkeleton
  previousBudgets: Map<string, ChapterResourceBudgetInput>
  recentOutlineContext: string
  signal?: AbortSignal
}): Promise<ReturnType<typeof validateChapterStructureContract>> {
  const resourceConstraints = formatResourceConstraintsForPrompt(input.workId)
  const example = {
    dramatic_contract: Object.fromEntries(DRAMATIC_CONTRACT_KEYS.map(key => [key, key])),
    pattern_contract: Object.fromEntries(PATTERN_CONTRACT_KEYS.map(key => [key, key])),
    resource_budget: resourceBudgetExample(input.workId, input.previousBudgets)
  }
  const { authorityLedger, ...frozenSkeleton } = input.skeleton
  let partialContract: Record<string, unknown> | null = null
  let missingFields: string[] = []
  try {
    return await requestStructuredModelOutput({
      workId: input.workId,
      label: `第 ${input.skeleton.chapterNumber} 章结构合同`,
      attempts: 3,
      signal: input.signal,
      request: async (attempt, lastError) => modelService.chat(
        {
          ...withGoalLoopModelOptions(input.workId, {
            workId: input.workId,
            step: 'goal_novel_chapter_contract',
            enrichWorkContext: false,
            enrichNarrativeMemory: false,
            temperature: 0.1,
            maxTokens: chapterStructureContractTokenBudget(attempt),
            thinkingEnabled: false,
            forceThinkingDisabled: true,
            responseSchema: {
              name: missingFields.length > 0
                ? 'novel_chapter_structure_missing_fields'
                : 'novel_chapter_structure_contract',
              schema: missingFields.length > 0
                ? chapterStructurePatchSchema(input.skeleton.chapterNumber, missingFields)
                : chapterStructureContractSchema(input.skeleton.chapterNumber),
              strict: true
            },
            structuredOutputMode: 'prompt_json',
            systemPrompt: [
              '你是长篇小说单章结构合同编辑。剧情骨架已经冻结；只补充这一章的结构合同和资源预算，不得改写标题、大纲、角色或钩子。',
              'dramatic_contract 和 pattern_contract 的每个字段都必须是非空字符串。',
              'pattern_contract 使用抽象语义；对手无调整时明确填写“不适用：原因”，禁止省略 antagonist_tactic。',
              resourceConstraints
                ? 'resource_budget 必须按资源账本逐项完整输出，名称不得改写，开章区间承接上一章。'
                : 'resource_budget 必须输出空数组。',
              '所有合同字符串只写可执行约束，每字段 40-120 个汉字，禁止复述整章剧情、禁止同义反复。',
              attempt > 1
                ? missingFields.length > 0
                  ? `上一轮只有以下字段缺失：${missingFields.join('、')}。只在 patch 中返回这些字段，禁止返回或改写其他字段。`
                  : /finishReason=length|长度上限|截断/.test(lastError)
                    ? '上一轮输出被截断。本轮必须压缩措辞，完整闭合 JSON；不得扩写解释。'
                    : '上一轮有结构或格式错误。本轮保持已有剧情含义，禁止重新设计章节。'
                : '',
              `结构示例：${JSON.stringify(example)}`
            ].filter(Boolean).join('\n'),
            prompt: [
              `【用户目标】\n${input.goal.trim() || '自动策划一部长篇小说'}`,
              `【分卷合同】\n${JSON.stringify(attempt === 1 ? input.volume : {
                name: input.volume.name,
                objective: input.volume.objective,
                midpoint: input.volume.midpoint,
                climax: input.volume.climax,
                mustResolve: input.volume.mustResolve,
                mayCarryForward: input.volume.mayCarryForward
              })}`,
              `【冻结的章节骨架】\n${JSON.stringify(frozenSkeleton, null, 2)}`,
              `【该章提交后的结构化权威账本】\n${formatChapterSkeletonAuthorityRegistry(authorityLedger)}`,
              resourceConstraints,
              previousResourceBudgetContext(input.previousBudgets),
              input.recentOutlineContext
                ? `【最近章节模式，只读】\n${attempt === 1
                  ? input.recentOutlineContext
                  : formatRecentOutlineContext(input.workId, 1, false)}`
                : '',
              partialContract && missingFields.length > 0
                ? `【已通过字段，只读且禁止重写】\n${JSON.stringify(partialContract, null, 2)}`
                : '',
              attempt > 1 ? `【上一轮缺失/非法字段】\n${lastError}` : ''
            ].filter(Boolean).join('\n\n')
          }),
          thinkingEnabled: false,
          forceThinkingDisabled: true
        },
        { stream: false, signal: input.signal }
      ),
      validate: parsed => {
        if (partialContract && parsed.patch) {
          assertChapterStructurePatchBoundary(parsed, input.skeleton.chapterNumber, missingFields)
        }
        const candidate = partialContract && parsed.patch
          ? mergeChapterStructurePatch(partialContract, parsed)
          : { ...parsed, chapterNumber: input.skeleton.chapterNumber }
        try {
          const validated = validateChapterStructureContract(candidate, input.skeleton.chapterNumber)
          validateChapterResourceBudgetCompleteness(
            input.workId,
            input.skeleton.chapterNumber,
            input.previousBudgets,
            validated.resourceBudgets
          )
          return validated
        } catch (error) {
          const missing = missingChapterStructureFields(candidate)
          if (/资源|resource_budget/.test(error instanceof Error ? error.message : String(error))) {
            missing.push('resource_budget')
          }
          if (missing.length > 0) {
            partialContract = candidate
            missingFields = [...new Set(missing)]
          } else {
            partialContract = null
            missingFields = []
          }
          throw error
        }
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/finishReason=length|长度上限|输出.*截断/.test(message)) {
      throw new NovelPipelineError(
        'OUTPUT_TRUNCATED',
        `第 ${input.skeleton.chapterNumber} 章结构合同在动态扩容重试后仍被截断，已保留前序章节检查点：${message}`
      )
    }
    throw error
  }
}

async function enrichChapterSkeletons(input: {
  workId: number
  goal: string
  volume: NovelVolumeContract
  skeletons: NovelChapterSkeleton[]
  existingItems?: NovelOutlineBatchItem[]
  signal?: AbortSignal
  onProgress?: (message: string) => void
  onCheckpoint?: (items: NovelOutlineBatchItem[]) => void
}): Promise<NovelOutlineBatchItem[]> {
  const previousChapter = volumeChapterDAO.listChaptersByWork(input.workId).at(-1)
  const previousBudgets = new Map<string, ChapterResourceBudgetInput>()
  if (previousChapter) {
    for (const budget of resourceLedgerDAO.listBudgetsByChapter(input.workId, previousChapter.id)) {
      previousBudgets.set(budgetKey(budget), budget)
    }
  }
  const recentOutlineContext = formatRecentOutlineContext(input.workId)
  const items: NovelOutlineBatchItem[] = (input.existingItems ?? []).slice(0, input.skeletons.length)
  const budgetRows: Array<{ chapterNumber: number; budgets: ChapterResourceBudgetInput[] }> = items.map((item, index) => ({
    chapterNumber: input.skeletons[index].chapterNumber,
    budgets: item.resourceBudgets
  }))
  for (const item of items) {
    for (const budget of item.resourceBudgets) previousBudgets.set(budgetKey(budget), budget)
  }
  for (let index = items.length; index < input.skeletons.length; index++) {
    const skeleton = input.skeletons[index]
    input.onProgress?.(`正在补全第 ${skeleton.chapterNumber} 章结构合同（${index + 1}/${input.skeletons.length}）`)
    const contract = await generateChapterStructureContract({
      workId: input.workId,
      goal: input.goal,
      volume: input.volume,
      skeleton,
      previousBudgets,
      recentOutlineContext,
      signal: input.signal
    })
    budgetRows.push({ chapterNumber: skeleton.chapterNumber, budgets: contract.resourceBudgets })
    for (const budget of contract.resourceBudgets) previousBudgets.set(budgetKey(budget), budget)
    const diagnosis = {
      arc_phase: skeleton.arcPhase,
      dramatic_contract: contract.dramaticContract,
      pattern_contract: contract.patternContract,
      tension_plan: { level: skeleton.tensionLevel, payoff_type: skeleton.payoffType }
    }
    items.push({
      title: skeleton.title,
      outline: skeleton.outline,
      arcPhase: skeleton.arcPhase,
      payoffRole: skeleton.payoffRole,
      foreshadowTarget: skeleton.foreshadowTarget,
      nextHook: skeleton.nextHook,
      characters: skeleton.characters,
      outlineDiagnosis: JSON.stringify(diagnosis),
      emotionContract: null,
      resourceBudgets: contract.resourceBudgets
    })
    input.onCheckpoint?.([...items])
  }
  validateResourceBudgets(input.workId, previousChapter?.id ?? null, budgetRows)
  return items
}

async function assessGoldenThreeOutlineBatch(
  workId: number,
  goal: string,
  items: NovelChapterSkeleton[],
  signal?: AbortSignal
): Promise<{ passed: boolean; score: number; issues: string[] }> {
  const firstThree = items.slice(0, 3)
  if (firstThree.length < 3) {
    return { passed: false, score: 0, issues: ['首批章节未完整包含第1至3章'] }
  }
  return requestStructuredModelOutput<{ passed: boolean; score: number; issues: string[] }>({
    workId,
    label: '黄金前三章门禁',
    attempts: GOLDEN_THREE_GATE_MAX_ATTEMPTS,
    signal,
    request: (attempt, lastError) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_novel_golden_three_gate',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        maxTokens: goldenThreeGateTokenBudget(attempt),
        systemPrompt: [
          '你是长篇网文黄金前三章门禁主编。只输出合法 JSON，不要 markdown 或解释。',
          goldenOutlineContract('novel', 1, 3),
          retentionEvaluationRules('novel'),
          '必须联合判断三章是否形成“立钩子→扩承诺→首兑现”的连续因果链，而非分别给三篇大纲挑文笔问题。',
          'score 低于85或存在 blocking_issues 时 passed=false。',
          '格式：{"passed":false,"score":78,"blocking_issues":["第3章没有兑现前两章承诺"],"repair_direction":"可直接用于重生成的具体要求"}'
        ].join('\n'),
        prompt: [
          `【用户目标】\n${goal.trim() || '自动策划一部长篇小说'}`,
          `【黄金前三章大纲】\n${JSON.stringify(firstThree, null, 2)}`,
          attempt > 1 ? `【上次协议错误】\n${lastError}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    ),
    validate: parsed => {
      const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)))
      const issues = Array.isArray(parsed.blocking_issues)
        ? parsed.blocking_issues.map(String).map(value => value.trim()).filter(Boolean)
        : []
      const direction = String(parsed.repair_direction ?? '').trim()
      if (parsed.passed !== true && direction) issues.push(direction)
      return {
        passed: parsed.passed === true && score >= 85 && issues.length === 0,
        score,
        issues
      }
    }
  })
}

export async function prepareNovelVolumePlan(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ volumes: number; revised: boolean }> {
  const targetChapters = loadWritingPlan(workId).targetChapters || 10
  const state = readNovelGoalState(workId)
  const compatibleOutline = state.novelOutline?.version === 2
    && state.novelOutline.targetChapters === targetChapters
    ? state.novelOutline
    : undefined
  if (!compatibleOutline && volumeChapterDAO.listChaptersByWork(workId).length > 0) {
    throw new NovelPipelineError(
      'PREREQUISITE_MISSING',
      '分卷规划规则已升级，但作品已有章节，不能自动重新分卷；请先备份并确认现有章节的迁移方式'
    )
  }
  let volumePlan = compatibleOutline?.volumePlan ?? []
  const expectedVolumes = planNovelVolumeRanges(targetChapters).length
  volumePlan = validatePartialVolumePlan(volumePlan, targetChapters)
  if (volumePlan.length < expectedVolumes) {
    onProgress?.(
      volumePlan.length > 0
        ? `检测到分卷生成断点：已完成 ${volumePlan.length}/${expectedVolumes} 卷，从下一卷继续`
        : `正在分卷生成全书大纲（共 ${expectedVolumes} 卷，每卷完成后自动保存）`
    )
    while (volumePlan.length < expectedVolumes) {
      if (signal?.aborted) throw new Error('已取消')
      const nextIndex = volumePlan.length + 1
      onProgress?.(`正在生成第 ${nextIndex}/${expectedVolumes} 卷合同`)
      const next = await generateNextVolumeContract(workId, goal, targetChapters, volumePlan, signal)
      volumePlan = validatePartialVolumePlan([...volumePlan, next], targetChapters)
      // 每卷都是独立检查点。超时、退出或应用重启后均从下一个缺失卷恢复。
      updateNovelGoalState(workId, {
        novelOutline: { version: 2, targetChapters, volumePlan },
        volumePlanChecked: false,
        volumeQualityReport: undefined,
        checkedChapterVolumes: undefined,
        chapterVolumeGateResults: undefined,
        pendingChapterVolumeGate: undefined,
        chapterVolumeGateCheckpoint: undefined,
        checkedBodyVolumes: undefined
      })
      onProgress?.(`第 ${nextIndex}/${expectedVolumes} 卷已保存`)
    }
    volumePlan = validateVolumePlan(volumePlan, targetChapters)
    updateNovelGoalState(workId, {
      novelOutline: { version: 2, targetChapters, volumePlan },
      volumePlanChecked: false,
      volumeQualityReport: undefined,
      checkedChapterVolumes: undefined,
      chapterVolumeGateResults: undefined,
      pendingChapterVolumeGate: undefined,
      chapterVolumeGateCheckpoint: undefined,
      checkedBodyVolumes: undefined,
      failure: undefined
    })
    onProgress?.(`全书分卷大纲已生成：${volumePlan.length} 卷`)
  } else {
    volumePlan = validateVolumePlan(volumePlan, targetChapters)
    updateNovelGoalState(workId, {
      novelOutline: { version: 2, targetChapters, volumePlan }
    })
  }

  let revised = false
  const latestState = readNovelGoalState(workId)
  if (!latestState.volumePlanChecked) {
    let gateRound = 0
    let gate: Awaited<ReturnType<typeof diagnoseVolumePlan>> | undefined
    while (gateRound < MAX_GATE_REPAIR_ROUNDS) {
      gateRound++
      onProgress?.(`正在诊断 ${volumePlan.length} 卷之间的逻辑与质量（第 ${gateRound} 轮）`)
      gate = await diagnoseVolumePlan(workId, goal, volumePlan, signal)
      if (gate.passed) break
      revised = true
      onProgress?.(`分卷质量门禁未通过，正在第 ${gateRound} 轮整体修订全书分卷大纲`)
      volumePlan = await reviseVolumePlan(workId, goal, targetChapters, volumePlan, gate.report, signal)
    }
    if (!gate?.passed) {
      throw new NovelPipelineError(
        'CONTRACT_INVALID',
        `全书分卷大纲连续 ${MAX_GATE_REPAIR_ROUNDS} 轮未通过质量门禁，请调整设定或模型后重试`
      )
    }
    updateNovelGoalState(workId, {
      novelOutline: { version: 2, targetChapters, volumePlan },
      volumePlanChecked: true,
      volumeQualityReport: gate.report,
      checkedChapterVolumes: revised ? undefined : latestState.checkedChapterVolumes,
      chapterVolumeGateResults: revised ? undefined : latestState.chapterVolumeGateResults,
      pendingChapterVolumeGate: undefined,
      chapterVolumeGateCheckpoint: undefined
    })
  }
  materializeVolumePlan(workId, volumePlan)
  onProgress?.(`分卷质量门禁通过，已冻结 ${volumePlan.length} 卷`)
  return { volumes: volumePlan.length, revised }
}

export async function generateNextNovelOutlineBatch(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<NovelOutlineBatchResult> {
  const writingPlan = loadWritingPlan(workId)
  const targetChapters = writingPlan.targetChapters || 10
  const existing = volumeChapterDAO.listChaptersByWork(workId)
  if (existing.length > targetChapters) {
    throw new NovelPipelineError('CONTRACT_INVALID', `现有章节数 ${existing.length} 超过目标章节数 ${targetChapters}`)
  }
  let state = readNovelGoalState(workId)
  if (state.chapterSkeletonProtocolVersion !== CHAPTER_SKELETON_PROTOCOL_VERSION) {
    updateNovelGoalState(workId, {
      chapterSkeletonProtocolVersion: CHAPTER_SKELETON_PROTOCOL_VERSION,
      pendingChapterSkeletonBatch: undefined,
      failure: state.failure?.phase === 'generate_beats' ? undefined : state.failure
    })
    state = readNovelGoalState(workId)
  }
  const invalidExisting = existing.find(chapter =>
    !chapter.title?.trim()
    || !chapter.outline?.trim()
    || !chapter.outline_diagnosis?.trim()
    || !chapter.next_hook?.trim()
    || !['A', 'B', 'C'].includes(chapter.beat_role ?? '')
  )
  if (invalidExisting) {
    throw new NovelPipelineError(
      'PREREQUISITE_MISSING',
      `已有章节「${invalidExisting.title || invalidExisting.id}」缺少长篇章节合同，请先重建该章大纲后再继续目标循环`
    )
  }
  if (!state.chapterSkeletonAuthorityLedger) {
    const migratedLedger = materializeChapterSkeletonAuthorityLedger(
      existing.at(-1)?.outline ?? '',
      existing.length
    )
    updateNovelGoalState(workId, { chapterSkeletonAuthorityLedger: migratedLedger })
    state = readNovelGoalState(workId)
    onProgress?.(`已将第 ${existing.length} 章边界迁移为结构化章节权威账本`)
  }
  validateChapterSkeletonAuthorityLedger(state.chapterSkeletonAuthorityLedger, existing.length)
  if (!state.novelOutline || state.novelOutline.targetChapters !== targetChapters || !state.volumePlanChecked) {
    throw new NovelPipelineError('PREREQUISITE_MISSING', '分卷大纲尚未通过质量门禁，不能生成章节大纲')
  }
  const volumePlan = validateVolumePlan(state.novelOutline.volumePlan, targetChapters)
  await ensurePleasureEngineMatchesVolumePlan(workId, goal, volumePlan, signal, onProgress)
  const alignedState = readNovelGoalState(workId)
  const requiredFingerprint = pleasureVolumeFingerprint(workId, volumePlan)
  const pleasureGate = validatePleasureEngineScale(workId)
  if (alignedState.pleasureVolumeFingerprint !== requiredFingerprint || !pleasureGate.valid) {
    throw new NovelPipelineError('PREREQUISITE_MISSING', `爽点机制分卷映射门禁未通过：${pleasureGate.reason || '映射版本不一致'}`)
  }

  const workflow = resolveNovelVolumeWorkflowCheckpoint(
    volumePlan,
    existing,
    alignedState.checkedChapterVolumes,
    alignedState.checkedBodyVolumes
  )

  const checkCompletedVolume = async (contract: NovelVolumeContract): Promise<{
    volume: string
    score: number
    rounds: number
  }> => {
    updateNovelGoalState(workId, { pendingChapterVolumeGate: contract.name })
    const result = await runVolumeChapterGate(workId, goal, contract, signal, onProgress)
    const latest = readNovelGoalState(workId)
    const volumeRows = volumeChapterDAO.listVolumes(workId)
    const completedVolume = volumeRows.find(item => item.name === contract.name)
    const snapshotFingerprint = completedVolume
      ? volumeGateSnapshotFingerprint(volumeChapterDAO.listChapters(completedVolume.id))
      : ''
    const gateResult = {
      volume: contract.name,
      status: 'passed' as const,
      score: result.score,
      rounds: result.rounds,
      completedAt: new Date().toISOString(),
      snapshotFingerprint,
      issues: []
    }
    updateNovelGoalState(workId, {
      pendingChapterVolumeGate: undefined,
      chapterVolumeGateCheckpoint: undefined,
      checkedChapterVolumes: [...new Set([...(latest.checkedChapterVolumes ?? []), contract.name])],
      volumeGateDeferredIssues: (latest.volumeGateDeferredIssues ?? [])
        .filter(item => item.volume !== contract.name),
      chapterVolumeGateResults: [
        ...(latest.chapterVolumeGateResults ?? []).filter(item => item.volume !== contract.name),
        gateResult
      ]
    })
    return { volume: contract.name, ...result }
  }

  if (workflow.kind === 'outline_gate') {
    const volumeGate = await checkCompletedVolume(workflow.volume)
    const refreshed = volumeChapterDAO.listChaptersByWork(workId)
    return {
      created: 0,
      reused: refreshed.length,
      remaining: targetChapters - refreshed.length,
      complete: refreshed.length === targetChapters,
      volumeGate,
      volumeReadyForDraft: workflow.volume.name
    }
  }

  if (workflow.kind === 'draft_body' || workflow.kind === 'body_gate') {
    return {
      created: 0,
      reused: existing.length,
      remaining: targetChapters - existing.length,
      complete: existing.length === targetChapters,
      volumeReadyForDraft: workflow.volume.name
    }
  }

  if (workflow.kind === 'complete') {
    return {
      created: 0,
      reused: existing.length,
      remaining: 0,
      complete: true
    }
  }

  const volume = workflow.volume
  const start = workflow.nextChapter!
  const batchProfile = planNovelChapterBatch(
    start,
    volume.endChapter,
    state.failure?.phase === 'generate_beats' ? state.failure.message : undefined
  )
  const end = batchProfile.end
  const volumeFingerprint = createHash('sha256').update(JSON.stringify(volume)).digest('hex')
  onProgress?.(`正在生成章节大纲第 ${start}-${end} 章（剩余 ${targetChapters - existing.length} 章）`)
  let correction = state.failure?.phase === 'generate_beats' ? state.failure.message : undefined
  const pendingSkeletons = state.pendingChapterSkeletonBatch
  const sourceLedger = validateChapterSkeletonAuthorityLedger(
    alignedState.chapterSkeletonAuthorityLedger,
    existing.length
  )
  const canResumeSkeletons = pendingSkeletons?.protocolVersion === CHAPTER_SKELETON_PROTOCOL_VERSION
    && pendingSkeletons.volumeName === volume.name
    && pendingSkeletons.volumeFingerprint === volumeFingerprint
    && pendingSkeletons.start === start
    && pendingSkeletons.end === end
    && pendingSkeletons.skeletons.length === end - start + 1
    && pendingSkeletons.authorityLedger.lastCommittedChapter === end
    && (pendingSkeletons.items?.length ?? 0) <= pendingSkeletons.skeletons.length
  let skeletons: NovelChapterSkeleton[] = canResumeSkeletons ? pendingSkeletons!.skeletons : []
  let authorityLedger = canResumeSkeletons ? pendingSkeletons!.authorityLedger : sourceLedger
  if (canResumeSkeletons) {
    onProgress?.(
      `检测到第 ${start}-${end} 章骨架检查点和 ${pendingSkeletons?.items?.length ?? 0} 章已完成合同，继续补全剩余单章合同`
    )
  } else {
    for (let round = 1; round <= MAX_GATE_REPAIR_ROUNDS; round++) {
      const generated = await generateChapterSkeletonBatch({
        workId, goal, volume, start, end, correction, signal, sourceLedger
      })
      skeletons = generated.skeletons
      authorityLedger = generated.authorityLedger
      if (start !== 1 || end < 3) break
      onProgress?.(`正在执行黄金前三章联合门禁（第 ${round} 轮）`)
      const gate = await assessGoldenThreeOutlineBatch(workId, goal, skeletons, signal)
      if (gate.passed) {
        onProgress?.(`黄金前三章联合门禁通过（${gate.score}分）`)
        break
      }
      if (round === MAX_GATE_REPAIR_ROUNDS) {
        throw new NovelPipelineError(
          'CONTRACT_INVALID',
          `黄金前三章连续 ${MAX_GATE_REPAIR_ROUNDS} 轮未通过门禁：${gate.issues.join('；') || `${gate.score}分`}`
        )
      }
      correction = `黄金前三章门禁未通过（${gate.score}分），必须整体重建第1至3章：${gate.issues.join('；')}`
      onProgress?.(`黄金前三章骨架未通过（${gate.score}分），正在整体重建骨架`)
    }
    updateNovelGoalState(workId, {
      pendingChapterSkeletonBatch: {
        protocolVersion: CHAPTER_SKELETON_PROTOCOL_VERSION,
        authorityLedger,
        volumeName: volume.name,
        volumeFingerprint,
        start,
        end,
        skeletons,
        items: []
      }
    })
    onProgress?.(`第 ${start}-${end} 章骨架已冻结，后续结构合同失败不会重抽骨架`)
  }
  const items = await enrichChapterSkeletons({
    workId,
    goal,
    volume,
    skeletons,
    existingItems: canResumeSkeletons ? pendingSkeletons?.items : undefined,
    signal,
    onProgress,
    onCheckpoint: completedItems => updateNovelGoalState(workId, {
      pendingChapterSkeletonBatch: {
        protocolVersion: CHAPTER_SKELETON_PROTOCOL_VERSION,
        authorityLedger,
        volumeName: volume.name,
        volumeFingerprint,
        start,
        end,
        skeletons,
        items: completedItems
      }
    })
  })
  const volumeIndex = volumePlan.findIndex(item => item.name === volume.name)
  const authorityStateUpdate = prepareNovelAuthorityStateUpdate(workId, {
    chapterSkeletonAuthorityLedger: authorityLedger
  })
  novelOutlineDAO.commitBatch({
    workId,
    volumeName: volume.name,
    volumeDescription: volume.description,
    volumeSort: volumeIndex + 1,
    volumeStartChapter: volume.startChapter,
    volumeEndChapter: volume.endChapter,
    chapterStartSort: start - volume.startChapter + 1,
    items,
    authorityStateUpdate
  })
  updateNovelGoalState(workId, { pendingChapterSkeletonBatch: undefined })

  const total = volumeChapterDAO.listChaptersByWork(workId).length
  if (total !== end) {
    throw new NovelPipelineError('CONTRACT_INVALID', `批次提交后章节总数异常：期望 ${end}，实际 ${total}`)
  }
  const volumeGate = end === volume.endChapter
    ? await checkCompletedVolume(volume)
    : undefined
  return {
    created: items.length,
    reused: existing.length,
    remaining: targetChapters - total,
    complete: total === targetChapters,
    range: { start, end },
    volumeGate,
    volumeReadyForDraft: volumeGate ? volume.name : undefined
  }
}
