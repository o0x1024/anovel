/**
 * 小说目标循环运行器 —— 复刻短故事目标循环到小说管理。
 *
 * 与短故事差异：
 * 1. 跳过短故事孵化器阶段（incubate_outline / incubator_gate / freeze_storyline），
 *    小说直接复用作品已有的分卷/章节结构或生成分卷大纲与章节情节。
 * 2. 正文生成按「章」而非「拍」走 novel 正文 prompt。
 * 3. 验收逻辑复用 story-goal-checker（维度通用）。
 *
 * 状态机：
 *   materialize_settings → 沉淀核心设定
 *   generate_character_cards → 生成主角人设卡片
 *   generate_volumes → 生成、诊断并冻结全书分卷大纲
 *   generate_beats ⇄ draft_body → 按卷交错生成章节情节与正文，卷末冻结后再开下一卷
 *   generate_title_hook → 首卷章节情节冻结后生成爆款书名与导语
 *   overall_self_check → 核心设定整体自检
 *   goal_check → 全书只读终审；未通过时冻结正文并暂停
 *   repair_plan / repair_execute → 仅在用户显式继续时修复全书尾部安全窗口
 */
import { BrowserWindow, type WebContents } from 'electron'
import { appLogger } from '../../logger/app-logger'
import { volumeChapterDAO, goalRoutineDAO, coreSettingDAO, storyStateDAO, workDAO } from '../../db'
import { modelService } from '../../model'
import { CHARACTER_CARDS_AI_PROMPT } from '../writing-techniques'
import { buildWorkContext } from '../work-context'
import {
  parseCharacterCardsFromAi,
  sanitizeCharacterCards,
  saveCharacterCards,
  validateCharacterCards
} from '../character-cards'
import { buildSettingsQualityInput, getSettingsQualityStatus, recordQualityCheck } from '../settings-quality'
import { STORY_OVERALL_CHECK_SYSTEM_PROMPT } from '../story-settings-quality'
import { loadWritingPlan } from '../writing-plan'
import { bodyWordCountBounds } from '../../../shared/body-word-target'
import {
  evaluateNovelQualityAcceptance,
  formatChapterExecutionContract,
  isBetterNovelBodyCandidate,
  isRecognizedNovelHardFail
} from '../../../shared/chapter-execution-contract'
import { goldenFingerStructuredPromptSection } from '../../../shared/golden-finger-types'
import { validateGoldenFinger } from '../golden-finger-validation'
import { extractJsonText } from '../parse-json-extract'
import {
  checkStoryGoal,
  DEFAULT_STORY_GOAL_CONFIG,
  type StoryGoalConfig,
  type GoalCheckResult
} from './story-goal-checker'
import {
  commitPreparedNarrativeMemory,
  generateBeatBody,
  prepareNarrativeMemoryAfterGeneration,
  reviseBeatBody,
  type BeatGenResult
} from './story-goal-doer'
import { incubateStoryline, runStorylineGate, freezeStoryline } from './story-goal-routine'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import { parseQualityAiScoreReport, type QualityAiMetricKey } from '../../../shared/quality-ai-score'
import { normalizeModelBodyOutput, stripDeterministicAiPatterns } from '../../../shared/normalize-body-text'
import { QUALITY_APPLY_FIXES_PROMPT } from '../chapter-quality'
import { STYLE_REWRITE_INSTRUCTION, countEmDashes, stripEmDashes } from '../anti-ai-rules'
import { runConsistencyGate } from '../consistency-gate'
import { refreshResourceConstraints, runResourceConstraintGate } from '../resource-ledger'
import { clearChapterNarrativeMemory } from '../memory-cleanup'
import {
  bindGoalLoopModelOpts,
  clearGoalLoopModelOpts,
  getGoalLoopModelOpts,
  withGoalLoopModelOptions
} from './story-goal-model'
import {
  generateNextNovelOutlineBatch,
  reconcileNovelWorkflowState,
  prepareNovelVolumePlan,
  NovelPipelineError,
  readNovelGoalState,
  resetNovelGoalStateFromVolumePlan,
  resolveNovelVolumeWorkflowCheckpoint,
  updateNovelGoalState,
} from './novel-outline-pipeline'
import { formatNovelScaleContract, validatePleasureEngineScale } from './novel-scale-contract'
import { ensureEmotionEngine } from './emotion-engine'
import { assessChapterEmotion, emotionRepairHint, isEmotionOutcomeComplete } from './emotion-gate'
import { parseCachedQualityAssessment, serializeQualityAssessment } from './chapter-assessment-cache'
import { retentionPackagingRules } from './reader-retention'
import { assessNovelVolume } from './novel-whole-evaluator'
import { assessNovelSystemics } from './novel-systemic-gate'
import { compileChapterExecutionContract } from '../chapter-execution-context'
import {
  MAX_AUTO_NOVEL_REPAIR_CHAPTERS,
  MAX_NOVEL_PHASE_FAILURES,
  MAX_NOVEL_REPAIR_STALLS,
  capNovelAutomaticRepairTargets,
  isNovelChapterReadyForTransition,
  isTerminalNovelRepairError,
  nextPhaseAfterNovelOutlineCheckpoint,
  novelPhaseFailureSignature,
  shouldPauseForReadOnlyNovelAudit
} from './novel-goal-policy'
import { requireGoalTurnLimit } from '../../../shared/goal-turn-limit'

import {
  NOVEL_GOAL_ROUTINE_PHASE_ORDER,
  isGoalRoutinePhase,
  type GoalRoutinePhase
} from '../../../shared/goal-routine-phases'

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
  action: 'draft_missing' | 'expand' | 'compress' | 'deai' | 'quality' | 'emotion' | 'goal_align' | 'systemic' | 'cluster' | 'volume'
  scope: 'sentence' | 'chapter' | 'cluster' | 'volume'
  targetChapterIds: number[]
  hint: string
  issueCodes?: string[]
  evidenceFingerprint?: string
}

interface TitleHookCandidate {
  title: string
  hook: string
  summary?: string
}

const NOVEL_SETTING_TYPES = ['protagonist', 'golden_finger', 'world_pressure', 'conflict_engine', 'pleasure_engine', 'supporting_cast', 'main_plotline'] as const

const NOVEL_SETTING_PROMPTS: Record<(typeof NOVEL_SETTING_TYPES)[number], string> = {
  protagonist: '你是顶级长篇小说人设设计师。基于作品背景输出 Markdown：## 身份与核心动机 / ## 长期成长弧线 / ## 关系网络 / ## 关键决策模式 / ## 与反派的对抗姿态。',
  golden_finger: [
    '你是顶级长篇小说特殊机制设计师。修仙境界、灵力、寿命压力、身份信息差、重生或穿越身份本身不是金手指；只有作品明确存在独立于世界常规能力的特殊机制时才设计。',
    '默认使用 narrative 模式，以阶段、触发条件、恢复条件、代价后果、场景边界和失效表现定义能力。只有用户明确要求系统面板、积分余额、属性点、数值经营或精确次数玩法时才能使用 numeric 模式。',
    'narrative 模式禁止生成百分比成功率、固定点数消耗、精确次数、固定冷却时长、进度条和每章资源余额。',
    '必须完整定义名称形态、核心规则、呈现形式、外人可见性、交互方式、有效能力、获取条件、来源性质、使用边界、失效场景、反噬、升级路径、信息差、副作用、禁用红线、暴露后果、番茄卖点和前三章爽点。',
    goldenFingerStructuredPromptSection()
  ].join('\n\n'),
  world_pressure: '你是顶级长篇小说世界观设计师。输出 Markdown：## 世界基础规则 / ## 权力/势力结构 / ## 关键地点与时代 / ## 规则如何约束主角行动 / ## 压迫升级路径。',
  conflict_engine: '你是顶级长篇小说冲突设计师。输出 Markdown：## 对立双方价值观冲突 / ## 不可调和点 / ## 三层赌注（个人/势力/世界） / ## 冲突升级机制 / ## 终局收束方式。',
  pleasure_engine: '你是顶级长篇小说节奏与爽点设计师。输出 Markdown：## 开篇钩子 / ## 前期小高潮 / ## 中期大反转 / ## 后期终极清算。必须明确每个爽点对应的卷/章位置。',
  supporting_cast: '你是顶级长篇小说配角设计师。输出 Markdown：## 核心反派与对手 / ## 盟友与导师 / ## 情感线对象 / ## 关系演变与情绪宣泄点。配角只写功能、冲突价值和记忆点。',
  main_plotline: '你是顶级长篇小说主线架构师。基于全部已有设定，设计故事从开局到终局的发展轨迹。输出 Markdown：## 故事起点 / ## 核心发展线（3-5个关键阶段，每阶段标注触发事件、主角选择、状态变化）/ ## 关键转折点（至少2次预判外转向）/ ## 伏笔与回收布局 / ## 高潮设计 / ## 故事终点 / ## 各阶段递进逻辑。递进必须因果闭环，禁止"突然"跳跃。总字数 800-1500 字。'
}

const activeLoops = new Map<number, AbortController>()
const MAX_SETTING_GENERATION_ROUNDS = 4
const MAX_CHAPTER_QUALITY_ROUNDS = 4
const MAX_CHAPTER_CONVERGENCE_ROUNDS = 3
const MAX_REPAIR_STALL_ROUNDS = 3

function shouldSkipGoldenFingerForNovel(goal: string, mainline: string): boolean {
  const text = `${goal}\n${mainline}`.trim()
  if (!text) return false

  const explicitMechanism = /系统|属性面板|积分兑换|签到|抽奖|属性点|熟练度面板|随身空间|可调用空间|独立异能|超能力|金手指|外挂/.test(text)
  return !explicitMechanism
}

export function isNovelGoalLoopRunning(workId: number): boolean {
  return activeLoops.has(workId)
}

export function cancelNovelGoalLoop(workId: number): boolean {
  const controller = activeLoops.get(workId)
  if (!controller) return false
  controller.abort()
  return true
}

export function cancelAllNovelGoalLoops(): void {
  for (const [workId, controller] of activeLoops) {
    controller.abort()
    try {
      goalRoutineDAO.setStatus(workId, 'paused')
    } catch { /* ignore */ }
  }
  activeLoops.clear()
}

function broadcastProgress(channel: string, payload: unknown): void {
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

function countWords(s: string): number {
  return s.replace(/[\s\p{Z}]/gu, '').length
}

function repairReasonSignature(reasons: string[]): string {
  return reasons
    .map(reason => reason.replace(/\d+(?:\.\d+)?/g, '#').replace(/\s+/g, ' ').trim())
    .sort()
    .join('|')
    .slice(0, 1000)
}

function repairEvidenceSnapshot(check: GoalCheckResult): { fingerprint: string; count: number } {
  if ((check.systemicIssues ?? []).length > 0) {
    return {
      fingerprint: check.systemicIssues
        .map(issue => `${issue.code}:${issue.chapterIds.join(',')}:${issue.evidence.join('|')}`)
        .sort()
        .join('\n')
        .slice(0, 12000),
      count: check.systemicIssues.length
    }
  }
  const failingChapters = check.chapterDiagnostics
    .filter(item => item.qualityHardFail || item.gateBlockers > 0 || item.antiAiViolations > 0 || item.emotionPassed === false)
    .map(item => `${item.chapterId}:${item.qualityScore}:${item.gateBlockers}:${item.antiAiViolations}:${item.emotionScore}`)
  return {
    fingerprint: [check.reasons.join('\n'), ...failingChapters].join('\n').slice(0, 12000),
    count: failingChapters.length || check.reasons.length
  }
}

async function materializeNovelSettings(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<number> {
  assertNotAborted(signal)
  const existing = coreSettingDAO.listByWork(workId)
  const mainline = coreSettingDAO.getByType(workId, 'idea')?.content?.trim()
    || buildWorkContext(workId, { includeVolumes: true, includeCoreSettings: true }).text.slice(0, 4000)
  const shouldSkipGoldenFinger = shouldSkipGoldenFingerForNovel(goal, mainline)
  const targetTypes = shouldSkipGoldenFinger
    ? NOVEL_SETTING_TYPES.filter(t => t !== 'golden_finger')
    : [...NOVEL_SETTING_TYPES]
  const missing = targetTypes.filter(t => !existing.some(e => e.type === t && e.content?.trim()))
  if (!validatePleasureEngineScale(workId).valid && !missing.includes('pleasure_engine')) {
    missing.push('pleasure_engine')
  }
  if (targetTypes.includes('golden_finger') && !validateGoldenFinger(workId).valid && !missing.includes('golden_finger')) {
    missing.push('golden_finger')
  }

  if (shouldSkipGoldenFinger) {
    onProgress?.('检测为无特殊机制题材，跳过「金手指系统」生成')
  }

  if (missing.length === 0) {
    onProgress?.('核心设定已存在，跳过')
    return 0
  }

  let count = 0
  for (const type of missing) {
    for (let attempt = 1; attempt <= MAX_SETTING_GENERATION_ROUNDS; attempt++) {
      assertNotAborted(signal)
      onProgress?.(`正在生成核心设定「${type}」(${count + 1}/${missing.length}，第 ${attempt} 轮)`)
      const existingText = targetTypes
        .filter(t => t !== type)
        .map(t => coreSettingDAO.getByType(workId, t)?.content?.trim() ? `## ${t}\n${coreSettingDAO.getByType(workId, t)?.content?.trim()}` : '')
        .filter(Boolean)
        .join('\n\n')
      const res = await modelService.chat(
        withGoalLoopModelOptions(workId, {
          workId,
          step: `settings_${type}`,
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          systemPrompt: [
            NOVEL_SETTING_PROMPTS[type],
            type === 'pleasure_engine'
              ? '爽点机制必须按全书阶段规划，并明确写出目标末章的终极清算；不得自行虚构更短的卷数或提前完结。'
              : ''
          ].filter(Boolean).join('\n\n'),
          prompt: [
            formatNovelScaleContract(workId),
            goal.trim() ? `【用户创作目标】\n${goal.trim()}` : '',
            `【长篇主线】\n${mainline}`,
            existingText ? `【已生成设定】\n${existingText}` : ''
          ].filter(Boolean).join('\n\n')
        }),
        { stream: false, signal }
      )
      if (!res.success || !res.content?.trim()) {
        onProgress?.(`核心设定「${type}」第 ${attempt} 轮未返回有效内容${attempt < MAX_SETTING_GENERATION_ROUNDS ? '，正在重试' : ''}`)
        continue
      }
      if (type === 'pleasure_engine') {
        const scaleGate = validatePleasureEngineScale(workId, res.content.trim())
        if (!scaleGate.valid) {
          onProgress?.(`爽点机制规模门禁未通过：${scaleGate.reason}${attempt < MAX_SETTING_GENERATION_ROUNDS ? '，正在重新生成' : ''}`)
          continue
        }
      }
      coreSettingDAO.upsert(workId, type, res.content.trim())
      count++
      onProgress?.(`已回填核心设定「${type}」`)
      break
    }
  }
  const unresolved = targetTypes.filter(type => !coreSettingDAO.getByType(workId, type)?.content?.trim())
  if (unresolved.length > 0) {
    throw new Error(`核心设定生成不完整：${unresolved.join('、')}`)
  }
  const pleasureScaleGate = validatePleasureEngineScale(workId)
  if (!pleasureScaleGate.valid) {
    throw new NovelPipelineError('CONTRACT_INVALID', `爽点机制规模门禁未通过：${pleasureScaleGate.reason}`)
  }
  if (targetTypes.includes('golden_finger')) {
    const goldenFinger = validateGoldenFinger(workId)
    if (!goldenFinger.valid) {
      throw new NovelPipelineError('PREREQUISITE_MISSING', `金手指设定不完整：${goldenFinger.issues.join('、')}`)
    }
  }
  return count
}

async function generateNovelCharacterCards(workId: number, signal?: AbortSignal): Promise<number> {
  assertNotAborted(signal)
  const ctx = buildWorkContext(workId, { includeVolumes: true, includeCoreSettings: true })
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'character_cards_generate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      systemPrompt: CHARACTER_CARDS_AI_PROMPT,
      prompt: `请基于以下作品上下文，生成主角人设卡片。\n\n${ctx.text.slice(0, 8000)}`
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) throw new Error(`主角人设卡生成失败：${res.error || '模型未返回内容'}`)
  const parsed = parseCharacterCardsFromAi(res.content.trim())
  const sanitized = sanitizeCharacterCards(parsed)
  if (!validateCharacterCards(sanitized.cards)) throw new Error('主角人设卡结构校验失败')
  saveCharacterCards(workId, sanitized.cards)
  return sanitized.cards.length
}

async function generateNovelTitleHook(workId: number, goal: string, signal?: AbortSignal): Promise<{
  preferred: TitleHookCandidate
  preferredIndex: number
  candidates: TitleHookCandidate[]
}> {
  assertNotAborted(signal)
  const ctx = buildWorkContext(workId, { includeVolumes: true, includeCoreSettings: true })
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_title_hook',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      systemPrompt: [
        '你是长篇小说书名与导语策划。根据已冻结的分卷和章节结构生成3套差异明显的候选，并给出推荐序号。只输出 JSON。',
        '格式：{"preferredIndex":0,"candidates":[{"title":"...","hook":"...","summary":"..."}]}',
        'title 要爆款吸睛；hook 为 80-150 字长篇导语，必须同时承诺开篇核心冲突、主角差异和前三章首次兑现方向，但不能提前剧透终局；summary 是 100 字以内核心卖点；三套候选不得只是同义替换。',
        retentionPackagingRules('novel')
      ].join('\n'),
      prompt: [
        `【用户创作目标】\n${goal.trim() || '请策划一部长篇小说。'}`,
        `【作品上下文】\n${ctx.text.slice(0, 6000)}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) throw new Error(`书名导语生成失败：${res.error || '模型未返回内容'}`)
  try {
    const json = extractJsonText(res.content.trim()) ?? res.content.trim()
    const parsed = JSON.parse(json) as { preferredIndex?: unknown; candidates?: unknown }
    if (!Array.isArray(parsed.candidates) || parsed.candidates.length !== 3) throw new Error('必须返回3套 candidates')
    const candidates = parsed.candidates.map((value, index) => {
      if (!value || typeof value !== 'object') throw new Error(`第${index + 1}套候选不是对象`)
      const row = value as Record<string, unknown>
      const title = String(row.title ?? '').trim()
      const hook = String(row.hook ?? '').trim()
      if (!title || !hook) throw new Error(`第${index + 1}套候选缺少 title 或 hook`)
      return { title, hook, summary: String(row.summary ?? '').trim() || undefined }
    })
    const preferredIndex = Number(parsed.preferredIndex)
    if (!Number.isInteger(preferredIndex) || preferredIndex < 0 || preferredIndex >= candidates.length) {
      throw new Error('preferredIndex 非法')
    }
    return { preferred: candidates[preferredIndex], preferredIndex, candidates }
  } catch (error) {
    throw new Error(`书名导语解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runNovelOverallSelfCheck(workId: number, signal?: AbortSignal): Promise<string> {
  assertNotAborted(signal)
  const prompt = buildSettingsQualityInput(workId)
  if (!prompt.replace(/（尚未设定）|（无活跃锚点）/g, '').trim()) {
    return '设定内容为空，跳过自检'
  }
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'settings_overall_check',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      systemPrompt: STORY_OVERALL_CHECK_SYSTEM_PROMPT,
      prompt
    }),
    { stream: false, signal }
  )
  if (!res.success || !res.content?.trim()) return '自检未返回结果'
  recordQualityCheck(workId, {
    overall: { report: res.content, checkedAt: new Date().toISOString() }
  })
  return res.content.trim()
}

async function repairNovelSettingsFromOverallCheck(
  workId: number,
  report: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<number> {
  const mainline = coreSettingDAO.getByType(workId, 'main_plotline')?.content?.trim()
    || coreSettingDAO.getByType(workId, 'idea')?.content?.trim()
    || ''
  let revised = 0
  for (const type of NOVEL_SETTING_TYPES) {
    assertNotAborted(signal)
    const current = coreSettingDAO.getByType(workId, type)?.content?.trim() ?? ''
    const otherSettings = NOVEL_SETTING_TYPES
      .filter(other => other !== type)
      .map(other => {
        const content = coreSettingDAO.getByType(workId, other)?.content?.trim()
        return content ? `## ${other}\n${content}` : ''
      })
      .filter(Boolean)
      .join('\n\n')
    onProgress?.(`正在根据整体自检修订「${type}」`)
    const response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: `settings_${type}_revise`,
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        systemPrompt: [
          NOVEL_SETTING_PROMPTS[type],
          '这是长篇设定门禁修订。保留已自洽内容，只修复报告指出的阻塞问题；输出完整修订后的 Markdown，不要解释。'
        ].join('\n\n'),
        prompt: [
          `【长篇主线】\n${mainline}`,
          `【当前 ${type}】\n${current || '（空）'}`,
          otherSettings ? `【其他已确定设定】\n${otherSettings}` : '',
          `【整体自检报告】\n${report}`
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!response.success || !response.content?.trim()) {
      throw new Error(response.error || `整体自检修订 ${type} 失败`)
    }
    if (response.content.trim() !== current) {
      coreSettingDAO.upsert(workId, type, response.content.trim())
      revised++
    }
  }
  return revised
}

interface PendingDraftChapter {
  id: number
  title: string
  needsGeneration: boolean
}

function nextPendingDraftChapter(workId: number, config: StoryGoalConfig): PendingDraftChapter | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const fingerprintChapterIds = new Set(storyStateDAO.listFingerprintsByWork(workId).map(row => row.chapter_id))
  for (const ch of chapters) {
    const content = ch.content?.trim() ?? ''
    if (!content) return { id: ch.id, title: ch.title, needsGeneration: true }

    const cachedQuality = parseCachedQualityAssessment(ch.quality_assessment_json, content)
    const qualityReady = !config.diagnoseBodyAfterGeneration || config.qualityMin <= 0 || !!cachedQuality
    const emotionReady = isEmotionOutcomeComplete(ch.id, content, ch.emotion_assessment_json)
    const memoryReady = fingerprintChapterIds.has(ch.id)
    if (!isNovelChapterReadyForTransition({
      qualityReady,
      emotionReady,
      patternFingerprintReady: memoryReady
    })) {
      return { id: ch.id, title: ch.title, needsGeneration: false }
    }
  }
  return null
}

function phaseAfterCurrentDraftWindow(workId: number): Phase {
  const expected = loadWritingPlan(workId).targetChapters
  return expected > 0 && volumeChapterDAO.listChaptersByWork(workId).length < expected
    ? 'generate_beats'
    : 'goal_check'
}

async function diagnoseAndFixUntilPass(
  workId: number,
  chapterId: number,
  qualityMin: number,
  qualityMetricMins: Record<QualityAiMetricKey, number>,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ passed: boolean; finalScore: number; rounds: number; failedMetrics: string[] }> {
  let rounds = 0
  let bestScore = -1
  const failedMetrics: string[] = []
  const contract = compileChapterExecutionContract(workId, chapterId)
  if (!contract || contract.errors.length > 0) {
    throw new Error(`章节执行合同无效：${contract?.errors.join('；') || '章节不存在'}`)
  }
  let bestCandidate: {
    content: string
    wordCount: number
    scoreTotal: number
    hardFail: boolean
    blockingFailures: string[]
    advisoryFailures: string[]
    report?: string
  } | null = null

  while (rounds < MAX_CHAPTER_QUALITY_ROUNDS) {
    assertNotAborted(signal)
    rounds++
    const ch = volumeChapterDAO.getChapter(chapterId)
    if (!ch?.content?.trim()) throw new Error('待诊断正文不存在')

    onProgress?.(`正在诊断「${ch.title}」第 ${rounds} 轮`)
    const res = await diagnoseChapterQualityAi(workId, chapterId, ch.content, { thinkingEnabled: getGoalLoopModelOpts(workId).thinkingEnabled })
    if (!res.success || typeof res.scoreTotal !== 'number') {
      failedMetrics.push('诊断未返回分数')
      onProgress?.(`「${ch.title}」第 ${rounds} 轮诊断未返回有效分数，正在重试`)
      continue
    }

    const breakdown = res.report ? parseQualityAiScoreReport(res.report) : null
    const recognizedHardFail = isRecognizedNovelHardFail(
      Boolean(res.hardFail),
      breakdown?.failedRules ?? []
    )
    const acceptance = breakdown
      ? evaluateNovelQualityAcceptance({
          scoreTotal: res.scoreTotal,
          hardFail: recognizedHardFail,
          items: breakdown.items,
          actualWordCount: countWords(ch.content),
          qualityMin,
          qualityMetricMins,
          contract
        })
      : {
          passed: false,
          acceptedWithinTolerance: false,
          blockingFailures: ['诊断报告缺少结构化单项分'],
          advisoryFailures: [] as string[],
          acceptanceFloor: Math.max(65, qualityMin - 5)
        }
    failedMetrics.splice(0, failedMetrics.length, ...acceptance.blockingFailures)

    const candidateRank = {
      hardFail: recognizedHardFail,
      blockingFailures: acceptance.blockingFailures.length,
      scoreTotal: res.scoreTotal,
      wordCount: countWords(ch.content),
      targetWords: contract.wordTarget
    }
    const bestRank = bestCandidate
      ? {
          hardFail: bestCandidate.hardFail,
          blockingFailures: bestCandidate.blockingFailures.length,
          scoreTotal: bestCandidate.scoreTotal,
          wordCount: bestCandidate.wordCount,
          targetWords: contract.wordTarget
        }
      : null
    if (isBetterNovelBodyCandidate(candidateRank, bestRank)) {
      bestCandidate = {
        content: ch.content,
        wordCount: candidateRank.wordCount,
        scoreTotal: res.scoreTotal,
        hardFail: recognizedHardFail,
        blockingFailures: [...acceptance.blockingFailures],
        advisoryFailures: [...acceptance.advisoryFailures],
        report: res.report
      }
    }
    bestScore = Math.max(bestScore, res.scoreTotal)

    if (acceptance.passed) {
      volumeChapterDAO.updateChapter(chapterId, {
        quality_assessment_json: serializeQualityAssessment({
          content: ch.content,
          scoreTotal: res.scoreTotal,
          hardFail: false,
          report: res.report
        })
      })
      if (acceptance.acceptedWithinTolerance) {
        onProgress?.(`「${ch.title}」承重门禁通过，质量 ${res.scoreTotal}/${qualityMin}，按弱模型软容差验收`)
      }
      return { passed: true, finalScore: res.scoreTotal, rounds, failedMetrics }
    }

    let repairSource = ch.content
    let repairReport = res.report
    let repairBlocking = acceptance.blockingFailures
    let repairAdvisory = acceptance.advisoryFailures
    if (bestCandidate && bestCandidate.content !== ch.content) {
      volumeChapterDAO.updateChapterWithVersion(chapterId, {
        content: bestCandidate.content,
        word_count: bestCandidate.wordCount,
        emotion_assessment_json: null,
        quality_assessment_json: null
      })
      repairSource = bestCandidate.content
      repairReport = bestCandidate.report
      repairBlocking = bestCandidate.blockingFailures
      repairAdvisory = bestCandidate.advisoryFailures
      onProgress?.(`「${ch.title}」本轮评分退化，已回滚到最佳候选 ${bestCandidate.scoreTotal} 分后继续定点修复`)
    }

    onProgress?.(`正在修复「${ch.title}」第 ${rounds} 轮`)
    const fixPrompt = [
      formatChapterExecutionContract(contract),
      `【原文】\n${repairSource}`,
      `【本轮只修复这些阻塞项】\n${repairBlocking.join('；')}`,
      repairAdvisory.length ? `【软质量参考，不得牺牲章节合同强行追分】\n${repairAdvisory.slice(0, 4).join('；')}` : '',
      repairReport ? `【完整诊断报告】\n${repairReport}` : '',
      QUALITY_APPLY_FIXES_PROMPT
    ].filter(Boolean).join('\n\n')

    const fixRes = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_diagnose_fix',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0.3,
        maxTokens: Math.max(6000, Math.min(12000, contract.wordTarget * 2)),
        systemPrompt: [
          '你是资深网文定向编辑。只修复 user 消息中【本轮只修复这些阻塞项】，直接输出修改后的正文全文，不要解释。',
          '章节执行合同优先；软质量参考不得驱使你增加无效对话、越过结尾、改变事实或删减已通过节点。',
          '修改后须保持或改善其他已通过指标；无法同时改善时保留原文对应部分。',
          STYLE_REWRITE_INSTRUCTION
        ].join('\n'),
        prompt: fixPrompt
      }),
      { stream: false, signal }
    )

    if (fixRes.success && fixRes.content?.trim()) {
      let fixed = normalizeModelBodyOutput(fixRes.content.trim(), 'body_generation')
      fixed = stripDeterministicAiPatterns(fixed)
      volumeChapterDAO.updateChapterWithVersion(chapterId, {
        content: fixed,
        word_count: countWords(fixed),
        emotion_assessment_json: null
      })
    } else {
      failedMetrics.push('修复未返回有效正文')
      onProgress?.(`「${ch.title}」第 ${rounds} 轮修复未返回有效正文，正在重新诊断`)
    }
  }
  if (bestCandidate) {
    const latest = volumeChapterDAO.getChapter(chapterId)
    if (latest?.content !== bestCandidate.content) {
      volumeChapterDAO.updateChapterWithVersion(chapterId, {
        content: bestCandidate.content,
        word_count: bestCandidate.wordCount,
        emotion_assessment_json: null,
        quality_assessment_json: null
      })
    }
    failedMetrics.splice(0, failedMetrics.length, ...bestCandidate.blockingFailures)
    bestScore = bestCandidate.scoreTotal
  }
  onProgress?.(`「${volumeChapterDAO.getChapter(chapterId)?.title ?? chapterId}」连续 ${MAX_CHAPTER_QUALITY_ROUNDS} 轮未通过质量门禁`)
  return { passed: false, finalScore: bestScore, rounds, failedMetrics: [...new Set(failedMetrics)] }
}

function cleanupEmDashesAfterPassedGate(
  workId: number,
  mode: 'comma' | 'remove' = 'comma',
  onlyChapterIds?: number[]
): { chapters: number; replaced: number } {
  let chapters = 0
  let replaced = 0
  const allowed = onlyChapterIds ? new Set(onlyChapterIds) : null
  const chaptersList = volumeChapterDAO.listChaptersByWork(workId)
  for (const ch of chaptersList) {
    if (allowed && !allowed.has(ch.id)) continue
    if (!ch.content?.trim()) continue
    const before = countEmDashes(ch.content)
    if (before === 0) continue
    const cleaned = mode === 'remove' ? stripEmDashes(ch.content) : ch.content.replace(/——/g, '，')
    const after = countEmDashes(cleaned)
    if (after !== before) {
      volumeChapterDAO.updateChapterWithVersion(ch.id, {
        content: cleaned,
        word_count: countWords(cleaned),
        emotion_assessment_json: null
      })
      chapters++
      replaced += before - after
    }
  }
  return { chapters, replaced }
}

export async function runChapterAcceptanceGate(
  workId: number,
  chapterId: number,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ passed: boolean; qualityScore: number; rounds: number; failedMetrics: string[] }> {
  let totalQualityRounds = 0
  let qualityScore = -1
  const failures: string[] = []

  for (let convergenceRound = 1; convergenceRound <= MAX_CHAPTER_CONVERGENCE_ROUNDS; convergenceRound++) {
    if (config.diagnoseBodyAfterGeneration && config.qualityMin > 0) {
      const quality = await diagnoseAndFixUntilPass(
        workId,
        chapterId,
        config.qualityMin,
        config.qualityMetricMins,
        signal,
        onProgress
      )
      totalQualityRounds += quality.rounds
      qualityScore = quality.finalScore
      failures.push(...quality.failedMetrics)
      if (!quality.passed) {
        return { passed: false, qualityScore, rounds: totalQualityRounds, failedMetrics: [...new Set(failures)] }
      }
    }

    const cleaned = cleanupEmDashesAfterPassedGate(workId, 'comma', [chapterId])
    if (cleaned.replaced > 0) {
      onProgress?.(`「${volumeChapterDAO.getChapter(chapterId)?.title ?? chapterId}」清理破折号后正在重新执行质量门禁`)
      failures.push(`清理破折号 ${cleaned.replaced} 处后需复验`)
      continue
    }
    const chapter = volumeChapterDAO.getChapter(chapterId)
    const assessment = await assessChapterEmotion(workId, chapterId, chapter?.content ?? '', signal, true)
    if (assessment.passed) {
      onProgress?.(`「${chapter?.title ?? chapterId}」质量与情绪门禁均已通过`)
      return { passed: true, qualityScore, rounds: totalQualityRounds, failedMetrics: [] }
    }

    failures.push(`情绪门禁 ${assessment.score}分/${assessment.failure_layer}层`)
    if (convergenceRound === MAX_CHAPTER_CONVERGENCE_ROUNDS) break
    onProgress?.(
      `「${chapter?.title ?? chapterId}」情绪门禁未通过（${assessment.score}分），正在修订并重新执行质量门禁`
    )
    const revised = await reviseBeatBody(workId, chapterId, {
      signal,
      workType: 'novel',
      deferNarrativeMemory: true,
      instruction: emotionRepairHint(assessment)
    })
    if (!revised.success) {
      failures.push(revised.error || '情绪定向修订失败')
      break
    }
  }

  return {
    passed: false,
    qualityScore,
    rounds: totalQualityRounds,
    failedMetrics: [...new Set(failures)]
  }
}

export async function finalizeNovelChapterMemory(
  workId: number,
  chapterId: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<NonNullable<BeatGenResult['memoryExtracted']>> {
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!chapter?.content?.trim()) throw new Error('最终正文不存在，无法提交叙事记忆')

  onProgress?.(`正在从「${chapter.title}」已通过质量与情绪门禁的正文提取候选记忆`)
  try {
    const prepared = await prepareNarrativeMemoryAfterGeneration(
      workId,
      chapterId,
      chapter.content,
      signal,
      { requirePatternFingerprint: true, dropInvalidStateFactsAfterRetries: true }
    )
    const committed = commitPreparedNarrativeMemory(workId, chapterId, prepared, {
      markChapterCompleted: true,
      validate: () => novelMemoryCommitBlockers(workId, chapterId)
    })
    onProgress?.(`「${chapter.title}」候选记忆及依赖门禁已原子提交`)
    return committed
  } catch (error) {
    // 候选正文仍保留，但任何不完整或过期的派生记忆都不得对后续章节可见。
    clearChapterNarrativeMemory(workId, chapterId)
    volumeChapterDAO.updateChapter(chapterId, {
      status: 'draft',
      emotion_assessment_json: null,
      quality_assessment_json: null
    })
    throw error
  }
}

export function novelMemoryCommitBlockers(workId: number, chapterId: number): string[] {
  const latest = volumeChapterDAO.getChapter(chapterId)
  const consistency = runConsistencyGate(workId, chapterId, latest?.content ?? '')
  const resource = runResourceConstraintGate(workId, chapterId)
  const fingerprintReady = storyStateDAO.listFingerprintsByWork(workId)
    .some(row => row.chapter_id === chapterId)
  const systemic = assessNovelSystemics(workId, {
    requireFingerprints: false,
    includeProseScan: false
  }).issues.filter(issue => issue.severity === 'blocker' && issue.chapterIds.includes(chapterId))
  return [
    ...consistency.blockers.map(item => `一致性：${item}`),
    ...resource.blockers.map(item => `资源约束：${item}`),
    ...(!fingerprintReady ? ['模式指纹：章节模式指纹缺失'] : []),
    ...systemic.map(issue => `跨章状态/模式：${issue.message}`)
  ]
}

function buildNovelRepairPlan(workId: number, check: GoalCheckResult, config: StoryGoalConfig): RepairPlan {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const emptyChapters = chapters.filter(c => !c.content?.trim())
  if (emptyChapters.length > 0) {
    return { action: 'draft_missing', scope: 'chapter', targetChapterIds: emptyChapters.map(c => c.id), hint: '先生成缺失章节正文' }
  }

  const systemicBlockers = (check.systemicIssues ?? []).filter(issue => issue.severity === 'blocker')
  if (systemicBlockers.length > 0) {
    const priority = [...systemicBlockers].sort((a, b) => {
      const weight = { volume: 4, cluster: 3, chapter: 2, sentence: 1 }
      return weight[b.scope] - weight[a.scope]
    })[0]
    const ids = [...new Set(systemicBlockers
      .filter(issue => issue.scope === priority.scope)
      .flatMap(issue => issue.chapterIds))]
    const scope = priority.scope === 'sentence' ? 'sentence' : priority.scope
    return {
      action: scope === 'volume' ? 'volume' : scope === 'cluster' ? 'cluster' : 'systemic',
      scope,
      targetChapterIds: ids.slice(0, MAX_AUTO_NOVEL_REPAIR_CHAPTERS),
      hint: systemicBlockers.map(issue => `${issue.code}：${issue.message}；${issue.recommendedAction}`).join('\n'),
      issueCodes: [...new Set(systemicBlockers.map(issue => issue.code))],
      evidenceFingerprint: systemicBlockers.map(issue => `${issue.code}:${issue.chapterIds.join(',')}:${issue.evidence.join('|')}`).sort().join('\n')
    }
  }

  const lowQuality = check.chapterDiagnostics.filter(d => d.qualityScore >= 0 && (d.qualityHardFail || d.qualityScore < config.qualityMin))
  if (lowQuality.length > 0) {
    return { action: 'quality', scope: 'chapter', targetChapterIds: lowQuality.slice(0, 3).map(d => d.chapterId), hint: '提升低质量章节' }
  }

  const emotionFailures = check.chapterDiagnostics.filter(d => d.emotionScore >= 0 && !d.emotionPassed)
  if (emotionFailures.length > 0) {
    return {
      action: 'emotion',
      scope: 'chapter',
      targetChapterIds: emotionFailures.slice(0, 3).map(d => d.chapterId),
      hint: '按情绪盲读报告定向修复失败章节'
    }
  }

  const gateFailures = check.chapterDiagnostics.filter(d => d.gateBlockers > 0 || d.antiAiViolations > 0)
  if (gateFailures.length > 0) {
    return { action: 'deai', scope: 'sentence', targetChapterIds: gateFailures.slice(0, 6).map(d => d.chapterId), hint: '修复一致性门禁与去AI问题' }
  }

  const perChapterTarget = loadWritingPlan(workId).wordsPerChapter || 4000
  const bounds = bodyWordCountBounds(perChapterTarget)
  const shortChapters = chapters.filter(chapter => (chapter.word_count ?? 0) < bounds.min)
  if (shortChapters.length > 0 || check.totalWords < check.targetWords * 0.9) {
    const targets = (shortChapters.length > 0 ? shortChapters : chapters).slice(0, 3)
    return {
      action: 'expand',
      scope: 'chapter',
      targetChapterIds: targets.map(chapter => chapter.id),
      hint: `扩写至每章 ${bounds.min}-${bounds.max} 字，增加有效冲突和因果细节，禁止注水`
    }
  }

  const longChapters = chapters.filter(chapter => (chapter.word_count ?? 0) > bounds.max)
  if (longChapters.length > 0 || check.totalWords > check.targetWords * 1.1) {
    const targets = longChapters.length > 0 ? longChapters.slice(0, 3) : chapters.slice(-3)
    return {
      action: 'compress',
      scope: 'chapter',
      targetChapterIds: targets.map(chapter => chapter.id),
      hint: `压缩至每章 ${bounds.min}-${bounds.max} 字，只删除重复解释和无推进段落`
    }
  }

  const systemicWarnings = (check.systemicIssues ?? []).filter(issue => issue.severity === 'warning')
  if (systemicWarnings.length > 0) {
    const sentenceWarnings = systemicWarnings.filter(issue => issue.scope === 'sentence')
    const selected = sentenceWarnings.length > 0 ? sentenceWarnings : systemicWarnings
    return {
      action: sentenceWarnings.length > 0 ? 'deai' : 'cluster',
      scope: sentenceWarnings.length > 0 ? 'sentence' : 'cluster',
      targetChapterIds: [...new Set(selected.flatMap(issue => issue.chapterIds))].slice(0, 8),
      hint: selected.map(issue => `${issue.code}：${issue.message}；证据：${issue.evidence.join('；')}`).join('\n'),
      issueCodes: selected.map(issue => issue.code),
      evidenceFingerprint: selected.map(issue => `${issue.code}:${issue.chapterIds.join(',')}`).join('|')
    }
  }

  const weakIds = check.weakChapterTitles
    .map(title => chapters.find(chapter => chapter.title === title
      || chapter.title.includes(title)
      || title.includes(chapter.title))?.id)
    .filter((id): id is number => id != null)
  const targetChapterIds = weakIds.length > 0
    ? weakIds.slice(0, 3)
    : chapters
      .filter((_, index) => index === 0 || index === Math.floor(chapters.length / 2) || index === chapters.length - 1)
      .map(chapter => chapter.id)
  return {
    action: 'goal_align',
    scope: 'chapter',
    targetChapterIds,
    hint: `修复整书目标与结构问题：${check.storyIssues.slice(0, 3).join('；') || check.goalMatchReason || check.overallStoryReason}`
  }
}

async function reviseNovelStructuralCluster(
  workId: number,
  plan: RepairPlan,
  goal: string,
  signal?: AbortSignal
): Promise<{ outlines: number; invalidatedBodies: number }> {
  const allChapters = volumeChapterDAO.listChaptersByWork(workId)
  const targets = allChapters.filter(chapter => plan.targetChapterIds.includes(chapter.id))
  if (targets.length === 0) throw new Error('结构修复没有可匹配的目标章节')
  const targetVolumes = [...new Set(targets.map(chapter => chapter.volume_id))]
  const contextIds = new Set<number>()
  for (const target of targets) {
    const index = allChapters.findIndex(chapter => chapter.id === target.id)
    for (let offset = -1; offset <= 1; offset++) {
      const chapter = allChapters[index + offset]
      if (chapter) contextIds.add(chapter.id)
    }
  }
  const context = allChapters.filter(chapter => contextIds.has(chapter.id))
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'story_repair_blueprint',
      enrichWorkContext: true,
      enrichNarrativeMemory: false,
      temperature: 0.2,
      maxTokens: 8000,
      systemPrompt: [
        '你是长篇小说结构修复编辑。只输出合法JSON，不要markdown或解释。',
        '只修改target=true的章节；id和title必须原样返回。不得修改章节数量、人物既有不可逆事实或资源预算。',
        '这是章节簇/整卷结构修复，必须从因果、解法、对手学习、阶段兑现、关系变化和卷级闭环上消除给定证据，不能只换措辞。',
        '每项返回完整outline、next_hook和pattern_contract；payoff_type只允许debt/partial/major/aftertaste，tension_level为1-10。',
        '格式：{"chapters":[{"id":1,"title":"原题","outline":"完整新大纲","next_hook":"新钩子","tension_level":7,"payoff_type":"partial","pattern_contract":{"conflict_type":"","protagonist_method":"","antagonist_tactic":"","anticipated_opponent_adjustment":"","location_type":"","hook_type":"","cost_type":"","relationship_delta":"","volume_objective_delta":""}}]}'
      ].join('\n'),
      prompt: [
        `【用户目标】\n${goal.trim() || '完成一部长篇小说'}`,
        `【结构问题与确定性证据】\n${plan.hint}`,
        `【目标与相邻章节】\n${JSON.stringify(context.map(chapter => ({
          id: chapter.id,
          target: plan.targetChapterIds.includes(chapter.id),
          title: chapter.title,
          volume: chapter.volume_name,
          outline: chapter.outline,
          next_hook: chapter.next_hook,
          outline_diagnosis: chapter.outline_diagnosis
        })), null, 2)}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) throw new Error(response.error || '章节簇结构修复失败')
  const json = extractJsonText(response.content.trim()) ?? response.content.trim()
  let parsed: { chapters?: Array<Record<string, unknown>> }
  try { parsed = JSON.parse(json) as typeof parsed } catch (error) {
    throw new Error(`章节簇结构修复解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(parsed.chapters)) throw new Error('章节簇结构修复缺少chapters数组')

  let outlines = 0
  for (const row of parsed.chapters) {
    const id = Number(row.id)
    const target = targets.find(chapter => chapter.id === id)
    if (!target || String(row.title ?? '').trim() !== target.title) continue
    const outline = String(row.outline ?? '').trim()
    const nextHook = String(row.next_hook ?? '').trim()
    const tensionLevel = Math.max(1, Math.min(10, Math.round(Number(row.tension_level) || 0)))
    const payoffType = String(row.payoff_type ?? '')
    const pattern = row.pattern_contract
    if (!outline || !nextHook || !pattern || typeof pattern !== 'object' || Array.isArray(pattern)
      || !['debt', 'partial', 'major', 'aftertaste'].includes(payoffType) || tensionLevel <= 0) continue
    let diagnosis: Record<string, unknown> = {}
    try { diagnosis = JSON.parse(target.outline_diagnosis ?? '{}') as Record<string, unknown> } catch { /* 重建 */ }
    diagnosis.pattern_contract = pattern
    diagnosis.tension_plan = { level: tensionLevel, payoff_type: payoffType }
    volumeChapterDAO.updateChapterWithVersion(id, {
      outline,
      next_hook: nextHook,
      outline_diagnosis: JSON.stringify(diagnosis)
    })
    outlines++
  }
  if (outlines !== targets.length) throw new Error(`章节簇结构修复仅返回 ${outlines}/${targets.length} 个有效目标`)

  // 结构变化会污染后续记忆；从每个受影响卷最早修改章起级联失效正文，交回draft_body顺序重生。
  let invalidatedBodies = 0
  const invalidatedVolumeNames = new Set<string>()
  for (const volumeId of targetVolumes) {
    const volumeChapters = allChapters.filter(chapter => chapter.volume_id === volumeId)
    if (volumeChapters[0]?.volume_name) invalidatedVolumeNames.add(volumeChapters[0].volume_name)
    const firstTargetIndex = volumeChapters.findIndex(chapter => plan.targetChapterIds.includes(chapter.id))
    if (firstTargetIndex < 0) continue
    for (const chapter of volumeChapters.slice(firstTargetIndex)) {
      clearChapterNarrativeMemory(workId, chapter.id)
      if (chapter.content?.trim()) invalidatedBodies++
      volumeChapterDAO.updateChapterWithVersion(chapter.id, {
        content: '', word_count: 0, status: 'draft', emotion_assessment_json: null
      })
    }
  }
  const state = readNovelGoalState(workId)
  updateNovelGoalState(workId, {
    checkedBodyVolumes: (state.checkedBodyVolumes ?? []).filter(name => !invalidatedVolumeNames.has(name))
  })
  return { outlines, invalidatedBodies }
}

async function executeNovelRepairPlan(
  workId: number,
  plan: RepairPlan,
  goal: string,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<string> {
  const boundedTargets = capNovelAutomaticRepairTargets(
    plan.targetChapterIds,
    volumeChapterDAO.listChaptersByWork(workId)
  )
  if (plan.targetChapterIds.length > 0 && boundedTargets.length === 0) {
    throw new NovelPipelineError(
      'REPAIR_BOUNDARY',
      `修复目标超出全书尾部 ${MAX_AUTO_NOVEL_REPAIR_CHAPTERS} 章安全窗口，拒绝自动改写已冻结正文`
    )
  }
  plan = { ...plan, targetChapterIds: boundedTargets }

  if (plan.action === 'draft_missing') {
    const summaries: string[] = []
    for (const chapterId of plan.targetChapterIds) {
      assertNotAborted(signal)
      const ch = volumeChapterDAO.getChapter(chapterId)
      onProgress?.(`正在生成缺失章节「${ch?.title ?? chapterId}」`)
      clearChapterNarrativeMemory(workId, chapterId)
      const gen = await generateBeatBody(workId, chapterId, {
        signal,
        goalDescription: goal,
        workType: 'novel',
        deferNarrativeMemory: true
      })
      if (!gen.success) throw new Error(gen.error || '生成失败')
      const gate = await runChapterAcceptanceGate(workId, chapterId, config, signal, onProgress)
      if (!gate.passed) {
        throw new Error(`「${ch?.title ?? chapterId}」补写后未通过质量与情绪门禁：${gate.failedMetrics.join('、')}`)
      }
      await finalizeNovelChapterMemory(workId, chapterId, signal, onProgress)
      summaries.push(`${ch?.title ?? chapterId} ${gen.wordCount}字，质量与情绪门禁通过`)
    }
    return summaries.join('；')
  }

  if (plan.scope === 'cluster' || plan.scope === 'volume') {
    onProgress?.(`正在执行${plan.scope === 'volume' ? '整卷' : '章节簇'}结构修复`)
    const result = await reviseNovelStructuralCluster(workId, plan, goal, signal)
    return `重构 ${result.outlines} 章大纲，级联失效 ${result.invalidatedBodies} 章正文，将按新状态顺序重生`
  }

  const summaries: string[] = []
  for (const chapterId of plan.targetChapterIds) {
    assertNotAborted(signal)
    const ch = volumeChapterDAO.getChapter(chapterId)
    if (!ch) continue
    clearChapterNarrativeMemory(workId, chapterId)
    let summary = ''
    let bodyChanged = false

    if (plan.issueCodes?.includes('MISSING_PATTERN_FINGERPRINT') && ch.content?.trim()) {
      onProgress?.(`「${ch.title}」将在复验后重新提取状态与模式指纹`)
      summary = `${ch.title} 等待复验后补抽取状态与模式指纹`
    } else if (plan.action === 'systemic') {
      onProgress?.(`正在修复承重状态「${ch.title}」`)
      const gen = await reviseBeatBody(workId, chapterId, {
        signal,
        workType: 'novel',
        deferNarrativeMemory: true,
        instruction: `${plan.hint}\n只修改与确定性证据冲突的事实；既有不可逆状态优先，不得用模糊措辞掩盖冲突。`
      })
      if (!gen.success) throw new Error(gen.error || '承重状态修复失败')
      bodyChanged = true
      summary = `${ch.title} 已修复承重状态冲突`

    } else if (plan.action === 'expand' || plan.action === 'compress') {
      onProgress?.(`正在${plan.action === 'expand' ? '扩写' : '压缩'}「${ch.title}」`)
      const gen = await reviseBeatBody(workId, chapterId, {
        signal, instruction: plan.hint, workType: 'novel', deferNarrativeMemory: true
      })
      if (!gen.success) throw new Error(gen.error || '字数修订失败')
      bodyChanged = true
      summary = `${ch.title} ${gen.wordCount}字`
    } else if (plan.action === 'quality') {
      onProgress?.(`正在定向精修「${ch.title}」`)
      const diagnosis = await diagnoseChapterQualityAi(workId, chapterId, ch.content ?? '', {
        thinkingEnabled: getGoalLoopModelOpts(workId).thinkingEnabled
      })
      if (!diagnosis.success || !diagnosis.report) throw new Error(diagnosis.error || '质量诊断失败')
      const gen = await reviseBeatBody(workId, chapterId, {
        signal,
        workType: 'novel',
        deferNarrativeMemory: true,
        instruction: `根据以下质量诊断逐项修复，优先处理硬失败、因果、人设、设定、大纲覆盖和章末钩子：\n${diagnosis.report}`
      })
      if (!gen.success) throw new Error(gen.error || '质量修复失败')
      bodyChanged = true
      summary = `${ch.title} 已按诊断定向精修`
    } else if (plan.action === 'emotion') {
      onProgress?.(`正在定向修复情绪门禁「${ch.title}」`)
      let instruction = plan.hint
      try {
        const assessment = ch.emotion_assessment_json
          ? JSON.parse(ch.emotion_assessment_json)
          : null
        if (assessment) instruction = emotionRepairHint(assessment)
      } catch { /* 使用通用情绪修复提示 */ }
      const gen = await reviseBeatBody(workId, chapterId, {
        signal, instruction, workType: 'novel', deferNarrativeMemory: true
      })
      if (!gen.success) throw new Error(gen.error || '情绪修复失败')
      bodyChanged = true
      summary = `${ch.title} 已按情绪盲读报告定向精修`
    } else if (plan.action === 'deai') {
      onProgress?.(`正在去AI/修复一致性「${ch.title}」`)
      const gate = runConsistencyGate(workId, chapterId, ch.content ?? '', { requireTimeline: false })
      const violations = gate.blockers.join('；')
      const gen = await reviseBeatBody(workId, chapterId, {
        signal,
        instruction: `请修复以下问题：${[violations, plan.hint].filter(Boolean).join('；') || '去除AI腔、提升叙事自然度'}`,
        workType: 'novel',
        deferNarrativeMemory: true
      })
      if (!gen.success) throw new Error(gen.error || '修复失败')
      bodyChanged = true
      summary = `${ch.title} 已修复`
    } else {
      onProgress?.(`正在优化目标匹配「${ch.title}」`)
      const gen = await reviseBeatBody(workId, chapterId, {
        signal,
        deferNarrativeMemory: true,
        instruction: `${plan.hint || '强化创作目标匹配度'}\n用户目标：${goal}`,
        workType: 'novel'
      })
      if (!gen.success) throw new Error(gen.error || '优化失败')
      bodyChanged = true
      summary = `${ch.title} 已优化`
    }

    const acceptance = await runChapterAcceptanceGate(workId, chapterId, config, signal, onProgress)
    if (!acceptance.passed) {
      throw new Error(`「${ch.title}」修订后未通过质量与情绪门禁：${acceptance.failedMetrics.join('、')}`)
    }
    await finalizeNovelChapterMemory(workId, chapterId, signal, onProgress)
    if (bodyChanged) {
      const state = readNovelGoalState(workId)
      const volumeName = volumeChapterDAO.listVolumes(workId).find(volume => volume.id === ch.volume_id)?.name
      updateNovelGoalState(workId, {
        checkedBodyVolumes: (state.checkedBodyVolumes ?? []).filter(name => name !== volumeName)
      })
    }
    summaries.push(`${summary}，复验通过`)
  }
  return summaries.join('；') || '无需修复'
}

async function runVolumeBodyCheckpoint(
  workId: number,
  chapterId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ passed: boolean; summary: string }> {
  const all = volumeChapterDAO.listChaptersByWork(workId)
  const current = all.find(chapter => chapter.id === chapterId)
  if (!current) return { passed: true, summary: '' }
  const volumeChapters = all.filter(chapter => chapter.volume_id === current.volume_id)
  if (volumeChapters.at(-1)?.id !== chapterId || volumeChapters.some(chapter => !chapter.content?.trim())) {
    return { passed: true, summary: '' }
  }
  const state = readNovelGoalState(workId)
  if (state.checkedBodyVolumes?.includes(current.volume_name)) return { passed: true, summary: '' }

  onProgress?.(`正在执行「${current.volume_name}」全覆盖分卷正文检查点`)
  const assessment = await assessNovelVolume(workId, current.volume_name, volumeChapters, signal)
  const scoresPassed = assessment.structureScore >= 80
    && assessment.escalationScore >= 78
    && assessment.payoffScore >= 80
    && assessment.continuityScore >= 85
    && assessment.repetitionScore >= 80
  const passed = scoresPassed && assessment.evidenceIssues.length === 0 && assessment.issues.length === 0
  if (passed) {
    updateNovelGoalState(workId, {
      checkedBodyVolumes: [...new Set([...(state.checkedBodyVolumes ?? []), current.volume_name])]
    })
    return {
      passed: true,
      summary: `结构${assessment.structureScore}/升级${assessment.escalationScore}/兑现${assessment.payoffScore}/连续${assessment.continuityScore}/反重复${assessment.repetitionScore}`
    }
  }

  if (assessment.evidenceIssues.length === 0) {
    throw new Error(
      `分卷评估器给出低分或问题但没有“章节标题 + 原文证据”，禁止据此自动重写「${current.volume_name}」`
    )
  }

  const weakIds = assessment.weakChapters
    .map(title => volumeChapters.find(chapter => chapter.title === title
      || chapter.title.includes(title)
      || title.includes(chapter.title))?.id)
    .filter((id): id is number => id != null)
  const targetIds = capNovelAutomaticRepairTargets(
    weakIds,
    volumeChapterDAO.listChaptersByWork(workId)
  )
  if (targetIds.length === 0) {
    throw new NovelPipelineError(
      'REPAIR_BOUNDARY',
      `「${current.volume_name}」的问题证据位于已冻结窗口之外，超出尾部 ${MAX_AUTO_NOVEL_REPAIR_CHAPTERS} 章自动修复范围`
    )
  }
  const plan: RepairPlan = {
    action: 'volume',
    scope: 'volume',
    targetChapterIds: targetIds,
    hint: [
      `分卷正文检查点未通过：结构${assessment.structureScore}/升级${assessment.escalationScore}/兑现${assessment.payoffScore}/连续${assessment.continuityScore}/反重复${assessment.repetitionScore}`,
      ...assessment.issues
    ].join('\n')
  }
  const repaired = await reviseNovelStructuralCluster(workId, plan, goal, signal)
  return {
    passed: false,
    summary: `已重构 ${repaired.outlines} 章并级联失效 ${repaired.invalidatedBodies} 章正文`
  }
}

const VALID_PHASES: Phase[] = NOVEL_GOAL_ROUTINE_PHASE_ORDER

function isResumable(status: string | null | undefined): boolean {
  return status === 'paused' || status === 'running' || status === 'cancelled' || status === 'timeout'
}

export function shouldResumeNovelGoalLoop(workId: number): boolean {
  const existing = goalRoutineDAO.getByWork(workId)
  if (!existing || existing.goal_met) return false
  if (!isResumable(existing.status)) return false
  if (existing.status === 'timeout') return true
  if (existing.status === 'paused' || existing.status === 'cancelled') {
    return (existing.turn_count ?? 0) > 0 || Boolean(existing.current_phase)
  }
  return false
}

export async function runNovelGoalLoop(
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
    const defaultStart: Phase = fullConfig.incubatorEnabled ? 'incubate_outline' : 'materialize_settings'
    phase = explicitPhase ?? (VALID_PHASES.includes(savedPhase) ? savedPhase : defaultStart)
    if (existing.status === 'timeout' || turn >= fullConfig.maxTurns) {
      turn = 0
    }
  } else if (explicitPhase && existing) {
    const saved = existing.goal_config_json
      ? { ...DEFAULT_STORY_GOAL_CONFIG, ...JSON.parse(existing.goal_config_json) as Partial<StoryGoalConfig> }
      : { ...DEFAULT_STORY_GOAL_CONFIG }
    fullConfig = { ...saved, ...config }
    turn = 0
    phase = explicitPhase
  } else {
    fullConfig = { ...DEFAULT_STORY_GOAL_CONFIG, ...config }
    turn = 0
    phase = explicitPhase ?? (fullConfig.incubatorEnabled ? 'incubate_outline' : 'materialize_settings')
  }

  fullConfig.maxTurns = requireGoalTurnLimit(fullConfig.maxTurns)

  const controller = new AbortController()
  activeLoops.set(workId, controller)
  bindGoalLoopModelOpts(workId, fullConfig)

  goalRoutineDAO.ensure(workId)
  const hasNoNovelStructure = volumeChapterDAO.listVolumes(workId).length === 0
    && volumeChapterDAO.listChaptersByWork(workId).length === 0
  if (!resume && explicitPhase === 'generate_volumes' && hasNoNovelStructure) {
    resetNovelGoalStateFromVolumePlan(workId)
  }
  updateNovelGoalState(workId, {
    ...(!resume && !explicitPhase
      ? {
          titleHookCandidates: undefined,
          titleHookPreferredIndex: undefined,
          titleHookApplied: undefined,
          finalAudit: undefined
        }
      : {}),
    ...(!resume ? {
      failure: undefined,
      repairStall: undefined
    } : {})
  })
  if (!resume && !explicitPhase && volumeChapterDAO.listChaptersByWork(workId).length === 0) {
    updateNovelGoalState(workId, {
      novelOutline: undefined,
      volumePlanChecked: undefined,
      volumeQualityReport: undefined,
      repairPlan: undefined,
      failure: undefined,
      overallRepairRounds: 0,
      repairStall: undefined,
      checkedChapterVolumes: undefined,
      pendingChapterVolumeGate: undefined,
      chapterVolumeGateCheckpoint: undefined,
      checkedBodyVolumes: undefined,
      titleHookCandidates: undefined,
      titleHookPreferredIndex: undefined,
      titleHookApplied: undefined,
      finalAudit: undefined
    })
  }
  goalRoutineDAO.update(workId, {
    status: 'running',
    max_turns: fullConfig.maxTurns,
    turn_count: turn,
    current_phase: phase,
    goal_met: false,
    goal_config_json: JSON.stringify(fullConfig)
  })

  let lastCheck: GoalCheckResult | undefined = readNovelGoalState(workId).lastCheck

  const emit = (message: string, status: string) => {
    const ev: GoalProgressEvent = {
      workId, turn, maxTurns: fullConfig.maxTurns, phase, status, check: lastCheck, message
    }
    broadcastProgress('goal:progress', ev)
  }

  try {
    while (true) {
      if (controller.signal.aborted) {
        goalRoutineDAO.setStatus(workId, 'cancelled')
        emit('已取消', 'cancelled')
        return
      }

      if (turn >= fullConfig.maxTurns) {
        goalRoutineDAO.appendTurn({
          work_id: workId,
          turn_no: turn,
          phase,
          action: 'budget_exhausted',
          summary: `已使用 ${fullConfig.maxTurns} 轮硬预算，保存断点并暂停，继续运行需显式恢复`
        })
        goalRoutineDAO.setStatus(workId, 'timeout')
        emit('本轮调用预算已用完，已保存断点；请显式继续运行', 'timeout')
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
          const count = await materializeNovelSettings(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          emit('正在抽取资源约束账本', 'running')
          const resourceCount = await refreshResourceConstraints(workId, controller.signal)
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'settings', summary: `生成 ${count} 项核心设定，抽取 ${resourceCount} 项资源约束`
          })
          emit(`生成 ${count} 项核心设定，抽取 ${resourceCount} 项资源约束`, 'running')
          phase = 'generate_character_cards'
        } else if (phase === 'generate_character_cards') {
          emit('正在生成主角人设卡片', 'running')
          const count = await generateNovelCharacterCards(workId, controller.signal)
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'character_cards', summary: `生成 ${count} 张主角人设卡片`
          })
          emit(`生成 ${count} 张主角人设卡片`, 'running')
          phase = 'emotion_engine_gate'
        } else if (phase === 'emotion_engine_gate') {
          const result = await ensureEmotionEngine(
            workId, fullConfig.goalDescription, 'novel', controller.signal,
            message => emit(message, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'emotion_engine_gate',
            score: result.score, summary: `情绪发动机通过（${result.score}分，${result.rounds}轮）`
          })
          emit(`情绪发动机通过（${result.score}分）`, 'running')
          phase = 'overall_self_check'
        } else if (phase === 'generate_title_hook') {
          emit('正在生成书名和导语', 'running')
          const selection = await generateNovelTitleHook(workId, fullConfig.goalDescription, controller.signal)
          const picked = selection.preferred
          workDAO.update(workId, { title: picked.title, description: picked.hook || undefined })
          updateNovelGoalState(workId, {
            titleHookCandidates: selection.candidates,
            titleHookPreferredIndex: selection.preferredIndex,
            titleHookApplied: true
          })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'title_hook_auto_selected',
            summary: `AI 从 ${selection.candidates.length} 套候选中自动选择并应用书名「${picked.title}」`
          })
          emit(`AI 已自动选择并应用书名「${picked.title}」`, 'running')
          phase = 'draft_body'
        } else if (phase === 'overall_self_check') {
          emit('正在运行整体自检', 'running')
          const report = await runNovelOverallSelfCheck(workId, controller.signal)
          const conclusionText = report.match(/(PASS|FAIL|REVISE|通过|不通过|需修订).{0,40}/i)?.[0] ?? '自检完成'
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'overall_check', summary: conclusionText
          })
          const qualityStatus = getSettingsQualityStatus(workId)
          if (!qualityStatus.canProceed) {
            const runtime = readNovelGoalState(workId)
            const repairRound = runtime.overallRepairRounds ?? 0
            const revised = await repairNovelSettingsFromOverallCheck(
              workId,
              report,
              controller.signal,
              message => emit(message, 'running')
            )
            updateNovelGoalState(workId, { overallRepairRounds: repairRound + 1 })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'settings_repair',
              summary: `整体自检未通过，自动修订 ${revised} 项设定（第 ${repairRound + 1} 轮，达标前持续修订）`
            })
            coreSettingDAO.deleteByWorkAndTypes(workId, ['emotion_engine'])
            phase = 'generate_character_cards'
          } else {
            updateNovelGoalState(workId, { overallRepairRounds: 0 })
            emit(`整体自检通过：${conclusionText}`, 'running')
            phase = 'generate_volumes'
          }
        } else if (phase === 'generate_volumes') {
          const result = await prepareNovelVolumePlan(
            workId,
            fullConfig.goalDescription,
            controller.signal,
            msg => emit(msg, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase,
            action: 'volumes',
            summary: `分卷大纲已冻结：${result.volumes} 卷${result.revised ? '，经门禁整体修订' : ''}`
          })
          emit(`分卷大纲完成：${result.volumes} 卷，进入章节情节`, 'running')
          phase = 'generate_beats'
        } else if (phase === 'generate_beats') {
          const reconciled = reconcileNovelWorkflowState(workId)
          if (reconciled.changed) {
            emit(
              `检测到分卷事实数据与冻结检查点不一致，已自动失效章节门禁 ${reconciled.invalidatedChapterVolumes.length} 卷、正文门禁 ${reconciled.invalidatedBodyVolumes.length} 卷`,
              'running'
            )
          }
          const outlinedChapters = volumeChapterDAO.listChaptersByWork(workId)
          const outlineState = readNovelGoalState(workId)
          const workflow = outlineState.novelOutline
            ? resolveNovelVolumeWorkflowCheckpoint(
                outlineState.novelOutline.volumePlan,
                outlinedChapters,
                outlineState.checkedChapterVolumes,
                outlineState.checkedBodyVolumes
              )
            : undefined
          if (workflow?.kind === 'body_gate') {
            const volumeChapters = outlinedChapters.filter(chapter => chapter.volume_name === workflow.volume.name)
            const lastVolumeChapter = volumeChapters.at(-1)
            if (!lastVolumeChapter) {
              throw new NovelPipelineError('CONTRACT_INVALID', `分卷「${workflow.volume.name}」缺少正文检查点章节`)
            }
            const checkpoint = await runVolumeBodyCheckpoint(
              workId,
              lastVolumeChapter.id,
              fullConfig.goalDescription,
              controller.signal,
              msg => emit(msg, 'running')
            )
            if (!checkpoint.passed) {
              emit(`恢复分卷检查点后需要重写尾部窗口：${checkpoint.summary}`, 'running')
              phase = 'draft_body'
              continue
            }
            emit(`「${workflow.volume.name}」正文检查点已冻结，允许规划下一卷`, 'running')
            continue
          }
          if (workflow?.kind === 'draft_body') {
            phase = outlineState.titleHookApplied ? 'draft_body' : 'generate_title_hook'
            emit(
              outlineState.titleHookApplied
                ? '当前分卷章节情节已冻结，转入该卷正文生成'
                : '首卷章节情节已冻结，先生成书名导语再写正文',
              'running'
            )
            continue
          }
          if (workflow?.kind === 'complete') {
            phase = 'goal_check'
            emit('全部分卷章节情节、正文及卷末检查点均已冻结，进入整书目标验收', 'running')
            continue
          }
          const res = await generateNextNovelOutlineBatch(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'beats',
            summary: res.created > 0
              ? `生成章节情节 ${res.range?.start}-${res.range?.end}，剩余 ${res.remaining} 章${res.volumeGate ? `；「${res.volumeGate.volume}」整卷门禁通过（${res.volumeGate.score}分，${res.volumeGate.rounds}轮）` : ''}`
              : `章节情节完整，复用 ${res.reused} 章`
          })
          if (res.volumeGate) {
            emit(`「${res.volumeGate.volume}」章节情节门禁通过：${res.volumeGate.score}分`, 'running')
          }
          emit(res.volumeReadyForDraft
            ? `「${res.volumeReadyForDraft}」章节情节已冻结，转入该卷正文；全书剩余 ${res.remaining} 章待滚动规划`
            : res.complete
              ? `章节情节已完整生成，共 ${res.created + res.reused} 章`
              : `本批生成 ${res.created} 章，剩余 ${res.remaining} 章`, 'running')
          const state = readNovelGoalState(workId)
          phase = nextPhaseAfterNovelOutlineCheckpoint({
            volumeReadyForDraft: Boolean(res.volumeReadyForDraft),
            titleHookApplied: Boolean(state.titleHookApplied),
            allOutlinesComplete: res.complete
          })
        } else if (phase === 'draft_body') {
          const reconciled = reconcileNovelWorkflowState(workId)
          if (reconciled.changed) {
            emit(
              `检测到正文事实数据与冻结检查点不一致，已自动回退到最早未完成分卷`,
              'running'
            )
          }
          const draftState = readNovelGoalState(workId)
          const draftChapters = volumeChapterDAO.listChaptersByWork(workId)
          const workflow = draftState.novelOutline
            ? resolveNovelVolumeWorkflowCheckpoint(
                draftState.novelOutline.volumePlan,
                draftChapters,
                draftState.checkedChapterVolumes,
                draftState.checkedBodyVolumes
              )
            : undefined
          if (workflow && workflow.kind !== 'draft_body') {
            phase = workflow.kind === 'complete' ? 'goal_check' : 'generate_beats'
            emit(
              workflow.kind === 'outline_gate'
                ? `「${workflow.volume.name}」章节门禁尚未通过，禁止生成正文`
                : workflow.kind === 'generate_outline'
                  ? `「${workflow.volume.name}」章节情节尚未完整，禁止生成正文`
                  : workflow.kind === 'body_gate'
                    ? `「${workflow.volume.name}」正文完整，先执行卷末检查点`
                    : '全部分卷已冻结，进入整书目标验收',
              'running'
            )
            continue
          }
          const chapter = nextPendingDraftChapter(workId, fullConfig)
          if (!chapter) {
            phase = phaseAfterCurrentDraftWindow(workId)
            emit(
              phase === 'generate_beats'
                ? '当前分卷正文已冻结，开始滚动规划下一卷章节情节'
                : '正文已全部生成，进入只读整书目标验收',
              'running'
            )
          } else {
            const chapterRow = draftChapters.find(item => item.id === chapter.id)
            if (!chapterRow || !workflow || chapterRow.volume_name !== workflow.volume.name) {
              throw new NovelPipelineError(
                'CONTRACT_INVALID',
                `正文目标章节不属于当前已冻结分卷「${workflow?.kind === 'draft_body' ? workflow.volume.name : '未知'}」`
              )
            }
            // 未完成验收的正文只能作为候选；先移除旧派生记忆，避免同章修订读到未来章末状态。
            clearChapterNarrativeMemory(workId, chapter.id)
            if (chapter.needsGeneration) {
              emit(`正在生成正文「${chapter.title}」`, 'running')
              const gen = await generateBeatBody(workId, chapter.id, {
                signal: controller.signal,
                goalDescription: fullConfig.goalDescription,
                workType: 'novel',
                deferNarrativeMemory: true
              })
              if (!gen.success) throw new Error(gen.error || '正文生成失败')
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'draft',
                target_chapter_id: chapter.id,
                summary: `生成候选正文「${chapter.title}」${gen.wordCount}字，叙事记忆尚未提交`
              })
              emit(`生成候选正文「${chapter.title}」${gen.wordCount}字，开始执行质量与情绪门禁`, 'running')
            } else {
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'diagnose_resume',
                target_chapter_id: chapter.id,
                summary: `检测到「${chapter.title}」已有正文但缺少完整验收，恢复质量与情绪门禁`
              })
              emit(`「${chapter.title}」正文已存在但尚未完整验收，正在补跑质量与情绪门禁`, 'running')
            }

            const acceptance = await runChapterAcceptanceGate(
              workId,
              chapter.id,
              fullConfig,
              controller.signal,
              msg => emit(msg, 'running')
            )
            goalRoutineDAO.appendTurn({
              work_id: workId, turn_no: turn, phase, action: 'diagnose_fix',
              target_chapter_id: chapter.id,
              score: acceptance.qualityScore >= 0 ? acceptance.qualityScore : null,
              summary: acceptance.passed
                ? `「${chapter.title}」质量与情绪门禁通过（质量 ${acceptance.qualityScore} 分，累计诊断 ${acceptance.rounds} 轮）`
                : `「${chapter.title}」质量与情绪门禁未通过：${acceptance.failedMetrics.join('、')}`
            })
            if (!acceptance.passed) {
              clearChapterNarrativeMemory(workId, chapter.id)
              volumeChapterDAO.updateChapter(chapter.id, {
                status: 'draft', emotion_assessment_json: null, quality_assessment_json: null
              })
              throw new Error(
                `「${chapter.title}」累计诊断 ${acceptance.rounds} 轮仍未通过质量与情绪联合门禁，已保留最佳正文并禁止进入下一章`
                + `；${acceptance.failedMetrics.join('、') || '综合质量未达标'}`
              )
            }

            const finalMemory = await finalizeNovelChapterMemory(
              workId,
              chapter.id,
              controller.signal,
              msg => emit(msg, 'running')
            )
            goalRoutineDAO.appendTurn({
              work_id: workId, turn_no: turn, phase, action: 'memory_sync',
              target_chapter_id: chapter.id,
              summary: `章级门禁完成后原子提交「${chapter.title}」记忆体：+${finalMemory.planted}伏笔/${finalMemory.snapshots}快照/${finalMemory.foreshadowingResolved}回收`
            })

            const volumeCheckpoint = await runVolumeBodyCheckpoint(
              workId,
              chapter.id,
              fullConfig.goalDescription,
              controller.signal,
              msg => emit(msg, 'running')
            )
            if (!volumeCheckpoint.passed) {
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'volume',
                target_chapter_id: chapter.id,
                summary: `分卷正文检查点未通过，${volumeCheckpoint.summary}`
              })
              emit(`分卷正文检查点未通过，${volumeCheckpoint.summary}`, 'running')
              phase = 'draft_body'
              continue
            }
            if (volumeCheckpoint.summary) emit(`分卷正文检查点通过：${volumeCheckpoint.summary}`, 'running')

            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'acceptance_complete',
              target_chapter_id: chapter.id,
              score: acceptance.qualityScore >= 0 ? acceptance.qualityScore : null,
              summary: `「${chapter.title}」全部门禁完成，可进入下一章`
            })
            phase = nextPendingDraftChapter(workId, fullConfig)
              ? 'draft_body'
              : phaseAfterCurrentDraftWindow(workId)
          }
        } else if (phase === 'goal_check') {
          emit('正在进行目标验收（质量/字数/门禁/目标匹配）', 'running')
          lastCheck = await checkStoryGoal(
            workId,
            fullConfig,
            controller.signal,
            msg => emit(msg, 'running')
          )
          updateNovelGoalState(workId, { lastCheck })
          goalRoutineDAO.update(workId, {
            last_quality_score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : null,
            goal_met: lastCheck.met
          })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'check',
            score: lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : lastCheck.goalMatchScore,
            summary: lastCheck.met ? '目标达成' : lastCheck.reasons.join('；')
          })

          const expectedChapters = loadWritingPlan(workId).targetChapters
          if (expectedChapters > 0 && lastCheck.totalBeats < expectedChapters) {
            emit(`章节数量不完整：${lastCheck.totalBeats}/${expectedChapters}，返回章节情节生成`, 'running')
            phase = 'generate_beats'
            continue
          }
          if (lastCheck.contentBeats < lastCheck.totalBeats) {
            emit(`正文未全部完成：${lastCheck.contentBeats}/${lastCheck.totalBeats}，返回正文生成`, 'running')
            phase = 'draft_body'
            continue
          }

          if (lastCheck.met) {
            updateNovelGoalState(workId, {
              repairPlan: undefined,
              repairStall: undefined,
              finalAudit: { passed: true, auditedAt: new Date().toISOString(), reasons: [] }
            })
            goalRoutineDAO.setStatus(workId, 'goal_met')
            emit(`目标达成：质量${lastCheck.qualityScore} · 情绪盲读${lastCheck.emotionScore} · 目标匹配${lastCheck.goalMatchScore} · 章节${lastCheck.contentBeats}/${lastCheck.totalBeats} · 字数${lastCheck.totalWords}`, 'goal_met')
            return
          }

          if (shouldPauseForReadOnlyNovelAudit({
            planComplete: expectedChapters <= 0 || lastCheck.totalBeats === expectedChapters,
            contentComplete: lastCheck.contentBeats === lastCheck.totalBeats,
            met: lastCheck.met
          })) {
            updateNovelGoalState(workId, {
              finalAudit: {
                passed: false,
                auditedAt: new Date().toISOString(),
                reasons: lastCheck.reasons
              }
            })
            goalRoutineDAO.update(workId, { status: 'paused', current_phase: 'goal_check', goal_met: false })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'audit_pause',
              summary: `整书终审未通过但正文已冻结；需显式选择继续修复：${lastCheck.reasons.join('；')}`
            })
            emit(`整书终审未通过，已冻结全部正文并暂停：${lastCheck.reasons.join('；')}`, 'paused')
            return
          }

          emit(`未达标：${lastCheck.reasons.join('；')}`, 'running')
          phase = 'repair_plan'
        } else if (phase === 'repair_plan') {
          if (!lastCheck) {
            throw new NovelPipelineError('PREREQUISITE_MISSING', '缺少最近一次整书终审结果，不能制定修复计划')
          }
          const signature = repairReasonSignature(lastCheck!.reasons)
          const evidence = repairEvidenceSnapshot(lastCheck!)
          const previousStall = readNovelGoalState(workId).repairStall
          const noEvidenceImprovement = previousStall?.signature === signature
            && previousStall.issueFingerprint === evidence.fingerprint
            && evidence.count >= (previousStall.blockerCount ?? evidence.count)
          const stallCount = noEvidenceImprovement ? previousStall.count + 1 : 1
          updateNovelGoalState(workId, {
            repairStall: {
              signature,
              issueFingerprint: evidence.fingerprint,
              blockerCount: evidence.count,
              count: stallCount
            }
          })
          const basePlan = buildNovelRepairPlan(workId, lastCheck!, fullConfig)
          const boundedTargets = capNovelAutomaticRepairTargets(
            basePlan.targetChapterIds,
            volumeChapterDAO.listChaptersByWork(workId)
          )
          if (boundedTargets.length === 0) {
            throw new NovelPipelineError(
              'REPAIR_BOUNDARY',
              `终审问题位于已冻结正文，超出尾部 ${MAX_AUTO_NOVEL_REPAIR_CHAPTERS} 章自动修复窗口`
            )
          }
          if (stallCount >= MAX_NOVEL_REPAIR_STALLS) {
            goalRoutineDAO.update(workId, { status: 'paused', current_phase: 'repair_plan' })
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'repair_stalled',
              summary: `同一证据连续 ${stallCount} 轮未改善，已熔断并保留当前版本`
            })
            emit(`同一修复证据连续 ${stallCount} 轮没有改善，已熔断并暂停`, 'paused')
            return
          }
          const plan: RepairPlan = stallCount >= MAX_REPAIR_STALL_ROUNDS
            ? {
                action: 'cluster',
                scope: 'cluster',
                targetChapterIds: boundedTargets,
                hint: [
                  `同一验收证据连续 ${stallCount} 轮未改善，只升级为尾部 ${boundedTargets.length} 章结构修复。`,
                  basePlan.hint,
                  ...lastCheck!.reasons
                ].join('\n'),
                issueCodes: basePlan.issueCodes,
                evidenceFingerprint: basePlan.evidenceFingerprint
              }
            : { ...basePlan, targetChapterIds: boundedTargets }
          if (stallCount >= MAX_REPAIR_STALL_ROUNDS) {
            goalRoutineDAO.appendTurn({
              work_id: workId,
              turn_no: turn,
              phase,
              action: 'repair_escalate',
              summary: `相同验收问题连续 ${stallCount} 轮未改善，已升级为尾部 ${boundedTargets.length} 章结构修复`
            })
            emit(`相同验收问题未改善，已升级到尾部 ${boundedTargets.length} 章结构修复`, 'running')
          }
          updateNovelGoalState(workId, { repairPlan: plan })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: plan.action,
            target_chapter_id: plan.targetChapterIds[0] ?? null,
            summary: `修复计划：${plan.action} · ${plan.hint}`
          })
          emit(`修复计划：${plan.action}`, 'running')
          phase = 'repair_execute'
        } else if (phase === 'repair_execute') {
          const parsed = readNovelGoalState(workId)
          const plan = (parsed.repairPlan as RepairPlan | undefined)
            ?? buildNovelRepairPlan(workId, lastCheck!, fullConfig)
          emit(`正在执行修复：${plan.action}`, 'running')
          const summary = await executeNovelRepairPlan(
            workId,
            plan,
            fullConfig.goalDescription,
            fullConfig,
            controller.signal,
            msg => emit(msg, 'running')
          )
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: plan.action,
            target_chapter_id: plan.targetChapterIds[0] ?? null,
            summary
          })
          emit(`执行修复：${summary}`, 'running')
          phase = 'goal_check'
        } else {
          phase = 'materialize_settings'
        }
        updateNovelGoalState(workId, { failure: undefined })
      } catch (e) {
        if (controller.signal.aborted) {
          goalRoutineDAO.setStatus(workId, 'cancelled')
          emit('已取消', 'cancelled')
          return
        }
        const msg = e instanceof Error ? e.message : String(e)
        appLogger.error('goal_routine', '小说目标循环轮次异常', { workId, turn, error: msg })
        goalRoutineDAO.appendTurn({
          work_id: workId, turn_no: turn, phase, action: 'error', summary: msg
        })
        emit(`轮次异常：${msg}`, 'running')
        const currentFailure = readNovelGoalState(workId).failure
        const errorCode = attemptedPhase === 'draft_body' && msg.includes('AI 诊断未达到')
          ? 'QUALITY_GATE_NOT_MET'
          : e instanceof NovelPipelineError
            ? e.code
            : e instanceof Error ? e.name : 'unknown'
        const signature = novelPhaseFailureSignature(attemptedPhase, errorCode, msg)
        const failureCount = currentFailure?.phase === attemptedPhase && currentFailure.signature === signature
          ? currentFailure.count + 1
          : 1
        updateNovelGoalState(workId, {
          failure: { phase: attemptedPhase, signature, count: failureCount, message: msg }
        })
        const pendingChapterGate = attemptedPhase === 'generate_beats'
          ? readNovelGoalState(workId).pendingChapterVolumeGate
          : undefined
        if (isTerminalNovelRepairError(errorCode)) {
          goalRoutineDAO.update(workId, { status: 'paused', current_phase: attemptedPhase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: errorCode === 'REPAIR_STALL' ? 'repair_stall_pause' : 'repair_boundary_pause',
            summary: msg
          })
          emit(
            errorCode === 'REPAIR_STALL'
              ? `自动修复未收敛，已停止改写并保留检查点：${msg}`
              : `自动修复已越过安全边界，保留现有正文并暂停：${msg}`,
            'paused'
          )
          return
        }
        if (failureCount >= MAX_NOVEL_PHASE_FAILURES) {
          goalRoutineDAO.update(workId, { status: 'paused', current_phase: attemptedPhase })
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'failure_circuit_breaker',
            summary: `相同失败连续 ${failureCount} 次，已熔断：${msg}`
          })
          emit(`「${attemptedPhase}」相同失败连续 ${failureCount} 次，已保存断点并暂停`, 'paused')
          return
        }
        if (failureCount >= MAX_REPAIR_STALL_ROUNDS) {
          // 分卷生成会保存逐卷检查点；保留失败详情，让下一轮按超时/截断分别降级，
          // 成功进入下一阶段后由轮次末尾统一清除。
          goalRoutineDAO.appendTurn({
            work_id: workId,
            turn_no: turn,
            phase: attemptedPhase,
            action: 'failure_escalate',
            summary: attemptedPhase === 'generate_beats'
              ? pendingChapterGate
                ? `分卷「${pendingChapterGate}」章节窗口门禁连续 ${failureCount} 次失败，已保留卷内窗口检查点；下一轮仅重试未完成窗口：${msg}`
                : `章节情节生成连续 ${failureCount} 次失败，已切换为单章检查点、关闭思考并压缩上下文后继续：${msg}`
              : attemptedPhase === 'generate_volumes'
              ? /VOLUME_OUTPUT_TRUNCATED|Unterminated string|Unexpected end of JSON/i.test(msg)
                ? `分卷生成连续 ${failureCount} 次发生输出截断，下一轮将从已保存分卷继续，提高输出预算并强制精简字段：${msg}`
                : `分卷生成连续 ${failureCount} 次失败，下一轮将从已保存分卷继续；若为超时则仅压缩输入上下文：${msg}`
              : `「${attemptedPhase}」连续 ${failureCount} 次执行失败，将保留检查点继续重试：${msg}`
          })
          emit(
            attemptedPhase === 'generate_beats'
              ? pendingChapterGate
                ? `分卷「${pendingChapterGate}」窗口门禁失败，已保存卷内检查点并仅重试未完成窗口`
                : '章节情节连续失败，已切换单章检查点策略并从断点继续'
              : attemptedPhase === 'generate_volumes'
              ? /VOLUME_OUTPUT_TRUNCATED|Unterminated string|Unexpected end of JSON/i.test(msg)
                ? '分卷输出被截断，已提高输出预算并从当前卷继续'
                : '分卷生成连续失败，已按错误类型调整请求并从断点继续'
              : `「${attemptedPhase}」连续失败，已保留检查点并继续重试`,
            'running'
          )
        } else {
          emit(`「${attemptedPhase}」第 ${failureCount} 次执行失败，将在下一轮继续自动重试：${msg}`, 'running')
        }
      }
    }
  } finally {
    clearGoalLoopModelOpts(workId)
    activeLoops.delete(workId)
  }
}
