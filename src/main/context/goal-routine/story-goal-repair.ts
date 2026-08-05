import { BrowserWindow, type WebContents } from 'electron'
import { appLogger } from '../../logger/app-logger'
import {
  volumeChapterDAO,
  goalRoutineDAO,
  coreSettingDAO,
  workDAO,
  appPreferenceDAO,
  storyHarnessDAO
} from '../../db'
import { modelService } from '../../model'
import { CHARACTER_CARDS_AI_PROMPT } from '../writing-techniques'
import { buildWorkContext } from '../work-context'
import { buildSettingsQualityInput, recordQualityCheck } from '../settings-quality'
import { STORY_OVERALL_CHECK_SYSTEM_PROMPT } from '../story-settings-quality'
import { runIncubatorGate } from '../incubator/gate-check'
import { runGateFix } from '../incubator/gate-fix'
import { freezeIncubatorStorylineVersion } from '../incubator/freeze-version'
import {
  parseChapterSuggestions,
  type ContinuityContract,
  type ParsedChapter
} from '../parse-chapters'
import { outlineConstraintsForWordTarget } from '../../../shared/outline-constraints'
import { DEFAULT_WORDS_PER_CHAPTER } from '../../../shared/writing-plan-presets'
import { loadWritingPlan } from '../writing-plan'
import { STORY_INCUBATOR_ANALYSIS_PROMPTS } from '../../../shared/story-incubator-prompts'
import { STORY_SLOT_KEYS, getIncubatorSlotLabel, type IncubatorSlotKey } from '../../../shared/incubator-slots'
import { parseExpansionVersions, type ExpansionVersion } from '../parse-expansion'
import { parseIncubatorVariants, type IncubatorVariant } from '../parse-variants'
import { updateDraftSlotContent } from '../incubator/update-slot'
import { incubatorDraftSlotDAO } from '../../db/dao/incubator'
import {
  checkStoryGoal,
  DEFAULT_STORY_GOAL_CONFIG,
  failedCriticalStoryMetrics,
  type StoryGoalConfig,
  type GoalCheckResult
} from './story-goal-checker'
import {
  commitStoryBodyCandidate,
  generateBeatBody,
  extractNarrativeMemoryAfterGeneration
} from './story-goal-doer'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import {
  parseStoryQualityAiScoreBreakdown,
  recognizeStoryQualityHardFail
} from '../../../shared/story-quality-score'
import { normalizeModelBodyOutput, stripDeterministicAiPatterns } from '../../../shared/normalize-body-text'
import { QUALITY_APPLY_FIXES_PROMPT } from '../chapter-quality'
import { STYLE_REWRITE_INSTRUCTION, countEmDashes, stripEmDashes } from '../anti-ai-rules'
import { runConsistencyGate } from '../consistency-gate'
import {
  bindGoalLoopModelOpts,
  clearGoalLoopModelOpts,
  getGoalLoopModelOpts,
  withGoalLoopModelOptions
} from './story-goal-model'
import {
  GOAL_ROUTINE_PHASE_ORDER,
  isGoalRoutinePhase,
  type GoalRoutinePhase
} from '../../../shared/goal-routine-phases'
import {
  normalizeStoryCategoryTags,
  storyCategoryPromptSection,
  storyCategoryTagsToStorage,
  type StoryCategoryTags
} from '../../../shared/story-category-tags'
import { storyHotWordPromptSection } from '../../../shared/story-hot-words'
import { fuzzyReplace } from '../../../shared/fuzzy-match'
import { parseQualityConclusion, PASS_SCORE_THRESHOLD, type QualityConclusion } from '../settings-quality-conclusion'
import { selectPreferredTitleHook } from './story-pairwise-evaluator'
import {
  parseStructuredModelContent,
  requestStructuredModelOutput
} from './structured-model-output'
import {
  requestQualityEvaluatorEvidence,
  requireQualityEvaluatorEvidence
} from './quality-evaluator-policy'
import { clearChapterNarrativeMemory } from '../memory-cleanup'
import { recordTasteChoice } from '../taste-profile'
import { bodyWordCountBounds, countWords } from '../../../shared/body-word-target'
import { ensureStoryEngine } from './story-engine-gate'
import { ensureStoryContract, formatStoryContractForPrompt, getStoryContract } from './story-contract'
import { EMOTION_CONTRACT_JSON_SHAPE, ensureEmotionEngine } from './emotion-engine'
import {
  EMOTION_CONTRACT_ENUM_RULE,
  validateEmotionContract,
  type EmotionBlindAssessment
} from '../../../shared/emotion-contract'
import {
  assessChapterEmotion,
  emotionRepairHint,
  isEmotionAssessmentAcceptedForTransition
} from './emotion-gate'
import { serializeQualityAssessment } from './chapter-assessment-cache'
import {
  formatGenrePolicy,
  normalizeTensionPlanForBeat,
  resolveStoryGenrePolicy,
  tensionCurveForBeat,
  validateTensionPlans
} from './story-genre-policy'
import {
  filterStoryRepairLedgerIssues,
  routeStoryForensicRepair,
  stalledStoryForensicEscalationCount
} from './story-forensic-repair'
import type { StoryForensicIssue } from './story-whole-evaluator'
import {
  BEAT_CONTRACT_MAX_TOKENS,
  BEAT_SKELETON_MAX_TOKENS,
  BEAT_STAGE_MAX_ATTEMPTS,
  beatGateContractRepairIndexes,
  beatGateIssueSignature,
  beatGateIssuesForIndex,
  beatGateIssuesForLayer,
  beatGateNeedsSkeletonModelRepair,
  beatGateRepairIndexes,
  beatGateResolvedTargetCount,
  type BeatGateRecovery,
  compactBeatSkeletons,
  exactStageCountError,
  mergeStagedBeat,
  mergeStoryBlueprintDiagnosis,
  sanitizeBeatSkeleton,
  storyDeterministicRepairTargets,
  storyBeatStageKey,
  synchronizeStoryBoundaryPairs
} from './story-beat-staging'
import { retentionEvaluationRules, retentionPackagingRules, retentionPlanningRules } from './reader-retention'
import {
  validateStoryBoundaryContracts,
  validateStoryContinuityContracts
} from '../../../shared/story-hard-guards'
import {
  routeStoryContinuityEscalation,
  type StoryContinuityEscalationRoute
} from './story-continuity-escalation'
import type { StoryContinuityRepairEvent } from './story-goal-doer'
import {
  STRUCTURAL_REPAIR_MAX_ATTEMPTS,
  STORY_ROUTINE_FAILURE_LIMIT,
  StructuralRepairError,
  classifyStructuralRepairParseFailure,
  routineFailureSignature,
  structuralRepairTokenBudget
} from './story-structural-repair-policy'
import { GoalPhaseExhaustedError } from './goal-phase-error'
import {
  detectStoryTextIntegrityIssues,
  repairDeterministicStorySentences,
  resolveStoryModelCapability,
  stableStoryHash,
  storyHarnessIssueKey
} from '../../../shared/story-harness'
import { requireGoalTurnLimit } from '../../../shared/goal-turn-limit'
import {
  patchStoryGoalRuntimeState as patchRuntimeState,
  readStoryGoalRuntimeState as readRuntimeState,
  type RepairPlan,
  type TitleHookCandidate
} from './story-goal-runtime'

export type { TitleHookCandidate } from './story-goal-runtime'



function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消')
}

interface EmDashCleanupResult {
  chapters: number
  replaced: number
}

export function cleanupEmDashesAfterPassedGate(workId: number, mode: 'comma' | 'delete' = 'comma'): EmDashCleanupResult {
  const chapters = volumeChapterDAO.listChaptersByWork(workId).filter(c => c.content?.trim())
  let changedChapters = 0
  let replaced = 0

  for (const ch of chapters) {
    const content = ch.content ?? ''
    if (!content.trim()) continue
    const gate = runConsistencyGate(workId, ch.id, content)
    if (gate.blockers.length > 0) continue
    const count = countEmDashes(content)
    if (count <= 0) continue
    const cleaned = stripEmDashes(content, mode)
    if (cleaned === content) continue
    const candidateId = storyHarnessDAO.createCandidate({
      workId,
      chapterId: ch.id,
      content: cleaned,
      wordCount: cleaned.replace(/\s/g, '').length,
      baseContent: content,
      sourceStep: 'deterministic_em_dash_cleanup'
    })
    storyHarnessDAO.markCandidate(candidateId, 'semantic_passed', {
      checks: { deterministicCleanup: 'em_dash', consistencyGate: gate }
    })
    if (!storyHarnessDAO.acceptCandidate(candidateId)) continue
    changedChapters++
    replaced += count
  }

  return { chapters: changedChapters, replaced }
}

/** draft 阶段：取下一个无正文节拍生成正文 */
export function nextEmptyBeat(workId: number): { id: number; title: string } | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const empty = chapters.find(c => !c.content?.trim())
  return empty ? { id: empty.id, title: empty.title } : null
}

/** 旧故事没有 pov_mode 时，从首拍已成文叙述中冻结一次全篇视角。 */
export function ensureFrozenStoryPovModes(workId: number): { mode: string; updated: number } | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  if (chapters.length === 0) return null
  const existingModes = [...new Set(chapters.map(chapter => chapter.pov_mode?.trim()).filter(Boolean) as string[])]
  if (existingModes.length > 1) return null
  const anchor = chapters.find(chapter => chapter.content?.trim())?.content?.trim() ?? ''
  const narration = anchor.replace(/“[^”]*”/g, '')
  const firstPersonSignals = (narration.match(/我(?:们|的|在|要|想|看|听|说|没|不|把|从|向|又|也|就|才|已经|仍|正|刚)?/g) ?? []).length
  const mode = existingModes[0] ?? (firstPersonSignals >= 3 ? 'first' : 'third_limited')
  let updated = 0
  for (const chapter of chapters) {
    if (chapter.pov_mode?.trim()) continue
    volumeChapterDAO.updateChapter(chapter.id, { pov_mode: mode })
    updated++
  }
  return { mode, updated }
}

/** 字数缺口分摊到多个较短节拍，避免把单拍一次膨胀到全篇一半。 */
function shortestBeatsWithWordCounts(
  workId: number,
  limit = 3
): Array<{ id: number; title: string; wordCount: number }> {
  return volumeChapterDAO.listChaptersByWork(workId)
    .filter(chapter => chapter.content?.trim())
    .sort((a, b) => (a.word_count || 0) - (b.word_count || 0))
    .slice(0, Math.max(1, limit))
    .map(chapter => ({ id: chapter.id, title: chapter.title, wordCount: chapter.word_count || 0 }))
}

/** 取正文最长的节拍（总字数超出时优先压缩重写） */
function longestBeat(workId: number): { id: number; title: string } | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId).filter(c => c.content?.trim())
  if (chapters.length === 0) return null
  const longest = chapters.reduce((a, b) =>
    (a.word_count || 0) > (b.word_count || 0) ? a : b
  )
  return { id: longest.id, title: longest.title }
}

interface DiagnoseFixResult {
  passed: boolean
  rounds: number
  finalScore: number
  emotionScore: number
  bestRound: number
  failedMetrics: string[]
  hardBlockers: string[]
  advisories: string[]
}

interface DiagnoseCandidate {
  round: number
  content: string
  qualityScore: number
  qualityReport: string
  emotionScore: number
  hardBlockers: string[]
  advisories: string[]
  failedMetrics: string[]
}

function isBetterDiagnoseCandidate(
  candidate: DiagnoseCandidate,
  current: DiagnoseCandidate | undefined
): boolean {
  if (!current) return true
  if (candidate.hardBlockers.length !== current.hardBlockers.length) {
    return candidate.hardBlockers.length < current.hardBlockers.length
  }
  const candidateFloor = Math.min(candidate.qualityScore, candidate.emotionScore)
  const currentFloor = Math.min(current.qualityScore, current.emotionScore)
  if (candidateFloor !== currentFloor) return candidateFloor > currentFloor
  return candidate.qualityScore + candidate.emotionScore > current.qualityScore + current.emotionScore
}

/**
 * 正文生成后的证据化诊断。
 * 分数只作为编辑建议；只有带原文证据的质量硬伤或情绪因果阻塞才能触发修复。
 */
export async function diagnoseAndFixUntilPass(
  workId: number,
  chapterId: number,
  qualityMin: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<DiagnoseFixResult> {
  let round = 0
  let bestCandidate: DiagnoseCandidate | undefined
  const evaluatorErrors: Array<{ code: 'QUALITY_EVALUATOR_UNAVAILABLE' | 'QUALITY_EVALUATOR_PROTOCOL'; message: string }> = []
  const storyChapters = volumeChapterDAO.listChaptersByWork(workId)
  const chTitle = volumeChapterDAO.getChapter(chapterId)?.title ?? `#${chapterId}`
  const isFinalBeat = storyChapters[storyChapters.length - 1]?.id === chapterId

  const maxRounds = resolveStoryModelCapability(getGoalLoopModelOpts(workId)).maxIssueRepairs + 1
  while (round < maxRounds) {
    assertNotAborted(signal)
    round++

    const ch = volumeChapterDAO.getChapter(chapterId)
    let content = ch?.content?.trim() ?? ''
    if (!content) {
      return {
        passed: false,
        rounds: round,
        finalScore: 0,
        emotionScore: 0,
        bestRound: round,
        failedMetrics: ['无正文'],
        hardBlockers: ['无正文'],
        advisories: []
      }
    }

    const deterministicClean = stripDeterministicAiPatterns(content)
    if (deterministicClean !== content) {
      const committed = await commitStoryBodyCandidate(
        workId,
        chapterId,
        deterministicClean,
        signal,
        onProgress
      )
      if (!committed.success) {
        return {
          passed: false,
          rounds: round,
          finalScore: 0,
          emotionScore: 0,
          bestRound: round,
          failedMetrics: [`确定性清理候选未通过：${committed.error ?? '未知错误'}`],
          hardBlockers: [`确定性清理候选未通过：${committed.error ?? '未知错误'}`],
          advisories: []
        }
      }
      content = committed.content
      onProgress?.(`「${chTitle}」已自动删除形容词回环递进等 AI 典型句式`)
    }

    onProgress?.(`「${chTitle}」AI诊断 第${round}轮`)
    const diagRes = await diagnoseChapterQualityAi(workId, chapterId, content, { thinkingEnabled: getGoalLoopModelOpts(workId).thinkingEnabled })

    if (!diagRes.success) {
      const message = diagRes.error || '质量评估器未返回有效结果'
      evaluatorErrors.push({ code: 'QUALITY_EVALUATOR_UNAVAILABLE', message })
      appLogger.warn('goal_routine', 'AI诊断失败，有限重试且不改写正文', { workId, chapterId, round, error: message })
      onProgress?.(`「${chTitle}」第${round}轮诊断失败，保留正文并重新取证`)
      continue
    }

    const breakdown = diagRes.report ? parseStoryQualityAiScoreBreakdown(diagRes.report) : null
    if (!breakdown) {
      const message = '质量评估器报告缺少完整评分与证据结构'
      evaluatorErrors.push({ code: 'QUALITY_EVALUATOR_PROTOCOL', message })
      onProgress?.(`「${chTitle}」第${round}轮质量证据协议无效，保留正文并重新取证`)
      continue
    }
    const hardFailEvidence = recognizeStoryQualityHardFail(breakdown, content)
    if (diagRes.hardFail && !hardFailEvidence.recognized) {
      const message = 'hard_fail 缺少受支持规则和可定位原文证据'
      evaluatorErrors.push({ code: 'QUALITY_EVALUATOR_PROTOCOL', message })
      onProgress?.(`「${chTitle}」第${round}轮 hard_fail 无原文证据，保留正文并重新取证`)
      continue
    }
    volumeChapterDAO.updateChapter(chapterId, {
      quality_assessment_json: serializeQualityAssessment({
        content,
        scoreTotal: diagRes.scoreTotal,
        hardFail: hardFailEvidence.recognized,
        report: diagRes.report
      })
    })
    const items = breakdown?.items ?? []

    const advisories = failedCriticalStoryMetrics(items, qualityMin, { finalBeat: isFinalBeat })
    if (diagRes.scoreTotal < qualityMin) advisories.unshift(`总分:${diagRes.scoreTotal}`)
    const emotionAssessment = await assessChapterEmotion(workId, chapterId, content, signal, true)
    const emotionAccepted = isEmotionAssessmentAcceptedForTransition(emotionAssessment)
    const emotionBlockers = emotionAccepted ? [] : (emotionAssessment.blocking_issues ?? [])
    if (!emotionAccepted && emotionBlockers.length === 0) {
      advisories.push(`情绪盲读:${emotionAssessment.score}`)
    }
    const hardBlockers = [
      ...hardFailEvidence.failedRules.map(rule => `质量硬伤:${rule}`),
      ...emotionBlockers.map(issue => `情绪因果:${issue}`)
    ]
    const failedMetrics = [...hardBlockers, ...advisories]
    const allPassed = hardBlockers.length === 0
    const candidate: DiagnoseCandidate = {
      round,
      content,
      qualityScore: diagRes.scoreTotal,
      qualityReport: diagRes.report ?? '',
      emotionScore: emotionAssessment.score,
      hardBlockers,
      advisories,
      failedMetrics: [...failedMetrics]
    }
    if (isBetterDiagnoseCandidate(candidate, bestCandidate)) bestCandidate = candidate

    appLogger.info('goal_routine', `AI诊断 第${round}轮`, {
      workId, chapterId, scoreTotal: diagRes.scoreTotal, allPassed,
      failedMetrics, hardFail: diagRes.hardFail
    })

    if (allPassed) {
      onProgress?.(`「${chTitle}」AI诊断通过（${diagRes.scoreTotal}分，第${round}轮）`)
      return {
        passed: true,
        rounds: round,
        finalScore: diagRes.scoreTotal,
        emotionScore: emotionAssessment.score,
        bestRound: round,
        failedMetrics: advisories,
        hardBlockers: [],
        advisories
      }
    }

    // 最后一轮之后不再生成一个未经复验的版本，直接回退并保留已验收过的最佳候选。
    if (round === maxRounds) {
      onProgress?.(`「${chTitle}」第${round}轮仍未达标（${diagRes.scoreTotal}分），正在选择最佳候选`)
      break
    }
    onProgress?.(`「${chTitle}」未达标（${diagRes.scoreTotal}分），不达标项：${failedMetrics.join('、')}，正在修复`)

    // 1) 尝试应用诊断返回的 patches（快速文本替换）
    const patches = (breakdown.patches ?? []).filter(patch =>
      hardFailEvidence.evidence.some(evidence =>
        evidence.includes(patch.find) || patch.find.includes(evidence)
      )
    )
    let patched = content
    let patchApplied = 0
    for (const p of patches) {
      if (!p.find) continue
      const next = fuzzyReplace(patched, p.find, p.replace)
      if (next !== null) {
        patched = next
        patchApplied++
      }
    }

    // 2) 若 patches 不够或无 patches，用 LLM 对照诊断报告进行修复
    if (patchApplied === 0 || failedMetrics.length > 2) {
      assertNotAborted(signal)
      const report = [
        `【必须修复的硬阻塞】\n${hardBlockers.join('\n')}`,
        hardFailEvidence.evidence.length > 0
          ? `【原文证据】\n${hardFailEvidence.evidence.join('\n')}`
          : '',
        emotionBlockers.length > 0 ? emotionRepairHint(emotionAssessment) : ''
      ].filter(Boolean).join('\n\n')
      const plan = loadWritingPlan(workId)
      const wordTarget = plan.wordsPerChapter || 4000
      const systemPrompt = [
        '只修复列出的硬阻塞及其直接因果上下文。低分、文风偏好和未列出的段落不构成改写许可。',
        QUALITY_APPLY_FIXES_PROMPT,
        STYLE_REWRITE_INSTRUCTION
      ].join('\n\n')
      const fixRes = await modelService.chat(
        withGoalLoopModelOptions(workId, {
          prompt: [
            '【诊断报告】',
            report,
            `\n【目标字数】${wordTarget} 字`,
            '【需要修改的原文】',
            patched
          ].join('\n'),
          systemPrompt,
          workId,
          step: 'body_style_rewrite',
          enrichWorkContext: false,
          enrichNarrativeMemory: false
        }),
        { stream: false, signal }
      )
      if (fixRes.success && fixRes.content?.trim()) {
        patched = normalizeModelBodyOutput(fixRes.content.trim(), 'body_generation')
      } else {
        throw new Error(fixRes.error || '硬阻塞修复模型未返回正文')
      }
    }

    if (patched !== content) {
      const committed = await commitStoryBodyCandidate(workId, chapterId, patched, signal, onProgress)
      if (!committed.success) {
        onProgress?.(`「${chTitle}」修复候选未通过提交门禁：${committed.error ?? '未知错误'}`)
        break
      }
      onProgress?.(`「${chTitle}」修复完成（第${round}轮，${patchApplied}条patches + LLM修复）`)
    } else {
      onProgress?.(`「${chTitle}」硬阻塞修复未产生可验证变更，停止重复评估同一正文`)
      break
    }
  }
  if (!bestCandidate) {
    const evaluatorFailure = evaluatorErrors.at(-1) ?? {
      code: 'QUALITY_EVALUATOR_UNAVAILABLE' as const,
      message: '正文诊断未返回有效结果'
    }
    const qualityAdvisory = `逐拍质量建议器${evaluatorFailure.code === 'QUALITY_EVALUATOR_PROTOCOL' ? '证据协议无效' : '不可用'}：${evaluatorFailure.message}`
    const currentContent = volumeChapterDAO.getChapter(chapterId)?.content?.trim() ?? ''
    const emotionAssessment = await assessChapterEmotion(
      workId,
      chapterId,
      currentContent,
      signal,
      true
    )
    const emotionAccepted = isEmotionAssessmentAcceptedForTransition(emotionAssessment)
    const hardBlockers = emotionAccepted
      ? []
      : (emotionAssessment.blocking_issues ?? []).map(issue => `情绪因果:${issue}`)
    const advisories = [
      qualityAdvisory,
      ...(!emotionAccepted && hardBlockers.length === 0
        ? [`情绪盲读:${emotionAssessment.score}`]
        : [])
    ]
    return {
      passed: hardBlockers.length === 0,
      rounds: round,
      finalScore: -1,
      emotionScore: emotionAssessment.score,
      bestRound: round,
      failedMetrics: [...hardBlockers, ...advisories],
      hardBlockers,
      advisories
    }
  }
  const currentContent = volumeChapterDAO.getChapter(chapterId)?.content?.trim() ?? ''
  if (currentContent !== bestCandidate.content.trim()) {
    const restored = await commitStoryBodyCandidate(
      workId,
      chapterId,
      bestCandidate.content,
      signal,
      onProgress
    )
    if (!restored.success) {
      appLogger.warn('goal_routine', '最佳候选恢复未通过完整提交门禁，保留当前正式正文', {
        workId, chapterId, error: restored.error
      })
    }
  }
  const acceptedContent = volumeChapterDAO.getChapter(chapterId)?.content?.trim() ?? bestCandidate.content
  volumeChapterDAO.updateChapter(chapterId, {
    quality_assessment_json: serializeQualityAssessment({
      content: acceptedContent,
      scoreTotal: bestCandidate.qualityScore,
      hardFail: bestCandidate.hardBlockers.some(item => item.startsWith('质量硬伤:')),
      report: bestCandidate.qualityReport
    })
  })
  // 诊断修订会改变正文；按最终正式正文同步重建记忆，避免候选与记忆错位。
  clearChapterNarrativeMemory(workId, chapterId)
  try {
    await extractNarrativeMemoryAfterGeneration(workId, chapterId, acceptedContent, signal)
  } catch (error) {
    appLogger.warn('goal_routine', '保留最佳正文后重建叙事记忆失败（不阻断后续生成）', {
      workId,
      chapterId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
  // 正文回滚会使旧盲读和账本失效；必须在记忆清理后重新原子提交情绪结果。
  await assessChapterEmotion(workId, chapterId, acceptedContent, signal, true, true)
  onProgress?.(
    `「${chTitle}」已达到 ${maxRounds} 轮修复上限，保留第 ${bestCandidate.round} 轮最佳候选` +
    `（正文质量 ${bestCandidate.qualityScore} 分，情绪 ${bestCandidate.emotionScore} 分）`
  )
  return {
    passed: false,
    rounds: round,
    finalScore: bestCandidate.qualityScore,
    emotionScore: bestCandidate.emotionScore,
    bestRound: bestCandidate.round,
    failedMetrics: bestCandidate.failedMetrics.length > 0
      ? bestCandidate.failedMetrics
      : ['超过正文质量与情绪联合修复上限'],
    hardBlockers: bestCandidate.hardBlockers,
    advisories: bestCandidate.advisories
  }
}

export function buildRepairPlan(workId: number, check: GoalCheckResult | undefined): RepairPlan {
  const missing = volumeChapterDAO.listChaptersByWork(workId).filter(c => !c.content?.trim())
  const reasons = check?.reasons.join('；') ?? ''
  if (check?.releasePromise && !check.releasePromise.passed) {
    const targetChapterIds = volumeChapterDAO.listChaptersByWork(workId).map(chapter => chapter.id)
    return {
      action: 'storyline',
      targetChapterIds,
      hint: [
        '发布承诺合同未兑现。保留标题与导语，只重建节拍因果和正文，使标题核心结果真实发生。',
        `标题承诺：${check.releasePromise.titlePromise || '未提取'}`,
        `导语承诺：${check.releasePromise.hookPromise || '未提取'}`,
        `缺失项：${check.releasePromise.missingPromises.join('；') || '前30%、高潮或结局缺少原文证据'}`
      ].join('\n'),
      issues: check.releasePromise.missingPromises
    }
  }
  if (check?.compliance && !check.compliance.passed) {
    const targetChapterIds = volumeChapterDAO.listChaptersByWork(workId).map(chapter => chapter.id)
    return {
      action: 'beat',
      targetChapterIds,
      hint: [
        '事实与平台合规门禁未通过。只修复有原文证据的问题，禁止把违法获证、网暴、人肉或极端报复换词后继续作为爽点。',
        ...check.compliance.issues.map(issue =>
          `${issue.code}：${issue.message}；证据：${issue.evidence}；最小修正：${issue.requiredAction}`
        )
      ].join('\n'),
      issues: check.compliance.issues.map(issue => `${issue.code}：${issue.message}`)
    }
  }
  if (/确定性成稿门禁/.test(reasons)) {
    const currentKeys = new Set((check?.harnessIssues ?? [])
      .filter(issue => issue.severity === 'blocker')
      .map(storyHarnessIssueKey))
    const issues = storyHarnessDAO.listIssues(workId)
      .filter(issue => issue.status !== 'resolved' && currentKeys.has(issue.issue_key))
    const targetChapterIds = [...new Set(issues.flatMap(issue => {
      try {
        const value = JSON.parse(issue.chapter_ids_json ?? '[]')
        return Array.isArray(value) ? value.filter(Number.isInteger) as number[] : []
      } catch {
        return []
      }
    }))]
    const engineLevel = issues.some(issue => issue.scope === 'engine')
    const boundaryLevel = issues.some(issue => issue.code === 'CONTINUITY_CONTRACT_INVALID')
    const allChapterIds = volumeChapterDAO.listChaptersByWork(workId).map(chapter => chapter.id)
    const deterministicTargets = storyDeterministicRepairTargets(
      targetChapterIds,
      allChapterIds,
      boundaryLevel
    )
    return {
      action: engineLevel ? 'storyline' : boundaryLevel ? 'beat' : 'paragraph',
      targetChapterIds: deterministicTargets.length > 0
        ? deterministicTargets
        : pickWeakChapters(workId, check, 2),
      hint: `只修复确定性门禁列出的证据，不得改动其他已通过事实。${issues.map(issue => `${issue.code}：${issue.message}；验收结果：${issue.expected_result ?? ''}`).join('；')}`,
      issues: issues.map(issue => `${issue.code}：${issue.message}`),
      issueKeys: issues.map(issue => issue.issue_key),
      blueprintOnly: boundaryLevel
    }
  }
  if (missing[0]) {
    return {
      action: 'draft_missing',
      targetChapterIds: [missing[0].id],
      hint: '补写缺失正文，并严格衔接前后节拍。'
    }
  }
  if (/情绪门禁未通过/.test(reasons)) {
    for (const chapter of volumeChapterDAO.listChaptersByWork(workId)) {
      if (!chapter.emotion_assessment_json) continue
      try {
        const assessment = JSON.parse(chapter.emotion_assessment_json) as EmotionBlindAssessment
        if (assessment.passed) continue
        const action: RepairPlan['action'] = assessment.failure_layer === 'attachment'
          ? 'storyline'
          : assessment.failure_layer === 'arc'
            ? 'beat'
            : assessment.failure_layer === 'prose'
              ? 'paragraph'
              : 'scene'
        return {
          action,
          targetChapterIds: [chapter.id],
          hint: emotionRepairHint(assessment),
          issues: assessment.blocking_issues
        }
      } catch { /* 尝试下一章 */ }
    }
  }
  if (check && /(整篇结构与兑现|试读追读力|创作目标匹配度)/.test(reasons)) {
    const titleTargets = volumeChapterDAO.listChaptersByWork(workId)
      .filter(chapter => check.weakChapterTitles.some(title => chapter.title.includes(title) || title.includes(chapter.title)))
      .map(chapter => chapter.id)
    const targets = titleTargets.length > 0 ? titleTargets.slice(0, 2) : pickWeakChapters(workId, check, 2)
    const layerLabels: Record<GoalCheckResult['weakestLayer'], string> = {
      storyline: '主线层',
      beat: '节拍层',
      scene: '场景层',
      paragraph: '段落层'
    }
    return {
      action: check.weakestLayer,
      targetChapterIds: targets,
      hint: `整篇终审定位为${layerLabels[check.weakestLayer]}问题。必须优先修复因果、承诺与兑现，不得只做措辞润色。${check.storyIssues.length > 0 ? `具体问题：${check.storyIssues.join('；')}` : ''}`,
      issues: check.storyIssues
    }
  }

  if (/创作目标匹配度/.test(reasons)) {
    const targets = pickWeakChapters(workId, check, 2)
    return {
      action: 'goal_align',
      targetChapterIds: targets,
      hint: `当前正文未充分满足用户创作目标。请围绕目标重写本节拍，强化题材、人物动机、关键情节与结局指向。${check?.goalMatchReason ? `偏离原因：${check.goalMatchReason}` : ''}`
    }
  }

  if (/字数超出/.test(reasons)) {
    const target = longestBeat(workId)
    const current = target ? volumeChapterDAO.getChapter(target.id) : null
    const maxTotal = check ? bodyWordCountBounds(check.targetWords).max : 0
    const excess = check && maxTotal > 0 ? Math.max(0, check.totalWords - maxTotal) : 0
    const targetWords = Math.max(600, (current?.word_count ?? 0) - excess - 80)
    return {
      action: 'resize',
      targetChapterIds: target ? [target.id] : [],
      targetWordCounts: target ? { [target.id]: targetWords } : {},
      hint: `当前全篇超出目标上限。将本拍精确重写为约 ${targetWords} 字，删除重复心理、解释和同义反应，只保留选择、阻力、代价与状态变化。`
    }
  }

  if (/字数不足/.test(reasons)) {
    const minTotal = check ? bodyWordCountBounds(check.targetWords).min : 0
    const shortage = check && minTotal > 0 ? Math.max(0, minTotal - check.totalWords) : 0
    const targets = shortestBeatsWithWordCounts(workId, 3)
    const perBeat = targets.length > 0 ? Math.ceil((shortage + 120) / targets.length) : 0
    const targetWordCounts = Object.fromEntries(targets.map(target => [
      target.id,
      target.wordCount + perBeat
    ]))
    return {
      action: 'resize',
      targetChapterIds: targets.map(target => target.id),
      targetWordCounts,
      hint: `当前全篇低于目标下限。将字数缺口分摊到 ${targets.length} 个较短节拍，只扩充人物选择、对手反制、代价、铺垫和因果变化，禁止把缺口堆进单拍，也禁止重复情绪或围观反应。`
    }
  }

  if (/anti-AI 规则(?:违规|达到阻塞阈值)/.test(reasons)) {
    const violatingDiagnostics = check?.chapterDiagnostics
      .filter(diagnostic => diagnostic.antiAiViolations > 0) ?? []
    const targetChapterIds = violatingDiagnostics.map(diagnostic => diagnostic.chapterId)
    const details = [...new Set(violatingDiagnostics.flatMap(diagnostic => diagnostic.antiAiViolationDetails ?? []))]
    return {
      action: 'deai',
      targetChapterIds,
      hint: [
        '当前存在 anti-AI 规则违规。只修复确实违规的句子，保留未涉及的情节事实、人物状态和有效表达。',
        '泛白类身体反应如无独立剧情信息就删除；确有作用则改成会产生后果、暴露意图或改变选择的动作。不得换成呼吸一滞、身体僵住、瞳孔骤缩、颤抖或攥拳等同类套话。',
        details.length > 0 ? `确定性检测证据：${details.join('；')}` : ''
      ].filter(Boolean).join('\n')
    }
  }

  if (/原文盲读/.test(reasons)) {
    return {
      action: 'paragraph',
      targetChapterIds: pickWeakChapters(workId, check, 2),
      hint: `原文匿名盲读未通过。只修复真实阅读问题：重复心理、解释过度、电报短句、模板刺激和人物声音雷同。${check?.proseReadReason ?? ''}`,
      issues: check?.storyIssues ?? []
    }
  }

  return {
    action: 'quality',
    targetChapterIds: pickWeakChapters(workId, check, 1),
    hint: '当前质量或一致性未达标。请强化开篇钩子、视角稳定、因果链、反转兑现和节拍结尾钩子。'
  }
}

async function reviseBeatBlueprints(
  workId: number,
  plan: RepairPlan,
  goal: string,
  signal?: AbortSignal
): Promise<number> {
  if (plan.action !== 'storyline' && plan.action !== 'beat') return 0
  const targets = plan.targetChapterIds
    .map(id => volumeChapterDAO.getChapter(id))
    .filter((chapter): chapter is NonNullable<typeof chapter> => chapter != null)
  if (targets.length === 0) return 0

  const userMaxTokens = appPreferenceDAO.getGenerationParams().maxTokens
  const responseSchema = {
    type: 'object',
    required: ['chapters'],
    properties: {
      chapters: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'title', 'plot_points'],
          properties: {
            id: { type: 'integer' },
            title: { type: 'string' },
            plot_points: { type: 'array', items: { type: 'string' } }
          },
          additionalProperties: true
        }
      }
    },
    additionalProperties: false
  }
  let previousFailure = ''
  for (let round = 1; round <= STRUCTURAL_REPAIR_MAX_ATTEMPTS; round++) {
    let lastStructuralFailure: StructuralRepairError | null = null
    let parsed: ParsedChapter[]
    try {
      parsed = await requestStructuredModelOutput<ParsedChapter[]>({
        workId,
        label: '短故事结构层节拍修复',
        attempts: STRUCTURAL_REPAIR_MAX_ATTEMPTS,
        signal,
        schema: responseSchema,
        validate: value => {
          const chapters = parseChapterSuggestions(JSON.stringify(value))
          if (chapters.length === 0) throw new Error('结构修复未返回可解析的 chapters')
          const missing = targets.filter(target => !chapters.some(candidate => candidate.id === target.id))
          if (missing.length > 0) {
            throw new StructuralRepairError(
              'STRUCTURE_TARGET_MISMATCH',
              `结构修复缺少目标节拍 ID：${missing.map(target => target.id).join('、')}`
            )
          }
          return chapters
        },
        request: (attempt, error) => {
          const maxTokens = structuralRepairTokenBudget(userMaxTokens, targets.length, attempt)
          return modelService.chat(
            withGoalLoopModelOptions(workId, {
              workId,
              step: 'story_repair_blueprint',
              enrichWorkContext: true,
              enrichNarrativeMemory: true,
              temperature: 0.2,
              maxTokens,
              responseSchema: { name: 'story_structural_repair', strict: false, schema: responseSchema },
              structuredOutputMode: 'prompt_json',
              systemPrompt: [
                '你是短故事结构修复编辑。只输出一个合法 JSON 对象，不要 Markdown、解释或思考过程。',
                '只返回输入中的待修复节拍；每项 id 必须原样返回，title 也必须保持原样。id 是唯一匹配依据。',
                '保留未被问题证据否定的事实、人物关系和前后拍边界，只修复指出的因果、时间、地点、知识与证据状态问题。',
                '每项返回完整字段：id、title、plot_points、dramatic_contract、continuity_contract、tension_plan、emotion_contract、beat_role、foreshadow_target、next_hook、characters。',
                'plot_points 为 3-5 条；其余文本字段每项只写一句，禁止正文级展开，以确保 JSON 能完整结束。',
                `emotion_contract 枚举必须遵守：${EMOTION_CONTRACT_ENUM_RULE}`,
                '格式：{"chapters":[{"id":123,"title":"原题","plot_points":["节点1","节点2","节点3"],"dramatic_contract":{},"continuity_contract":{},"tension_plan":{"phase":"主动选择与逼近高潮","level":8,"payoff_type":"partial"},"emotion_contract":{},"beat_role":"B","foreshadow_target":"","next_hook":"具体追问","characters":["角色"]}]}'
              ].join('\n'),
              prompt: [
                `【创作目标】\n${goal.trim() || '高完读率短故事'}`,
                `【结构修复证据】\n${plan.hint}`,
                previousFailure ? `【上一候选边界失败】\n${previousFailure}` : '',
                attempt > 1 ? `【协议重试】\n${error}\n进一步压缩文字并输出闭合 JSON。` : '',
                `【待修复节拍】\n${JSON.stringify(targets.map(chapter => ({
                  id: chapter.id,
                  title: chapter.title,
                  outline: chapter.outline,
                  beat_role: chapter.beat_role,
                  foreshadow_target: chapter.foreshadow_target,
                  next_hook: chapter.next_hook,
                  outline_diagnosis: chapter.outline_diagnosis,
                  ...(plan.continuityEscalation
                    ? {
                        current_text_opening: chapter.content?.slice(0, 1200) ?? '',
                        current_text_ending: chapter.content?.slice(-1800) ?? ''
                      }
                    : {})
                })), null, 2)}`
              ].filter(Boolean).join('\n\n')
            }),
            { stream: false, signal }
          )
        },
        onAttemptFailure: ({ attempt, error, response }) => {
          if (!response?.success || !response.content?.trim()) return
          lastStructuralFailure = /缺少目标节拍 ID/.test(error)
            ? new StructuralRepairError('STRUCTURE_TARGET_MISMATCH', error)
            : classifyStructuralRepairParseFailure({
                content: response.content,
                completionTokens: response.usage?.completionTokens,
                maxTokens: structuralRepairTokenBudget(userMaxTokens, targets.length, attempt),
                finishReason: response.finishReason
              })
          appLogger.warn('goal_routine', '结构修复协议响应无效，扩大任务预算后有限重试', {
            workId,
            round,
            attempt,
            code: lastStructuralFailure.code,
            maxTokens: structuralRepairTokenBudget(userMaxTokens, targets.length, attempt),
            nextMaxTokens: attempt < STRUCTURAL_REPAIR_MAX_ATTEMPTS
              ? structuralRepairTokenBudget(userMaxTokens, targets.length, attempt + 1)
              : undefined
          })
        }
      })
    } catch (error) {
      throw lastStructuralFailure ?? error
    }
    const matched = targets.map(target => ({
      target,
      candidate: parsed.find(candidate => candidate.id === target.id)
    }))
    const updates: Array<{
      chapterId: number
      fields: Parameters<typeof volumeChapterDAO.updateChapterWithVersion>[1]
      continuityContract: ContinuityContract | null
    }> = []
    for (const { target, candidate: matchedCandidate } of matched) {
      const candidate = matchedCandidate!
      if (candidate.title !== target.title) {
        appLogger.warn('goal_routine', '结构修复按 ID 匹配成功，但模型改写了标题；保留数据库原标题', {
          workId,
          chapterId: target.id,
          expectedTitle: target.title,
          returnedTitle: candidate.title
        })
      }
      const nextFields = {
        outline: candidate.outline,
        beat_role: candidate.beat_role ?? target.beat_role ?? null,
        foreshadow_target: candidate.foreshadow_target ?? target.foreshadow_target ?? null,
        next_hook: candidate.next_hook ?? target.next_hook ?? null,
        characters: candidate.characters ?? target.characters ?? null,
        emotion_contract_json: candidate.emotion_contract
          ? JSON.stringify(candidate.emotion_contract)
          : target.emotion_contract_json ?? null,
        outline_diagnosis: mergeStoryBlueprintDiagnosis(target.outline_diagnosis, candidate)
      }
      const unchanged = nextFields.outline === (target.outline ?? '')
        && nextFields.beat_role === (target.beat_role ?? null)
        && nextFields.foreshadow_target === (target.foreshadow_target ?? null)
        && nextFields.next_hook === (target.next_hook ?? null)
        && nextFields.characters === (target.characters ?? null)
        && nextFields.emotion_contract_json === (target.emotion_contract_json ?? null)
        && nextFields.outline_diagnosis === (target.outline_diagnosis ?? null)
      if (unchanged) continue
      updates.push({
        chapterId: target.id,
        fields: nextFields,
        continuityContract: candidate.continuity_contract ?? null
      })
    }
    const allChapters = volumeChapterDAO.listChaptersByWork(workId)
    const updateByChapter = new Map(updates.map(update => [update.chapterId, update]))
    const proposed = allChapters.map(chapter => {
      const update = updateByChapter.get(chapter.id)
      if (update) {
        return {
          id: chapter.id,
          title: chapter.title,
          outline: update.fields.outline ?? chapter.outline ?? '',
          continuity_contract: update.continuityContract
        } satisfies ParsedChapter
      }
      let continuityContract: ContinuityContract | null = null
      try {
        const diagnosis = chapter.outline_diagnosis
          ? JSON.parse(chapter.outline_diagnosis) as { continuity_contract?: ContinuityContract }
          : {}
        continuityContract = diagnosis.continuity_contract ?? null
      } catch { /* 非法诊断会由确定性边界门禁阻塞 */ }
      return {
        id: chapter.id,
        title: chapter.title,
        outline: chapter.outline ?? '',
        continuity_contract: continuityContract
      } satisfies ParsedChapter
    })
    const synchronized = synchronizeStoryBoundaryPairs(proposed)
    synchronized.forEach((chapter, index) => {
      const before = proposed[index].continuity_contract ?? null
      const after = chapter.continuity_contract ?? null
      if (JSON.stringify(before) === JSON.stringify(after)) return
      const stored = allChapters[index]
      const outlineDiagnosis = mergeStoryBlueprintDiagnosis(stored.outline_diagnosis, {
        continuity_contract: after
      })
      const existing = updateByChapter.get(stored.id)
      if (existing) {
        existing.fields = { ...existing.fields, outline_diagnosis: outlineDiagnosis }
        existing.continuityContract = after
      } else {
        const projected = {
          chapterId: stored.id,
          fields: { outline_diagnosis: outlineDiagnosis },
          continuityContract: after
        }
        updates.push(projected)
        updateByChapter.set(stored.id, projected)
      }
    })
    const boundaryIssues = validateStoryBoundaryContracts(synchronized)
    if (boundaryIssues.length > 0) {
      const failure = new StructuralRepairError(
        'BOUNDARY_ATOMIC_MISMATCH',
        `相邻拍边界未形成可原子提交的闭合补丁：${boundaryIssues.map(issue => issue.message).join('；')}`
      )
      previousFailure = failure.message
      if (round < STRUCTURAL_REPAIR_MAX_ATTEMPTS) continue
      throw failure
    }
    if (updates.length === 0) return 0

    volumeChapterDAO.updateChaptersWithVersionsAtomic(updates.map(update => ({
      chapterId: update.chapterId,
      fields: update.fields,
      versionMeta: { model_type: 'story_boundary_atomic_repair', generation_round: round }
    })))
    return updates.length
  }
  throw new StructuralRepairError('STRUCTURE_PATCH_EMPTY', '结构修复未返回可应用补丁')
}

function pickWeakChapters(workId: number, check: GoalCheckResult | undefined, limit: number): number[] {
  const chapters = volumeChapterDAO.listChaptersByWork(workId).filter(c => c.content?.trim())
  if (chapters.length === 0) return []
  const diagnostics = check?.chapterDiagnostics ?? []
  const ranked = chapters
    .map(ch => {
      const d = diagnostics.find(x => x.chapterId === ch.id)
      const score = (d?.qualityHardFail ? -100 : 0)
        - (d?.gateBlockers ?? 0) * 20
        + (d?.qualityScore ?? 50)
        + (d?.emotionPassed === false ? -80 : 0)
        + Math.max(0, d?.emotionScore ?? 0)
        + Math.min(20, (ch.word_count || 0) / 200)
      return { id: ch.id, score }
    })
    .sort((a, b) => a.score - b.score)
  return ranked.slice(0, limit).map(x => x.id)
}

const STORY_LEAD_REPAIR_RESPONSE_SCHEMA = {
  type: 'object', required: ['lead'], properties: { lead: { type: 'string' } }
}

const STORY_LEAD_GATE_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['passed', 'issues'],
  properties: { passed: { type: 'boolean' }, issues: { type: 'array', items: { type: 'string' } } }
}

function parseStoryLeadRepair(value: Record<string, unknown>): string {
  const lead = typeof value.lead === 'string' ? value.lead.trim() : ''
  if (lead.length < 60 || lead.length > 500) {
    throw new Error(`导语修复长度必须为 60-500 字符，当前 ${lead.length}`)
  }
  return lead
}

function parseStoryLeadGate(value: Record<string, unknown>): { passed: boolean; issues: string[] } {
  if (typeof value.passed !== 'boolean') throw new Error('导语复验缺少 passed')
  if (!Array.isArray(value.issues)) throw new Error('导语复验缺少 issues')
  return {
    passed: value.passed,
    issues: value.issues.map(String).map(item => item.trim()).filter(Boolean).slice(0, 6)
  }
}

async function repairStoryLead(
  workId: number,
  plan: RepairPlan,
  goal: string,
  signal?: AbortSignal
): Promise<string> {
  const work = workDAO.getById(workId)
  const currentLead = work?.description?.trim() ?? ''
  if (!currentLead) throw new Error('作品没有可修复的导语')
  const firstBeat = volumeChapterDAO.listChaptersByWork(workId)[0]
  const firstBeatOpening = firstBeat?.content?.trim().slice(0, 3200) ?? ''
  let lastIssue = ''
  for (let round = 1; round <= 2; round++) {
    assertNotAborted(signal)
    const candidate = await requestStructuredModelOutput<string>({
      workId,
      label: '短故事导语定向修复',
      signal,
      schema: STORY_LEAD_REPAIR_RESPONSE_SCHEMA,
      validate: parseStoryLeadRepair,
      request: (attempt, error) => modelService.chat(
        withGoalLoopModelOptions(workId, {
          workId,
          step: 'story_lead_repair',
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          temperature: 0.2,
          maxTokens: 900,
          forceThinkingDisabled: true,
          responseSchema: { name: 'story_lead_repair', schema: STORY_LEAD_REPAIR_RESPONSE_SCHEMA, strict: false },
          structuredOutputMode: 'prompt_json',
          systemPrompt: [
            '你是短故事导语定向修复编辑。只改导语，不改标题、第一拍或任何剧情事实。',
            '导语是独立钩子场景，不是第一拍缩写。必须避免完整复述第一拍的起因、对话、行动和结果。',
            '保留一个当下异常或具体悬念即可；不得补充正文不存在的新证据、身份、规则或结局。',
            '只输出合法 JSON：{"lead":"修复后的导语"}'
          ].join('\n'),
          prompt: [
            goal.trim() ? `【创作目标】${goal.trim()}` : '',
            `【当前导语】\n${currentLead}`,
            `【第一拍开头，只读且不得改写】\n${firstBeatOpening}`,
            `【本轮法医修复要求】\n${plan.hint}`,
            lastIssue ? `【上一候选未通过原因】\n${lastIssue}` : '',
            attempt > 1 ? `【协议重试】${error}。只返回完整 JSON。` : ''
          ].filter(Boolean).join('\n\n')
        }),
        { stream: false, signal }
      )
    })
    const gateEvidence = await requestQualityEvaluatorEvidence<{ passed: boolean; issues: string[] }>({
      workId,
      label: '短故事导语独立复验',
      signal,
      request: (attempt, error) => modelService.chat(
        withGoalLoopModelOptions(workId, {
          workId,
          step: 'story_lead_repair_gate',
          enrichWorkContext: false,
          enrichNarrativeMemory: false,
          temperature: 0,
          maxTokens: 700,
          forceThinkingDisabled: true,
          responseSchema: { name: 'story_lead_repair_gate', schema: STORY_LEAD_GATE_RESPONSE_SCHEMA, strict: false },
          structuredOutputMode: 'prompt_json',
          systemPrompt: [
            '你是独立短故事导语验收员。候选必须是钩子而非第一拍摘要。',
            '若候选与第一拍重复完整事件链、泄露后续解法/结局、引入新事实，或没有具体悬念，passed 必须为 false。',
            '只输出合法 JSON：{"passed":true,"issues":[]}'
          ].join('\n'),
          prompt: [
            `【候选导语】\n${candidate}`,
            `【第一拍开头】\n${firstBeatOpening}`,
            `【法医要求】\n${plan.hint}`,
            attempt > 1 ? `【协议重试】${error}。只返回完整 JSON。` : ''
          ].filter(Boolean).join('\n\n')
        }),
        { stream: false, signal }
      ),
      parse: content => parseStructuredModelContent({
        content,
        schema: STORY_LEAD_GATE_RESPONSE_SCHEMA,
        validate: parseStoryLeadGate
      }).value
    })
    const verdict = requireQualityEvaluatorEvidence(gateEvidence, '短故事导语独立复验')
    if (!verdict.passed) {
      lastIssue = verdict.issues.join('；') || '候选仍与第一拍重复或泄露后续'
      continue
    }
    storyHarnessDAO.replaceLeadWithVersion(workId, candidate)
    return `导语已定向修复并保存旧版本（${candidate.length}字符，第${round}轮）`
  }
  throw new GoalPhaseExhaustedError(`导语连续 2 轮未通过独立复验：${lastIssue}`)
}

export async function executeRepairPlan(
  workId: number,
  plan: RepairPlan,
  goal: string,
  signal?: AbortSignal,
  onContinuityEvent?: (chapterId: number, event: StoryContinuityRepairEvent) => void
): Promise<{
  summary: string
  changed: boolean
  continuityFailure?: { chapterId: number; blockers: string[]; attempts: number }
}> {
  if (plan.targetChapterIds.length === 0 && !plan.targetLead) return { summary: '无可修复节拍或导语', changed: false }
  const summaries: string[] = []
  const originals = new Map(plan.targetChapterIds.map(id => [id, volumeChapterDAO.getChapter(id)]))
  const originalLead = workDAO.getById(workId)?.description?.trim() ?? ''
  const rollbackCluster = () => {
    const restoreItems = [...originals.entries()].flatMap(([chapterId, original]) => original
      ? [{
          chapterId,
          fields: {
            title: original.title,
            outline: original.outline,
            content: original.content,
            word_count: original.word_count,
            status: original.status,
            beat_role: original.beat_role,
            foreshadow_target: original.foreshadow_target,
            next_hook: original.next_hook,
            pov_mode: original.pov_mode,
            characters: original.characters,
            outline_diagnosis: original.outline_diagnosis,
            emotion_contract_json: original.emotion_contract_json,
            emotion_assessment_json: original.emotion_assessment_json,
            quality_assessment_json: original.quality_assessment_json
          },
          versionMeta: { model_type: 'story_cluster_rollback', generation_round: 1 }
        }]
      : [])
    if (restoreItems.length > 0) {
      volumeChapterDAO.updateChaptersWithVersionsAtomic(restoreItems)
      restoreItems.forEach(item => clearChapterNarrativeMemory(workId, item.chapterId))
      const runtime = readRuntimeState(workId)
      patchRuntimeState(workId, {
        pendingMemoryChapterIds: [...new Set([
          ...(runtime.pendingMemoryChapterIds ?? []),
          ...restoreItems.map(item => item.chapterId)
        ])]
      })
    }
    if (plan.targetLead && (workDAO.getById(workId)?.description?.trim() ?? '') !== originalLead) {
      storyHarnessDAO.replaceLeadWithVersion(workId, originalLead, 'story_cluster_rollback')
    }
  }
  if (plan.targetLead) {
    summaries.push(await repairStoryLead(workId, plan, goal, signal))
  }
  const revisedBlueprints = plan.targetChapterIds.length > 0
    ? await reviseBeatBlueprints(workId, plan, goal, signal)
    : 0
  for (const chapterId of plan.targetChapterIds) {
    assertNotAborted(signal)
    const ch = volumeChapterDAO.getChapter(chapterId)
    const original = originals.get(chapterId)
    const baseline = original?.content?.trim() ?? ch?.content?.trim() ?? ''
    if (plan.blueprintOnly) {
      summaries.push(`${ch?.title ?? chapterId} 共享边界合同已原子同步，正文保持不变`)
      continue
    }
    const gen = await generateBeatBody(workId, chapterId, {
      signal,
      goalDescription: goal,
      extraHint: plan.hint,
      wordTargetOverride: plan.targetWordCounts?.[chapterId],
      onContinuityEvent: event => onContinuityEvent?.(chapterId, event)
    })
    if (!gen.success && gen.requiresEscalation) {
      rollbackCluster()
      return {
        summary: `${ch?.title ?? chapterId} 连续性候选修复未收敛，准备提升修复层级`,
        changed: false,
        continuityFailure: {
          chapterId,
          blockers: gen.continuityBlockers ?? [gen.error || '连续性修复未通过'],
          attempts: gen.continuityRepairRounds ?? 0
        }
      }
    }
    if (!gen.success) {
      rollbackCluster()
      throw new Error(gen.error || '修复生成失败')
    }
    if (!baseline) {
      summaries.push(`${ch?.title ?? chapterId} ${gen.wordCount}字`)
      continue
    }

    // 候选已经通过确定性完整性、连续性、资源与一致性门禁并原子提交。
    // 是否消除本轮证据化问题由下一轮同稿检查决定，主观二选一不得回滚已通过候选。
    summaries.push(`${ch?.title ?? chapterId} ${gen.wordCount}字（证据化修复候选已提交，待同稿复验）`)
  }
  return {
    summary: `${revisedBlueprints > 0 ? `修订 ${revisedBlueprints} 个节拍蓝图；` : ''}${summaries.join('；')}`,
    changed: revisedBlueprints > 0 || plan.targetChapterIds.some(chapterId => {
      const before = originals.get(chapterId)?.content?.trim() ?? ''
      const after = volumeChapterDAO.getChapter(chapterId)?.content?.trim() ?? ''
      return before !== after
    }) || Boolean(plan.targetLead && (workDAO.getById(workId)?.description?.trim() ?? '') !== originalLead)
  }
}

export async function applyDeterministicSentenceRepair(
  plan: RepairPlan,
  signal?: AbortSignal
): Promise<{ summary: string; changed: boolean }> {
  const issueKeys = plan.issueKeys ?? []
  if (issueKeys.length === 0 || !issueKeys.every(key => key.startsWith('CORRUPTED_SENTENCE:'))) {
    return { summary: '', changed: false }
  }

  const updates: Array<{
    chapterId: number
    fields: Parameters<typeof volumeChapterDAO.updateChapterWithVersion>[1]
    content: string
    replacements: number
  }> = []
  for (const chapterId of plan.targetChapterIds) {
    assertNotAborted(signal)
    const chapter = volumeChapterDAO.getChapter(chapterId)
    if (!chapter?.content) continue
    const repaired = repairDeterministicStorySentences(chapter.content)
    if (repaired.repairs.length === 0) continue
    const residual = detectStoryTextIntegrityIssues(repaired.content, { chapterId })
      .filter(issue => issue.code === 'CORRUPTED_SENTENCE')
    if (residual.length > 0) continue
    updates.push({
      chapterId,
      content: repaired.content,
      replacements: repaired.repairs.length,
      fields: {
        content: repaired.content,
        word_count: countWords(repaired.content),
        quality_assessment_json: null,
        emotion_assessment_json: null
      }
    })
  }
  if (updates.length === 0) return { summary: '', changed: false }

  volumeChapterDAO.updateChaptersWithVersionsAtomic(updates.map(update => ({
    chapterId: update.chapterId,
    fields: update.fields,
    versionMeta: { model_type: 'det_sentence_fix', generation_round: 99 }
  })))
  // 错词替换不改变事件、人物或证据状态，现有叙事记忆仍然有效；避免为了两个字
  // 再发起一次模型提取，从而把瞬时修复重新变成可能卡住的长任务。
  const replacementCount = updates.reduce((sum, update) => sum + update.replacements, 0)
  return {
    summary: `原位修复 ${updates.length} 个节拍中的 ${replacementCount} 处确定性坏词，并保存旧版本`,
    changed: true
  }
}
