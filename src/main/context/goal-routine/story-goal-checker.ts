/**
 * 短故事目标检查器（checker）—— loop-engineering 的核心难点。
 * 多维度判定短故事是否达成用户设定的"done"。
 *
 * 不自己给自己打分：质量诊断与写作模型分离。
 * 困惑度检测已移至 AI 实验室手动执行。
 */
import { checkAntiAiRuleViolations } from '../anti-ai-rules'
import { runConsistencyGate } from '../consistency-gate'
import { getWritingStats } from '../writing-stats'
import { loadWritingPlan } from '../writing-plan'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import { volumeChapterDAO, workDAO } from '../../db'
import { modelService } from '../../model'
import { extractJsonText } from '../parse-json-extract'
import { parseStoryQualityAiScoreBreakdown } from '../../../shared/story-quality-score'
import { parseQualityAiScoreReport } from '../../../shared/quality-ai-score'
import { bodyWordCountBounds, isTotalWordCountInTargetRange } from '../../../shared/body-word-target'
import { storyGoalModelOpts } from './story-goal-model'
import { formatPreviewAnchorReport } from '../../../shared/story-preview-anchor'
import { buildStoryMergedText } from '../../../shared/work-terminology'

export interface StoryGoalConfig {
  /** 用户自由文字目标（题材/风格/情节要求）——驱动生成并参与最终语义验收 */
  goalDescription: string
  /** 完成度：所有节拍都有正文 */
  requireAllBeatsContent: boolean
  /** 完成度：总字数达标（null=用作品 writing plan 的 targetTotalWords；0=不卡） */
  targetTotalWords: number | null
  /** 质量分下限（quality:diagnoseAI 的 scoreTotal，0-100） */
  qualityMin: number
  /** 正文生成后是否立即运行 AI 诊断与修复（关闭则直接进入下一节拍） */
  diagnoseBodyAfterGeneration: boolean
  /** 门禁：每章 runConsistencyGate 通过（无 blockers） */
  checkConsistencyGate: boolean
  /** 去AI：anti-AI 规则零违规 */
  checkAntiAiRules: boolean
  /** 轮次硬上限（文章强调整必须封顶） */
  maxTurns: number
  /** 语义验收：用户创作目标匹配度下限（0=不卡） */
  goalMatchMin: number
  /** 试读比例（0-1），目标循环验收时据此计算试读卡点报告 */
  previewRatio: number
  /** 正文工作台右上角所选模型（与手动正文生成一致） */
  modelType?: string
  modelName?: string
  thinkingEnabled?: boolean
}

export const DEFAULT_STORY_GOAL_CONFIG: StoryGoalConfig = {
  goalDescription: '',
  requireAllBeatsContent: true,
  targetTotalWords: null,
  qualityMin: 85,
  diagnoseBodyAfterGeneration: true,
  checkConsistencyGate: true,
  checkAntiAiRules: true,
  maxTurns: 60,
  goalMatchMin: 85,
  previewRatio: 0.3
}

export interface GoalCheckResult {
  met: boolean
  // 完成度
  beatCompletion: number       // 0..1
  totalBeats: number
  contentBeats: number
  totalWords: number
  targetWords: number
  // 质量
  qualityScore: number         // 平均分，0-100；-1=未检测
  qualityHardFail: boolean
  // 门禁
  gateBlockers: number
  // 去AI
  antiAiViolations: number
  goalMatchScore: number
  goalMatchReason: string
  previewReport: string | null
  chapterDiagnostics: GoalChapterDiagnostic[]
  reasons: string[]
}

export interface GoalChapterDiagnostic {
  chapterId: number
  title: string
  wordCount: number
  qualityScore: number
  qualityHardFail: boolean
  gateBlockers: number
}

/** 拼接作品全章节正文，供整文检测 */
function collectFullBody(workId: number): string {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  return chapters
    .map(c => c.content?.trim())
    .filter(Boolean)
    .join('\n\n')
}

async function assessGoalMatch(
  workId: number,
  goalDescription: string,
  fullBody: string,
  config: StoryGoalConfig,
  signal?: AbortSignal
): Promise<{ score: number; reason: string }> {
  const goal = goalDescription.trim()
  if (!goal) return { score: 100, reason: '' }
  if (!fullBody.trim()) return { score: 0, reason: '尚无正文，无法验收创作目标' }
  if (signal?.aborted) throw new Error('已取消')

  const res = await modelService.chat(
    {
      workId,
      step: 'goal_semantic_check',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      systemPrompt: [
        '你是短故事终审编辑。判断正文是否满足用户创作目标，只输出 JSON。',
        'score 为 0-100 的整数，reason 用一句话说明最关键的匹配或偏离。',
        '格式：{"score":80,"reason":"..."}'
      ].join('\n'),
      prompt: [
        `【用户创作目标】\n${goal}`,
        `【待验收正文】\n${fullBody.slice(0, 16000)}`
      ].join('\n\n'),
      thinkingEnabled: storyGoalModelOpts(config).thinkingEnabled
    },
    { stream: false, signal }
  )

  if (!res.success || !res.content?.trim()) {
    return { score: 0, reason: res.error || '创作目标语义验收失败' }
  }

  try {
    const json = extractJsonText(res.content.trim()) ?? res.content.trim()
    const parsed = JSON.parse(json) as Record<string, unknown>
    const rawScore = Number(parsed.score)
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0
    const reason = String(parsed.reason ?? '').trim() || '未返回原因'
    return { score, reason }
  } catch {
    return { score: 0, reason: '创作目标语义验收解析失败' }
  }
}

/**
 * 对短故事执行多维度目标检查。
 * @param signal 可选取消信号（质量诊断耗时，支持中断）
 */
export async function checkStoryGoal(
  workId: number,
  config: StoryGoalConfig,
  signal?: AbortSignal
): Promise<GoalCheckResult> {
  const reasons: string[] = []
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const fullBody = collectFullBody(workId)
  const isStory = workDAO.getById(workId)?.work_type === 'story'
  const parseBreakdown = isStory ? parseStoryQualityAiScoreBreakdown : parseQualityAiScoreReport
  const chapterDiagnostics: GoalChapterDiagnostic[] = chapters.map(ch => ({
    chapterId: ch.id,
    title: ch.title,
    wordCount: ch.word_count || 0,
    qualityScore: -1,
    qualityHardFail: false,
    gateBlockers: 0
  }))

  // ---- 1. 完成度：节拍 ----
  const total = chapters.length
  const content = chapters.filter(c => c.content?.trim()).length
  const beatCompletion = total > 0 ? content / total : 0
  if (total === 0) {
    reasons.push('尚无节拍')
  } else if (config.requireAllBeatsContent && content < total) {
    reasons.push(`节拍未全部完成：${content}/${total} 有正文`)
  }

  // ---- 2. 完成度：字数（±10% 容差，与单章正文一致） ----
  const totalWords = getWritingStats(workId).totalWords
  const targetWords = config.targetTotalWords ?? loadWritingPlan(workId).targetTotalWords
  if (targetWords > 0 && !isTotalWordCountInTargetRange(totalWords, targetWords)) {
    const { min, max } = bodyWordCountBounds(targetWords)
    if (totalWords < min) {
      reasons.push(`字数不足：${totalWords}/${targetWords}（下限 ${min}）`)
    } else if (totalWords > max) {
      reasons.push(`字数超出：${totalWords}/${targetWords}（上限 ${max}）`)
    }
  }

  // ---- 3. 质量（仅当所有节拍都有正文时才做 LLM 诊断，避免对半成品打分） ----
  let qualityScore = -1
  let qualityHardFail = false
  const modelOpts = storyGoalModelOpts(config)

  if (content > 0 && content === total && config.qualityMin > 0) {
    if (signal?.aborted) throw new Error('已取消')
    try {
      const scores: number[] = []
      let anyHardFail = false
      const allMetricFailures: string[] = []
      for (const ch of chapters) {
        if (signal?.aborted) throw new Error('已取消')
        const res = await diagnoseChapterQualityAi(workId, ch.id, ch.content ?? '', { thinkingEnabled: modelOpts?.thinkingEnabled })
        const diag = chapterDiagnostics.find(d => d.chapterId === ch.id)
        if (res.success && typeof res.scoreTotal === 'number') {
          scores.push(res.scoreTotal)
          if (diag) {
            diag.qualityScore = res.scoreTotal
            diag.qualityHardFail = !!res.hardFail
          }
          if (res.hardFail) anyHardFail = true

          const breakdown = res.report ? parseBreakdown(res.report) : null
          if (breakdown) {
            for (const item of breakdown.items) {
              if (item.score < config.qualityMin) {
                allMetricFailures.push(`${ch.title}/${item.label}:${item.score}`)
              }
            }
          }
        }
      }
      if (scores.length > 0) {
        qualityScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        qualityHardFail = anyHardFail
        if (qualityHardFail) {
          reasons.push('存在硬失败章节（质量门禁致命项）')
        } else if (allMetricFailures.length > 0) {
          reasons.push(`质量单项未达标（下限${config.qualityMin}）：${allMetricFailures.join('、')}`)
        } else if (qualityScore < config.qualityMin) {
          reasons.push(`质量分 ${qualityScore} 低于下限 ${config.qualityMin}`)
        }
      } else {
        reasons.push('质量诊断未返回有效分数')
      }
    } catch (e) {
      if (signal?.aborted) throw e
      reasons.push(`质量诊断失败：${e instanceof Error ? e.message : String(e)}`)
    }
  } else if (content > 0 && content < total) {
    reasons.push('节拍未全部完成，暂不进行质量诊断')
  }

  // ---- 4. 门禁：每章一致性门禁（同步，轻量） ----
  let gateBlockers = 0
  if (config.checkConsistencyGate && content > 0) {
    for (const ch of chapters) {
      if (!ch.content?.trim()) continue
      const gate = runConsistencyGate(workId, ch.id, ch.content)
      gateBlockers += gate.blockers.length
      const diag = chapterDiagnostics.find(d => d.chapterId === ch.id)
      if (diag) diag.gateBlockers = gate.blockers.length
    }
    if (gateBlockers > 0) {
      reasons.push(`一致性门禁 ${gateBlockers} 项阻塞`)
    }
  }

  // ---- 5. 去AI：anti-AI 规则违规 ----
  let antiAiViolations = 0
  if (config.checkAntiAiRules && fullBody.trim()) {
    antiAiViolations = checkAntiAiRuleViolations(workId, fullBody).length
    if (antiAiViolations > 0) {
      reasons.push(`anti-AI 规则违规 ${antiAiViolations} 处`)
    }
  }

  let goalMatchScore = config.goalDescription.trim() ? 0 : 100
  let goalMatchReason = ''
  if (config.goalMatchMin > 0 && config.goalDescription.trim() && content > 0 && content === total) {
    try {
      const match = await assessGoalMatch(workId, config.goalDescription, fullBody, config, signal)
      goalMatchScore = match.score
      goalMatchReason = match.reason
      if (goalMatchScore < config.goalMatchMin) {
        reasons.push(`创作目标匹配度 ${goalMatchScore} 低于下限 ${config.goalMatchMin}：${goalMatchReason}`)
      }
    } catch (e) {
      if (signal?.aborted) throw e
      goalMatchReason = e instanceof Error ? e.message : String(e)
      reasons.push(`创作目标语义验收失败：${goalMatchReason}`)
    }
  }

  // ---- 6. 试读卡点报告（全篇正文就绪时计算） ----
  let previewReport: string | null = null
  if (content > 0 && content === total && config.previewRatio > 0) {
    const work = workDAO.getById(workId)
    const mergedText = buildStoryMergedText(work?.description ?? '', chapters.map(c => ({ content: c.content ?? '' })))
    if (mergedText.trim()) {
      previewReport = formatPreviewAnchorReport(mergedText, config.previewRatio)
    }
  }

  const met = reasons.length === 0
  return {
    met,
    beatCompletion,
    totalBeats: total,
    contentBeats: content,
    totalWords,
    targetWords,
    qualityScore,
    qualityHardFail,
    gateBlockers,
    antiAiViolations,
    goalMatchScore,
    goalMatchReason,
    previewReport,
    chapterDiagnostics,
    reasons
  }
}
