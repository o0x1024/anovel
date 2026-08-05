import { createHash } from 'node:crypto'
import {
  goalRoutineDAO,
  novelChapterGateDAO,
  novelChapterAcceptanceDAO,
  volumeChapterDAO,
  workflowModelContractDAO,
  type NovelChapterAcceptanceAssessmentRow,
  type NovelChapterAcceptanceCandidateRow,
  type NovelChapterAcceptanceEpisodeRow,
  type NovelChapterGateStatus,
  type NovelChapterGateType
} from '../../db'
import type { StoryGoalConfig } from './story-goal-checker'
import { compileChapterExecutionContract } from '../chapter-execution-context'
import {
  CHAPTER_ACCEPTANCE_MAX_ASSESSMENTS,
  CHAPTER_ACCEPTANCE_MAX_REPAIRS,
  CHAPTER_ACCEPTANCE_PROTOCOL_VERSION,
  novelChapterAcceptanceKey,
  novelChapterContentHash
} from './novel-chapter-acceptance-policy'

export interface NovelChapterAcceptanceIdentity {
  episodeKey: string
  baseContentHash: string
  currentContentHash: string
  contractHash: string
  protocolVersion: number
}

export interface NovelChapterAcceptanceSummary {
  episodeId: number
  status: NovelChapterAcceptanceEpisodeRow['status']
  chapterId: number
  chapterTitle: string
  assessmentsUsed: number
  maxAssessments: number
  repairsUsed: number
  maxRepairs: number
  bestScore: number | null
  bestContentHash: string | null
  currentContentHash: string
  contentChanged: boolean
  terminalCode: string | null
  terminalReason: string | null
  authorNote: string | null
  gates: Array<{
    gateType: NovelChapterGateType
    status: NovelChapterGateStatus
    score: number | null
    failureCode: string | null
    failureReason: string | null
    blockers: string[]
  }>
  blockedGate: NovelChapterGateType | null
  canResumeDownstream: boolean
  blockingFailures: string[]
  advisoryFailures: string[]
  evidence: Array<{ id: string; evidence: string; fixHint: string }>
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function parseEvidence(raw: string): Array<{ id: string; evidence: string; fixHint: string }> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap(item => {
      if (!item || typeof item !== 'object') return []
      const row = item as Record<string, unknown>
      return [{
        id: typeof row.id === 'string' ? row.id : '',
        evidence: typeof row.evidence === 'string' ? row.evidence : '',
        fixHint: typeof row.fixHint === 'string' ? row.fixHint : ''
      }]
    })
  } catch {
    return []
  }
}

function acceptanceContractHash(
  workId: number,
  chapterId: number,
  config: StoryGoalConfig
): string {
  const contract = compileChapterExecutionContract(workId, chapterId)
  if (!contract || contract.errors.length > 0) {
    throw new Error(`章节执行合同无效：${contract?.errors.join('；') || '章节不存在'}`)
  }
  const runId = goalRoutineDAO.getByWork(workId)?.id
  return createHash('sha256').update(JSON.stringify({
    contract,
    qualityMin: config.qualityMin,
    qualityMetricMins: config.qualityMetricMins,
    diagnoseBodyAfterGeneration: config.diagnoseBodyAfterGeneration,
    checkEmotionContract: config.checkEmotionContract,
    checkEmotionGate: config.checkEmotionGate,
    evaluatorModelContractHash: runId == null ? null : workflowModelContractDAO.getHash(runId)
  })).digest('hex')
}

function reusableAcceptanceEpisode(
  episode: NovelChapterAcceptanceEpisodeRow | null,
  contentHash: string
): NovelChapterAcceptanceEpisodeRow | null {
  if (!episode || episode.status !== 'accepted') return episode
  const candidate = novelChapterAcceptanceDAO.findCandidate(episode.id, contentHash)
  return candidate && episode.best_candidate_id === candidate.id ? episode : null
}

export function resolveNovelChapterAcceptanceIdentity(
  workId: number,
  chapterId: number,
  config: StoryGoalConfig
): NovelChapterAcceptanceIdentity {
  const chapter = volumeChapterDAO.getChapter(chapterId)
  const content = chapter?.content?.trim() ?? ''
  if (!content) throw new Error(`章节 ${chapterId} 没有待验收正文`)
  const currentContentHash = novelChapterContentHash(content)
  const contractHash = acceptanceContractHash(workId, chapterId, config)
  const existing = reusableAcceptanceEpisode(
    novelChapterAcceptanceDAO.findEpisodeByCandidate({
      workId,
      chapterId,
      contentHash: currentContentHash,
      contractHash,
      protocolVersion: CHAPTER_ACCEPTANCE_PROTOCOL_VERSION
    }),
    currentContentHash
  )
  const baseContentHash = existing?.base_content_hash ?? currentContentHash
  return {
    episodeKey: existing?.episode_key ?? novelChapterAcceptanceKey({
      workId,
      chapterId,
      baseContentHash,
      contractHash,
      protocolVersion: CHAPTER_ACCEPTANCE_PROTOCOL_VERSION
    }),
    baseContentHash,
    currentContentHash,
    contractHash,
    protocolVersion: CHAPTER_ACCEPTANCE_PROTOCOL_VERSION
  }
}

export function ensureNovelChapterAcceptanceEpisode(
  workId: number,
  chapterId: number,
  config: StoryGoalConfig
): NovelChapterAcceptanceEpisodeRow {
  const identity = resolveNovelChapterAcceptanceIdentity(workId, chapterId, config)
  const runId = goalRoutineDAO.getByWork(workId)?.id
  let episode = reusableAcceptanceEpisode(
    novelChapterAcceptanceDAO.findEpisodeByCandidate({
      workId,
      chapterId,
      contentHash: identity.currentContentHash,
      contractHash: identity.contractHash,
      protocolVersion: identity.protocolVersion
    }),
    identity.currentContentHash
  )
  if (!episode) {
    episode = novelChapterAcceptanceDAO.createEpisode({
      episodeKey: identity.episodeKey,
      workId,
      chapterId,
      runId,
      baseContentHash: identity.baseContentHash,
      contractHash: identity.contractHash,
      protocolVersion: identity.protocolVersion,
      maxAssessments: CHAPTER_ACCEPTANCE_MAX_ASSESSMENTS,
      maxRepairs: CHAPTER_ACCEPTANCE_MAX_REPAIRS
    })
  } else {
    novelChapterAcceptanceDAO.touchRun(episode.id, runId)
  }
  const chapter = volumeChapterDAO.getChapter(chapterId)!
  const candidate = novelChapterAcceptanceDAO.addCandidate({
    episodeId: episode.id,
    contentHash: identity.currentContentHash,
    sourceKind: 'baseline',
    content: chapter.content?.trim() ?? '',
    wordCount: chapter.word_count ?? 0
  })
  novelChapterGateDAO.ensureStates(episode.id, candidate.id)
  return novelChapterAcceptanceDAO.getEpisode(episode.id)!
}

export function beginNovelChapterAcceptanceResume(
  episodeId: number,
  expectedContentHash: string
): NovelChapterAcceptanceEpisodeRow {
  const episode = novelChapterAcceptanceDAO.getEpisode(episodeId)
  if (!episode || episode.status !== 'awaiting_resume') {
    throw new Error('章节验收事件不在等待恢复状态')
  }
  const candidate = novelChapterAcceptanceDAO.findCandidate(episode.id, expectedContentHash)
  if (!candidate) throw new Error('等待恢复的正文候选不存在')
  const decision = novelChapterGateDAO.findAuthorDecision({
    episodeId: episode.id,
    candidateId: candidate.id,
    gateType: 'quality',
    contentHash: candidate.content_hash,
    contractHash: episode.contract_hash
  })
  if (!decision) throw new Error('当前正文没有有效的作者质量决策')
  return novelChapterAcceptanceDAO.beginExplicitResume(episode.id)
}

function bestAssessment(
  episode: NovelChapterAcceptanceEpisodeRow
): {
  candidate: NovelChapterAcceptanceCandidateRow | null
  assessment: NovelChapterAcceptanceAssessmentRow | null
} {
  if (episode.best_candidate_id == null) return { candidate: null, assessment: null }
  const candidate = novelChapterAcceptanceDAO.getCandidate(episode.best_candidate_id) ?? null
  const assessment = candidate
    ? novelChapterAcceptanceDAO.findAssessment(episode.id, candidate.id) ?? null
    : null
  return { candidate, assessment }
}

export function restoreNovelChapterAcceptanceBest(
  episodeId: number
): NovelChapterAcceptanceCandidateRow | null {
  const episode = novelChapterAcceptanceDAO.getEpisode(episodeId)
  if (!episode) return null
  const { candidate } = bestAssessment(episode)
  if (!candidate) return null
  const chapter = volumeChapterDAO.getChapter(episode.chapter_id)
  if (chapter?.content?.trim() !== candidate.content) {
    volumeChapterDAO.updateChapterWithVersion(episode.chapter_id, {
      content: candidate.content,
      word_count: candidate.word_count,
      status: 'draft',
      emotion_assessment_json: null,
      quality_assessment_json: null
    }, { model_type: 'acceptance_best_restore' })
  }
  return candidate
}

export function blockNovelChapterAcceptance(
  episodeId: number,
  code: string,
  reason: string,
  gateType: NovelChapterGateType = 'quality',
  blockers: string[] = [reason]
): void {
  const episode = novelChapterAcceptanceDAO.getEpisode(episodeId)
  if (!episode) return
  const currentChapter = volumeChapterDAO.getChapter(episode.chapter_id)
  const currentCandidate = currentChapter?.content?.trim()
    ? novelChapterAcceptanceDAO.findCandidate(
        episodeId,
        novelChapterContentHash(currentChapter.content.trim())
      )
    : undefined
  const candidate = currentCandidate
  if (candidate && gateType !== 'quality') {
    novelChapterAcceptanceDAO.setBestCandidate(episodeId, candidate.id)
  }
  if (episode && candidate) {
    novelChapterGateDAO.setState({
      episodeId,
      candidateId: candidate.id,
      gateType,
      status: 'failed',
      failureCode: code,
      failureReason: reason,
      blockers
    })
  }
  if (gateType === 'quality') {
    restoreNovelChapterAcceptanceBest(episodeId)
  }
  novelChapterAcceptanceDAO.finish(episodeId, {
    status: 'blocked',
    terminalCode: code,
    terminalReason: reason
  })
}

export function finishNovelChapterAcceptanceAccepted(episodeId: number): void {
  const episode = novelChapterAcceptanceDAO.getEpisode(episodeId)
  const chapter = episode ? volumeChapterDAO.getChapter(episode.chapter_id) : null
  const candidate = chapter?.content?.trim()
    ? novelChapterAcceptanceDAO.findCandidate(
        episodeId,
        novelChapterContentHash(chapter.content.trim())
      )
    : null
  if (!episode || !candidate) throw new Error('章节验收完成时缺少当前正文候选')
  novelChapterAcceptanceDAO.setBestCandidate(episodeId, candidate.id)
  novelChapterAcceptanceDAO.finish(episodeId, { status: 'accepted' })
}

export function getNovelChapterAcceptanceSummary(
  workId: number
): NovelChapterAcceptanceSummary | null {
  const episode = novelChapterAcceptanceDAO.latestForWork(workId)
  if (!episode) return null
  const chapter = volumeChapterDAO.getChapter(episode.chapter_id)
  if (!chapter) return null
  const currentContentHash = novelChapterContentHash(chapter.content?.trim() ?? '')
  const currentCandidate = novelChapterAcceptanceDAO.findCandidate(episode.id, currentContentHash)
  const { candidate, assessment } = bestAssessment(episode)
  const projectedCandidate = currentCandidate ?? candidate
  const projectedAssessment = projectedCandidate
    ? novelChapterAcceptanceDAO.findAssessment(episode.id, projectedCandidate.id)
    : undefined
  const gateRows = projectedCandidate
    ? novelChapterGateDAO.listStates(episode.id, projectedCandidate.id)
    : []
  const gates = gateRows.map(gate => ({
    gateType: gate.gate_type,
    status: gate.status,
    score: gate.score,
    failureCode: gate.failure_code,
    failureReason: gate.failure_reason,
    blockers: parseStringArray(gate.blockers_json)
  }))
  const blockedGate = gates.find(gate =>
    gate.status === 'failed'
    && !(gate.gateType === 'quality' && projectedAssessment?.passed === 1)
  )?.gateType ?? null
  const authorDecision = projectedCandidate
    ? novelChapterGateDAO.findAuthorDecision({
        episodeId: episode.id,
        candidateId: projectedCandidate.id,
        gateType: 'quality',
        contentHash: projectedCandidate.content_hash,
        contractHash: episode.contract_hash
      })
    : undefined
  const activeGate = blockedGate == null
    ? null
    : gates.find(gate => gate.gateType === blockedGate)
  return {
    episodeId: episode.id,
    status: episode.status,
    chapterId: episode.chapter_id,
    chapterTitle: chapter.title,
    assessmentsUsed: episode.assessments_used,
    maxAssessments: episode.max_assessments,
    repairsUsed: episode.repairs_used,
    maxRepairs: episode.max_repairs,
    bestScore: assessment?.score_total ?? null,
    bestContentHash: candidate?.content_hash ?? null,
    currentContentHash,
    contentChanged: currentCandidate == null,
    terminalCode: episode.terminal_code,
    terminalReason: episode.terminal_reason,
    authorNote: authorDecision?.note ?? null,
    gates,
    blockedGate,
    canResumeDownstream: episode.status === 'awaiting_resume',
    blockingFailures: activeGate?.blockers
      ?? (assessment ? parseStringArray(assessment.blocking_failures_json) : []),
    advisoryFailures: assessment ? parseStringArray(assessment.advisory_failures_json) : [],
    evidence: assessment ? parseEvidence(assessment.top_issues_json) : [],
  }
}

/**
 * 将升级前已经耗尽“4轮内层×6轮外层”的正文门禁熔断一次性收束为新终态。
 * 只迁移明确的 body_acceptance 失败，不推断其他异常，也不改写正文。
 */
export function recoverLegacyNovelChapterAcceptance(workId: number): boolean {
  if (novelChapterAcceptanceDAO.latestForWork(workId)) return false
  const run = goalRoutineDAO.getByWork(workId)
  if (!run || run.status !== 'paused' || run.current_phase !== 'draft_body') return false
  let failure: { step?: string; message?: string } | undefined
  try {
    const parsed = JSON.parse(run.state_json ?? '{}') as {
      failure?: { step?: string; message?: string }
    }
    failure = parsed.failure
  } catch {
    return false
  }
  if (
    failure?.step !== 'body_acceptance'
    || !failure.message?.includes('未通过章节联合门禁')
  ) return false
  const failedStep = goalRoutineDAO.listSteps(workId, 32)
    .find(step => step.step_key === 'body_acceptance' && step.status === 'failed')
  const chapterId = Number(failedStep?.scope_key.match(/^chapter:(\d+)$/)?.[1])
  if (!Number.isInteger(chapterId) || chapterId <= 0) return false
  const chapter = volumeChapterDAO.getChapter(chapterId)
  if (!chapter?.content?.trim()) return false
  if (!run.goal_config_json) return false
  const config = JSON.parse(run.goal_config_json) as StoryGoalConfig
  const episode = ensureNovelChapterAcceptanceEpisode(workId, chapterId, config)
  const content = chapter.content.trim()
  const candidate = novelChapterAcceptanceDAO.findCandidate(
    episode.id,
    novelChapterContentHash(content)
  )!
  const lastDiagnosis = goalRoutineDAO.listTurns(workId, 64)
    .find(turn => turn.action === 'diagnose_fix' && turn.target_chapter_id === chapterId)
  const detail = failure.message.split('；').slice(1).join('；').trim()
  const blockers = detail
    ? detail.split('、').map(item => item.trim()).filter(Boolean)
    : ['升级前章节质量门禁未通过']
  const assessment = novelChapterAcceptanceDAO.addAssessment({
    episodeId: episode.id,
    candidateId: candidate.id,
    scoreTotal: lastDiagnosis?.score ?? -1,
    hardFail: detail.includes('硬失败'),
    passed: false,
    blockingFailures: blockers,
    advisoryFailures: [],
    topIssues: [],
    patches: [],
    report: ''
  })
  novelChapterAcceptanceDAO.setBestCandidate(episode.id, candidate.id)
  novelChapterAcceptanceDAO.setBudgetUsage(
    episode.id,
    episode.max_assessments,
    episode.max_repairs
  )
  novelChapterAcceptanceDAO.finish(episode.id, {
    status: 'blocked',
    terminalCode: 'LEGACY_QUALITY_NON_CONVERGENT',
    terminalReason: failure.message
  })
  novelChapterGateDAO.setState({
    episodeId: episode.id,
    candidateId: candidate.id,
    gateType: 'quality',
    status: 'failed',
    score: assessment.score_total,
    failureCode: 'LEGACY_QUALITY_NON_CONVERGENT',
    failureReason: failure.message,
    blockers
  })
  return assessment.id > 0
}
