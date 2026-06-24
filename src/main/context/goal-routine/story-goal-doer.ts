/**
 * 短故事目标循环的 Doer —— 主进程 headless 正文生成。
 * 复刻 GeneratePanel.generateBody 的 prompt 构造，但走 modelService.chat 无渲染层。
 * context-budget.ts 在 step=body_generation + workId 时自动注入 anti-ai 规则/人设/文风。
 *
 * 目标驱动：用户自由文字目标注入 prompt，引导生成贯彻题材/风格/情节。
 * 仅轻量 humanize（不掺重的 autoRewrite）——去AI 由 checker 判定、fix 阶段针对性处理。
 */
import { modelService } from '../../model'
import { volumeChapterDAO } from '../../db'
import { normalizeModelBodyOutput } from '../../../shared/normalize-body-text'
import { formatBodyWordTargetLine } from '../../../shared/body-word-target'
import { STORY_BODY_GENERATION_SYSTEM } from '../../../shared/body-generation-prompt'
import { humanizeText } from '../humanize-text'
import { loadWritingPlan } from '../writing-plan'

export interface BeatGenResult {
  success: boolean
  content: string
  wordCount: number
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

  // 仅轻量 humanize（正则级），不掺重的 autoRewrite
  try {
    content = humanizeText(content)
  } catch { /* humanize 失败不阻断 */ }

  const wordCount = countWords(content)

  // 写库：updateChapterWithVersion 自动存版本快照（安全 guardrail）
  volumeChapterDAO.updateChapterWithVersion(chapterId, {
    content,
    word_count: wordCount,
    status: 'completed'
  })

  return { success: true, content, wordCount }
}
