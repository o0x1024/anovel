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
  saveCharacterCards
} from '../character-cards'
import { buildSettingsQualityInput, recordQualityCheck } from '../settings-quality'
import { STORY_OVERALL_CHECK_SYSTEM_PROMPT } from '../story-settings-quality'
import { runIncubatorGate } from '../incubator/gate-check'
import { runGateFix } from '../incubator/gate-fix'
import { freezeIncubatorStorylineVersion } from '../incubator/freeze-version'
import {
  parseChapterSuggestions,
  type ContinuityContract,
  type ParsedChapter
} from '../parse-chapters'
import { outlineConstraintsForWordTarget } from '../../../shared/outline-constraints'
import { DEFAULT_WORDS_PER_CHAPTER } from '../../../shared/writing-plan-presets'
import { loadWritingPlan } from '../writing-plan'
import { STORY_INCUBATOR_ANALYSIS_PROMPTS } from '../../../shared/story-incubator-prompts'
import { STORY_SLOT_KEYS, getIncubatorSlotLabel, type IncubatorSlotKey } from '../../../shared/incubator-slots'
import { parseExpansionVersions, type ExpansionVersion } from '../parse-expansion'
import { parseIncubatorVariants, type IncubatorVariant } from '../parse-variants'
import { updateDraftSlotContent } from '../incubator/update-slot'
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
import { bodyWordCountBounds, countWords } from '../../../shared/body-word-target'
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
import {
  filterStoryRepairLedgerIssues,
  routeStoryForensicRepair,
  stalledStoryForensicEscalationCount
} from './story-forensic-repair'
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
import {
  validateStoryBoundaryContracts,
  validateStoryContinuityContracts
} from '../../../shared/story-hard-guards'
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
  detectStoryTextIntegrityIssues,
  repairDeterministicStorySentences,
  resolveStoryModelCapability,
  stableStoryHash,
  storyHarnessIssueKey
} from '../../../shared/story-harness'
import { requireGoalTurnLimit } from '../../../shared/goal-turn-limit'
import {
  patchStoryGoalRuntimeState as patchRuntimeState,
  readStoryGoalRuntimeState as readRuntimeState,
  type RepairPlan,
  type TitleHookCandidate
} from './story-goal-runtime'
import {
  parseStructuredModelContent,
  requestStructuredModelOutput
} from './structured-model-output'
import {
  requestQualityEvaluatorEvidence,
  requireQualityEvaluatorEvidence
} from './quality-evaluator-policy'
import {
  CHARACTER_CARDS_RESPONSE_SCHEMA,
  parseStrictCharacterCards
} from './strict-character-card-output'

export type { TitleHookCandidate } from './story-goal-runtime'


interface SlotCandidate {
  title: string
  content: string
  score?: number
  reason?: string
}

interface SelectedSlotCandidate extends SlotCandidate {
  total: number
}

export const STORY_SETTING_TYPES = ['protagonist', 'golden_finger', 'pleasure_engine', 'supporting_cast'] as const
const MAX_INCUBATOR_GATE_REPAIR_ROUNDS = 4

const SLOT_CANDIDATES_RESPONSE_SCHEMAS = {
  variants: {
    type: 'object', required: ['variants'],
    properties: {
      variants: {
        type: 'array', minItems: 3, maxItems: 3,
        items: {
          type: 'object', required: ['title', 'dimension', 'summary'],
          properties: { title: { type: 'string' }, dimension: { type: 'string' }, summary: { type: 'string' } }
        }
      }
    }
  },
  versions: {
    type: 'object', required: ['versions'],
    properties: {
      versions: {
        type: 'array', minItems: 3, maxItems: 3,
        items: {
          type: 'object', required: ['title', 'summary'],
          properties: {
            title: { type: 'string' }, summary: { type: 'string' },
            highlights: {}, audience: {}
          }
        }
      }
    }
  }
} as const

const SLOT_SELECTION_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['bestIndex', 'scores'],
  properties: {
    bestIndex: { type: 'integer' },
    scores: {
      type: 'array',
      items: {
        type: 'object', required: ['index', 'score', 'reason'],
        properties: { index: { type: 'integer' }, score: { type: 'integer' }, reason: { type: 'string' } }
      }
    }
  }
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

export const STORY_SETTING_PROMPTS: Record<(typeof STORY_SETTING_TYPES)[number], string> = {
  protagonist: ['你是顶级短故事人设设计师。基于主线大纲输出 Markdown：## 身份与反差标签 / ## 核心痛点与执念 / ## 反差行为矩阵 / ## 爽点爆发时机 / ## 主角金句与对抗姿态。', HOT_WORD_SECTION].join('\n\n'),
  golden_finger: ['你是顶级短故事核心钩子设计师。判断故事是否需要特殊机制；没有机制则设计身份反差与信息差。输出 Markdown：## 设定名称与形态 / ## 信息差构建 / ## 限制与紧迫感 / ## 对核心冲突的推动作用。', HOT_WORD_SECTION].join('\n\n'),
  pleasure_engine: ['你是顶级短故事节奏与爽点设计师。输出 Markdown：## 开篇憋屈/危机点 / ## 黄金开局爽感/反击 / ## 中点反转 / ## 终局极致爽感清算。必须明确每个爽点对应的节拍位置。', HOT_WORD_SECTION].join('\n\n'),
  supporting_cast: ['你是顶级短故事配角设计师。输出 Markdown：## 核心极品/反派角色 / ## 关键支持者/对照组 / ## 喜剧或信息工具人 / ## 关系演变与情绪宣泄点。配角只写功能、冲突价值和记忆点。', HOT_WORD_SECTION].join('\n\n')
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

export function slotContext(workId: number): string {
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

function parseSlotCandidates(slotKey: IncubatorSlotKey, value: Record<string, unknown>): SlotCandidate[] {
  const raw = JSON.stringify(value)
  if (slotKey === 'core_conflict') {
    const variants = parseIncubatorVariants(raw)
    if (variants.length !== 3) throw new Error(`微创新候选必须为 3 项，实际 ${variants.length} 项`)
    return variants.map(v => ({ title: v.title, content: formatVariantSlot(v) }))
  }
  const versions = parseExpansionVersions(raw)
  if (versions.length !== 3) throw new Error(`槽位候选必须为 3 项，实际 ${versions.length} 项`)
  return versions.map(v => ({ title: v.title, content: formatExpansionSlot(v) }))
}

async function selectBestSlotCandidate(
  workId: number,
  slotKey: IncubatorSlotKey,
  goal: string,
  candidates: SlotCandidate[],
  signal?: AbortSignal
): Promise<SelectedSlotCandidate> {
  if (candidates.length <= 1) throw new Error('槽位评审至少需要 2 个候选')
  const label = getIncubatorSlotLabel(slotKey, 'story')
  const evidence = await requestQualityEvaluatorEvidence<{
    bestIndex: number
    scores: Array<{ index: number; score: number; reason: string }>
  }>({
    workId,
    label: `短故事槽位评审-${label}`,
    signal,
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_slot_candidate_score',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        forceThinkingDisabled: true,
        responseSchema: { name: 'story_slot_candidate_score', schema: SLOT_SELECTION_RESPONSE_SCHEMA, strict: false },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是短故事爆款主线评审。请从候选方案中选择最符合用户创作目标、最能支撑完读率的一项。',
          '只输出 JSON：{"bestIndex":0,"scores":[{"index":0,"score":90,"reason":"..."}]}'
        ].join('\n'),
        prompt: [
          `【槽位】${label}`,
          `【用户创作目标】\n${goal.trim() || '高完读率爆款短故事'}`,
          '【候选方案】',
          JSON.stringify(candidates.map((c, index) => ({ index, title: c.title, content: c.content.slice(0, 1600) })), null, 2),
          attempt > 1 ? `【协议重试】${error}。只返回完整 JSON。` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    ),
    parse: content => parseStructuredModelContent({
      content,
      schema: SLOT_SELECTION_RESPONSE_SCHEMA,
      validate: value => {
        const bestIndex = Number(value.bestIndex)
        if (!Number.isInteger(bestIndex) || bestIndex < 0 || bestIndex >= candidates.length) {
          throw new Error('bestIndex 超出候选范围')
        }
        if (!Array.isArray(value.scores)) throw new Error('scores 必须是数组')
        const scores = value.scores.map((item, index) => {
          if (!item || typeof item !== 'object') throw new Error(`scores[${index}] 必须是对象`)
          const row = item as Record<string, unknown>
          const scoreIndex = Number(row.index)
          const score = Number(row.score)
          const reason = typeof row.reason === 'string' ? row.reason.trim() : ''
          if (!Number.isInteger(scoreIndex) || scoreIndex < 0 || scoreIndex >= candidates.length) {
            throw new Error(`scores[${index}].index 超出候选范围`)
          }
          if (!Number.isFinite(score) || score < 0 || score > 100 || !reason) {
            throw new Error(`scores[${index}] 缺少有效分数或理由`)
          }
          return { index: scoreIndex, score: Math.round(score), reason }
        })
        if (!scores.some(score => score.index === bestIndex)) throw new Error('scores 缺少 bestIndex 对应证据')
        return { bestIndex, scores }
      }
    }).value
  })
  const parsed = requireQualityEvaluatorEvidence(evidence, `短故事槽位评审-${label}`)
  const scoreRow = parsed.scores.find(score => score.index === parsed.bestIndex)!
  return {
    ...candidates[parsed.bestIndex],
    score: scoreRow.score,
    reason: scoreRow.reason,
    total: candidates.length
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
  const schema = slotKey === 'core_conflict'
    ? SLOT_CANDIDATES_RESPONSE_SCHEMAS.variants
    : SLOT_CANDIDATES_RESPONSE_SCHEMAS.versions
  const candidates = await requestStructuredModelOutput<SlotCandidate[]>({
    workId,
    label: `短故事槽位候选-${label}`,
    signal,
    schema,
    validate: value => parseSlotCandidates(slotKey, value),
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt: [
          `【用户创作目标】\n${goal.trim() || '请自动策划一篇高完读率爆款短故事。'}`,
          existing ? `【已确定槽位】\n${existing}` : '',
          `请生成「${label}」的 3 套候选方案，后续会由独立评审择优回填。`,
          attempt > 1 ? `【协议重试】${error}。只返回更短的完整 JSON。` : ''
        ].filter(Boolean).join('\n\n'),
        systemPrompt: promptDef.system,
        step: promptDef.step,
        workId,
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        responseSchema: { name: `story_slot_${slotKey}`, schema, strict: false },
        structuredOutputMode: 'prompt_json'
      }),
      { stream: false, signal }
    )
  })
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

export async function materializeStorySettings(
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

export async function generateCharacterCards(
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
  const cards = await requestStructuredModelOutput({
    workId,
    label: '短故事主角人设卡',
    signal,
    schema: CHARACTER_CARDS_RESPONSE_SCHEMA,
    validate: parseStrictCharacterCards,
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt: [
          basePrompt,
          attempt > 1 ? `【协议重试】${error}。重新输出完整且更短的人设卡 JSON，不要解释。` : ''
        ].filter(Boolean).join('\n\n'),
        systemPrompt: CHARACTER_CARDS_AI_PROMPT,
        workId,
        step: 'character_cards_generate',
        enrichWorkContext: false,
        responseSchema: { name: 'story_character_cards', schema: CHARACTER_CARDS_RESPONSE_SCHEMA, strict: false },
        structuredOutputMode: 'prompt_json'
      }),
      { stream: false, signal }
    )
  })
  saveCharacterCards(workId, cards)
  return cards.length
}
