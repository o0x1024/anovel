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
import { volumeChapterDAO, goalRoutineDAO, coreSettingDAO, workDAO } from '../../db'
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
import { generateBeatBody, extractNarrativeMemoryAfterGeneration } from './story-goal-doer'
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
import { EMOTION_CONTRACT_JSON_SHAPE, ensureEmotionEngine } from './emotion-engine'
import { validateEmotionContract, type EmotionBlindAssessment } from '../../../shared/emotion-contract'
import { assessChapterEmotion, emotionRepairHint } from './emotion-gate'
import { formatGenrePolicy, resolveStoryGenrePolicy, tensionCurveForBeat, validateTensionPlans } from './story-genre-policy'
import { resetFailedStoryStructure } from './story-structure-reset'

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
}

interface RoutineRuntimeState {
  lastCheck?: GoalCheckResult
  repairPlan?: RepairPlan
  overallRepairRounds?: number
  lastCheckComposite?: number
  lastCheckSignature?: string
  stagnantChecks?: number
  structuralResetCount?: number
  structuralFeedback?: string
  titleHookCandidates?: TitleHookCandidate[]
  titleHookPreferredIndex?: number
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

    onProgress?.(`AI 门禁未通过，正在自动修复主线槽位（第 ${repairRounds + 1} 轮，达标前持续修复）`)
    const fix = await runGateFix(workId, gate, { sessionTitle: '目标循环门禁自动修复' }, getGoalLoopModelOpts(workId))
    assertNotAborted(signal)
    if (fix.error || fix.applied <= 0) {
      throw new Error(`孵化门禁自动修复失败：${fix.error || '未应用任何槽位修复'}；门禁问题：${lastReason}`)
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
  const prompt = [
    ctx.text || '（请先填写故事方向）',
    goal.trim() ? `## 用户创作目标\n${goal.trim()}` : ''
  ].filter(Boolean).join('\n\n')
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      prompt,
      systemPrompt: CHARACTER_CARDS_AI_PROMPT,
      workId,
      step: 'character_cards_generate',
      enrichWorkContext: false
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) throw new Error(res.error || '主角人设卡片生成失败')
  const parsed = parseCharacterCardsFromAi(res.content)
  if (parsed.length === 0) throw new Error('AI 返回成功，但未能解析人设卡片')
  const sanitized = sanitizeCharacterCards(parsed)
  const validation = validateCharacterCards(sanitized.cards)
  if (!validation.valid) throw new Error(`人设卡片未通过结构校验：${validation.errors[0] ?? '未知错误'}`)
  const cards = sanitized.cards.filter(c => c.role === 'protagonist')
  saveCharacterCards(workId, cards.length > 0 ? cards : sanitized.cards)
  return cards.length > 0 ? cards.length : sanitized.cards.length
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

async function generateTitleHook(
  workId: number,
  goal: string,
  signal?: AbortSignal
): Promise<{ preferred: TitleHookCandidate; preferredIndex: number; candidates: TitleHookCandidate[] }> {
  assertNotAborted(signal)
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      prompt: buildTitleHookPrompt(workId, goal),
      systemPrompt: [
        '你是番茄短故事的顶流爆款编辑，深谙爆款流量密码。',
        '基于大纲孵化设定、节拍大纲和创作目标，生成 5 个能瞬间抓住读者眼球、让其产生极强追读冲动的短故事书名与导语组合。',
        '书名必须强网感、直击人性弱点、带爽感/反差/悬念/场景刺激。',
        '导语是放在全篇正文最开头、独立于编号节拍之外的"钩子段落"，交待核心故事、留住用户。',
        '导语 150-300 字，前三句建立明确冲突或异常；叙事视角服从用户目标与正文设定，未指定时优先第一人称；结尾留下具体追问。',
        '导语是独立于正文节拍之外的开篇钩子，发布时置于第一节拍之前。须用最具冲击力的场景直切核心冲突，让读者3秒内被抓住，产生强烈的追读冲动。',
        '导语必须是一个完整的场景片段（包含对话、动作/心声等形式），而非概括性介绍；读者读完导语就要产生"然后呢"的强烈冲动。',
        storyHotWordPromptSection(),
        storyCategoryPromptSection(),
        '必须且只能输出合法 JSON：{"candidates":[{"title":"书名","hook":"导语正文","type":"类型","summary":"一句点评","tags":{"main_category":"主分类","plot":["情节分类"],"character":["角色分类"],"emotion":["情绪分类"],"setting":["背景分类"]}}]}'
      ].join('\n'),
      workId,
      step: 'story_title_hook_gen',
      enrichWorkContext: false
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) throw new Error(res.error || '爆款书名导语生成失败')
  const candidates = parseTitleHookCandidates(res.content)
  if (candidates.length === 0) throw new Error('AI 返回成功，但未能解析书名导语候选')
  const picked = await selectPreferredTitleHook(workId, goal, candidates, signal)
  return { preferred: picked, preferredIndex: Math.max(0, candidates.indexOf(picked)), candidates }
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
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      prompt,
      systemPrompt: STORY_OVERALL_CHECK_SYSTEM_PROMPT,
      workId,
      step: 'settings_overall_check',
      enrichWorkContext: false
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) throw new Error(res.error || '整体自检失败')
  recordQualityCheck(workId, {
    overall: { report: res.content, checkedAt: new Date().toISOString() }
  })
  return { report: res.content, conclusion: parseQualityConclusion(res.content) }
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
    '【每拍情绪契约 - 读者状态变化硬约束】',
    '- emotion_contract 不是情绪标签，必须形成“依恋依据→触发→人物评价→表里冲突→选择与代价→读者推断→余波”。',
    '- 每拍必须区分人物真实感受、愿意承认、对外表现和压抑内容；四项不得写成同义句。',
    '- private_detail_anchor 必须是该人物/关系独有的物件、习惯或共同记忆，禁止心跳、瞳孔、攥拳等通用反应。',
    '- reader_state_before/after 必须有可解释变化；低唤醒拍必须承担依恋、预感、亲密、羞耻或余味功能。',
    '【输出格式 - 必须严格遵守】',
    '只输出一个 JSON 对象；禁止 Markdown 标题、前置说明、思考过程，以及 ``` 代码块围栏。',
    'chapters 数组每一项为一个节拍（请勿输出"第X章"或"节拍X"字样，直接写节拍剧情标题即可）。',
    `每章字段：title、plot_points（${oc.pointsMin}-${oc.pointsMax} 条情节节点数组）、dramatic_contract、tension_plan、emotion_contract、beat_role、foreshadow_target、next_hook、characters（本章出场角色名数组）。`,
    'beat_role: A(爽点释放)/B(推进冲突)/C(反转铺垫)，禁止使用 transition',
    `【长度】每项 plot_points 合计 ${oc.charsMin}-${oc.charsMax} 字梗概（每节拍目标 ${wordsPerChapter} 字正文），禁止正文级长文。`,
    `emotion_contract 格式：${JSON.stringify(EMOTION_CONTRACT_JSON_SHAPE)}`,
    `格式：{"chapters":[{"title":"节拍剧情标题","plot_points":["节点1","节点2","节点3"],"dramatic_contract":{"scene_promise":"...","protagonist_want":"...","obstacle":"...","stakes":"...","info_gap":"...","pressure_escalation":"...","turn":"...","irreversible_change":"...","payoff_or_debt":"...","next_question":"..."},"tension_plan":{"phase":"蓄力与受阻","level":6,"payoff_type":"debt"},"emotion_contract":${JSON.stringify(EMOTION_CONTRACT_JSON_SHAPE)},"beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"]}]}`
  ].join('\n')
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
  return [
    goalDescription.trim() ? `【用户创作目标】\n${goalDescription.trim()}` : '',
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
      emotion_contract: chapter.emotion_contract
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
  const emotionIssues = chapters.flatMap((chapter, index) => chapter.emotion_contract
    ? validateEmotionContract(chapter.emotion_contract).map(issue => `第${index + 1}拍${issue}`)
    : [`第${index + 1}拍缺少 emotion_contract`])
  if (tensionIssues.length > 0 || emotionIssues.length > 0) {
    return {
      passed: false,
      score: 60,
      blockingIssues: [...tensionIssues, ...emotionIssues],
      suggestions: ['按全篇张力曲线重分 tension_plan，并为每拍重建完整情绪因果契约']
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
        '1. 每拍都必须有完整 dramatic_contract，尤其是 protagonist_want、obstacle、stakes、pressure_escalation、turn、irreversible_change、next_question。',
        '2. 每拍必须是一场有目标、阻力、选择和后果的戏，不能只是事件顺序、设定解释、地点移动或背景补充。',
        '3. 每拍结尾必须让局面发生不可逆变化，且 next_question/next_hook 能驱动读者继续看。',
        '4. 全篇节拍之间必须形成压力递增和因果推进，不能每拍相互独立。',
        '5. 第一拍必须直接切入极端冲突，不能慢热铺垫。',
        '6. 每拍必须有 tension_plan；全篇必须存在蓄力、部分兑现、高潮兑现和余味，禁止所有拍都标成高潮。',
        '7. 每拍必须有完整 emotion_contract；读者依恋、事件意义、人物表里冲突、有代价选择和下一拍余波缺一不可。',
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
    '请整组重生 chapters，不要只小修文字；必须让每拍具备目标、阻力、代价、转折和不可逆变化。'
  ].filter(Boolean).join('\n')
}

async function generateBeatCandidatesWithGate(
  workId: number,
  volumeId: number,
  systemPrompt: string,
  basePrompt: string,
  goalDescription: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ chapters: ParsedChapter[]; gate: BeatGateResult; rounds: number }> {
  let gateFeedback = ''

  let round = 0
  while (true) {
    round++
    assertNotAborted(signal)
    const prompt = [
      basePrompt,
      gateFeedback ? `【上一轮门禁反馈 - 必须全部修复】\n${gateFeedback}` : ''
    ].filter(Boolean).join('\n\n')

    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt,
        systemPrompt,
        step: 'volume_chapters_batch',
        workId,
        volumeId,
        workContextOptions: { includeVolumes: true }
      }),
      { stream: false, signal }
    )

    if (!response.success || !response.content?.trim()) {
      throw new Error(response.error || '节拍生成失败')
    }

    const parsed = parseChapterSuggestions(response.content.trim())
    if (parsed.length === 0) throw new Error('节拍解析为空')

    onProgress?.(`正在运行节拍 AI 门禁（第 ${round} 轮，达标前持续重生）`)
    const gate = await runBeatGate(workId, goalDescription, parsed, signal)
    if (gate.passed) {
      onProgress?.(`节拍 AI 门禁通过（${gate.score}分，第 ${round} 轮）`)
      return { chapters: parsed, gate, rounds: round }
    }

    onProgress?.(`节拍 AI 门禁未通过（${gate.score}分），正在重生节拍`)
    gateFeedback = formatBeatGateFeedback(gate)
  }
}

/** outline 阶段：若无节拍，生成节拍大纲并入库（注入创作目标） */
async function ensureBeats(
  workId: number,
  goalDescription: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ created: number; error?: string }> {
  const existing = volumeChapterDAO.listChaptersByWork(workId)
  if (existing.some(c => c.content?.trim())) return { created: 0 }

  let volumes = volumeChapterDAO.listVolumes(workId)
  let volumeId = volumes[0]?.id
  if (!volumeId) {
    volumeId = volumeChapterDAO.createVolume(workId, '正文', '短故事主线剧情')
    volumes = volumeChapterDAO.listVolumes(workId)
  }

  const plan = loadWritingPlan(workId)
  const wpc = plan.wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER
  const suggestedCount = plan.targetChapters > 0
    ? Math.max(1, Math.round(plan.targetChapters))
    : 5

  const vol = volumes[0]
  const work = workDAO.getById(workId)
  const genreText = [work?.genre, work?.tags, goalDescription].filter(Boolean).join('\n')
  const structuralFeedback = readRuntimeState(workId).structuralFeedback?.trim() ?? ''
  onProgress?.(`正在生成节拍大纲（约 ${suggestedCount} 个节拍）`)
  const prompt = [
    `【短故事一镜到底】当前需要将其拆解为连续的情节节拍，共约 ${suggestedCount} 个节拍。`,
    goalDescription.trim() ? `【短故事创作目标】${goalDescription.trim()}，请据此拆解节拍（题材/风格/情节走向须贴合目标）` : '',
    structuralFeedback ? `【上一版整篇失败反馈 - 本轮必须从结构上解决】\n${structuralFeedback}` : '',
    vol.description ? `主线说明：${vol.description}` : '',
    '请输出完整 chapters 数组。'
  ].filter(Boolean).join('\n')

  let parsed: ParsedChapter[]
  let gateRounds = 0
  try {
    const gated = await generateBeatCandidatesWithGate(
      workId,
      volumeId,
      buildBeatBatchSystemPrompt(wpc, genreText, suggestedCount),
      prompt,
      goalDescription,
      signal,
      onProgress
    )
    parsed = gated.chapters
    gateRounds = gated.rounds
  } catch (e) {
    return { created: 0, error: e instanceof Error ? e.message : String(e) }
  }

  const items = parsed.map(p => ({
    title: p.title,
    outline: p.outline ?? '',
    beat_role: p.beat_role ?? null,
    foreshadow_target: p.foreshadow_target ?? null,
    next_hook: p.next_hook ?? null,
    characters: p.characters ?? null,
    emotion_contract_json: p.emotion_contract ? JSON.stringify(p.emotion_contract) : null,
      outline_diagnosis: p.dramatic_contract || p.tension_plan
        ? JSON.stringify({ dramatic_contract: p.dramatic_contract, tension_plan: p.tension_plan, emotion_contract: p.emotion_contract })
        : null
  }))
  volumeChapterDAO.batchCreateChapters(volumeId, items, existing.length > 0 ? 'replace' : 'append')
  if (structuralFeedback) patchRuntimeState(workId, { structuralFeedback: undefined })
  onProgress?.(`已回填 ${items.length} 个节拍到节拍大纲（门禁 ${gateRounds} 轮）`)
  return { created: items.length }
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
    volumeChapterDAO.updateChapterWithVersion(ch.id, {
      content: cleaned,
      word_count: cleaned.replace(/\s/g, '').length,
      status: ch.status ?? 'completed'
    })
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
  failedMetrics: string[]
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
  const chTitle = volumeChapterDAO.getChapter(chapterId)?.title ?? `#${chapterId}`

  const maxRounds = 4
  while (round < maxRounds) {
    assertNotAborted(signal)
    round++

    const ch = volumeChapterDAO.getChapter(chapterId)
    let content = ch?.content?.trim() ?? ''
    if (!content) return { passed: false, rounds: round, finalScore: 0, failedMetrics: ['无正文'] }

    const deterministicClean = stripDeterministicAiPatterns(content)
    if (deterministicClean !== content) {
      content = deterministicClean
      volumeChapterDAO.updateChapterWithVersion(chapterId, {
        content,
        word_count: content.replace(/\s/g, '').length,
        status: 'completed'
      })
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

    const failedMetrics = failedCriticalStoryMetrics(items, qualityMin)
    if (diagRes.scoreTotal < qualityMin) failedMetrics.unshift(`总分:${diagRes.scoreTotal}`)
    const emotionAssessment = await assessChapterEmotion(workId, chapterId, content, signal, true)
    if (!emotionAssessment.passed) failedMetrics.push(`情绪门禁:${emotionAssessment.score}`)
    const allPassed = diagRes.scoreTotal >= qualityMin && failedMetrics.length === 0 && !diagRes.hardFail

    appLogger.info('goal_routine', `AI诊断 第${round}轮`, {
      workId, chapterId, scoreTotal: diagRes.scoreTotal, allPassed,
      failedMetrics, hardFail: diagRes.hardFail
    })

    if (allPassed) {
      onProgress?.(`「${chTitle}」AI诊断通过（${diagRes.scoreTotal}分，第${round}轮）`)
      return { passed: true, rounds: round, finalScore: diagRes.scoreTotal, failedMetrics: [] }
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
      const wordCount = patched.replace(/\s/g, '').length
      volumeChapterDAO.updateChapterWithVersion(chapterId, {
        content: patched,
        word_count: wordCount,
        status: 'completed'
      })
      onProgress?.(`「${chTitle}」修复完成（第${round}轮，${patchApplied}条patches + LLM修复）`)
    }
  }
  const latest = volumeChapterDAO.getChapter(chapterId)
  let finalScore = 0
  if (latest?.emotion_assessment_json) {
    try { finalScore = Number((JSON.parse(latest.emotion_assessment_json) as { score?: number }).score) || 0 } catch { /* 无效报告 */ }
  }
  return { passed: false, rounds: round, finalScore, failedMetrics: ['超过正文质量与情绪联合修复上限'] }
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

  if (/anti-AI 规则违规/.test(reasons)) {
    const target = shortestBeat(workId)
    return {
      action: 'deai',
      targetChapterIds: target ? [target.id] : [],
      hint: '当前存在 anti-AI 规则违规。请重写为更口语、更具象、更不均匀的表达，减少模板连接词和整齐句式。'
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

  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'story_repair_blueprint',
      enrichWorkContext: true,
      enrichNarrativeMemory: true,
      temperature: 0.2,
      maxTokens: 2600,
      systemPrompt: [
        buildBeatBatchSystemPrompt(
          loadWritingPlan(workId).wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER,
          [workDAO.getById(workId)?.genre, workDAO.getById(workId)?.tags, goal].filter(Boolean).join('\n'),
          volumeChapterDAO.listChaptersByWork(workId).length
        ),
        '这是结构修复，只返回指定节拍，title 必须与输入完全一致。保留已通过的事实与人物关系，修复终审指出的主线/节拍问题。'
      ].join('\n\n'),
      prompt: [
        `【创作目标】\n${goal.trim() || '高完读率短故事'}`,
        `【整篇终审问题】\n${plan.hint}`,
        `【待修复节拍】\n${JSON.stringify(targets.map(chapter => ({ title: chapter.title, outline: chapter.outline })), null, 2)}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) throw new Error(res.error || '结构层节拍修复失败')
  const parsed = parseChapterSuggestions(res.content.trim())
  let updated = 0
  for (const candidate of parsed) {
    const target = targets.find(chapter => chapter.title === candidate.title)
    if (!target) continue
    volumeChapterDAO.updateChapterWithVersion(target.id, {
      outline: candidate.outline,
      beat_role: candidate.beat_role ?? null,
      foreshadow_target: candidate.foreshadow_target ?? null,
      next_hook: candidate.next_hook ?? null,
      characters: candidate.characters ?? null,
      emotion_contract_json: candidate.emotion_contract ? JSON.stringify(candidate.emotion_contract) : null,
      outline_diagnosis: candidate.dramatic_contract || candidate.tension_plan
        ? JSON.stringify({ dramatic_contract: candidate.dramatic_contract, tension_plan: candidate.tension_plan, emotion_contract: candidate.emotion_contract })
        : null
    })
    updated++
  }
  if (updated === 0) throw new Error('结构层修复未返回可匹配的节拍标题')
  return updated
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
  signal?: AbortSignal
): Promise<string> {
  if (plan.targetChapterIds.length === 0) return '无可修复节拍'
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
      wordTargetOverride: plan.targetWordCounts?.[chapterId]
    })
    if (!gen.success) throw new Error(gen.error || '修复生成失败')
    if (!baseline) {
      summaries.push(`${ch?.title ?? chapterId} ${gen.wordCount}字`)
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

    clearChapterNarrativeMemory(workId, chapterId)
    volumeChapterDAO.updateChapterWithVersion(chapterId, {
      content: baseline,
      word_count: baseline.replace(/\s/g, '').length,
      status: 'completed',
      ...((plan.action === 'storyline' || plan.action === 'beat') && original
        ? {
            outline: original.outline ?? '',
            beat_role: original.beat_role ?? null,
            foreshadow_target: original.foreshadow_target ?? null,
            next_hook: original.next_hook ?? null,
            characters: original.characters ?? null,
            outline_diagnosis: original.outline_diagnosis ?? null,
            emotion_contract_json: original.emotion_contract_json ?? null,
            emotion_assessment_json: original.emotion_assessment_json ?? null
          }
        : {})
    })
    try {
      await extractNarrativeMemoryAfterGeneration(workId, chapterId, baseline, signal)
    } catch (error) {
      appLogger.warn('goal_routine', '回滚后重建叙事记忆失败', {
        workId,
        chapterId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    summaries.push(`${ch?.title ?? chapterId} 已回滚（${comparison.preferCandidate ? '新版情绪门禁未通过' : comparison.reason}）`)
  }
  return `${revisedBlueprints > 0 ? `修订 ${revisedBlueprints} 个节拍蓝图；` : ''}${summaries.join('；')}`
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
    // 轮次用尽后续跑：保留阶段断点，重置轮次计数以便获得新一轮预算
    if (existing.status === 'timeout' || turn >= fullConfig.maxTurns) {
      appLogger.info('goal_routine', '轮次上限后续跑，重置轮次计数', {
        workId, phase, previousTurn: turn, maxTurns: fullConfig.maxTurns
      })
      turn = 0
    }
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
    broadcastProgress('goal:progress', ev)
  }

  appLogger.info('goal_routine', '目标循环启动', { workId, config: fullConfig })

  try {
    const pendingTitleReview = readRuntimeState(workId).titleHookCandidates
    if (phase === 'overall_self_check' && pendingTitleReview && pendingTitleReview.length > 0) {
      goalRoutineDAO.setStatus(workId, 'paused')
      emit('请先在目标循环面板确认书名导语候选，再继续整体自检', 'paused')
      return
    }

    while (turn < fullConfig.maxTurns) {
      if (controller.signal.aborted) {
        goalRoutineDAO.setStatus(workId, 'cancelled')
        emit('已取消', 'cancelled')
        return
      }

      turn++
      goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })
      const attemptedPhase = phase

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
          if (res.error) throw new Error(res.error)
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'beats', summary: res.created > 0 ? `生成 ${res.created} 个节拍` : '复用已有节拍'
          })
          emit(res.created > 0 ? `生成 ${res.created} 个节拍` : '复用已有节拍', 'running')
          phase = 'generate_title_hook'
        } else if (phase === 'generate_title_hook') {
          emit('正在生成爆款书名和导语', 'running')
          const selection = await generateTitleHook(workId, fullConfig.goalDescription, controller.signal)
          if (fullConfig.humanReviewTitleHook) {
            patchRuntimeState(workId, {
              titleHookCandidates: selection.candidates,
              titleHookPreferredIndex: selection.preferredIndex
            })
            goalRoutineDAO.update(workId, {
              status: 'paused',
              current_phase: 'overall_self_check'
            })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'title_hook_review',
              summary: `已生成 ${selection.candidates.length} 套书名导语，盲评推荐「${selection.preferred.title}」，等待作者确认`
            })
            phase = 'overall_self_check'
            emit(`书名导语盲评完成，推荐「${selection.preferred.title}」，已暂停等待作者确认`, 'paused')
            return
          }
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
          const beat = nextEmptyBeat(workId)
          if (!beat) {
            emit('正文已全部生成，进入目标验收', 'running')
            phase = 'goal_check'
          } else {
            emit(`正在生成正文「${beat.title}」`, 'running')
            const gen = await generateBeatBody(workId, beat.id, { signal: controller.signal, goalDescription: fullConfig.goalDescription })
            if (!gen.success) throw new Error(gen.error || '正文生成失败')
            const mem = gen.memoryExtracted
            const memMsg = mem ? ` · 记忆体：+${mem.planted}伏笔/${mem.snapshots}快照/${mem.foreshadowingResolved}回收` : ''
            goalRoutineDAO.appendTurn({
              work_id: workId, turn_no: turn, phase, action: 'draft',
              target_chapter_id: beat.id,
              summary: `生成「${beat.title}」${gen.wordCount}字${memMsg}`
            })
            emit(`生成「${beat.title}」${gen.wordCount}字${memMsg}`, 'running')

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
                  ? `「${beat.title}」诊断通过（${diagResult.finalScore}分，${diagResult.rounds}轮）${cleanMsg}`
                  : `「${beat.title}」诊断未完全通过（${diagResult.finalScore}分，${diagResult.rounds}轮，不达标：${diagResult.failedMetrics.join('、')}）${cleanMsg}`
              })
              if (!diagResult.passed) {
                clearChapterNarrativeMemory(workId, beat.id)
                volumeChapterDAO.updateChapterWithVersion(beat.id, {
                  content: '', word_count: 0, status: 'draft', emotion_assessment_json: null
                })
                throw new Error(`「${beat.title}」正文质量/情绪门禁未通过：${diagResult.failedMetrics.join('、')}`)
              }
            } else {
              const latest = volumeChapterDAO.getChapter(beat.id)
              const emotion = await assessChapterEmotion(workId, beat.id, latest?.content ?? '', controller.signal, true)
              if (!emotion.passed) {
                clearChapterNarrativeMemory(workId, beat.id)
                volumeChapterDAO.updateChapterWithVersion(beat.id, {
                  content: '', word_count: 0, status: 'draft', emotion_assessment_json: null
                })
                throw new Error(`「${beat.title}」情绪门禁未通过：${emotionRepairHint(emotion)}`)
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

            goalRoutineDAO.setStatus(workId, 'goal_met')

            // 试读卡点报告
            const previewRatioPct = Math.round(fullConfig.previewRatio * 100)
            if (lastCheck.previewReport) {
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'preview_anchor',
                summary: `试读卡点报告（目标比例 ${previewRatioPct}%）已生成`
              })
            }
            emit(`目标达成：质量${lastCheck.qualityScore} · 情绪盲读${lastCheck.emotionScore} · 整篇${lastCheck.overallStoryScore} · 原文盲读${lastCheck.proseReadScore} · 试读追读力${lastCheck.previewHookScore} · 目标匹配${lastCheck.goalMatchScore} · 节拍${lastCheck.contentBeats}/${lastCheck.totalBeats} · 字数${lastCheck.totalWords} · 试读${previewRatioPct}%`, 'goal_met')
            return
          }

          if (stagnantChecks >= MAX_STAGNANT_CHECKS) {
            const resetCount = runtime.structuralResetCount ?? 0
            const feedback = [lastCheck.reasons.join('；'), ...lastCheck.storyIssues].filter(Boolean).join('；')
            const deleted = resetFailedStoryStructure(workId)
            const returnToEngine = lastCheck.weakestLayer === 'storyline'
            if (returnToEngine) coreSettingDAO.deleteByWorkAndTypes(workId, ['story_engine', 'emotion_engine'])
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
          emit(`正在执行修复：${plan.action}`, 'running')
          const summary = await executeRepairPlan(workId, plan, fullConfig.goalDescription, controller.signal)
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: plan.action,
            target_chapter_id: plan.targetChapterIds[0] ?? null,
            summary
          })
          emit(`执行修复：${summary}`, 'running')
          phase = 'goal_check'
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
        emit(`轮次异常：${msg}`, 'running')
        emit(`「${attemptedPhase}」执行异常，将在下一轮继续自动重试`, 'running')
      }
    }

    // 轮次上限
    goalRoutineDAO.setStatus(workId, 'timeout')
    emit(`已达轮次上限 ${fullConfig.maxTurns}，停止`, 'timeout')
  } finally {
    clearGoalLoopModelOpts(workId)
    activeLoops.delete(workId)
  }
}
