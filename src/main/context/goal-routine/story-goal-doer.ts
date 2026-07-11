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
  STORY_BODY_GENERATION_OPENING_EXTRA,
  extractEmotionIntensity
} from '../../../shared/body-generation-prompt'
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

export interface BeatGenResult {
  success: boolean
  content: string
  wordCount: number
  memoryExtracted?: { planted: number; resolved: number; snapshots: number; foreshadowingResolved: number; foreshadowingPartial: number }
  error?: string
}

export interface GenerateBeatBodyOptions {
  signal?: AbortSignal
  goalDescription?: string
  extraHint?: string
  workType?: 'novel' | 'story'
  wordTargetOverride?: number
}

function countWords(s: string): number {
  return s.replace(/\s/g, '').length
}

/** 检测当前节拍是否为全篇第一节拍（按 sort 排序） */
function isFirstBeat(workId: number, chapterId: number): boolean {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  if (chapters.length === 0) return false
  const sorted = [...chapters].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
  return sorted[0]?.id === chapterId
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
  const firstBeat = workType === 'story' && isFirstBeat(workId, chapterId)
  const openingSlot = firstBeat ? getOpeningSlotContent(workId) : ''
  const hookText = firstBeat ? getWorkHook(workId) : ''
  const dramaticContract = workType === 'story' ? getDramaticContractPrompt(ch.outline_diagnosis) : ''
  const work = workDAO.getById(workId)
  const genrePolicy = workType === 'story'
    ? formatGenrePolicy(resolveStoryGenrePolicy([work?.genre, work?.tags, goalDescription].filter(Boolean).join('\n')), 'proseRules')
    : ''
  const resourceBudget = formatChapterResourceBudgetsForPrompt(workId, chapterId)
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
      dramaticContract,
      resourceBudget,
      openingSlot ? `【黄金开局设计 - 必须严格执行】\n${openingSlot}` : '',
      hookText ? `【本篇导语（已确定的前台钩子风格）】\n${hookText}\n本拍正文开头须与导语的情绪烈度和冲突切入点保持一致，但不得重复导语中已写的场景和台词，须从导语结束处自然衔接、继续推进剧情。` : ''
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
  const { signal, goalDescription, extraHint, workType = 'story', wordTargetOverride } = options
  const plan = loadWritingPlan(workId)
  const wordTarget = wordTargetOverride ?? (plan.wordsPerChapter || 4000)
  const prompt = buildBodyPrompt(workId, chapterId, wordTarget, goalDescription, extraHint, workType)
  if (!prompt) return { success: false, content: '', wordCount: 0, error: `${workType === 'story' ? '节拍' : '章节'}不存在` }

  if (signal?.aborted) return { success: false, content: '', wordCount: 0, error: '已取消' }

  const firstBeat = workType === 'story' && isFirstBeat(workId, chapterId)
  const baseSystemPrompt = workType === 'story' ? STORY_BODY_GENERATION_SYSTEM : BODY_GENERATION_SYSTEM
  const systemPrompt = firstBeat
    ? baseSystemPrompt + STORY_BODY_GENERATION_OPENING_EXTRA
    : baseSystemPrompt

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

  let content = normalizeModelBodyOutput(response.content.trim(), 'body_generation')

  const { cleanedContent, intensity } = extractEmotionIntensity(content)
  content = cleanedContent

  // 仅轻量 humanize（正则级），不掺重的 autoRewrite
  try {
    content = humanizeText(content)
  } catch { /* humanize 失败不阻断 */ }

  const wordCount = countWords(content)

  // 写库：updateChapterWithVersion 自动存版本快照（安全 guardrail）
  volumeChapterDAO.updateChapterWithVersion(chapterId, {
    content,
    word_count: wordCount,
    status: 'completed',
    ...(intensity != null ? { emotion_intensity: intensity } : {})
  })

  // 提取叙事记忆体（伏笔种植 + 角色快照）+ AI 伏笔回收检测
  let memoryExtracted: BeatGenResult['memoryExtracted']
  try {
    memoryExtracted = await extractNarrativeMemoryAfterGeneration(workId, chapterId, content, signal)
  } catch (e) {
    appLogger.warn('goal_routine', '叙事记忆提取失败（不阻断生成）', {
      workId, chapterId, error: e instanceof Error ? e.message : String(e)
    })
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

  return { success: true, content, wordCount, memoryExtracted }
}

export async function extractNarrativeMemoryAfterGeneration(
  workId: number,
  chapterId: number,
  content: string,
  signal?: AbortSignal
): Promise<NonNullable<BeatGenResult['memoryExtracted']>> {
  if (signal?.aborted) return { planted: 0, resolved: 0, snapshots: 0, foreshadowingResolved: 0, foreshadowingPartial: 0 }

  // 1. 提取伏笔种植 + 角色快照
  const memRes = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      prompt: content,
      systemPrompt: MEMORY_EXTRACT_SYSTEM_PROMPT,
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
  if (memRes.success && memRes.content?.trim()) {
    const extracted = parseMemoryExtract(memRes.content)
    clearChapterMemoryBeforeExtract(workId, chapterId)
    const result = applyMemoryExtract(workId, chapterId, extracted)
    planted = result.planted
    snapshots = result.snapshots
  }

  // 2. AI 伏笔回收检测
  let foreshadowingResolved = 0
  let foreshadowingPartial = 0
  const pending = foreshadowingDAO.listPending(workId)
  if (pending.length > 0) {
    if (signal?.aborted) return { planted, resolved: 0, snapshots, foreshadowingResolved, foreshadowingPartial }
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
    foreshadowingResolved,
    foreshadowingPartial
  }
}
