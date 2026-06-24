/**
 * 短故事目标检查器（checker）—— loop-engineering 的核心难点。
 * 多维度判定短故事是否达成用户设定的"done"。去AI只是其中一个维度，并非核心。
 *
 * 不自己给自己打分：质量诊断/困惑度检测均与写作模型分离。
 */
import { runPerplexityDetect } from '../../perplexity'
import { checkAntiAiRuleViolations } from '../anti-ai-rules'
import { runConsistencyGate } from '../consistency-gate'
import { getWritingStats } from '../writing-stats'
import { loadWritingPlan } from '../writing-plan'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import { volumeChapterDAO } from '../../db'

export interface StoryGoalConfig {
  /** 用户自由文字目标（题材/风格/情节要求）——驱动生成，checker 不直接判定但记录 */
  goalDescription: string
  /** 完成度：所有节拍都有正文 */
  requireAllBeatsContent: boolean
  /** 完成度：总字数达标（null=用作品 writing plan 的 targetTotalWords；0=不卡） */
  targetTotalWords: number | null
  /** 质量分下限（quality:diagnoseAI 的 scoreTotal，0-100） */
  qualityMin: number
  /** 门禁：每章 runConsistencyGate 通过（无 blockers） */
  checkConsistencyGate: boolean
  /** 去AI：AI 特征占比上限（runPerplexityDetect distribution.ai） */
  aiPercentMax: number
  /** 去AI：anti-AI 规则零违规 */
  checkAntiAiRules: boolean
  /** 轮次硬上限（文章强调整必须封顶） */
  maxTurns: number
}

export const DEFAULT_STORY_GOAL_CONFIG: StoryGoalConfig = {
  goalDescription: '',
  requireAllBeatsContent: true,
  targetTotalWords: null,
  qualityMin: 70,
  checkConsistencyGate: true,
  aiPercentMax: 20,
  checkAntiAiRules: true,
  maxTurns: 30
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
  aiPercent: number
  antiAiViolations: number
  reasons: string[]
}

/** 拼接作品全章节正文，供整文检测 */
function collectFullBody(workId: number): string {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  return chapters
    .map(c => c.content?.trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 对短故事执行多维度目标检查。
 * @param signal 可选取消信号（质量诊断/困惑度检测耗时，支持中断）
 */
export async function checkStoryGoal(
  workId: number,
  config: StoryGoalConfig,
  signal?: AbortSignal
): Promise<GoalCheckResult> {
  const reasons: string[] = []
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const fullBody = collectFullBody(workId)

  // ---- 1. 完成度：节拍 ----
  const total = chapters.length
  const content = chapters.filter(c => c.content?.trim()).length
  const beatCompletion = total > 0 ? content / total : 0
  if (total === 0) {
    reasons.push('尚无节拍')
  } else if (config.requireAllBeatsContent && content < total) {
    reasons.push(`节拍未全部完成：${content}/${total} 有正文`)
  }

  // ---- 2. 完成度：字数 ----
  const totalWords = getWritingStats(workId).totalWords
  const targetWords = config.targetTotalWords ?? loadWritingPlan(workId).targetTotalWords
  if (targetWords > 0 && totalWords < targetWords) {
    reasons.push(`字数不足：${totalWords}/${targetWords}`)
  }

  // ---- 3. 质量（仅当所有节拍都有正文时才做 LLM 诊断，避免对半成品打分） ----
  let qualityScore = -1
  let qualityHardFail = false
  if (content > 0 && content === total && config.qualityMin > 0) {
    if (signal?.aborted) throw new Error('已取消')
    try {
      // 对有正文的章节逐一诊断，取平均分；任一 hardFail 则整体不达标
      const scores: number[] = []
      let anyHardFail = false
      for (const ch of chapters) {
        if (signal?.aborted) throw new Error('已取消')
        const res = await diagnoseChapterQualityAi(workId, ch.id, ch.content ?? '')
        if (res.success && typeof res.scoreTotal === 'number') {
          scores.push(res.scoreTotal)
          if (res.hardFail) anyHardFail = true
        }
      }
      if (scores.length > 0) {
        qualityScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        qualityHardFail = anyHardFail
        if (qualityHardFail) {
          reasons.push('存在硬失败章节（质量门禁致命项）')
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
    }
    if (gateBlockers > 0) {
      reasons.push(`一致性门禁 ${gateBlockers} 项阻塞`)
    }
  }

  // ---- 5. 去AI：AI 特征占比（困惑度模型，与写作模型分离） ----
  let aiPercent = 0
  if (fullBody.trim()) {
    if (signal?.aborted) throw new Error('已取消')
    try {
      const result = await runPerplexityDetect(fullBody)
      aiPercent = Math.round(result.distribution.ai)
      if (aiPercent > config.aiPercentMax) {
        reasons.push(`AI 特征 ${aiPercent}% 超过上限 ${config.aiPercentMax}%`)
      }
    } catch (e) {
      if (signal?.aborted) throw e
      // 困惑度模型不可用时退化为不卡此项，但记录原因
      reasons.push(`困惑度检测失败：${e instanceof Error ? e.message : String(e)}`)
    }
  } else if (total > 0) {
    reasons.push('尚无正文，无法检测 AI 特征')
  }

  // ---- 6. 去AI：anti-AI 规则违规 ----
  let antiAiViolations = 0
  if (config.checkAntiAiRules && fullBody.trim()) {
    antiAiViolations = checkAntiAiRuleViolations(workId, fullBody).length
    if (antiAiViolations > 0) {
      reasons.push(`anti-AI 规则违规 ${antiAiViolations} 处`)
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
    aiPercent,
    antiAiViolations,
    reasons
  }
}
