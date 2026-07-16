import { createHash } from 'node:crypto'
import {
  goalRoutineDAO,
  coreSettingDAO,
  novelOutlineDAO,
  resourceLedgerDAO,
  volumeChapterDAO,
  type ChapterResourceBudgetInput,
  type NovelOutlineBatchItem,
  type ChapterPatternFingerprintRow
} from '../../db'
import { modelService } from '../../model'
import { buildWorkContext } from '../work-context'
import { extractJsonText } from '../parse-json-extract'
import { formatResourceConstraintsForPrompt, normalizeChapterResourceBudgets } from '../resource-ledger'
import { outlineConstraintsForWordTarget } from '../../../shared/outline-constraints'
import { DEFAULT_WORDS_PER_CHAPTER } from '../../../shared/writing-plan-presets'
import { loadWritingPlan } from '../writing-plan'
import { withGoalLoopModelOptions } from './story-goal-model'
import { normalizeEmotionContract, validateEmotionContract } from '../../../shared/emotion-contract'
import { EMOTION_CONTRACT_JSON_SHAPE } from './emotion-engine'
import type { GoalCheckResult } from './story-goal-checker'
import { goldenOutlineContract } from '../../../shared/golden-opening'
import { retentionEvaluationRules, retentionPlanningRules } from './reader-retention'
import {
  formatNovelScaleContract,
  novelScaleFingerprint,
  validatePleasureEngineScale
} from './novel-scale-contract'
import { detectChapterPatternIssues } from './novel-systemic-gate'

const OUTLINE_BATCH_SIZE = 1
const GOLDEN_OPENING_BATCH_SIZE = 3
const MAX_GATE_REPAIR_ROUNDS = 4
const MAX_VOLUME_CHAPTER_GATE_REPAIR_ROUNDS = 2
const TARGET_CHAPTERS_PER_VOLUME = 42
const MAX_CHAPTERS_PER_VOLUME = 50
export const VOLUME_CONTRACT_MAX_TOKENS = 3200
export const VOLUME_CONTEXT_CHAR_LIMIT = 8000
export const NOVEL_SINGLE_CHAPTER_MAX_TOKENS = 6000
export const NOVEL_VOLUME_GATE_MAX_WINDOW_SIZE = 8
export const NOVEL_VOLUME_GATE_MAX_REPAIR_CLUSTER = 2
export const NOVEL_VOLUME_GATE_MAX_REPAIR_TARGETS_PER_ISSUE = 4
export const NOVEL_VOLUME_GATE_MAX_REPAIRED_CHAPTERS = 6
export const NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER = 1
const NOVEL_VOLUME_GATE_ASSESS_MAX_TOKENS = 2400

const NOVEL_VOLUME_GATE_HARD_ISSUE_CODES = new Set([
  'STATE_CONTINUITY_BREAK',
  'RESOURCE_CONTINUITY_BREAK',
  'CAST_CONTINUITY_BREAK',
  'GEOGRAPHY_CONTINUITY_BREAK',
  'GEOGRAPHY_BOUNDARY_VIOLATION',
  'FORBIDDEN_BOUNDARY_VIOLATION',
  'SETUP_PAYOFF_MISMATCH'
])

const NOVEL_VOLUME_GATE_REPAIR_FIELDS = [
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
  'dramatic_contract.next_question'
] as const

const NOVEL_VOLUME_GATE_ASSESSMENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'issues', 'summary'],
  properties: {
    score: { type: 'integer', minimum: 0, maximum: 100 },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'code', 'problem', 'repairCandidates', 'evidence', 'requiredOutcome'],
        properties: {
          severity: { type: 'string', enum: ['hard', 'advisory'] },
          code: { type: 'string', minLength: 1, maxLength: 64 },
          problem: { type: 'string', minLength: 1, maxLength: 1200 },
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
          requiredOutcome: { type: 'string', minLength: 1, maxLength: 1200 }
        }
      }
    },
    summary: { type: 'string', maxLength: 800 }
  }
}

const NOVEL_VOLUME_GATE_REPAIR_SCHEMA: Record<string, unknown> = {
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
                oldText: { type: 'string', minLength: 4, maxLength: 400 },
                newText: { type: 'string', minLength: 1, maxLength: 1200 }
              }
            }
          }
        }
      }
    }
  }
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
  lastRoundVersions: Array<{ chapterId: number; versionId: number }>
}

export interface NovelVolumeGateCheckpoint {
  version: 2
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
  lastCheck?: GoalCheckResult
  novelOutline?: NovelOutlineProgressState
  volumePlanChecked?: boolean
  volumeQualityReport?: string
  checkedChapterVolumes?: string[]
  pendingChapterVolumeGate?: string
  chapterVolumeGateCheckpoint?: NovelVolumeGateCheckpoint
  checkedBodyVolumes?: string[]
  pleasureVolumeFingerprint?: string
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
  }
  failure?: {
    phase: string
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
  volumeGate?: { volume: string; score: number; rounds: number }
  volumeReadyForDraft?: string
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
    maxTokens: start === 1 ? 9000 : NOVEL_SINGLE_CHAPTER_MAX_TOKENS,
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
    public readonly code: 'OUTPUT_INVALID' | 'CONTRACT_INVALID' | 'PREREQUISITE_MISSING' | 'REPAIR_BOUNDARY' | 'REPAIR_STALL',
    message: string
  ) {
    super(message)
    this.name = 'NovelPipelineError'
  }
}

export function readNovelGoalState(workId: number): NovelGoalPersistentState {
  const raw = goalRoutineDAO.getByWork(workId)?.state_json
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? parsed as NovelGoalPersistentState : {}
  } catch {
    throw new NovelPipelineError('CONTRACT_INVALID', '目标循环状态损坏：state_json 不是合法 JSON')
  }
}

export function updateNovelGoalState(workId: number, patch: Partial<NovelGoalPersistentState>): void {
  const current = readNovelGoalState(workId)
  goalRoutineDAO.update(workId, { state_json: JSON.stringify({ ...current, ...patch }) })
}

function parseObject(content: string, label: string): Record<string, unknown> {
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

function textField(row: Record<string, unknown>, key: string, label: string): string {
  const value = String(row[key] ?? '').trim()
  if (!value) throw new NovelPipelineError('CONTRACT_INVALID', `${label}缺少字段 ${key}`)
  return value
}

function intField(row: Record<string, unknown>, key: string, label: string): number {
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

function validateVolumePlan(raw: unknown, targetChapters: number): NovelVolumeContract[] {
  const plan = validatePartialVolumePlan(raw, targetChapters)
  const expectedVolumes = planNovelVolumeRanges(targetChapters).length
  if (plan.length !== expectedVolumes) {
    throw new NovelPipelineError('CONTRACT_INVALID', `分卷合同必须包含 ${expectedVolumes} 卷，实际 ${plan.length} 卷`)
  }
  return plan
}

async function generateNextVolumeContract(
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
  const baseRequest = withGoalLoopModelOptions(workId, {
    workId,
    step: 'goal_novel_volume_plan',
    enrichWorkContext: false,
    enrichNarrativeMemory: false,
    maxTokens: profile.maxTokens,
    thinkingEnabled: false,
    forceThinkingDisabled: true,
    responseSchema: {
      name: 'novel_volume_contract',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['volume'],
        properties: {
          volume: {
            type: 'object',
            additionalProperties: false,
            required: [
              'name', 'description', 'startChapter', 'endChapter', 'objective', 'midpoint', 'climax',
              'irreversibleCost', 'nextDebt', 'mustResolve', 'mayCarryForward',
              'forbiddenNewThreadsAfterChapter', 'protagonistEndState', 'antagonistEndState'
            ],
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              startChapter: { type: 'integer', const: range.startChapter },
              endChapter: { type: 'integer', const: range.endChapter },
              objective: { type: 'string' },
              midpoint: { type: 'string' },
              climax: { type: 'string' },
              irreversibleCost: { type: 'string' },
              nextDebt: { type: 'string' },
              mustResolve: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
              mayCarryForward: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
              forbiddenNewThreadsAfterChapter: {
                type: 'integer', minimum: range.startChapter, maximum: range.endChapter
              },
              protagonistEndState: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } },
              antagonistEndState: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' } }
            }
          }
        }
      }
    },
    systemPrompt: [
      '你是长篇小说总架构师。只输出合法 JSON 对象，不要 markdown、前言或解释。',
      `全书共 ${suggestedVolumes} 卷；本次只设计第 ${index + 1} 卷，禁止输出其他卷。`,
      '本卷必须形成阶段闭环，同时留下因果驱动下一卷的新债务；终卷必须完成全书主线清算。',
      previous ? '本卷 objective 必须由上一卷 nextDebt 直接驱动，不能另起无关主线。' : '首卷必须建立核心冲突并完成首个阶段兑现。',
      `startChapter 和 endChapter 必须分别严格输出 ${range.startChapter} 和 ${range.endChapter}。`,
      '严格控制篇幅：description 不超过180字；objective、midpoint、climax各不超过120字；其余字符串不超过100字；每个数组1-3项且每项不超过80字。',
      '优先保证 JSON 完整闭合；不得把章节级事件清单塞进字段，不得在一个字符串中使用编号长篇扩写。',
      `格式：{"volume":{"name":"第${index + 1}卷 名称","description":"核心冲突与升级路径","startChapter":${range.startChapter},"endChapter":${range.endChapter},"objective":"阶段目标","midpoint":"中点反转","climax":"卷高潮与兑现","irreversibleCost":"永久代价","nextDebt":"${nextRange ? '留给下一卷的未偿债务' : '终卷清算后不可逆余波'}","mustResolve":["本卷必须闭环的承诺"],"mayCarryForward":["${nextRange ? '允许跨卷的债务' : '终卷余波'}"],"forbiddenNewThreadsAfterChapter":${Math.max(range.startChapter, range.endChapter - 5)},"protagonistEndState":["卷末主角状态"],"antagonistEndState":["卷末对手状态"]}}`
    ].join('\n'),
    prompt: [
      `【用户目标】\n${goal.trim() || '自动策划一部长篇小说'}`,
      `【目标章节数】${targetChapters}`,
      `【当前任务】第 ${index + 1}/${suggestedVolumes} 卷，章节 ${range.startChapter}-${range.endChapter}`,
      previous ? `【上一卷合同（必须承接）】\n${JSON.stringify(previous)}` : '',
      completed.length > 1 ? `【此前各卷因果摘要】\n${JSON.stringify(completed.map(volume => ({ name: volume.name, objective: volume.objective, climax: volume.climax, nextDebt: volume.nextDebt })))}` : '',
      `【核心设定（${profile.compact ? '超时降级摘要' : '已压缩'}）】\n${ctx.text.slice(0, profile.contextChars)}`
    ].join('\n\n')
  })
  const response = await modelService.chat(
    // 分卷合同是严格结构化任务。关闭思考可避免隐藏推理占满输出预算；
    // 此处必须覆盖目标循环的全局思考开关。
    { ...baseRequest, thinkingEnabled: false },
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`第 ${index + 1} 卷合同生成失败：${response.error || '模型未返回内容'}`)
  }
  if (response.finishReason === 'length') {
    throw new NovelPipelineError(
      'OUTPUT_INVALID',
      `VOLUME_OUTPUT_TRUNCATED：第 ${index + 1} 卷输出达到长度上限（finishReason=length），将提高输出预算后从本卷重试`
    )
  }
  let parsed: Record<string, unknown>
  try {
    parsed = parseObject(response.content, `第 ${index + 1} 卷合同`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Unterminated string|Unexpected end of JSON|end of data/i.test(message)) {
      throw new NovelPipelineError(
        'OUTPUT_INVALID',
        `VOLUME_OUTPUT_TRUNCATED：第 ${index + 1} 卷 JSON 被截断，将提高输出预算后从本卷重试；${message}`
      )
    }
    throw error
  }
  return normalizeVolumeContract(parsed.volume, index, range)
}

async function diagnoseVolumePlan(
  workId: number,
  goal: string,
  plan: NovelVolumeContract[],
  signal?: AbortSignal
): Promise<{ passed: boolean; report: string }> {
  const response = await modelService.chat(
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
      prompt: `【创作目标】\n${goal.trim() || '完成一部长篇小说'}\n\n【全书分卷合同】\n${JSON.stringify(plan, null, 2)}`
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) throw new Error(response.error || '分卷质量门禁未返回结果')
  const parsed = parseObject(response.content, '分卷质量门禁')
  if (typeof parsed.passed !== 'boolean' || !Array.isArray(parsed.issues)) {
    throw new NovelPipelineError('OUTPUT_INVALID', '分卷质量门禁缺少 passed 或 issues')
  }
  return { passed: parsed.passed, report: JSON.stringify(parsed) }
}

async function reviseVolumePlan(
  workId: number,
  goal: string,
  targetChapters: number,
  plan: NovelVolumeContract[],
  report: string,
  signal?: AbortSignal
): Promise<NovelVolumeContract[]> {
  const plannedRanges = planNovelVolumeRanges(targetChapters)
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_novel_volume_revise',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      maxTokens: 6000,
      systemPrompt: [
        '你是长篇小说总架构修订师。只输出合法 JSON，不要 markdown 或解释。',
        `必须保留恰好 ${plannedRanges.length} 卷。`,
        'startChapter 和 endChapter 必须逐项照抄用户消息中的预设范围，不得重新分配、合并或拆分。',
        '逐项修复门禁报告；上一卷 nextDebt 必须直接驱动下一卷 objective；冲突、高潮、成长和不可逆代价必须逐卷升级。',
        '输出格式与输入相同：{"volumes":[...]}'
      ].join('\n'),
      prompt: [
        `【创作目标】\n${goal.trim() || '完成一部长篇小说'}`,
        `【不可修改的分卷章节范围】\n${JSON.stringify(plannedRanges, null, 2)}`,
        `【当前分卷合同】\n${JSON.stringify({ volumes: plan }, null, 2)}`,
        `【门禁报告】\n${report}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) throw new Error(response.error || '分卷合同修订失败')
  const parsed = parseObject(response.content, '分卷合同修订')
  return validateVolumePlan(parsed.volumes, targetChapters)
}

function materializeVolumePlan(workId: number, plan: NovelVolumeContract[]): void {
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

function pleasureVolumeFingerprint(workId: number, plan: NovelVolumeContract[]): string {
  return [
    novelScaleFingerprint(loadWritingPlan(workId)),
    ...plan.map(volume => `${volume.name}:${volume.startChapter}-${volume.endChapter}`)
  ].join('|')
}

async function ensurePleasureEngineMatchesVolumePlan(
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

type VolumeGateChapter = ReturnType<typeof volumeChapterDAO.listChapters>[number]

function volumeGateSnapshotFingerprint(chapters: VolumeGateChapter[]): string {
  const hash = createHash('sha256')
  for (const chapter of chapters) {
    hash.update(JSON.stringify({
      id: chapter.id,
      update_time: chapter.update_time,
      title: chapter.title,
      outline: chapter.outline,
      beat_role: chapter.beat_role,
      foreshadow_target: chapter.foreshadow_target,
      next_hook: chapter.next_hook,
      characters: chapter.characters,
      outline_diagnosis: chapter.outline_diagnosis,
      emotion_contract_json: chapter.emotion_contract_json
    }))
  }
  return hash.digest('hex')
}

function volumeGateWindowFingerprint(input: {
  chapters: VolumeGateChapter[]
  contractStartChapter: number
  range: NovelVolumeRange
}): string {
  const firstIndex = Math.max(0, input.range.startChapter - input.contractStartChapter - 1)
  const lastIndex = Math.min(
    input.chapters.length - 1,
    input.range.endChapter - input.contractStartChapter + 1
  )
  return volumeGateSnapshotFingerprint(input.chapters.slice(firstIndex, lastIndex + 1))
}

export function checkNovelVolumeRepairBudget(input: {
  chapterNumbers: number[]
  control?: NovelVolumeGateRepairControl
}): { allowed: boolean; control: NovelVolumeGateRepairControl; reason?: string } {
  const chapterNumbers = [...new Set(input.chapterNumbers)].sort((a, b) => a - b)
  const current = input.control ?? {
    changedChapterNumbers: [],
    rewriteCounts: {},
    lastRoundVersions: []
  }
  const changed = new Set(current.changedChapterNumbers)
  for (const chapterNumber of chapterNumbers) changed.add(chapterNumber)
  if (changed.size > NOVEL_VOLUME_GATE_MAX_REPAIRED_CHAPTERS) {
    return {
      allowed: false,
      control: current,
      reason: `整卷自动修复将触及 ${changed.size} 章，超过安全上限 ${NOVEL_VOLUME_GATE_MAX_REPAIRED_CHAPTERS} 章`
    }
  }
  for (const chapterNumber of chapterNumbers) {
    const count = current.rewriteCounts[String(chapterNumber)] ?? 0
    if (count >= NOVEL_VOLUME_GATE_MAX_REWRITES_PER_CHAPTER) {
      return {
        allowed: false,
        control: current,
        reason: `第 ${chapterNumber} 章已自动修复 ${count} 次，禁止再次改写`
      }
    }
  }
  return {
    allowed: true,
    control: {
      ...current,
      changedChapterNumbers: [...changed].sort((a, b) => a - b)
    }
  }
}

function clampGateScore(value: unknown): number {
  const score = Number(value)
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0
}

function compactGateText(value: string | null | undefined, maxChars: number): string {
  const text = String(value ?? '').trim()
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}

function parseChapterDiagnosis(chapter: VolumeGateChapter): Record<string, unknown> {
  try {
    const parsed = JSON.parse(chapter.outline_diagnosis ?? '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    throw new NovelPipelineError('CONTRACT_INVALID', `章节「${chapter.title}」的结构合同不是合法 JSON`)
  }
}

function compactGateContractFields(value: unknown, keys: string[], maxChars: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const row = value as Record<string, unknown>
  return Object.fromEntries(keys.map(key => [key, compactGateText(String(row[key] ?? ''), maxChars)]))
}

function compactChapterForVolumeGate(chapter: VolumeGateChapter, chapterNumber: number): Record<string, unknown> {
  const diagnosis = parseChapterDiagnosis(chapter)
  const tension = diagnosis.tension_plan && typeof diagnosis.tension_plan === 'object' && !Array.isArray(diagnosis.tension_plan)
    ? diagnosis.tension_plan as Record<string, unknown>
    : {}
  return {
    chapterNumber,
    title: chapter.title,
    outline: compactGateText(chapter.outline, 1800),
    beat_role: chapter.beat_role,
    foreshadow_target: compactGateText(chapter.foreshadow_target, 240),
    next_hook: compactGateText(chapter.next_hook, 360),
    dramatic_contract: compactGateContractFields(diagnosis.dramatic_contract, [
      'scene_promise', 'protagonist_want', 'obstacle', 'stakes', 'turn',
      'irreversible_change', 'payoff_or_debt', 'next_question'
    ], 240),
    pattern_contract: compactGateContractFields(diagnosis.pattern_contract, [
      'conflict_type', 'protagonist_method', 'antagonist_tactic', 'anticipated_opponent_adjustment',
      'location_type', 'hook_type', 'cost_type', 'relationship_delta', 'volume_objective_delta'
    ], 180),
    tension_plan: {
      level: tension.level ?? '',
      payoff_type: tension.payoff_type ?? ''
    }
  }
}

function compactGateEvidence(value: string): string {
  return value.replace(/[\s“”‘’'"《》【】]/g, '')
}

/**
 * 弱模型偶尔会用省略号把同一章的多段原文拼成一条证据。
 * 先保留严格的连续子串匹配；只在存在显式省略号时拆分，并要求每个片段都在同一章输入中逐字命中。
 * 这是格式容错，不是语义模糊匹配：任一片段对不上仍然整条拒绝。
 */
export function locateNovelVolumeGateEvidenceFragments(source: string, quote: string): string[] {
  const normalizedSource = compactGateEvidence(source)
  const normalizedQuote = compactGateEvidence(quote)
  if (normalizedQuote.length >= 4 && normalizedSource.includes(normalizedQuote)) {
    return [quote.trim()]
  }

  if (!/(?:…{1,}|\.{3,})/u.test(quote)) return []
  const fragments = quote
    .split(/(?:…{1,}|\.{3,})/u)
    .map(fragment => fragment.trim())
    .filter(Boolean)
  if (fragments.length < 2 || fragments.length > 4) return []
  if (fragments.some(fragment => {
    const normalized = compactGateEvidence(fragment)
    return normalized.length < 4 || !normalizedSource.includes(normalized)
  })) return []
  return fragments
}

function chapterGateEvidence(chapter: VolumeGateChapter, chapterNumber: number): string {
  return compactGateEvidence(JSON.stringify(compactChapterForVolumeGate(chapter, chapterNumber)))
}

function normalizeVolumeGateIssueCode(value: unknown): string {
  const normalized = String(value ?? 'SEMANTIC_CONTRACT_ISSUE')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 64)
  return normalized || 'SEMANTIC_CONTRACT_ISSUE'
}

function boundedRepairCandidates(candidates: number[]): number[] {
  const unique = [...new Set(candidates)].sort((a, b) => a - b)
  // 跨章问题过大时优先修改后出现的合同，保留较早章节作为只读事实锚点。
  return unique.slice(-NOVEL_VOLUME_GATE_MAX_REPAIR_TARGETS_PER_ISSUE)
}

export function selectNovelVolumeGateRepairTargets(input: {
  repairCandidates?: number[]
  evidenceChapterNumbers: number[]
  editableChapterNumbers: number[]
}): number[] {
  const editable = new Set(input.editableChapterNumbers)
  const candidates = input.repairCandidates?.length
    ? input.repairCandidates
    : input.evidenceChapterNumbers.filter(number => editable.has(number))
  return boundedRepairCandidates(candidates.filter(number => editable.has(number)))
}

function parseModelVolumeGateIssues(input: {
  value: unknown
  label: string
  allowedEvidenceChapterNumbers: Set<number>
  editableChapterNumbers: Set<number>
  chaptersByNumber: Map<number, VolumeGateChapter>
}): NovelVolumeGateIssue[] {
  if (!Array.isArray(input.value)) {
    throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}缺少 issues 数组`)
  }
  return input.value.flatMap((value, issueIndex) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}第 ${issueIndex + 1} 个问题不是对象`)
    }
    const row = value as Record<string, unknown>
    const code = normalizeVolumeGateIssueCode(row.code)
    const declaredSeverity = String(row.severity ?? 'hard').trim().toLowerCase()
    const severity: 'hard' | 'advisory' = declaredSeverity === 'hard'
      && NOVEL_VOLUME_GATE_HARD_ISSUE_CODES.has(code)
      ? 'hard'
      : 'advisory'
    const problem = textField(row, 'problem', `${input.label}第 ${issueIndex + 1} 个问题`)
    const requiredFix = String(row.requiredOutcome ?? row.requiredFix ?? '').trim()
    if (!requiredFix) throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}问题「${problem}」缺少 requiredOutcome`)
    // 建议性问题只保留在模型 summary，不允许进入自动修复链。
    if (severity === 'advisory') return []
    if (!Array.isArray(row.evidence) || row.evidence.length === 0) {
      throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}问题「${problem}」没有逐字证据`)
    }
    let evidence: Array<{ chapterNumber: number; quote: string }>
    try {
      evidence = row.evidence.flatMap((rawEvidence, evidenceIndex) => {
        if (!rawEvidence || typeof rawEvidence !== 'object' || Array.isArray(rawEvidence)) {
          throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}问题「${problem}」第 ${evidenceIndex + 1} 条证据不是对象`)
        }
        const evidenceRow = rawEvidence as Record<string, unknown>
        const chapterNumber = intField(evidenceRow, 'chapterNumber', `${input.label}问题「${problem}」证据`)
        const quote = textField(evidenceRow, 'quote', `${input.label}问题「${problem}」证据`)
        const chapter = input.chaptersByNumber.get(chapterNumber)
        if (!input.allowedEvidenceChapterNumbers.has(chapterNumber) || !chapter) {
          throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}问题「${problem}」引用了证据范围外的第 ${chapterNumber} 章`)
        }
        const fragments = locateNovelVolumeGateEvidenceFragments(
          chapterGateEvidence(chapter, chapterNumber),
          quote
        )
        if (fragments.length === 0) {
          throw new NovelPipelineError('OUTPUT_INVALID', `${input.label}问题「${problem}」的第 ${chapterNumber} 章证据无法在输入合同中逐字定位`)
        }
        return fragments.map(fragment => ({ chapterNumber, quote: fragment }))
      })
    } catch (error) {
      // 弱模型的证据格式偏差不是小说合同错误：没有可定位证据就忽略该问题，不进入目标轮次重试。
      if (error instanceof NovelPipelineError && error.code === 'OUTPUT_INVALID') return []
      throw error
    }

    const rawCandidates = Array.isArray(row.repairCandidates)
      ? row.repairCandidates
      : Array.isArray(row.chapterNumbers)
        ? row.chapterNumbers // 兼容升级前的已返回结果和旧模型格式。
        : undefined
    const candidateNumbers = rawCandidates
      ? rawCandidates.map(Number)
      : evidence.map(item => item.chapterNumber).filter(number => input.editableChapterNumbers.has(number))
    if (candidateNumbers.some(number => !Number.isInteger(number) || !input.editableChapterNumbers.has(number))) {
      return []
    }
    const repairChapterNumbers = selectNovelVolumeGateRepairTargets({
      repairCandidates: candidateNumbers,
      evidenceChapterNumbers: evidence.map(item => item.chapterNumber),
      editableChapterNumbers: [...input.editableChapterNumbers]
    })
    if (repairChapterNumbers.length === 0) {
      return []
    }
    return [{ source: 'model', severity, code, problem, repairChapterNumbers, evidence, requiredFix }]
  })
}

function parseVolumeGateAssessment(input: {
  content: string
  label: string
  key: string
  startChapter: number
  endChapter: number
  allowedEvidenceChapterNumbers: Set<number>
  editableChapterNumbers: Set<number>
  chaptersByNumber: Map<number, VolumeGateChapter>
}): NovelVolumeGateAssessment {
  const parsed = parseObject(input.content, input.label)
  const issues = parseModelVolumeGateIssues({
    value: parsed.issues,
    label: input.label,
    allowedEvidenceChapterNumbers: input.allowedEvidenceChapterNumbers,
    editableChapterNumbers: input.editableChapterNumbers,
    chaptersByNumber: input.chaptersByNumber
  })
  const score = clampGateScore(parsed.score)
  return {
    key: input.key,
    startChapter: input.startChapter,
    endChapter: input.endChapter,
    // 分数只用于诊断展示；弱模型的主观分数不能单独触发重写。
    passed: issues.length === 0,
    score,
    summary: compactGateText(String(parsed.summary ?? ''), 600),
    issues
  }
}

async function assessVolumeChapterWindow(input: {
  workId: number
  goal: string
  contract: NovelVolumeContract
  chapters: VolumeGateChapter[]
  range: NovelVolumeRange
  signal?: AbortSignal
}): Promise<NovelVolumeGateAssessment> {
  const chaptersByNumber = new Map(input.chapters.map((chapter, index) => [input.contract.startChapter + index, chapter]))
  const targetNumbers = Array.from(
    { length: input.range.endChapter - input.range.startChapter + 1 },
    (_, index) => input.range.startChapter + index
  )
  const contextNumbers = [input.range.startChapter - 1, input.range.endChapter + 1]
    .filter(number => chaptersByNumber.has(number))
  const key = `${input.range.startChapter}-${input.range.endChapter}`
  const response = await modelService.chat(
    withGoalLoopModelOptions(input.workId, {
      workId: input.workId,
      step: 'goal_novel_volume_chapter_gate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.2,
      thinkingEnabled: false,
      forceThinkingDisabled: true,
      maxTokens: NOVEL_VOLUME_GATE_ASSESS_MAX_TOKENS,
      responseSchema: {
        name: 'novel_volume_chapter_gate_assessment',
        schema: NOVEL_VOLUME_GATE_ASSESSMENT_SCHEMA,
        strict: true
      },
      systemPrompt: [
        '你是长篇小说章节合同门禁。只读评估，不得输出修复后的章节，只输出合法 JSON。',
        '只检查当前窗口：因果链、冲突升级、阶段目标推进、角色选择与代价、伏笔、功能重复、节奏断层，以及与相邻章的接口。',
        '本卷合同用于判断方向，但不得因为个人文风偏好或没有证据的猜测压低分数。',
        'severity=hard 只用于两段输入中已经同时存在、可直接互斥的状态事实；“可能误解、执行时可能出错、节奏可优化、存在风险”一律是 advisory，只写入 summary，不得放入 issues。',
        `hard code 仅允许：${[...NOVEL_VOLUME_GATE_HARD_ISSUE_CODES].join('、')}；功能重复、节奏、文风与信息密度不得触发自动修复。`,
        'evidence 可引用当前窗口或相邻只读上下文；每条 quote 只摘录一段 4-80 字的连续原文，必须逐字摘自输入中的 title、outline、next_hook 或结构合同。',
        '禁止在 quote 中改写、概括，或用“……”拼接两段原文；需要两段证据时必须输出两个 evidence 项。',
        'repairCandidates 只列当前窗口内真正可能需要修改的章节，不得包含相邻只读章节；可以超过2章，程序会按最小安全簇拆分。',
        '只报告阻断问题；没有逐字证据不得列问题或压低分数。passed 由程序根据证据计算，不要输出。',
        '格式：{"score":88,"issues":[{"severity":"hard","code":"STATE_CONTINUITY_BREAK","problem":"","repairCandidates":[2,3],"evidence":[{"chapterNumber":1,"quote":"输入中的逐字短句"}],"requiredOutcome":""}],"summary":"窗口结论"}'
      ].join('\n'),
      prompt: [
        `【创作目标】\n${compactGateText(input.goal.trim() || '完成一部长篇小说', 1200)}`,
        `【本卷合同】\n${JSON.stringify(input.contract)}`,
        `【当前窗口 ${key}】\n${JSON.stringify(targetNumbers.map(number => compactChapterForVolumeGate(chaptersByNumber.get(number)!, number)), null, 2)}`,
        contextNumbers.length > 0
          ? `【只读相邻上下文：可作证据，不得列入 repairCandidates】\n${JSON.stringify(contextNumbers.map(number => compactChapterForVolumeGate(chaptersByNumber.get(number)!, number)), null, 2)}`
          : ''
      ].filter(Boolean).join('\n\n')
    }),
    { stream: false, signal: input.signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`分卷「${input.contract.name}」第 ${key} 章窗口门禁失败：${response.error || '模型未返回内容'}`)
  }
  const assessment = parseVolumeGateAssessment({
    content: response.content,
    label: `分卷「${input.contract.name}」第 ${key} 章窗口门禁`,
    key,
    startChapter: input.range.startChapter,
    endChapter: input.range.endChapter,
    allowedEvidenceChapterNumbers: new Set([...targetNumbers, ...contextNumbers]),
    editableChapterNumbers: new Set(targetNumbers),
    chaptersByNumber
  })
  return {
    ...assessment,
    inputFingerprint: volumeGateWindowFingerprint({
      chapters: input.chapters,
      contractStartChapter: input.contract.startChapter,
      range: input.range
    })
  }
}

function volumeGateAnchorNumbers(contract: NovelVolumeContract): number[] {
  const midpoint = Math.floor((contract.startChapter + contract.endChapter) / 2)
  return [...new Set([
    contract.startChapter,
    contract.startChapter + 1,
    midpoint - 1,
    midpoint,
    midpoint + 1,
    contract.endChapter - 2,
    contract.endChapter - 1,
    contract.endChapter
  ].filter(number => number >= contract.startChapter && number <= contract.endChapter))]
}

async function assessVolumeChapterAggregate(input: {
  workId: number
  goal: string
  contract: NovelVolumeContract
  chapters: VolumeGateChapter[]
  assessments: NovelVolumeGateAssessment[]
  signal?: AbortSignal
}): Promise<NovelVolumeGateAssessment> {
  const chaptersByNumber = new Map(input.chapters.map((chapter, index) => [input.contract.startChapter + index, chapter]))
  const anchorNumbers = volumeGateAnchorNumbers(input.contract)
  const response = await modelService.chat(
    withGoalLoopModelOptions(input.workId, {
      workId: input.workId,
      step: 'goal_novel_volume_chapter_gate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.2,
      thinkingEnabled: false,
      forceThinkingDisabled: true,
      maxTokens: 1800,
      responseSchema: {
        name: 'novel_volume_chapter_gate_aggregate',
        schema: NOVEL_VOLUME_GATE_ASSESSMENT_SCHEMA,
        strict: true
      },
      systemPrompt: [
        '你是长篇小说整卷章节合同聚合门禁。只读汇总，不得输出任何章节补丁，只输出合法 JSON。',
        '依据本卷合同、全部窗口报告和卷首/中点/卷末锚点，检查阶段目标、中点转折、卷高潮、不可逆代价、mustResolve 和跨卷债务是否闭环。',
        '不得推翻已经通过的窗口，除非锚点证据能证明整卷合同存在阻断缺口。',
        'severity=hard 只用于锚点中已实际存在的互斥事实；潜在风险、可选优化、节奏和文风问题只写 summary，不得进入 issues。',
        'evidence.quote 必须是逐字摘自锚点输入的 4-80 字连续原文；禁止改写、概括或用省略号拼接，多段证据必须拆成多个 evidence 项。',
        'repairCandidates 只列锚点中真正需要修改的章节，可以超过2章，由程序拆分。',
        '没有逐字证据不得列问题或压低分数。passed 由程序根据证据计算，不要输出。',
        '格式：{"score":88,"issues":[{"severity":"hard","code":"SETUP_PAYOFF_MISMATCH","problem":"","repairCandidates":[1],"evidence":[{"chapterNumber":1,"quote":"输入中的逐字短句"}],"requiredOutcome":""}],"summary":"整卷只读结论"}'
      ].join('\n'),
      prompt: [
        `【创作目标】\n${compactGateText(input.goal.trim() || '完成一部长篇小说', 1200)}`,
        `【本卷合同】\n${JSON.stringify(input.contract, null, 2)}`,
        `【全部窗口只读报告】\n${JSON.stringify(input.assessments.map(item => ({
          range: item.key,
          passed: item.passed,
          score: item.score,
          summary: item.summary
        })), null, 2)}`,
        `【卷级锚点证据】\n${JSON.stringify(anchorNumbers.map(number => compactChapterForVolumeGate(chaptersByNumber.get(number)!, number)), null, 2)}`
      ].join('\n\n')
    }),
    { stream: false, signal: input.signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`分卷「${input.contract.name}」只读聚合门禁失败：${response.error || '模型未返回内容'}`)
  }
  return parseVolumeGateAssessment({
    content: response.content,
    label: `分卷「${input.contract.name}」只读聚合门禁`,
    key: 'aggregate',
    startChapter: input.contract.startChapter,
    endChapter: input.contract.endChapter,
    allowedEvidenceChapterNumbers: new Set(anchorNumbers),
    editableChapterNumbers: new Set(anchorNumbers),
    chaptersByNumber
  })
}

function plannedPatternFingerprints(workId: number, chapters: VolumeGateChapter[]): ChapterPatternFingerprintRow[] {
  return chapters.flatMap((chapter): ChapterPatternFingerprintRow[] => {
    const diagnosis = parseChapterDiagnosis(chapter) as {
      pattern_contract?: Record<string, string>
      tension_plan?: { payoff_type?: ChapterPatternFingerprintRow['payoff_type'] }
    }
    const pattern = diagnosis.pattern_contract
    if (!pattern) return []
    return [{
      chapter_id: chapter.id,
      work_id: workId,
      conflict_type: pattern.conflict_type ?? '',
      protagonist_method: pattern.protagonist_method ?? '',
      antagonist_tactic: pattern.antagonist_tactic ?? '',
      antagonist_outcome: '',
      opponent_adjustment: pattern.anticipated_opponent_adjustment ?? '',
      location_type: pattern.location_type ?? '',
      hook_type: pattern.hook_type ?? '',
      cost_type: pattern.cost_type ?? '',
      relationship_delta: pattern.relationship_delta ?? '',
      volume_objective_delta: pattern.volume_objective_delta ?? '',
      payoff_type: diagnosis.tension_plan?.payoff_type ?? 'debt',
      create_time: '',
      update_time: ''
    }]
  })
}

function deterministicVolumeGateIssues(
  workId: number,
  contract: NovelVolumeContract,
  chapters: VolumeGateChapter[]
): NovelVolumeGateIssue[] {
  const numberById = new Map(chapters.map((chapter, index) => [chapter.id, contract.startChapter + index]))
  return detectChapterPatternIssues(chapters, plannedPatternFingerprints(workId, chapters), {
    requireFingerprints: true,
    includeProseScan: false
  }).filter(issue => issue.severity === 'blocker').flatMap(issue => {
    const affected = [...new Set(issue.chapterIds.map(id => numberById.get(id)).filter((value): value is number => value != null))]
    if (affected.length === 0) return []
    // 确定性窗口问题优先改后出现的重复/停滞章，不把整个五章窗口全部重写。
    const chapterNumbers = affected.slice(-NOVEL_VOLUME_GATE_MAX_REPAIR_CLUSTER)
    return [{
      source: 'deterministic' as const,
      code: issue.code,
      problem: `${issue.code}：${issue.message}`,
      repairChapterNumbers: chapterNumbers,
      evidence: issue.evidence.slice(0, 4).map((quote, index) => ({
        chapterNumber: chapterNumbers[Math.min(index, chapterNumbers.length - 1)],
        quote
      })),
      requiredFix: issue.recommendedAction
    }]
  })
}

function planVolumeGateRepairClusters(issues: NovelVolumeGateIssue[]): Array<{
  chapterNumbers: number[]
  issues: NovelVolumeGateIssue[]
}> {
  const targets = [...new Set(issues.flatMap(issue => issue.repairChapterNumbers))].sort((a, b) => a - b)
  const groups: number[][] = []
  for (const target of targets) {
    const current = groups.at(-1)
    if (current && current.length < NOVEL_VOLUME_GATE_MAX_REPAIR_CLUSTER && target === current.at(-1)! + 1) {
      current.push(target)
    } else {
      groups.push([target])
    }
  }
  return groups.map(chapterNumbers => ({
    chapterNumbers,
    issues: issues.filter(issue => issue.repairChapterNumbers.some(number => chapterNumbers.includes(number)))
  }))
}

type NovelVolumeGateRepairField = typeof NOVEL_VOLUME_GATE_REPAIR_FIELDS[number]

export function replaceUniqueRepairText(input: {
  chapterNumber: number
  field: NovelVolumeGateRepairField
  current: string
  oldText: string
  newText: string
}): string {
  if (input.oldText === input.newText) {
    throw new NovelPipelineError('OUTPUT_INVALID', `第 ${input.chapterNumber} 章 ${input.field} 修复前后文本相同`)
  }
  const first = input.current.indexOf(input.oldText)
  const last = input.current.lastIndexOf(input.oldText)
  if (first < 0 || first !== last) {
    throw new NovelPipelineError(
      'OUTPUT_INVALID',
      `第 ${input.chapterNumber} 章 ${input.field} 的 oldText 必须在当前字段中逐字且唯一命中`
    )
  }
  return `${input.current.slice(0, first)}${input.newText}${input.current.slice(first + input.oldText.length)}`
}

async function repairVolumeChapterCluster(input: {
  workId: number
  goal: string
  contract: NovelVolumeContract
  volumeId: number
  chapterNumbers: number[]
  issues: NovelVolumeGateIssue[]
  signal?: AbortSignal
}): Promise<Array<{ chapterId: number; versionId: number }>> {
  const chapters = volumeChapterDAO.listChapters(input.volumeId)
  const chaptersByNumber = new Map(chapters.map((chapter, index) => [input.contract.startChapter + index, chapter]))
  const targets = input.chapterNumbers.map(number => chaptersByNumber.get(number)).filter((chapter): chapter is VolumeGateChapter => !!chapter)
  if (targets.length !== input.chapterNumbers.length) {
    throw new NovelPipelineError('CONTRACT_INVALID', `分卷「${input.contract.name}」修复目标章节不存在`)
  }
  const contextNumbers = [...new Set([
    ...input.chapterNumbers.flatMap(number => [number - 1, number + 1]),
    ...input.issues.flatMap(issue => issue.evidence.map(item => item.chapterNumber))
  ])]
    .filter(number => chaptersByNumber.has(number) && !input.chapterNumbers.includes(number))
    .sort((a, b) => a - b)
  const clusterIssues = input.issues.map(issue => ({
    ...issue,
    repairChapterNumbers: issue.repairChapterNumbers.filter(number => input.chapterNumbers.includes(number))
  }))
  const targetPayload = input.chapterNumbers.map(number => {
    const chapter = chaptersByNumber.get(number)!
    const diagnosis = parseChapterDiagnosis(chapter)
    return {
      chapterNumber: number,
      outline: chapter.outline,
      next_hook: chapter.next_hook,
      dramatic_contract: diagnosis.dramatic_contract ?? {},
      resource_budgets_read_only: resourceLedgerDAO.listBudgetsByChapter(input.workId, chapter.id)
    }
  })
  const response = await modelService.chat(
    withGoalLoopModelOptions(input.workId, {
      workId: input.workId,
      step: 'goal_novel_volume_chapter_repair',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.2,
      thinkingEnabled: false,
      forceThinkingDisabled: true,
      maxTokens: input.chapterNumbers.length === 1 ? 2400 : 4000,
      responseSchema: {
        name: 'novel_volume_chapter_minimal_repair',
        schema: NOVEL_VOLUME_GATE_REPAIR_SCHEMA,
        strict: true
      },
      systemPrompt: [
        '你是长篇小说章节合同定点修复编辑。只输出合法 JSON，不要 markdown、解释或评估。',
        `只允许修改指定的 ${input.chapterNumbers.length} 章，patches 必须逐章且仅返回这些章，不得改相邻章。`,
        '只做最小文本替换：每个 operation 的 oldText 必须逐字且唯一存在于当前字段，newText 只修正点名的连续性事实。',
        `field 只允许：${NOVEL_VOLUME_GATE_REPAIR_FIELDS.join('、')}。不得重写整章，不得改标题、角色、节拍、情绪合同、pattern_contract 或资源预算。`,
        '格式：{"patches":[{"chapterNumber":1,"operations":[{"field":"outline","oldText":"当前字段中的逐字短段","newText":"修正后短段"}]}]}'
      ].join('\n'),
      prompt: [
        `【创作目标】\n${compactGateText(input.goal.trim() || '完成一部长篇小说', 1200)}`,
        `【本卷合同】\n${JSON.stringify(input.contract, null, 2)}`,
        `【必须消除的问题与证据】\n${JSON.stringify(clusterIssues, null, 2)}`,
        `【只允许修改的当前章节合同】\n${JSON.stringify(targetPayload, null, 2)}`,
        contextNumbers.length > 0
          ? `【只读相邻章节】\n${JSON.stringify(contextNumbers.map(number => compactChapterForVolumeGate(chaptersByNumber.get(number)!, number)), null, 2)}`
          : ''
      ].filter(Boolean).join('\n\n')
    }),
    { stream: false, signal: input.signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`分卷「${input.contract.name}」第 ${input.chapterNumbers.join('、')} 章定点修复失败：${response.error || '模型未返回内容'}`)
  }
  const parsed = parseObject(response.content, `分卷「${input.contract.name}」定点修复`)
  if (!Array.isArray(parsed.patches) || parsed.patches.length !== input.chapterNumbers.length) {
    throw new NovelPipelineError('OUTPUT_INVALID', `分卷「${input.contract.name}」定点修复补丁数量不匹配`)
  }
  const seen = new Set<number>()
  const validatedPatches: Array<{
    chapter: VolumeGateChapter
    fields: Parameters<typeof volumeChapterDAO.updateChapterWithVersion>[1]
  }> = []
  for (const value of parsed.patches) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new NovelPipelineError('OUTPUT_INVALID', '章节定点修复补丁不是对象')
    }
    const patch = value as Record<string, unknown>
    const chapterNumber = intField(patch, 'chapterNumber', '章节定点修复补丁')
    if (!input.chapterNumbers.includes(chapterNumber) || seen.has(chapterNumber)) {
      throw new NovelPipelineError('REPAIR_BOUNDARY', `章节修复补丁越出点名范围或重复：第 ${chapterNumber} 章`)
    }
    seen.add(chapterNumber)
    const chapter = chaptersByNumber.get(chapterNumber)!
    const diagnosis = parseChapterDiagnosis(chapter)
    if (!Array.isArray(patch.operations) || patch.operations.length === 0 || patch.operations.length > 6) {
      throw new NovelPipelineError('OUTPUT_INVALID', `第 ${chapterNumber} 章最小补丁 operations 必须包含 1-6 项`)
    }
    let outline = String(chapter.outline ?? '')
    let nextHook = String(chapter.next_hook ?? '')
    const dramaticContract = diagnosis.dramatic_contract && typeof diagnosis.dramatic_contract === 'object'
      && !Array.isArray(diagnosis.dramatic_contract)
      ? { ...diagnosis.dramatic_contract as Record<string, unknown> }
      : {}
    let outlineChanged = false
    let nextHookChanged = false
    let diagnosisChanged = false
    for (const rawOperation of patch.operations) {
      if (!rawOperation || typeof rawOperation !== 'object' || Array.isArray(rawOperation)) {
        throw new NovelPipelineError('OUTPUT_INVALID', `第 ${chapterNumber} 章最小补丁 operation 非法`)
      }
      const operation = rawOperation as Record<string, unknown>
      const field = textField(operation, 'field', `第 ${chapterNumber} 章最小补丁`) as NovelVolumeGateRepairField
      if (!(NOVEL_VOLUME_GATE_REPAIR_FIELDS as readonly string[]).includes(field)) {
        throw new NovelPipelineError('REPAIR_BOUNDARY', `第 ${chapterNumber} 章补丁试图修改禁止字段 ${field}`)
      }
      const oldText = textField(operation, 'oldText', `第 ${chapterNumber} 章最小补丁`)
      const newText = textField(operation, 'newText', `第 ${chapterNumber} 章最小补丁`)
      if (field === 'outline') {
        outline = replaceUniqueRepairText({ chapterNumber, field, current: outline, oldText, newText })
        outlineChanged = true
      } else if (field === 'next_hook') {
        nextHook = replaceUniqueRepairText({ chapterNumber, field, current: nextHook, oldText, newText })
        nextHookChanged = true
      } else {
        const key = field.slice('dramatic_contract.'.length)
        const current = String(dramaticContract[key] ?? '')
        dramaticContract[key] = replaceUniqueRepairText({ chapterNumber, field, current, oldText, newText })
        diagnosisChanged = true
      }
    }
    if (!outlineChanged && !nextHookChanged && !diagnosisChanged) {
      throw new NovelPipelineError('OUTPUT_INVALID', `第 ${chapterNumber} 章最小补丁没有产生变更`)
    }
    validatedPatches.push({
      chapter,
      fields: {
        ...(outlineChanged ? { outline } : {}),
        ...(nextHookChanged ? { next_hook: nextHook } : {}),
        ...(diagnosisChanged ? {
          outline_diagnosis: JSON.stringify({ ...diagnosis, dramatic_contract: dramaticContract })
        } : {})
      }
    })
  }
  if (seen.size !== input.chapterNumbers.length) {
    throw new NovelPipelineError('OUTPUT_INVALID', `分卷「${input.contract.name}」定点修复没有覆盖全部点名章节`)
  }
  return volumeChapterDAO.updateChaptersWithVersionsAtomic(validatedPatches.map(patch => ({
    chapterId: patch.chapter.id,
    fields: patch.fields
  })))
}

async function runVolumeChapterGate(
  workId: number,
  goal: string,
  contract: NovelVolumeContract,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ score: number; rounds: number }> {
  const volume = volumeChapterDAO.listVolumes(workId).find(item => item.name === contract.name)
  if (!volume) throw new NovelPipelineError('PREREQUISITE_MISSING', `分卷「${contract.name}」尚未落库`)
  const savedCheckpoint = readNovelGoalState(workId).chapterVolumeGateCheckpoint
  if (savedCheckpoint?.version === 2 && savedCheckpoint.volume === contract.name && savedCheckpoint.stalled) {
    throw new NovelPipelineError('REPAIR_STALL', savedCheckpoint.stalled.reason)
  }
  if (savedCheckpoint?.version === 2
    && savedCheckpoint.volume === contract.name
    && savedCheckpoint.round >= MAX_VOLUME_CHAPTER_GATE_REPAIR_ROUNDS
    && !savedCheckpoint.repair
    && !savedCheckpoint.repairControl) {
    const reason = `分卷「${contract.name}」已进入旧版自动修复上限，禁止重新开启整卷重写`
    updateNovelGoalState(workId, {
      chapterVolumeGateCheckpoint: {
        ...savedCheckpoint,
        stalled: { reason, createTime: new Date().toISOString() }
      }
    })
    throw new NovelPipelineError('REPAIR_STALL', reason)
  }
  let rounds = savedCheckpoint?.version === 2
    && savedCheckpoint.volume === contract.name
    && savedCheckpoint.round >= 1
    && savedCheckpoint.round <= MAX_VOLUME_CHAPTER_GATE_REPAIR_ROUNDS
    ? savedCheckpoint.round - 1
    : 0
  let lastScore = -1

  const stallAndRollback = (
    checkpoint: NovelVolumeGateCheckpoint,
    reason: string,
    rollback = true
  ): never => {
    const versions = checkpoint.repairControl?.lastRoundVersions ?? []
    if (rollback && versions.length > 0) {
      volumeChapterDAO.restoreVersionsAtomic(versions)
    }
    const refreshed = volumeChapterDAO.listChapters(volume.id)
    const terminal: NovelVolumeGateCheckpoint = {
      ...checkpoint,
      snapshotFingerprint: volumeGateSnapshotFingerprint(refreshed),
      repair: undefined,
      stalled: { reason, createTime: new Date().toISOString() }
    }
    updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: terminal })
    throw new NovelPipelineError('REPAIR_STALL', reason)
  }

  const executePendingRepairs = async (checkpoint: NovelVolumeGateCheckpoint): Promise<void> => {
    const repair = checkpoint.repair
    if (!repair) return
    const allTargets = [...new Set(repair.clusters.flatMap(cluster => cluster.chapterNumbers))]
    const budget = checkNovelVolumeRepairBudget({
      chapterNumbers: allTargets,
      control: checkpoint.repairControl
    })
    if (!budget.allowed) stallAndRollback(checkpoint, `分卷「${contract.name}」自动修复停滞：${budget.reason}`, false)
    let current: NovelVolumeGateCheckpoint = {
      ...checkpoint,
      repairControl: budget.control
    }
    for (let clusterIndex = repair.nextClusterIndex; clusterIndex < repair.clusters.length; clusterIndex++) {
      if (signal?.aborted) throw new Error('已取消')
      const cluster = repair.clusters[clusterIndex]
      onProgress?.(`正在修复第 ${cluster.chapterNumbers.join('、')} 章（${clusterIndex + 1}/${repair.clusters.length}）`)
      let versions: Array<{ chapterId: number; versionId: number }>
      try {
        versions = await repairVolumeChapterCluster({
          workId,
          goal,
          contract,
          volumeId: volume.id,
          chapterNumbers: cluster.chapterNumbers,
          issues: cluster.issues,
          signal
        })
      } catch (error) {
        if (error instanceof NovelPipelineError && error.code === 'OUTPUT_INVALID') {
          stallAndRollback(
            current,
            `分卷「${contract.name}」第 ${cluster.chapterNumbers.join('、')} 章最小补丁无法逐字验证，已拒绝落库并暂停`
          )
        }
        throw error
      }
      const refreshed = volumeChapterDAO.listChapters(volume.id)
      const control = current.repairControl!
      const rewriteCounts = { ...control.rewriteCounts }
      for (const chapterNumber of cluster.chapterNumbers) {
        rewriteCounts[String(chapterNumber)] = (rewriteCounts[String(chapterNumber)] ?? 0) + 1
      }
      current = {
        ...current,
        snapshotFingerprint: volumeGateSnapshotFingerprint(refreshed),
        repairControl: {
          ...control,
          rewriteCounts,
          lastRoundVersions: [...control.lastRoundVersions, ...versions]
        },
        repair: { ...repair, nextClusterIndex: clusterIndex + 1 }
      }
      updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: current })
    }
    const refreshed = volumeChapterDAO.listChapters(volume.id)
    const windows = planNovelVolumeGateWindows(contract.startChapter, contract.endChapter)
    const reusableAssessments = checkpoint.assessments.filter(assessment => {
      if (!assessment.passed || !assessment.inputFingerprint) return false
      const range = windows.find(item => `${item.startChapter}-${item.endChapter}` === assessment.key)
      return !!range && assessment.inputFingerprint === volumeGateWindowFingerprint({
        chapters: refreshed,
        contractStartChapter: contract.startChapter,
        range
      })
    })
    updateNovelGoalState(workId, {
      chapterVolumeGateCheckpoint: {
        version: 2,
        volume: contract.name,
        round: checkpoint.round + 1,
        snapshotFingerprint: volumeGateSnapshotFingerprint(refreshed),
        assessments: reusableAssessments,
        repairControl: current.repairControl
      }
    })
  }

  while (rounds < MAX_VOLUME_CHAPTER_GATE_REPAIR_ROUNDS) {
    rounds++
    const chapters = volumeChapterDAO.listChapters(volume.id)
    if (chapters.length !== contract.endChapter - contract.startChapter + 1) {
      throw new NovelPipelineError('CONTRACT_INVALID', `分卷「${contract.name}」章节情节尚未完整，不能执行整卷门禁`)
    }
    const windows = planNovelVolumeGateWindows(contract.startChapter, contract.endChapter)
    const snapshotFingerprint = volumeGateSnapshotFingerprint(chapters)
    const currentSaved = readNovelGoalState(workId).chapterVolumeGateCheckpoint
    const savedMatchesSnapshot = currentSaved?.version === 2
      && currentSaved.volume === contract.name
      && currentSaved.round === rounds
      && currentSaved.snapshotFingerprint === snapshotFingerprint
    let checkpoint: NovelVolumeGateCheckpoint = savedMatchesSnapshot
      ? currentSaved
      : {
          version: 2,
          volume: contract.name,
          round: rounds,
          snapshotFingerprint,
          assessments: []
        }
    updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: checkpoint })
    if (checkpoint.repair) {
      onProgress?.(`正在从断点恢复「${contract.name}」定点修复（已完成 ${checkpoint.repair.nextClusterIndex}/${checkpoint.repair.clusters.length} 个小簇）`)
      await executePendingRepairs(checkpoint)
      continue
    }
    onProgress?.(`正在诊断「${contract.name}」章节情节第 ${rounds} 轮：共 ${windows.length} 个连续窗口`)
    const assessments: NovelVolumeGateAssessment[] = []
    for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
      if (signal?.aborted) throw new Error('已取消')
      const range = windows[windowIndex]
      const key = `${range.startChapter}-${range.endChapter}`
      const inputFingerprint = volumeGateWindowFingerprint({
        chapters,
        contractStartChapter: contract.startChapter,
        range
      })
      const saved = checkpoint.assessments.find(item => item.key === key && item.inputFingerprint === inputFingerprint)
      if (saved) {
        assessments.push(saved)
        onProgress?.(`已从断点恢复「${contract.name}」第 ${key} 章窗口（${windowIndex + 1}/${windows.length}）`)
        continue
      }
      onProgress?.(`正在检查「${contract.name}」第 ${key} 章窗口（${windowIndex + 1}/${windows.length}）`)
      const assessment = await assessVolumeChapterWindow({ workId, goal, contract, chapters, range, signal })
      assessments.push(assessment)
      checkpoint = { ...checkpoint, assessments: [...checkpoint.assessments, assessment] }
      updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: checkpoint })
    }

    const deterministicIssues = deterministicVolumeGateIssues(workId, contract, chapters)
    let aggregate = checkpoint.aggregate
    const windowIssues = assessments.flatMap(item => item.issues)
    if (windowIssues.length === 0 && deterministicIssues.length === 0) {
      if (!aggregate) {
        onProgress?.(`正在对「${contract.name}」执行只读卷级汇总（不生成修复补丁）`)
        aggregate = await assessVolumeChapterAggregate({ workId, goal, contract, chapters, assessments, signal })
        checkpoint = { ...checkpoint, aggregate }
        updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: checkpoint })
      }
    } else {
      aggregate = undefined
    }
    const issues = [...windowIssues, ...deterministicIssues, ...(aggregate?.issues ?? [])]
    const scoreRows = [...assessments.map(item => item.score), ...(aggregate ? [aggregate.score] : [])]
    lastScore = scoreRows.length > 0
      ? Math.round(scoreRows.reduce((sum, value) => sum + value, 0) / scoreRows.length)
      : 0
    const passed = assessments.every(item => item.passed)
      && deterministicIssues.length === 0
      && !!aggregate?.passed
      && issues.length === 0
    if (passed) {
      updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: undefined })
      onProgress?.(`「${contract.name}」窗口门禁与只读卷级汇总均通过（${lastScore}分）`)
      return { score: lastScore, rounds }
    }
    if (issues.length === 0) {
      throw new NovelPipelineError('OUTPUT_INVALID', `分卷「${contract.name}」门禁未通过，但没有证据点名的修复目标`)
    }
    const control = checkpoint.repairControl
    if (control?.previousIssueCount != null && issues.length >= control.previousIssueCount) {
      stallAndRollback(
        checkpoint,
        `分卷「${contract.name}」自动修复后硬问题未减少（${control.previousIssueCount} → ${issues.length}），已回滚上一修复轮并暂停`
      )
    }
    if (rounds >= MAX_VOLUME_CHAPTER_GATE_REPAIR_ROUNDS) {
      stallAndRollback(
        checkpoint,
        `分卷「${contract.name}」章节情节连续 ${MAX_VOLUME_CHAPTER_GATE_REPAIR_ROUNDS} 轮未通过硬门禁（最终 ${lastScore} 分），已停止自动重写`
      )
    }
    const clusters = planVolumeGateRepairClusters(issues)
    const targets = [...new Set(clusters.flatMap(cluster => cluster.chapterNumbers))]
    const budget = checkNovelVolumeRepairBudget({ chapterNumbers: targets, control })
    if (!budget.allowed) {
      stallAndRollback(checkpoint, `分卷「${contract.name}」自动修复停滞：${budget.reason}`)
    }
    checkpoint = {
      ...checkpoint,
      aggregate,
      repairControl: {
        ...budget.control,
        previousIssueCount: issues.length,
        lastRoundVersions: []
      },
      repair: { clusters, nextClusterIndex: 0 }
    }
    updateNovelGoalState(workId, { chapterVolumeGateCheckpoint: checkpoint })
    onProgress?.(`「${contract.name}」发现 ${issues.length} 个证据问题，将定点修复 ${clusters.length} 个小簇`)
    await executePendingRepairs(checkpoint)
  }
  const checkpoint = readNovelGoalState(workId).chapterVolumeGateCheckpoint
  throw new NovelPipelineError(
    'REPAIR_STALL',
    checkpoint?.stalled?.reason
      ?? `分卷「${contract.name}」自动修复未收敛，已保留检查点并暂停`
  )
}

function normalizeCharacters(value: unknown, chapterNumber: number): string[] {
  if (!Array.isArray(value)) {
    throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章 characters 必须是数组`)
  }
  const names = value.map(String).map(s => s.trim()).filter(Boolean)
  if (names.length === 0) {
    throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章没有出场角色`)
  }
  return [...new Set(names)]
}

function validateDramaticContract(value: unknown, chapterNumber: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章缺少 dramatic_contract`)
  }
  const contract = value as Record<string, unknown>
  for (const key of ['scene_promise', 'protagonist_want', 'obstacle', 'stakes', 'turn', 'irreversible_change', 'next_question']) {
    textField(contract, key, `第 ${chapterNumber} 章 dramatic_contract`)
  }
  return contract
}

function validatePatternContract(value: unknown, chapterNumber: number): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章缺少 pattern_contract`)
  }
  const row = value as Record<string, unknown>
  const result: Record<string, string> = {}
  for (const key of [
    'conflict_type', 'protagonist_method', 'antagonist_tactic', 'anticipated_opponent_adjustment',
    'location_type', 'hook_type', 'cost_type', 'relationship_delta', 'volume_objective_delta'
  ]) {
    result[key] = textField(row, key, `第 ${chapterNumber} 章 pattern_contract`)
  }
  return result
}

function budgetKey(budget: { owner?: string | null; resource: string }): string {
  return `${budget.owner?.trim() || '*'}::${budget.resource.trim()}`
}

function resourceBudgetExample(
  workId: number,
  previousBudgets: Map<string, ChapterResourceBudgetInput>
): ChapterResourceBudgetInput[] {
  return resourceLedgerDAO.listConstraints(workId)
    .filter(isNumericConstraint)
    .map(row => {
      const previous = previousBudgets.get(budgetKey(row))
      const startMin = previous?.end_min ?? row.initial_value ?? row.min_value ?? 0
      const startMax = previous?.end_max ?? row.initial_value ?? row.max_value ?? row.min_value ?? 0
      return {
        owner: row.owner ?? null,
        resource: row.resource,
        unit: row.unit ?? null,
        start_min: startMin,
        start_max: startMax,
        end_min: startMin,
        end_max: startMax,
        allowed_events: '填写本章允许发生的资源变化',
        forbidden_events: '填写本章禁止发生的资源变化',
        reason: previous ? '开章区间严格承接上一章章末区间' : '开章区间包含全书初始值'
      }
    })
}

function previousResourceBudgetContext(previousBudgets: Map<string, ChapterResourceBudgetInput>): string {
  if (previousBudgets.size === 0) return ''
  return [
    '【上一章资源预算 - 本批第一章必须严格承接】',
    ...Array.from(previousBudgets.entries()).map(([key, budget]) =>
      `- ${key}：上一章章末 ${budget.end_min}-${budget.end_max}${budget.unit || ''}；本批第一章 start_min/start_max 必须与该区间相交`)
  ].join('\n')
}

function isNumericConstraint(constraint: ReturnType<typeof resourceLedgerDAO.listConstraints>[number]): boolean {
  if (constraint.initial_value != null || constraint.min_value != null || constraint.max_value != null) return true
  if (!constraint.milestones_json) return false
  try {
    const milestones = JSON.parse(constraint.milestones_json) as Array<Record<string, unknown>>
    return milestones.some(item => Number.isFinite(Number(item.min)) || Number.isFinite(Number(item.max)))
  } catch {
    throw new NovelPipelineError('CONTRACT_INVALID', `资源 ${constraint.resource} 的里程碑配置不是合法 JSON`)
  }
}

function rangesOverlap(aMin: number | null | undefined, aMax: number | null | undefined, bMin: number | null | undefined, bMax: number | null | undefined): boolean {
  if (aMin == null || aMax == null || bMin == null || bMax == null) return false
  return Math.max(aMin, bMin) <= Math.min(aMax, bMax)
}

function validateResourceBudgets(
  workId: number,
  previousChapterId: number | null,
  batches: Array<{ chapterNumber: number; budgets: ChapterResourceBudgetInput[] }>
): void {
  const constraints = resourceLedgerDAO.listConstraints(workId)
  if (constraints.length === 0) return
  const numericConstraints = constraints.filter(isNumericConstraint)
  const required = new Set(numericConstraints.map(row => budgetKey(row)))
  const previous = new Map<string, ChapterResourceBudgetInput>()
  if (previousChapterId) {
    for (const budget of resourceLedgerDAO.listBudgetsByChapter(workId, previousChapterId)) {
      previous.set(budgetKey(budget), budget)
    }
  }

  for (const batch of batches) {
    const current = new Map(batch.budgets.map(budget => [budgetKey(budget), budget]))
    for (const key of required) {
      const budget = current.get(key)
      if (!budget) {
        throw new NovelPipelineError('CONTRACT_INVALID', `第 ${batch.chapterNumber} 章缺少资源预算 ${key}`)
      }
      if (budget.start_min == null || budget.start_max == null || budget.end_min == null || budget.end_max == null) {
        throw new NovelPipelineError('CONTRACT_INVALID', `第 ${batch.chapterNumber} 章资源预算 ${key} 缺少完整起止区间`)
      }
      const prior = previous.get(key)
      if (prior?.end_min != null && prior.end_max != null) {
        // 开章资源是上一章章末状态的确定继承，不允许交给模型重新估算。
        budget.start_min = prior.end_min
        budget.start_max = prior.end_max
      }
      if (prior && !rangesOverlap(prior.end_min, prior.end_max, budget.start_min, budget.start_max)) {
        throw new NovelPipelineError(
          'CONTRACT_INVALID',
          `第 ${batch.chapterNumber} 章资源 ${key} 开章区间 ${budget.start_min}-${budget.start_max} 与上一章章末区间 ${prior.end_min}-${prior.end_max} 断裂`
        )
      }
      const constraint = numericConstraints.find(row => budgetKey(row) === key)
      if (!prior && batch.chapterNumber === 1 && constraint?.initial_value != null
        && (constraint.initial_value < budget.start_min! || constraint.initial_value > budget.start_max!)) {
        throw new NovelPipelineError('CONTRACT_INVALID', `第 1 章资源 ${key} 开章区间不包含初始值 ${constraint.initial_value}`)
      }
      if (constraint?.milestones_json) {
        try {
          const milestones = JSON.parse(constraint.milestones_json) as Array<Record<string, unknown>>
          for (const milestone of milestones.filter(item => Number(item.chapter) === batch.chapterNumber)) {
            const min = Number(milestone.min)
            const max = Number(milestone.max)
            if (Number.isFinite(min) && budget.end_max! < min) {
              throw new NovelPipelineError('CONTRACT_INVALID', `第 ${batch.chapterNumber} 章资源 ${key} 预算无法达到里程碑下限 ${min}`)
            }
            if (Number.isFinite(max) && budget.end_min! > max) {
              throw new NovelPipelineError('CONTRACT_INVALID', `第 ${batch.chapterNumber} 章资源 ${key} 预算超过里程碑上限 ${max}`)
            }
          }
        } catch (error) {
          if (error instanceof NovelPipelineError) throw error
          throw new NovelPipelineError('CONTRACT_INVALID', `资源 ${key} 里程碑配置不是合法 JSON`)
        }
      }
    }
    previous.clear()
    for (const [key, value] of current) previous.set(key, value)
  }
}

function validateChapterBatch(input: {
  parsed: Record<string, unknown>
  start: number
  end: number
  outlineMin: number
  workId: number
  previousChapterId: number | null
}): NovelOutlineBatchItem[] {
  if (Number(input.parsed.startChapter) !== input.start || Number(input.parsed.endChapter) !== input.end) {
    throw new NovelPipelineError('CONTRACT_INVALID', `章节批次范围不匹配，期望 ${input.start}-${input.end}`)
  }
  const raw = input.parsed.chapters
  if (!Array.isArray(raw) || raw.length !== input.end - input.start + 1) {
    throw new NovelPipelineError('CONTRACT_INVALID', `章节批次数量不匹配，期望 ${input.end - input.start + 1} 章，实际 ${Array.isArray(raw) ? raw.length : 0} 章`)
  }

  const budgetRows: Array<{ chapterNumber: number; budgets: ChapterResourceBudgetInput[] }> = []
  const items = raw.map((value, index) => {
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
    const contract = validateDramaticContract(row.dramatic_contract, chapterNumber)
    const patternContract = validatePatternContract(row.pattern_contract, chapterNumber)
    const emotionContract = normalizeEmotionContract(row.emotion_contract)
    if (!emotionContract || validateEmotionContract(emotionContract).length > 0) {
      throw new NovelPipelineError('CONTRACT_INVALID', `第 ${chapterNumber} 章缺少完整 emotion_contract`)
    }
    const budgets = normalizeChapterResourceBudgets(row.resource_budget).filter(budget =>
      budget.start_min != null && budget.start_max != null && budget.end_min != null && budget.end_max != null
    )
    budgetRows.push({ chapterNumber, budgets })
    const diagnosis = {
      arc_phase: textField(row, 'arc_phase', `第 ${chapterNumber} 章`),
      dramatic_contract: contract,
      pattern_contract: patternContract,
      tension_plan: { level: tensionLevel, payoff_type: payoffType },
      emotion_contract: emotionContract
    }
    return {
      title: textField(row, 'title', `第 ${chapterNumber} 章`),
      outline,
      arcPhase: diagnosis.arc_phase,
      payoffRole,
      foreshadowTarget: String(row.foreshadow_target ?? '').trim() || null,
      nextHook: textField(row, 'next_hook', `第 ${chapterNumber} 章`),
      characters: normalizeCharacters(row.characters, chapterNumber),
      outlineDiagnosis: JSON.stringify(diagnosis),
      emotionContract,
      resourceBudgets: budgets
    }
  })
  validateResourceBudgets(input.workId, input.previousChapterId, budgetRows)
  return items
}

function formatRecentOutlineContext(workId: number): string {
  return volumeChapterDAO.listChaptersByWork(workId)
    .slice(-5)
    .map((chapter, index, rows) => {
      let pattern = ''
      try {
        pattern = JSON.stringify(JSON.parse(chapter.outline_diagnosis ?? '{}').pattern_contract ?? {})
      } catch { /* 忽略旧大纲 */ }
      return `第 ${rows.length - index} 个最近章节：${chapter.title}\n${chapter.outline ?? ''}\n模式指纹：${pattern}`
    })
    .join('\n\n')
}

async function generateChapterBatch(input: {
  workId: number
  goal: string
  volume: NovelVolumeContract
  start: number
  end: number
  correction?: string
  signal?: AbortSignal
}): Promise<NovelOutlineBatchItem[]> {
  const plan = loadWritingPlan(input.workId)
  const constraints = outlineConstraintsForWordTarget(plan.wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER)
  const resourceConstraints = formatResourceConstraintsForPrompt(input.workId)
  const previousChapter = volumeChapterDAO.listChaptersByWork(input.workId).at(-1)
  const previousBudgets = new Map<string, ChapterResourceBudgetInput>()
  if (previousChapter) {
    for (const budget of resourceLedgerDAO.listBudgetsByChapter(input.workId, previousChapter.id)) {
      previousBudgets.set(budgetKey(budget), budget)
    }
  }
  const budgetExample = resourceBudgetExample(input.workId, previousBudgets)
  const outputExample = {
    startChapter: input.start,
    endChapter: input.end,
    chapters: [{
      chapterNumber: input.start,
      title: `第${input.start}章 标题`,
      outline: '按合同输出完整章节执行蓝图',
      arc_phase: 'setup',
      payoff_role: 'B',
      tension_level: 6,
      payoff_type: 'debt',
      dramatic_contract: {
        scene_promise: '本章场景承诺', protagonist_want: '主角目标', obstacle: '阻力', stakes: '失败代价',
        info_gap: '信息差', pressure_escalation: '压力升级', turn: '中段转折', irreversible_change: '不可逆变化',
        payoff_or_debt: '兑现或债务', next_question: '结尾问题'
      },
      pattern_contract: {
        conflict_type: '抽象冲突类型', protagonist_method: '主角本章核心解法', antagonist_tactic: '对手策略',
        anticipated_opponent_adjustment: '对手基于既有失败的调整或不适用', location_type: '场景功能类型',
        hook_type: '章末钩子类型', cost_type: '主角实际支付的代价', relationship_delta: '核心关系变化或无变化',
        volume_objective_delta: '本卷核心目标的可验证推进'
      },
      emotion_contract: EMOTION_CONTRACT_JSON_SHAPE,
      foreshadow_target: '',
      next_hook: '下一章钩子',
      characters: ['主角'],
      resource_budget: budgetExample
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
  const request = withGoalLoopModelOptions(input.workId, {
    workId: input.workId,
    step: 'goal_novel_chapter_batch',
    enrichWorkContext: false,
    enrichNarrativeMemory: false,
    temperature: 0.2,
    maxTokens: profile.maxTokens,
    thinkingEnabled: false,
    forceThinkingDisabled: true,
    systemPrompt: [
      '你是长篇小说章节结构编辑。只输出合法 JSON 对象，不要 markdown、前言、总结或解释。',
      `只生成第 ${input.start}-${input.end} 章，不得生成范围外章节。`,
      input.start === input.end
        ? '本次只生成一章完整合同，优先保证 JSON 完整闭合，禁止附加解释。'
        : '本次只生成黄金前三章，字段必须精炼，优先保证 JSON 完整闭合。',
      goldenOutlineContract('novel', input.start, input.end),
      retentionPlanningRules('novel'),
      `每章大纲 ${constraints.charsMin}-${constraints.charsMax} 字，必须包含【开场状态】【必须覆盖】【禁止越界】【结尾落点】【连续性约束】。`,
      '每章必须有戏剧契约：目标、阻力、失败代价、中段转折、不可逆变化和结尾问题。',
      '每章必须有 emotion_contract：依恋锚点、事件意义、人物表里冲突、读者信息位置、有代价选择和跨章余波缺一不可。',
      '每章必须有 pattern_contract，用抽象语义声明冲突、解法、对手策略及学习、场景功能、钩子、代价、关系变化和分卷目标推进。',
      '同一批次内不得连续复用相同 conflict_type+protagonist_method 或 hook_type；对手失败后必须调整策略。',
      'payoff_role 只允许 A/B/C；payoff_type 只允许 debt/partial/major/aftertaste；tension_level 为1-10。',
      resourceConstraints ? '每章必须为全书资源账本中可数值化的资源输出完整 resource_budget，起止区间必须承接上一章；境界、身份等枚举状态写入角色状态和戏剧契约，不得伪造数值区间。' : 'resource_budget 输出空数组。',
      'resource_budget 必须按账本逐项输出，owner 和 resource 必须与账本完全一致，禁止遗漏或改名。',
      `合法 JSON 结构示例：${JSON.stringify(outputExample)}`
    ].join('\n'),
    prompt: [
      `【用户目标】\n${input.goal.trim() || '自动策划一部长篇小说'}`,
      `【当前分卷合同】\n${JSON.stringify(input.volume, null, 2)}`,
      resourceConstraints,
      previousResourceBudgetContext(previousBudgets),
      input.correction && !/timeout|timed out|超时/i.test(input.correction)
        ? `【上一次输出未通过合同校验，本次必须逐项修正】\n${input.correction}`
        : '',
      recentOutlineContext ? `【最近章节，必须连续承接】\n${recentOutlineContext}` : '',
      `【作品上下文（${profile.compact ? '超时后压缩' : '必要摘要'}）】\n${ctx.text.slice(0, profile.contextChars)}`
    ].filter(Boolean).join('\n\n')
  })
  const response = await modelService.chat(
    { ...request, thinkingEnabled: false, forceThinkingDisabled: true },
    { stream: false, signal: input.signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`章节情节批次生成失败：${response.error || '模型未返回内容'}`)
  }
  if (response.finishReason === 'length') {
    throw new NovelPipelineError(
      'OUTPUT_INVALID',
      `章节情节输出被截断（finishReason=length）：第 ${input.start}-${input.end} 章，将缩小任务后从断点重试`
    )
  }
  const parsed = parseObject(response.content, `第 ${input.start}-${input.end} 章批次`)
  return validateChapterBatch({
    parsed,
    start: input.start,
    end: input.end,
    outlineMin: constraints.charsMin,
    workId: input.workId,
    previousChapterId: previousChapter?.id ?? null
  })
}

async function assessGoldenThreeOutlineBatch(
  workId: number,
  goal: string,
  items: NovelOutlineBatchItem[],
  signal?: AbortSignal
): Promise<{ passed: boolean; score: number; issues: string[] }> {
  const firstThree = items.slice(0, 3)
  if (firstThree.length < 3) {
    return { passed: false, score: 0, issues: ['首批章节未完整包含第1至3章'] }
  }
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_novel_golden_three_gate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 1600,
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
        `【黄金前三章大纲】\n${JSON.stringify(firstThree, null, 2)}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    throw new Error(`黄金前三章门禁失败：${response.error || '模型未返回内容'}`)
  }
  const parsed = parseObject(response.content, '黄金前三章门禁')
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
  const state = readNovelGoalState(workId)
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
  if (!state.novelOutline || state.novelOutline.targetChapters !== targetChapters || !state.volumePlanChecked) {
    throw new NovelPipelineError('PREREQUISITE_MISSING', '分卷大纲尚未通过质量门禁，不能生成章节情节')
  }
  const volumePlan = validateVolumePlan(state.novelOutline.volumePlan, targetChapters)
  await ensurePleasureEngineMatchesVolumePlan(workId, goal, volumePlan, signal, onProgress)
  const alignedState = readNovelGoalState(workId)
  const requiredFingerprint = pleasureVolumeFingerprint(workId, volumePlan)
  const pleasureGate = validatePleasureEngineScale(workId)
  if (alignedState.pleasureVolumeFingerprint !== requiredFingerprint || !pleasureGate.valid) {
    throw new NovelPipelineError('PREREQUISITE_MISSING', `爽点机制分卷映射门禁未通过：${pleasureGate.reason || '映射版本不一致'}`)
  }

  const checkCompletedVolume = async (contract: NovelVolumeContract): Promise<{ volume: string; score: number; rounds: number }> => {
    updateNovelGoalState(workId, { pendingChapterVolumeGate: contract.name })
    const result = await runVolumeChapterGate(workId, goal, contract, signal, onProgress)
    const latest = readNovelGoalState(workId)
    updateNovelGoalState(workId, {
      pendingChapterVolumeGate: undefined,
      chapterVolumeGateCheckpoint: undefined,
      checkedChapterVolumes: [...new Set([...(latest.checkedChapterVolumes ?? []), contract.name])]
    })
    return { volume: contract.name, ...result }
  }

  if (state.pendingChapterVolumeGate) {
    const pending = volumePlan.find(item => item.name === state.pendingChapterVolumeGate)
    if (!pending) throw new NovelPipelineError('CONTRACT_INVALID', `待诊断分卷不存在：${state.pendingChapterVolumeGate}`)
    const volumeGate = await checkCompletedVolume(pending)
    const refreshed = volumeChapterDAO.listChaptersByWork(workId)
    return {
      created: 0,
      reused: refreshed.length,
      remaining: targetChapters - refreshed.length,
      complete: refreshed.length === targetChapters,
      volumeGate,
      volumeReadyForDraft: pending.name
    }
  }

  if (existing.length === targetChapters) {
    const finalVolume = volumePlan.at(-1)!
    const checked = readNovelGoalState(workId).checkedChapterVolumes ?? []
    const volumeGate = checked.includes(finalVolume.name) ? undefined : await checkCompletedVolume(finalVolume)
    return {
      created: 0,
      reused: existing.length,
      remaining: 0,
      complete: true,
      volumeGate,
      volumeReadyForDraft: finalVolume.name
    }
  }

  const start = existing.length + 1
  const volume = volumePlan.find(item => start >= item.startChapter && start <= item.endChapter)
  if (!volume) throw new NovelPipelineError('CONTRACT_INVALID', `第 ${start} 章不属于任何分卷合同`)
  const batchProfile = planNovelChapterBatch(
    start,
    volume.endChapter,
    state.failure?.phase === 'generate_beats' ? state.failure.message : undefined
  )
  const end = batchProfile.end
  onProgress?.(`正在生成章节情节第 ${start}-${end} 章（剩余 ${targetChapters - existing.length} 章）`)
  let correction = state.failure?.phase === 'generate_beats' ? state.failure.message : undefined
  let items: NovelOutlineBatchItem[] = []
  for (let round = 1; round <= MAX_GATE_REPAIR_ROUNDS; round++) {
    items = await generateChapterBatch({ workId, goal, volume, start, end, correction, signal })
    if (start !== 1 || end < 3) break
    onProgress?.(`正在执行黄金前三章联合门禁（第 ${round} 轮）`)
    const gate = await assessGoldenThreeOutlineBatch(workId, goal, items, signal)
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
    onProgress?.(`黄金前三章未通过（${gate.score}分），正在整体重建首批章节`)
  }
  const volumeIndex = volumePlan.findIndex(item => item.name === volume.name)
  novelOutlineDAO.commitBatch({
    workId,
    volumeName: volume.name,
    volumeDescription: volume.description,
    volumeSort: volumeIndex + 1,
    volumeStartChapter: volume.startChapter,
    volumeEndChapter: volume.endChapter,
    chapterStartSort: start - volume.startChapter + 1,
    items
  })

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
