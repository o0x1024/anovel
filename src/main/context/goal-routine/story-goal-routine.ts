/**
 * 短故事目标循环运行器 —— loop-engineering 的 automations + 状态机。
 *
 * 状态机（目标驱动流水线 + 验收后修复）：
 *   materialize_settings → 从创作目标直接沉淀核心设定
 *   generate_character_cards → 生成主角人设卡片
 *   story_engine_gate → 固化人物欲望、两难、代价与题材因果
 *   generate_beats → 生成完整节拍大纲
 *   generate_title_hook → 基于节拍大纲生成爆款书名与导语
 *   overall_self_check → 核心设定整体自检
 *   draft_body → 顺序生成全部正文
 *   goal_check → 统一验收目标维度
 *   repair_plan/repair_execute → 结构化修复后回到验收
 *
 * 安全 guardrail：轮次硬上限、AbortController 可取消、每轮写轮次记忆、
 * 重启后由用户手动断点续跑（paused 态可恢复）。
 */
import { BrowserWindow, type WebContents } from 'electron'
import { appLogger } from '../../logger/app-logger'
import {
  volumeChapterDAO,
  goalRoutineDAO,
  coreSettingDAO,
  workDAO,
  appPreferenceDAO,
  storyHarnessDAO
} from '../../db'
import { modelService } from '../../model'
import { CHARACTER_CARDS_AI_PROMPT } from '../writing-techniques'
import { buildWorkContext } from '../work-context'
import {
  parseCharacterCardsFromAi,
  sanitizeCharacterCards,
  saveCharacterCards,
  validateCharacterCards
} from '../character-cards'
import { buildSettingsQualityInput, recordQualityCheck } from '../settings-quality'
import { STORY_OVERALL_CHECK_SYSTEM_PROMPT } from '../story-settings-quality'
import { runIncubatorGate } from '../incubator/gate-check'
import { runGateFix } from '../incubator/gate-fix'
import { freezeIncubatorStorylineVersion } from '../incubator/freeze-version'
import { parseChapterSuggestions, type ParsedChapter } from '../parse-chapters'
import { outlineConstraintsForWordTarget } from '../../../shared/outline-constraints'
import { DEFAULT_WORDS_PER_CHAPTER } from '../../../shared/writing-plan-presets'
import { loadWritingPlan } from '../writing-plan'
import { STORY_INCUBATOR_ANALYSIS_PROMPTS } from '../../../shared/story-incubator-prompts'
import { STORY_SLOT_KEYS, getIncubatorSlotLabel, type IncubatorSlotKey } from '../../../shared/incubator-slots'
import { parseExpansionVersions, type ExpansionVersion } from '../parse-expansion'
import { parseIncubatorVariants, type IncubatorVariant } from '../parse-variants'
import { updateDraftSlotContent } from '../incubator/update-slot'
import { extractJsonText } from '../parse-json-extract'
import { incubatorDraftSlotDAO } from '../../db/dao/incubator'
import {
  checkStoryGoal,
  DEFAULT_STORY_GOAL_CONFIG,
  failedCriticalStoryMetrics,
  type StoryGoalConfig,
  type GoalCheckResult
} from './story-goal-checker'
import {
  commitStoryBodyCandidate,
  generateBeatBody,
  extractNarrativeMemoryAfterGeneration
} from './story-goal-doer'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import { parseStoryQualityAiScoreBreakdown } from '../../../shared/story-quality-score'
import { normalizeModelBodyOutput, stripDeterministicAiPatterns } from '../../../shared/normalize-body-text'
import { QUALITY_APPLY_FIXES_PROMPT } from '../chapter-quality'
import { STYLE_REWRITE_INSTRUCTION, countEmDashes, stripEmDashes } from '../anti-ai-rules'
import { runConsistencyGate } from '../consistency-gate'
import {
  bindGoalLoopModelOpts,
  clearGoalLoopModelOpts,
  getGoalLoopModelOpts,
  withGoalLoopModelOptions
} from './story-goal-model'
import {
  GOAL_ROUTINE_PHASE_ORDER,
  isGoalRoutinePhase,
  type GoalRoutinePhase
} from '../../../shared/goal-routine-phases'
import {
  normalizeStoryCategoryTags,
  storyCategoryPromptSection,
  storyCategoryTagsToStorage,
  type StoryCategoryTags
} from '../../../shared/story-category-tags'
import { storyHotWordPromptSection } from '../../../shared/story-hot-words'
import { fuzzyReplace } from '../../../shared/fuzzy-match'
import { parseQualityConclusion, PASS_SCORE_THRESHOLD, type QualityConclusion } from '../settings-quality-conclusion'
import { selectPreferredTitleHook, compareRepairCandidate } from './story-pairwise-evaluator'
import { clearChapterNarrativeMemory } from '../memory-cleanup'
import { recordTasteChoice } from '../taste-profile'
import { bodyWordCountBounds } from '../../../shared/body-word-target'
import { ensureStoryEngine } from './story-engine-gate'
import { ensureStoryContract, formatStoryContractForPrompt, getStoryContract } from './story-contract'
import { EMOTION_CONTRACT_JSON_SHAPE, ensureEmotionEngine } from './emotion-engine'
import {
  EMOTION_CONTRACT_ENUM_RULE,
  validateEmotionContract,
  type EmotionBlindAssessment
} from '../../../shared/emotion-contract'
import {
  assessChapterEmotion,
  emotionRepairHint,
  ensureChapterEmotionOutcome,
  EMOTION_GATE_MIN_SCORE
} from './emotion-gate'
import {
  formatGenrePolicy,
  normalizeTensionPlanForBeat,
  resolveStoryGenrePolicy,
  tensionCurveForBeat,
  validateTensionPlans
} from './story-genre-policy'
import { resetFailedStoryStructure } from './story-structure-reset'
import { routeStoryForensicRepair } from './story-forensic-repair'
import type { StoryForensicIssue } from './story-whole-evaluator'
import {
  BEAT_CONTRACT_MAX_TOKENS,
  BEAT_SKELETON_MAX_TOKENS,
  BEAT_STAGE_MAX_ATTEMPTS,
  beatGateContractRepairIndexes,
  beatGateIssueSignature,
  beatGateIssuesForIndex,
  beatGateIssuesForLayer,
  beatGateNeedsSkeletonModelRepair,
  beatGateRepairIndexes,
  beatGateResolvedTargetCount,
  type BeatGateRecovery,
  compactBeatSkeletons,
  exactStageCountError,
  mergeStagedBeat,
  mergeStoryBlueprintDiagnosis,
  sanitizeBeatSkeleton,
  storyBeatStageKey
} from './story-beat-staging'
import { retentionEvaluationRules, retentionPackagingRules, retentionPlanningRules } from './reader-retention'
import { validateStoryContinuityContracts } from '../../../shared/story-hard-guards'
import {
  routeStoryContinuityEscalation,
  type StoryContinuityEscalationRoute
} from './story-continuity-escalation'
import type { StoryContinuityRepairEvent } from './story-goal-doer'
import {
  STRUCTURAL_REPAIR_MAX_ATTEMPTS,
  STORY_ROUTINE_FAILURE_LIMIT,
  StructuralRepairError,
  classifyStructuralRepairParseFailure,
  routineFailureSignature,
  structuralRepairTokenBudget
} from './story-structural-repair-policy'
import { GoalPhaseExhaustedError } from './goal-phase-error'
import {
  resolveStoryModelCapability,
  stableStoryHash,
  canStartStoryFallbackEpoch
} from '../../../shared/story-harness'
import { requireGoalTurnLimit } from '../../../shared/goal-turn-limit'

export type Phase = GoalRoutinePhase

export interface GoalProgressEvent {
  workId: number
  turn: number
  maxTurns: number
  phase: Phase
  status: string
  check?: GoalCheckResult
  message: string
}

interface RepairPlan {
  action: 'draft_missing' | 'resize' | 'deai' | 'quality' | 'goal_align' | 'storyline' | 'beat' | 'scene' | 'paragraph'
  targetChapterIds: number[]
  targetWordCounts?: Record<number, number>
  hint: string
  issues?: string[]
  forensicIssues?: StoryForensicIssue[]
  forensicFingerprint?: string
  continuityEscalation?: boolean
}

interface RoutineRuntimeState {
  lastCheck?: GoalCheckResult
  repairPlan?: RepairPlan
  overallRepairRounds?: number
  wholeAuditCount?: number
  lastCheckComposite?: number
  lastCheckSignature?: string
  stagnantChecks?: number
  structuralResetCount?: number
  structuralFeedback?: string
  forceBeatRebuild?: boolean
  beatGateFailureCount?: number
  pendingMemoryChapterIds?: number[]
  memoryCompensationAttempts?: Record<string, number>
  automationEpoch?: number
  forensicRepairStall?: { fingerprint: string; count: number }
  continuityRepairFailure?: {
    chapterId: number
    blockers: string[]
    attempts: number
    fingerprint?: string
    escalationCount?: number
    updatedAt: string
  }
  continuityPendingRepair?: RepairPlan
  executionFailure?: {
    phase: Phase
    signature: string
    count: number
    message: string
    updatedAt: string
  }
  terminalReason?: 'needs_manual_editor'
  titleHookCandidates?: TitleHookCandidate[]
  titleHookPreferredIndex?: number
  liveProgress?: {
    turn: number
    phase: Phase
    status: string
    message: string
    updatedAt: string
  }
  beatGenerationDraft?: {
    round: number
    score: number
    issues: string[]
    chapters: ParsedChapter[]
    updatedAt: string
  }
  beatGenerationStage?: {
    key: string
    round: number
    gateFeedback: string
    skeletons: ParsedChapter[]
    enriched: ParsedChapter[]
    repairIndexes?: number[]
    gateIssues?: string[]
    updatedAt: string
  }
  evaluationHistory?: Array<{
    checkedAt: string
    qualityScore: number
    goalMatchScore: number
    overallStoryScore: number
    previewHookScore: number
    proseReadScore: number
    composite: number
    weakestLayer: string
    issues: string[]
  }>
}

interface SlotCandidate {
  title: string
  content: string
  score?: number
  reason?: string
}

interface SelectedSlotCandidate extends SlotCandidate {
  total: number
}

const STORY_SETTING_TYPES = ['protagonist', 'golden_finger', 'pleasure_engine', 'supporting_cast'] as const
export interface TitleHookCandidate {
  title: string
  hook: string
  type?: string
  summary?: string
  tags: StoryCategoryTags
}

const SLOT_PROMPT_KEYS: Record<IncubatorSlotKey, keyof typeof STORY_INCUBATOR_ANALYSIS_PROMPTS> = {
  premise: 'premise',
  core_conflict: 'variants',
  world_rules: 'premise',
  role_engine: 'role_engine',
  opening: 'expand',
  ending: 'rhythm_ending',
  rhythm_ending: 'rhythm_ending'
}
const HOT_WORD_SECTION = storyHotWordPromptSection()

const STORY_SETTING_PROMPTS: Record<(typeof STORY_SETTING_TYPES)[number], string> = {
  protagonist: ['你是顶级短故事人设设计师。基于主线大纲输出 Markdown：## 身份与反差标签 / ## 核心痛点与执念 / ## 反差行为矩阵 / ## 爽点爆发时机 / ## 主角金句与对抗姿态。', HOT_WORD_SECTION].join('\n\n'),
  golden_finger: ['你是顶级短故事核心钩子设计师。判断故事是否需要特殊机制；没有机制则设计身份反差与信息差。输出 Markdown：## 设定名称与形态 / ## 信息差构建 / ## 限制与紧迫感 / ## 对核心冲突的推动作用。', HOT_WORD_SECTION].join('\n\n'),
  pleasure_engine: ['你是顶级短故事节奏与爽点设计师。输出 Markdown：## 开篇憋屈/危机点 / ## 黄金开局爽感/反击 / ## 中点反转 / ## 终局极致爽感清算。必须明确每个爽点对应的节拍位置。', HOT_WORD_SECTION].join('\n\n'),
  supporting_cast: ['你是顶级短故事配角设计师。输出 Markdown：## 核心极品/反派角色 / ## 关键支持者/对照组 / ## 喜剧或信息工具人 / ## 关系演变与情绪宣泄点。配角只写功能、冲突价值和记忆点。', HOT_WORD_SECTION].join('\n\n')
}

const activeLoops = new Map<number, AbortController>()
const MAX_STAGNANT_CHECKS = 2
const MAX_BEAT_GENERATION_ROUNDS = 4
const MAX_INCUBATOR_GATE_REPAIR_ROUNDS = 4
const CHARACTER_CARD_FORMAT_ATTEMPTS = 2
const OVERALL_CHECK_FORMAT_ATTEMPTS = 2
const MAX_OVERALL_SETTING_REPAIR_ROUNDS = 3

function readRuntimeState(workId: number): RoutineRuntimeState {
  const raw = goalRoutineDAO.getByWork(workId)?.state_json
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as RoutineRuntimeState
      : {}
  } catch {
    return {}
  }
}

function patchRuntimeState(workId: number, patch: Partial<RoutineRuntimeState>): RoutineRuntimeState {
  const next = { ...readRuntimeState(workId), ...patch }
  goalRoutineDAO.update(workId, { state_json: JSON.stringify(next) })
  return next
}

async function compensatePendingStoryMemory(workId: number, signal?: AbortSignal): Promise<void> {
  const runtime = readRuntimeState(workId)
  const pending = [...new Set(runtime.pendingMemoryChapterIds ?? [])]
  const chapterId = pending[0]
  if (chapterId == null) return
  if (signal?.aborted) throw new Error('已取消')
  const attempts = { ...(runtime.memoryCompensationAttempts ?? {}) }
  const key = String(chapterId)
  if ((attempts[key] ?? 0) >= 2) {
    patchRuntimeState(workId, {
      pendingMemoryChapterIds: pending.filter(id => id !== chapterId),
      memoryCompensationAttempts: attempts
    })
    return
  }
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!chapter?.content?.trim()) {
    patchRuntimeState(workId, { pendingMemoryChapterIds: pending.filter(id => id !== chapterId) })
    return
  }
  try {
    await extractNarrativeMemoryAfterGeneration(workId, chapterId, chapter.content, signal)
    delete attempts[key]
    patchRuntimeState(workId, {
      pendingMemoryChapterIds: pending.filter(id => id !== chapterId),
      memoryCompensationAttempts: attempts
    })
    appLogger.info('goal_routine', '短故事叙事记忆旁路补偿成功', { workId, chapterId })
  } catch (error) {
    if (signal?.aborted) throw error
    attempts[key] = (attempts[key] ?? 0) + 1
    patchRuntimeState(workId, { pendingMemoryChapterIds: pending, memoryCompensationAttempts: attempts })
    appLogger.warn('goal_routine', '短故事叙事记忆旁路补偿未通过，不回滚正文', {
      workId, chapterId, attempts: attempts[key], error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function isGoalLoopRunning(workId: number): boolean {
  return activeLoops.has(workId)
}

export function cancelGoalLoop(workId: number): boolean {
  const controller = activeLoops.get(workId)
  if (!controller) return false
  controller.abort()
  return true
}

/** 关闭应用时调用：中止所有运行中的目标循环并标记为 paused 以便断点续跑 */
export function cancelAllGoalLoops(): void {
  for (const [workId, controller] of activeLoops) {
    controller.abort()
    try {
      goalRoutineDAO.setStatus(workId, 'paused')
    } catch { /* ignore */ }
  }
  activeLoops.clear()
}

function broadcastProgress(channel: string, payload: unknown): void {
  // 目标循环进度需要被所有窗口/视图感知（如作品列表、编辑器），所以广播到全部窗口
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch { /* 接收方已销毁 */ }
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消')
}

function slotMap(workId: number): Record<string, string> {
  const rows = incubatorDraftSlotDAO.listActiveByWork(workId)
  const map: Record<string, string> = {}
  for (const key of STORY_SLOT_KEYS) {
    map[key] = rows.find(r => r.slot_key === key)?.content?.trim() ?? ''
  }
  return map
}

function slotContext(workId: number): string {
  const map = slotMap(workId)
  return STORY_SLOT_KEYS
    .map(key => {
      const text = map[key]?.trim()
      return text ? `## ${getIncubatorSlotLabel(key, 'story')}\n${text}` : ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function formatExpansionSlot(item: ExpansionVersion): string {
  return [
    `# ${item.title}`,
    item.summary,
    item.highlights ? `## 核心亮点\n${item.highlights}` : '',
    item.audience ? `## 受众定位\n${item.audience}` : ''
  ].filter(Boolean).join('\n\n')
}

function formatVariantSlot(item: IncubatorVariant): string {
  return [
    `# ${item.title}`,
    item.dimension ? `## 微创新维度\n${item.dimension}` : '',
    item.summary
  ].filter(Boolean).join('\n\n')
}

function parseSlotCandidates(slotKey: IncubatorSlotKey, raw: string): SlotCandidate[] {
  if (slotKey === 'core_conflict') {
    const variants = parseIncubatorVariants(raw)
    if (variants.length > 0) {
      return variants.map(v => ({ title: v.title, content: formatVariantSlot(v) }))
    }
  }
  const versions = parseExpansionVersions(raw)
  if (versions.length > 0) {
    return versions.map(v => ({ title: v.title, content: formatExpansionSlot(v) }))
  }
  return [{ title: '方案1', content: raw.trim() }]
}

async function selectBestSlotCandidate(
  workId: number,
  slotKey: IncubatorSlotKey,
  goal: string,
  candidates: SlotCandidate[],
  signal?: AbortSignal
): Promise<SelectedSlotCandidate> {
  const fallback = candidates[0] ?? { title: '方案1', content: '' }
  if (candidates.length <= 1) return { ...fallback, total: candidates.length }
  const label = getIncubatorSlotLabel(slotKey, 'story')
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_slot_candidate_score',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      systemPrompt: [
        '你是短故事爆款主线评审。请从候选方案中选择最符合用户创作目标、最能支撑完读率的一项。',
        '只输出 JSON：{"bestIndex":0,"scores":[{"index":0,"score":90,"reason":"..."}]}'
      ].join('\n'),
      prompt: [
        `【槽位】${label}`,
        `【用户创作目标】\n${goal.trim() || '高完读率爆款短故事'}`,
        '【候选方案】',
        JSON.stringify(candidates.map((c, index) => ({ index, title: c.title, content: c.content.slice(0, 1600) })), null, 2)
      ].join('\n\n')
    }),
    { stream: false, signal }
  )

  if (!res.success || !res.content?.trim()) return { ...fallback, total: candidates.length }

  try {
    const json = extractJsonText(res.content.trim()) ?? res.content.trim()
    const parsed = JSON.parse(json) as { bestIndex?: unknown; scores?: Array<{ index?: unknown; score?: unknown; reason?: unknown }> }
    const bestIndex = Number(parsed.bestIndex)
    const scores = Array.isArray(parsed.scores) ? parsed.scores : []
    const picked = Number.isInteger(bestIndex) && bestIndex >= 0 && bestIndex < candidates.length ? bestIndex : 0
    const scoreRow = scores.find(s => Number(s.index) === picked)
    const selected = candidates[picked] ?? fallback
    return {
      ...selected,
      score: Number.isFinite(Number(scoreRow?.score)) ? Math.round(Number(scoreRow?.score)) : undefined,
      reason: scoreRow?.reason != null ? String(scoreRow.reason) : undefined,
      total: candidates.length
    }
  } catch {
    return { ...fallback, total: candidates.length }
  }
}

async function generateSlot(
  workId: number,
  slotKey: IncubatorSlotKey,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<SelectedSlotCandidate> {
  assertNotAborted(signal)
  const promptDef = STORY_INCUBATOR_ANALYSIS_PROMPTS[SLOT_PROMPT_KEYS[slotKey]]
  const label = getIncubatorSlotLabel(slotKey, 'story')
  const existing = slotContext(workId)
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      prompt: [
        `【用户创作目标】\n${goal.trim() || '请自动策划一篇高完读率爆款短故事。'}`,
        existing ? `【已确定槽位】\n${existing}` : '',
        `请生成「${label}」的 3 套候选方案，后续会由独立评审择优回填。`
      ].filter(Boolean).join('\n\n'),
      systemPrompt: promptDef.system,
      step: promptDef.step,
      workId,
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) throw new Error(res.error || `${label}生成失败`)
  const candidates = parseSlotCandidates(slotKey, res.content.trim())
  onProgress?.(`正在从 ${candidates.length} 个候选中评分择优「${label}」`)
  return await selectBestSlotCandidate(workId, slotKey, goal, candidates, signal)
}

export async function incubateStoryline(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<number> {
  let count = 0
  for (const key of STORY_SLOT_KEYS) {
    const label = getIncubatorSlotLabel(key, 'story')
    onProgress?.(`正在孵化「${label}」(${count + 1}/${STORY_SLOT_KEYS.length})`)
    const selected = await generateSlot(workId, key, goal, signal, onProgress)
    updateDraftSlotContent(workId, key, selected.content)
    count++
    onProgress?.(`已从 ${selected.total} 个候选中选择「${selected.title}」${selected.score != null ? `（${selected.score}分）` : ''}并回填「${label}」`)
  }
  const ctx = slotContext(workId)
  coreSettingDAO.upsert(workId, 'idea', ['# 目标循环自动孵化主线', goal.trim() ? `【创作目标】\n${goal.trim()}` : '', ctx].filter(Boolean).join('\n\n'))
  return count
}

async function materializeStorySettings(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<number> {
  const mainline = coreSettingDAO.getByType(workId, 'idea')?.content?.trim() || slotContext(workId)
  let count = 0
  for (const type of STORY_SETTING_TYPES) {
    assertNotAborted(signal)
    onProgress?.(`正在生成核心设定「${type}」(${count + 1}/${STORY_SETTING_TYPES.length})`)
    const existing = STORY_SETTING_TYPES
      .map(t => coreSettingDAO.getByType(workId, t)?.content?.trim() ? `## ${t}\n${coreSettingDAO.getByType(workId, t)?.content?.trim()}` : '')
      .filter(Boolean)
      .join('\n\n')
    const res = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt: [
          goal.trim() ? `【用户创作目标】\n${goal.trim()}` : '',
          `【短故事主线】\n${mainline}`,
          existing ? `【已生成设定】\n${existing}` : ''
        ].filter(Boolean).join('\n\n'),
        systemPrompt: STORY_SETTING_PROMPTS[type],
        step: `settings_${type}`,
        workId,
        enrichWorkContext: false,
        enrichNarrativeMemory: false
      }),
      { stream: false, signal }
    )
    if (!res.success || !res.content?.trim()) throw new Error(res.error || `${type}生成失败`)
    coreSettingDAO.upsert(workId, type, res.content.trim())
    count++
    onProgress?.(`已回填核心设定「${type}」`)
  }
  return count
}

function formatGateFailureReasons(gate: Awaited<ReturnType<typeof runIncubatorGate>>): string {
  const blockers = gate.coherence.filter(c => c.severity === 'blocking')
  return [
    ...blockers.map(b => `[${getIncubatorSlotLabel(b.slotKey, 'story')}] ${b.issue}`),
    ...gate.issues
  ].filter(Boolean).join('；') || '请先修复主线槽位'
}

export async function runStorylineGate(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ serializabilityScore: number; conflictClosureScore: number; repairRounds: number }> {
  let repairRounds = 0
  let lastReason = ''

  while (true) {
    assertNotAborted(signal)
    onProgress?.(repairRounds === 0 ? '正在运行大纲孵化 AI 门禁' : `正在第 ${repairRounds} 轮修复后重新运行 AI 门禁`)
    const gate = await runIncubatorGate(workId, goal.trim() || undefined)
    assertNotAborted(signal)
    if (gate.passed) {
      onProgress?.(`AI 门禁通过：可写性 ${gate.serializabilityScore} · 闭环 ${gate.conflictClosureScore}`)
      return {
        serializabilityScore: gate.serializabilityScore,
        conflictClosureScore: gate.conflictClosureScore,
        repairRounds
      }
    }

    lastReason = formatGateFailureReasons(gate)

    if (repairRounds >= MAX_INCUBATOR_GATE_REPAIR_ROUNDS) {
      throw new GoalPhaseExhaustedError(
        `孵化门禁连续 ${MAX_INCUBATOR_GATE_REPAIR_ROUNDS} 轮修复仍未收敛：${lastReason}`
      )
    }

    onProgress?.(`AI 门禁未通过，正在自动修复主线槽位（第 ${repairRounds + 1} 轮，达标前持续修复）`)
    const beforeFingerprint = stableStoryHash(slotContext(workId))
    const fix = await runGateFix(workId, gate, { sessionTitle: '目标循环门禁自动修复' }, getGoalLoopModelOpts(workId))
    assertNotAborted(signal)
    if (fix.error || fix.applied <= 0) {
      throw new Error(`孵化门禁自动修复失败：${fix.error || '未应用任何槽位修复'}；门禁问题：${lastReason}`)
    }
    if (stableStoryHash(slotContext(workId)) === beforeFingerprint) {
      throw new GoalPhaseExhaustedError(`孵化门禁报告已应用修复但槽位内容没有变化；门禁问题：${lastReason}`)
    }
    repairRounds++
    const labels = fix.slotKeys.map(k => getIncubatorSlotLabel(k, 'story')).join('、')
    onProgress?.(`已自动修复 ${fix.applied} 项槽位：${labels || '主线槽位'}`)
  }
}

export async function freezeStoryline(
  workId: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<number> {
  assertNotAborted(signal)
  onProgress?.('正在冻结孵化版本')
  const frozen = await freezeIncubatorStorylineVersion(workId, '目标循环冻结版', getGoalLoopModelOpts(workId))
  assertNotAborted(signal)
  if (!frozen.success || frozen.versionId == null) throw new Error(frozen.error || '冻结孵化版本失败')
  return frozen.versionId
}

async function generateCharacterCards(
  workId: number,
  goal: string,
  signal?: AbortSignal
): Promise<number> {
  assertNotAborted(signal)
  const ctx = buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true })
  const basePrompt = [
    ctx.text || '（请先填写故事方向）',
    goal.trim() ? `## 用户创作目标\n${goal.trim()}` : ''
  ].filter(Boolean).join('\n\n')
  let lastError = '未知错误'
  for (let attempt = 1; attempt <= CHARACTER_CARD_FORMAT_ATTEMPTS; attempt++) {
    const res = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt: [
          basePrompt,
          attempt > 1 ? `【上一轮无效】${lastError}。重新输出完整且更短的人设卡结构，不要解释。` : ''
        ].filter(Boolean).join('\n\n'),
        systemPrompt: CHARACTER_CARDS_AI_PROMPT,
        workId,
        step: 'character_cards_generate',
        enrichWorkContext: false
      }),
      { stream: false, signal }
    )
    if (!res.success || !res.content?.trim()) {
      lastError = res.error || '主角人设卡片生成无返回'
      continue
    }
    if (res.finishReason === 'length') {
      lastError = '人设卡输出达到长度上限'
      continue
    }
    const parsed = parseCharacterCardsFromAi(res.content)
    if (parsed.length === 0) {
      lastError = 'AI 返回成功，但未能解析人设卡片'
      continue
    }
    const sanitized = sanitizeCharacterCards(parsed)
    const validation = validateCharacterCards(sanitized.cards)
    if (!validation.valid) {
      lastError = `人设卡片未通过结构校验：${validation.errors[0] ?? '未知错误'}`
      continue
    }
    const cards = sanitized.cards.filter(c => c.role === 'protagonist')
    saveCharacterCards(workId, cards.length > 0 ? cards : sanitized.cards)
    return cards.length > 0 ? cards.length : sanitized.cards.length
  }
  throw new Error(`主角人设卡连续 ${CHARACTER_CARD_FORMAT_ATTEMPTS} 次无效：${lastError}`)
}

function buildTitleHookPrompt(workId: number, goal: string): string {
  const slotsContext = slotContext(workId)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const outlineContext = chapters
    .filter(c => c.outline?.trim())
    .map(c => `### ${c.title}\n${c.outline?.trim()}`)
    .join('\n\n')
  return [
    `【大纲孵化内容】\n${slotsContext || '（暂无大纲孵化内容）'}`,
    `【各节拍情节大纲】\n${outlineContext || '（暂无节拍大纲内容）'}`,
    `【故事核心与补充要求】\n${goal.trim() || '（无额外补充）'}`
  ].join('\n\n')
}

function parseTitleHookCandidates(content: string): TitleHookCandidate[] {
  const text = content.trim()
  const jsonText = extractJsonText(text) ?? text.match(/(\{[\s\S]*\})/)?.[1] ?? text
  const parsed = JSON.parse(jsonText) as { candidates?: unknown }
  if (!Array.isArray(parsed.candidates)) return []
  return parsed.candidates
    .map((item): TitleHookCandidate | null => {
      if (!item || typeof item !== 'object') return null
      const row = item as Record<string, unknown>
      const title = typeof row.title === 'string' ? row.title.trim() : ''
      const hook = typeof row.hook === 'string' ? row.hook.trim() : ''
      if (!title || !hook) return null
      const summary = typeof row.summary === 'string' ? row.summary.trim() : ''
      const fallbackText = [title, hook, summary].join('\n')
      const candidate: TitleHookCandidate = {
        title,
        hook,
        tags: normalizeStoryCategoryTags(row.tags, fallbackText)
      }
      if (typeof row.type === 'string') candidate.type = row.type.trim()
      if (summary) candidate.summary = summary
      return candidate
    })
    .filter((x): x is TitleHookCandidate => x != null)
}

function applyTitleHook(workId: number, picked: TitleHookCandidate): void {
  workDAO.update(workId, {
    title: picked.title,
    description: picked.hook,
    genre: picked.tags.main_category || undefined,
    tags: storyCategoryTagsToStorage(picked.tags)
  })
}

const TITLE_HOOK_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array', minItems: 5, maxItems: 5,
      items: {
        type: 'object',
        required: ['title', 'hook', 'type', 'summary', 'tags'],
        properties: {
          title: { type: 'string' }, hook: { type: 'string' }, type: { type: 'string' }, summary: { type: 'string' },
          tags: { type: 'object' }
        }
      }
    }
  }
}
const TITLE_HOOK_GATE_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['valid_indices', 'issues'],
  properties: {
    valid_indices: { type: 'array', items: { type: 'integer' } },
    issues: { type: 'array', items: { type: 'string' } }
  }
}

async function generateTitleHook(
  workId: number,
  goal: string,
  signal?: AbortSignal
): Promise<{ preferred: TitleHookCandidate; preferredIndex: number; candidates: TitleHookCandidate[] }> {
  assertNotAborted(signal)
  let lastIssue = ''
  for (let round = 1; round <= 3; round++) {
    const res = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt: [buildTitleHookPrompt(workId, goal), lastIssue ? `【上一轮硬伤】${lastIssue}` : ''].filter(Boolean).join('\n\n'),
        systemPrompt: [
          '你是番茄短故事的顶流爆款编辑，深谙爆款流量密码。',
          '基于大纲孵化设定、节拍大纲和创作目标，生成 5 个能瞬间抓住读者眼球、让其产生极强追读冲动的短故事书名与导语组合。',
          '书名必须强网感、直击人性弱点、带爽感/反差/悬念/场景刺激。',
          '导语是放在全篇正文最开头、独立于编号节拍之外的钩子场景，不是剧情摘要。',
          '导语 150-300 字，前三句建立明确冲突或异常；叙事视角服从用户目标与正文设定，未指定时优先第一人称；结尾留下具体追问。',
          '导语必须包含当下动作、对话或感官细节，展示一张牌但至少隐藏两张核心牌。',
          '禁止按时间顺序概括全篇；禁止罗列完整计划、全部证据、所有帮手和高潮解法；禁止提前宣布反派如何失败。',
          '禁止“从A到B再到C，每一步都在我的计划里”式总结。读者应知道冲突和异常应对，但不知道终局答案。',
          retentionPackagingRules('story'),
          storyHotWordPromptSection(),
          storyCategoryPromptSection(),
          '必须且只能输出合法 JSON：{"candidates":[{"title":"书名","hook":"导语正文","type":"类型","summary":"一句点评","tags":{"main_category":"主分类","plot":["情节分类"],"character":["角色分类"],"emotion":["情绪分类"],"setting":["背景分类"]}}]}'
        ].join('\n'),
        workId,
        step: 'story_title_hook_gen',
        enrichWorkContext: false,
        forceThinkingDisabled: true,
        responseSchema: { name: 'story_title_hook_candidates', schema: TITLE_HOOK_RESPONSE_SCHEMA, strict: false }
      }),
      { stream: false, signal }
    )
    if (!res.success || !res.content?.trim()) {
      lastIssue = res.error || '爆款书名导语生成无返回'
      continue
    }
    if (res.finishReason === 'length') {
      lastIssue = '书名导语候选输出达到长度上限，请压缩每条导语后重新生成完整 JSON'
      continue
    }
    let candidates: TitleHookCandidate[] = []
    try {
      candidates = parseTitleHookCandidates(res.content)
    } catch (error) {
      lastIssue = `候选 JSON 格式无效：${error instanceof Error ? error.message : String(error)}`
      continue
    }
    if (candidates.length === 0) {
      lastIssue = '未返回可解析候选'
      continue
    }
    const gate = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'story_title_hook_gate',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        maxTokens: 1000,
        forceThinkingDisabled: true,
        responseSchema: { name: 'story_title_hook_gate', schema: TITLE_HOOK_GATE_RESPONSE_SCHEMA, strict: false },
        systemPrompt: [
          '你是短故事导语防剧透门禁。逐项判断是否为具体钩子场景，而非全篇摘要。',
          '若导语罗列完整计划、全部证据/帮手、高潮解法、反派最终下场，或只用概括句交代故事，必须淘汰。',
          '只输出 JSON：{"valid_indices":[0],"issues":["候选1泄露..."]}'
        ].join('\n'),
        prompt: `${formatStoryContractForPrompt(workId)}\n\n【候选】\n${JSON.stringify(candidates.map((candidate, index) => ({ index, title: candidate.title, hook: candidate.hook })), null, 2)}`
      }),
      { stream: false, signal }
    )
    if (!gate.success || !gate.content?.trim()) {
      lastIssue = gate.error || '导语门禁无返回'
      continue
    }
    if (gate.finishReason === 'length') {
      lastIssue = '导语防剧透门禁输出被截断'
      continue
    }
    try {
      const json = extractJsonText(gate.content.trim()) ?? gate.content.trim()
      const parsed = JSON.parse(json) as { valid_indices?: unknown; issues?: unknown }
      const validIndices = Array.isArray(parsed.valid_indices)
        ? parsed.valid_indices.map(Number).filter(index => Number.isInteger(index) && index >= 0 && index < candidates.length)
        : []
      const valid = validIndices.map(index => candidates[index])
      if (valid.length === 0) {
        lastIssue = Array.isArray(parsed.issues) ? parsed.issues.join('；') : '全部候选泄露终局或属于剧情摘要'
        continue
      }
      const picked = await selectPreferredTitleHook(workId, goal, valid, signal)
      return { preferred: picked, preferredIndex: Math.max(0, valid.indexOf(picked)), candidates: valid }
    } catch {
      lastIssue = '导语门禁返回格式无效'
    }
  }
  throw new GoalPhaseExhaustedError(`书名导语连续3轮未通过防剧透门禁：${lastIssue}`)
}

export function applyGoalTitleHookSelection(workId: number, candidateIndex: number): TitleHookCandidate {
  const runtime = readRuntimeState(workId)
  const candidates = runtime.titleHookCandidates ?? []
  if (!Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= candidates.length) {
    throw new Error('书名导语候选不存在或已过期')
  }
  const picked = candidates[candidateIndex]
  const isNovel = workDAO.getById(workId)?.work_type === 'novel'
  if (isNovel) {
    workDAO.update(workId, { title: picked.title, description: picked.hook })
  } else {
    applyTitleHook(workId, picked)
  }
  recordTasteChoice(
    workId,
    'goal_title_hook_pick',
    `${picked.title}｜${picked.hook.slice(0, 140)}`
  )
  const state = goalRoutineDAO.getByWork(workId)
  goalRoutineDAO.appendTurn({
    work_id: workId,
    turn_no: state?.turn_count ?? 0,
    phase: 'generate_title_hook',
    action: 'title_hook_selected',
    summary: `作者确认书名「${picked.title}」`
  })
  patchRuntimeState(workId, {
    titleHookCandidates: undefined,
    titleHookPreferredIndex: undefined
  })
  goalRoutineDAO.update(workId, {
    status: 'paused',
    current_phase: isNovel ? 'draft_body' : 'overall_self_check'
  })
  return picked
}

async function runOverallSelfCheck(
  workId: number,
  signal?: AbortSignal
): Promise<{ report: string; conclusion: QualityConclusion | null }> {
  assertNotAborted(signal)
  const prompt = buildSettingsQualityInput(workId)
  if (!prompt.replace(/（尚未设定）|（无活跃锚点）/g, '').trim()) throw new Error('请先填写故事方向或核心设定后再运行自检')
  let lastError = '整体自检未返回可解析结论'
  for (let attempt = 1; attempt <= OVERALL_CHECK_FORMAT_ATTEMPTS; attempt++) {
    const res = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt: [
          prompt,
          attempt > 1 ? `【格式重试】${lastError}。保留审查结论，但必须按要求给出可解析的最终结论字段。` : ''
        ].filter(Boolean).join('\n\n'),
        systemPrompt: STORY_OVERALL_CHECK_SYSTEM_PROMPT,
        workId,
        step: 'settings_overall_check',
        enrichWorkContext: false
      }),
      { stream: false, signal }
    )
    if (!res.success || !res.content?.trim()) {
      lastError = res.error || '整体自检无返回'
      continue
    }
    if (res.finishReason === 'length') {
      lastError = '整体自检输出达到长度上限'
      continue
    }
    const conclusion = parseQualityConclusion(res.content)
    if (!conclusion) {
      lastError = '整体自检缺少可解析的 verdict、overallScore 或 blockingCount'
      continue
    }
    recordQualityCheck(workId, {
      overall: { report: res.content, checkedAt: new Date().toISOString() }
    })
    return { report: res.content, conclusion }
  }
  throw new Error(`整体自检连续 ${OVERALL_CHECK_FORMAT_ATTEMPTS} 次评估器输出无效：${lastError}`)
}

async function repairSettingsFromOverallCheck(
  workId: number,
  report: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<number> {
  const mainline = coreSettingDAO.getByType(workId, 'idea')?.content?.trim() || slotContext(workId)
  let revised = 0

  for (const type of STORY_SETTING_TYPES) {
    assertNotAborted(signal)
    const current = coreSettingDAO.getByType(workId, type)?.content?.trim() ?? ''
    const otherSettings = STORY_SETTING_TYPES
      .filter(other => other !== type)
      .map(other => {
        const text = coreSettingDAO.getByType(workId, other)?.content?.trim()
        return text ? `## ${other}\n${text}` : ''
      })
      .filter(Boolean)
      .join('\n\n')

    onProgress?.(`正在根据整体自检修订「${type}」`)
    const res = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: `settings_${type}_revise`,
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        systemPrompt: [
          STORY_SETTING_PROMPTS[type],
          '这是门禁修订，不是重新发散。保留已自洽内容，只修复报告指出的阻塞问题；输出完整修订后的 Markdown，不要解释。'
        ].join('\n\n'),
        prompt: [
          `【短故事主线】\n${mainline}`,
          `【当前 ${type}】\n${current || '（空）'}`,
          otherSettings ? `【其他已确定设定】\n${otherSettings}` : '',
          `【整体自检报告】\n${report}`
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!res.success || !res.content?.trim()) {
      throw new Error(res.error || `整体自检修订 ${type} 失败`)
    }
    if (res.content.trim() !== current) {
      coreSettingDAO.upsert(workId, type, res.content.trim())
      revised++
    }
  }
  return revised
}

/** 构造短故事节拍拆解的 system prompt（复刻 ChaptersPanel 的 story 分支） */
function buildBeatBatchSystemPrompt(wordsPerChapter: number, genreText: string, beatCount: number): string {
  const oc = outlineConstraintsForWordTarget(wordsPerChapter)
  const policy = resolveStoryGenrePolicy(genreText)
  const curve = Array.from({ length: beatCount }, (_, index) => {
    const point = tensionCurveForBeat(index + 1, beatCount)
    return `- 第${index + 1}拍：${point.phase}，张力 ${point.min}-${point.max}`
  }).join('\n')
  return [
    '这是一篇一镜到底的短故事。请根据短故事的主线规划，将其拆解为连续的情节节拍（Beats），每个节拍负责推进一段核心剧情。',
    '【极度紧凑与高潮迭起约束 - 硬要求】',
    '短故事要求剧情极度紧凑，节奏极快。禁止安排任何平淡的"过渡节拍"或"日常水文"。',
    '全篇必须有张弛变化。低烈度蓄力拍可以存在，但必须改变线索、关系、认知、风险或现实条件；禁止每拍都强行高潮。',
    formatGenrePolicy(policy, 'beatRules'),
    retentionPlanningRules('story'),
    `【全篇张力曲线 - 必须逐拍执行】\n${curve}`,
    'tension_plan.level 必须落在对应拍区间；payoff_type 只能是 debt/partial/major/aftertaste。相邻两拍禁止无理由连续使用 major。',
    '【第一节拍黄金开局 - 硬约束】',
    'chapters 数组的第一项是全篇第一节拍，决定读者去留。必须满足：',
    '- 标题必须体现核心冲突场景（如"离婚协议甩在脸上"、"全家逼她跪下道歉"），禁止用背景介绍式标题。',
    '- plot_points 第一条必须是冲突的极端场景直接切入（不公/背叛/羞辱/悬念），禁止背景介绍、角色出场铺垫或日常开篇。',
    '- beat_role 必须是 B(推进冲突) 或 A(爽点释放)，禁止 C(反转铺垫)——第一节拍不允许慢热。',
    '- next_hook 必须是能让读者瞬间想看下一拍的强悬念。',
    '【每拍戏剧契约 - 防流水账硬约束】',
    '- 每个节拍都必须像一场戏，而不是事件摘要。必须明确：主角想要什么、谁阻止、失败代价、信息差、压力升级、中段转折、结尾后局面发生什么不可逆变化。',
    '- 如果某拍只是在交代背景、移动地点、解释设定、串联事件，没有不可逆变化，则该拍不合格，必须重设为冲突场。',
    '- dramatic_contract.scene_promise：本拍给读者承诺的爽点/悬念/情绪释放。',
    '- dramatic_contract.protagonist_want：主角此刻明确想得到/阻止/证明什么。',
    '- dramatic_contract.obstacle：具体阻力，必须是人、规则、误会、证据缺失或即时危险，不得写成泛泛困难。',
    '- dramatic_contract.stakes：失败会立刻失去什么，必须具体。',
    '- dramatic_contract.info_gap：读者与角色、主角与对手之间的信息差；没有信息差也要写清"无，靠正面对抗推进"。',
    '- dramatic_contract.pressure_escalation：本拍中压力如何升级，不能只维持原状。',
    '- dramatic_contract.turn：中段揭示/反转/选择，必须改变读者对局面的判断。',
    '- dramatic_contract.irreversible_change：本拍结束后局面发生的不可逆变化，这是防流水账的核心字段。',
    '- dramatic_contract.payoff_or_debt：本拍兑现了什么爽点，或欠下什么更大的情绪债。',
    '- dramatic_contract.next_question：读者结尾最想立刻知道的问题，必须与 next_hook 一致。',
    '【跨拍连续性合同 - 硬约束】',
    '- 每拍必须输出 continuity_contract，明确时间、起止地点、入场/离场事实、人物新获信息、证据或道具状态变化。',
    '- 第二拍起 elapsed_from_previous 必须明确；上一拍 exit_facts 必须能与下一拍 entry_facts 无矛盾衔接，已经发生的关键事件不得换个说法再次发生。',
    '- 中段节拍必须写 opponent_action、opponent_reasoning、damage_to_protagonist、protagonist_adjustment；对手必须造成真实损害，主角必须因此调整计划。',
    '- recap_forbidden 列出读者已经知道、正文不得再次完整复述的信息。',
    '- 最后一拍必须回收全篇故事合同的 must_resolve，不得引入 forbidden_final_threads；next_question 可以为空，余味不能变成新主线。',
    '【每拍情绪契约 - 读者状态变化硬约束】',
    '- emotion_contract 不是情绪标签，必须形成“依恋依据→触发→人物评价→表里冲突→选择与代价→读者推断→余波”。',
    '- 每拍必须区分人物真实感受、愿意承认、对外表现和压抑内容；四项不得写成同义句。',
    '- private_detail_anchor 必须是该人物/关系独有的物件、习惯或共同记忆，禁止心跳、瞳孔、攥拳等通用反应。',
    '- reader_state_before/after 必须有可解释变化；低唤醒拍必须承担依恋、预感、亲密、羞耻或余味功能。',
    `- ${EMOTION_CONTRACT_ENUM_RULE}。不得创造 climax、resolution 等近义枚举。`,
    '【输出格式 - 必须严格遵守】',
    '只输出一个 JSON 对象；禁止 Markdown 标题、前置说明、思考过程，以及 ``` 代码块围栏。',
    'chapters 数组每一项为一个节拍（请勿输出"第X章"或"节拍X"字样，直接写节拍剧情标题即可）。',
    `每章字段：title、plot_points（${oc.pointsMin}-${oc.pointsMax} 条情节节点数组）、dramatic_contract、continuity_contract、tension_plan、emotion_contract、beat_role、foreshadow_target、next_hook、characters（本章出场角色名数组）。`,
    'beat_role: A(爽点释放)/B(推进冲突)/C(反转铺垫)，禁止使用 transition',
    `【长度】每项 plot_points 合计 ${oc.charsMin}-${oc.charsMax} 字梗概（每节拍目标 ${wordsPerChapter} 字正文），禁止正文级长文。`,
    `emotion_contract 格式：${JSON.stringify(EMOTION_CONTRACT_JSON_SHAPE)}`,
    `格式：{"chapters":[{"title":"节拍剧情标题","plot_points":["节点1","节点2","节点3"],"dramatic_contract":{"scene_promise":"...","protagonist_want":"...","obstacle":"...","stakes":"...","info_gap":"...","pressure_escalation":"...","turn":"...","irreversible_change":"...","payoff_or_debt":"...","next_question":"..."},"continuity_contract":{"time_anchor":"...","elapsed_from_previous":"...","start_location":"...","end_location":"...","entry_facts":["..."],"exit_facts":["..."],"knowledge_changes":["..."],"evidence_changes":["..."],"opponent_action":"...","opponent_reasoning":"...","damage_to_protagonist":"...","protagonist_adjustment":"...","recap_forbidden":["..."]},"tension_plan":{"phase":"蓄力与受阻","level":6,"payoff_type":"debt"},"emotion_contract":${JSON.stringify(EMOTION_CONTRACT_JSON_SHAPE)},"beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"]}]}`
  ].join('\n')
}

const BEAT_STAGE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['chapters'],
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'plot_points'],
        properties: {
          title: { type: 'string' },
          plot_points: { type: 'array', items: { type: 'string' } }
        },
        additionalProperties: true
      }
    }
  },
  additionalProperties: false
}

/**
 * 第一阶段只决定全篇事件链，避免模型在同一次请求里为所有节拍展开几十个合同字段。
 */
function buildBeatSkeletonSystemPrompt(wordsPerChapter: number, genreText: string, beatCount: number): string {
  const oc = outlineConstraintsForWordTarget(wordsPerChapter)
  const policy = resolveStoryGenrePolicy(genreText)
  const curve = Array.from({ length: beatCount }, (_, index) => {
    const point = tensionCurveForBeat(index + 1, beatCount)
    return `- 第${index + 1}拍：${point.phase}，张力 ${point.min}-${point.max}`
  }).join('\n')
  return [
    '你是短故事节拍架构师。本阶段只生成全篇事件骨架，不生成正文，也不生成任何 contract 字段。',
    `必须恰好输出 ${beatCount} 个连续节拍；每拍都要改变关系、认知、风险、证据或权力状态。`,
    '第一拍直接进入核心冲突；中段必须出现对手有效反制并造成真实损害；最后一拍完成核心冲突和承诺回收。',
    '相邻节拍必须因果相接，已经发生的关键事件不得换个说法重复发生。',
    formatGenrePolicy(policy, 'beatRules'),
    retentionPlanningRules('story'),
    `【张力曲线】\n${curve}`,
    `每拍 plot_points 必须为 ${oc.pointsMin}-${oc.pointsMax} 条，总计 ${oc.charsMin}-${oc.charsMax} 字。`,
    '只输出合法 JSON，不要 Markdown、说明或思考过程。',
    '只允许以下字段：title、plot_points、beat_role、foreshadow_target、next_hook、characters。',
    '格式：{"chapters":[{"title":"冲突场景标题","plot_points":["事件节点1","事件节点2","事件节点3"],"beat_role":"B","foreshadow_target":"伏笔或回收目标","next_hook":"下一拍具体问题","characters":["角色A"]}]}'
  ].join('\n')
}

async function generateBeatStage(
  workId: number,
  volumeId: number,
  request: { prompt: string; systemPrompt: string; maxTokens: number },
  label: string,
  signal?: AbortSignal,
  validate?: (chapters: ParsedChapter[]) => string | null
): Promise<ParsedChapter[]> {
  let lastError = ''
  for (let attempt = 1; attempt <= BEAT_STAGE_MAX_ATTEMPTS; attempt++) {
    assertNotAborted(signal)
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt: [
          request.prompt,
          lastError ? `【上一请求失败】${lastError}\n请缩短表达并重新输出完整 JSON。` : ''
        ].filter(Boolean).join('\n\n'),
        systemPrompt: request.systemPrompt,
        step: 'volume_chapters_batch',
        workId,
        volumeId,
        maxTokens: request.maxTokens,
        responseSchema: {
          name: label.includes('骨架') ? 'story_beat_skeletons' : 'story_beat_contract',
          schema: BEAT_STAGE_RESPONSE_SCHEMA,
          strict: false
        },
        // basePrompt 已包含冻结故事合同；禁止再次灌入整套核心设定和分卷，避免重复上下文。
        enrichWorkContext: false,
        enrichNarrativeMemory: false
      }),
      { stream: false, signal }
    )
    if (response.success && response.content?.trim()) {
      const parsed = parseChapterSuggestions(response.content.trim())
      if (parsed.length > 0) {
        const validationError = validate?.(parsed) ?? null
        if (!validationError) return parsed
        lastError = validationError
      } else {
        lastError = `${label}返回 JSON 无法解析`
      }
    } else {
      lastError = response.error || `${label}模型未返回内容`
    }
  }
  throw new Error(`${label}连续 ${BEAT_STAGE_MAX_ATTEMPTS} 次失败：${lastError}`)
}

interface BeatGateResult {
  passed: boolean
  score: number
  blockingIssues: string[]
  suggestions: string[]
}


function parseBeatGateResult(content: string): BeatGateResult | null {
  const jsonText = extractJsonText(content.trim()) ?? extractFirstJsonObject(content.trim())
  if (!jsonText) return null
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    const rawPassed = parsed.passed
    if (typeof rawPassed !== 'boolean') return null
    const rawScore = Number(parsed.score)
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0
    const blockingRaw = parsed.blocking_issues ?? parsed.blockingIssues
    const suggestionsRaw = parsed.suggestions
    const blockingIssues = Array.isArray(blockingRaw)
      ? blockingRaw.map(v => String(v).trim()).filter(Boolean)
      : []
    const suggestions = Array.isArray(suggestionsRaw)
      ? suggestionsRaw.map(v => String(v).trim()).filter(Boolean)
      : []
    return { passed: rawPassed, score, blockingIssues, suggestions }
  } catch {
    return null
  }
}

function extractFirstJsonObject(content: string): string | null {
  const start = content.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < content.length; i++) {
    const ch = content[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    if (ch === '}') {
      depth--
      if (depth === 0) return content.slice(start, i + 1)
    }
  }
  return null
}

function buildBeatGatePrompt(goalDescription: string, chapters: ParsedChapter[]): string {
  const authorityCurve = chapters.map((_, index) => {
    const expected = tensionCurveForBeat(index + 1, chapters.length)
    return `第${index + 1}拍：${expected.phase}，允许 ${expected.min}-${expected.max}`
  }).join('\n')
  return [
    goalDescription.trim() ? `【用户创作目标】\n${goalDescription.trim()}` : '',
    `【权威张力曲线 - 允许蓄力回落，禁止要求逐拍单调递增】\n${authorityCurve}`,
    '【待门禁节拍】',
    JSON.stringify(chapters.map((chapter, index) => ({
      index: index + 1,
      title: chapter.title,
      plot_outline: chapter.outline,
      beat_role: chapter.beat_role,
      next_hook: chapter.next_hook,
      characters: chapter.characters,
      dramatic_contract: chapter.dramatic_contract,
      tension_plan: chapter.tension_plan,
      emotion_contract: chapter.emotion_contract,
      continuity_contract: chapter.continuity_contract
    })), null, 2)
  ].filter(Boolean).join('\n\n')
}

async function runBeatGate(
  workId: number,
  goalDescription: string,
  chapters: ParsedChapter[],
  signal?: AbortSignal
): Promise<BeatGateResult> {
  assertNotAborted(signal)
  const tensionIssues = validateTensionPlans(chapters)
  const continuityIssues = validateStoryContinuityContracts(chapters)
  const emotionIssues = chapters.flatMap((chapter, index) => chapter.emotion_contract
    ? validateEmotionContract(chapter.emotion_contract, { isFinalBeat: index === chapters.length - 1 }).map(issue => `第${index + 1}拍${issue}`)
    : [`第${index + 1}拍缺少 emotion_contract`])
  if (tensionIssues.length > 0 || emotionIssues.length > 0 || continuityIssues.length > 0) {
    return {
      passed: false,
      score: 60,
      blockingIssues: [...tensionIssues, ...emotionIssues, ...continuityIssues],
      suggestions: ['按全篇张力曲线重分 tension_plan，并为每拍重建完整情绪因果与跨拍连续性合同']
    }
  }
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      prompt: buildBeatGatePrompt(goalDescription, chapters),
      systemPrompt: [
        '你是短故事节拍门禁主编。你的任务是在正文生成前拦截会导致流水账的节拍大纲。',
        '只输出合法 JSON，不要输出 markdown、解释或代码块。',
        '',
        '【硬性通过条件】',
        '1. 每拍都必须有完整 dramatic_contract，尤其是 protagonist_want、obstacle、stakes、pressure_escalation、turn、irreversible_change；仅最终拍允许 next_question 为空。',
        '2. 每拍必须是一场有目标、阻力、选择和后果的戏，不能只是事件顺序、设定解释、地点移动或背景补充。',
        '3. 每拍结尾必须让局面发生不可逆变化；非最终拍的 next_question/next_hook 必须驱动追读，最终拍必须闭环且不得强行续钩子。',
        '4. 张力必须严格遵守用户提示中的权威曲线；曲线允许蓄力拍回落，不得擅自要求逐拍单调递增。因果压力仍须持续推进。',
        '5. 第一拍必须直接切入极端冲突，不能慢热铺垫。',
        '6. 每拍必须有 tension_plan；level 建议不得越过权威曲线范围。全篇必须存在蓄力、部分兑现、高潮兑现和余味。',
        '7. 每拍必须有完整 emotion_contract；读者依恋、事件意义、人物表里冲突、有代价选择和下一拍余波缺一不可。',
        '8. 每拍必须有完整 continuity_contract；逐拍核对时间、地点、已完成事件、人物知识和证据状态，相邻拍存在矛盾即 blocking issue。',
        '9. 中段必须有基于对手已知信息的有效反制，并实际破坏主角计划；只有挑衅、自曝、下跪或等待主角公布证据不算反制。',
        '10. 最终拍必须完成核心冲突和承诺回收，不得突然引入新反派、新任务或续集钩子。',
        retentionEvaluationRules('story'),
        '',
        '【评分】',
        'score 0-100，85 分以下或存在 blocking_issues 时 passed=false。',
        'blocking_issues 必须写清第几拍、缺什么、为什么会导致流水账。',
        'suggestions 必须给出可直接用于下一轮重生的改法。',
        '输出格式：{"passed":false,"score":70,"blocking_issues":["第2拍缺少不可逆变化..."],"suggestions":["把第2拍改成..."]}'
      ].join('\n'),
      step: 'story_beat_gate',
      workId,
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) {
    throw new Error(res.error || '节拍门禁失败：模型未返回内容')
  }
  const parsed = parseBeatGateResult(res.content)
  if (!parsed) throw new Error('节拍门禁失败：返回 JSON 解析失败')
  if (parsed.score < 85 && parsed.passed) {
    return { ...parsed, passed: false, blockingIssues: parsed.blockingIssues.length > 0 ? parsed.blockingIssues : [`门禁分 ${parsed.score} 低于 85`] }
  }
  if (parsed.blockingIssues.length > 0 && parsed.passed) {
    return { ...parsed, passed: false }
  }
  return parsed
}

function formatBeatGateFeedback(gate: BeatGateResult): string {
  return [
    `上一轮节拍门禁未通过，得分 ${gate.score}。`,
    gate.blockingIssues.length > 0 ? `阻塞问题：\n${gate.blockingIssues.map(x => `- ${x}`).join('\n')}` : '',
    gate.suggestions.length > 0 ? `重生要求：\n${gate.suggestions.map(x => `- ${x}`).join('\n')}` : '',
    '只修复阻塞问题明确指出的字段；未被点名且已通过的合同字段必须保持不变。'
  ].filter(Boolean).join('\n')
}

function cloneBeatChapters(chapters: ParsedChapter[]): ParsedChapter[] {
  return JSON.parse(JSON.stringify(chapters)) as ParsedChapter[]
}

function beatRepairNeighborhood(chapters: ParsedChapter[], index: number): Array<Record<string, unknown>> {
  return chapters
    .slice(Math.max(0, index - 1), Math.min(chapters.length, index + 2))
    .map((chapter, offset) => ({
      index: Math.max(0, index - 1) + offset + 1,
      title: chapter.title,
      plot_outline: chapter.outline,
      next_hook: chapter.next_hook,
      dramatic_contract: chapter.dramatic_contract,
      continuity_contract: chapter.continuity_contract,
      emotion_information_position: chapter.emotion_contract?.information_position ?? null
    }))
}

async function repairBeatSkeletons(
  workId: number,
  volumeId: number,
  skeletons: ParsedChapter[],
  current: ParsedChapter[],
  issues: string[],
  context: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<Set<number>> {
  const modelIssues = issues.filter(beatGateNeedsSkeletonModelRepair)
  const indexes = beatGateRepairIndexes(modelIssues, skeletons.length)
  const repaired = new Set<number>()
  for (const index of indexes) {
    const scopedIssues = beatGateIssuesForIndex(modelIssues, index, skeletons.length)
    if (scopedIssues.length === 0) continue
    onProgress?.(`正在重写第 ${index + 1} 拍事件骨架（保留其余节拍）`)
    const candidates = await generateBeatStage(workId, volumeId, {
      systemPrompt: [
        '你是短故事事件骨架修复编辑。本次只重写指定的一拍，只输出包含一个元素的 chapters 数组。',
        'title 必须原样保留；只允许输出 title、plot_points、beat_role、foreshadow_target、next_hook、characters。',
        '修复触发机制、因果铺垫、事件可信度或最终闭环问题；不得改写其他节拍已经确定的事实。',
        index === skeletons.length - 1
          ? '这是最终拍：必须完成核心冲突，next_hook 必须为空，plot_points 不得包含章末钩子、续集问题或未来任务。'
          : '非最终拍的 next_hook 必须由本拍结果自然产生。',
        '只输出合法 JSON，不要 Markdown、说明或思考过程。'
      ].join('\n'),
      prompt: [
        context,
        `【全篇事件骨架 - 只读】\n${JSON.stringify(compactBeatSkeletons(skeletons), null, 2)}`,
        `【相邻拍当前事实状态 - 必须保持一致】\n${JSON.stringify(beatRepairNeighborhood(current, index), null, 2)}`,
        `【只修复第 ${index + 1} 拍】\n${JSON.stringify(compactBeatSkeletons([skeletons[index]])[0], null, 2)}`,
        `【必须解决的问题】\n${scopedIssues.map(issue => `- ${issue}`).join('\n')}`
      ].join('\n\n'),
      maxTokens: BEAT_CONTRACT_MAX_TOKENS
    }, `第 ${index + 1} 拍骨架修复`, signal,
    chapters => exactStageCountError(chapters.length, 1, '单拍骨架修复返回'))
    const candidate = candidates[0]
    skeletons[index] = sanitizeBeatSkeleton({
      ...skeletons[index],
      title: skeletons[index].title,
      outline: candidate.outline,
      beat_role: candidate.beat_role ?? skeletons[index].beat_role,
      foreshadow_target: candidate.foreshadow_target ?? skeletons[index].foreshadow_target,
      next_hook: candidate.next_hook ?? skeletons[index].next_hook,
      characters: candidate.characters ?? skeletons[index].characters
    }, index === skeletons.length - 1)
    repaired.add(index)
  }
  return repaired
}

async function generateBeatCandidatesWithGate(
  workId: number,
  volumeId: number,
  skeletonSystemPrompt: string,
  contractSystemPrompt: string,
  basePrompt: string,
  goalDescription: string,
  beatCount: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ chapters: ParsedChapter[]; gate: BeatGateResult; rounds: number; degraded: boolean }> {
  const stageKey = storyBeatStageKey(basePrompt, beatCount)
  const storedRuntime = readRuntimeState(workId)
  const storedStage = storedRuntime.beatGenerationStage
  const resumableStage = storedStage?.key === stageKey && storedStage.skeletons.length === beatCount
    ? storedStage
    : undefined
  let gateFeedback = resumableStage?.gateFeedback ?? ''
  let skeletons = resumableStage?.skeletons
  const storedDraft = storedRuntime.beatGenerationDraft
  let best: { chapters: ParsedChapter[]; skeletons: ParsedChapter[]; gate: BeatGateResult; round: number } | null =
    storedDraft?.chapters.length === beatCount
      ? {
          chapters: cloneBeatChapters(storedDraft.chapters),
          skeletons: cloneBeatChapters(skeletons ?? storedDraft.chapters),
          gate: { passed: false, score: storedDraft.score, blockingIssues: storedDraft.issues, suggestions: [] },
          round: storedDraft.round
        }
      : null
  let parsed = resumableStage ? [...resumableStage.enriched] : []
  let repairIndexes = resumableStage?.repairIndexes
  let repairIssues = resumableStage?.gateIssues ?? []
  let previousIssueSignature = ''
  let stagnantIssueRounds = 0

  for (let round = resumableStage?.round ?? 1; round <= MAX_BEAT_GENERATION_ROUNDS; round++) {
    assertNotAborted(signal)
    const isResume = Boolean(skeletons)
    onProgress?.(isResume
      ? `正在定向补全 ${repairIndexes?.length ?? Math.max(0, beatCount - parsed.length)} 个问题节拍（第 ${round}/${MAX_BEAT_GENERATION_ROUNDS} 轮）`
      : `正在生成节拍骨架（第 ${round}/${MAX_BEAT_GENERATION_ROUNDS} 轮）`)
    const prompt = [
      basePrompt,
      gateFeedback ? `【上一轮门禁反馈 - 必须全部修复】\n${gateFeedback}` : ''
    ].filter(Boolean).join('\n\n')

    if (!skeletons) {
      skeletons = await generateBeatStage(workId, volumeId, {
          prompt,
          systemPrompt: skeletonSystemPrompt,
          maxTokens: BEAT_SKELETON_MAX_TOKENS
        }, '节拍骨架', signal, chapters => exactStageCountError(chapters.length, beatCount, '节拍骨架'))
      parsed = []
      repairIndexes = Array.from({ length: skeletons.length }, (_, index) => index)
    }

    // 最终拍闭环属于可确定执行的格式约束，先清除骨架文本中的章末钩子，
    // 避免后续契约修复永远无法触及被锁定的 plot_outline。
    skeletons = skeletons.map((chapter, index) => sanitizeBeatSkeleton(chapter, index === skeletons!.length - 1))
    parsed = parsed.map((chapter, index) => sanitizeBeatSkeleton(chapter, index === skeletons!.length - 1))
    // 定向补拍必须携带上一轮门禁反馈，否则会原样再生成同一个缺字段合同。
    const contractContext = prompt.replace(/\n请输出完整 chapters 数组。?\s*$/, '')
    const structuralRepaired = repairIssues.length > 0
      ? await repairBeatSkeletons(
          workId,
          volumeId,
          skeletons,
          parsed,
          beatGateIssuesForLayer(repairIssues, 'skeleton'),
          contractContext,
          signal,
          onProgress
        )
      : new Set<number>()
    const compactSkeletons = compactBeatSkeletons(skeletons)
    if (!isResume || parsed.length < skeletons.length) {
      patchRuntimeState(workId, {
        beatGenerationStage: {
          key: stageKey, round, gateFeedback, skeletons, enriched: parsed, repairIndexes, gateIssues: repairIssues, updatedAt: new Date().toISOString()
        }
      })
    }
    const contractIssues = beatGateIssuesForLayer(repairIssues, 'contract')
    const structuralContractIndexes = new Set<number>()
    for (const index of structuralRepaired) {
      if (index > 0) structuralContractIndexes.add(index - 1)
      structuralContractIndexes.add(index)
      if (index + 1 < skeletons.length) structuralContractIndexes.add(index + 1)
    }
    const routedRepairIndexes = repairIssues.length > 0
      ? [...new Set([
          ...beatGateContractRepairIndexes(contractIssues, skeletons.length),
          ...structuralContractIndexes
        ])].sort((left, right) => left - right)
      : []
    const indexesToRepair = routedRepairIndexes.length > 0
      ? routedRepairIndexes
      : repairIssues.length > 0
        ? []
        : repairIndexes?.length
          ? repairIndexes
          : Array.from({ length: skeletons.length - parsed.length }, (_, offset) => parsed.length + offset)
    for (const index of indexesToRepair) {
      assertNotAborted(signal)
      const skeleton = skeletons[index]
      let issueScope = beatGateIssuesForIndex(contractIssues, index, skeletons.length)
      if (structuralRepaired.has(index)) {
        issueScope = ['事件骨架已经定向改写：按新骨架重新生成全部合同，并与相邻拍事实状态保持一致']
      } else if (structuralContractIndexes.has(index)) {
        issueScope = ['相邻拍事件骨架已经改变：联动校准 continuity_contract 的事实、知识、时间、地点和证据状态']
      } else if (issueScope.length === 0 && contractIssues.some(issue => /continuity_contract|连续性|时间线|时间锚点|地点|人物认知|知识状态|entry_facts|knowledge_changes|info_gap|证据/.test(issue))) {
        issueScope = ['相邻拍 continuity_contract 联动校准：只修正与相邻拍冲突的事实、知识、时间、地点和证据状态']
      }
      onProgress?.(`正在补全节拍契约 ${index + 1}/${skeletons.length}（第 ${round} 轮）`)
      const candidates = await generateBeatStage(workId, volumeId, {
        systemPrompt: [
          contractSystemPrompt,
          '本次只补全指定的一个节拍。必须沿用给定 title 和事件骨架，只输出包含一个元素的 chapters 数组。',
          '不得扩写正文；所有文本字段用一句话完成。plot_points 只需将给定 plot_outline 压缩为 3-5 条。'
        ].join('\n\n'),
        prompt: [
          contractContext,
          `【全篇节拍骨架 - 只读】\n${JSON.stringify(compactSkeletons, null, 2)}`,
          parsed[index]
            ? `【当前合同与相邻拍事实状态 - 在此基础上定向修复】\n${JSON.stringify(beatRepairNeighborhood(parsed, index), null, 2)}`
            : '',
          `【当前只补全第 ${index + 1} 拍】\n${JSON.stringify(compactSkeletons[index], null, 2)}`,
          issueScope.length > 0 ? `【当前拍必须解决的问题】\n${issueScope.map(issue => `- ${issue}`).join('\n')}` : ''
        ].filter(Boolean).join('\n\n'),
        maxTokens: BEAT_CONTRACT_MAX_TOKENS
      }, `第 ${index + 1} 拍契约补全`, signal,
      chapters => exactStageCountError(chapters.length, 1, '单拍契约返回'))
      parsed[index] = normalizeTensionPlanForBeat(
        mergeStagedBeat(skeleton, candidates[0], {
          current: structuralRepaired.has(index) ? undefined : parsed[index],
          issues: issueScope,
          isFinalBeat: index === skeletons.length - 1
        }),
        index,
        skeletons.length
      )
      patchRuntimeState(workId, {
        beatGenerationStage: {
          key: stageKey, round, gateFeedback, skeletons, enriched: parsed, repairIndexes, gateIssues: repairIssues, updatedAt: new Date().toISOString()
        }
      })
    }

    onProgress?.(`正在运行节拍 AI 门禁（第 ${round} 轮，达标前持续重生）`)
    const gate = await runBeatGate(workId, goalDescription, parsed, signal)
    const resolvedTargetCount = beatGateResolvedTargetCount(repairIssues, gate.blockingIssues, skeletons.length)
    const madeTargetedProgress = resolvedTargetCount > 0
      && (!best || gate.score >= best.gate.score - 5)
      && (!best || gate.blockingIssues.length <= best.gate.blockingIssues.length)
    // 通过硬门禁的候选永远优先于历史高分但仍有阻塞项的草稿。
    const shouldKeep = gate.passed
      || !best
      || gate.score > best.gate.score
      || (gate.score === best.gate.score && gate.blockingIssues.length < best.gate.blockingIssues.length)
      || madeTargetedProgress
    if (shouldKeep) best = { chapters: cloneBeatChapters(parsed), skeletons: cloneBeatChapters(skeletons), gate, round }
    else if (best) {
      parsed = cloneBeatChapters(best.chapters)
      skeletons = cloneBeatChapters(best.skeletons)
      onProgress?.(`本轮引入了更多问题，已回滚到 ${best.gate.score} 分最佳候选`)
    }
    if (best) {
      patchRuntimeState(workId, {
        beatGenerationDraft: {
          round: best.round,
          score: best.gate.score,
          issues: best.gate.blockingIssues,
          chapters: cloneBeatChapters(best.chapters),
          updatedAt: new Date().toISOString()
        }
      })
    }
    if (gate.passed) {
      patchRuntimeState(workId, { beatGenerationDraft: undefined, beatGenerationStage: undefined })
      onProgress?.(`节拍 AI 门禁通过（${gate.score}分，第 ${round} 轮）`)
      return { chapters: parsed, gate, rounds: round, degraded: false }
    }

    const repairGate = shouldKeep || !best ? gate : best.gate
    const issueSummary = gate.blockingIssues.slice(0, 2).join('；') || '未达到门禁标准'
    onProgress?.(`节拍门禁第 ${round}/${MAX_BEAT_GENERATION_ROUNDS} 轮未通过（${gate.score}分）：${issueSummary}`)
    const issueSignature = beatGateIssueSignature(gate.blockingIssues, skeletons.length)
    if (issueSignature && issueSignature === previousIssueSignature && !shouldKeep) stagnantIssueRounds++
    else stagnantIssueRounds = 0
    previousIssueSignature = issueSignature
    const noConvergence = stagnantIssueRounds >= 1
    if (round === MAX_BEAT_GENERATION_ROUNDS || noConvergence) {
      const fallback = best ?? { chapters: parsed, skeletons, gate, round }
      const fallbackIssues = fallback.gate.blockingIssues
      const fallbackIndexes = beatGateRepairIndexes(fallbackIssues, skeletons.length)
      patchRuntimeState(workId, {
        beatGenerationStage: {
          key: stageKey,
          round: 1,
          gateFeedback: formatBeatGateFeedback(fallback.gate),
          skeletons: cloneBeatChapters(fallback.skeletons),
          enriched: cloneBeatChapters(fallback.chapters),
          repairIndexes: fallbackIndexes.length > 0 ? fallbackIndexes : Array.from({ length: skeletons.length }, (_, index) => index),
          gateIssues: fallbackIssues,
          updatedAt: new Date().toISOString()
        }
      })
      throw new Error(
        noConvergence
          ? `节拍门禁连续 2 轮同类问题未收敛，禁止继续消耗调用；最佳候选 ${fallback.gate.score} 分：${fallbackIssues.join('；')}`
          : `节拍门禁连续 ${MAX_BEAT_GENERATION_ROUNDS} 轮未通过，禁止降级进入正文；最佳候选 ${fallback.gate.score} 分：${fallbackIssues.join('；')}`
      )
    }
    // parsed 已回滚到最佳草稿时，下一轮必须按该草稿自己的问题定向修复，
    // 不能拿被丢弃候选的问题去覆盖最佳草稿的字段。
    gateFeedback = formatBeatGateFeedback(repairGate)
    repairIssues = repairGate.blockingIssues
    // “第15拍缺 emotion_contract”这类局部错误只需要补第15拍，不能再付出整组 15 次调用。
    repairIndexes = beatGateRepairIndexes(repairGate.blockingIssues, skeletons.length)
    if (repairIndexes.length === 0) repairIndexes = Array.from({ length: skeletons.length }, (_, index) => index)
    patchRuntimeState(workId, {
      beatGenerationStage: {
        key: stageKey,
        round: round + 1,
        gateFeedback,
        skeletons,
        enriched: parsed,
        repairIndexes,
        gateIssues: repairIssues,
        updatedAt: new Date().toISOString()
      }
    })
  }

  throw new Error('节拍大纲生成未能在有限轮次内完成')
}

/** outline 阶段：若无节拍，生成节拍大纲并入库（注入创作目标） */
async function ensureBeats(
  workId: number,
  goalDescription: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ created: number; error?: string; warning?: string; recovery?: BeatGateRecovery; terminal?: boolean }> {
  const existing = volumeChapterDAO.listChaptersByWork(workId)
  const runtime = readRuntimeState(workId)
  const forceBeatRebuild = runtime.forceBeatRebuild === true
  if (!forceBeatRebuild && existing.some(c => c.content?.trim())) return { created: 0 }
  if (!getStoryContract(workId)) {
    await ensureStoryContract(workId, goalDescription, '', signal, onProgress)
  }

  let volumes = volumeChapterDAO.listVolumes(workId)
  let volumeId = volumes[0]?.id
  if (!volumeId) {
    volumeId = volumeChapterDAO.createVolume(workId, '正文', '短故事主线剧情')
    volumes = volumeChapterDAO.listVolumes(workId)
  }

  const plan = loadWritingPlan(workId)
  const wpc = plan.wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER
  const configuredCount = plan.targetChapters > 0
    ? Math.max(1, Math.round(plan.targetChapters))
    : 5
  // 断点续跑时，未完成的节拍骨架是已投入模型调用成本的唯一事实来源。
  // 不能因写作计划在此期间回落到默认值而把 15 拍的断点悄悄改成 5 拍并从头再来。
  const stagedBeatCount = !forceBeatRebuild ? runtime.beatGenerationStage?.skeletons?.length : undefined
  const suggestedCount = forceBeatRebuild && existing.length > 0
    ? existing.length
    : stagedBeatCount && stagedBeatCount > 0
      ? stagedBeatCount
      : configuredCount

  const vol = volumes[0]
  const work = workDAO.getById(workId)
  const genreText = [work?.genre, work?.tags, goalDescription].filter(Boolean).join('\n')
  const structuralFeedback = runtime.structuralFeedback?.trim() ?? ''
  onProgress?.(`正在生成节拍大纲（约 ${suggestedCount} 个节拍）`)
  const prompt = [
    `【短故事一镜到底】当前需要将其拆解为连续的情节节拍，共约 ${suggestedCount} 个节拍。`,
    formatStoryContractForPrompt(workId),
    goalDescription.trim() ? `【短故事创作目标】${goalDescription.trim()}，请据此拆解节拍（题材/风格/情节走向须贴合目标）` : '',
    structuralFeedback ? `【上一版整篇失败反馈 - 本轮必须从结构上解决】\n${structuralFeedback}` : '',
    vol.description ? `主线说明：${vol.description}` : '',
    '请输出完整 chapters 数组。'
  ].filter(Boolean).join('\n')

  let parsed: ParsedChapter[]
  let gateRounds = 0
  let gateWarning: string | undefined
  try {
    const gated = await generateBeatCandidatesWithGate(
      workId,
      volumeId,
      buildBeatSkeletonSystemPrompt(wpc, genreText, suggestedCount),
      buildBeatBatchSystemPrompt(wpc, genreText, suggestedCount),
      prompt,
      goalDescription,
      suggestedCount,
      signal,
      onProgress
    )
    parsed = gated.chapters
    gateRounds = gated.rounds
    if (gated.degraded) {
      gateWarning = `节拍门禁未达标，已自动采用最佳候选（${gated.gate.score}分）`
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    if (/节拍门禁连续/.test(error)) {
      // 一次生成周期已经最多经历四轮门禁；到这里继续从头重建只会把同一问题放大为数小时等待。
      return { created: 0, error, terminal: true }
    }
    return { created: 0, error }
  }

  const items = parsed.map(p => ({
    title: p.title,
    outline: p.outline ?? '',
    beat_role: p.beat_role ?? null,
    foreshadow_target: p.foreshadow_target ?? null,
    next_hook: p.next_hook ?? null,
    characters: p.characters ?? null,
    emotion_contract_json: p.emotion_contract ? JSON.stringify(p.emotion_contract) : null,
      outline_diagnosis: p.dramatic_contract || p.continuity_contract || p.tension_plan
        ? JSON.stringify({ dramatic_contract: p.dramatic_contract, continuity_contract: p.continuity_contract, tension_plan: p.tension_plan, emotion_contract: p.emotion_contract })
        : null
  }))
  if (forceBeatRebuild && existing.length === items.length) {
    volumeChapterDAO.rewriteStoryBeatsPreservingVersions(existing.map((chapter, index) => ({
      chapterId: chapter.id,
      ...items[index]
    })))
    existing.forEach(chapter => clearChapterNarrativeMemory(workId, chapter.id))
  } else {
    volumeChapterDAO.batchCreateChapters(volumeId, items, existing.length > 0 ? 'replace' : 'append')
  }
  if (structuralFeedback || forceBeatRebuild) {
    patchRuntimeState(workId, {
      structuralFeedback: undefined,
      forceBeatRebuild: undefined,
      beatGateFailureCount: undefined
    })
  }
  onProgress?.(`已回填 ${items.length} 个节拍到节拍大纲（门禁 ${gateRounds} 轮）`)
  return { created: items.length, warning: gateWarning }
}

interface EmDashCleanupResult {
  chapters: number
  replaced: number
}

function cleanupEmDashesAfterPassedGate(workId: number, mode: 'comma' | 'delete' = 'comma'): EmDashCleanupResult {
  const chapters = volumeChapterDAO.listChaptersByWork(workId).filter(c => c.content?.trim())
  let changedChapters = 0
  let replaced = 0

  for (const ch of chapters) {
    const content = ch.content ?? ''
    if (!content.trim()) continue
    const gate = runConsistencyGate(workId, ch.id, content)
    if (gate.blockers.length > 0) continue
    const count = countEmDashes(content)
    if (count <= 0) continue
    const cleaned = stripEmDashes(content, mode)
    if (cleaned === content) continue
    const candidateId = storyHarnessDAO.createCandidate({
      workId,
      chapterId: ch.id,
      content: cleaned,
      wordCount: cleaned.replace(/\s/g, '').length,
      baseContent: content,
      sourceStep: 'deterministic_em_dash_cleanup'
    })
    storyHarnessDAO.markCandidate(candidateId, 'semantic_passed', {
      checks: { deterministicCleanup: 'em_dash', consistencyGate: gate }
    })
    if (!storyHarnessDAO.acceptCandidate(candidateId)) continue
    changedChapters++
    replaced += count
  }

  return { chapters: changedChapters, replaced }
}

/** draft 阶段：取下一个无正文节拍生成正文 */
function nextEmptyBeat(workId: number): { id: number; title: string } | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const empty = chapters.find(c => !c.content?.trim())
  return empty ? { id: empty.id, title: empty.title } : null
}

/** 取正文最短的节拍（字数不足/信息最弱时优先扩写重写） */
function shortestBeat(workId: number): { id: number; title: string } | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId).filter(c => c.content?.trim())
  if (chapters.length === 0) return null
  const shortest = chapters.reduce((a, b) =>
    (a.word_count || 0) < (b.word_count || 0) ? a : b
  )
  return { id: shortest.id, title: shortest.title }
}

/** 取正文最长的节拍（总字数超出时优先压缩重写） */
function longestBeat(workId: number): { id: number; title: string } | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId).filter(c => c.content?.trim())
  if (chapters.length === 0) return null
  const longest = chapters.reduce((a, b) =>
    (a.word_count || 0) > (b.word_count || 0) ? a : b
  )
  return { id: longest.id, title: longest.title }
}

interface DiagnoseFixResult {
  passed: boolean
  rounds: number
  finalScore: number
  emotionScore: number
  bestRound: number
  failedMetrics: string[]
}

interface DiagnoseCandidate {
  round: number
  content: string
  qualityScore: number
  emotionScore: number
  emotionPassed: boolean
  qualityPassed: boolean
  hardFail: boolean
  failedMetrics: string[]
  emotionAssessmentJson: string
}

function isBetterDiagnoseCandidate(
  candidate: DiagnoseCandidate,
  current: DiagnoseCandidate | undefined
): boolean {
  if (!current) return true
  const candidatePassedGates = Number(candidate.qualityPassed && !candidate.hardFail) + Number(candidate.emotionPassed)
  const currentPassedGates = Number(current.qualityPassed && !current.hardFail) + Number(current.emotionPassed)
  if (candidatePassedGates !== currentPassedGates) return candidatePassedGates > currentPassedGates
  if (candidate.failedMetrics.length !== current.failedMetrics.length) {
    return candidate.failedMetrics.length < current.failedMetrics.length
  }
  const candidateFloor = Math.min(candidate.qualityScore, candidate.emotionScore)
  const currentFloor = Math.min(current.qualityScore, current.emotionScore)
  if (candidateFloor !== currentFloor) return candidateFloor > currentFloor
  return candidate.qualityScore + candidate.emotionScore > current.qualityScore + current.emotionScore
}

/**
 * 正文生成后的 AI 诊断 + 修复循环。
 * 持续诊断 → 修复，直到总分达标且承重项无硬伤。
 */
async function diagnoseAndFixUntilPass(
  workId: number,
  chapterId: number,
  qualityMin: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<DiagnoseFixResult> {
  let round = 0
  let bestCandidate: DiagnoseCandidate | undefined
  const storyChapters = volumeChapterDAO.listChaptersByWork(workId)
  const chTitle = volumeChapterDAO.getChapter(chapterId)?.title ?? `#${chapterId}`
  const isFinalBeat = storyChapters[storyChapters.length - 1]?.id === chapterId

  const maxRounds = resolveStoryModelCapability(getGoalLoopModelOpts(workId)).maxIssueRepairs + 1
  while (round < maxRounds) {
    assertNotAborted(signal)
    round++

    const ch = volumeChapterDAO.getChapter(chapterId)
    let content = ch?.content?.trim() ?? ''
    if (!content) {
      return { passed: false, rounds: round, finalScore: 0, emotionScore: 0, bestRound: round, failedMetrics: ['无正文'] }
    }

    const deterministicClean = stripDeterministicAiPatterns(content)
    if (deterministicClean !== content) {
      const committed = await commitStoryBodyCandidate(
        workId,
        chapterId,
        deterministicClean,
        signal,
        onProgress
      )
      if (!committed.success) {
        return {
          passed: false,
          rounds: round,
          finalScore: 0,
          emotionScore: 0,
          bestRound: round,
          failedMetrics: [`确定性清理候选未通过：${committed.error ?? '未知错误'}`]
        }
      }
      content = committed.content
      onProgress?.(`「${chTitle}」已自动删除形容词回环递进等 AI 典型句式`)
    }

    onProgress?.(`「${chTitle}」AI诊断 第${round}轮`)
    const diagRes = await diagnoseChapterQualityAi(workId, chapterId, content, { thinkingEnabled: getGoalLoopModelOpts(workId).thinkingEnabled })

    if (!diagRes.success || diagRes.scoreTotal == null) {
      appLogger.warn('goal_routine', 'AI诊断失败，继续重试', { workId, chapterId, round, error: diagRes.error })
      onProgress?.(`「${chTitle}」第${round}轮诊断失败，正在继续重试`)
      continue
    }

    const breakdown = diagRes.report ? parseStoryQualityAiScoreBreakdown(diagRes.report) : null
    const items = breakdown?.items ?? []

    const failedMetrics = failedCriticalStoryMetrics(items, qualityMin, { finalBeat: isFinalBeat })
    if (diagRes.scoreTotal < qualityMin) failedMetrics.unshift(`总分:${diagRes.scoreTotal}`)
    const emotionAssessment = await assessChapterEmotion(workId, chapterId, content, signal, true)
    if (!emotionAssessment.passed) failedMetrics.push(`情绪门禁:${emotionAssessment.score}`)
    const allPassed = diagRes.scoreTotal >= qualityMin && failedMetrics.length === 0 && !diagRes.hardFail
    const candidate: DiagnoseCandidate = {
      round,
      content,
      qualityScore: diagRes.scoreTotal,
      emotionScore: emotionAssessment.score,
      emotionPassed: emotionAssessment.passed,
      qualityPassed: diagRes.scoreTotal >= qualityMin
        && failedCriticalStoryMetrics(items, qualityMin, { finalBeat: isFinalBeat }).length === 0,
      hardFail: !!diagRes.hardFail,
      failedMetrics: [...failedMetrics],
      emotionAssessmentJson: JSON.stringify(emotionAssessment)
    }
    if (isBetterDiagnoseCandidate(candidate, bestCandidate)) bestCandidate = candidate

    appLogger.info('goal_routine', `AI诊断 第${round}轮`, {
      workId, chapterId, scoreTotal: diagRes.scoreTotal, allPassed,
      failedMetrics, hardFail: diagRes.hardFail
    })

    if (allPassed) {
      onProgress?.(`「${chTitle}」AI诊断通过（${diagRes.scoreTotal}分，第${round}轮）`)
      return {
        passed: true,
        rounds: round,
        finalScore: diagRes.scoreTotal,
        emotionScore: emotionAssessment.score,
        bestRound: round,
        failedMetrics: []
      }
    }

    // 最后一轮之后不再生成一个未经复验的版本，直接回退并保留已验收过的最佳候选。
    if (round === maxRounds) {
      onProgress?.(`「${chTitle}」第${round}轮仍未达标（${diagRes.scoreTotal}分），正在选择最佳候选`)
      break
    }
    onProgress?.(`「${chTitle}」未达标（${diagRes.scoreTotal}分），不达标项：${failedMetrics.join('、')}，正在修复`)

    // 1) 尝试应用诊断返回的 patches（快速文本替换）
    const patches = breakdown?.patches ?? []
    let patched = content
    let patchApplied = 0
    for (const p of patches) {
      if (!p.find) continue
      const next = fuzzyReplace(patched, p.find, p.replace)
      if (next !== null) {
        patched = next
        patchApplied++
      }
    }

    // 2) 若 patches 不够或无 patches，用 LLM 对照诊断报告进行修复
    if (patchApplied === 0 || failedMetrics.length > 2) {
      assertNotAborted(signal)
      const report = [diagRes.report ?? '', emotionRepairHint(emotionAssessment)].filter(Boolean).join('\n\n')
      const plan = loadWritingPlan(workId)
      const wordTarget = plan.wordsPerChapter || 4000
      const systemPrompt = [QUALITY_APPLY_FIXES_PROMPT, STYLE_REWRITE_INSTRUCTION].join('\n\n')
      const fixRes = await modelService.chat(
        withGoalLoopModelOptions(workId, {
          prompt: [
            '【诊断报告】',
            report,
            `\n【目标字数】${wordTarget} 字`,
            '【需要修改的原文】',
            patched
          ].join('\n'),
          systemPrompt,
          workId,
          step: 'body_style_rewrite',
          enrichWorkContext: false,
          enrichNarrativeMemory: false
        }),
        { stream: false, signal }
      )
      if (fixRes.success && fixRes.content?.trim()) {
        patched = normalizeModelBodyOutput(fixRes.content.trim(), 'body_generation')
      }
    }

    if (patched !== content) {
      const committed = await commitStoryBodyCandidate(workId, chapterId, patched, signal, onProgress)
      if (!committed.success) {
        onProgress?.(`「${chTitle}」修复候选未通过提交门禁：${committed.error ?? '未知错误'}`)
        break
      }
      onProgress?.(`「${chTitle}」修复完成（第${round}轮，${patchApplied}条patches + LLM修复）`)
    }
  }
  if (!bestCandidate) {
    return {
      passed: false,
      rounds: round,
      finalScore: 0,
      emotionScore: 0,
      bestRound: round,
      failedMetrics: ['正文诊断未返回有效结果']
    }
  }
  const currentContent = volumeChapterDAO.getChapter(chapterId)?.content?.trim() ?? ''
  if (currentContent !== bestCandidate.content.trim()) {
    const restored = await commitStoryBodyCandidate(
      workId,
      chapterId,
      bestCandidate.content,
      signal,
      onProgress
    )
    if (!restored.success) {
      appLogger.warn('goal_routine', '最佳候选恢复未通过完整提交门禁，保留当前正式正文', {
        workId, chapterId, error: restored.error
      })
    }
  }
  const acceptedContent = volumeChapterDAO.getChapter(chapterId)?.content?.trim() ?? bestCandidate.content
  // 诊断修订会改变正文；按最终正式正文同步重建记忆，避免候选与记忆错位。
  clearChapterNarrativeMemory(workId, chapterId)
  try {
    await extractNarrativeMemoryAfterGeneration(workId, chapterId, acceptedContent, signal)
  } catch (error) {
    appLogger.warn('goal_routine', '保留最佳正文后重建叙事记忆失败（不阻断后续生成）', {
      workId,
      chapterId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  // 正文回滚会使旧盲读和账本失效；必须在记忆清理后重新原子提交情绪结果。
  await assessChapterEmotion(workId, chapterId, acceptedContent, signal, true, true)
  onProgress?.(
    `「${chTitle}」已达到 ${maxRounds} 轮修复上限，保留第 ${bestCandidate.round} 轮最佳候选` +
    `（正文质量 ${bestCandidate.qualityScore} 分，情绪 ${bestCandidate.emotionScore} 分）`
  )
  return {
    passed: false,
    rounds: round,
    finalScore: bestCandidate.qualityScore,
    emotionScore: bestCandidate.emotionScore,
    bestRound: bestCandidate.round,
    failedMetrics: bestCandidate.failedMetrics.length > 0
      ? bestCandidate.failedMetrics
      : ['超过正文质量与情绪联合修复上限']
  }
}

function buildRepairPlan(workId: number, check: GoalCheckResult | undefined): RepairPlan {
  const missing = volumeChapterDAO.listChaptersByWork(workId).filter(c => !c.content?.trim())
  if (missing[0]) {
    return {
      action: 'draft_missing',
      targetChapterIds: [missing[0].id],
      hint: '补写缺失正文，并严格衔接前后节拍。'
    }
  }

  const reasons = check?.reasons.join('；') ?? ''
  if (/确定性成稿门禁/.test(reasons)) {
    const issues = storyHarnessDAO.listIssues(workId).filter(issue => issue.status !== 'resolved')
    const targetChapterIds = [...new Set(issues.flatMap(issue => {
      try {
        const value = JSON.parse(issue.chapter_ids_json ?? '[]')
        return Array.isArray(value) ? value.filter(Number.isInteger) as number[] : []
      } catch {
        return []
      }
    }))]
    const engineLevel = issues.some(issue => issue.scope === 'engine')
    return {
      action: engineLevel ? 'storyline' : 'paragraph',
      targetChapterIds: targetChapterIds.length > 0
        ? targetChapterIds.slice(0, 2)
        : pickWeakChapters(workId, check, 2),
      hint: `只修复确定性门禁列出的证据，不得改动其他已通过事实。${issues.map(issue => `${issue.code}：${issue.message}；验收结果：${issue.expected_result ?? ''}`).join('；')}`,
      issues: issues.map(issue => `${issue.code}：${issue.message}`)
    }
  }
  if (/情绪门禁未通过/.test(reasons)) {
    for (const chapter of volumeChapterDAO.listChaptersByWork(workId)) {
      if (!chapter.emotion_assessment_json) continue
      try {
        const assessment = JSON.parse(chapter.emotion_assessment_json) as EmotionBlindAssessment
        if (assessment.passed) continue
        const action: RepairPlan['action'] = assessment.failure_layer === 'attachment'
          ? 'storyline'
          : assessment.failure_layer === 'arc'
            ? 'beat'
            : assessment.failure_layer === 'prose'
              ? 'paragraph'
              : 'scene'
        return {
          action,
          targetChapterIds: [chapter.id],
          hint: emotionRepairHint(assessment),
          issues: assessment.blocking_issues
        }
      } catch { /* 尝试下一章 */ }
    }
  }
  if (check && /(整篇结构与兑现|试读追读力|创作目标匹配度)/.test(reasons)) {
    const titleTargets = volumeChapterDAO.listChaptersByWork(workId)
      .filter(chapter => check.weakChapterTitles.some(title => chapter.title.includes(title) || title.includes(chapter.title)))
      .map(chapter => chapter.id)
    const targets = titleTargets.length > 0 ? titleTargets.slice(0, 2) : pickWeakChapters(workId, check, 2)
    const layerLabels: Record<GoalCheckResult['weakestLayer'], string> = {
      storyline: '主线层',
      beat: '节拍层',
      scene: '场景层',
      paragraph: '段落层'
    }
    return {
      action: check.weakestLayer,
      targetChapterIds: targets,
      hint: `整篇终审定位为${layerLabels[check.weakestLayer]}问题。必须优先修复因果、承诺与兑现，不得只做措辞润色。${check.storyIssues.length > 0 ? `具体问题：${check.storyIssues.join('；')}` : ''}`,
      issues: check.storyIssues
    }
  }

  if (/创作目标匹配度/.test(reasons)) {
    const targets = pickWeakChapters(workId, check, 2)
    return {
      action: 'goal_align',
      targetChapterIds: targets,
      hint: `当前正文未充分满足用户创作目标。请围绕目标重写本节拍，强化题材、人物动机、关键情节与结局指向。${check?.goalMatchReason ? `偏离原因：${check.goalMatchReason}` : ''}`
    }
  }

  if (/字数超出/.test(reasons)) {
    const target = longestBeat(workId)
    const current = target ? volumeChapterDAO.getChapter(target.id) : null
    const maxTotal = check ? bodyWordCountBounds(check.targetWords).max : 0
    const excess = check && maxTotal > 0 ? Math.max(0, check.totalWords - maxTotal) : 0
    const targetWords = Math.max(600, (current?.word_count ?? 0) - excess - 80)
    return {
      action: 'resize',
      targetChapterIds: target ? [target.id] : [],
      targetWordCounts: target ? { [target.id]: targetWords } : {},
      hint: `当前全篇超出目标上限。将本拍精确重写为约 ${targetWords} 字，删除重复心理、解释和同义反应，只保留选择、阻力、代价与状态变化。`
    }
  }

  if (/字数不足/.test(reasons)) {
    const target = shortestBeat(workId)
    const current = target ? volumeChapterDAO.getChapter(target.id) : null
    const minTotal = check ? bodyWordCountBounds(check.targetWords).min : 0
    const shortage = check && minTotal > 0 ? Math.max(0, minTotal - check.totalWords) : 0
    const targetWords = (current?.word_count ?? 0) + shortage + 80
    return {
      action: 'resize',
      targetChapterIds: target ? [target.id] : [],
      targetWordCounts: target ? { [target.id]: targetWords } : {},
      hint: `当前全篇低于目标下限。将本拍精确重写为约 ${targetWords} 字，只扩充人物选择、对手反制、代价和因果变化，禁止重复情绪或围观反应。`
    }
  }

  if (/anti-AI 规则(?:违规|达到阻塞阈值)/.test(reasons)) {
    const violatingDiagnostics = check?.chapterDiagnostics
      .filter(diagnostic => diagnostic.antiAiViolations > 0) ?? []
    const targetChapterIds = violatingDiagnostics.map(diagnostic => diagnostic.chapterId)
    const details = [...new Set(violatingDiagnostics.flatMap(diagnostic => diagnostic.antiAiViolationDetails ?? []))]
    return {
      action: 'deai',
      targetChapterIds,
      hint: [
        '当前存在 anti-AI 规则违规。只修复确实违规的句子，保留未涉及的情节事实、人物状态和有效表达。',
        '泛白类身体反应如无独立剧情信息就删除；确有作用则改成会产生后果、暴露意图或改变选择的动作。不得换成呼吸一滞、身体僵住、瞳孔骤缩、颤抖或攥拳等同类套话。',
        details.length > 0 ? `确定性检测证据：${details.join('；')}` : ''
      ].filter(Boolean).join('\n')
    }
  }

  if (/原文盲读/.test(reasons)) {
    return {
      action: 'paragraph',
      targetChapterIds: pickWeakChapters(workId, check, 2),
      hint: `原文匿名盲读未通过。只修复真实阅读问题：重复心理、解释过度、电报短句、模板刺激和人物声音雷同。${check?.proseReadReason ?? ''}`,
      issues: check?.storyIssues ?? []
    }
  }

  return {
    action: 'quality',
    targetChapterIds: pickWeakChapters(workId, check, 1),
    hint: '当前质量或一致性未达标。请强化开篇钩子、视角稳定、因果链、反转兑现和节拍结尾钩子。'
  }
}

async function reviseBeatBlueprints(
  workId: number,
  plan: RepairPlan,
  goal: string,
  signal?: AbortSignal
): Promise<number> {
  if (plan.action !== 'storyline' && plan.action !== 'beat') return 0
  const targets = plan.targetChapterIds
    .map(id => volumeChapterDAO.getChapter(id))
    .filter((chapter): chapter is NonNullable<typeof chapter> => chapter != null)
  if (targets.length === 0) return 0

  const userMaxTokens = appPreferenceDAO.getGenerationParams().maxTokens
  let previousFailure = ''
  for (let attempt = 1; attempt <= STRUCTURAL_REPAIR_MAX_ATTEMPTS; attempt++) {
    const maxTokens = structuralRepairTokenBudget(userMaxTokens, targets.length, attempt)
    const res = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'story_repair_blueprint',
        enrichWorkContext: true,
        enrichNarrativeMemory: true,
        temperature: 0.2,
        maxTokens,
        responseSchema: {
          name: 'story_structural_repair',
          strict: false,
          schema: {
            type: 'object',
            required: ['chapters'],
            properties: {
              chapters: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'title', 'plot_points'],
                  properties: {
                    id: { type: 'integer' },
                    title: { type: 'string' },
                    plot_points: { type: 'array', items: { type: 'string' } }
                  },
                  additionalProperties: true
                }
              }
            },
            additionalProperties: false
          }
        },
        systemPrompt: [
          '你是短故事结构修复编辑。只输出一个合法 JSON 对象，不要 Markdown、解释或思考过程。',
          '只返回输入中的待修复节拍；每项 id 必须原样返回，title 也必须保持原样。id 是唯一匹配依据。',
          '保留未被问题证据否定的事实、人物关系和前后拍边界，只修复指出的因果、时间、地点、知识与证据状态问题。',
          '每项返回完整字段：id、title、plot_points、dramatic_contract、continuity_contract、tension_plan、emotion_contract、beat_role、foreshadow_target、next_hook、characters。',
          'plot_points 为 3-5 条；其余文本字段每项只写一句，禁止正文级展开，以确保 JSON 能完整结束。',
          `emotion_contract 枚举必须遵守：${EMOTION_CONTRACT_ENUM_RULE}`,
          '格式：{"chapters":[{"id":123,"title":"原题","plot_points":["节点1","节点2","节点3"],"dramatic_contract":{},"continuity_contract":{},"tension_plan":{"phase":"主动选择与逼近高潮","level":8,"payoff_type":"partial"},"emotion_contract":{},"beat_role":"B","foreshadow_target":"","next_hook":"具体追问","characters":["角色"]}]}'
        ].join('\n'),
        prompt: [
          `【创作目标】\n${goal.trim() || '高完读率短故事'}`,
          `【结构修复证据】\n${plan.hint}`,
          previousFailure
            ? `【上一请求失败】\n${previousFailure}\n本轮必须进一步压缩文字并输出闭合 JSON。`
            : '',
          `【待修复节拍】\n${JSON.stringify(targets.map(chapter => ({
            id: chapter.id,
            title: chapter.title,
            outline: chapter.outline,
            beat_role: chapter.beat_role,
            foreshadow_target: chapter.foreshadow_target,
            next_hook: chapter.next_hook,
            outline_diagnosis: chapter.outline_diagnosis,
            ...(plan.continuityEscalation
              ? {
                  current_text_opening: chapter.content?.slice(0, 1200) ?? '',
                  current_text_ending: chapter.content?.slice(-1800) ?? ''
                }
              : {})
          })), null, 2)}`
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!res.success || !res.content?.trim()) throw new Error(res.error || '结构层节拍修复失败')

    const parsed = parseChapterSuggestions(res.content.trim())
    if (parsed.length === 0) {
      const failure = classifyStructuralRepairParseFailure({
        content: res.content,
        completionTokens: res.usage?.completionTokens,
        maxTokens,
        finishReason: res.finishReason
      })
      previousFailure = failure.message
      if (attempt < STRUCTURAL_REPAIR_MAX_ATTEMPTS) {
        appLogger.warn('goal_routine', '结构修复响应无效，扩大任务预算后有限重试', {
          workId,
          attempt,
          code: failure.code,
          maxTokens,
          nextMaxTokens: structuralRepairTokenBudget(userMaxTokens, targets.length, attempt + 1)
        })
        continue
      }
      throw failure
    }

    const matched = targets.map(target => ({
      target,
      candidate: parsed.find(candidate => candidate.id === target.id)
        ?? parsed.find(candidate => candidate.id == null && candidate.title === target.title)
    }))
    const missing = matched.filter(item => !item.candidate)
    if (missing.length > 0) {
      const failure = new StructuralRepairError(
        'STRUCTURE_TARGET_MISMATCH',
        `结构修复缺少目标节拍 ID：${missing.map(item => item.target.id).join('、')}`
      )
      previousFailure = failure.message
      if (attempt < STRUCTURAL_REPAIR_MAX_ATTEMPTS) continue
      throw failure
    }

    let changed = 0
    for (const { target, candidate: matchedCandidate } of matched) {
      const candidate = matchedCandidate!
      if (candidate.title !== target.title) {
        appLogger.warn('goal_routine', '结构修复按 ID 匹配成功，但模型改写了标题；保留数据库原标题', {
          workId,
          chapterId: target.id,
          expectedTitle: target.title,
          returnedTitle: candidate.title
        })
      }
      const nextFields = {
        outline: candidate.outline,
        beat_role: candidate.beat_role ?? target.beat_role ?? null,
        foreshadow_target: candidate.foreshadow_target ?? target.foreshadow_target ?? null,
        next_hook: candidate.next_hook ?? target.next_hook ?? null,
        characters: candidate.characters ?? target.characters ?? null,
        emotion_contract_json: candidate.emotion_contract
          ? JSON.stringify(candidate.emotion_contract)
          : target.emotion_contract_json ?? null,
        outline_diagnosis: mergeStoryBlueprintDiagnosis(target.outline_diagnosis, candidate)
      }
      const unchanged = nextFields.outline === (target.outline ?? '')
        && nextFields.beat_role === (target.beat_role ?? null)
        && nextFields.foreshadow_target === (target.foreshadow_target ?? null)
        && nextFields.next_hook === (target.next_hook ?? null)
        && nextFields.characters === (target.characters ?? null)
        && nextFields.emotion_contract_json === (target.emotion_contract_json ?? null)
        && nextFields.outline_diagnosis === (target.outline_diagnosis ?? null)
      if (unchanged) continue
      volumeChapterDAO.updateChapterWithVersion(target.id, nextFields)
      changed++
    }
    return changed
  }
  throw new StructuralRepairError('STRUCTURE_PATCH_EMPTY', '结构修复未返回可应用补丁')
}

function pickWeakChapters(workId: number, check: GoalCheckResult | undefined, limit: number): number[] {
  const chapters = volumeChapterDAO.listChaptersByWork(workId).filter(c => c.content?.trim())
  if (chapters.length === 0) return []
  const diagnostics = check?.chapterDiagnostics ?? []
  const ranked = chapters
    .map(ch => {
      const d = diagnostics.find(x => x.chapterId === ch.id)
      const score = (d?.qualityHardFail ? -100 : 0)
        - (d?.gateBlockers ?? 0) * 20
        + (d?.qualityScore ?? 50)
        + (d?.emotionPassed === false ? -80 : 0)
        + Math.max(0, d?.emotionScore ?? 0)
        + Math.min(20, (ch.word_count || 0) / 200)
      return { id: ch.id, score }
    })
    .sort((a, b) => a.score - b.score)
  return ranked.slice(0, limit).map(x => x.id)
}

async function executeRepairPlan(
  workId: number,
  plan: RepairPlan,
  goal: string,
  signal?: AbortSignal,
  onContinuityEvent?: (chapterId: number, event: StoryContinuityRepairEvent) => void
): Promise<{
  summary: string
  continuityFailure?: { chapterId: number; blockers: string[]; attempts: number }
}> {
  if (plan.targetChapterIds.length === 0) return { summary: '无可修复节拍' }
  const summaries: string[] = []
  const originals = new Map(plan.targetChapterIds.map(id => [id, volumeChapterDAO.getChapter(id)]))
  const revisedBlueprints = await reviseBeatBlueprints(workId, plan, goal, signal)
  for (const chapterId of plan.targetChapterIds) {
    assertNotAborted(signal)
    const ch = volumeChapterDAO.getChapter(chapterId)
    const original = originals.get(chapterId)
    const baseline = original?.content?.trim() ?? ch?.content?.trim() ?? ''
    const gen = await generateBeatBody(workId, chapterId, {
      signal,
      goalDescription: goal,
      extraHint: plan.hint,
      wordTargetOverride: plan.targetWordCounts?.[chapterId],
      onContinuityEvent: event => onContinuityEvent?.(chapterId, event)
    })
    if (!gen.success && gen.requiresEscalation) {
      return {
        summary: `${ch?.title ?? chapterId} 连续性候选修复未收敛，准备提升修复层级`,
        continuityFailure: {
          chapterId,
          blockers: gen.continuityBlockers ?? [gen.error || '连续性修复未通过'],
          attempts: gen.continuityRepairRounds ?? 0
        }
      }
    }
    if (!gen.success) throw new Error(gen.error || '修复生成失败')
    if (!baseline) {
      summaries.push(`${ch?.title ?? chapterId} ${gen.wordCount}字`)
      continue
    }

    if (plan.forensicIssues?.length || plan.continuityEscalation) {
      // 法医修复候选保留在章节版本历史中，不用通用文风偏好将其回退。
      // 是否真正消除硬伤由下一轮整篇法医审计判定。
      summaries.push(`${ch?.title ?? chapterId} ${gen.wordCount}字（结构升级候选，待整篇复验）`)
      continue
    }

    const current = volumeChapterDAO.getChapter(chapterId)
    const comparison = await compareRepairCandidate(
      workId,
      goal,
      current?.outline ?? ch?.outline ?? '',
      baseline,
      gen.content,
      signal
    )
    if (comparison.preferCandidate) {
      const emotion = await assessChapterEmotion(workId, chapterId, gen.content, signal, true)
      if (emotion.passed) {
        summaries.push(`${ch?.title ?? chapterId} ${gen.wordCount}字（盲评新版 ${comparison.candidateWins}:${comparison.baselineWins} 胜出，情绪门禁 ${emotion.score}分）`)
        continue
      }
    }

    const restoreCandidateId = storyHarnessDAO.createCandidate({
      workId,
      chapterId,
      content: baseline,
      wordCount: baseline.replace(/\s/g, '').length,
      baseContent: current?.content,
      sourceStep: 'pairwise_baseline_restore'
    })
    storyHarnessDAO.markCandidate(restoreCandidateId, 'semantic_passed', {
      checks: { pairwiseComparison: comparison, restoredAcceptedBaseline: true }
    })
    if (!storyHarnessDAO.acceptCandidate(restoreCandidateId)) {
      throw new Error(`「${ch?.title ?? chapterId}」基线候选原子恢复失败`)
    }
    if ((plan.action === 'storyline' || plan.action === 'beat') && original) {
      volumeChapterDAO.updateChapterWithVersion(chapterId, {
        outline: original.outline ?? '',
        beat_role: original.beat_role ?? null,
        foreshadow_target: original.foreshadow_target ?? null,
        next_hook: original.next_hook ?? null,
        characters: original.characters ?? null,
        outline_diagnosis: original.outline_diagnosis ?? null,
        emotion_contract_json: original.emotion_contract_json ?? null,
        emotion_assessment_json: original.emotion_assessment_json ?? null
      })
    }
    clearChapterNarrativeMemory(workId, chapterId)
    try {
      await extractNarrativeMemoryAfterGeneration(workId, chapterId, baseline, signal)
      await ensureChapterEmotionOutcome(workId, chapterId, baseline, signal)
    } catch (error) {
      appLogger.warn('goal_routine', '回滚后重建叙事记忆或情绪账本失败', {
        workId,
        chapterId,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
    summaries.push(`${ch?.title ?? chapterId} 已回滚（${comparison.preferCandidate ? '新版情绪门禁未通过' : comparison.reason}）`)
  }
  return {
    summary: `${revisedBlueprints > 0 ? `修订 ${revisedBlueprints} 个节拍蓝图；` : ''}${summaries.join('；')}`
  }
}

const VALID_PHASES: Phase[] = GOAL_ROUTINE_PHASE_ORDER

function isResumable(status: string | null | undefined): boolean {
  return status === 'paused' || status === 'running' || status === 'cancelled' || status === 'timeout'
}

function goalCheckComposite(check: GoalCheckResult): number {
  const quality = check.qualityScore >= 0 ? check.qualityScore : 0
  return Math.round(
    (quality + check.emotionScore + check.goalMatchScore + check.overallStoryScore + check.previewHookScore + check.proseReadScore) / 6
    - check.gateBlockers * 5
    - Math.min(20, check.antiAiViolations)
  )
}

function goalCheckSignature(check: GoalCheckResult): string {
  return check.reasons
    .map(reason => reason.replace(/\d+(?:\.\d+)?/g, '#').split('：')[0])
    .sort()
    .join('|')
}

/** 存在未完成进度、应续跑而非从头孵化 */
export function shouldResumeGoalLoop(workId: number): boolean {
  const existing = goalRoutineDAO.getByWork(workId)
  if (!existing || existing.goal_met) return false
  if (!isResumable(existing.status)) return false
  if (existing.status === 'timeout') return true
  if (existing.status === 'paused' || existing.status === 'cancelled') {
    return (existing.turn_count ?? 0) > 0 || Boolean(existing.current_phase)
  }
  return false
}

/**
 * 运行短故事目标循环，直到目标达成或轮次上限。
 * 非阻塞：在后台异步跑，通过 sender 发 goal:progress 事件。
 *
 * @param resume true 时从 DB 中保存的 phase/turn/config 继续执行（断点续跑）。
 */
export async function runStoryGoalLoop(
  workId: number,
  config: Partial<StoryGoalConfig> = {},
  sender?: WebContents,
  resume = false,
  forcePhase?: Phase
): Promise<void> {
  if (activeLoops.has(workId)) {
    throw new Error('该作品已有目标循环在运行')
  }

  const existing = goalRoutineDAO.getByWork(workId)
  let fullConfig: StoryGoalConfig
  let turn: number
  let phase: Phase
  const explicitPhase = forcePhase && isGoalRoutinePhase(forcePhase) ? forcePhase : undefined

  if (resume && existing && isResumable(existing.status)) {
    const saved = existing.goal_config_json
      ? { ...DEFAULT_STORY_GOAL_CONFIG, ...JSON.parse(existing.goal_config_json) as Partial<StoryGoalConfig> }
      : { ...DEFAULT_STORY_GOAL_CONFIG }
    fullConfig = { ...saved, ...config }
    turn = existing.turn_count ?? 0
    const savedPhase = existing.current_phase as Phase
    phase = explicitPhase ?? (VALID_PHASES.includes(savedPhase) ? savedPhase : 'materialize_settings')
    appLogger.info('goal_routine', '目标循环断点续跑', { workId, phase, turn, config: fullConfig })
  } else if (explicitPhase && existing) {
    const saved = existing.goal_config_json
      ? { ...DEFAULT_STORY_GOAL_CONFIG, ...JSON.parse(existing.goal_config_json) as Partial<StoryGoalConfig> }
      : { ...DEFAULT_STORY_GOAL_CONFIG }
    fullConfig = { ...saved, ...config }
    turn = 0
    phase = explicitPhase
    appLogger.info('goal_routine', '目标循环从指定步骤启动新一轮', { workId, phase, turn, config: fullConfig })
  } else {
    fullConfig = { ...DEFAULT_STORY_GOAL_CONFIG, ...config }
    turn = 0
    phase = explicitPhase ?? 'materialize_settings'
  }

  fullConfig.maxTurns = requireGoalTurnLimit(fullConfig.maxTurns)

  const controller = new AbortController()
  activeLoops.set(workId, controller)
  bindGoalLoopModelOpts(workId, fullConfig)

  goalRoutineDAO.ensure(workId)
  const retainedEvaluationHistory = readRuntimeState(workId).evaluationHistory
  goalRoutineDAO.update(workId, {
    status: 'running',
    max_turns: fullConfig.maxTurns,
    turn_count: turn,
    current_phase: phase,
    goal_met: false,
    goal_config_json: JSON.stringify(fullConfig),
    ...(!resume
      ? { state_json: JSON.stringify(retainedEvaluationHistory ? { evaluationHistory: retainedEvaluationHistory } : {}) }
      : {})
  })

  let lastCheck: GoalCheckResult | undefined
  const emit = (message: string, status: string) => {
    const ev: GoalProgressEvent = {
      workId, turn, maxTurns: fullConfig.maxTurns, phase, status, check: lastCheck, message
    }
    patchRuntimeState(workId, {
      liveProgress: {
        turn,
        phase,
        status,
        message,
        updatedAt: new Date().toISOString()
      }
    })
    appLogger.info('goal_progress', message, { workId, turn, phase, status })
    broadcastProgress('goal:progress', ev)
  }

  const recordContinuityEvent = (
    chapterId: number,
    chapterTitle: string,
    event: StoryContinuityRepairEvent
  ) => {
    const action = event.type === 'rejected'
      ? 'continuity_gate'
      : event.type === 'repaired'
        ? 'continuity_repair'
        : event.type === 'passed'
          ? 'continuity_pass'
          : 'continuity_retry'
    const summary = event.type === 'rejected'
      ? `「${chapterTitle}」候选第 ${event.candidateRound} 轮连续性门禁未通过，已保存候选版本：${event.blockers.join('；')}`
      : event.type === 'repaired'
        ? `「${chapterTitle}」已按上一轮阻塞证据生成第 ${event.candidateRound} 轮定向修复候选（${event.wordCount}字）`
        : event.type === 'passed'
          ? `「${chapterTitle}」候选第 ${event.candidateRound} 轮跨拍连续性门禁通过`
          : `「${chapterTitle}」连续性评估器无效，保留候选并重试审计：${event.blockers.join('；')}`
    goalRoutineDAO.appendTurn({
      work_id: workId,
      turn_no: turn,
      phase,
      action,
      target_chapter_id: chapterId,
      summary
    })
  }

  const escalateContinuityFailure = async (
    chapterId: number,
    blockers: string[],
    attempts: number
  ): Promise<StoryContinuityEscalationRoute> => {
    const sourcePhase = phase
    const chapters = volumeChapterDAO.listChaptersByWork(workId)
    const runtime = readRuntimeState(workId)
    const previous = runtime.continuityRepairFailure?.fingerprint
      ? {
          fingerprint: runtime.continuityRepairFailure.fingerprint,
          count: runtime.continuityRepairFailure.escalationCount ?? 0
        }
      : undefined
    const route = routeStoryContinuityEscalation(
      chapters.map(chapter => chapter.id),
      chapterId,
      blockers,
      previous
    )
    const plan: RepairPlan = {
      action: route.mode === 'engine' || route.mode === 'storyline' || route.mode === 'simplify' ? 'storyline' : 'beat',
      targetChapterIds: route.targetChapterIds,
      hint: route.hint,
      issues: blockers,
      continuityEscalation: true
    }
    patchRuntimeState(workId, {
      continuityRepairFailure: {
        chapterId,
        blockers,
        attempts,
        fingerprint: route.fingerprint,
        escalationCount: route.count,
        updatedAt: new Date().toISOString()
      },
      structuralFeedback: route.hint
    })

    if (route.mode === 'contract') {
      coreSettingDAO.deleteByWorkAndTypes(workId, ['story_contract'])
      emit('连续性问题已升级到故事合同，正在自动重建合同', 'running')
      await ensureStoryContract(
        workId,
        fullConfig.goalDescription,
        route.hint,
        controller.signal,
        message => emit(message, 'running')
      )
      patchRuntimeState(workId, { repairPlan: plan })
      phase = 'repair_execute'
    } else if (route.mode === 'engine') {
      coreSettingDAO.deleteByWorkAndTypes(workId, ['story_engine', 'story_contract', 'emotion_engine'])
      patchRuntimeState(workId, { continuityPendingRepair: plan })
      phase = 'story_engine_gate'
    } else if (route.mode === 'storyline' || route.mode === 'simplify') {
      patchRuntimeState(workId, {
        repairPlan: undefined,
        continuityPendingRepair: undefined,
        forceBeatRebuild: true
      })
      phase = 'generate_beats'
    } else {
      patchRuntimeState(workId, { repairPlan: plan })
      phase = 'repair_execute'
    }

    goalRoutineDAO.appendTurn({
      work_id: workId,
      turn_no: turn,
      phase: sourcePhase,
      action: 'continuity_escalate',
      target_chapter_id: chapterId,
      summary: `连续性候选层修复未收敛，自动升级到 ${route.mode} 层（同类第 ${route.count} 次）：${route.hint}`
    })
    emit(`连续性修复未收敛，已自动升级到 ${route.mode} 层继续运行`, 'running')
    return route
  }

  appLogger.info('goal_routine', '目标循环启动', { workId, config: fullConfig })

  try {
    const pendingTitleReview = readRuntimeState(workId).titleHookCandidates
    if (phase === 'overall_self_check' && pendingTitleReview && pendingTitleReview.length > 0) {
      const runtime = readRuntimeState(workId)
      const preferredIndex = runtime.titleHookPreferredIndex ?? 0
      const preferred = pendingTitleReview[preferredIndex] ?? pendingTitleReview[0]
      applyTitleHook(workId, preferred)
      patchRuntimeState(workId, {
        titleHookCandidates: undefined,
        titleHookPreferredIndex: undefined
      })
      emit(`已自动采用待确认书名「${preferred.title}」，继续整体自检`, 'running')
    }

    while (true) {
      if (controller.signal.aborted) {
        goalRoutineDAO.setStatus(workId, 'cancelled')
        emit('已取消', 'cancelled')
        return
      }

      if (turn >= fullConfig.maxTurns) {
        const runtime = readRuntimeState(workId)
        const automationEpoch = runtime.automationEpoch ?? 0
        if (canStartStoryFallbackEpoch(automationEpoch)) {
          const nextEpoch = automationEpoch + 1
          const fallbackFeedback = [
            `自动生产第 ${nextEpoch + 1} 阶段：上一阶段已耗尽局部预算，现强制降低故事复杂度并重建全篇。`,
            '只保留一个核心冲突、一个倒计时、一个证据载体和最少必要人物；删除非必要身份反转、巧合式官方到场与重复打脸。',
            '每拍最多一次地点迁移和一次证据状态变化；结局只兑现核心冲突，不开新线。'
          ].join('\n')
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'auto_simplify_rollover',
            summary: `首阶段 ${fullConfig.maxTurns} 轮预算耗尽，自动进入降复杂度重建阶段 ${nextEpoch + 1}`
          })
          patchRuntimeState(workId, {
            automationEpoch: nextEpoch,
            forceBeatRebuild: true,
            structuralFeedback: fallbackFeedback,
            repairPlan: undefined,
            continuityRepairFailure: undefined,
            continuityPendingRepair: undefined,
            terminalReason: undefined
          })
          turn = 0
          phase = 'generate_beats'
          goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
          emit('首阶段预算耗尽，已自动降复杂度并开启一次有界的全篇重建，不需要人工介入', 'running')
          continue
        }
        goalRoutineDAO.appendTurn({
          work_id: workId,
          turn_no: turn,
          phase,
          action: 'budget_exhausted',
          summary: `已使用 ${fullConfig.maxTurns} 轮硬预算，自动修复停止，等待人工编辑决策`
        })
        patchRuntimeState(workId, { terminalReason: 'needs_manual_editor' })
        goalRoutineDAO.setStatus(workId, 'paused')
        emit('目标循环已达到硬预算上限，正文和候选均已保留；需要人工编辑后从指定阶段继续', 'paused')
        return
      }

      turn++
      goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
      const attemptedPhase = phase
      // 每轮在发起模型调用前就落库。过去节拍门禁通过 continue 回到本阶段时，
      // 轮次 4/5/6 没有成功或 error 记录，界面因而只能看到 1/2/3 和实时轮次。
      goalRoutineDAO.appendTurn({
        work_id: workId,
        turn_no: turn,
        phase: attemptedPhase,
        action: 'phase_start',
        summary: `开始执行「${attemptedPhase}」阶段`
      })

      try {
        if (phase === 'incubate_outline') {
          const count = await incubateStoryline(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'incubate', summary: `完成 ${count} 个孵化槽位`
          })
          emit(`完成 ${count} 个孵化槽位`, 'running')
          phase = 'incubator_gate'
        } else if (phase === 'incubator_gate') {
          const res = await runStorylineGate(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'gate',
            score: Math.min(res.serializabilityScore, res.conflictClosureScore),
            summary: res.repairRounds > 0
              ? `门禁通过：自动修复 ${res.repairRounds} 轮 · 可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`
              : `门禁通过：可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`
          })
          emit(res.repairRounds > 0
            ? `门禁通过：已自动修复 ${res.repairRounds} 轮 · 可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`
            : `门禁通过：可写性 ${res.serializabilityScore} · 闭环 ${res.conflictClosureScore}`, 'running')
          phase = 'freeze_storyline'
        } else if (phase === 'freeze_storyline') {
          const versionId = await freezeStoryline(workId, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'freeze',
            summary: `冻结孵化版本 #${versionId}`
          })
          emit(`冻结孵化版本 #${versionId}`, 'running')
          phase = 'materialize_settings'
        } else if (phase === 'materialize_settings') {
          const count = await materializeStorySettings(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'settings', summary: `生成 ${count} 项核心设定`
          })
          emit(`生成 ${count} 项核心设定`, 'running')
          phase = 'generate_character_cards'
        } else if (phase === 'generate_character_cards') {
          emit('正在生成主角人设卡片', 'running')
          const count = await generateCharacterCards(workId, fullConfig.goalDescription, controller.signal)
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'character_cards', summary: `生成 ${count} 张主角人设卡片`
          })
          emit(`生成 ${count} 张主角人设卡片`, 'running')
          phase = 'story_engine_gate'
        } else if (phase === 'story_engine_gate') {
          const runtime = readRuntimeState(workId)
          const result = await ensureStoryEngine(
            workId,
            fullConfig.goalDescription,
            runtime.structuralFeedback ?? '',
            controller.signal,
            message => emit(message, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'engine_gate',
            score: result.score,
            summary: `故事发动机通过（${result.score}分，${result.rounds}轮）`
          })
          await ensureStoryContract(
            workId,
            fullConfig.goalDescription,
            runtime.structuralFeedback ?? '',
            controller.signal,
            message => emit(message, 'running')
          )
          phase = 'emotion_engine_gate'
        } else if (phase === 'emotion_engine_gate') {
          const result = await ensureEmotionEngine(
            workId, fullConfig.goalDescription, 'story', controller.signal,
            message => emit(message, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'emotion_engine_gate',
            score: result.score, summary: `情绪发动机通过（${result.score}分，${result.rounds}轮）`
          })
          emit(`情绪发动机通过（${result.score}分）`, 'running')
          phase = 'generate_beats'
        } else if (phase === 'generate_beats') {
          const res = await ensureBeats(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          if (res.error) throw (res.terminal ? new GoalPhaseExhaustedError(res.error) : new Error(res.error))
          if (res.recovery === 'retry_beats') {
            emit('节拍门禁未通过，保留故事发动机并在节拍层定向重建', 'running')
            phase = 'generate_beats'
            continue
          }
          if (res.recovery === 'rebuild_contract') {
            coreSettingDAO.deleteByWorkAndTypes(workId, ['story_contract'])
            emit('节拍层两次未收敛，保留故事发动机，仅重建全篇合同后继续', 'running')
            phase = 'generate_beats'
            continue
          }
          if (res.recovery === 'simplify') {
            emit('节拍层仍未收敛，已自动降复杂度并继续在节拍层重建', 'running')
            phase = 'generate_beats'
            continue
          }
          if (res.recovery === 'rebuild_engine') {
            coreSettingDAO.deleteByWorkAndTypes(workId, ['story_engine', 'story_contract', 'emotion_engine'])
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'storyline',
              summary: res.warning ?? '节拍硬门禁未通过，回退故事发动机'
            })
            emit('节拍硬门禁未通过，已回退故事发动机重建', 'running')
            phase = 'story_engine_gate'
            continue
          }
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'beats',
            summary: res.warning ?? (res.created > 0 ? `生成 ${res.created} 个节拍` : '复用已有节拍')
          })
          emit(res.warning ?? (res.created > 0 ? `生成 ${res.created} 个节拍` : '复用已有节拍'), 'running')
          phase = 'generate_title_hook'
        } else if (phase === 'generate_title_hook') {
          emit('正在生成爆款书名和导语', 'running')
          const selection = await generateTitleHook(workId, fullConfig.goalDescription, controller.signal)
          applyTitleHook(workId, selection.preferred)
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'title_hook',
            summary: `盲评后应用书名「${selection.preferred.title}」`
          })
          emit(`已应用盲评胜出的书名「${selection.preferred.title}」和导语`, 'running')
          phase = 'overall_self_check'
        } else if (phase === 'overall_self_check') {
          emit('正在运行整体自检', 'running')
          const result = await runOverallSelfCheck(workId, controller.signal)
          const conclusionText = result.report.match(/(PASS|FAIL|REVISE|通过|不通过|需修订).{0,40}/i)?.[0] ?? '自检完成'
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'overall_check',
            score: result.conclusion?.overallScore ?? null,
            summary: conclusionText
          })
          const passed = result.conclusion != null
            && result.conclusion.blockingCount === 0
            && result.conclusion.overallScore >= PASS_SCORE_THRESHOLD
            && result.conclusion.verdict === 'pass'
          if (passed) {
            patchRuntimeState(workId, { overallRepairRounds: 0 })
            emit(`整体自检通过：${result.conclusion?.overallScore ?? '-'}分`, 'running')
            phase = 'draft_body'
          } else {
            const runtime = readRuntimeState(workId)
            const repairRound = runtime.overallRepairRounds ?? 0
            if (repairRound >= MAX_OVERALL_SETTING_REPAIR_ROUNDS) {
              throw new GoalPhaseExhaustedError(
                `核心设定整体自检经过 ${MAX_OVERALL_SETTING_REPAIR_ROUNDS} 轮定向修订仍未通过`
                + `；最后结论：${conclusionText}`
              )
            }
            const revised = await repairSettingsFromOverallCheck(
              workId,
              result.report,
              controller.signal,
              message => emit(message, 'running')
            )
            patchRuntimeState(workId, { overallRepairRounds: repairRound + 1 })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'settings_repair',
              summary: `整体自检未通过，已修订 ${revised} 项设定（第 ${repairRound + 1} 轮，达标前持续修订）`
            })
            emit(`整体自检未通过，已修订 ${revised} 项设定并重新生成依赖内容`, 'running')
            phase = 'generate_character_cards'
          }
        } else if (phase === 'draft_body') {
          const pendingRepair = readRuntimeState(workId).continuityPendingRepair
          if (pendingRepair) {
            patchRuntimeState(workId, {
              repairPlan: pendingRepair,
              continuityPendingRepair: undefined
            })
            emit('故事发动机已重建，继续执行连续性结构升级计划', 'running')
            phase = 'repair_execute'
            continue
          }
          await compensatePendingStoryMemory(workId, controller.signal)
          const beat = nextEmptyBeat(workId)
          if (!beat) {
            emit('正文已全部生成，进入目标验收', 'running')
            phase = 'goal_check'
          } else {
            emit(`正在生成正文「${beat.title}」`, 'running')
            const continuityFailure = readRuntimeState(workId).continuityRepairFailure
            const gen = await generateBeatBody(workId, beat.id, {
              signal: controller.signal,
              goalDescription: fullConfig.goalDescription,
              extraHint: continuityFailure?.chapterId === beat.id && continuityFailure.blockers.length > 0
                ? `【上一次连续性修复仍未收敛】\n${continuityFailure.blockers.map((item, i) => `${i + 1}. ${item}`).join('\n')}\n本次初稿必须从源头规避这些问题。`
                : undefined,
              onProgress: message => emit(`「${beat.title}」${message}`, 'running'),
              onContinuityEvent: event => recordContinuityEvent(beat.id, beat.title, event)
            })
            if (!gen.success && gen.requiresEscalation) {
              const blockers = gen.continuityBlockers ?? [gen.error || '连续性修复未通过']
              await escalateContinuityFailure(
                beat.id,
                blockers,
                gen.continuityRepairRounds ?? 0
              )
              continue
            }
            if (!gen.success) throw new Error(gen.error || '正文生成失败')
            if (continuityFailure?.chapterId === beat.id) {
              patchRuntimeState(workId, {
                continuityRepairFailure: undefined,
                continuityPendingRepair: undefined
              })
            }
            const mem = gen.memoryExtracted
            if (gen.memoryPending) {
              const runtime = readRuntimeState(workId)
              patchRuntimeState(workId, {
                pendingMemoryChapterIds: [...new Set([...(runtime.pendingMemoryChapterIds ?? []), beat.id])]
              })
            }
            const memMsg = gen.memoryPending
              ? ' · 记忆体：待旁路补偿（正文已安全提交）'
              : mem ? ` · 记忆体：+${mem.planted}伏笔/${mem.snapshots}快照/${mem.foreshadowingResolved}回收` : ''
            const antiAiMsg = gen.antiAiRepairs
              ? ` · 套话定点修复：${gen.antiAiRepairs}句/${gen.antiAiRepairRounds ?? 1}轮`
              : ''
            const continuityMsg = gen.continuityRepairRounds
              ? ` · 连续性定向修复 ${gen.continuityRepairRounds} 轮`
              : ''
            goalRoutineDAO.appendTurn({
              work_id: workId, turn_no: turn, phase, action: 'draft',
              target_chapter_id: beat.id,
              summary: `生成「${beat.title}」${gen.wordCount}字${antiAiMsg}${continuityMsg}${memMsg}`
            })
            emit(`生成「${beat.title}」${gen.wordCount}字${antiAiMsg}${continuityMsg}${memMsg}`, 'running')

            // 正文生成后可选：AI 诊断 + 修复循环，总分达标且承重项无硬伤即停
            if (fullConfig.diagnoseBodyAfterGeneration && fullConfig.qualityMin > 0) {
              const diagResult = await diagnoseAndFixUntilPass(
                workId, beat.id, fullConfig.qualityMin, controller.signal,
                msg => emit(msg, 'running')
              )
              const cleaned = cleanupEmDashesAfterPassedGate(workId, 'comma')
              const cleanMsg = cleaned.replaced > 0 ? `；破折号已替换 ${cleaned.replaced} 处` : ''
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'diagnose_fix',
                target_chapter_id: beat.id,
                score: diagResult.finalScore >= 0 ? diagResult.finalScore : null,
                summary: diagResult.passed
                  ? `「${beat.title}」诊断通过（正文质量 ${diagResult.finalScore}分，情绪 ${diagResult.emotionScore}分，第${diagResult.bestRound}轮）${cleanMsg}`
                  : `「${beat.title}」达到 ${diagResult.rounds} 轮修复上限，已保留第 ${diagResult.bestRound} 轮最佳候选` +
                    `（正文质量 ${diagResult.finalScore}分，情绪 ${diagResult.emotionScore}分；不达标：${diagResult.failedMetrics.join('、')}）${cleanMsg}`
              })
              if (!diagResult.passed) {
                emit(
                  `「${beat.title}」未完全通过联合门禁，已保留最佳候选并继续后续节拍` +
                  `（正文质量 ${diagResult.finalScore}/${fullConfig.qualityMin}，情绪 ${diagResult.emotionScore}/${EMOTION_GATE_MIN_SCORE}）`,
                  'running'
                )
              }
            } else {
              const latest = volumeChapterDAO.getChapter(beat.id)
              const emotion = await assessChapterEmotion(workId, beat.id, latest?.content ?? '', controller.signal, true)
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'emotion_check',
                target_chapter_id: beat.id,
                score: emotion.score,
                summary: emotion.passed
                  ? `「${beat.title}」情绪门禁通过（${emotion.score}分）`
                  : `「${beat.title}」情绪门禁未通过（${emotion.score}分），已保留当前正文并继续；${emotionRepairHint(emotion)}`
              })
              if (!emotion.passed) {
                emit(`「${beat.title}」情绪门禁未通过（${emotion.score}分），已保留当前正文并继续后续节拍`, 'running')
              }
            }

            phase = nextEmptyBeat(workId) ? 'draft_body' : 'goal_check'
          }
        } else if (phase === 'goal_check') {
          emit('正在进行目标验收（质量/字数/门禁/目标匹配）', 'running')
          lastCheck = await checkStoryGoal(workId, fullConfig, controller.signal)
          patchRuntimeState(workId, { lastCheck })
          goalRoutineDAO.update(workId, {
            last_quality_score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : null,
            goal_met: lastCheck.met
          })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'check',
            score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : lastCheck.goalMatchScore,
            summary: lastCheck.met ? '目标达成' : lastCheck.reasons.join('；')
          })

          const runtime = readRuntimeState(workId)
          const capability = resolveStoryModelCapability(getGoalLoopModelOpts(workId))
          const wholeAuditCount = (runtime.wholeAuditCount ?? 0) + 1
          const composite = goalCheckComposite(lastCheck)
          const signature = goalCheckSignature(lastCheck)
          const noMeaningfulGain = runtime.lastCheckComposite != null
            && composite <= runtime.lastCheckComposite + 1
            && signature === runtime.lastCheckSignature
          const stagnantChecks = noMeaningfulGain ? (runtime.stagnantChecks ?? 0) + 1 : 0
          const evaluationHistory = [
            ...(runtime.evaluationHistory ?? []),
            {
              checkedAt: new Date().toISOString(),
              qualityScore: lastCheck.qualityScore,
              goalMatchScore: lastCheck.goalMatchScore,
              overallStoryScore: lastCheck.overallStoryScore,
              previewHookScore: lastCheck.previewHookScore,
              proseReadScore: lastCheck.proseReadScore,
              composite,
              weakestLayer: lastCheck.weakestLayer,
              issues: lastCheck.storyIssues.slice(0, 10)
            }
          ].slice(-20)
          patchRuntimeState(workId, {
            lastCheckComposite: composite,
            lastCheckSignature: signature,
            stagnantChecks,
            wholeAuditCount,
            evaluationHistory
          })

          if (lastCheck.met) {
            const cleanup = cleanupEmDashesAfterPassedGate(workId, 'comma')
            if (cleanup.replaced > 0) {
              goalRoutineDAO.appendTurn({
                work_id: workId,
                turn_no: turn,
                phase,
                action: 'deai',
                summary: `门禁通过后自动替换破折号：${cleanup.chapters} 个节拍 ${cleanup.replaced} 处`
              })
              emit(`门禁通过后已自动替换破折号：${cleanup.chapters} 个节拍 ${cleanup.replaced} 处`, 'running')
              lastCheck = await checkStoryGoal(workId, fullConfig, controller.signal)
              patchRuntimeState(workId, { lastCheck })
              goalRoutineDAO.update(workId, {
                last_quality_score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : null,
                goal_met: lastCheck.met
              })
              if (!lastCheck.met) {
                emit(`清理后复验未通过：${lastCheck.reasons.join('；')}`, 'running')
                phase = 'repair_plan'
                continue
              }
            }

            const snapshotId = storyHarnessDAO.createReleaseSnapshot(workId)
            patchRuntimeState(workId, { terminalReason: undefined })
            goalRoutineDAO.setStatus(workId, 'goal_met')

            // 试读卡点报告
            const previewRatioPct = Math.round(fullConfig.previewRatio * 100)
            if (lastCheck.previewReport) {
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'preview_anchor',
                summary: `试读卡点报告（目标比例 ${previewRatioPct}%）已生成`
              })
            }
            emit(`目标达成并冻结发布快照 #${snapshotId}：质量${lastCheck.qualityScore} · 情绪盲读${lastCheck.emotionScore} · 整篇${lastCheck.overallStoryScore} · 原文盲读${lastCheck.proseReadScore} · 试读追读力${lastCheck.previewHookScore} · 目标匹配${lastCheck.goalMatchScore} · 节拍${lastCheck.contentBeats}/${lastCheck.totalBeats} · 字数${lastCheck.totalWords} · 试读${previewRatioPct}%`, 'goal_met')
            return
          }

          if (wholeAuditCount >= capability.maxWholeAudits) {
            patchRuntimeState(workId, { terminalReason: 'needs_manual_editor' })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'audit_budget_exhausted',
              summary: `整篇审计已达到 ${capability.maxWholeAudits} 次上限，停止自动改稿：${lastCheck.reasons.join('；')}`
            })
            goalRoutineDAO.setStatus(workId, 'paused')
            emit(`整篇审计已达到 ${capability.maxWholeAudits} 次上限，已保留正文和问题账本，等待人工编辑`, 'paused')
            return
          }

          if ((lastCheck.storyHardBlockers?.length ?? 0) > 0) {
            const feedback = lastCheck.storyHardBlockers.join('；')
            const chapters = volumeChapterDAO.listChaptersByWork(workId)
            const issues: StoryForensicIssue[] = lastCheck.forensicIssues?.length
              ? lastCheck.forensicIssues
              : [{
                  code: 'LEGACY_FORENSIC_BLOCKER', scope: 'beat_cluster',
                  chapterTitles: [], repairChapterTitles: [], evidence: [feedback], message: feedback,
                  repairable: true, recommendedAction: '定位最小节拍簇并动态修复'
                }]
            const firstRoute = routeStoryForensicRepair(chapters, issues, 1)
            const previousForensic = runtime.forensicRepairStall
            const forensicCount = previousForensic?.fingerprint === firstRoute.fingerprint
              ? previousForensic.count + 1 : 1
            const route = routeStoryForensicRepair(chapters, issues, forensicCount)
            patchRuntimeState(workId, {
              forensicRepairStall: { fingerprint: route.fingerprint, count: forensicCount },
              stagnantChecks: 0,
              lastCheckComposite: undefined,
              lastCheckSignature: undefined
            })

            if (route.mode === 'retry_audit') {
              if (forensicCount >= 3 && issues.some(issue => issue.code === 'FORENSIC_EVALUATOR_ERROR')) {
                goalRoutineDAO.appendTurn({
                  work_id: workId, turn_no: turn, phase, action: 'forensic_retry',
                  summary: '法医评估器连续返回无效，保留全部原文并自动继续独立复核'
                })
                emit('法医评估器暂时不可用，已保留全部原文并继续自动复核', 'running')
                phase = 'goal_check'
                continue
              }
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'check',
                summary: `法医全局硬伤首次告警，保留原文并进行第 ${forensicCount + 1} 次独立复核：${feedback}`
              })
              emit('法医审计需要独立复核，已保留全部原文', 'running')
              phase = 'goal_check'
              continue
            }

            if (route.mode === 'reset_beats' || route.mode === 'reset_engine') {
              const returnToEngine = route.mode === 'reset_engine'
              const deleted = resetFailedStoryStructure(workId)
              if (returnToEngine) {
                coreSettingDAO.deleteByWorkAndTypes(workId, ['story_engine', 'story_contract', 'emotion_engine'])
              }
              patchRuntimeState(workId, { structuralFeedback: route.hint })
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase,
                action: returnToEngine ? 'storyline' : 'beat',
                summary: `同一法医证据连续 ${forensicCount} 轮未消除，才升级删除 ${deleted} 个节拍并回退到${returnToEngine ? '故事发动机' : '整组节拍'}`
              })
              emit(`法医动态修复未收敛，已逐级升级到${returnToEngine ? '故事发动机' : '整组节拍'}重建`, 'running')
              phase = returnToEngine ? 'story_engine_gate' : 'generate_beats'
              continue
            }

            const plan: RepairPlan = {
              action: route.action,
              targetChapterIds: route.targetChapterIds,
              hint: route.hint,
              issues: issues.map(issue => `${issue.code}：${issue.message}`),
              forensicIssues: issues,
              forensicFingerprint: route.fingerprint
            }
            patchRuntimeState(workId, { repairPlan: plan })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: route.action,
              target_chapter_id: route.targetChapterIds[0] ?? null,
              summary: `整篇法医审计阻止交付，保留原文并执行第 ${forensicCount} 轮动态修复：${route.hint}`
            })
            emit(`法医审计发现硬伤，正在动态修复 ${route.targetChapterIds.length} 个节拍，其他原文保留`, 'running')
            phase = 'repair_execute'
            continue
          }

          if (runtime.forensicRepairStall) patchRuntimeState(workId, { forensicRepairStall: undefined })

          if (stagnantChecks >= MAX_STAGNANT_CHECKS) {
            const resetCount = runtime.structuralResetCount ?? 0
            const feedback = [lastCheck.reasons.join('；'), ...lastCheck.storyIssues].filter(Boolean).join('；')
            const deleted = resetFailedStoryStructure(workId)
            const returnToEngine = lastCheck.weakestLayer === 'storyline'
            if (returnToEngine) coreSettingDAO.deleteByWorkAndTypes(workId, ['story_engine', 'story_contract', 'emotion_engine'])
            patchRuntimeState(workId, {
              structuralResetCount: resetCount + 1,
              structuralFeedback: feedback,
              stagnantChecks: 0,
              lastCheckComposite: undefined,
              lastCheckSignature: undefined
            })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: returnToEngine ? 'storyline' : 'beat',
              summary: `连续 ${stagnantChecks} 次无提升，第 ${resetCount + 1} 次删除 ${deleted} 个失败节拍并回退到${returnToEngine ? '故事发动机' : '整组节拍'}重生`
            })
            emit(`连续 ${stagnantChecks} 次无提升，已回退到${returnToEngine ? '故事发动机' : '整组节拍'}继续重生`, 'running')
            phase = returnToEngine ? 'story_engine_gate' : 'generate_beats'
            continue
          }

          emit(`未达标：${lastCheck.reasons.join('；')}`, 'running')
          phase = 'repair_plan'
        } else if (phase === 'repair_plan') {
          const plan = buildRepairPlan(workId, lastCheck)
          patchRuntimeState(workId, { repairPlan: plan })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: plan.action,
            target_chapter_id: plan.targetChapterIds[0] ?? null,
            summary: `修复计划：${plan.action} · ${plan.hint}`
          })
          emit(`修复计划：${plan.action}`, 'running')
          phase = 'repair_execute'
        } else if (phase === 'repair_execute') {
          const row = goalRoutineDAO.getByWork(workId)
          const parsed = row?.state_json ? JSON.parse(row.state_json) as { repairPlan?: RepairPlan } : {}
          const plan = parsed.repairPlan ?? buildRepairPlan(workId, lastCheck)
          const capability = resolveStoryModelCapability(getGoalLoopModelOpts(workId))
          const plannedCodes = new Set(plan.forensicIssues?.map(issue => issue.code) ?? [])
          const plannedChapterIds = new Set(plan.targetChapterIds)
          const relevantLedgerIssues = storyHarnessDAO.listIssues(workId).filter(issue => {
            const chapterIds = (() => {
              try {
                const value = JSON.parse(issue.chapter_ids_json ?? '[]')
                return Array.isArray(value) ? value.filter(Number.isInteger) as number[] : []
              } catch {
                return []
              }
            })()
            return plannedCodes.has(issue.code)
              || (plan.issues ?? []).some(text => text.includes(issue.code))
              || chapterIds.some(chapterId => plannedChapterIds.has(chapterId))
          })
          const stalledIssue = relevantLedgerIssues.find(issue => issue.status === 'stalled')
          if (stalledIssue) {
            patchRuntimeState(workId, { terminalReason: 'needs_manual_editor' })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'issue_stalled',
              target_chapter_id: plan.targetChapterIds[0] ?? null,
              summary: `${stalledIssue.code} 已达到 ${stalledIssue.attempts} 次定向修复上限，停止自动改稿`
            })
            goalRoutineDAO.setStatus(workId, 'paused')
            emit(`问题 ${stalledIssue.code} 已达到自动修复上限；已保留全部正文，等待人工编辑`, 'paused')
            return
          }
          for (const issue of relevantLedgerIssues.filter(issue => issue.status === 'open')) {
            storyHarnessDAO.incrementIssueAttempt(
              workId,
              issue.issue_key,
              capability.maxIssueRepairs
            )
          }
          emit(`正在执行修复：${plan.action}`, 'running')
          const execution = await executeRepairPlan(
            workId,
            plan,
            fullConfig.goalDescription,
            controller.signal,
            (chapterId, event) => {
              const chapter = volumeChapterDAO.getChapter(chapterId)
              recordContinuityEvent(chapterId, chapter?.title ?? String(chapterId), event)
            }
          )
          if (execution.continuityFailure) {
            await escalateContinuityFailure(
              execution.continuityFailure.chapterId,
              execution.continuityFailure.blockers,
              execution.continuityFailure.attempts
            )
            continue
          }
          const summary = execution.summary
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: plan.action,
            target_chapter_id: plan.targetChapterIds[0] ?? null,
            summary
          })
          emit(`执行修复：${summary}`, 'running')
          if (plan.continuityEscalation) {
            patchRuntimeState(workId, {
              continuityRepairFailure: undefined,
              continuityPendingRepair: undefined
            })
          }
          phase = 'goal_check'
        }
        if (readRuntimeState(workId).executionFailure) {
          patchRuntimeState(workId, { executionFailure: undefined })
        }
      } catch (e) {
        if (controller.signal.aborted) {
          goalRoutineDAO.setStatus(workId, 'cancelled')
          emit('已取消', 'cancelled')
          return
        }
        const msg = e instanceof Error ? e.message : String(e)
        appLogger.error('goal_routine', '轮次异常', { workId, turn, error: msg })
        goalRoutineDAO.appendTurn({
          work_id: workId, turn_no: turn, phase, action: 'error', summary: msg
        })
        const previousFailure = readRuntimeState(workId).executionFailure
        const signature = routineFailureSignature(attemptedPhase, e)
        const failureCount = previousFailure?.phase === attemptedPhase && previousFailure.signature === signature
          ? previousFailure.count + 1
          : 1
        patchRuntimeState(workId, {
          executionFailure: {
            phase: attemptedPhase,
            signature,
            count: failureCount,
            message: msg,
            updatedAt: new Date().toISOString()
          }
        })
        const phaseBudgetExhausted = e instanceof GoalPhaseExhaustedError
        if (phaseBudgetExhausted || failureCount >= STORY_ROUTINE_FAILURE_LIMIT) {
          goalRoutineDAO.setStatus(workId, 'paused')
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'failure_pause',
            summary: phaseBudgetExhausted
              ? `「${attemptedPhase}」阶段内部修复预算已耗尽，目标循环安全暂停：${msg}`
              : `「${attemptedPhase}」连续 ${failureCount} 次发生同类异常，目标循环已自动暂停：${msg}`
          })
          emit(
            phaseBudgetExhausted
              ? `「${attemptedPhase}」阶段内部修复预算已耗尽，已安全暂停：${msg}`
              : `「${attemptedPhase}」连续 ${failureCount} 次发生同类异常，已自动暂停：${msg}`,
            'paused'
          )
          return
        }
        emit(`轮次异常：${msg}`, 'running')
        emit(`「${attemptedPhase}」第 ${failureCount} 次发生同类异常，将有限重试；连续 ${STORY_ROUTINE_FAILURE_LIMIT} 次后自动暂停`, 'running')
      }
    }

  } finally {
    clearGoalLoopModelOpts(workId)
    activeLoops.delete(workId)
  }
}
