/**
 * 短故事目标检查器（checker）—— loop-engineering 的核心难点。
 * 多维度判定短故事是否达成用户设定的"done"。
 *
 * 不自己给自己打分：质量诊断与写作模型分离。
 * 困惑度检测已移至 AI 实验室手动执行。
 */
import { checkAntiAiRuleViolations } from '../anti-ai-rules'
import { runConsistencyGate } from '../consistency-gate'
import { runResourceConstraintGate } from '../resource-ledger'
import { getWritingStats } from '../writing-stats'
import { loadWritingPlan } from '../writing-plan'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import { volumeChapterDAO, workDAO } from '../../db'
import {
  parseStoryQualityAiScoreBreakdown,
  type StoryQualityAiScoreItem,
  type StoryQualityAiMetricKey
} from '../../../shared/story-quality-score'
import {
  QUALITY_AI_METRIC_DEFS,
  parseQualityAiScoreReport,
  type QualityAiMetricKey
} from '../../../shared/quality-ai-score'
import { bodyWordCountBounds, isTotalWordCountInTargetRange } from '../../../shared/body-word-target'
import { storyGoalModelOpts } from './story-goal-model'
import { formatPreviewAnchorReport } from '../../../shared/story-preview-anchor'
import { buildStoryMergedText } from '../../../shared/work-terminology'
import { assessWholeStory, type StoryWeakestLayer } from './story-whole-evaluator'
import { assessWholeNovel } from './novel-whole-evaluator'
import type { EmotionBlindAssessment } from '../../../shared/emotion-contract'
import { assessChapterEmotion } from './emotion-gate'
import { ensureChapterEmotionContract } from './emotion-engine'
import {
  parseCachedQualityAssessment,
  serializeQualityAssessment
} from './chapter-assessment-cache'

export interface StoryGoalConfig {
  /** 用户自由文字目标（题材/风格/情节要求）——驱动生成并参与最终语义验收 */
  goalDescription: string
  /** 完成度：所有节拍都有正文 */
  requireAllBeatsContent: boolean
  /** 完成度：总字数达标（null=用作品 writing plan 的 targetTotalWords；0=不卡） */
  targetTotalWords: number | null
  /** 质量分下限（quality:diagnoseAI 的 scoreTotal，0-100） */
  qualityMin: number
  /** 小说正文各质量单项的独立下限 */
  qualityMetricMins: Record<QualityAiMetricKey, number>
  /** 正文生成后是否立即运行 AI 诊断与修复（关闭则直接进入下一节拍） */
  diagnoseBodyAfterGeneration: boolean
  /** 书名导语盲评后是否暂停，由作者从候选中确认 */
  humanReviewTitleHook: boolean
  /** 门禁：每章 runConsistencyGate 通过（无 blockers） */
  checkConsistencyGate: boolean
  /** 去AI：anti-AI 规则零违规 */
  checkAntiAiRules: boolean
  /** 轮次硬上限（文章强调整必须封顶） */
  maxTurns: number
  /** 语义验收：用户创作目标匹配度下限（0=不卡） */
  goalMatchMin: number
  /** 短故事整篇结构与兑现质量下限（0=不卡） */
  overallStoryMin: number
  /** 试读边界的阶段兑现与追读动力下限（0=不卡） */
  previewHookMin: number
  /** 匿名原文切片盲读下限（0=不卡） */
  proseReadMin: number
  /** 试读比例（0-1），目标循环验收时据此计算试读卡点报告 */
  previewRatio: number
  /** 小说目标循环：是否走大岗孵化器三阶段（incubate/gate/freeze），默认 false */
  incubatorEnabled: boolean
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
  qualityMetricMins: Object.fromEntries(
    QUALITY_AI_METRIC_DEFS.map(metric => [metric.key, 85])
  ) as Record<QualityAiMetricKey, number>,
  diagnoseBodyAfterGeneration: true,
  humanReviewTitleHook: false,
  checkConsistencyGate: true,
  checkAntiAiRules: true,
  maxTurns: 60,
  goalMatchMin: 85,
  overallStoryMin: 80,
  previewHookMin: 75,
  proseReadMin: 78,
  previewRatio: 0.3,
  incubatorEnabled: false
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
  emotionScore: number
  goalMatchScore: number
  goalMatchReason: string
  overallStoryScore: number
  overallStoryReason: string
  previewHookScore: number
  previewHookReason: string
  proseReadScore: number
  proseReadReason: string
  weakestLayer: StoryWeakestLayer
  weakChapterTitles: string[]
  storyIssues: string[]
  previewReport: string | null
  chapterDiagnostics: GoalChapterDiagnostic[]
  reasons: string[]
}

const STORY_CRITICAL_METRICS = new Set<StoryQualityAiMetricKey>([
  'hook_density',
  'dramatic_causality',
  'state_change',
  'outline_coverage',
  'setting_consistency'
])

/**
 * 单项分只拦截真正的承重维度，且使用低于总分线的硬伤门槛。
 * 避免要求 13 项全部达到同一高分，导致模型对评分表过拟合。
 */
export function failedCriticalStoryMetrics(
  items: StoryQualityAiScoreItem[],
  qualityMin: number
): string[] {
  const criticalFloor = Math.max(60, qualityMin - 15)
  return items
    .filter(item => STORY_CRITICAL_METRICS.has(item.key) && item.score < criticalFloor)
    .map(item => `${item.label}:${item.score}`)
}

export interface GoalChapterDiagnostic {
  chapterId: number
  title: string
  wordCount: number
  qualityScore: number
  qualityHardFail: boolean
  gateBlockers: number
  antiAiViolations: number
  antiAiViolationDetails: string[]
  emotionScore: number
  emotionPassed: boolean
}

function selectNovelQualitySample<T>(chapters: T[]): T[] {
  if (chapters.length <= 24) return chapters
  const indexes = new Set<number>([0, 1, chapters.length - 2, chapters.length - 1])
  const step = (chapters.length - 1) / 19
  for (let i = 0; i < 20; i++) indexes.add(Math.round(i * step))
  return [...indexes].sort((a, b) => a - b).map(index => chapters[index])
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
 * @param signal 可选取消信号（质量诊断耗时，支持中断）
 */
export async function checkStoryGoal(
  workId: number,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
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
    gateBlockers: 0,
    antiAiViolations: 0,
    antiAiViolationDetails: [],
    emotionScore: -1,
    emotionPassed: false
  }))

  // ---- 1. 完成度：节拍 ----
  const total = chapters.length
  const content = chapters.filter(c => c.content?.trim()).length
  const beatCompletion = total > 0 ? content / total : 0
  const expectedChapters = loadWritingPlan(workId).targetChapters
  const chapterPlanComplete = isStory || expectedChapters <= 0 || total === expectedChapters
  if (total === 0) {
    reasons.push('尚无节拍')
  } else if (!isStory && expectedChapters > 0 && total !== expectedChapters) {
    reasons.push(`章节数量不完整：${total}/${expectedChapters}`)
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

  if (chapterPlanComplete && content > 0 && content === total && config.qualityMin > 0) {
    if (signal?.aborted) throw new Error('已取消')
    try {
      const scores: number[] = []
      let anyHardFail = false
      const allMetricFailures: string[] = []
      const qualityChapters = isStory ? chapters : selectNovelQualitySample(chapters)
      for (const [index, ch] of qualityChapters.entries()) {
        if (signal?.aborted) throw new Error('已取消')
        const contentText = ch.content ?? ''
        const cached = isStory
          ? null
          : parseCachedQualityAssessment(ch.quality_assessment_json, contentText)
        onProgress?.(
          `目标验收：${cached ? '复用' : '正在抽检'}正文质量 ${index + 1}/${qualityChapters.length}「${ch.title}」`
        )
        const res = cached
          ? {
              success: true,
              scoreTotal: cached.scoreTotal,
              hardFail: cached.hardFail,
              report: cached.report
            }
          : await diagnoseChapterQualityAi(workId, ch.id, contentText, { thinkingEnabled: modelOpts?.thinkingEnabled })
        if (!cached && res.success && typeof res.scoreTotal === 'number') {
          volumeChapterDAO.updateChapter(ch.id, {
            quality_assessment_json: serializeQualityAssessment({
              content: contentText,
              scoreTotal: res.scoreTotal,
              hardFail: !!res.hardFail,
              report: res.report
            })
          })
        }
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
            if (isStory) {
              for (const failed of failedCriticalStoryMetrics(
                breakdown.items as StoryQualityAiScoreItem[],
                config.qualityMin
              )) {
                allMetricFailures.push(`${ch.title}/${failed}`)
              }
            } else {
              for (const item of breakdown.items) {
                const key = item.key as QualityAiMetricKey
                const threshold = config.qualityMetricMins[key]
                if (item.score < threshold) {
                  allMetricFailures.push(`${ch.title}/${item.label}:${item.score}/${threshold}`)
                }
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
          reasons.push(`质量承重项存在硬伤：${allMetricFailures.join('、')}`)
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
      const resourceGate = runResourceConstraintGate(workId, ch.id)
      const chapterBlockers = gate.blockers.length + resourceGate.blockers.length
      gateBlockers += chapterBlockers
      const diag = chapterDiagnostics.find(d => d.chapterId === ch.id)
      if (diag) diag.gateBlockers = chapterBlockers
    }
    if (gateBlockers > 0) {
      reasons.push(`一致性门禁 ${gateBlockers} 项阻塞`)
    }
  }

  // ---- 5. 去AI：anti-AI 规则违规 ----
  let antiAiViolations = 0
  if (config.checkAntiAiRules && fullBody.trim()) {
    for (const ch of chapters) {
      if (!ch.content?.trim()) continue
      const violations = checkAntiAiRuleViolations(workId, ch.content)
      const count = violations.reduce((sum, violation) => sum + Math.max(1, violation.count ?? 1), 0)
      antiAiViolations += count
      const diag = chapterDiagnostics.find(item => item.chapterId === ch.id)
      if (diag) {
        diag.antiAiViolations = count
        diag.antiAiViolationDetails = violations.map(violation => violation.detail)
      }
    }
    if (antiAiViolations > 0) {
      reasons.push(`anti-AI 规则违规 ${antiAiViolations} 处`)
    }
  }

  // ---- 6. 独立情绪盲读门禁（不再信任正文模型自报 intensity） ----
  const emotionScores: number[] = []
  const emotionFailures: string[] = []
  if (chapterPlanComplete && content > 0) {
    for (const [index, chapter] of chapters.entries()) {
      if (!chapter.content?.trim()) continue
      const diagnostic = chapterDiagnostics.find(item => item.chapterId === chapter.id)
      let assessment: EmotionBlindAssessment | null = null
      try {
        assessment = chapter.emotion_assessment_json
          ? JSON.parse(chapter.emotion_assessment_json) as EmotionBlindAssessment
          : null
      } catch { assessment = null }
      if (!assessment) {
        onProgress?.(`目标验收：正在补充情绪盲读 ${index + 1}/${chapters.length}「${chapter.title}」`)
        await ensureChapterEmotionContract(workId, chapter.id, config.goalDescription, signal)
        assessment = await assessChapterEmotion(workId, chapter.id, chapter.content, signal, true)
      }
      if (!assessment) {
        emotionFailures.push(`${chapter.title}:缺少情绪盲读验收`)
        continue
      }
      emotionScores.push(assessment.score)
      if (diagnostic) {
        diagnostic.emotionScore = assessment.score
        diagnostic.emotionPassed = assessment.passed
      }
      if (!assessment.passed) {
        emotionFailures.push(`${chapter.title}:${assessment.score}分/${assessment.failure_layer}层`)
      }
    }
  }
  const emotionScore = emotionScores.length > 0
    ? Math.round(emotionScores.reduce((sum, score) => sum + score, 0) / emotionScores.length)
    : -1
  if (emotionFailures.length > 0) reasons.push(`情绪门禁未通过：${emotionFailures.slice(0, 8).join('、')}`)

  let goalMatchScore = config.goalDescription.trim() ? 0 : 100
  let goalMatchReason = ''
  let overallStoryScore = isStory ? 0 : 100
  let overallStoryReason = ''
  let previewHookScore = isStory ? 0 : 100
  let previewHookReason = ''
  let proseReadScore = isStory ? 0 : 100
  let proseReadReason = ''
  let weakestLayer: StoryWeakestLayer = 'scene'
  let weakChapterTitles: string[] = []
  let storyIssues: string[] = []

  if (chapterPlanComplete && isStory && content > 0 && content === total
    && (config.goalMatchMin > 0 || config.overallStoryMin > 0 || config.previewHookMin > 0 || config.proseReadMin > 0)) {
    try {
      const assessment = await assessWholeStory(workId, config, signal)
      goalMatchScore = assessment.goalMatchScore
      goalMatchReason = assessment.goalMatchReason
      overallStoryScore = assessment.overallStoryScore
      overallStoryReason = assessment.overallStoryReason
      previewHookScore = assessment.previewHookScore
      previewHookReason = assessment.previewHookReason
      proseReadScore = assessment.proseReadScore
      proseReadReason = assessment.proseReadReason
      weakestLayer = assessment.weakestLayer
      weakChapterTitles = assessment.weakChapterTitles
      storyIssues = assessment.issues

      if (config.goalMatchMin > 0 && config.goalDescription.trim() && goalMatchScore < config.goalMatchMin) {
        reasons.push(`创作目标匹配度 ${goalMatchScore} 低于下限 ${config.goalMatchMin}：${goalMatchReason}`)
      }
      if (config.overallStoryMin > 0 && overallStoryScore < config.overallStoryMin) {
        reasons.push(`整篇结构与兑现 ${overallStoryScore} 低于下限 ${config.overallStoryMin}：${overallStoryReason}`)
      }
      if (config.previewHookMin > 0 && previewHookScore < config.previewHookMin) {
        reasons.push(`试读追读力 ${previewHookScore} 低于下限 ${config.previewHookMin}：${previewHookReason}`)
      }
      if (config.proseReadMin > 0 && proseReadScore < config.proseReadMin) {
        reasons.push(`原文盲读 ${proseReadScore} 低于下限 ${config.proseReadMin}：${proseReadReason}`)
      }
    } catch (e) {
      if (signal?.aborted) throw e
      storyIssues = [e instanceof Error ? e.message : String(e)]
      reasons.push(`整篇终审失败：${storyIssues[0]}`)
    }
  } else if (chapterPlanComplete && !isStory && content > 0 && content === total
    && (config.goalMatchMin > 0 || config.overallStoryMin > 0 || config.previewHookMin > 0 || config.proseReadMin > 0)) {
    try {
      onProgress?.('目标验收：正在进行整书结构、目标匹配与跨阶段盲读')
      const assessment = await assessWholeNovel(workId, config.goalDescription, signal)
      goalMatchScore = assessment.goalMatchScore
      goalMatchReason = assessment.goalMatchReason
      overallStoryScore = assessment.overallStoryScore
      overallStoryReason = assessment.overallStoryReason
      previewHookScore = assessment.previewHookScore
      previewHookReason = assessment.previewHookReason
      proseReadScore = assessment.proseReadScore
      proseReadReason = assessment.proseReadReason
      weakChapterTitles = assessment.weakChapterTitles
      storyIssues = assessment.issues
      weakestLayer = 'storyline'
      if (config.goalMatchMin > 0 && config.goalDescription.trim() && goalMatchScore < config.goalMatchMin) {
        reasons.push(`创作目标匹配度 ${goalMatchScore} 低于下限 ${config.goalMatchMin}：${goalMatchReason}`)
      }
      if (config.overallStoryMin > 0 && overallStoryScore < config.overallStoryMin) {
        reasons.push(`整书结构与兑现 ${overallStoryScore} 低于下限 ${config.overallStoryMin}：${overallStoryReason}`)
      }
      if (config.previewHookMin > 0 && previewHookScore < config.previewHookMin) {
        reasons.push(`长篇追读力 ${previewHookScore} 低于下限 ${config.previewHookMin}：${previewHookReason}`)
      }
      if (config.proseReadMin > 0 && proseReadScore < config.proseReadMin) {
        reasons.push(`跨阶段原文盲读 ${proseReadScore} 低于下限 ${config.proseReadMin}：${proseReadReason}`)
      }
    } catch (e) {
      if (signal?.aborted) throw e
      goalMatchReason = e instanceof Error ? e.message : String(e)
      reasons.push(`创作目标语义验收失败：${goalMatchReason}`)
    }
  }

  // ---- 6. 试读卡点报告（全篇正文就绪时计算） ----
  let previewReport: string | null = null
  if (chapterPlanComplete && content > 0 && content === total && config.previewRatio > 0) {
    const work = workDAO.getById(workId)
    const mergedText = buildStoryMergedText(work?.description ?? '', chapters.map(c => ({ content: c.content ?? '' })))
    if (mergedText.trim()) {
      const anchorReport = formatPreviewAnchorReport(mergedText, config.previewRatio)
      previewReport = isStory
        ? [
            `语义追读力：${previewHookScore}/100`,
            previewHookReason ? `终审理由：${previewHookReason}` : '',
            '',
            '以下关键词候选仅用于定位切点，不参与质量通过判定：',
            anchorReport
          ].filter(line => line !== '').join('\n')
        : anchorReport
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
    emotionScore,
    goalMatchScore,
    goalMatchReason,
    overallStoryScore,
    overallStoryReason,
    previewHookScore,
    previewHookReason,
    proseReadScore,
    proseReadReason,
    weakestLayer,
    weakChapterTitles,
    storyIssues,
    previewReport,
    chapterDiagnostics,
    reasons
  }
}
