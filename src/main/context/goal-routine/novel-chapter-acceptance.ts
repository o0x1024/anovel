import {
  causalNovelDAO,
  novelChapterGateDAO,
  novelChapterAcceptanceDAO,
  volumeChapterDAO,
  storyStateDAO,
  type NovelChapterAcceptanceAssessmentRow,
  type NovelChapterGateType
} from '../../db'
import { loadWritingPlan } from '../writing-plan'
import { resolvePendingNovelReleaseWindow } from './novel-release-window-audit'
import { countWords } from '../../../shared/body-word-target'
import {
  evaluateNovelQualityAcceptance,
  isBetterNovelBodyCandidate,
  isRecognizedNovelHardFail
} from '../../../shared/chapter-execution-contract'
import type { StoryGoalConfig } from './story-goal-checker'
import { diagnoseChapterQualityAi } from '../../ipc-v15'
import { parseQualityAiScoreReport, type QualityAiMetricKey } from '../../../shared/quality-ai-score'
import { normalizeModelBodyOutput, stripDeterministicAiPatterns } from '../../../shared/normalize-body-text'
import { countEmDashes, stripEmDashes } from '../anti-ai-rules'
import { clearChapterNarrativeMemory } from '../memory-cleanup'
import { getGoalLoopModelOpts } from './story-goal-model'
import {
  NovelPipelineError,
  readNovelGoalState,
  updateNovelGoalState
} from './novel-outline-pipeline'
import {
  assessChapterEmotion,
  emotionRepairHint,
  isEmotionOutcomeComplete,
  parseStoredEmotionAssessment
} from './emotion-gate'
import { parseCachedQualityAssessment, serializeQualityAssessment } from './chapter-assessment-cache'
import {
  compileChapterExecutionContract,
  isChapterExecutionAccepted,
  markChapterExecutionAccepted,
  persistChapterExecutionContract
} from '../chapter-execution-context'
import {
  assessNovelExecutionCandidate,
  isNovelExecutionEvaluatorFailure
} from './novel-execution-gate'
import { resolveNovelChapterRecoveryAction } from './novel-goal-policy'
import type { GoalRoutinePhase } from '../../../shared/goal-routine-phases'
import {
  MAX_QUALITY_EVALUATOR_FAILURES,
  qualityEvaluatorFailureCode,
  shouldOpenQualityEvaluatorCircuit
} from './quality-evaluator-policy'
import {
  applyExactQualityPatches,
  CHAPTER_EMOTION_MAX_REPAIRS,
  CHAPTER_EXECUTION_CONTRACT_MAX_REPAIRS,
  CHAPTER_QUALITY_MAX_REPAIRS,
  detectChapterAcceptanceStall,
  novelChapterContentHash,
  type AcceptanceProgressPoint
} from './novel-chapter-acceptance-policy'
import {
  beginNovelChapterAcceptanceResume,
  blockNovelChapterAcceptance,
  ensureNovelChapterAcceptanceEpisode,
  finishNovelChapterAcceptanceAccepted
} from './novel-chapter-acceptance-ledger'
import { repairNovelChapterByEvidencePatches } from './novel-chapter-evidence-repair'
import { hasUnifiedNovelPrecommitArtifacts } from './unified-novel-chapter'
import {
  clearChapterEditorialDebt,
  recordChapterEditorialDebt
} from './novel-chapter-transaction-policy'

const MAX_CHAPTER_CONVERGENCE_ROUNDS = 1

export interface ChapterWordRangeFailure {
  actual: number
  min: number
  target: number
  max: number
  direction: 'expand' | 'compress'
}

interface ChapterAcceptanceFailureProjection {
  blockedGate?: NovelChapterGateType
  failureCode?: string
}

function acceptanceFailureProjection(
  episodeId: number,
  contentHash: string
): ChapterAcceptanceFailureProjection {
  const episode = novelChapterAcceptanceDAO.getEpisode(episodeId)
  const candidate = novelChapterAcceptanceDAO.findCandidate(episodeId, contentHash)
    ?? (episode?.best_candidate_id == null
      ? undefined
      : novelChapterAcceptanceDAO.getCandidate(episode.best_candidate_id))
  const failedGate = candidate
    ? novelChapterGateDAO.listStates(episodeId, candidate.id)
      .find(gate =>
        gate.status === 'failed'
        && !(
          gate.gate_type === 'quality'
          && novelChapterAcceptanceDAO.findAssessment(episodeId, candidate.id)?.passed === 1
        )
      )
    : undefined
  return {
    blockedGate: failedGate?.gate_type,
    failureCode: failedGate?.failure_code ?? episode?.terminal_code ?? undefined
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('已取消')
}

export interface PendingDraftChapter {
  id: number
  title: string
  needsGeneration: boolean
  needsAcceptance: boolean
}

export function isStrictCachedQualityReady(
  cached: ReturnType<typeof parseCachedQualityAssessment>
): boolean {
  if (!cached || cached.acceptedDeferred) return false
  if (cached.acceptedByAuthor) return true
  const report = parseQualityAiScoreReport(cached.report)
  return !isRecognizedNovelHardFail(cached.hardFail, report?.failedRules ?? [])
}

export function strictChapterTransitionBlockers(
  workId: number,
  chapterId: number,
  config: StoryGoalConfig
): string[] {
  const chapter = volumeChapterDAO.getChapter(chapterId)
  const content = chapter?.content?.trim() ?? ''
  if (!chapter || !content) return ['最终正文为空']
  const contract = compileChapterExecutionContract(workId, chapterId)
  if (!contract || contract.errors.length > 0) {
    return [`章节合同无效：${contract?.errors.join('；') || '无法编译'}`]
  }
  const blockers: string[] = []
  const actualWordCount = countWords(content)
  const softMargin = Math.max(50, Math.round(contract.wordTarget * 0.02))
  if (
    actualWordCount < contract.wordMin - softMargin
    || actualWordCount > contract.wordMax + softMargin
  ) {
    blockers.push(`章节字数 ${actualWordCount} 不在合同范围 ${contract.wordMin}-${contract.wordMax}`)
  }
  if (!isChapterExecutionAccepted(chapterId, content, contract.sourceOutlineHash)) {
    blockers.push('最终正文缺少与当前合同、当前内容匹配的执行验收凭证')
  }
  return blockers
}

export function invalidateDownstreamBodiesAfterAcceptedChapterRewrite(
  workId: number,
  chapterId: number
): number {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const sourceIndex = chapters.findIndex(chapter => chapter.id === chapterId)
  if (sourceIndex < 0) return 0
  const invalidatedVolumeNames = new Set<string>()
  let invalidated = 0
  for (const chapter of chapters.slice(sourceIndex + 1)) {
    if (!chapter.content?.trim()) continue
    clearChapterNarrativeMemory(workId, chapter.id)
    volumeChapterDAO.updateChapterWithVersion(chapter.id, {
      content: '',
      word_count: 0,
      status: 'draft',
      emotion_assessment_json: null,
      quality_assessment_json: null
    }, { model_type: 'upstream_reset' })
    invalidatedVolumeNames.add(chapter.volume_name)
    invalidated++
  }
  if (invalidated > 0) {
    const state = readNovelGoalState(workId)
    const invalidatedIds = new Set(chapters.slice(sourceIndex + 1).map(chapter => chapter.id))
    updateNovelGoalState(workId, {
      checkedBodyVolumes: (state.checkedBodyVolumes ?? [])
        .filter(name => !invalidatedVolumeNames.has(name)),
      chapterExecutionDeferredIssues: (state.chapterExecutionDeferredIssues ?? [])
        .filter(item => !invalidatedIds.has(item.chapterId)),
      chapterAcceptanceDeferredIssues: (state.chapterAcceptanceDeferredIssues ?? [])
        .filter(item => !invalidatedIds.has(item.chapterId)),
      finalAudit: undefined,
      failure: undefined
    })
  }
  return invalidated
}

export function nextPendingDraftChapter(workId: number, config: StoryGoalConfig): PendingDraftChapter | null {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const fingerprintChapterIds = new Set(storyStateDAO.listFingerprintsByWork(workId).map(row => row.chapter_id))
  for (const ch of chapters) {
    const content = ch.content?.trim() ?? ''
    const decision = causalNovelDAO.getDecision(ch.id)
    if (decision?.status === 'committed') continue
    const baselineBinding = causalNovelDAO.getChapterBinding(ch.id)
    const baselineVersion = baselineBinding
      ? causalNovelDAO.getContentVersion(baselineBinding.contentVersionId)
      : null
    if (
      baselineBinding?.decisionStatus === 'baseline'
      && baselineBinding.bindingStatus === 'active'
      && baselineVersion?.content.trim() === content
    ) continue
    const qualityReady = true
    const emotionReady = true
    const memoryReady = fingerprintChapterIds.has(ch.id)
    const contract = compileChapterExecutionContract(workId, ch.id)
    const executionReady = Boolean(
      content
      && contract
      && isChapterExecutionAccepted(ch.id, content, contract.sourceOutlineHash)
    )
    const precommitReady = hasUnifiedNovelPrecommitArtifacts(workId, ch.id)
    const action = resolveNovelChapterRecoveryAction({
      hasContent: Boolean(content),
      qualityReady,
      emotionReady,
      patternFingerprintReady: memoryReady
    })
    if (action === 'complete' && executionReady && precommitReady) continue
    return {
      id: ch.id,
      title: ch.title,
      needsGeneration: action === 'generate',
      needsAcceptance: action === 'generate' || action === 'acceptance' || !executionReady
    }
  }
  return null
}

export function phaseAfterCurrentDraftWindow(workId: number): GoalRoutinePhase {
  if (resolvePendingNovelReleaseWindow(workId)) return 'release_window_audit'
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
  episodeId: number,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{ passed: boolean; deferred?: boolean; finalScore: number; rounds: number; failedMetrics: string[] }> {
  let evaluatorFailures = 0
  const contract = compileChapterExecutionContract(workId, chapterId)
  if (!contract || contract.errors.length > 0) {
    throw new Error(`章节执行合同无效：${contract?.errors.join('；') || '章节不存在'}`)
  }

  const parseList = (raw: string): string[] => {
    try {
      const parsed = JSON.parse(raw) as unknown
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }
  const failureResult = (): {
    passed: false
    finalScore: number
    rounds: number
    failedMetrics: string[]
  } => {
    const episode = novelChapterAcceptanceDAO.getEpisode(episodeId)
    const bestCandidate = episode?.best_candidate_id == null
      ? null
      : novelChapterAcceptanceDAO.getCandidate(episode.best_candidate_id)
    const assessment = bestCandidate
      ? novelChapterAcceptanceDAO.findAssessment(episodeId, bestCandidate.id)
      : undefined
    return {
      passed: false,
      finalScore: assessment?.score_total ?? -1,
      rounds: episode?.assessments_used ?? 0,
      failedMetrics: assessment ? parseList(assessment.blocking_failures_json) : ['质量修订未收敛']
    }
  }
  const stopNonConvergent = (code: string, reason: string) => {
    blockNovelChapterAcceptance(episodeId, code, reason, 'quality')
    onProgress?.(`「${volumeChapterDAO.getChapter(chapterId)?.title ?? chapterId}」自动质量修订未收敛：${reason}`)
    return failureResult()
  }
  const rankFromAssessment = (
    assessment: NovelChapterAcceptanceAssessmentRow,
    wordCount: number
  ) => ({
    hardFail: assessment.hard_fail === 1,
    blockingFailures: parseList(assessment.blocking_failures_json).length,
    scoreTotal: assessment.score_total,
    wordCount,
    targetWords: contract.wordTarget
  })

  while (true) {
    assertNotAborted(signal)
    const episode = novelChapterAcceptanceDAO.getEpisode(episodeId)
    if (!episode) throw new Error(`章节验收事件不存在：${episodeId}`)
    if (episode.status === 'blocked') return failureResult()
    const ch = volumeChapterDAO.getChapter(chapterId)
    if (!ch?.content?.trim()) throw new Error('待诊断正文不存在')
    const content = ch.content.trim()
    const contentHash = novelChapterContentHash(content)
    const candidate = novelChapterAcceptanceDAO.addCandidate({
      episodeId,
      contentHash,
      sourceKind: 'baseline',
      content,
      wordCount: countWords(content)
    })
    let storedAssessment = novelChapterAcceptanceDAO.findAssessment(episodeId, candidate.id)
    const reusedStoredAssessment = storedAssessment != null
    let breakdown = storedAssessment ? parseQualityAiScoreReport(storedAssessment.report) : null
    let acceptance = storedAssessment
      ? {
          passed: storedAssessment.passed === 1,
          acceptedWithinTolerance: storedAssessment.passed === 1 && storedAssessment.score_total < qualityMin,
          blockingFailures: parseList(storedAssessment.blocking_failures_json),
          advisoryFailures: parseList(storedAssessment.advisory_failures_json),
          acceptanceFloor: Math.max(65, qualityMin - 5)
        }
      : null

    if (!storedAssessment) {
      if (episode.assessments_used >= episode.max_assessments) {
        return stopNonConvergent(
          'ASSESSMENT_BUDGET_EXHAUSTED',
          `已用完 ${episode.max_assessments} 次评估预算`
        )
      }
      onProgress?.(`正在诊断「${ch.title}」第 ${episode.assessments_used + 1}/${episode.max_assessments} 个质量候选`)
      const res = await diagnoseChapterQualityAi(workId, chapterId, content, {
        thinkingEnabled: getGoalLoopModelOpts(workId).thinkingEnabled,
        signal
      })
      if (!res.success) {
        if (res.failureKind === 'cancelled') {
          assertNotAborted(signal)
          throw new Error('质量诊断请求已取消')
        }
        evaluatorFailures++
        const duration = res.durationMs ? `，耗时 ${Math.round(res.durationMs / 1000)} 秒` : ''
        onProgress?.(
          `「${ch.title}」质量评估器第 ${evaluatorFailures}/${MAX_QUALITY_EVALUATOR_FAILURES} 次`
          + `${res.failureKind === 'protocol' ? '协议失败' : '调用失败'}${duration}：${res.error}`
        )
        if (shouldOpenQualityEvaluatorCircuit({
          failureKind: res.failureKind,
          consecutiveFailures: evaluatorFailures
        })) {
          throw new NovelPipelineError(
            qualityEvaluatorFailureCode(res.failureKind),
            `质量评估器连续 ${evaluatorFailures} 次${res.failureKind === 'protocol' ? '协议失败' : '不可用'}`
            + `，未消耗内容评估与修订预算；正文、候选和版本均已保留`
            + `；最后错误：${res.error}${duration}`
          )
        }
        continue
      }
      evaluatorFailures = 0
      breakdown = res.report ? parseQualityAiScoreReport(res.report) : null
      const recognizedHardFail = isRecognizedNovelHardFail(
        Boolean(res.hardFail),
        breakdown?.failedRules ?? []
      )
      acceptance = breakdown
        ? evaluateNovelQualityAcceptance({
            scoreTotal: res.scoreTotal,
            hardFail: recognizedHardFail,
            items: breakdown.items,
            actualWordCount: countWords(content),
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
      storedAssessment = novelChapterAcceptanceDAO.addAssessment({
        episodeId,
        candidateId: candidate.id,
        scoreTotal: res.scoreTotal,
        hardFail: recognizedHardFail,
        passed: acceptance.passed,
        blockingFailures: acceptance.blockingFailures,
        advisoryFailures: acceptance.advisoryFailures,
        topIssues: breakdown?.topIssues ?? [],
        patches: breakdown?.patches ?? [],
        report: res.report ?? ''
      })
    }

    if (!acceptance || !storedAssessment) {
      return stopNonConvergent('ASSESSMENT_PROTOCOL_INVALID', '质量诊断没有形成可持久化验收证据')
    }
    let qualityEvidence: unknown[] = []
    try {
      const parsed = JSON.parse(storedAssessment.top_issues_json) as unknown
      qualityEvidence = Array.isArray(parsed) ? parsed : []
    } catch {
      qualityEvidence = []
    }
    novelChapterGateDAO.setState({
      episodeId,
      candidateId: candidate.id,
      gateType: 'quality',
      status: acceptance.passed ? 'passed_model' : 'failed',
      score: storedAssessment.score_total,
      failureCode: acceptance.passed ? null : 'QUALITY_GATE_FAILED',
      failureReason: acceptance.passed ? null : acceptance.blockingFailures.join('；'),
      blockers: acceptance.blockingFailures,
      evidence: qualityEvidence,
      incrementAssessment: !reusedStoredAssessment
    })
    const latestEpisode = novelChapterAcceptanceDAO.getEpisode(episodeId)!
    const previousBestCandidate = latestEpisode.best_candidate_id == null
      ? undefined
      : novelChapterAcceptanceDAO.getCandidate(latestEpisode.best_candidate_id)
    const previousBestAssessment = previousBestCandidate
      ? novelChapterAcceptanceDAO.findAssessment(episodeId, previousBestCandidate.id)
      : undefined
    if (isBetterNovelBodyCandidate(
      rankFromAssessment(storedAssessment, candidate.word_count),
      previousBestCandidate && previousBestAssessment
        ? rankFromAssessment(previousBestAssessment, previousBestCandidate.word_count)
        : null
    )) {
      novelChapterAcceptanceDAO.setBestCandidate(episodeId, candidate.id)
    }

    if (acceptance.passed) {
      volumeChapterDAO.updateChapter(chapterId, {
        quality_assessment_json: serializeQualityAssessment({
          content,
          scoreTotal: storedAssessment.score_total,
          hardFail: false,
          report: storedAssessment.report
        })
      })
      if (acceptance.acceptedWithinTolerance) {
        onProgress?.(`「${ch.title}」承重门禁通过，质量 ${storedAssessment.score_total}/${qualityMin}，按软容差验收`)
      }
      return {
        passed: true,
        finalScore: storedAssessment.score_total,
        rounds: novelChapterAcceptanceDAO.getEpisode(episodeId)?.assessments_used ?? 0,
        failedMetrics: []
      }
    }

    const history: AcceptanceProgressPoint[] = novelChapterAcceptanceDAO.listAssessments(episodeId)
      .map(item => ({
        contentHash: item.content_hash ?? '',
        blockingFailures: parseList(item.blocking_failures_json),
        scoreTotal: item.score_total
      }))
    const stall = detectChapterAcceptanceStall(history)
    if (stall) return stopNonConvergent(stall.code, stall.message)

    const budget = novelChapterAcceptanceDAO.getEpisode(episodeId)!
    if (budget.assessments_used >= budget.max_assessments) {
      return stopNonConvergent(
        'ASSESSMENT_BUDGET_EXHAUSTED',
        `累计 ${budget.assessments_used} 次评估仍未通过：${acceptance.blockingFailures.join('、')}`
      )
    }
    const qualityGate = novelChapterGateDAO.getState(episodeId, candidate.id, 'quality')
    if ((qualityGate?.repair_count ?? 0) >= CHAPTER_QUALITY_MAX_REPAIRS) {
      return stopNonConvergent(
        'REPAIR_BUDGET_EXHAUSTED',
        `当前质量候选已用完 ${CHAPTER_QUALITY_MAX_REPAIRS} 次定点修订预算：${acceptance.blockingFailures.join('、')}`
      )
    }
    if (budget.repairs_used >= budget.max_repairs) {
      return stopNonConvergent('REPAIR_BUDGET_EXHAUSTED', '章节联合门禁总修订预算已耗尽')
    }

    const exactPatch = applyExactQualityPatches(content, breakdown?.patches ?? [])
    if (!exactPatch.success) {
      return stopNonConvergent(
        'EVIDENCE_PATCH_UNAVAILABLE',
        `${exactPatch.error}；禁止改写整章`
      )
    }
    const fixed = stripDeterministicAiPatterns(
      normalizeModelBodyOutput(exactPatch.content, 'body_generation')
    )
    const fixedWords = countWords(fixed)
    if (fixedWords < contract.wordMin || fixedWords > contract.wordMax) {
      return stopNonConvergent(
        'PATCH_CONTRACT_VIOLATION',
        `证据补丁会使正文变为 ${fixedWords} 字，越过合同 ${contract.wordMin}-${contract.wordMax}`
      )
    }
    const fixedHash = novelChapterContentHash(fixed)
    const existingCandidate = novelChapterAcceptanceDAO.findCandidate(episodeId, fixedHash)
    if (existingCandidate) {
      const existingAssessment = novelChapterAcceptanceDAO.findAssessment(episodeId, existingCandidate.id)
      if (existingCandidate.parent_content_hash === contentHash && !existingAssessment) {
        volumeChapterDAO.updateChapterWithVersion(chapterId, {
          content: existingCandidate.content,
          word_count: existingCandidate.word_count,
          status: 'draft',
          emotion_assessment_json: null,
          quality_assessment_json: null
        }, { model_type: 'quality_evidence_patch' })
        continue
      }
      return stopNonConvergent('REPEATED_BODY', '证据补丁会回到已经评估过的正文候选')
    }
    novelChapterAcceptanceDAO.reserveRepairCandidate({
      episodeId,
      contentHash: fixedHash,
      parentContentHash: contentHash,
      sourceKind: 'quality_patch',
      gateType: 'quality',
      gateRepairLimit: CHAPTER_QUALITY_MAX_REPAIRS,
      content: fixed,
      wordCount: fixedWords
    })
    volumeChapterDAO.updateChapterWithVersion(chapterId, {
      content: fixed,
      word_count: fixedWords,
      status: 'draft',
      emotion_assessment_json: null,
      quality_assessment_json: null
    }, { model_type: 'quality_evidence_patch' })
    onProgress?.(
      `「${ch.title}」已原子应用 ${exactPatch.applied.length} 条原文证据补丁；正在复验新候选`
    )
  }
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
): Promise<{
  passed: boolean
  deferred?: boolean
  qualityScore: number
  emotionScore?: number
  rounds: number
  failedMetrics: string[]
  blockedGate?: NovelChapterGateType
  failureCode?: string
  wordRange?: ChapterWordRangeFailure
}> {
  const chapterForTransaction = volumeChapterDAO.getChapter(chapterId)
  const contentForTransaction = chapterForTransaction?.content?.trim() ?? ''
  const contractForTransaction = compileChapterExecutionContract(workId, chapterId)
  if (!chapterForTransaction || !contentForTransaction) {
    return {
      passed: false,
      qualityScore: -1,
      rounds: 0,
      blockedGate: 'execution_contract',
      failureCode: 'EMPTY_BODY',
      failedMetrics: ['最终正文为空']
    }
  }
  if (!contractForTransaction || contractForTransaction.errors.length > 0) {
    return {
      passed: false,
      qualityScore: -1,
      rounds: 0,
      blockedGate: 'execution_contract',
      failureCode: 'CONTRACT_INVALID',
      failedMetrics: [`章节合同无效：${contractForTransaction?.errors.join('；') || '无法编译'}`]
    }
  }
  const transactionWordCount = countWords(contentForTransaction)
  if (chapterForTransaction.word_count !== transactionWordCount) {
    volumeChapterDAO.updateChapter(chapterId, { word_count: transactionWordCount })
  }
  if (
    transactionWordCount < contractForTransaction.wordMin
    || transactionWordCount > contractForTransaction.wordMax
  ) {
    const wordRange: ChapterWordRangeFailure = {
      actual: transactionWordCount,
      min: contractForTransaction.wordMin,
      target: contractForTransaction.wordTarget,
      max: contractForTransaction.wordMax,
      direction: transactionWordCount > contractForTransaction.wordMax ? 'compress' : 'expand'
    }
    return {
      passed: false,
      qualityScore: -1,
      rounds: 0,
      blockedGate: 'execution_contract',
      failureCode: 'BODY_WORD_RANGE_NON_CONVERGENT',
      wordRange,
      failedMetrics: [
        `章节字数 ${transactionWordCount} 不在合同范围 ${contractForTransaction.wordMin}-${contractForTransaction.wordMax}`
      ]
    }
  }
  const transactionEpisode = ensureNovelChapterAcceptanceEpisode(workId, chapterId, config)
  const transactionCandidate = novelChapterAcceptanceDAO.addCandidate({
    episodeId: transactionEpisode.id,
    contentHash: novelChapterContentHash(contentForTransaction),
    sourceKind: 'baseline',
    content: contentForTransaction,
    wordCount: transactionWordCount
  })
  const cachedQuality = parseCachedQualityAssessment(
    chapterForTransaction.quality_assessment_json,
    contentForTransaction
  )
  const cachedEmotion = parseStoredEmotionAssessment(chapterForTransaction.emotion_assessment_json)
  novelChapterGateDAO.setState({
    episodeId: transactionEpisode.id,
    candidateId: transactionCandidate.id,
    gateType: 'quality',
    status: 'deferred',
    score: cachedQuality?.scoreTotal ?? null,
    failureCode: 'EDITORIAL_DEBT',
    failureReason: '质量评审已移至卷级异步编辑审读',
    blockers: []
  })
  novelChapterGateDAO.setState({
    episodeId: transactionEpisode.id,
    candidateId: transactionCandidate.id,
    gateType: 'emotion',
    status: 'deferred',
    score: cachedEmotion?.score ?? null,
    failureCode: config.checkEmotionGate ? 'EDITORIAL_DEBT' : 'USER_DISABLED',
    failureReason: config.checkEmotionGate
      ? '情绪评审已移至卷级异步编辑审读'
      : '用户已关闭情绪门禁审读',
    blockers: []
  })
  recordChapterEditorialDebt({
    workId,
    chapterId,
    kind: 'quality',
    score: cachedQuality?.scoreTotal,
    issues: ['等待卷级独立编辑审读，不阻塞章节事务提交']
  })
  if (config.checkEmotionGate) {
    recordChapterEditorialDebt({
      workId,
      chapterId,
      kind: 'emotion',
      score: cachedEmotion?.score,
      issues: ['等待卷级情绪曲线审读，不触发同步改写']
    })
  }
  onProgress?.(
    `「${chapterForTransaction.title}」正文结构与字数合同通过；质量已登记为卷级编辑债务，`
      + (config.checkEmotionGate ? '情绪审读已登记为编辑债务' : '情绪门禁已按用户设置关闭')
  )
  return {
    passed: true,
    qualityScore: cachedQuality?.scoreTotal ?? -1,
    emotionScore: cachedEmotion?.score,
    rounds: 0,
    failedMetrics: []
  }
}

/**
 * 卷级异步编辑审读。它可以形成编辑债务或后续卷级建议，不能作为章节提交状态机的回边。
 */
export async function runChapterEditorialReview(
  workId: number,
  chapterId: number,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<{
  passed: boolean
  deferred?: boolean
  qualityScore: number
  emotionScore?: number
  rounds: number
  failedMetrics: string[]
  blockedGate?: NovelChapterGateType
  failureCode?: string
}> {
  let episode = ensureNovelChapterAcceptanceEpisode(workId, chapterId, config)
  const currentChapter = volumeChapterDAO.getChapter(chapterId)
  const currentContentHash = novelChapterContentHash(currentChapter?.content?.trim() ?? '')
  if (episode.status === 'awaiting_resume') {
    episode = beginNovelChapterAcceptanceResume(episode.id, currentContentHash)
  }
  if (episode.status === 'blocked') {
    const best = episode.best_candidate_id == null
      ? undefined
      : novelChapterAcceptanceDAO.getCandidate(episode.best_candidate_id)
    const assessment = best
      ? novelChapterAcceptanceDAO.findAssessment(episode.id, best.id)
      : undefined
    const projectedCandidate = novelChapterAcceptanceDAO.findCandidate(
      episode.id,
      currentContentHash
    ) ?? best
    const failedGate = projectedCandidate
      ? novelChapterGateDAO.listStates(episode.id, projectedCandidate.id)
        .find(gate => gate.status === 'failed')
      : undefined
    let failedMetrics: string[] = []
    try {
      const parsed = JSON.parse(failedGate?.blockers_json ?? '[]') as unknown
      failedMetrics = Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : []
    } catch {
      failedMetrics = []
    }
    const cachedQuality = parseCachedQualityAssessment(
      currentChapter?.quality_assessment_json,
      currentChapter?.content ?? ''
    )
    return {
      passed: false,
      qualityScore: cachedQuality?.scoreTotal ?? assessment?.score_total ?? -1,
      rounds: failedGate?.gate_type === 'quality' ? episode.assessments_used : 0,
      blockedGate: failedGate?.gate_type,
      failureCode: failedGate?.failure_code ?? episode.terminal_code ?? undefined,
      failedMetrics: failedMetrics.length
        ? failedMetrics
        : [failedGate?.failure_reason ?? episode.terminal_reason ?? '章节门禁未通过']
    }
  }
  let totalQualityRounds = 0
  let qualityScore = -1
  const failures: string[] = []

  for (let convergenceRound = 1; convergenceRound <= MAX_CHAPTER_CONVERGENCE_ROUNDS; convergenceRound++) {
    if (config.diagnoseBodyAfterGeneration && config.qualityMin > 0) {
      const current = volumeChapterDAO.getChapter(chapterId)
      const cachedQuality = parseCachedQualityAssessment(
        current?.quality_assessment_json,
        current?.content ?? ''
      )
      if (cachedQuality && isStrictCachedQualityReady(cachedQuality)) {
        qualityScore = cachedQuality.scoreTotal
        const currentCandidate = novelChapterAcceptanceDAO.findCandidate(
          episode.id,
          novelChapterContentHash(current?.content?.trim() ?? '')
        )
        if (currentCandidate) {
          novelChapterGateDAO.setState({
            episodeId: episode.id,
            candidateId: currentCandidate.id,
            gateType: 'quality',
            status: cachedQuality.acceptedByAuthor ? 'passed_author' : 'passed_model',
            score: cachedQuality.scoreTotal,
            blockers: []
          })
        }
        onProgress?.(`「${current?.title ?? chapterId}」复用当前正文已通过的质量检查点 ${qualityScore} 分`)
      } else {
        const quality = await diagnoseAndFixUntilPass(
          workId,
          chapterId,
          config.qualityMin,
          config.qualityMetricMins,
          episode.id,
          signal,
          onProgress
        )
        totalQualityRounds += quality.rounds
        qualityScore = quality.finalScore
        failures.push(...quality.failedMetrics)
        if (!quality.passed) {
          return {
            passed: false,
            qualityScore,
            rounds: totalQualityRounds,
            failedMetrics: [...new Set(failures)],
            ...acceptanceFailureProjection(
              episode.id,
              novelChapterContentHash(volumeChapterDAO.getChapter(chapterId)?.content?.trim() ?? '')
            )
          }
        }
      }
    }

    const cleaned = cleanupEmDashesAfterPassedGate(workId, 'comma', [chapterId])
    if (cleaned.replaced > 0) {
      onProgress?.(`「${volumeChapterDAO.getChapter(chapterId)?.title ?? chapterId}」清理破折号后正在重新执行质量门禁`)
      failures.push(`清理破折号 ${cleaned.replaced} 处后需复验`)
      continue
    }
    if (!config.checkEmotionGate) {
      const skippedChapter = volumeChapterDAO.getChapter(chapterId)
      const skippedCandidate = novelChapterAcceptanceDAO.findCandidate(
        episode.id,
        novelChapterContentHash(skippedChapter?.content?.trim() ?? '')
      )
      if (skippedCandidate) {
        novelChapterGateDAO.setState({
          episodeId: episode.id,
          candidateId: skippedCandidate.id,
          gateType: 'emotion',
          status: 'deferred',
          failureCode: 'USER_DISABLED',
          failureReason: '用户已关闭情绪门禁审读',
          blockers: []
        })
      }
      onProgress?.(`「${skippedChapter?.title ?? chapterId}」按用户设置跳过情绪门禁`)
      clearChapterEditorialDebt({ workId, chapterId, kinds: ['quality'] })
      return {
        passed: true,
        deferred: false,
        qualityScore,
        rounds: totalQualityRounds,
        failedMetrics: []
      }
    }
    const chapter = volumeChapterDAO.getChapter(chapterId)
    const assessment = await assessChapterEmotion(workId, chapterId, chapter?.content ?? '', signal, true)
    const assessedCandidate = novelChapterAcceptanceDAO.findCandidate(
      episode.id,
      novelChapterContentHash(chapter?.content?.trim() ?? '')
    )
    if (assessedCandidate) {
      novelChapterGateDAO.setState({
        episodeId: episode.id,
        candidateId: assessedCandidate.id,
        gateType: 'emotion',
        status: assessment.passed ? 'passed_model' : 'failed',
        score: assessment.score,
        failureCode: assessment.passed ? null : 'EMOTION_GATE_FAILED',
        failureReason: assessment.passed
          ? null
          : `情绪门禁 ${assessment.score}分/${assessment.failure_layer}层`,
        blockers: assessment.blocking_issues,
        evidence: assessment.actual_reader_curve,
        incrementAssessment: true
      })
    }
    if (assessment.passed) {
      clearChapterEditorialDebt({ workId, chapterId, kinds: ['quality', 'emotion'] })
      onProgress?.(`「${chapter?.title ?? chapterId}」质量与情绪门禁均已通过`)
      return {
        passed: true,
        deferred: false,
        qualityScore,
        emotionScore: assessment.score,
        rounds: totalQualityRounds,
        failedMetrics: []
      }
    }

    failures.push(`情绪门禁 ${assessment.score}分/${assessment.failure_layer}层`)
    if (convergenceRound === MAX_CHAPTER_CONVERGENCE_ROUNDS) {
      blockNovelChapterAcceptance(
        episode.id,
        'EMOTION_NON_CONVERGENT',
        `情绪门禁连续 ${MAX_CHAPTER_CONVERGENCE_ROUNDS} 轮未通过`,
        'emotion',
        assessment.blocking_issues
      )
      break
    }
    const beforeRepair = volumeChapterDAO.getChapter(chapterId)?.content?.trim() ?? ''
    const repairBudget = novelChapterAcceptanceDAO.getEpisode(episode.id)
    const emotionCandidate = novelChapterAcceptanceDAO.findCandidate(
      episode.id,
      novelChapterContentHash(beforeRepair)
    )
    const emotionGate = emotionCandidate
      ? novelChapterGateDAO.getState(episode.id, emotionCandidate.id, 'emotion')
      : undefined
    if ((emotionGate?.repair_count ?? 0) >= CHAPTER_EMOTION_MAX_REPAIRS) {
      blockNovelChapterAcceptance(
        episode.id,
        'REPAIR_BUDGET_EXHAUSTED',
        `当前情绪候选已用完 ${CHAPTER_EMOTION_MAX_REPAIRS} 次定点修订预算`,
        'emotion',
        assessment.blocking_issues
      )
      break
    }
    if (!repairBudget || repairBudget.repairs_used >= repairBudget.max_repairs) {
      blockNovelChapterAcceptance(
        episode.id,
        'REPAIR_BUDGET_EXHAUSTED',
        '章节联合门禁总修订预算已耗尽',
        'emotion',
        assessment.blocking_issues
      )
      break
    }
    onProgress?.(
      `「${chapter?.title ?? chapterId}」情绪门禁未通过（${assessment.score}分），正在修订并重新执行质量门禁`
    )
    const revised = await repairNovelChapterByEvidencePatches({
      workId,
      chapterId,
      content: beforeRepair,
      kind: 'emotion',
      issues: [emotionRepairHint(assessment)],
      signal
    })
    if (!revised.success) {
      failures.push(revised.error || '情绪定向修订失败')
      blockNovelChapterAcceptance(
        episode.id,
        'EMOTION_REPAIR_FAILED',
        revised.error || '情绪定向修订没有产生有效候选',
        'emotion',
        assessment.blocking_issues
      )
      break
    }
    const afterRepair = revised.content.trim()
    const parentHash = novelChapterContentHash(beforeRepair)
    const repairedHash = novelChapterContentHash(afterRepair)
    if (!afterRepair || repairedHash === parentHash) {
      blockNovelChapterAcceptance(
        episode.id,
        'EMOTION_REPAIR_NO_CHANGE',
        '情绪定向修订没有改变正文',
        'emotion',
        assessment.blocking_issues
      )
      break
    }
    if (novelChapterAcceptanceDAO.findCandidate(episode.id, repairedHash)) {
      blockNovelChapterAcceptance(
        episode.id,
        'REPEATED_BODY',
        '情绪定向修订回到了已评估正文',
        'emotion',
        assessment.blocking_issues
      )
      break
    }
    novelChapterAcceptanceDAO.reserveRepairCandidate({
      episodeId: episode.id,
      contentHash: repairedHash,
      parentContentHash: parentHash,
      sourceKind: 'emotion_repair',
      gateType: 'emotion',
      gateRepairLimit: CHAPTER_EMOTION_MAX_REPAIRS,
      content: afterRepair,
      wordCount: countWords(afterRepair)
    })
    clearChapterNarrativeMemory(workId, chapterId)
    volumeChapterDAO.updateChapterWithVersion(chapterId, {
      content: afterRepair,
      word_count: countWords(afterRepair),
      status: 'draft',
      emotion_assessment_json: null,
      quality_assessment_json: null
    }, { model_type: 'emotion_evidence_patch' })
    onProgress?.(`「${chapter?.title ?? chapterId}」已原子应用 ${revised.appliedCount} 条情绪证据补丁`)
  }

  return {
    passed: false,
    qualityScore,
    emotionScore: undefined,
    rounds: totalQualityRounds,
    failedMetrics: [...new Set(failures)],
    ...acceptanceFailureProjection(
      episode.id,
      novelChapterContentHash(volumeChapterDAO.getChapter(chapterId)?.content?.trim() ?? '')
    )
  }
}

export async function runChapterConvergenceGate(
  workId: number,
  chapterId: number,
  config: StoryGoalConfig,
  signal?: AbortSignal,
  onProgress?: (message: string) => void
): Promise<Awaited<ReturnType<typeof runChapterAcceptanceGate>>> {
  let lastAcceptance: Awaited<ReturnType<typeof runChapterAcceptanceGate>> | null = null
  for (let round = 1; round <= MAX_CHAPTER_CONVERGENCE_ROUNDS; round++) {
    const acceptance = await runChapterAcceptanceGate(workId, chapterId, config, signal, onProgress)
    lastAcceptance = acceptance
    if (!acceptance.passed) return acceptance

    const contract = persistChapterExecutionContract(workId, chapterId)
    const chapter = volumeChapterDAO.getChapter(chapterId)
    if (!contract || !chapter?.content?.trim()) {
      return {
        ...acceptance,
        passed: false,
        failedMetrics: [...acceptance.failedMetrics, '无法编译章节合同或最终正文为空']
      }
    }

    onProgress?.(`「${chapter.title}」正在执行唯一一次章节硬合同验证`)
    let gate = await assessNovelExecutionCandidate(workId, chapterId, chapter.content, contract, signal)
    if (isNovelExecutionEvaluatorFailure(gate.blockers)) {
      throw new NovelPipelineError(
        'EVALUATOR_PROTOCOL',
        '章节硬合同评估器未返回有效证据；本事务不重试，正文与版本均已保留'
      )
    }
    const gateEpisode = ensureNovelChapterAcceptanceEpisode(workId, chapterId, config)
    const gateCandidate = novelChapterAcceptanceDAO.findCandidate(
      gateEpisode.id,
      novelChapterContentHash(chapter.content)
    )
    if (gateCandidate) {
      novelChapterGateDAO.setState({
        episodeId: gateEpisode.id,
        candidateId: gateCandidate.id,
        gateType: 'execution_contract',
        status: gate.passed ? 'passed_model' : 'failed',
        failureCode: gate.passed ? null : 'EXECUTION_CONTRACT_FAILED',
        failureReason: gate.passed ? null : gate.blockers.join('；'),
        blockers: gate.blockers,
        evidence: gate.coverage,
        incrementAssessment: true
      })
    }
    if (gate.passed) {
      markChapterExecutionAccepted(chapterId, chapter.content, contract.sourceOutlineHash)
      finishNovelChapterAcceptanceAccepted(gateEpisode.id)
      onProgress?.(`「${chapter.title}」最终章节合同全部 covered，正文已冻结并进入预提交制品阶段`)
      return acceptance
    }
    if (round === MAX_CHAPTER_CONVERGENCE_ROUNDS) {
      const episode = ensureNovelChapterAcceptanceEpisode(workId, chapterId, config)
      blockNovelChapterAcceptance(
        episode.id,
        'EXECUTION_CONTRACT_NON_CONVERGENT',
        `最终章节合同连续 ${MAX_CHAPTER_CONVERGENCE_ROUNDS} 轮仍未通过`,
        'execution_contract',
        gate.blockers
      )
      return {
        ...acceptance,
        passed: false,
        blockedGate: 'execution_contract',
        failureCode: 'EXECUTION_CONTRACT_NON_CONVERGENT',
        failedMetrics: [...new Set([
          ...acceptance.failedMetrics,
          ...gate.blockers.map(item => `章节合同：${item}`)
        ])]
      }
    }

    const episode = ensureNovelChapterAcceptanceEpisode(workId, chapterId, config)
    const contractCandidate = novelChapterAcceptanceDAO.findCandidate(
      episode.id,
      novelChapterContentHash(chapter.content)
    )
    const contractGate = contractCandidate
      ? novelChapterGateDAO.getState(episode.id, contractCandidate.id, 'execution_contract')
      : undefined
    if ((contractGate?.repair_count ?? 0) >= CHAPTER_EXECUTION_CONTRACT_MAX_REPAIRS) {
      blockNovelChapterAcceptance(
        episode.id,
        'REPAIR_BUDGET_EXHAUSTED',
        `当前合同候选已用完 ${CHAPTER_EXECUTION_CONTRACT_MAX_REPAIRS} 次定点修订预算`,
        'execution_contract',
        gate.blockers
      )
      return {
        ...acceptance,
        passed: false,
        blockedGate: 'execution_contract',
        failureCode: 'REPAIR_BUDGET_EXHAUSTED',
        failedMetrics: [...acceptance.failedMetrics, '合同门禁定点修订预算已耗尽']
      }
    }
    if (episode.repairs_used >= episode.max_repairs) {
      blockNovelChapterAcceptance(
        episode.id,
        'REPAIR_BUDGET_EXHAUSTED',
        '章节联合门禁总修订预算已耗尽',
        'execution_contract',
        gate.blockers
      )
      return {
        ...acceptance,
        passed: false,
        blockedGate: 'execution_contract',
        failureCode: 'REPAIR_BUDGET_EXHAUSTED',
        failedMetrics: [...acceptance.failedMetrics, '章节联合门禁总修订预算已耗尽']
      }
    }
    onProgress?.(`「${chapter.title}」最终合同复验未通过，正在本章内定向修复；不会进入下一章`)
    const repaired = await repairNovelChapterByEvidencePatches({
      workId,
      chapterId,
      content: chapter.content,
      kind: 'execution_contract',
      issues: gate.blockers,
      contract,
      signal
    })
    if (!repaired.success || !repaired.content.trim()) {
      blockNovelChapterAcceptance(
        episode.id,
        'EXECUTION_CONTRACT_REPAIR_FAILED',
        repaired.error || '章节合同定向修复失败',
        'execution_contract',
        gate.blockers
      )
      return {
        ...acceptance,
        passed: false,
        blockedGate: 'execution_contract',
        failureCode: 'EXECUTION_CONTRACT_REPAIR_FAILED',
        failedMetrics: [...acceptance.failedMetrics, repaired.error || '章节合同定向修复失败']
      }
    }
    const normalized = stripDeterministicAiPatterns(
      normalizeModelBodyOutput(repaired.content.trim(), 'body_generation')
    )
    const parentHash = novelChapterContentHash(chapter.content)
    const repairedHash = novelChapterContentHash(normalized)
    if (repairedHash === parentHash || novelChapterAcceptanceDAO.findCandidate(episode.id, repairedHash)) {
      blockNovelChapterAcceptance(
        episode.id,
        'REPEATED_BODY',
        '章节合同定向修复没有产生新的正文候选',
        'execution_contract',
        gate.blockers
      )
      return {
        ...acceptance,
        passed: false,
        blockedGate: 'execution_contract',
        failureCode: 'REPEATED_BODY',
        failedMetrics: [...acceptance.failedMetrics, '章节合同修订正文重复']
      }
    }
    novelChapterAcceptanceDAO.reserveRepairCandidate({
      episodeId: episode.id,
      contentHash: repairedHash,
      parentContentHash: parentHash,
      sourceKind: 'contract_repair',
      gateType: 'execution_contract',
      gateRepairLimit: CHAPTER_EXECUTION_CONTRACT_MAX_REPAIRS,
      content: normalized,
      wordCount: countWords(normalized)
    })
    onProgress?.(`「${chapter.title}」已原子应用 ${repaired.appliedCount} 条章节合同证据补丁`)
    clearChapterNarrativeMemory(workId, chapterId)
    volumeChapterDAO.updateChapterWithVersion(chapterId, {
      content: normalized,
      word_count: countWords(normalized),
      status: 'draft',
      emotion_assessment_json: null,
      quality_assessment_json: null
    })
  }
  return lastAcceptance ?? {
    passed: false,
    qualityScore: -1,
    rounds: 0,
    failedMetrics: ['章节联合门禁未执行']
  }
}

export { novelMemoryCommitBlockers } from './novel-memory-commit-blockers'
