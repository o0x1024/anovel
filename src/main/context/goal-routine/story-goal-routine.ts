/**
 * 短故事目标循环运行器 —— loop-engineering 的 automations + 状态机。
 *
 * 状态机（目标驱动流水线 + 验收后修复）：
 *   incubate_outline → 自动孵化短故事主线槽位
 *   incubator_gate → 孵化 AI 门禁
 *   freeze_storyline → 冻结主线版本
 *   materialize_settings → 沉淀核心设定
 *   generate_character_cards → 生成主角人设卡片
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
import { parseChapterSuggestions } from '../parse-chapters'
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
  type StoryGoalConfig,
  type GoalCheckResult
} from './story-goal-checker'
import { generateBeatBody } from './story-goal-doer'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import { parseStoryQualityAiScoreBreakdown } from '../../../shared/story-quality-score'
import { normalizeModelBodyOutput, stripDeterministicAiPatterns } from '../../../shared/normalize-body-text'
import { QUALITY_APPLY_FIXES_PROMPT } from '../chapter-quality'
import { STYLE_REWRITE_INSTRUCTION, countEmDashes, stripEmDashes } from '../anti-ai-rules'
import { runConsistencyGate } from '../consistency-gate'
import {
  bindGoalLoopModelOpts,
  clearGoalLoopModelOpts,
  extractStoryGoalModelPatch,
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
  action: 'draft_missing' | 'expand' | 'deai' | 'quality' | 'goal_align'
  targetChapterIds: number[]
  hint: string
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
interface TitleHookCandidate {
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

async function incubateStoryline(
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

async function runStorylineGate(
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

    onProgress?.(`AI 门禁未通过，正在自动修复主线槽位（第 ${repairRounds + 1} 轮）`)
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

async function freezeStoryline(
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

async function generateTitleHook(
  workId: number,
  goal: string,
  signal?: AbortSignal
): Promise<TitleHookCandidate> {
  assertNotAborted(signal)
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      prompt: buildTitleHookPrompt(workId, goal),
      systemPrompt: [
        '你是番茄短故事的顶流爆款编辑，深谙爆款流量密码。',
        '基于大纲孵化设定、节拍大纲和创作目标，生成 5 个能瞬间抓住读者眼球、让其产生极强追读冲动的短故事书名与导语组合。',
        '书名必须强网感、直击人性弱点、带爽感/反差/悬念/场景刺激。',
        '导语是放在全篇正文最开头、独立于编号节拍之外的"钩子段落"，交待核心故事、留住用户。',
        '导语 150-300 字，前三句爆发冲突，第一人称，强情绪，最后留悬念钩子。',
        '导语是独立于正文节拍之外的开篇钩子，发布时置于第一节拍之前。须用最具冲击力的场景直切核心冲突，让读者3秒内被抓住，产生强烈的追读冲动。',
        '导语必须是一个完整的场景片段（包含对话、动作或弹幕/心声等形式），而非概括性介绍；读者读完导语就要产生"然后呢"的强烈冲动。',
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
  const picked = candidates[0]
  workDAO.update(workId, {
    title: picked.title,
    description: picked.hook,
    genre: picked.tags.main_category || undefined,
    tags: storyCategoryTagsToStorage(picked.tags)
  })
  return picked
}

async function runOverallSelfCheck(
  workId: number,
  signal?: AbortSignal
): Promise<string> {
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
  return res.content
}

/** 构造短故事节拍拆解的 system prompt（复刻 ChaptersPanel 的 story 分支） */
function buildBeatBatchSystemPrompt(wordsPerChapter: number): string {
  const oc = outlineConstraintsForWordTarget(wordsPerChapter)
  return [
    '这是一篇一镜到底的短故事。请根据短故事的主线规划，将其拆解为连续的情节节拍（Beats），每个节拍负责推进一段核心剧情。',
    '【极度紧凑与高潮迭起约束 - 硬要求】',
    '短故事要求剧情极度紧凑，节奏极快。禁止安排任何平淡的"过渡节拍"或"日常水文"。',
    '每个节拍都必须有核心矛盾冲突或情绪爆发，爽点或反转必须一个接一个密集抛出。',
    '【第一节拍黄金开局 - 硬约束】',
    'chapters 数组的第一项是全篇第一节拍，决定读者去留。必须满足：',
    '- 标题必须体现核心冲突场景（如"离婚协议甩在脸上"、"全家逼她跪下道歉"），禁止用背景介绍式标题。',
    '- plot_points 第一条必须是冲突的极端场景直接切入（不公/背叛/羞辱/悬念），禁止背景介绍、角色出场铺垫或日常开篇。',
    '- beat_role 必须是 B(推进冲突) 或 A(爽点释放)，禁止 C(反转铺垫)——第一节拍不允许慢热。',
    '- next_hook 必须是能让读者瞬间想看下一拍的强悬念。',
    '【输出格式 - 必须严格遵守】',
    '只输出一个 JSON 对象；禁止 Markdown 标题、前置说明、思考过程，以及 ``` 代码块围栏。',
    'chapters 数组每一项为一个节拍（请勿输出"第X章"或"节拍X"字样，直接写节拍剧情标题即可）。',
    `每章字段：title、plot_points（${oc.pointsMin}-${oc.pointsMax} 条情节节点数组）、beat_role、foreshadow_target、next_hook、characters（本章出场角色名数组）。`,
    'beat_role: A(爽点释放)/B(推进冲突)/C(反转铺垫)，禁止使用 transition',
    `【长度】每项 plot_points 合计 ${oc.charsMin}-${oc.charsMax} 字梗概（每节拍目标 ${wordsPerChapter} 字正文），禁止正文级长文。`,
    `格式：{"chapters":[{"title":"节拍剧情标题","plot_points":["节点1","节点2","节点3"],"beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"]}]}`
  ].join('\n')
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
  onProgress?.(`正在生成节拍大纲（约 ${suggestedCount} 个节拍）`)
  const prompt = [
    `【短故事一镜到底】当前需要将其拆解为连续的情节节拍，共约 ${suggestedCount} 个节拍。`,
    goalDescription.trim() ? `【短故事创作目标】${goalDescription.trim()}，请据此拆解节拍（题材/风格/情节走向须贴合目标）` : '',
    vol.description ? `主线说明：${vol.description}` : '',
    '请输出完整 chapters 数组。'
  ].filter(Boolean).join('\n')

  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      prompt,
      systemPrompt: buildBeatBatchSystemPrompt(wpc),
      step: 'volume_chapters_batch',
      workId,
      volumeId,
      workContextOptions: { includeVolumes: true }
    }),
    { stream: false, signal }
  )

  if (!response.success || !response.content?.trim()) {
    return { created: 0, error: response.error || '节拍生成失败' }
  }

  const parsed = parseChapterSuggestions(response.content.trim())
  if (parsed.length === 0) return { created: 0, error: '节拍解析为空' }

  const items = parsed.map(p => ({
    title: p.title,
    outline: p.outline ?? '',
    beat_role: p.beat_role ?? null,
    foreshadow_target: p.foreshadow_target ?? null,
    next_hook: p.next_hook ?? null,
    characters: p.characters ?? null
  }))
  volumeChapterDAO.batchCreateChapters(volumeId, items, existing.length > 0 ? 'replace' : 'append')
  onProgress?.(`已回填 ${items.length} 个节拍到节拍大纲`)
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

const MAX_DIAGNOSE_FIX_ROUNDS = 5

interface DiagnoseFixResult {
  passed: boolean
  rounds: number
  finalScore: number
  failedMetrics: string[]
}

/**
 * 正文生成后的 AI 诊断 + 修复循环。
 * 持续诊断 → 修复，直到所有单项评分 >= qualityMin 或达到轮次上限。
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

  while (round < MAX_DIAGNOSE_FIX_ROUNDS) {
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
      appLogger.warn('goal_routine', 'AI诊断失败，跳过修复循环', { workId, chapterId, round, error: diagRes.error })
      return { passed: false, rounds: round, finalScore: -1, failedMetrics: ['诊断失败'] }
    }

    const breakdown = diagRes.report ? parseStoryQualityAiScoreBreakdown(diagRes.report) : null
    const items = breakdown?.items ?? []

    const failedMetrics = items
      .filter(it => it.score < qualityMin)
      .map(it => `${it.label}:${it.score}`)
    const allPassed = failedMetrics.length === 0 && !diagRes.hardFail

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
      if (p.find && patched.includes(p.find)) {
        patched = patched.replace(p.find, p.replace)
        patchApplied++
      }
    }

    // 2) 若 patches 不够或无 patches，用 LLM 对照诊断报告进行修复
    if (patchApplied === 0 || failedMetrics.length > 2) {
      assertNotAborted(signal)
      const report = diagRes.report ?? ''
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

  // 轮次用尽，做最终诊断返回
  const finalCh = volumeChapterDAO.getChapter(chapterId)
  const finalContent = finalCh?.content?.trim() ?? ''
  if (!finalContent) return { passed: false, rounds: round, finalScore: 0, failedMetrics: ['无正文'] }

  const finalDiag = await diagnoseChapterQualityAi(workId, chapterId, finalContent, { thinkingEnabled: getGoalLoopModelOpts(workId).thinkingEnabled })
  const finalBreakdown = finalDiag.report ? parseStoryQualityAiScoreBreakdown(finalDiag.report) : null
  const finalFailed = (finalBreakdown?.items ?? [])
    .filter(it => it.score < qualityMin)
    .map(it => `${it.label}:${it.score}`)

  onProgress?.(`「${chTitle}」修复${MAX_DIAGNOSE_FIX_ROUNDS}轮后仍有不达标项：${finalFailed.join('、')}（${finalDiag.scoreTotal ?? -1}分）`)
  return {
    passed: finalFailed.length === 0 && !finalDiag.hardFail,
    rounds: round,
    finalScore: finalDiag.scoreTotal ?? -1,
    failedMetrics: finalFailed
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
    return {
      action: 'expand',
      targetChapterIds: target ? [target.id] : [],
      hint: '当前全篇总字数已超出目标上限。请重写本节拍并压缩：删除注水段落、冗余内容与重复内容，保留核心冲突，显著降低本节拍字数。'
    }
  }

  if (/字数不足/.test(reasons)) {
    const target = shortestBeat(workId)
    return {
      action: 'expand',
      targetChapterIds: target ? [target.id] : [],
      hint: '当前总字数不足。请在不拖慢节奏的前提下扩充强冲突细节、对话、动作和情绪反应。'
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

  return {
    action: 'quality',
    targetChapterIds: pickWeakChapters(workId, check, 1),
    hint: '当前质量或一致性未达标。请强化开篇钩子、视角稳定、因果链、反转兑现和节拍结尾钩子。'
  }
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
  for (const chapterId of plan.targetChapterIds) {
    assertNotAborted(signal)
    const ch = volumeChapterDAO.getChapter(chapterId)
    const gen = await generateBeatBody(workId, chapterId, { signal, goalDescription: goal, extraHint: plan.hint })
    if (!gen.success) throw new Error(gen.error || '修复生成失败')
    summaries.push(`${ch?.title ?? chapterId} ${gen.wordCount}字`)
  }
  return summaries.join('；')
}

const VALID_PHASES: Phase[] = GOAL_ROUTINE_PHASE_ORDER

function isResumable(status: string | null | undefined): boolean {
  return status === 'paused' || status === 'running' || status === 'cancelled' || status === 'timeout'
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
    fullConfig = { ...saved, ...extractStoryGoalModelPatch(config) }
    turn = existing.turn_count ?? 0
    const savedPhase = existing.current_phase as Phase
    phase = explicitPhase ?? (VALID_PHASES.includes(savedPhase) ? savedPhase : 'incubate_outline')
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
    fullConfig = { ...saved, ...extractStoryGoalModelPatch(config) }
    turn = existing.turn_count ?? 0
    phase = explicitPhase
    if (existing.status === 'timeout' || turn >= fullConfig.maxTurns) {
      appLogger.info('goal_routine', '指定步骤续跑，重置轮次计数', {
        workId, phase, previousTurn: turn, maxTurns: fullConfig.maxTurns
      })
      turn = 0
    }
    appLogger.info('goal_routine', '目标循环从指定步骤续跑', { workId, phase, turn, config: fullConfig })
  } else {
    fullConfig = { ...DEFAULT_STORY_GOAL_CONFIG, ...config }
    turn = 0
    phase = explicitPhase ?? 'incubate_outline'
  }

  const controller = new AbortController()
  activeLoops.set(workId, controller)
  bindGoalLoopModelOpts(workId, fullConfig)

  goalRoutineDAO.ensure(workId)
  goalRoutineDAO.update(workId, {
    status: 'running',
    max_turns: fullConfig.maxTurns,
    turn_count: turn,
    current_phase: phase,
    goal_met: false,
    goal_config_json: JSON.stringify(fullConfig)
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
    while (turn < fullConfig.maxTurns) {
      if (controller.signal.aborted) {
        goalRoutineDAO.setStatus(workId, 'cancelled')
        emit('已取消', 'cancelled')
        return
      }

      turn++
      goalRoutineDAO.update(workId, { turn_count: turn, current_phase: phase })

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
          const picked = await generateTitleHook(workId, fullConfig.goalDescription, controller.signal)
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'title_hook',
            summary: `应用书名「${picked.title}」`
          })
          emit(`已应用书名「${picked.title}」和导语`, 'running')
          phase = 'overall_self_check'
        } else if (phase === 'overall_self_check') {
          emit('正在运行整体自检', 'running')
          const report = await runOverallSelfCheck(workId, controller.signal)
          const conclusion = report.match(/(PASS|FAIL|REVISE|通过|不通过|需修订).{0,40}/i)?.[0] ?? '自检完成'
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'overall_check', summary: conclusion
          })
          emit(`整体自检完成：${conclusion}`, 'running')
          phase = 'draft_body'
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

            // 正文生成后可选：AI 诊断 + 修复循环，直到所有单项评分 >= qualityMin
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
            }

            phase = nextEmptyBeat(workId) ? 'draft_body' : 'goal_check'
          }
        } else if (phase === 'goal_check') {
          emit('正在进行目标验收（质量/字数/门禁/目标匹配）', 'running')
          lastCheck = await checkStoryGoal(workId, fullConfig, controller.signal)
          goalRoutineDAO.update(workId, {
            last_quality_score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : null,
            goal_met: lastCheck.met
          })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'check',
            score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : lastCheck.goalMatchScore,
            summary: lastCheck.met ? '目标达成' : lastCheck.reasons.join('；')
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
            emit(`目标达成：质量${lastCheck.qualityScore} · 目标匹配${lastCheck.goalMatchScore} · 节拍${lastCheck.contentBeats}/${lastCheck.totalBeats} · 字数${lastCheck.totalWords} · 试读${previewRatioPct}%`, 'goal_met')
            return
          }

          emit(`未达标：${lastCheck.reasons.join('；')}`, 'running')
          phase = 'repair_plan'
        } else if (phase === 'repair_plan') {
          const plan = buildRepairPlan(workId, lastCheck)
          goalRoutineDAO.update(workId, { state_json: JSON.stringify({ repairPlan: plan }) })
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
        // 异常不立即终止，下一轮继续；靠 maxTurns 兜底
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
