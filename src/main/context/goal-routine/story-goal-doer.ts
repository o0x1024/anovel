/**
 * 短故事目标循环的 Doer —— 主进程 headless 正文生成。
 * 复刻 GeneratePanel.generateBody 的 prompt 构造，但走 modelService.chat 无渲染层。
 * context-budget.ts 在 step=body_generation + workId 时自动注入 anti-ai 规则/人设/文风。
 *
 * 目标驱动：用户自由文字目标注入 prompt，引导生成贯彻题材/风格/情节。
 * 仅轻量 humanize（不掺重的 autoRewrite）——去AI 由 checker 判定、fix 阶段针对性处理。
 */
import { modelService } from '../../model'
import { volumeChapterDAO, foreshadowingDAO } from '../../db'
import { normalizeModelBodyOutput } from '../../../shared/normalize-body-text'
import { formatBodyWordTargetLine } from '../../../shared/body-word-target'
import { STORY_BODY_GENERATION_SYSTEM, extractEmotionIntensity } from '../../../shared/body-generation-prompt'
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
import { clearChapterMemoryBeforeExtract } from '../memory-cleanup'
import { appLogger } from '../../logger/app-logger'

export interface BeatGenResult {
  success: boolean
  content: string
  wordCount: number
  memoryExtracted?: { planted: number; resolved: number; snapshots: number; foreshadowingResolved: number; foreshadowingPartial: number }
  error?: string
}

function countWords(s: string): number {
  return s.replace(/\s/g, '').length
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
  extraHint?: string
): string | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const ch = chapters.find(c => c.id === chapterId)
  if (!ch) return null
  const volumes = volumeChapterDAO.listVolumes(workId)
  const vol = volumes.find(v => v.id === ch.volume_id)
  return [
    goalDescription?.trim()
      ? `【本篇创作目标】\n${goalDescription.trim()}\n请在生成本节拍时贯彻该目标（题材/风格/情节走向）。`
      : '',
    extraHint?.trim() ? `【本次修复要求】\n${extraHint.trim()}` : '',
    `分卷：${vol?.name || ''}`,
    vol?.description ? `分卷说明：${vol.description}` : '',
    `章节：${ch.title}`,
    formatBodyWordTargetLine(wordTarget),
    ch.outline
      ? `章节大纲（本章内容指引，非叙事起点；须先衔接上一章结尾再自然展开）：\n${ch.outline}`
      : '（暂无章节大纲，请尽量根据作品上下文创作）'
  ].filter(Boolean).join('\n\n')
}

/**
 * 为指定节拍生成正文：headless 生成 → humanize（仅轻量）→ 写库（带版本快照）。
 * 不掺 autoRewrite；去AI 由 checker 判定、fix 阶段针对性处理。
 * @param signal 取消信号
 * @param goalDescription 用户创作目标
 * @param extraHint 额外修复提示（fix 阶段）
 */
export async function generateBeatBody(
  workId: number,
  chapterId: number,
  signal?: AbortSignal,
  goalDescription?: string,
  extraHint?: string
): Promise<BeatGenResult> {
  const plan = loadWritingPlan(workId)
  const wordTarget = plan.wordsPerChapter || 4000
  const prompt = buildBodyPrompt(workId, chapterId, wordTarget, goalDescription, extraHint)
  if (!prompt) return { success: false, content: '', wordCount: 0, error: '节拍不存在' }

  if (signal?.aborted) return { success: false, content: '', wordCount: 0, error: '已取消' }

  const response = await modelService.chat(
    {
      prompt,
      systemPrompt: STORY_BODY_GENERATION_SYSTEM,
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
    },
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

  return { success: true, content, wordCount, memoryExtracted }
}

async function extractNarrativeMemoryAfterGeneration(
  workId: number,
  chapterId: number,
  content: string,
  signal?: AbortSignal
): Promise<NonNullable<BeatGenResult['memoryExtracted']>> {
  if (signal?.aborted) return { planted: 0, resolved: 0, snapshots: 0, foreshadowingResolved: 0, foreshadowingPartial: 0 }

  // 1. 提取伏笔种植 + 角色快照
  const memRes = await modelService.chat(
    {
      prompt: content,
      systemPrompt: MEMORY_EXTRACT_SYSTEM_PROMPT,
      workId,
      chapterId,
      step: 'memory_extract',
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    },
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
      {
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
      },
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
