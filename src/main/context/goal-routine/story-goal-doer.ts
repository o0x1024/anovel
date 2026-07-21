/**
 * 短故事目标循环的 Doer —— 主进程 headless 正文生成。
 * 复刻 GeneratePanel.generateBody 的 prompt 构造，但走 modelService.chat 无渲染层。
 * context-budget.ts 在 step=body_generation + workId 时自动注入 anti-ai 规则/人设/文风。
 *
 * 目标驱动：用户自由文字目标注入 prompt，引导生成贯彻题材/风格/情节。
 * 仅轻量 humanize（不掺重的 autoRewrite）——去AI 由 checker 判定、fix 阶段针对性处理。
 */
import { modelService } from '../../model'
import {
  volumeChapterDAO,
  foreshadowingDAO,
  workDAO,
  incubatorDraftSlotDAO,
  storyStateDAO,
  storyHarnessDAO,
  coreSettingDAO
} from '../../db'
import { normalizeModelBodyOutput } from '../../../shared/normalize-body-text'
import { formatBodyWordTargetLine } from '../../../shared/body-word-target'
import { formatBodyPromptLines } from '../../../shared/work-terminology'
import {
  NOVEL_GOAL_BODY_GENERATION_SYSTEM,
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
  MEMORY_EXTRACT_RESPONSE_SCHEMA,
  parseMemoryExtract,
  partitionStateFactsByEvidence,
  deriveChapterPatternFromOutlineDiagnosis,
  applyMemoryExtract,
  parseForeshadowingResolutions,
  applyForeshadowingResolutions
} from '../memory-extract'
import type { ExtractedMemory, ForeshadowingResolutionResult } from '../memory-extract'
import { clearChapterMemoryBeforeExtract, clearChapterNarrativeMemory } from '../memory-cleanup'
import { getDatabase } from '../../db/connection'
import { appLogger } from '../../logger/app-logger'
import { getGoalLoopModelOpts, withGoalLoopModelOptions } from './story-goal-model'
import { formatChapterResourceBudgetsForPrompt, runResourceConstraintGate } from '../resource-ledger'
import { formatGenrePolicy, resolveStoryGenrePolicy } from './story-genre-policy'
import { runConsistencyGate } from '../consistency-gate'
import { emotionExecutionCard, ensureChapterEmotionContract } from './emotion-engine'
import { retentionProseRules } from './reader-retention'
import {
  applyBodyReactionReplacementPatches,
  BODY_REACTION_CLICHE_DIRECTIVE,
  detectBodyReactionCliches,
  removeBodyReactionClichesDeterministically,
  type BodyReactionReplacementPatch
} from '../anti-ai-rules'
import { extractJsonText } from '../parse-json-extract'
import { assessStoryBeatContinuity } from './story-continuity-gate'
import { formatStoryContractForPrompt } from './story-contract'
import { assessNovelSystemics } from './novel-systemic-gate'
import {
  canRepairStoryContinuity,
  isStoryContinuityEvaluatorFailure
} from './story-continuity-repair-policy'
import {
  detectStoryTextIntegrityIssues,
  buildStoryCandidateContextSource,
  derivedMemoryFailureDisposition,
  isStructuralStoryCandidateRejection,
  repairDeterministicStoryQuotes,
  resolveStoryModelCapability,
  shouldBlockStoryAntiAi,
  STORY_HARNESS_MAX_CANDIDATES_PER_BEAT
} from '../../../shared/story-harness'
import {
  formatChapterExecutionContract,
  type ChapterExecutionContract
} from '../../../shared/chapter-execution-contract'
import {
  buildChapterExecutionContext,
  persistChapterExecutionContract
} from '../chapter-execution-context'
import {
  isNovelExecutionEvaluatorFailure,
  assessNovelExecutionCandidate,
  repairNovelExecutionCandidate,
  type NovelExecutionGateResult
} from './novel-execution-gate'
import { selectReusableNovelExecutionCandidate } from './novel-goal-policy'

function storyCandidateContextSource(
  workId: number,
  chapter: ReturnType<typeof volumeChapterDAO.getChapter>
): string {
  return buildStoryCandidateContextSource({
    acceptedBody: chapter?.content,
    outline: chapter?.outline,
    outlineDiagnosis: chapter?.outline_diagnosis,
    emotionContract: chapter?.emotion_contract_json,
    storyEngine: coreSettingDAO.getByType(workId, 'story_engine')?.structured_content,
    storyContract: coreSettingDAO.getByType(workId, 'story_contract')?.structured_content
  })
}

export interface StoryContinuityRepairEvent {
  type: 'rejected' | 'repaired' | 'passed' | 'evaluator_retry'
  candidateRound: number
  blockers: string[]
  wordCount: number
}

export interface BeatGenResult {
  success: boolean
  content: string
  wordCount: number
  antiAiRepairs?: number
  antiAiRepairRounds?: number
  continuityRepairRounds?: number
  continuityBlockers?: string[]
  requiresEscalation?: boolean
  failureKind?: 'contract' | 'body_integrity' | 'continuity' | 'evaluator_protocol' | 'memory_extract' | 'resource' | 'consistency' | 'candidate_budget' | 'cancelled'
  memoryPending?: boolean
  memoryExtracted?: { planted: number; resolved: number; snapshots: number; timelineEvents: number; stateFacts?: number; patternFingerprint?: boolean; warnings?: string[]; foreshadowingResolved: number; foreshadowingPartial: number }
  error?: string
}

export interface GenerateBeatBodyOptions {
  signal?: AbortSignal
  onProgress?: (message: string) => void
  goalDescription?: string
  extraHint?: string
  workType?: 'novel' | 'story' | 'causal_novel'
  wordTargetOverride?: number
  onContinuityEvent?: (event: StoryContinuityRepairEvent) => void
  /** 小说目标循环先稳定正文，再由外层统一提交叙事记忆。 */
  deferNarrativeMemory?: boolean
}

export interface ReviseBeatBodyOptions {
  signal?: AbortSignal
  instruction: string
  workType?: 'novel' | 'story'
  wordTargetOverride?: number
  /** 修订候选不得提前覆盖已经验收的叙事记忆。 */
  deferNarrativeMemory?: boolean
}

export interface PreparedNarrativeMemory {
  sourceContent: string
  extracted: ExtractedMemory
  resolutions: ForeshadowingResolutionResult
  warnings: string[]
}

export interface CommitPreparedNarrativeMemoryOptions {
  /** 在同一事务内、临时记忆已经可见时执行依赖记忆的同步门禁。 */
  validate?: () => string[]
  markChapterCompleted?: boolean
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
        responseSchema: {
          name: 'body_reaction_replacements',
          strict: false,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['replacements'],
            properties: {
              replacements: {
                type: 'array',
                minItems: 1,
                maxItems: sentences.length,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['original', 'replacement'],
                  properties: {
                    original: { type: 'string', enum: sentences },
                    replacement: { type: 'string' }
                  }
                }
              }
            }
          }
        },
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

    const patchResult = applyBodyReactionReplacementPatches(
      content,
      sentences,
      replacements as BodyReactionReplacementPatch[]
    )
    content = patchResult.content
    const appliedThisRound = patchResult.applied
    repairs += appliedThisRound
    onProgress?.(`泛白类模板反应第 ${round} 轮已修复 ${appliedThisRound} 句，剩余 ${detectBodyReactionCliches(content).length} 处`)
    appLogger.info('goal_routine', '泛白类身体反应定点修复', {
      workId,
      chapterId,
      round,
      detected: violations.length,
      applied: appliedThisRound,
      rejected: patchResult.rejected,
      remaining: detectBodyReactionCliches(content).length
    })
  }

  const beforeFallback = detectBodyReactionCliches(content).length
  if (!signal?.aborted && beforeFallback > 0) {
    const fallback = removeBodyReactionClichesDeterministically(content)
    content = fallback.content
    repairs += fallback.removedClauses
    onProgress?.(`模型定点补丁未收敛，已只删除 ${fallback.removedClauses} 个命中分句，剩余 ${fallback.remaining} 处`)
    appLogger.warn('goal_routine', '泛白类身体反应使用确定性删除兜底', {
      workId,
      chapterId,
      detected: beforeFallback,
      removedClauses: fallback.removedClauses,
      remaining: fallback.remaining
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

function getDramaticContractPrompt(outlineDiagnosis?: string | null, isFinalBeat = false): string {
  if (!outlineDiagnosis?.trim()) return ''
  try {
    const parsed = JSON.parse(outlineDiagnosis) as {
      arc_phase?: unknown
      dramatic_contract?: Record<string, unknown>
      continuity_contract?: Record<string, unknown>
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
      ...(!isFinalBeat ? [['结尾问题', String(contract.next_question ?? '').trim()] as [string, string]] : [])
    ] as Array<[string, string]>).filter(([, value]) => Boolean(value))
    const tension = parsed.tension_plan
    const continuity = parsed.continuity_contract
    if (rows.length === 0 && !tension && !continuity) return ''
    return [
      '【本拍戏剧契约 - 必须执行】',
      parsed.arc_phase ? `长篇结构阶段：${String(parsed.arc_phase)}` : '',
      '正文不是复述事件流水账，必须把本拍写成一场有目标、阻力、代价、转折和不可逆变化的戏。',
      ...rows.map(([label, value]) => `- ${label}：${value}`),
      continuity ? `【本拍连续性合同 - 事实硬约束】\n${JSON.stringify(continuity, null, 2)}` : '',
      tension ? `【本拍张力位置】${String(tension.phase ?? '')} · 强度 ${String(tension.level ?? '')}/10 · 兑现类型 ${String(tension.payoff_type ?? '')}` : '',
      tension?.payoff_type === 'debt' ? '本拍以蓄力和欠债为主，不得强行完成大清算。' : '',
      tension?.payoff_type === 'partial' ? '本拍只做阶段兑现，同时产生更具体的新代价。' : '',
      tension?.payoff_type === 'major' ? '本拍允许重大兑现，但兑现必须由此前筹备和本拍选择共同触发。' : '',
      tension?.payoff_type === 'aftertaste' ? '本拍完成闭环后保留人物损失、关系余波或主题余味。' : '',
      isFinalBeat
        ? '执行要求：这是全篇最终拍。必须落实不可逆变化、回答核心问题并完成主线闭环；不得引入未经铺垫的新反派、新任务、新证据或续集钩子。可以保留损失和情绪余味，但不能再抛主线问题。'
        : '执行要求：每个主要段落都必须推动目标/阻力/压力/信息差之一；禁止连续两段只交代背景、移动地点、解释设定或重复情绪。结尾必须落实“不可逆变化”，并抛出由本拍因果自然产生的“结尾问题”。'
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
  workType: 'novel' | 'story' = 'story',
  executionContract?: ChapterExecutionContract,
  executionContext = ''
): string | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const ch = chapters.find(c => c.id === chapterId)
  if (!ch) return null
  const volumes = volumeChapterDAO.listVolumes(workId)
  const vol = volumes.find(v => v.id === ch.volume_id)
  const ordinal = unitOrdinal(workId, chapterId)
  const totalUnits = chapters.length
  const isFinalBeat = workType === 'story' && ordinal === totalUnits
  const openingSlot = workType === 'story' && ordinal === 1 ? getOpeningSlotContent(workId) : ''
  const hookText = ordinal === 1 ? getWorkHook(workId) : ''
  const dramaticContract = getDramaticContractPrompt(ch.outline_diagnosis, isFinalBeat)
  const work = workDAO.getById(workId)
  const genrePolicy = formatGenrePolicy(
    resolveStoryGenrePolicy([work?.genre, work?.tags, goalDescription].filter(Boolean).join('\n')),
    'proseRules'
  )
  const resourceBudget = formatChapterResourceBudgetsForPrompt(workId, chapterId)
  const emotionCard = emotionExecutionCard(chapterId)
  const taskPrompt = formatBodyPromptLines(workType, {
    volName: vol?.name,
    volDescription: workType === 'novel' && executionContract ? undefined : vol?.description,
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
      workType === 'story' ? formatStoryContractForPrompt(workId) : '',
      dramaticContract,
      emotionCard,
      resourceBudget,
      goldenOpeningUserSection({ workType, ordinal, hook: hookText, openingDesign: openingSlot })
    ].filter(Boolean)
  ).join('\n\n')
  if (workType !== 'novel' || !executionContract) return taskPrompt
  return [
    formatChapterExecutionContract(executionContract),
    executionContext,
    taskPrompt
  ].filter(Boolean).join('\n\n')
}

async function generateNovelBodyByScenes(input: {
  workId: number
  chapterId: number
  contract: ChapterExecutionContract
  basePrompt: string
  systemPrompt: string
  signal?: AbortSignal
  onProgress?: (message: string) => void
  startIndex?: number
  initialContent?: string
}): Promise<{ success: boolean; content: string; completedSceneCount: number; error?: string }> {
  const completed: string[] = input.initialContent?.trim() ? [input.initialContent.trim()] : []
  const startIndex = Math.max(0, Math.min(input.startIndex ?? 0, input.contract.scenes.length))
  for (let index = startIndex; index < input.contract.scenes.length; index++) {
    if (input.signal?.aborted) {
      return { success: false, content: completed.join('\n\n'), completedSceneCount: index, error: '已取消' }
    }
    const scene = input.contract.scenes[index]
    input.onProgress?.(`正在生成${scene.label}（${index + 1}/${input.contract.scenes.length}）`)
    const priorTail = completed.join('\n\n').slice(-1800)
    const response = await modelService.chat(
      withGoalLoopModelOptions(input.workId, {
        workId: input.workId,
        chapterId: input.chapterId,
        step: 'body_generation_scene',
        maxTokens: Math.max(1800, Math.min(5000, scene.targetWords * 2)),
        temperature: 0.65,
        enrichWorkContext: false,
        enrichNarrativeMemory: index === 0,
        systemPrompt: [
          input.systemPrompt,
          '你正在分场景完成同一章节。只输出当前场景正文，不输出场景标题、编号、自检或后续场景。',
          '当前场景必须从已完成正文末尾之后继续，禁止复述。完成本场 mustCover 并停在 exitFacts，不得提前写后续场景。'
        ].join('\n\n'),
        prompt: [
          input.basePrompt,
          `【当前只写这一场】\n${JSON.stringify(scene, null, 2)}`,
          priorTail ? `【本章已完成正文尾部】\n${priorTail}` : '',
          `当前场景目标约 ${scene.targetWords} 字，只写正文。`
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal: input.signal }
    )
    if (!response.success || !response.content?.trim()) {
      return {
        success: false,
        content: completed.join('\n\n'),
        completedSceneCount: index,
        error: response.error || `${scene.label}生成失败`
      }
    }
    completed.push(normalizeModelBodyOutput(response.content.trim(), 'body_generation'))
  }
  return { success: true, content: completed.join('\n\n'), completedSceneCount: input.contract.scenes.length }
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
  const {
    signal, onProgress, goalDescription, extraHint, workType = 'story', wordTargetOverride,
    deferNarrativeMemory = false
  } = options
  const proseWorkType: 'novel' | 'story' = workType === 'causal_novel' ? 'novel' : workType
  const existingChapter = volumeChapterDAO.getChapter(chapterId)
  const generationContext = storyCandidateContextSource(workId, existingChapter)
  if (workType === 'story') {
    const priorCandidates = storyHarnessDAO.listCandidatesForBaseline(
      workId,
      chapterId,
      generationContext,
      50
    )
    const continuityEvidence = priorCandidates
      .map(candidate => candidate.reject_reason?.trim().slice(0, 600))
      .filter((value): value is string => Boolean(value))
      .filter(isStructuralStoryCandidateRejection)
    if (continuityEvidence.length >= STORY_HARNESS_MAX_CANDIDATES_PER_BEAT) {
      return {
        success: false,
        content: existingChapter?.content ?? '',
        wordCount: existingChapter?.word_count ?? 0,
        requiresEscalation: true,
        failureKind: 'candidate_budget',
        continuityBlockers: continuityEvidence.slice(0, STORY_HARNESS_MAX_CANDIDATES_PER_BEAT),
        error: `当前节拍基于同一生成上下文已有 ${STORY_HARNESS_MAX_CANDIDATES_PER_BEAT} 个结构性候选未通过，停止继续抽卡并升级结构修复`
      }
    }
  }
  await ensureChapterEmotionContract(workId, chapterId, goalDescription, signal)
  const plan = loadWritingPlan(workId)
  const wordTarget = wordTargetOverride ?? (plan.wordsPerChapter || 4000)
  const executionContract = proseWorkType === 'novel'
    ? persistChapterExecutionContract(workId, chapterId, wordTarget)
    : null
  if (proseWorkType === 'novel' && !executionContract) {
    return { success: false, content: '', wordCount: 0, failureKind: 'contract', error: '章节不存在，无法编译正文执行合同' }
  }
  if (executionContract?.errors.length) {
    return {
      success: false,
      content: '',
      wordCount: 0,
      failureKind: 'contract',
      error: `章节执行合同冲突：${executionContract.errors.join('；')}`
    }
  }
  const reusableEvaluatorCandidate = proseWorkType === 'novel' && executionContract && !existingChapter?.content?.trim()
    ? selectReusableNovelExecutionCandidate(volumeChapterDAO.listVersions(chapterId), {
        outline: existingChapter?.outline,
        wordTarget: executionContract.wordTarget,
        wordMin: executionContract.wordMin,
        wordMax: executionContract.wordMax
      })
    : undefined
  if (reusableEvaluatorCandidate?.content?.trim()) {
    onProgress?.(`复用已保留的章节候选版本 v${reusableEvaluatorCandidate.version_number}，按新版证据协议重新验收`)
    appLogger.info('goal_routine', '复用评估器证据协议失败时保留的最佳章节候选', {
      workId,
      chapterId,
      versionNumber: reusableEvaluatorCandidate.version_number,
      modelType: reusableEvaluatorCandidate.model_type,
      wordCount: reusableEvaluatorCandidate.word_count,
      wordTarget: executionContract.wordTarget,
      wordRange: [executionContract.wordMin, executionContract.wordMax]
    })
    return persistGeneratedBody(
      workId,
      chapterId,
      reusableEvaluatorCandidate.content,
      proseWorkType,
      signal,
      onProgress,
      options.onContinuityEvent,
      deferNarrativeMemory
    )
  }
  const compactContext = executionContract
    ? buildChapterExecutionContext(workId, chapterId, executionContract)
    : { text: '', sectionChars: {} }
  const prompt = buildBodyPrompt(
    workId,
    chapterId,
    wordTarget,
    goalDescription,
    extraHint,
    proseWorkType,
    executionContract ?? undefined,
    compactContext.text
  )
  if (!prompt) return { success: false, content: '', wordCount: 0, error: `${proseWorkType === 'story' ? '节拍' : '章节'}不存在` }

  if (signal?.aborted) return { success: false, content: '', wordCount: 0, error: '已取消' }

  const ordinal = unitOrdinal(workId, chapterId)
  const baseSystemPrompt = proseWorkType === 'story'
    ? STORY_BODY_GENERATION_SYSTEM
    : NOVEL_GOAL_BODY_GENERATION_SYSTEM
  const openingExtra = goldenOpeningSystemExtra(proseWorkType, ordinal)
  const systemPrompt = [baseSystemPrompt, openingExtra, BODY_REACTION_CLICHE_DIRECTIVE].filter(Boolean).join('\n\n')

  if (executionContract) {
    appLogger.info('goal_routine', '正文章节执行合同已编译', {
      workId,
      chapterId,
      chapterOrdinal: executionContract.chapterOrdinal,
      dialogueMode: executionContract.dialogueMode,
      wordRange: [executionContract.wordMin, executionContract.wordMax],
      contractChars: formatChapterExecutionContract(executionContract).length,
      relevantContextChars: compactContext.text.length,
      contextSectionChars: compactContext.sectionChars,
      warnings: executionContract.warnings
    })
  }

  let sceneResume: { startIndex: number; initialContent: string } | undefined
  if (proseWorkType === 'novel' && executionContract?.scenes.length) {
    const latestVersion = volumeChapterDAO.listVersions(chapterId)[0]
    const partial = latestVersion?.model_type === 'novel_scene_partial' && latestVersion.content?.trim()
      ? latestVersion
      : undefined
    if (partial?.snapshot_json) {
      try {
        const snapshot = JSON.parse(partial.snapshot_json) as {
          contractHash?: unknown
          completedSceneCount?: unknown
        }
        const completedSceneCount = Number(snapshot.completedSceneCount)
        if (
          snapshot.contractHash === executionContract.sourceOutlineHash
          && Number.isInteger(completedSceneCount)
          && completedSceneCount > 0
          && completedSceneCount < executionContract.scenes.length
        ) {
          sceneResume = { startIndex: completedSceneCount, initialContent: partial.content ?? '' }
          onProgress?.(`检测到同一章节合同的分场景断点，从第 ${completedSceneCount + 1} 场继续`)
        }
      } catch { /* 旧版本快照不是断点元数据 */ }
    }
  }

  const response = proseWorkType === 'novel' && executionContract?.scenes.length
    ? await generateNovelBodyByScenes({
        workId,
        chapterId,
        contract: executionContract,
        basePrompt: prompt,
        systemPrompt,
        signal,
        onProgress,
        startIndex: sceneResume?.startIndex,
        initialContent: sceneResume?.initialContent
      })
    : await modelService.chat(
        withGoalLoopModelOptions(workId, {
          prompt,
          systemPrompt,
          step: 'body_generation',
          workId,
          maxTokens: Math.max(6000, Math.min(12000, wordTarget * 2)),
          temperature: proseWorkType === 'novel' ? 0.75 : undefined,
          enrichWorkContext: proseWorkType !== 'novel',
          chapterId,
          volumeId: volumeChapterDAO.listChaptersByWork(workId).find(c => c.id === chapterId)?.volume_id,
          enrichNarrativeMemory: true
        }),
        { stream: false, signal }
      )

  if (!response.success || !response.content?.trim()) {
    if (proseWorkType === 'novel' && response.content?.trim() && executionContract) {
      volumeChapterDAO.createVersion(chapterId, {
        outline: existingChapter?.outline ?? undefined,
        content: response.content,
        word_count: countWords(response.content),
        model_type: 'novel_scene_partial',
        snapshot_json: JSON.stringify({
          contractHash: executionContract.sourceOutlineHash,
          completedSceneCount: 'completedSceneCount' in response ? response.completedSceneCount : 0,
          partialChars: response.content.length,
          error: response.error || '分场景生成中断'
        })
      })
    }
    return { success: false, content: response.content ?? '', wordCount: 0, error: response.error || '生成失败' }
  }

  if (proseWorkType === 'novel' && executionContract?.scenes.length && 'completedSceneCount' in response) {
    volumeChapterDAO.createVersion(chapterId, {
      outline: existingChapter?.outline ?? undefined,
      content: response.content,
      word_count: countWords(response.content),
      model_type: 'novel_scene_complete',
      snapshot_json: JSON.stringify({
        contractHash: executionContract.sourceOutlineHash,
        completedSceneCount: response.completedSceneCount
      })
    })
  }

  return persistGeneratedBody(
    workId,
    chapterId,
    response.content,
    proseWorkType,
    signal,
    onProgress,
    options.onContinuityEvent,
    deferNarrativeMemory
  )
}

async function repairStoryContinuityCandidate(
  workId: number,
  chapterId: number,
  candidate: string,
  blockers: string[],
  signal?: AbortSignal
): Promise<{ success: boolean; content: string; error?: string }> {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const index = chapters.findIndex(chapter => chapter.id === chapterId)
  const chapter = chapters[index]
  const previous = index > 0 ? chapters[index - 1]?.content?.trim() ?? '' : ''
  const next = index >= 0 && index < chapters.length - 1 ? chapters[index + 1]?.content?.trim() ?? '' : ''
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'story_continuity_repair',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.2,
      maxTokens: Math.max(2400, Math.min(9000, Math.ceil(countWords(candidate) * 1.7))),
      systemPrompt: [
        '你是短故事跨拍连续性修复编辑。只输出修订后的完整候选正文，不要解释、标题或Markdown。',
        '只修改门禁证据涉及的时间、地点、阻碍解法、人物知情、证据来源和因果衔接；保留其他已通过情节与有效表达。',
        '禁止用新巧合、新权威、新证据或反派降智覆盖旧硬伤。必须让修复事实能从上一拍、故事合同或当前蓝图推导。',
        '若需要时间过去，必须在正文中明确写出时间过渡；若上一拍提出断网、拉闸等阻碍，本拍必须展示可信应对及代价。',
        '修复后篇幅与当前候选大致相当，并继续完成本拍蓝图。'
      ].join('\n'),
      prompt: [
        formatStoryContractForPrompt(workId),
        `【当前节拍蓝图】\n${chapter?.outline ?? ''}\n${chapter?.outline_diagnosis ?? ''}`,
        previous ? `【上一拍结尾】\n${previous.slice(-2200)}` : '',
        next ? `【已有下一拍开头】\n${next.slice(0, 1600)}` : '',
        `【连续性门禁阻塞证据】\n${blockers.map((blocker, i) => `${i + 1}. ${blocker}`).join('\n')}`,
        `【待修复候选正文】\n${candidate}`
      ].filter(Boolean).join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    return { success: false, content: candidate, error: response.error || '连续性定向修复无返回' }
  }
  return {
    success: true,
    content: normalizeModelBodyOutput(response.content.trim(), 'body_generation')
  }
}

async function persistGeneratedBody(
  workId: number,
  chapterId: number,
  rawContent: string,
  workType: 'novel' | 'story',
  signal?: AbortSignal,
  onProgress?: (message: string) => void,
  onContinuityEvent?: (event: StoryContinuityRepairEvent) => void,
  deferNarrativeMemory = false
): Promise<BeatGenResult> {
  let content = normalizeModelBodyOutput(rawContent.trim(), 'body_generation')
  const currentChapter = volumeChapterDAO.getChapter(chapterId)
  const generationContext = storyCandidateContextSource(workId, currentChapter)
  let candidateId: number | undefined

  const rejectStoryCandidate = (reason: string, checks?: unknown): void => {
    if (candidateId != null) {
      storyHarnessDAO.markCandidate(candidateId, 'rejected', { rejectReason: reason, checks })
    }
  }

  const createStoryCandidate = (sourceStep: string): void => {
    if (workType !== 'story') return
    candidateId = storyHarnessDAO.createCandidate({
      workId,
      chapterId,
      content,
      wordCount: countWords(content),
      baseContent: generationContext,
      sourceStep
    })
  }

  const { cleanedContent } = extractEmotionIntensity(content)
  content = cleanedContent

  // 仅轻量 humanize（正则级），不掺重的 autoRewrite
  try {
    content = humanizeText(content)
  } catch { /* humanize 失败不阻断 */ }

  // 在写库和提取叙事记忆之前定点清理，避免模板反应污染伏笔/角色快照。
  let antiAiRepair = await repairBodyReactionCliches(workId, chapterId, content, signal, onProgress)
  content = antiAiRepair.content
  if (workType === 'story') content = repairDeterministicStoryQuotes(content)
  createStoryCandidate('body_generation')

  const antiAiBlocked = workType === 'story'
    ? shouldBlockStoryAntiAi(antiAiRepair.remaining, content.length)
    : antiAiRepair.remaining > 0
  if (antiAiBlocked) {
    const error = `泛白类身体反应经 ${antiAiRepair.rounds} 轮定点修复仍剩 ${antiAiRepair.remaining} 处，已否决当前候选`
    rejectStoryCandidate(error, { antiAiRemaining: antiAiRepair.remaining })
    return {
      success: false,
      content,
      wordCount: countWords(content),
      antiAiRepairs: antiAiRepair.repairs,
      antiAiRepairRounds: antiAiRepair.rounds,
      error
    }
  }

  if (workType === 'story' && antiAiRepair.remaining > 0) {
    appLogger.warn('goal_routine', '候选仍有少量模板反应，降级为软问题继续门禁', {
      workId, chapterId, remaining: antiAiRepair.remaining
    })
  }

  let antiAiRepairs = antiAiRepair.repairs
  let antiAiRepairRounds = antiAiRepair.rounds
  let wordCount = countWords(content)
  let continuityRepairRounds = 0

  if (workType === 'novel') {
    const contract = persistChapterExecutionContract(workId, chapterId)
    if (!contract) {
      return { success: false, content, wordCount, failureKind: 'contract', error: '无法编译长篇章节执行合同' }
    }
    for (let round = 0; round <= 2; round++) {
      onProgress?.(`正在核验章节情节点覆盖与章际衔接（${round + 1}/3）`)
      const evaluatorAttempts: NovelExecutionGateResult[] = []
      let gate = await assessNovelExecutionCandidate(workId, chapterId, content, contract, signal)
      evaluatorAttempts.push(gate)
      for (let evaluatorRetry = 1; isNovelExecutionEvaluatorFailure(gate.blockers) && evaluatorRetry <= 2; evaluatorRetry++) {
        onProgress?.(`章节执行门禁证据格式无效，正在重新取证（${evaluatorRetry}/2）`)
        gate = await assessNovelExecutionCandidate(
          workId,
          chapterId,
          content,
          contract,
          signal,
          gate.evaluatorProtocolErrors ?? gate.blockers
        )
        evaluatorAttempts.push(gate)
      }
      if (gate.passed) break
      if (isNovelExecutionEvaluatorFailure(gate.blockers)) {
        const candidateWordCount = countWords(content)
        volumeChapterDAO.createVersion(chapterId, {
          outline: currentChapter?.outline ?? undefined,
          content,
          word_count: candidateWordCount,
          model_type: 'novel_gate_evidence',
          generation_round: round + 1,
          snapshot_json: JSON.stringify({
            contractHash: contract.sourceOutlineHash,
            gate,
            evaluatorAttempts,
            evaluatorFailure: true
          })
        })
        return {
          success: false,
          content,
          wordCount: candidateWordCount,
          continuityRepairRounds: round,
          continuityBlockers: gate.blockers,
          requiresEscalation: true,
          failureKind: 'evaluator_protocol',
          error: '章节执行评估器连续 3 次未返回可逐项验证的精确证据，候选已存入版本历史且不触发正文改写'
        }
      }
      wordCount = countWords(content)
      volumeChapterDAO.createVersion(chapterId, {
        outline: currentChapter?.outline ?? undefined,
        content,
        word_count: wordCount,
        model_type: 'novel_execution_candidate',
        generation_round: round + 1,
        snapshot_json: JSON.stringify({
          contractHash: contract.sourceOutlineHash,
          gate,
          evaluatorAttempts
        })
      })
      if (round >= 2) {
        return {
          success: false,
          content,
          wordCount,
          continuityRepairRounds: round,
          continuityBlockers: gate.blockers,
          requiresEscalation: true,
          failureKind: 'continuity',
          error: `章节情节点覆盖/衔接经过 2 轮定向修复仍未通过：${gate.blockers.join('；')}`
        }
      }
      onProgress?.(`章节执行门禁未通过，正在定向修复（${round + 1}/2）`)
      const repaired = await repairNovelExecutionCandidate(
        workId,
        chapterId,
        content,
        contract,
        gate.blockers,
        signal
      )
      if (!repaired.success) {
        return {
          success: false,
          content,
          wordCount,
          continuityBlockers: gate.blockers,
          requiresEscalation: true,
          failureKind: 'continuity',
          error: repaired.error || '章节执行定向修复失败'
        }
      }
      content = normalizeModelBodyOutput(repaired.content, 'body_generation')
      try { content = humanizeText(content) } catch { /* 保留模型正文 */ }
      antiAiRepair = await repairBodyReactionCliches(workId, chapterId, content, signal, onProgress)
      content = antiAiRepair.content
      antiAiRepairs += antiAiRepair.repairs
      antiAiRepairRounds += antiAiRepair.rounds
      if (antiAiRepair.remaining > 0) {
        return {
          success: false,
          content,
          wordCount: countWords(content),
          error: `章节执行修复后仍有 ${antiAiRepair.remaining} 处泛白类模板反应`
        }
      }
      continuityRepairRounds = round + 1
    }
  }

  if (workType === 'story') {
    const chapters = volumeChapterDAO.listChaptersByWork(workId)
    let povCharacter = ''
    try {
      const names = JSON.parse(currentChapter?.characters ?? '[]') as unknown
      if (Array.isArray(names)) povCharacter = String(names[0] ?? '').trim()
    } catch { /* 角色字段不合法时仍继续其余确定性检查 */ }
    const integrityIssues = detectStoryTextIntegrityIssues(content, {
      chapterId,
      finalBeat: chapters.length > 0 && chapters[chapters.length - 1]?.id === chapterId,
      povMode: currentChapter?.pov_mode,
      povCharacter
    })
    if (integrityIssues.some(issue => issue.severity === 'blocker')) {
      const error = `正文确定性门禁未通过：${integrityIssues.map(issue => issue.message).join('；')}`
      rejectStoryCandidate(error, { integrityIssues })
      return {
        success: false,
        content,
        wordCount,
        antiAiRepairs,
        antiAiRepairRounds,
        error,
        failureKind: 'body_integrity'
      }
    }
    if (candidateId != null) {
      storyHarnessDAO.markCandidate(candidateId, 'lint_passed', { checks: { integrityIssues } })
    }

    const capability = resolveStoryModelCapability(getGoalLoopModelOpts(workId))
    let evaluatorRetries = 0
    while (true) {
      const candidateRound = continuityRepairRounds + 1
      onProgress?.(`正在执行跨拍连续性与最终闭环门禁（候选第 ${candidateRound} 轮）`)
      const continuity = await assessStoryBeatContinuity(workId, chapterId, content, signal)
      if (continuity.passed) {
        if (candidateId != null) {
          storyHarnessDAO.markCandidate(candidateId, 'continuity_passed', { checks: { continuity } })
        }
        onContinuityEvent?.({
          type: 'passed', candidateRound, blockers: [], wordCount: countWords(content)
        })
        break
      }
      if (isStoryContinuityEvaluatorFailure(continuity.blockers) && evaluatorRetries < 2) {
        evaluatorRetries++
        onContinuityEvent?.({
          type: 'evaluator_retry', candidateRound, blockers: continuity.blockers, wordCount: countWords(content)
        })
        continue
      }
      evaluatorRetries = 0
      wordCount = countWords(content)
      // 候选不进入正式正文，但存入章节版本，便于查看每轮修复前后的实际文本。
      volumeChapterDAO.createVersion(chapterId, {
        outline: volumeChapterDAO.getChapter(chapterId)?.outline ?? undefined,
        content,
        word_count: wordCount,
        model_type: 'continuity_candidate',
        generation_round: candidateRound
      })
      onContinuityEvent?.({
        type: 'rejected', candidateRound, blockers: continuity.blockers, wordCount
      })
      rejectStoryCandidate(continuity.blockers.join('；'), { continuity })
      if (isStoryContinuityEvaluatorFailure(continuity.blockers)) {
        return {
          success: false,
          content,
          wordCount,
          antiAiRepairs,
          antiAiRepairRounds,
          continuityRepairRounds,
          continuityBlockers: continuity.blockers,
          requiresEscalation: true,
          failureKind: 'continuity',
          error: '跨拍连续性评估器连续 3 次不可用，已保留候选且不修改正文'
        }
      }
      if (!canRepairStoryContinuity(continuityRepairRounds, capability.maxContinuityRepairs)) {
        return {
          success: false,
          content,
          wordCount,
          antiAiRepairs,
          antiAiRepairRounds,
          continuityRepairRounds,
          continuityBlockers: continuity.blockers,
          requiresEscalation: true,
          failureKind: 'continuity',
          error: `跨拍连续性经过 ${capability.maxContinuityRepairs} 轮定向修复仍未通过：${continuity.blockers.join('；')}`
        }
      }

      const nextRepairRound = continuityRepairRounds + 1
      onProgress?.(`跨拍连续性未通过，正在定向修复（${nextRepairRound}/${capability.maxContinuityRepairs}）`)
      const repaired = await repairStoryContinuityCandidate(workId, chapterId, content, continuity.blockers, signal)
      if (!repaired.success) {
        return {
          success: false,
          content,
          wordCount,
          antiAiRepairs,
          antiAiRepairRounds,
          continuityRepairRounds,
          continuityBlockers: continuity.blockers,
          requiresEscalation: true,
          failureKind: 'continuity',
          error: `跨拍连续性定向修复失败：${repaired.error}`
        }
      }
      content = repaired.content
      try {
        content = humanizeText(content)
      } catch { /* humanize 失败不阻断 */ }
      antiAiRepair = await repairBodyReactionCliches(workId, chapterId, content, signal, onProgress)
      content = antiAiRepair.content
      content = repairDeterministicStoryQuotes(content)
      createStoryCandidate('story_continuity_repair')
      if (shouldBlockStoryAntiAi(antiAiRepair.remaining, content.length)) {
        const error = `连续性修复候选仍有 ${antiAiRepair.remaining} 处泛白类模板反应`
        rejectStoryCandidate(error, { antiAiRemaining: antiAiRepair.remaining })
        return {
          success: false, content, wordCount: countWords(content), requiresEscalation: true,
          continuityRepairRounds,
          continuityBlockers: continuity.blockers,
          error
        }
      }
      antiAiRepairs += antiAiRepair.repairs
      antiAiRepairRounds += antiAiRepair.rounds
      continuityRepairRounds++
      wordCount = countWords(content)
      onContinuityEvent?.({
        type: 'repaired', candidateRound: continuityRepairRounds + 1,
        blockers: continuity.blockers, wordCount
      })
    }
  }

  // 小说目标循环的候选正文尚可能被质量/情绪门禁重写，禁止在此提前发布派生记忆。
  const memoryDeferred = workType === 'novel' && deferNarrativeMemory
  let memoryExtracted: BeatGenResult['memoryExtracted']
  let memoryError = ''
  if (!memoryDeferred) {
    try {
      memoryExtracted = await extractNarrativeMemoryAfterGeneration(workId, chapterId, content, signal, {
        requirePatternFingerprint: workType === 'novel',
        dropInvalidStateFactsAfterRetries: workType === 'novel'
      })
    } catch (e) {
      memoryError = e instanceof Error ? e.message : String(e)
      appLogger.warn('goal_routine', '叙事记忆提取失败（不阻断生成）', {
        workId, chapterId, error: memoryError
      })
    }
  }

  if (memoryError) {
    clearChapterNarrativeMemory(workId, chapterId)
    const memoryDisposition = derivedMemoryFailureDisposition(workType, Boolean(signal?.aborted))
    if (memoryDisposition === 'cancel') {
      rejectStoryCandidate('已取消', { memoryError })
      return { success: false, content, wordCount, error: '已取消', failureKind: 'cancelled' }
    }
    if (memoryDisposition === 'block') {
      return { success: false, content, wordCount, error: memoryError, failureKind: 'memory_extract' }
    }
    // 正文是主产物，叙事记忆是可由同一正文重算的派生索引。
    // 派生索引失败不得否决已经通过正文完整性与连续性门禁的候选。
    appLogger.warn('goal_routine', '正文候选保留，叙事记忆标记为待补偿', {
      workId, chapterId, error: memoryError
    })
  }

  if (workType === 'novel' && !memoryDeferred && !memoryError) {
    const fingerprint = storyStateDAO.listFingerprintsByWork(workId).find(row => row.chapter_id === chapterId)
    const systemic = assessNovelSystemics(workId, { requireFingerprints: false, includeProseScan: false })
    const blockers = systemic.issues.filter(issue =>
      issue.severity === 'blocker' && issue.chapterIds.includes(chapterId)
    )
    if (!fingerprint || blockers.length > 0) {
      clearChapterNarrativeMemory(workId, chapterId)
      return {
        success: false,
        content,
        wordCount,
        error: !fingerprint
          ? '章节模式指纹提取失败，禁止进入下一章'
          : `跨章状态/模式门禁未通过：${blockers.map(issue => issue.message).join('；')}`
      }
    }
  }

  const resourceGate = memoryDeferred
    ? { passed: true, blockers: [], warnings: ['候选记忆尚未提交，资源门禁推迟到最终原子提交'] }
    : memoryError
    ? { passed: true, blockers: [], warnings: ['叙事记忆待补偿，本轮不以派生快照缺失否决正文'] }
    : runResourceConstraintGate(workId, chapterId)
  if (!resourceGate.passed) {
    clearChapterNarrativeMemory(workId, chapterId)
    const error = `资源数值门禁未通过：${resourceGate.blockers.join('；')}`
    rejectStoryCandidate(error, { resourceGate })
    return {
      success: false,
      content,
      wordCount,
      memoryExtracted,
      error,
      failureKind: 'resource'
    }
  }
  if (!memoryDeferred && resourceGate.warnings.length > 0) {
    appLogger.warn('goal_routine', '资源数值门禁存在警告', {
      workId, chapterId, warnings: resourceGate.warnings
    })
  }

  const consistencyGate = runConsistencyGate(workId, chapterId, content, {
    // 小说候选记忆要等质量/情绪门禁通过后才原子提交；短故事记忆提取失败时也只标记待补偿。
    // 这两个阶段都不能用尚未发布的派生时间线反向否决正文候选。
    requireTimeline: !memoryDeferred && !memoryError
  })
  if (!consistencyGate.passed) {
    clearChapterNarrativeMemory(workId, chapterId)
    const error = `章节一致性门禁未通过：${consistencyGate.blockers.join('；')}`
    rejectStoryCandidate(error, { consistencyGate })
    return {
      success: false,
      content,
      wordCount,
      error,
      failureKind: 'consistency'
    }
  }

  if (workType === 'story') {
    if (candidateId != null) {
      storyHarnessDAO.markCandidate(candidateId, 'semantic_passed', {
        checks: { memoryExtracted, memoryPending: Boolean(memoryError), memoryError: memoryError || undefined, resourceGate, consistencyGate }
      })
    }
    if (candidateId == null || !storyHarnessDAO.acceptCandidate(candidateId)) {
      return { success: false, content, wordCount, error: '候选正文原子提交失败，正式正文未修改' }
    }
  } else {
    const persistFields = {
      content,
      word_count: wordCount,
      status: memoryDeferred ? 'draft' : 'completed',
      emotion_assessment_json: null
    }
    if (currentChapter?.content?.trim()) {
      volumeChapterDAO.updateChapterWithVersion(chapterId, persistFields)
    } else {
      volumeChapterDAO.updateChapter(chapterId, persistFields)
    }
  }

  return {
    success: true,
    content,
    wordCount,
    memoryExtracted,
    memoryPending: memoryDeferred || Boolean(memoryError),
    antiAiRepairs,
    antiAiRepairRounds,
    continuityRepairRounds
  }
}

/** 供质量修复等后处理复用完整候选门禁；禁止调用方直接覆盖短故事正式正文。 */
export async function commitStoryBodyCandidate(
  workId: number,
  chapterId: number,
  content: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<BeatGenResult> {
  return persistGeneratedBody(workId, chapterId, content, 'story', signal, onProgress)
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
  return persistGeneratedBody(
    workId,
    chapterId,
    response.content,
    workType,
    options.signal,
    undefined,
    undefined,
    options.deferNarrativeMemory ?? false
  )
}

export async function prepareNarrativeMemoryAfterGeneration(
  workId: number,
  chapterId: number,
  content: string,
  signal?: AbortSignal,
  options: {
    requirePatternFingerprint?: boolean
    dropInvalidStateFactsAfterRetries?: boolean
  } = {}
): Promise<PreparedNarrativeMemory> {
  if (signal?.aborted) throw new Error('已取消')

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

  // 只生成候选记忆，不修改任何正式账本。结构或证据不合格时只重试提取器。
  let extracted: ReturnType<typeof parseMemoryExtract> | undefined
  let extractError = ''
  const warnings: string[] = []
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (signal?.aborted) throw new Error('canceled')
    const memRes = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        prompt: content,
        systemPrompt: [
          memorySystemPrompt,
          extractError
            ? `【上一轮提取错误】${extractError}\n本轮必须修正 JSON 与 evidence；evidence 必须逐字摘自正文。`
            : ''
        ].filter(Boolean).join('\n\n'),
        workId,
        chapterId,
        step: 'memory_extract',
        temperature: 0,
        maxTokens: 4200,
        responseSchema: { name: 'narrative_memory_extract', schema: MEMORY_EXTRACT_RESPONSE_SCHEMA, strict: false },
        enrichWorkContext: false,
        enrichNarrativeMemory: false
      }),
      { stream: false, signal }
    )
    if (!memRes.success || !memRes.content?.trim()) {
      extractError = memRes.error || '模型未返回内容'
      continue
    }
    try {
      const candidate = parseMemoryExtract(memRes.content)
      const evidence = partitionStateFactsByEvidence(candidate, content)
      const attemptErrors = [...evidence.errors]
      if (options.requirePatternFingerprint && !candidate.chapter_pattern) {
        attemptErrors.push('chapter_pattern 缺失、字段为空或 payoffType 非法')
      }
      if (attemptErrors.length > 0 && attempt < 3) {
        throw new Error(attemptErrors.join('；'))
      }
      if (evidence.errors.length > 0) {
        if (!options.dropInvalidStateFactsAfterRetries) throw new Error(evidence.errors.join('；'))
        candidate.state_facts = evidence.valid
        warnings.push(`已丢弃 ${evidence.errors.length} 条无原文证据的状态事实：${evidence.errors.join('；')}`)
      }
      if (options.requirePatternFingerprint && !candidate.chapter_pattern) {
        const chapter = volumeChapterDAO.getChapter(chapterId)
        const fallback = deriveChapterPatternFromOutlineDiagnosis(chapter?.outline_diagnosis)
        if (!fallback) throw new Error('chapter_pattern 连续3轮无效，且章节合同无法生成确定性回退指纹')
        candidate.chapter_pattern = fallback
        warnings.push('模型未返回有效 chapter_pattern，已使用冻结章节合同生成确定性回退指纹')
      }
      extracted = candidate
      break
    } catch (error) {
      extractError = error instanceof Error ? error.message : String(error)
    }
  }
  if (!extracted) {
    throw new Error(`叙事记忆提取连续3轮未通过结构与证据门禁：${extractError}`)
  }
  if (warnings.length > 0) {
    appLogger.warn('goal_routine', '叙事记忆提取已执行弱模型确定性降级', {
      workId, chapterId, warnings
    })
  }
  let resolutions: ForeshadowingResolutionResult = { resolved: [], partial: [], pending: [] }
  const pending = foreshadowingDAO.listPending(workId)
  if (pending.length > 0) {
    if (signal?.aborted) throw new Error('已取消')
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
      resolutions = parseForeshadowingResolutions(resolveRes.content)
    }
  }

  return { sourceContent: content, extracted, resolutions, warnings }
}

/**
 * 把候选记忆、依赖记忆的同步门禁和章节完成状态放进同一事务。
 * validate 抛错或返回阻塞项时，清理/写入/状态变更会整体回滚。
 */
export function commitPreparedNarrativeMemory(
  workId: number,
  chapterId: number,
  prepared: PreparedNarrativeMemory,
  options: CommitPreparedNarrativeMemoryOptions = {}
): NonNullable<BeatGenResult['memoryExtracted']> {
  const commit = (): NonNullable<BeatGenResult['memoryExtracted']> => {
    const latest = volumeChapterDAO.getChapter(chapterId)
    if (!latest?.content?.trim() || latest.content !== prepared.sourceContent) {
      throw new Error('候选正文已变化，拒绝提交过期叙事记忆')
    }

    clearChapterMemoryBeforeExtract(workId, chapterId)
    const result = applyMemoryExtract(workId, chapterId, prepared.extracted)
    if (result.timelineEvents === 0) {
      throw new Error('候选叙事记忆缺少可提交的时间线事件')
    }
    const appliedResolutions = applyForeshadowingResolutions(workId, chapterId, prepared.resolutions)
    const blockers = options.validate?.().filter(Boolean) ?? []
    if (blockers.length > 0) {
      throw new Error(`候选叙事记忆门禁未通过：${blockers.join('；')}`)
    }
    if (options.markChapterCompleted) {
      volumeChapterDAO.updateChapter(chapterId, { status: 'completed' })
    }
    return {
      planted: result.planted,
      resolved: result.resolved,
      snapshots: result.snapshots,
      timelineEvents: result.timelineEvents,
      stateFacts: result.stateFacts,
      patternFingerprint: result.patternFingerprint,
      warnings: prepared.warnings,
      foreshadowingResolved: appliedResolutions.resolved,
      foreshadowingPartial: appliedResolutions.partial
    }
  }
  const database = getDatabase()
  const committed = database.inTransaction ? commit() : database.transaction(commit)()

  if (process.env.ELECTRON_RUN_AS_NODE !== '1') {
    appLogger.info('goal_routine', '叙事记忆已更新', {
      workId,
      chapterId,
      planted: committed.planted,
      snapshots: committed.snapshots,
      foreshadowingResolved: committed.foreshadowingResolved,
      foreshadowingPartial: committed.foreshadowingPartial,
      atomicCommit: true
    })
  }
  return committed
}

export async function extractNarrativeMemoryAfterGeneration(
  workId: number,
  chapterId: number,
  content: string,
  signal?: AbortSignal,
  options: {
    requirePatternFingerprint?: boolean
    dropInvalidStateFactsAfterRetries?: boolean
  } = {}
): Promise<NonNullable<BeatGenResult['memoryExtracted']>> {
  const prepared = await prepareNarrativeMemoryAfterGeneration(workId, chapterId, content, signal, options)
  return commitPreparedNarrativeMemory(workId, chapterId, prepared)
}
