import { BaseDAO } from './base-dao'
import type { NovelChapterGateType } from './novel-chapter-gate-dao'

export type NovelChapterAcceptanceStatus =
  | 'running'
  | 'awaiting_resume'
  | 'blocked'
  | 'accepted'
  | 'superseded'

export interface NovelChapterAcceptanceEpisodeRow {
  id: number
  episode_key: string
  work_id: number
  chapter_id: number
  source_run_id: number | null
  last_run_id: number | null
  base_content_hash: string
  contract_hash: string
  protocol_version: number
  status: NovelChapterAcceptanceStatus
  max_assessments: number
  max_repairs: number
  assessments_used: number
  repairs_used: number
  best_candidate_id: number | null
  terminal_code: string | null
  terminal_reason: string | null
  author_note: string | null
  create_time: string
  update_time: string
  closed_at: string | null
}

export interface NovelChapterAcceptanceCandidateRow {
  id: number
  episode_id: number
  content_hash: string
  parent_content_hash: string | null
  source_kind: 'baseline' | 'quality_patch' | 'emotion_repair' | 'contract_repair'
  content: string
  word_count: number
  create_time: string
}

export interface NovelChapterAcceptanceAssessmentRow {
  id: number
  episode_id: number
  candidate_id: number
  sequence_no: number
  score_total: number
  hard_fail: number
  passed: number
  blocking_failures_json: string
  advisory_failures_json: string
  top_issues_json: string
  patches_json: string
  report: string
  create_time: string
  content_hash?: string
}

export class NovelChapterAcceptanceDAO extends BaseDAO {
  findEpisodeByCandidate(input: {
    workId: number
    chapterId: number
    contentHash: string
    contractHash: string
    protocolVersion: number
  }): NovelChapterAcceptanceEpisodeRow | undefined {
    return this.get<NovelChapterAcceptanceEpisodeRow>(
      `SELECT episode.*
       FROM novel_chapter_acceptance_episodes episode
       JOIN novel_chapter_acceptance_candidates candidate
         ON candidate.episode_id = episode.id
       WHERE episode.work_id = ? AND episode.chapter_id = ?
         AND episode.contract_hash = ? AND episode.protocol_version = ?
         AND episode.status <> 'superseded'
         AND candidate.content_hash = ?
       ORDER BY episode.id DESC
       LIMIT 1`,
      [
        input.workId,
        input.chapterId,
        input.contractHash,
        input.protocolVersion,
        input.contentHash
      ]
    )
  }

  getEpisode(id: number): NovelChapterAcceptanceEpisodeRow | undefined {
    return this.get<NovelChapterAcceptanceEpisodeRow>(
      'SELECT * FROM novel_chapter_acceptance_episodes WHERE id = ?',
      [id]
    )
  }

  createEpisode(input: {
    episodeKey: string
    workId: number
    chapterId: number
    runId?: number
    baseContentHash: string
    contractHash: string
    protocolVersion: number
    maxAssessments: number
    maxRepairs: number
  }): NovelChapterAcceptanceEpisodeRow {
    return this.transaction(() => {
      this.run(
        `UPDATE novel_chapter_acceptance_episodes
         SET status = 'superseded', closed_at = CURRENT_TIMESTAMP, update_time = CURRENT_TIMESTAMP
         WHERE work_id = ? AND chapter_id = ?
           AND status IN ('running', 'awaiting_resume', 'blocked')`,
        [input.workId, input.chapterId]
      )
      this.run(
        `INSERT OR IGNORE INTO novel_chapter_acceptance_episodes (
           episode_key, work_id, chapter_id, source_run_id, last_run_id,
           base_content_hash, contract_hash, protocol_version, status,
           max_assessments, max_repairs
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
        [
          input.episodeKey,
          input.workId,
          input.chapterId,
          input.runId ?? null,
          input.runId ?? null,
          input.baseContentHash,
          input.contractHash,
          input.protocolVersion,
          input.maxAssessments,
          input.maxRepairs
        ]
      )
      return this.get<NovelChapterAcceptanceEpisodeRow>(
        'SELECT * FROM novel_chapter_acceptance_episodes WHERE episode_key = ?',
        [input.episodeKey]
      )!
    })
  }

  touchRun(episodeId: number, runId?: number): void {
    if (runId == null) return
    this.run(
      `UPDATE novel_chapter_acceptance_episodes
       SET last_run_id = ?, update_time = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [runId, episodeId]
    )
  }

  supersedeEpisode(episodeId: number): void {
    const changed = this.run(
      `UPDATE novel_chapter_acceptance_episodes
       SET status = 'superseded', closed_at = CURRENT_TIMESTAMP,
           update_time = CURRENT_TIMESTAMP
       WHERE id = ? AND status <> 'superseded'`,
      [episodeId]
    ).changes
    if (changed !== 1) {
      throw new Error(`章节验收事件 ${episodeId} 不存在或已被取代`)
    }
  }

  addCandidate(input: {
    episodeId: number
    contentHash: string
    parentContentHash?: string
    sourceKind: NovelChapterAcceptanceCandidateRow['source_kind']
    content: string
    wordCount: number
  }): NovelChapterAcceptanceCandidateRow {
    this.run(
      `INSERT OR IGNORE INTO novel_chapter_acceptance_candidates (
         episode_id, content_hash, parent_content_hash, source_kind, content, word_count
       ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.episodeId,
        input.contentHash,
        input.parentContentHash ?? null,
        input.sourceKind,
        input.content,
        input.wordCount
      ]
    )
    return this.get<NovelChapterAcceptanceCandidateRow>(
      `SELECT * FROM novel_chapter_acceptance_candidates
       WHERE episode_id = ? AND content_hash = ?`,
      [input.episodeId, input.contentHash]
    )!
  }

  findCandidate(episodeId: number, contentHash: string): NovelChapterAcceptanceCandidateRow | undefined {
    return this.get<NovelChapterAcceptanceCandidateRow>(
      `SELECT * FROM novel_chapter_acceptance_candidates
       WHERE episode_id = ? AND content_hash = ?`,
      [episodeId, contentHash]
    )
  }

  getCandidate(id: number): NovelChapterAcceptanceCandidateRow | undefined {
    return this.get<NovelChapterAcceptanceCandidateRow>(
      'SELECT * FROM novel_chapter_acceptance_candidates WHERE id = ?',
      [id]
    )
  }

  listCandidates(episodeId: number): NovelChapterAcceptanceCandidateRow[] {
    return this.all<NovelChapterAcceptanceCandidateRow>(
      `SELECT * FROM novel_chapter_acceptance_candidates
       WHERE episode_id = ? ORDER BY id`,
      [episodeId]
    )
  }

  findLatestWordCompliantCandidate(input: {
    workId: number
    chapterId: number
    contractHash: string
    protocolVersion: number
    minWords: number
    maxWords: number
    excludeContentHash: string
  }): NovelChapterAcceptanceCandidateRow | undefined {
    return this.get<NovelChapterAcceptanceCandidateRow>(
      `SELECT candidate.*
       FROM novel_chapter_acceptance_candidates candidate
       JOIN novel_chapter_acceptance_episodes episode ON episode.id = candidate.episode_id
       WHERE episode.work_id = ? AND episode.chapter_id = ?
         AND episode.contract_hash = ? AND episode.protocol_version = ?
         AND candidate.word_count BETWEEN ? AND ?
         AND candidate.content_hash <> ?
       ORDER BY candidate.id DESC
       LIMIT 1`,
      [
        input.workId,
        input.chapterId,
        input.contractHash,
        input.protocolVersion,
        input.minWords,
        input.maxWords,
        input.excludeContentHash
      ]
    )
  }

  findAssessment(
    episodeId: number,
    candidateId: number
  ): NovelChapterAcceptanceAssessmentRow | undefined {
    return this.get<NovelChapterAcceptanceAssessmentRow>(
      `SELECT assessment.*, candidate.content_hash
       FROM novel_chapter_acceptance_assessments assessment
       JOIN novel_chapter_acceptance_candidates candidate ON candidate.id = assessment.candidate_id
       WHERE assessment.episode_id = ? AND assessment.candidate_id = ?`,
      [episodeId, candidateId]
    )
  }

  addAssessment(input: {
    episodeId: number
    candidateId: number
    scoreTotal: number
    hardFail: boolean
    passed: boolean
    blockingFailures: string[]
    advisoryFailures: string[]
    topIssues: unknown[]
    patches: unknown[]
    report: string
  }): NovelChapterAcceptanceAssessmentRow {
    return this.transaction(() => {
      const episode = this.getEpisode(input.episodeId)
      if (!episode || episode.status !== 'running') {
        throw new Error(`章节验收事件 ${input.episodeId} 当前不可写入评估`)
      }
      const existing = this.findAssessment(input.episodeId, input.candidateId)
      if (existing) return existing
      if (episode.assessments_used >= episode.max_assessments) {
        throw new Error(`章节验收事件 ${input.episodeId} 已耗尽评估预算`)
      }
      const sequenceNo = episode.assessments_used + 1
      this.insert(
        `INSERT INTO novel_chapter_acceptance_assessments (
           episode_id, candidate_id, sequence_no, score_total, hard_fail, passed,
           blocking_failures_json, advisory_failures_json, top_issues_json, patches_json, report
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.episodeId,
          input.candidateId,
          sequenceNo,
          input.scoreTotal,
          input.hardFail ? 1 : 0,
          input.passed ? 1 : 0,
          JSON.stringify(input.blockingFailures),
          JSON.stringify(input.advisoryFailures),
          JSON.stringify(input.topIssues),
          JSON.stringify(input.patches),
          input.report
        ]
      )
      this.run(
        `UPDATE novel_chapter_acceptance_episodes
         SET assessments_used = assessments_used + 1, update_time = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [input.episodeId]
      )
      return this.findAssessment(input.episodeId, input.candidateId)!
    })
  }

  listAssessments(episodeId: number): NovelChapterAcceptanceAssessmentRow[] {
    return this.all<NovelChapterAcceptanceAssessmentRow>(
      `SELECT assessment.*, candidate.content_hash
       FROM novel_chapter_acceptance_assessments assessment
       JOIN novel_chapter_acceptance_candidates candidate ON candidate.id = assessment.candidate_id
       WHERE assessment.episode_id = ? ORDER BY assessment.sequence_no`,
      [episodeId]
    )
  }

  reserveRepairCandidate(input: {
    episodeId: number
    contentHash: string
    parentContentHash: string
    sourceKind: Exclude<NovelChapterAcceptanceCandidateRow['source_kind'], 'baseline'>
    gateType: NovelChapterGateType
    gateRepairLimit: number
    content: string
    wordCount: number
  }): NovelChapterAcceptanceCandidateRow {
    return this.transaction(() => {
      const existing = this.findCandidate(input.episodeId, input.contentHash)
      if (existing) return existing
      const episode = this.getEpisode(input.episodeId)
      if (!episode || episode.status !== 'running') {
        throw new Error(
          `章节验收事件 ${input.episodeId} 状态为 ${episode?.status ?? 'missing'}，禁止追加修订候选`
        )
      }
      const parent = this.findCandidate(input.episodeId, input.parentContentHash)
      if (!parent) {
        throw new Error(`章节验收事件 ${input.episodeId} 的修订父候选不存在`)
      }
      const gateChanged = this.run(
        `UPDATE novel_chapter_gate_states
         SET repair_count = repair_count + 1, update_time = CURRENT_TIMESTAMP
         WHERE episode_id = ? AND candidate_id = ? AND gate_type = ?
           AND repair_count < ?`,
        [input.episodeId, parent.id, input.gateType, input.gateRepairLimit]
      ).changes
      if (gateChanged !== 1) {
        throw new Error(`${input.gateType} 门禁已耗尽 ${input.gateRepairLimit} 次候选修订预算`)
      }
      const episodeChanged = this.run(
        `UPDATE novel_chapter_acceptance_episodes
         SET repairs_used = repairs_used + 1, update_time = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'running' AND repairs_used < max_repairs`,
        [input.episodeId]
      ).changes
      if (episodeChanged !== 1) {
        throw new Error(`章节验收事件 ${input.episodeId} 已耗尽总修订预算`)
      }
      const candidate = this.addCandidate({
        episodeId: input.episodeId,
        contentHash: input.contentHash,
        parentContentHash: input.parentContentHash,
        sourceKind: input.sourceKind,
        content: input.content,
        wordCount: input.wordCount
      })
      this.run(
        `INSERT OR IGNORE INTO novel_chapter_gate_states (
           episode_id, candidate_id, gate_type, status, blockers_json, evidence_json
         )
         SELECT ?, ?, gate_type, 'pending', '[]', '[]'
         FROM novel_chapter_gate_states
         WHERE episode_id = ? AND candidate_id = ?`,
        [input.episodeId, candidate.id, input.episodeId, parent.id]
      )
      return candidate
    })
  }

  setBestCandidate(episodeId: number, candidateId: number): void {
    this.run(
      `UPDATE novel_chapter_acceptance_episodes
       SET best_candidate_id = ?, update_time = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [candidateId, episodeId]
    )
  }

  setBudgetUsage(episodeId: number, assessmentsUsed: number, repairsUsed: number): void {
    this.run(
      `UPDATE novel_chapter_acceptance_episodes
       SET assessments_used = MIN(max_assessments, ?),
           repairs_used = MIN(max_repairs, ?),
           update_time = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [Math.max(0, assessmentsUsed), Math.max(0, repairsUsed), episodeId]
    )
  }

  finish(
    episodeId: number,
    input: {
      status: 'accepted' | 'blocked'
      terminalCode?: string
      terminalReason?: string
    }
  ): void {
    this.run(
      `UPDATE novel_chapter_acceptance_episodes
       SET status = ?, terminal_code = ?, terminal_reason = ?,
           closed_at = CURRENT_TIMESTAMP, update_time = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        input.status,
        input.terminalCode ?? null,
        input.terminalReason ?? null,
        episodeId
      ]
    )
  }

  beginExplicitResume(episodeId: number): NovelChapterAcceptanceEpisodeRow {
    const changed = this.run(
      `UPDATE novel_chapter_acceptance_episodes
       SET status = 'running', closed_at = NULL, update_time = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'awaiting_resume'`,
      [episodeId]
    ).changes
    if (changed !== 1) {
      throw new Error(`章节验收事件 ${episodeId} 不在等待恢复状态`)
    }
    return this.getEpisode(episodeId)!
  }

  latestForWork(workId: number): NovelChapterAcceptanceEpisodeRow | undefined {
    return this.get<NovelChapterAcceptanceEpisodeRow>(
      `SELECT * FROM novel_chapter_acceptance_episodes
       WHERE work_id = ? ORDER BY id DESC LIMIT 1`,
      [workId]
    )
  }
}

export const novelChapterAcceptanceDAO = new NovelChapterAcceptanceDAO()
