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
import { coreSettingDAO, storyHarnessDAO, volumeChapterDAO, workDAO } from '../../db'
import {
  parseStoryQualityAiScoreBreakdown,
  recognizeStoryQualityHardFail,
  type StoryQualityAiScoreBreakdown,
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
import {
  assessWholeStory,
  type StoryForensicIssue,
  type StoryWeakestLayer
} from './story-whole-evaluator'
import { assessWholeNovel } from './novel-whole-evaluator'
import type { NovelSystemIssue } from '../../../shared/novel-systemic-types'
import type { EmotionBlindAssessment } from '../../../shared/emotion-contract'
import {
  ensureChapterEmotionOutcome,
  emotionContentHash,
  isEmotionAssessmentAcceptedForTransition,
  isEmotionOutcomeComplete,
  parseStoredEmotionAssessment
} from './emotion-gate'
import { ensureChapterEmotionContract } from './emotion-engine'
import {
  parseCachedQualityAssessment,
  serializeQualityAssessment
} from './chapter-assessment-cache'
import {
  detectStorySettingContradictions,
  detectStoryTextIntegrityIssues,
  shouldBlockStoryAntiAi,
  type StoryHarnessIssue,
  type StoryHarnessScope
} from '../../../shared/story-harness'
import {
  assessStoryReleaseReview,
  type StoryReleasePromiseAssessment,
  type StoryComplianceAssessment
} from './story-release-review'
import { validateStoryContinuityContracts } from '../../../shared/story-hard-guards'

export interface StoryGoalConfig {
  /** 用户自由文字目标（题材/风格/情节要求）——驱动生成并参与最终语义验收 */
  goalDescription: string
  /** 完成度：所有节拍都有正文 */
  requireAllBeatsContent: boolean
  /** 完成度：总字数达标（null=用作品 writing plan 的 targetTotalWords；0=不卡） */
  targetTotalWords: number | null
  /** 每章/每拍目标字数（null=用 writing plan；会写入合同字数门禁） */
  wordsPerChapter: number | null
  /**
   * 单章字数门禁容差（0.05–1，表示 ±5%–±100%）。
   * 默认 0.25，与质量硬失败口径一致；过窄会导致偏长章节反复无法提交。
   */
  wordCountTolerance: number
  /** 质量分下限（quality:diagnoseAI 的 scoreTotal，0-100） */
  qualityMin: number
  /** 小说正文各质量单项的独立下限 */
  qualityMetricMins: Record<QualityAiMetricKey, number>
  /** 正文生成后是否立即运行 AI 诊断与修复（关闭则直接进入下一节拍） */
  diagnoseBodyAfterGeneration: boolean
  /** 是否把章节情绪合同作为生成与因果规划的硬约束 */
  checkEmotionContract: boolean
  /** 是否执行情绪门禁/编辑审读；关闭后不产生情绪阻塞或情绪编辑债务 */
  checkEmotionGate: boolean
  /** 书名导语盲评后是否暂停，由作者从候选中确认 */
  humanReviewTitleHook: boolean
  /** 门禁：每章 runConsistencyGate 通过（无 blockers） */
  checkConsistencyGate: boolean
  /** 去AI：anti-AI 规则零违规 */
  checkAntiAiRules: boolean
  /** 轮次硬上限（文章强调整必须封顶） */
  maxTurns: number
  /** 无人值守执行周期上限；每周期达到 maxTurns 后自动从持久化检查点开启下一周期 */
  autonomousMaxEpochs: number
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
  /** 小说目标循环：用户是否明确要求生成并校验金手指设定 */
  goldenFingerRequired: boolean
  /** 正文工作台右上角所选模型（与手动正文生成一致） */
  modelType?: string
  modelName?: string
  thinkingEnabled?: boolean
}

export const DEFAULT_STORY_GOAL_CONFIG: StoryGoalConfig = {
  goalDescription: '',
  requireAllBeatsContent: true,
  targetTotalWords: null,
  wordsPerChapter: null,
  wordCountTolerance: 0.25,
  qualityMin: 85,
  qualityMetricMins: Object.fromEntries(
    QUALITY_AI_METRIC_DEFS.map(metric => [metric.key, 85])
  ) as Record<QualityAiMetricKey, number>,
  diagnoseBodyAfterGeneration: true,
  checkEmotionContract: true,
  checkEmotionGate: true,
  humanReviewTitleHook: false,
  checkConsistencyGate: true,
  checkAntiAiRules: true,
  maxTurns: 60,
  autonomousMaxEpochs: 20,
  goalMatchMin: 85,
  overallStoryMin: 80,
  previewHookMin: 75,
  proseReadMin: 78,
  previewRatio: 0.3,
  incubatorEnabled: false,
  goldenFingerRequired: false
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
  storyHardBlockers: string[]
  forensicIssues: StoryForensicIssue[]
  harnessIssues: StoryHarnessIssue[]
  systemicIssues: NovelSystemIssue[]
  previewReport: string | null
  chapterDiagnostics: GoalChapterDiagnostic[]
  evaluatorFailure: { code: 'QUALITY_EVALUATOR_UNAVAILABLE' | 'QUALITY_EVALUATOR_PROTOCOL'; message: string } | null
  releasePromise: StoryReleasePromiseAssessment | null
  compliance: StoryComplianceAssessment | null
  releaseSourceHash: string
  /** 不阻断发布的编辑建议；不得参与 met 或自动回退判定。 */
  advisories: string[]
  /** 只包含可由合同、原文证据或评估器可用性证明的发布阻塞。 */
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
  qualityMin: number,
  options: { finalBeat?: boolean } = {}
): string[] {
  const criticalFloor = Math.max(60, qualityMin - 15)
  return items
    .filter(item => STORY_CRITICAL_METRICS.has(item.key)
      && !(options.finalBeat && item.key === 'hook_density')
      && item.score < criticalFloor)
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
  const advisories: string[] = []
  let evaluatorFailure: GoalCheckResult['evaluatorFailure'] = null
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const fullBody = collectFullBody(workId)
  const isStory = workDAO.getById(workId)?.work_type === 'story'
  const releaseSourceHashBefore = isStory ? storyHarnessDAO.releaseSourceHash(workId) : ''
  const harnessIssues: StoryHarnessIssue[] = []
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
  } else if (!isStory && expectedChapters > 0 && !chapterPlanComplete) {
    reasons.push(`章节数量不完整：${total}/${expectedChapters}`)
  } else if (config.requireAllBeatsContent && content < total) {
    reasons.push(`节拍未全部完成：${content}/${total} 有正文`)
  }

  // ---- 1.5 确定性完整性与设定矛盾：先于所有模型评分执行 ----
  if (isStory) {
    const storyPovModes = chapters.map(chapter => chapter.pov_mode?.trim() ?? '')
    if (storyPovModes.some(mode => !mode)) {
      reasons.push('全篇叙事视角合同未冻结：存在缺少 pov_mode 的节拍')
    } else if (new Set(storyPovModes).size > 1) {
      reasons.push(`全篇叙事视角漂移：${[...new Set(storyPovModes)].join('、')}`)
    }
    chapters.forEach((chapter, index) => {
      if (!chapter.content?.trim()) return
      let povCharacter = ''
      try {
        const names = JSON.parse(chapter.characters ?? '[]') as unknown
        if (Array.isArray(names)) povCharacter = String(names[0] ?? '').trim()
      } catch { /* 非 JSON 角色字段交给其他门禁处理 */ }
      harnessIssues.push(...detectStoryTextIntegrityIssues(chapter.content, {
        chapterId: chapter.id,
        finalBeat: index === chapters.length - 1,
        povMode: chapter.pov_mode,
        povCharacter
      }))
    })
    const settings = coreSettingDAO.listByWork(workId)
      .map(row => `${row.type}\n${row.content}`)
      .join('\n')
    const engineStructured = coreSettingDAO.getByType(workId, 'story_engine')?.structured_content
    let settingResolutions = ''
    if (engineStructured?.trim()) {
      try {
        const engine = JSON.parse(engineStructured) as Record<string, unknown>
        settingResolutions = Array.isArray(engine.setting_resolutions)
          ? engine.setting_resolutions.map(String).join('\n')
          : ''
      } catch { /* 旧版 story_engine 没有结构化消歧，按未解决处理 */ }
    }
    harnessIssues.push(...detectStorySettingContradictions(`${settings}\n${fullBody}`, settingResolutions))
    const storedContinuity = chapters.map(chapter => {
      try {
        const parsed = chapter.outline_diagnosis
          ? JSON.parse(chapter.outline_diagnosis) as {
              continuity_contract?: Record<string, unknown>
              tension_plan?: { payoff_type: string }
            }
          : {}
        return {
          continuity_contract: parsed.continuity_contract ?? null,
          tension_plan: parsed.tension_plan ?? null
        }
      } catch {
        return { continuity_contract: null, tension_plan: null }
      }
    })
    for (const issue of validateStoryContinuityContracts(storedContinuity)) {
      const indexes = [...issue.matchAll(/第(\d+)拍/g)]
        .map(match => Number(match[1]) - 1)
        .filter(index => index >= 0 && index < chapters.length)
      harnessIssues.push({
        code: 'CONTINUITY_CONTRACT_INVALID',
        severity: 'blocker',
        scope: indexes.length > 1 ? 'cluster' : 'beat',
        chapterIds: [...new Set(indexes.map(index => chapters[index].id))],
        evidence: [issue],
        message: issue,
        expectedResult: '相邻拍必须联动修复，并在同一事务提交；exit_boundary 必须与下一拍 entry_boundary 完全相等',
        invariants: ['未进入相邻边界簇的节拍不得改写']
      })
    }
    const deterministicBlockers = harnessIssues.filter(issue => issue.severity === 'blocker')
    if (deterministicBlockers.length > 0) {
      reasons.push(`确定性成稿门禁 ${deterministicBlockers.length} 项阻塞：${deterministicBlockers.map(issue => `${issue.code}/${issue.message}`).join('；')}`)
    }
  }

  // ---- 2. 完成度：字数（与单章正文共用容差口径） ----
  const totalWords = getWritingStats(workId).totalWords
  const targetWords = config.targetTotalWords ?? loadWritingPlan(workId).targetTotalWords
  if (targetWords > 0 && !isTotalWordCountInTargetRange(totalWords, targetWords, config.wordCountTolerance)) {
    const { min, max } = bodyWordCountBounds(targetWords, config.wordCountTolerance)
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

  if (chapterPlanComplete && isStory && content > 0 && content === total && config.qualityMin > 0) {
    if (signal?.aborted) throw new Error('已取消')
    try {
      const scores: number[] = []
      let anyHardFail = false
      const allMetricFailures: string[] = []
      const invalidDiagnostics: string[] = []
      const protocolDiagnostics: string[] = []
      const qualityChapters = isStory ? chapters : selectNovelQualitySample(chapters)
      for (const [index, ch] of qualityChapters.entries()) {
        if (signal?.aborted) throw new Error('已取消')
        const contentText = ch.content ?? ''
        const parsedCache = parseCachedQualityAssessment(ch.quality_assessment_json, contentText)
        const cachedBreakdown = isStory && parsedCache?.report
          ? parseStoryQualityAiScoreBreakdown(parsedCache.report)
          : null
        const cached = isStory && parsedCache?.hardFail
          && (!cachedBreakdown || !recognizeStoryQualityHardFail(cachedBreakdown, contentText).recognized)
          ? null
          : parsedCache
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
        const diag = chapterDiagnostics.find(d => d.chapterId === ch.id)
        if (res.success && typeof res.scoreTotal === 'number') {
          scores.push(res.scoreTotal)
          const breakdown = res.report ? parseBreakdown(res.report) : null
          const recognizedHardFail = isStory && res.hardFail
            ? (breakdown
                ? recognizeStoryQualityHardFail(
                    breakdown as StoryQualityAiScoreBreakdown,
                    contentText
                  ).recognized
                : false)
            : !!res.hardFail
          if (isStory && res.hardFail && !recognizedHardFail) {
            protocolDiagnostics.push(`${ch.title}:hard_fail 缺少受支持规则和可定位原文证据`)
          }
          if (diag) {
            diag.qualityScore = res.scoreTotal
            diag.qualityHardFail = recognizedHardFail
          }
          if (recognizedHardFail) anyHardFail = true

          if (breakdown) {
            if (isStory) {
              for (const failed of failedCriticalStoryMetrics(
                breakdown.items as StoryQualityAiScoreItem[],
                config.qualityMin,
                { finalBeat: ch.id === chapters[chapters.length - 1]?.id }
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
          if (!cached && (!isStory || !res.hardFail || recognizedHardFail)) {
            volumeChapterDAO.updateChapter(ch.id, {
              quality_assessment_json: serializeQualityAssessment({
                content: contentText,
                scoreTotal: res.scoreTotal,
                hardFail: recognizedHardFail,
                report: res.report
              })
            })
          }
        } else {
          const error = 'error' in res && typeof res.error === 'string'
            ? res.error
            : '未返回有效分数'
          invalidDiagnostics.push(`${ch.title}:${error}`)
        }
      }
      if (protocolDiagnostics.length > 0) {
        advisories.push(`逐拍质量建议器证据协议无效，未参与发布硬门禁：${protocolDiagnostics.join('；')}`)
      } else if (invalidDiagnostics.length > 0) {
        advisories.push(`逐拍质量建议器不可用，未参与发布硬门禁：${invalidDiagnostics.join('；')}`)
      }
      if (scores.length > 0) {
        qualityScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        qualityHardFail = anyHardFail
        if (qualityHardFail) {
          reasons.push('存在硬失败章节（质量门禁致命项）')
        } else if (allMetricFailures.length > 0) {
          const message = `质量承重项建议优化：${allMetricFailures.join('、')}`
          if (isStory) advisories.push(message)
          else reasons.push(message)
        } else if (qualityScore < config.qualityMin) {
          const message = `质量分 ${qualityScore} 低于建议线 ${config.qualityMin}`
          if (isStory) advisories.push(message)
          else reasons.push(message)
        }
      } else if (invalidDiagnostics.length === 0) {
        advisories.push('逐拍质量建议器未返回有效分数，未参与发布硬门禁')
      }
    } catch (e) {
      if (signal?.aborted) throw e
      const message = e instanceof Error ? e.message : String(e)
      advisories.push(`逐拍质量建议器不可用，未参与发布硬门禁：${message}`)
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
      const blockingChapters = isStory
        ? chapterDiagnostics.filter(diag => shouldBlockStoryAntiAi(diag.antiAiViolations, diag.wordCount))
        : chapterDiagnostics.filter(diag => diag.antiAiViolations > 0)
      if (blockingChapters.length > 0) {
        reasons.push(`anti-AI 规则达到阻塞阈值：${blockingChapters.map(diag => `${diag.title}${diag.antiAiViolations}处`).join('、')}`)
      }
    }
  }

  // ---- 6. 独立情绪盲读门禁（不再信任正文模型自报 intensity） ----
  const emotionScores: number[] = []
  const emotionFailures: string[] = []
  const emotionAdvisories: string[] = []
  if (config.checkEmotionGate && chapterPlanComplete && isStory && content > 0) {
    for (const [index, chapter] of chapters.entries()) {
      if (!chapter.content?.trim()) continue
      const diagnostic = chapterDiagnostics.find(item => item.chapterId === chapter.id)
      let assessment: EmotionBlindAssessment | null = parseStoredEmotionAssessment(chapter.emotion_assessment_json)
      const needsOutcome = !assessment
        || (isEmotionAssessmentAcceptedForTransition(assessment)
          && !isEmotionOutcomeComplete(chapter.id, chapter.content, chapter.emotion_assessment_json))
        || (assessment.outcome_meta?.content_hash != null
          && assessment.outcome_meta.content_hash !== emotionContentHash(chapter.content))
      if (needsOutcome) {
        onProgress?.(`目标验收：正在补充情绪盲读 ${index + 1}/${chapters.length}「${chapter.title}」`)
        await ensureChapterEmotionContract(workId, chapter.id, config.goalDescription, signal)
        assessment = await ensureChapterEmotionOutcome(workId, chapter.id, chapter.content, signal)
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
      if (!isEmotionAssessmentAcceptedForTransition(assessment)) {
        const message = `${chapter.title}:${assessment.score}分/${assessment.failure_layer}层`
        if (isStory && (assessment.blocking_issues ?? []).length === 0) {
          emotionAdvisories.push(message)
        } else {
          emotionFailures.push(message)
        }
      }
    }
  }
  const emotionScore = emotionScores.length > 0
    ? Math.round(emotionScores.reduce((sum, score) => sum + score, 0) / emotionScores.length)
    : -1
  if (emotionFailures.length > 0) reasons.push(`情绪门禁未通过：${emotionFailures.slice(0, 8).join('、')}`)
  if (emotionAdvisories.length > 0) {
    advisories.push(`情绪盲读建议优化：${emotionAdvisories.slice(0, 8).join('、')}`)
  }

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
  let storyHardBlockers: string[] = []
  let forensicIssues: StoryForensicIssue[] = []
  let systemicIssues: NovelSystemIssue[] = []
  let releasePromise: StoryReleasePromiseAssessment | null = null
  let compliance: StoryComplianceAssessment | null = null

  if (chapterPlanComplete && isStory && content > 0 && content === total
    && (config.goalMatchMin > 0 || config.overallStoryMin > 0 || config.previewHookMin > 0 || config.proseReadMin > 0)) {
    try {
      const assessment = await assessWholeStory(workId, config, signal, onProgress)
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
      storyHardBlockers = assessment.hardBlockers
      forensicIssues = assessment.forensicIssues
      const forensicEvaluatorError = forensicIssues.find(issue => issue.code === 'FORENSIC_EVALUATOR_ERROR')
      if (forensicEvaluatorError) {
        evaluatorFailure = {
          code: forensicEvaluatorError.evaluatorFailureCode ?? 'QUALITY_EVALUATOR_PROTOCOL',
          message: forensicEvaluatorError.message
        }
      }
      const chapterIdsByTitle = new Map(chapters.map(chapter => [chapter.title, chapter.id]))
      for (const issue of forensicIssues) {
        if (issue.code === 'FORENSIC_EVALUATOR_ERROR') continue
        const scope: StoryHarnessScope = issue.scope === 'beat_cluster'
          ? 'cluster'
          : issue.scope === 'story_engine'
            ? 'engine'
            : issue.scope
        harnessIssues.push({
          code: issue.code,
          severity: 'blocker',
          scope,
          chapterIds: issue.chapterTitles
            .map(title => chapterIdsByTitle.get(title))
            .filter((id): id is number => id != null),
          evidence: issue.evidence,
          message: issue.message,
          expectedResult: issue.recommendedAction,
          invariants: ['未被证据点名的正文与既有事实保持不变'],
          identityHint: issue.claimKey
        })
      }

      if (storyHardBlockers.length > 0 && !forensicEvaluatorError) {
        reasons.push(`整篇法医审计发现 ${storyHardBlockers.length} 项硬伤：${storyHardBlockers.join('；')}`)
      }
      if (forensicEvaluatorError) {
        const label = forensicEvaluatorError.evaluatorFailureCode === 'QUALITY_EVALUATOR_UNAVAILABLE'
          ? '不可用'
          : '协议失败'
        reasons.push(`法医评估器${label}：${forensicEvaluatorError.message}`)
      }

      if (config.goalMatchMin > 0 && config.goalDescription.trim() && goalMatchScore < config.goalMatchMin) {
        advisories.push(`创作目标匹配度 ${goalMatchScore} 低于建议线 ${config.goalMatchMin}：${goalMatchReason}`)
      }
      if (config.overallStoryMin > 0 && overallStoryScore < config.overallStoryMin) {
        advisories.push(`整篇结构与兑现 ${overallStoryScore} 低于建议线 ${config.overallStoryMin}：${overallStoryReason}`)
      }
      if (config.previewHookMin > 0 && previewHookScore < config.previewHookMin) {
        advisories.push(`试读追读力 ${previewHookScore} 低于建议线 ${config.previewHookMin}：${previewHookReason}`)
      }
      if (config.proseReadMin > 0 && proseReadScore < config.proseReadMin) {
        advisories.push(`原文盲读 ${proseReadScore} 低于建议线 ${config.proseReadMin}：${proseReadReason}`)
      }
    } catch (e) {
      if (signal?.aborted) throw e
      storyIssues = [e instanceof Error ? e.message : String(e)]
      evaluatorFailure = {
        code: /JSON|结构化|协议|解析/.test(storyIssues[0])
          ? 'QUALITY_EVALUATOR_PROTOCOL'
          : 'QUALITY_EVALUATOR_UNAVAILABLE',
        message: storyIssues[0]
      }
      reasons.push(`整篇评估器不可用：${storyIssues[0]}`)
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
      systemicIssues = assessment.systemicIssues
      storyHardBlockers = systemicIssues
        .filter(issue => issue.severity === 'blocker')
        .map(issue => `${issue.code}：${issue.message}`)
      weakestLayer = 'storyline'
      if (storyHardBlockers.length > 0) {
        reasons.push(`整书确定性审计发现 ${storyHardBlockers.length} 项硬伤：${storyHardBlockers.join('；')}`)
      }
      const systemicWarnings = systemicIssues.filter(issue => issue.severity === 'warning')
      if (systemicWarnings.length > 0) {
        advisories.push(`整书模式审计建议 ${systemicWarnings.length} 项：${systemicWarnings.map(issue => `${issue.code}：${issue.message}`).join('；')}`)
      }
      if (config.goalMatchMin > 0 && config.goalDescription.trim() && goalMatchScore < config.goalMatchMin) {
        advisories.push(`创作目标匹配度 ${goalMatchScore} 低于建议线 ${config.goalMatchMin}：${goalMatchReason}`)
      }
      if (config.overallStoryMin > 0 && overallStoryScore < config.overallStoryMin) {
        advisories.push(`整书结构与兑现 ${overallStoryScore} 低于建议线 ${config.overallStoryMin}：${overallStoryReason}`)
      }
      if (config.previewHookMin > 0 && previewHookScore < config.previewHookMin) {
        advisories.push(`长篇追读力 ${previewHookScore} 低于建议线 ${config.previewHookMin}：${previewHookReason}`)
      }
      if (config.proseReadMin > 0 && proseReadScore < config.proseReadMin) {
        advisories.push(`跨阶段原文盲读 ${proseReadScore} 低于建议线 ${config.proseReadMin}：${proseReadReason}`)
      }
    } catch (e) {
      if (signal?.aborted) throw e
      goalMatchReason = e instanceof Error ? e.message : String(e)
      advisories.push(`整书独立编辑审读不可用，未参与发布硬门禁：${goalMatchReason}`)
    }
  }

  // ---- 6.5 发布兑现、专业事实与平台合规：独立于生成器的发布硬门禁 ----
  if (chapterPlanComplete && isStory && content > 0 && content === total && !evaluatorFailure) {
    try {
      const releaseReview = await assessStoryReleaseReview(
        workId,
        config.goalDescription,
        signal,
        onProgress
      )
      releasePromise = releaseReview.promise
      compliance = releaseReview.compliance
      harnessIssues.push(...releaseReview.harnessIssues)
      if (!releasePromise.passed) {
        reasons.push(`发布承诺未兑现：${releasePromise.missingPromises.join('；') || '标题、导语、前30%、高潮与结局证据链不完整'}`)
      }
      if (!compliance.passed) {
        reasons.push(`题材事实或平台合规未通过：${compliance.issues.map(issue => `${issue.code}/${issue.message}`).join('；')}`)
      }
    } catch (e) {
      if (signal?.aborted) throw e
      const message = e instanceof Error ? e.message : String(e)
      evaluatorFailure = {
        code: /JSON|结构化|协议|解析/.test(message)
          ? 'QUALITY_EVALUATOR_PROTOCOL'
          : 'QUALITY_EVALUATOR_UNAVAILABLE',
        message
      }
      reasons.push(`发布评估器不可用：${message}`)
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

  if (isStory) storyHarnessDAO.syncIssues(workId, harnessIssues)
  const releaseSourceHash = isStory ? storyHarnessDAO.releaseSourceHash(workId) : ''
  if (isStory && releaseSourceHash !== releaseSourceHashBefore) {
    reasons.push('验收期间标题、导语或正文发生变化，必须对当前版本重新验收')
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
    storyHardBlockers,
    forensicIssues,
    harnessIssues,
    systemicIssues,
    previewReport,
    chapterDiagnostics,
    evaluatorFailure,
    releasePromise,
    compliance,
    releaseSourceHash,
    advisories,
    reasons
  }
}
