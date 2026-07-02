/**
 * 小说目标循环运行器 —— 复刻短故事目标循环到小说管理。
 *
 * 与短故事差异：
 * 1. 跳过短故事孵化器阶段（incubate_outline / incubator_gate / freeze_storyline），
 *    小说直接复用作品已有的分卷/章节结构或生成章节大纲。
 * 2. 正文生成按「章」而非「拍」走 novel 正文 prompt。
 * 3. 验收逻辑复用 story-goal-checker（维度通用）。
 *
 * 状态机：
 *   materialize_settings → 沉淀核心设定
 *   generate_character_cards → 生成主角人设卡片
 *   generate_beats → 确保章节大纲完整
 *   generate_title_hook → 基于章节大纲生成爆款书名与导语
 *   overall_self_check → 核心设定整体自检
 *   draft_body → 顺序生成全部正文
 *   goal_check → 统一验收目标维度
 *   repair_plan / repair_execute → 结构化修复后回到验收
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
import { outlineConstraintsForWordTarget } from '../../../shared/outline-constraints'
import { DEFAULT_WORDS_PER_CHAPTER } from '../../../shared/writing-plan-presets'
import { loadWritingPlan } from '../writing-plan'
import { extractJsonText } from '../parse-json-extract'
import {
  checkStoryGoal,
  DEFAULT_STORY_GOAL_CONFIG,
  type StoryGoalConfig,
  type GoalCheckResult
} from './story-goal-checker'
import { generateBeatBody, type BeatGenResult } from './story-goal-doer'
import { incubateStoryline, runStorylineGate, freezeStoryline } from './story-goal-routine'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import { parseQualityAiScoreReport } from '../../../shared/quality-ai-score'
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
  action: 'draft_missing' | 'expand' | 'deai' | 'quality' | 'goal_align'
  targetChapterIds: number[]
  hint: string
}

interface TitleHookCandidate {
  title: string
  hook: string
  summary?: string
}

interface ChapterOutline {
  volumeId?: number
  volumeName?: string
  title: string
  outline: string
  beatRole?: string
}

const NOVEL_SETTING_TYPES = ['worldview', 'protagonist', 'golden_finger', 'main_plotline', 'pleasure_engine', 'supporting_cast'] as const

const NOVEL_SETTING_PROMPTS: Record<(typeof NOVEL_SETTING_TYPES)[number], string> = {
  protagonist: '你是顶级长篇小说人设设计师。基于作品背景输出 Markdown：## 身份与核心动机 / ## 长期成长弧线 / ## 关系网络 / ## 关键决策模式 / ## 与反派的对抗姿态。',
  golden_finger: '你是顶级长篇小说设定设计师。判断故事是否需要特殊机制；没有机制则设计身份反差与信息差。输出 Markdown：## 设定名称与形态 / ## 信息差构建 / ## 限制与升级节奏 / ## 对主线冲突的推动作用。',
  pleasure_engine: '你是顶级长篇小说节奏与爽点设计师。输出 Markdown：## 开篇钩子 / ## 前期小高潮 / ## 中期大反转 / ## 后期终极清算。必须明确每个爽点对应的卷/章位置。',
  supporting_cast: '你是顶级长篇小说配角设计师。输出 Markdown：## 核心反派与对手 / ## 盟友与导师 / ## 情感线对象 / ## 关系演变与情绪宣泄点。配角只写功能、冲突价值和记忆点。',
  worldview: '你是顶级长篇小说世界观设计师。输出 Markdown：## 世界基础规则 / ## 权力/势力结构 / ## 关键地点与时代 / ## 规则如何约束主角行动。',
  main_plotline: '你是顶级长篇小说主线架构师。基于全部已有设定，设计故事从开局到终局的发展轨迹。输出 Markdown：## 故事起点 / ## 核心发展线（3-5个关键阶段，每阶段标注触发事件、主角选择、状态变化）/ ## 关键转折点（至少2次预判外转向）/ ## 伏笔与回收布局 / ## 高潮设计 / ## 故事终点 / ## 各阶段递进逻辑。递进必须因果闭环，禁止"突然"跳跃。总字数 800-1500 字。'
}

const activeLoops = new Map<number, AbortController>()

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

async function materializeNovelSettings(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<number> {
  assertNotAborted(signal)
  const existing = coreSettingDAO.listByWork(workId)
  const missing = NOVEL_SETTING_TYPES.filter(t => !existing.some(e => e.type === t && e.content?.trim()))

  if (missing.length === 0) {
    onProgress?.('核心设定已存在，跳过')
    return 0
  }

  const mainline = coreSettingDAO.getByType(workId, 'idea')?.content?.trim()
    || buildWorkContext(workId, { includeVolumes: true, includeCoreSettings: true }).text.slice(0, 4000)
  let count = 0
  for (const type of missing) {
    assertNotAborted(signal)
    onProgress?.(`正在生成核心设定「${type}」(${count + 1}/${missing.length})`)
    const existingText = NOVEL_SETTING_TYPES
      .map(t => coreSettingDAO.getByType(workId, t)?.content?.trim() ? `## ${t}\n${coreSettingDAO.getByType(workId, t)?.content?.trim()}` : '')
      .filter(Boolean)
      .join('\n\n')
    const res = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: `settings_${type}`,
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        systemPrompt: NOVEL_SETTING_PROMPTS[type],
        prompt: [
          goal.trim() ? `【用户创作目标】\n${goal.trim()}` : '',
          `【长篇主线】\n${mainline}`,
          existingText ? `【已生成设定】\n${existingText}` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
    if (!res.success || !res.content?.trim()) continue
    coreSettingDAO.upsert(workId, type, res.content.trim())
    count++
    onProgress?.(`已回填核心设定「${type}」`)
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
  if (!res.success || !res.content?.trim()) return 0
  const parsed = parseCharacterCardsFromAi(res.content.trim())
  const sanitized = sanitizeCharacterCards(parsed)
  if (!validateCharacterCards(sanitized.cards)) return 0
  saveCharacterCards(workId, sanitized.cards)
  return sanitized.cards.length
}

async function generateNovelTitleHook(workId: number, goal: string, signal?: AbortSignal): Promise<TitleHookCandidate> {
  assertNotAborted(signal)
  const ctx = buildWorkContext(workId, { includeVolumes: true, includeCoreSettings: true })
  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_title_hook',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      systemPrompt: [
        '你是长篇小说书名与导语策划。输出 JSON：{"title":"...","hook":"...","summary":"..."}',
        'title 要爆款吸睛，hook 是 30 字以内导语，summary 是 100 字以内核心卖点。'
      ].join('\n'),
      prompt: [
        `【用户创作目标】\n${goal.trim() || '请策划一部长篇小说。'}`,
        `【作品上下文】\n${ctx.text.slice(0, 6000)}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  const fallback: TitleHookCandidate = { title: '未命名长篇小说', hook: '' }
  if (!res.success || !res.content?.trim()) return fallback
  try {
    const json = extractJsonText(res.content.trim()) ?? res.content.trim()
    const parsed = JSON.parse(json) as Partial<TitleHookCandidate>
    return {
      title: parsed.title?.trim() || fallback.title,
      hook: parsed.hook?.trim() || fallback.hook,
      summary: parsed.summary?.trim()
    }
  } catch {
    return fallback
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
  const conclusion = res.content.trim().match(/(PASS|FAIL|REVISE|通过|不通过|需修订).{0,40}/i)?.[0] ?? '自检完成'
  return conclusion
}

async function generateNovelBeats(
  workId: number,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ created: number; reused: number }> {
  assertNotAborted(signal)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const plan = loadWritingPlan(workId)
  const targetChapters = plan.targetChapters || 10

  if (chapters.length > 0) {
    onProgress?.(`复用已有 ${chapters.length} 个章节，跳过大纲生成`)
    return { created: 0, reused: chapters.length }
  }

  const ctx = buildWorkContext(workId, { includeVolumes: true, includeCoreSettings: true })
  const constraints = outlineConstraintsForWordTarget(plan.wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER)

  const res = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      step: 'goal_generate_beats',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      systemPrompt: [
        `你是长篇小说结构编辑。请为作品生成 ${targetChapters} 个章节的标题与大纲。`,
        `每章大纲 ${constraints.charsMin}-${constraints.charsMax} 字，必须包含：本章目标、关键冲突、情绪转折、结尾钩子。`,
        '输出 JSON 数组：[{"volume":"第一卷 名字","title":"第N章 标题","outline":"...","beatRole":"setup|inciting|rising|midpoint|climax|resolution"}]'
      ].join('\n'),
      prompt: [
        `【用户创作目标】\n${goal.trim() || '请自动策划一部长篇小说。'}`,
        `【目标章节数】${targetChapters} 章`,
        `【作品上下文】\n${ctx.text.slice(0, 8000)}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )

  if (!res.success || !res.content?.trim()) throw new Error('章节大纲生成失败')
  const json = extractJsonText(res.content.trim()) ?? res.content.trim()
  let outlines: ChapterOutline[]
  try {
    const parsed = JSON.parse(json) as Array<Partial<ChapterOutline>>
    outlines = parsed
      .filter(o => o.title?.trim() && o.outline?.trim())
      .map(o => ({
        volumeName: o.volumeName ?? (o as { volume?: string }).volume,
        title: o.title!.trim(),
        outline: o.outline!.trim(),
        beatRole: o.beatRole?.trim()
      }))
  } catch {
    throw new Error('章节大纲解析失败')
  }

  if (outlines.length === 0) throw new Error('未解析到有效章节大纲')

  const volumes = volumeChapterDAO.listVolumes(workId)
  let currentVolumeId = volumes[0]?.id
  if (!currentVolumeId) {
    currentVolumeId = volumeChapterDAO.createVolume(workId, '第一卷', '默认分卷')
  }

  const created: number[] = []
  for (const o of outlines) {
    assertNotAborted(signal)
    if (o.volumeName) {
      const existing = volumeChapterDAO.listVolumes(workId).find(v => v.name === o.volumeName)
      if (existing) {
        currentVolumeId = existing.id
      } else {
        currentVolumeId = volumeChapterDAO.createVolume(workId, o.volumeName)
      }
    }
    const id = volumeChapterDAO.createChapter(currentVolumeId!, o.title, o.outline)
    if (o.beatRole) {
      volumeChapterDAO.updateChapter(id, { beat_role: o.beatRole })
    }
    created.push(id)
  }

  return { created: created.length, reused: chapters.length }
}

function nextEmptyChapter(workId: number): { id: number; title: string } | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  for (const ch of chapters) {
    if (!ch.content?.trim()) return { id: ch.id, title: ch.title }
  }
  return null
}

async function diagnoseAndFixUntilPass(
  workId: number,
  chapterId: number,
  qualityMin: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ passed: boolean; finalScore: number; rounds: number; failedMetrics: string[] }> {
  let rounds = 0
  const maxRounds = 3
  const failedMetrics: string[] = []

  while (rounds < maxRounds) {
    assertNotAborted(signal)
    rounds++
    const ch = volumeChapterDAO.getChapter(chapterId)
    if (!ch?.content?.trim()) break

    onProgress?.(`正在诊断「${ch.title}」第 ${rounds} 轮`)
    const res = await diagnoseChapterQualityAi(workId, chapterId, ch.content, { thinkingEnabled: getGoalLoopModelOpts(workId).thinkingEnabled })
    if (!res.success || typeof res.scoreTotal !== 'number') {
      failedMetrics.push('诊断未返回分数')
      break
    }

    const breakdown = res.report ? parseQualityAiScoreReport(res.report) : null
    const metricFailures = breakdown
      ? breakdown.items.filter(i => i.score < qualityMin).map(i => i.label)
      : []

    if (!res.hardFail && res.scoreTotal >= qualityMin && metricFailures.length === 0) {
      return { passed: true, finalScore: res.scoreTotal, rounds, failedMetrics }
    }

    if (rounds === maxRounds) {
      failedMetrics.push(...metricFailures)
      return { passed: false, finalScore: res.scoreTotal, rounds, failedMetrics }
    }

    onProgress?.(`正在修复「${ch.title}」第 ${rounds} 轮`)
    const fixPrompt = [
      `【原文】\n${ch.content}`,
      `【问题】${res.hardFail ? '存在硬失败项' : `质量分 ${res.scoreTotal}，未达标指标：${metricFailures.join('、')}`}`,
      QUALITY_APPLY_FIXES_PROMPT
    ].join('\n\n')

    const fixRes = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_diagnose_fix',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        systemPrompt: `你是资深网文编辑。请针对以下问题直接输出修改后的正文全文，不要解释。${STYLE_REWRITE_INSTRUCTION}`,
        prompt: fixPrompt
      }),
      { stream: false, signal }
    )

    if (fixRes.success && fixRes.content?.trim()) {
      let fixed = normalizeModelBodyOutput(fixRes.content.trim(), 'body_generation')
      fixed = stripDeterministicAiPatterns(fixed)
      volumeChapterDAO.updateChapterWithVersion(chapterId, {
        content: fixed,
        word_count: countWords(fixed)
      })
    }
  }

  return { passed: false, finalScore: -1, rounds, failedMetrics }
}

function cleanupEmDashesAfterPassedGate(workId: number, mode: 'comma' | 'remove' = 'comma'): { chapters: number; replaced: number } {
  let chapters = 0
  let replaced = 0
  const chaptersList = volumeChapterDAO.listChaptersByWork(workId)
  for (const ch of chaptersList) {
    if (!ch.content?.trim()) continue
    const before = countEmDashes(ch.content)
    if (before === 0) continue
    const cleaned = mode === 'remove' ? stripEmDashes(ch.content) : ch.content.replace(/——/g, '，')
    const after = countEmDashes(cleaned)
    if (after !== before) {
      volumeChapterDAO.updateChapterWithVersion(ch.id, { content: cleaned, word_count: countWords(cleaned) })
      chapters++
      replaced += before - after
    }
  }
  return { chapters, replaced }
}

function buildNovelRepairPlan(workId: number, check: GoalCheckResult): RepairPlan {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const emptyChapters = chapters.filter(c => !c.content?.trim())
  if (emptyChapters.length > 0) {
    return { action: 'draft_missing', targetChapterIds: emptyChapters.map(c => c.id), hint: '先生成缺失章节正文' }
  }

  const lowQuality = check.chapterDiagnostics.filter(d => d.qualityScore >= 0 && (d.qualityHardFail || d.qualityScore < (check.qualityScore > 0 ? check.qualityScore : 85)))
  if (lowQuality.length > 0) {
    return { action: 'quality', targetChapterIds: lowQuality.slice(0, 3).map(d => d.chapterId), hint: '提升低质量章节' }
  }

  const gateFailures = check.chapterDiagnostics.filter(d => d.gateBlockers > 0)
  if (gateFailures.length > 0) {
    return { action: 'deai', targetChapterIds: gateFailures.slice(0, 3).map(d => d.chapterId), hint: '修复一致性门禁与去AI问题' }
  }

  if (check.totalWords < check.targetWords) {
    return { action: 'expand', targetChapterIds: [chapters[chapters.length - 1]?.id].filter(Boolean) as number[], hint: '整体字数不足，适当扩写' }
  }

  return { action: 'goal_align', targetChapterIds: [], hint: '优化创作目标匹配度' }
}

async function executeNovelRepairPlan(
  workId: number,
  plan: RepairPlan,
  goal: string,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<string> {
  if (plan.action === 'draft_missing') {
    const summaries: string[] = []
    for (const chapterId of plan.targetChapterIds) {
      assertNotAborted(signal)
      const ch = volumeChapterDAO.getChapter(chapterId)
      onProgress?.(`正在生成缺失章节「${ch?.title ?? chapterId}」`)
      const gen = await generateBeatBody(workId, chapterId, { signal, goalDescription: goal, workType: 'novel' })
      if (!gen.success) throw new Error(gen.error || '生成失败')
      summaries.push(`${ch?.title ?? chapterId} ${gen.wordCount}字`)
    }
    return summaries.join('；')
  }

  const summaries: string[] = []
  for (const chapterId of plan.targetChapterIds) {
    assertNotAborted(signal)
    const ch = volumeChapterDAO.getChapter(chapterId)
    if (!ch) continue

    if (plan.action === 'expand') {
      onProgress?.(`正在扩写「${ch.title}」`)
      const gen = await generateBeatBody(workId, chapterId, { signal, goalDescription: goal, extraHint: plan.hint, workType: 'novel' })
      if (!gen.success) throw new Error(gen.error || '扩写失败')
      summaries.push(`${ch.title} ${gen.wordCount}字`)
    } else if (plan.action === 'quality') {
      const r = await diagnoseAndFixUntilPass(workId, chapterId, 85, signal, onProgress)
      summaries.push(`${ch.title} 诊断${r.passed ? '通过' : '未通过'}（${r.finalScore}分，${r.rounds}轮）`)
    } else if (plan.action === 'deai') {
      onProgress?.(`正在去AI/修复一致性「${ch.title}」`)
      const gate = runConsistencyGate(workId, chapterId, ch.content ?? '')
      const violations = gate.blockers.join('；')
      const gen = await generateBeatBody(workId, chapterId, { signal, goalDescription: goal, extraHint: `请修复以下问题：${violations || '去除AI腔、提升叙事自然度'}`, workType: 'novel' })
      if (!gen.success) throw new Error(gen.error || '修复失败')
      summaries.push(`${ch.title} 已修复`)
    } else {
      onProgress?.(`正在优化目标匹配「${ch.title}」`)
      const gen = await generateBeatBody(workId, chapterId, { signal, goalDescription: goal, extraHint: plan.hint || '强化创作目标匹配度', workType: 'novel' })
      if (!gen.success) throw new Error(gen.error || '优化失败')
      summaries.push(`${ch.title} 已优化`)
    }
  }
  return summaries.join('；') || '无需修复'
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
    fullConfig = { ...saved, ...extractStoryGoalModelPatch(config) }
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
    fullConfig = { ...saved, ...extractStoryGoalModelPatch(config) }
    turn = existing.turn_count ?? 0
    phase = explicitPhase
    if (existing.status === 'timeout' || turn >= fullConfig.maxTurns) {
      turn = 0
    }
  } else {
    fullConfig = { ...DEFAULT_STORY_GOAL_CONFIG, ...config }
    turn = 0
    phase = explicitPhase ?? (fullConfig.incubatorEnabled ? 'incubate_outline' : 'materialize_settings')
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
          const count = await materializeNovelSettings(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'settings', summary: `生成 ${count} 项核心设定`
          })
          emit(`生成 ${count} 项核心设定`, 'running')
          phase = 'generate_character_cards'
        } else if (phase === 'generate_character_cards') {
          emit('正在生成主角人设卡片', 'running')
          const count = await generateNovelCharacterCards(workId, controller.signal)
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'character_cards', summary: `生成 ${count} 张主角人设卡片`
          })
          emit(`生成 ${count} 张主角人设卡片`, 'running')
          phase = 'generate_beats'
        } else if (phase === 'generate_beats') {
          const res = await generateNovelBeats(workId, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'beats',
            summary: res.created > 0 ? `生成 ${res.created} 个章节大纲` : `复用 ${res.reused} 个已有章节`
          })
          emit(res.created > 0 ? `生成 ${res.created} 个章节大纲` : `复用 ${res.reused} 个已有章节`, 'running')
          phase = 'overall_self_check'
        } else if (phase === 'overall_self_check') {
          emit('正在运行整体自检', 'running')
          const report = await runNovelOverallSelfCheck(workId, controller.signal)
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'overall_check', summary: report
          })
          emit(`整体自检完成：${report}`, 'running')
          phase = 'generate_title_hook'
        } else if (phase === 'generate_title_hook') {
          emit('正在生成书名和导语', 'running')
          const picked = await generateNovelTitleHook(workId, fullConfig.goalDescription, controller.signal)
          workDAO.update(workId, { title: picked.title, description: picked.hook || undefined })
          goalRoutineDAO.appendTurn({
            work_id: workId, turn_no: turn, phase, action: 'title_hook', summary: `应用书名「${picked.title}」`
          })
          emit(`已应用书名「${picked.title}」`, 'running')
          phase = 'draft_body'
        } else if (phase === 'draft_body') {
          const chapter = nextEmptyChapter(workId)
          if (!chapter) {
            emit('正文已全部生成，进入目标验收', 'running')
            phase = 'goal_check'
          } else {
            emit(`正在生成正文「${chapter.title}」`, 'running')
            const gen = await generateBeatBody(workId, chapter.id, { signal: controller.signal, goalDescription: fullConfig.goalDescription, workType: 'novel' })
            if (!gen.success) throw new Error(gen.error || '正文生成失败')
            const mem = gen.memoryExtracted
            const memMsg = mem ? ` · 记忆体：+${mem.planted}伏笔/${mem.snapshots}快照/${mem.foreshadowingResolved}回收` : ''
            goalRoutineDAO.appendTurn({
              work_id: workId, turn_no: turn, phase, action: 'draft',
              target_chapter_id: chapter.id,
              summary: `生成「${chapter.title}」${gen.wordCount}字${memMsg}`
            })
            emit(`生成「${chapter.title}」${gen.wordCount}字${memMsg}`, 'running')

            if (fullConfig.diagnoseBodyAfterGeneration && fullConfig.qualityMin > 0) {
              const diagResult = await diagnoseAndFixUntilPass(workId, chapter.id, fullConfig.qualityMin, controller.signal, msg => emit(msg, 'running'))
              const cleaned = cleanupEmDashesAfterPassedGate(workId, 'comma')
              const cleanMsg = cleaned.replaced > 0 ? `；破折号已替换 ${cleaned.replaced} 处` : ''
              goalRoutineDAO.appendTurn({
                work_id: workId, turn_no: turn, phase, action: 'diagnose_fix',
                target_chapter_id: chapter.id,
                score: diagResult.finalScore >= 0 ? diagResult.finalScore : null,
                summary: diagResult.passed
                  ? `「${chapter.title}」诊断通过（${diagResult.finalScore}分，${diagResult.rounds}轮）${cleanMsg}`
                  : `「${chapter.title}」诊断未完全通过（${diagResult.finalScore}分，${diagResult.rounds}轮）${cleanMsg}`
              })
            }

            phase = nextEmptyChapter(workId) ? 'draft_body' : 'goal_check'
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
                work_id: workId, turn_no: turn, phase, action: 'deai',
                summary: `门禁通过后自动替换破折号：${cleanup.chapters} 个章节 ${cleanup.replaced} 处`
              })
              emit(`门禁通过后已自动替换破折号：${cleanup.chapters} 个章节 ${cleanup.replaced} 处`, 'running')
              lastCheck = await checkStoryGoal(workId, fullConfig, controller.signal)
            }

            goalRoutineDAO.setStatus(workId, 'goal_met')
            emit(`目标达成：质量${lastCheck.qualityScore} · 目标匹配${lastCheck.goalMatchScore} · 章节${lastCheck.contentBeats}/${lastCheck.totalBeats} · 字数${lastCheck.totalWords}`, 'goal_met')
            return
          }

          emit(`未达标：${lastCheck.reasons.join('；')}`, 'running')
          phase = 'repair_plan'
        } else if (phase === 'repair_plan') {
          const plan = buildNovelRepairPlan(workId, lastCheck!)
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
          const plan = parsed.repairPlan ?? buildNovelRepairPlan(workId, lastCheck!)
          emit(`正在执行修复：${plan.action}`, 'running')
          const summary = await executeNovelRepairPlan(workId, plan, fullConfig.goalDescription, controller.signal, msg => emit(msg, 'running'))
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
      }
    }

    goalRoutineDAO.setStatus(workId, 'timeout')
    emit(`已达轮次上限 ${fullConfig.maxTurns}，停止`, 'timeout')
  } finally {
    clearGoalLoopModelOpts(workId)
    activeLoops.delete(workId)
  }
}
