/**
 * 短故事目标循环的 Doer —— 主进程 headless 正文生成。
 * 复刻 GeneratePanel.generateBody 的 prompt 构造，但走 modelService.chat 无渲染层。
 * context-budget.ts 在 step=body_generation + workId 时自动注入 anti-ai 规则/人设/文风。
 *
 * 目标驱动：用户自由文字目标注入 prompt，引导生成贯彻题材/风格/情节。
 * 仅轻量 humanize（不掺重的 autoRewrite）——去AI 由 checker 判定、fix 阶段针对性处理。
 */
import { modelService } from '../../model'
import { volumeChapterDAO, foreshadowingDAO, workDAO, incubatorDraftSlotDAO } from '../../db'
import { normalizeModelBodyOutput } from '../../../shared/normalize-body-text'
import { formatBodyWordTargetLine } from '../../../shared/body-word-target'
import { formatBodyPromptLines } from '../../../shared/work-terminology'
import {
  BODY_GENERATION_SYSTEM,
  STORY_BODY_GENERATION_SYSTEM,
  extractEmotionIntensity
} from '../../../shared/body-generation-prompt'
import {
  goldenOpeningSystemExtra,
  goldenOpeningUserSection
} from '../../../shared/golden-opening'
import { humanizeText } from '../humanize-text'
import { loadWritingPlan } from '../writing-plan'
import {
  MEMORY_EXTRACT_SYSTEM_PROMPT,
  FORESHADOWING_RESOLVE_SYSTEM_PROMPT,
  parseMemoryExtract,
  applyMemoryExtract,
  parseForeshadowingResolutions,
  applyForeshadowingResolutions
} from '../memory-extract'
import { clearChapterMemoryBeforeExtract, clearChapterNarrativeMemory } from '../memory-cleanup'
import { appLogger } from '../../logger/app-logger'
import { withGoalLoopModelOptions } from './story-goal-model'
import { formatChapterResourceBudgetsForPrompt, runResourceConstraintGate } from '../resource-ledger'
import { formatGenrePolicy, resolveStoryGenrePolicy } from './story-genre-policy'
import { runConsistencyGate } from '../consistency-gate'
import { emotionExecutionCard, ensureChapterEmotionContract } from './emotion-engine'
import { retentionProseRules } from './reader-retention'
import {
  BODY_REACTION_CLICHE_DIRECTIVE,
  detectBodyReactionCliches
} from '../anti-ai-rules'
import { extractJsonText } from '../parse-json-extract'

export interface BeatGenResult {
  success: boolean
  content: string
  wordCount: number
  antiAiRepairs?: number
  antiAiRepairRounds?: number
  memoryExtracted?: { planted: number; resolved: number; snapshots: number; timelineEvents: number; foreshadowingResolved: number; foreshadowingPartial: number }
  error?: string
}

export interface GenerateBeatBodyOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
  goalDescription?: string
  extraHint?: string
  workType?: 'novel' | 'story'
  wordTargetOverride?: number
}

export interface ReviseBeatBodyOptions {
  signal?: AbortSignal
  instruction: string
  workType?: 'novel' | 'story'
  wordTargetOverride?: number
}

function countWords(s: string): number {
  return s.replace(/\s/g, '').length
}

interface BodyReactionRepairResult {
  content: string
  repairs: number
  rounds: number
  remaining: number
}

interface BodyReactionReplacement {
  original?: unknown
  replacement?: unknown
}

const MAX_BODY_REACTION_REPAIR_ROUNDS = 2

/**
 * 只让模型返回命中句子的 replacement，再由程序定点应用。
 * 避免为清理一句套话而重写整拍，导致事实、伏笔或人物状态漂移。
 */
async function repairBodyReactionCliches(
  workId: number,
  chapterId: number,
  initialContent: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<BodyReactionRepairResult> {
  let content = initialContent
  let repairs = 0
  let rounds = 0

  for (let round = 1; round <= MAX_BODY_REACTION_REPAIR_ROUNDS; round++) {
    if (signal?.aborted) break
    const violations = detectBodyReactionCliches(content)
    if (violations.length === 0) break
    rounds = round
    const sentences = [...new Set(violations.map(item => item.sentence))]
    onProgress?.(`检测到 ${violations.length} 处泛白类模板反应，正在定点修复（${round}/${MAX_BODY_REACTION_REPAIR_ROUNDS}）`)
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        chapterId,
        step: 'body_style_rewrite',
        maxTokens: Math.max(1200, sentences.join('').length * 3),
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        systemPrompt: [
          '你是小说正文定点修订器。只处理列出的命中句子，不得改动其他正文。',
          BODY_REACTION_CLICHE_DIRECTIVE,
          '无独立剧情信息的命中句子，replacement 返回空字符串。',
          '如命中句子还承载对话、选择、道具变化或因果信息，只删掉套话并保留这些信息。',
          '严禁补写呼吸一滞、身体僵住、瞳孔骤缩、颤抖、攥拳、嘴角上扬等替代套话。',
          '只返回 JSON：{"replacements":[{"original":"必须与输入句子逐字一致","replacement":"修订后完整句子或空字符串"}]}'
        ].join('\n'),
        prompt: `【待定点修订的句子】\n${JSON.stringify(sentences, null, 2)}`
      }),
      { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) {
      appLogger.warn('goal_routine', '泛白类身体反应定点修复未返回结果', {
        workId, chapterId, round, error: response.error
      })
      continue
    }

    let parsed: unknown
    try {
      const json = extractJsonText(response.content)
      parsed = json ? JSON.parse(json) : null
    } catch {
      parsed = null
    }
    const replacements = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { replacements?: unknown }).replacements)
        ? (parsed as { replacements: unknown[] }).replacements
        : []

    let appliedThisRound = 0
    for (const raw of replacements as BodyReactionReplacement[]) {
      if (typeof raw?.original !== 'string' || typeof raw.replacement !== 'string') continue
      const original = raw.original
      const replacement = raw.replacement
      if (!sentences.includes(original) || !content.includes(original) || original === replacement) continue
      // 模型若只是把一种禁用变体换成另一种，拒绝应用该 patch。
      if (replacement && detectBodyReactionCliches(replacement).length > 0) continue
      content = content.split(original).join(replacement)
      appliedThisRound++
    }
    repairs += appliedThisRound
    onProgress?.(`泛白类模板反应第 ${round} 轮已修复 ${appliedThisRound} 句，剩余 ${detectBodyReactionCliches(content).length} 处`)
    appLogger.info('goal_routine', '泛白类身体反应定点修复', {
      workId,
      chapterId,
      round,
      detected: violations.length,
      applied: appliedThisRound,
      remaining: detectBodyReactionCliches(content).length
    })
  }

  return {
    content,
    repairs,
    rounds,
    remaining: detectBodyReactionCliches(content).length
  }
}

/** 检测当前节拍是否为全篇第一节拍（按 sort 排序） */
function unitOrdinal(workId: number, chapterId: number): number {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  if (chapters.length === 0) return 0
  const index = chapters.findIndex(chapter => chapter.id === chapterId)
  return index < 0 ? 0 : index + 1
}

/** 从孵化器读取「黄金开局」slot 内容 */
function getOpeningSlotContent(workId: number): string {
  return incubatorDraftSlotDAO.getActiveSlot(workId, 'opening')?.content?.trim() ?? ''
}

/** 读取作品的导语（description 字段，由 generateTitleHook 阶段写入） */
function getWorkHook(workId: number): string {
  return workDAO.getById(workId)?.description?.trim() ?? ''
}

function getDramaticContractPrompt(outlineDiagnosis?: string | null): string {
  if (!outlineDiagnosis?.trim()) return ''
  try {
    const parsed = JSON.parse(outlineDiagnosis) as {
      arc_phase?: unknown
      dramatic_contract?: Record<string, unknown>
      tension_plan?: { phase?: unknown; level?: unknown; payoff_type?: unknown }
    }
    const contract = parsed.dramatic_contract
    if (!contract || typeof contract !== 'object') return ''
    const rows = ([
      ['读者承诺', String(contract.scene_promise ?? '').trim()],
      ['主角目标', String(contract.protagonist_want ?? '').trim()],
      ['阻力', String(contract.obstacle ?? '').trim()],
      ['失败代价', String(contract.stakes ?? '').trim()],
      ['信息差', String(contract.info_gap ?? '').trim()],
      ['压力升级', String(contract.pressure_escalation ?? '').trim()],
      ['中段转折', String(contract.turn ?? '').trim()],
      ['不可逆变化', String(contract.irreversible_change ?? '').trim()],
      ['兑现/欠账', String(contract.payoff_or_debt ?? '').trim()],
      ['结尾问题', String(contract.next_question ?? '').trim()]
    ] as Array<[string, string]>).filter(([, value]) => Boolean(value))
    const tension = parsed.tension_plan
    if (rows.length === 0 && !tension) return ''
    return [
      '【本拍戏剧契约 - 必须执行】',
      parsed.arc_phase ? `长篇结构阶段：${String(parsed.arc_phase)}` : '',
      '正文不是复述事件流水账，必须把本拍写成一场有目标、阻力、代价、转折和不可逆变化的戏。',
      ...rows.map(([label, value]) => `- ${label}：${value}`),
      tension ? `【本拍张力位置】${String(tension.phase ?? '')} · 强度 ${String(tension.level ?? '')}/10 · 兑现类型 ${String(tension.payoff_type ?? '')}` : '',
      tension?.payoff_type === 'debt' ? '本拍以蓄力和欠债为主，不得强行完成大清算。' : '',
      tension?.payoff_type === 'partial' ? '本拍只做阶段兑现，同时产生更具体的新代价。' : '',
      tension?.payoff_type === 'major' ? '本拍允许重大兑现，但兑现必须由此前筹备和本拍选择共同触发。' : '',
      tension?.payoff_type === 'aftertaste' ? '本拍完成闭环后保留人物损失、关系余波或主题余味。' : '',
      '执行要求：每个主要段落都必须推动目标/阻力/压力/信息差之一；禁止连续两段只交代背景、移动地点、解释设定或重复情绪。结尾必须落实“不可逆变化”，并抛出“结尾问题”。'
    ].filter(Boolean).join('\n')
  } catch {
    return ''
  }
}

/**
 * 构造用户提示。注入创作目标引导生成。
 * @param extraHint 额外修复提示（fix 阶段用，如"提升质量/扩写"）
 */
function buildBodyPrompt(
  workId: number,
  chapterId: number,
  wordTarget: number,
  goalDescription?: string,
  extraHint?: string,
  workType: 'novel' | 'story' = 'story'
): string | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const ch = chapters.find(c => c.id === chapterId)
  if (!ch) return null
  const volumes = volumeChapterDAO.listVolumes(workId)
  const vol = volumes.find(v => v.id === ch.volume_id)
  const ordinal = unitOrdinal(workId, chapterId)
  const openingSlot = workType === 'story' && ordinal === 1 ? getOpeningSlotContent(workId) : ''
  const hookText = ordinal === 1 ? getWorkHook(workId) : ''
  const dramaticContract = getDramaticContractPrompt(ch.outline_diagnosis)
  const work = workDAO.getById(workId)
  const genrePolicy = formatGenrePolicy(
    resolveStoryGenrePolicy([work?.genre, work?.tags, goalDescription].filter(Boolean).join('\n')),
    'proseRules'
  )
  const resourceBudget = formatChapterResourceBudgetsForPrompt(workId, chapterId)
  const emotionCard = emotionExecutionCard(chapterId)
  return formatBodyPromptLines(workType, {
    volName: vol?.name,
    volDescription: vol?.description,
    chapterTitle: ch.title,
    outline: ch.outline,
    wordTargetLine: formatBodyWordTargetLine(wordTarget)
  }).concat(
    [
      goalDescription?.trim()
        ? `【本篇创作目标】\n${goalDescription.trim()}\n请在生成本${workType === 'story' ? '拍' : '章'}时贯彻该目标（题材/风格/情节走向）。`
        : '',
      extraHint?.trim() ? `【本次修复要求】\n${extraHint.trim()}` : '',
      genrePolicy,
      retentionProseRules(workType),
      dramaticContract,
      emotionCard,
      resourceBudget,
      goldenOpeningUserSection({ workType, ordinal, hook: hookText, openingDesign: openingSlot })
    ].filter(Boolean)
  ).join('\n\n')
}

/**
 * 为指定节拍/章节生成正文：headless 生成 → humanize（仅轻量）→ 写库（带版本快照）。
 * 不掺 autoRewrite；去AI 由 checker 判定、fix 阶段针对性处理。
 */
export async function generateBeatBody(
  workId: number,
  chapterId: number,
  options: GenerateBeatBodyOptions = {}
): Promise<BeatGenResult> {
  const { signal, onProgress, goalDescription, extraHint, workType = 'story', wordTargetOverride } = options
  await ensureChapterEmotionContract(workId, chapterId, goalDescription, signal)
  const plan = loadWritingPlan(workId)
  const wordTarget = wordTargetOverride ?? (plan.wordsPerChapter || 4000)
  const prompt = buildBodyPrompt(workId, chapterId, wordTarget, goalDescription, extraHint, workType)
  if (!prompt) return { success: false, content: '', wordCount: 0, error: `${workType === 'story' ? '节拍' : '章节'}不存在` }

  if (signal?.aborted) return { success: false, content: '', wordCount: 0, error: '已取消' }

  const ordinal = unitOrdinal(workId, chapterId)
  const baseSystemPrompt = workType === 'story' ? STORY_BODY_GENERATION_SYSTEM : BODY_GENERATION_SYSTEM
  const openingExtra = goldenOpeningSystemExtra(workType, ordinal)
  const systemPrompt = [baseSystemPrompt, openingExtra, BODY_REACTION_CLICHE_DIRECTIVE].filter(Boolean).join('\n\n')

  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      prompt,
      systemPrompt,
      step: 'body_generation',
      workId,
      maxTokens: Math.max(2048, wordTarget * 2),
      workContextOptions: {
        includeVolumes: true,
        includeIncubator: false,
        excludeCoreTypes: ['worldview']
      },
      chapterId,
      volumeId: volumeChapterDAO.listChaptersByWork(workId).find(c => c.id === chapterId)?.volume_id,
      enrichNarrativeMemory: true
    }),
    { stream: false, signal }
  )

  if (!response.success || !response.content?.trim()) {
    return { success: false, content: '', wordCount: 0, error: response.error || '生成失败' }
  }

  return persistGeneratedBody(workId, chapterId, response.content, workType, signal, onProgress)
}

async function persistGeneratedBody(
  workId: number,
  chapterId: number,
  rawContent: string,
  workType: 'novel' | 'story',
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<BeatGenResult> {
  let content = normalizeModelBodyOutput(rawContent.trim(), 'body_generation')

  const { cleanedContent } = extractEmotionIntensity(content)
  content = cleanedContent

  // 仅轻量 humanize（正则级），不掺重的 autoRewrite
  try {
    content = humanizeText(content)
  } catch { /* humanize 失败不阻断 */ }

  // 在写库和提取叙事记忆之前定点清理，避免模板反应污染伏笔/角色快照。
  const antiAiRepair = await repairBodyReactionCliches(workId, chapterId, content, signal, onProgress)
  if (antiAiRepair.remaining > 0) {
    return {
      success: false,
      content: '',
      wordCount: 0,
      antiAiRepairs: antiAiRepair.repairs,
      antiAiRepairRounds: antiAiRepair.rounds,
      error: `泛白类身体反应经 ${antiAiRepair.rounds} 轮定点修复仍剩 ${antiAiRepair.remaining} 处，已否决当前候选`
    }
  }
  content = antiAiRepair.content

  const wordCount = countWords(content)

  // 写库：updateChapterWithVersion 自动存版本快照（安全 guardrail）
  volumeChapterDAO.updateChapterWithVersion(chapterId, {
    content,
    word_count: wordCount,
    status: 'completed',
    emotion_assessment_json: null
  })

  // 提取叙事记忆体（伏笔种植 + 角色快照）+ AI 伏笔回收检测
  let memoryExtracted: BeatGenResult['memoryExtracted']
  let memoryError = ''
  try {
    memoryExtracted = await extractNarrativeMemoryAfterGeneration(workId, chapterId, content, signal)
  } catch (e) {
    memoryError = e instanceof Error ? e.message : String(e)
    appLogger.warn('goal_routine', '叙事记忆提取失败（不阻断生成）', {
      workId, chapterId, error: memoryError
    })
  }

  if (workType === 'novel' && memoryError) {
    clearChapterNarrativeMemory(workId, chapterId)
    volumeChapterDAO.updateChapterWithVersion(chapterId, {
      content: '',
      word_count: 0,
      status: 'draft'
    })
    return { success: false, content: '', wordCount: 0, error: memoryError }
  }

  const resourceGate = runResourceConstraintGate(workId, chapterId)
  if (!resourceGate.passed) {
    clearChapterNarrativeMemory(workId, chapterId)
    volumeChapterDAO.updateChapterWithVersion(chapterId, {
      content: '',
      word_count: 0,
      status: 'draft'
    })
    return {
      success: false,
      content: '',
      wordCount: 0,
      memoryExtracted,
      error: `资源数值门禁未通过：${resourceGate.blockers.join('；')}`
    }
  }
  if (resourceGate.warnings.length > 0) {
    appLogger.warn('goal_routine', '资源数值门禁存在警告', {
      workId, chapterId, warnings: resourceGate.warnings
    })
  }

  const consistencyGate = runConsistencyGate(workId, chapterId, content)
  if (!consistencyGate.passed) {
    clearChapterNarrativeMemory(workId, chapterId)
    volumeChapterDAO.updateChapterWithVersion(chapterId, { content: '', word_count: 0, status: 'draft' })
    return {
      success: false,
      content: '',
      wordCount: 0,
      error: `章节一致性门禁未通过：${consistencyGate.blockers.join('；')}`
    }
  }

  return {
    success: true,
    content,
    wordCount,
    memoryExtracted,
    antiAiRepairs: antiAiRepair.repairs,
    antiAiRepairRounds: antiAiRepair.rounds
  }
}

/** 基于当前正文做定向修订；与首次生成共用同一套记忆、资源和时间线提交门禁。 */
export async function reviseBeatBody(
  workId: number,
  chapterId: number,
  options: ReviseBeatBodyOptions
): Promise<BeatGenResult> {
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!chapter?.content?.trim()) return { success: false, content: '', wordCount: 0, error: '当前章节没有可修订正文' }
  const workType = options.workType ?? 'novel'
  await ensureChapterEmotionContract(workId, chapterId, '', options.signal)
  const wordTarget = options.wordTargetOverride ?? (loadWritingPlan(workId).wordsPerChapter || 4000)
  const basePrompt = buildBodyPrompt(workId, chapterId, wordTarget, undefined, options.instruction, workType)
  if (!basePrompt) return { success: false, content: '', wordCount: 0, error: '章节不存在' }
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'body_goal_revise',
      maxTokens: Math.max(2048, wordTarget * 2),
      enrichWorkContext: false,
      enrichNarrativeMemory: true,
      systemPrompt: [
        '你是长篇小说结构精修编辑。根据修订要求修改当前章节，只输出修改后的完整正文。',
        '保留未被问题证据涉及的情节、人物状态和有效表达；不得改变后续章节已经依赖的事实。',
        '修改后仍须严格执行章节大纲、戏剧契约、资源预算和章末钩子。'
      ].join('\n'),
      prompt: `${basePrompt}\n\n【当前正文】\n${chapter.content}\n\n【修订要求】\n${options.instruction}`
    }),
    { stream: false, signal: options.signal }
  )
  if (!response.success || !response.content?.trim()) {
    return { success: false, content: '', wordCount: 0, error: response.error || '修订失败' }
  }
  return persistGeneratedBody(workId, chapterId, response.content, workType, options.signal)
}

export async function extractNarrativeMemoryAfterGeneration(
  workId: number,
  chapterId: number,
  content: string,
  signal?: AbortSignal
): Promise<NonNullable<BeatGenResult['memoryExtracted']>> {
  if (signal?.aborted) return { planted: 0, resolved: 0, snapshots: 0, timelineEvents: 0, foreshadowingResolved: 0, foreshadowingPartial: 0 }

  const resourceBudgetPrompt = formatChapterResourceBudgetsForPrompt(workId, chapterId)
  const memorySystemPrompt = resourceBudgetPrompt
    ? [
        MEMORY_EXTRACT_SYSTEM_PROMPT,
        resourceBudgetPrompt,
        '【资源快照硬要求】',
        '上方每一项预算资源都必须写入对应 owner 的 character_snapshots.numeric_stats，禁止遗漏。',
        '即使本章资源没有变化，也必须输出其章末数值；只有不在资源预算中的普通数值才允许省略。',
        'numeric_stats.name 必须与预算 resource 完全一致，character_name 必须与预算 owner 一致。',
        '章末数值必须落在预算的章末区间内，并以正文实际发生的消耗、恢复、冷却或状态变化为依据。'
      ].join('\n\n')
    : MEMORY_EXTRACT_SYSTEM_PROMPT

  // 1. 提取伏笔种植 + 角色快照
  const memRes = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      prompt: content,
      systemPrompt: memorySystemPrompt,
      workId,
      chapterId,
      step: 'memory_extract',
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    }),
    { stream: false, signal }
  )

  let planted = 0
  let snapshots = 0
  let timelineEvents = 0
  if (!memRes.success || !memRes.content?.trim()) {
    throw new Error(`叙事记忆提取失败：${memRes.error || '模型未返回内容'}`)
  }
  const extracted = parseMemoryExtract(memRes.content)
  clearChapterMemoryBeforeExtract(workId, chapterId)
  const result = applyMemoryExtract(workId, chapterId, extracted)
  planted = result.planted
  snapshots = result.snapshots
  timelineEvents = result.timelineEvents

  // 2. AI 伏笔回收检测
  let foreshadowingResolved = 0
  let foreshadowingPartial = 0
  const pending = foreshadowingDAO.listPending(workId)
  if (pending.length > 0) {
    if (signal?.aborted) return { planted, resolved: 0, snapshots, timelineEvents, foreshadowingResolved, foreshadowingPartial }
    const pendingList = pending.map(p =>
      `- [id:${p.id}] depth:${p.depth ?? 'normal'} 描述：${p.description}`
    ).join('\n')
    const resolveRes = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt: [
          '【待回收伏笔列表】',
          pendingList,
          '',
          '【本章内容】',
          content.slice(0, 8000)
        ].join('\n'),
        systemPrompt: FORESHADOWING_RESOLVE_SYSTEM_PROMPT,
        workId,
        chapterId,
        step: 'foreshadowing_resolve',
        enrichWorkContext: false,
        enrichNarrativeMemory: false
      }),
      { stream: false, signal }
    )
    if (resolveRes.success && resolveRes.content?.trim()) {
      const parsed = parseForeshadowingResolutions(resolveRes.content)
      const applied = applyForeshadowingResolutions(workId, chapterId, parsed)
      foreshadowingResolved = applied.resolved
      foreshadowingPartial = applied.partial
    }
  }

  appLogger.info('goal_routine', '叙事记忆已更新', {
    workId, chapterId, planted, snapshots, foreshadowingResolved, foreshadowingPartial
  })

  return {
    planted,
    resolved: 0,
    snapshots,
    timelineEvents,
    foreshadowingResolved,
    foreshadowingPartial
  }
}
