import { BaseDAO } from './base-dao'
import {
  stableStoryHash,
  storyHarnessIssueKey,
  type StoryHarnessIssue
} from '../../../shared/story-harness'

export type StoryCandidateStatus =
  | 'generated'
  | 'lint_passed'
  | 'continuity_passed'
  | 'semantic_passed'
  | 'accepted'
  | 'rejected'

export interface StoryGenerationCandidateRow {
  id: number
  work_id: number
  chapter_id: number
  base_content_hash: string | null
  content: string
  word_count: number
  status: StoryCandidateStatus
  source_step: string
  attempt_no: number
  checks_json: string | null
  reject_reason: string | null
  create_time: string
  update_time: string
}

export interface StoryIssueLedgerRow {
  id: number
  work_id: number
  issue_key: string
  code: string
  severity: string
  scope: string
  chapter_ids_json: string | null
  evidence_json: string | null
  invariants_json: string | null
  expected_result: string | null
  message: string
  attempts: number
  clean_confirmations: number
  last_checked_hash: string | null
  status: 'open' | 'resolved' | 'stalled'
  first_seen_time: string
  last_seen_time: string
  resolved_time: string | null
}

export interface StoryReleaseSnapshotRow {
  id: number
  work_id: number
  label: string
  content_hash: string
  is_frozen: number
  create_time: string
}

export interface StoryLeadVersionRow {
  id: number
  work_id: number
  description: string
  source_step: string
  create_time: string
}

interface ChapterSnapshotRow {
  id: number
  volume_id: number
  title: string
  outline: string | null
  content: string | null
  word_count: number
  sort: number
  status: string
  update_time: string
  volume_name: string
  volume_sort: number
}

export class StoryHarnessDAO extends BaseDAO {
  createCandidate(input: {
    workId: number
    chapterId: number
    content: string
    wordCount: number
    baseContent?: string | null
    sourceStep?: string
  }): number {
    const content = input.content.trim()
    if (!content) throw new Error('候选正文为空，禁止进入短故事沙箱')
    const attempt = this.get<{ n: number }>(
      'SELECT COUNT(*) + 1 AS n FROM story_generation_candidates WHERE work_id = ? AND chapter_id = ?',
      [input.workId, input.chapterId]
    )?.n ?? 1
    return this.insert(
      `INSERT INTO story_generation_candidates (
        work_id, chapter_id, base_content_hash, content, word_count,
        status, source_step, attempt_no
      ) VALUES (?, ?, ?, ?, ?, 'generated', ?, ?)`,
      [
        input.workId,
        input.chapterId,
        input.baseContent?.trim() ? stableStoryHash(input.baseContent) : null,
        content,
        input.wordCount,
        input.sourceStep ?? 'body_generation',
        attempt
      ]
    )
  }

  getCandidate(id: number): StoryGenerationCandidateRow | undefined {
    return this.get<StoryGenerationCandidateRow>(
      'SELECT * FROM story_generation_candidates WHERE id = ?',
      [id]
    )
  }

  listCandidatesByWork(workId: number, limit = 100): StoryGenerationCandidateRow[] {
    return this.all<StoryGenerationCandidateRow>(
      'SELECT * FROM story_generation_candidates WHERE work_id = ? ORDER BY id DESC LIMIT ?',
      [workId, limit]
    )
  }

  countCandidatesForChapter(workId: number, chapterId: number): number {
    return this.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM story_generation_candidates WHERE work_id = ? AND chapter_id = ?',
      [workId, chapterId]
    )?.n ?? 0
  }

  countCandidatesForBaseline(
    workId: number,
    chapterId: number,
    baseContent?: string | null
  ): number {
    const baseHash = baseContent?.trim() ? stableStoryHash(baseContent) : null
    return this.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM story_generation_candidates
       WHERE work_id = ? AND chapter_id = ?
         AND ((base_content_hash IS NULL AND ? IS NULL) OR base_content_hash = ?)`,
      [workId, chapterId, baseHash, baseHash]
    )?.n ?? 0
  }

  listCandidatesForBaseline(
    workId: number,
    chapterId: number,
    baseContent?: string | null,
    limit = 4
  ): StoryGenerationCandidateRow[] {
    const baseHash = baseContent?.trim() ? stableStoryHash(baseContent) : null
    return this.all<StoryGenerationCandidateRow>(
      `SELECT * FROM story_generation_candidates
       WHERE work_id = ? AND chapter_id = ?
         AND ((base_content_hash IS NULL AND ? IS NULL) OR base_content_hash = ?)
       ORDER BY id DESC LIMIT ?`,
      [workId, chapterId, baseHash, baseHash, Math.max(1, Math.floor(limit))]
    )
  }

  markCandidate(
    id: number,
    status: StoryCandidateStatus,
    input: { checks?: unknown; rejectReason?: string | null } = {}
  ): void {
    let checksJson: string | null = null
    if (input.checks !== undefined) {
      const existing = this.getCandidate(id)?.checks_json
      let previous: Record<string, unknown> = {}
      try {
        const parsed = existing ? JSON.parse(existing) : null
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) previous = parsed
      } catch { /* 旧记录无法解析时由新检查结果替代 */ }
      checksJson = JSON.stringify(
        input.checks && typeof input.checks === 'object' && !Array.isArray(input.checks)
          ? { ...previous, ...(input.checks as Record<string, unknown>) }
          : { ...previous, result: input.checks }
      )
    }
    this.run(
      `UPDATE story_generation_candidates
       SET status = ?, checks_json = COALESCE(?, checks_json), reject_reason = ?,
           update_time = datetime('now')
       WHERE id = ?`,
      [
        status,
        checksJson,
        input.rejectReason ?? null,
        id
      ]
    )
  }

  /**
   * 唯一允许把短故事候选写入正式章节的入口。整个版本快照与正文提交在同一事务中，
   * 并拒绝任何“非空正文 -> 空正文”的更新。
   */
  acceptCandidate(id: number): boolean {
    return this.transaction(() => {
      const candidate = this.getCandidate(id)
      if (!candidate || candidate.status === 'rejected') return false
      const content = candidate.content.trim()
      if (!content) throw new Error('候选正文为空，禁止提交')
      const chapter = this.get<{
        id: number
        outline: string | null
        content: string | null
        word_count: number
      }>(
        `SELECT c.id, c.outline, c.content, c.word_count
         FROM chapters c JOIN volumes v ON v.id = c.volume_id
         WHERE c.id = ? AND v.work_id = ?`,
        [candidate.chapter_id, candidate.work_id]
      )
      if (!chapter) throw new Error('候选对应章节不存在或不属于当前作品')

      if (chapter.content?.trim()) {
        const version = this.get<{ v: number }>(
          'SELECT COALESCE(MAX(version_number), 0) + 1 AS v FROM chapter_versions WHERE chapter_id = ?',
          [chapter.id]
        )?.v ?? 1
        this.run(
          `INSERT INTO chapter_versions (
            chapter_id, version_number, outline, content, word_count, model_type, generation_round
          ) VALUES (?, ?, ?, ?, ?, 'accepted_baseline', ?)`,
          [chapter.id, version, chapter.outline, chapter.content, chapter.word_count, candidate.attempt_no]
        )
      }

      this.run(
        `UPDATE chapters
         SET content = ?, word_count = ?, status = 'completed',
             emotion_assessment_json = NULL, quality_assessment_json = NULL,
             update_time = datetime('now')
         WHERE id = ?`,
        [content, candidate.word_count, chapter.id]
      )
      this.run('DELETE FROM emotional_state_ledger WHERE chapter_id = ?', [chapter.id])
      this.run(
        `UPDATE story_generation_candidates
         SET status = CASE WHEN id = ? THEN 'accepted'
                           WHEN status = 'accepted' THEN 'rejected'
                           ELSE status END,
             reject_reason = CASE WHEN id != ? AND status = 'accepted'
                                  THEN '被更新的已验收候选替代' ELSE reject_reason END,
             update_time = datetime('now')
         WHERE work_id = ? AND chapter_id = ?`,
        [id, id, candidate.work_id, candidate.chapter_id]
      )
      return true
    })
  }

  syncIssues(workId: number, current: StoryHarnessIssue[]): void {
    this.transaction(() => {
      const keys = new Set(current.map(storyHarnessIssueKey))
      const openRows = this.all<{
        id: number
        issue_key: string
        chapter_ids_json: string | null
        evidence_json: string | null
        message: string
        expected_result: string | null
        clean_confirmations: number
        last_checked_hash: string | null
      }>(
        `SELECT id, issue_key, chapter_ids_json, evidence_json, message, expected_result,
                clean_confirmations, last_checked_hash
         FROM story_issue_ledger
         WHERE work_id = ? AND status IN ('open', 'stalled')`,
        [workId]
      )
      for (const row of openRows) {
        if (!keys.has(row.issue_key)) {
          const scopeHash = this.issueScopeContentHash(workId, {
            chapterIdsJson: row.chapter_ids_json,
            evidenceJson: row.evidence_json,
            message: row.message,
            expectedResult: row.expected_result
          })
          const confirmations = row.last_checked_hash === scopeHash
            ? row.clean_confirmations + 1
            : 1
          if (confirmations >= 2) {
            this.run(
              `UPDATE story_issue_ledger
               SET status = 'resolved', resolved_time = datetime('now'),
                   clean_confirmations = ?, last_checked_hash = ?, last_seen_time = datetime('now')
               WHERE id = ?`,
              [confirmations, scopeHash, row.id]
            )
          } else {
            this.run(
              `UPDATE story_issue_ledger
               SET clean_confirmations = ?, last_checked_hash = ?, last_seen_time = datetime('now')
               WHERE id = ?`,
              [confirmations, scopeHash, row.id]
            )
          }
        }
      }

      for (const value of current) {
        const key = storyHarnessIssueKey(value)
        const scopeHash = this.issueScopeContentHash(workId, {
          chapterIds: value.chapterIds,
          evidence: value.evidence,
          message: value.message,
          expectedResult: value.expectedResult
        })
        this.run(
          `INSERT INTO story_issue_ledger (
            work_id, issue_key, code, severity, scope, chapter_ids_json,
            evidence_json, invariants_json, expected_result, message, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
          ON CONFLICT(work_id, issue_key) DO UPDATE SET
            code = excluded.code,
            severity = excluded.severity,
            scope = excluded.scope,
            chapter_ids_json = excluded.chapter_ids_json,
            evidence_json = excluded.evidence_json,
            invariants_json = excluded.invariants_json,
            expected_result = excluded.expected_result,
            message = excluded.message,
            status = CASE WHEN story_issue_ledger.status = 'stalled' THEN 'stalled' ELSE 'open' END,
            clean_confirmations = 0,
            last_checked_hash = ?,
            resolved_time = NULL,
            last_seen_time = datetime('now')`,
          [
            workId,
            key,
            value.code,
            value.severity,
            value.scope,
            JSON.stringify(value.chapterIds ?? []),
            JSON.stringify(value.evidence),
            JSON.stringify(value.invariants ?? []),
            value.expectedResult,
            value.message,
            scopeHash
          ]
        )
      }
    })
  }

  private issueScopeContentHash(workId: number, input: {
    chapterIds?: number[]
    chapterIdsJson?: string | null
    evidence?: string[]
    evidenceJson?: string | null
    message: string
    expectedResult?: string | null
  }): string {
    let chapterIds = input.chapterIds ?? []
    if (chapterIds.length === 0 && input.chapterIdsJson) {
      try {
        const parsed = JSON.parse(input.chapterIdsJson) as unknown
        if (Array.isArray(parsed)) chapterIds = parsed.filter(Number.isInteger) as number[]
      } catch { /* 非法旧数据按空作用域处理 */ }
    }
    let evidence = input.evidence ?? []
    if (evidence.length === 0 && input.evidenceJson) {
      try {
        const parsed = JSON.parse(input.evidenceJson) as unknown
        if (Array.isArray(parsed)) evidence = parsed.map(String)
      } catch { /* 非法旧数据不参与导语判断 */ }
    }
    const leadRelevant = /导语/.test([
      input.message,
      input.expectedResult ?? '',
      ...evidence
    ].join('\n'))
    const work = leadRelevant
      ? this.get<{ description: string | null }>('SELECT description FROM works WHERE id = ?', [workId])
      : undefined
    const rows = chapterIds.length > 0
      ? this.all<{ id: number; content: string | null }>(
          `SELECT id, content FROM chapters WHERE id IN (${chapterIds.map(() => '?').join(',')}) ORDER BY id`,
          chapterIds
        )
      : []
    return stableStoryHash(JSON.stringify({
      description: leadRelevant ? work?.description?.trim() ?? '' : undefined,
      chapters: rows.map(row => ({ id: row.id, content: row.content?.trim() ?? '' }))
    }))
  }

  replaceLeadWithVersion(workId: number, description: string, sourceStep = 'story_lead_repair'): number {
    const next = description.trim()
    if (!next) throw new Error('导语修复结果为空，禁止覆盖')
    return this.transaction(() => {
      const work = this.get<{ description: string | null }>('SELECT description FROM works WHERE id = ?', [workId])
      if (!work) throw new Error('作品不存在，无法修复导语')
      const versionId = this.insert(
        'INSERT INTO story_lead_versions (work_id, description, source_step) VALUES (?, ?, ?)',
        [workId, work.description ?? '', sourceStep]
      )
      this.run(
        'UPDATE works SET description = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?',
        [next, workId]
      )
      return versionId
    })
  }

  listLeadVersions(workId: number, limit = 20): StoryLeadVersionRow[] {
    return this.all<StoryLeadVersionRow>(
      'SELECT * FROM story_lead_versions WHERE work_id = ? ORDER BY id DESC LIMIT ?',
      [workId, limit]
    )
  }

  private currentStoryContentHash(workId: number): string {
    const work = this.get<{ description: string | null }>('SELECT description FROM works WHERE id = ?', [workId])
    const chapters = this.all<{ id: number; content: string | null }>(
      `SELECT c.id, c.content FROM chapters c
       JOIN volumes v ON v.id = c.volume_id
       WHERE v.work_id = ? ORDER BY v.sort, c.sort`,
      [workId]
    )
    return stableStoryHash(JSON.stringify({
      description: work?.description?.trim() ?? '',
      chapters: chapters.map(chapter => ({ id: chapter.id, content: chapter.content?.trim() ?? '' }))
    }))
  }

  incrementIssueAttempt(workId: number, issueKey: string, maxAttempts: number): number {
    return this.transaction(() => {
      this.run(
        `UPDATE story_issue_ledger SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= ? THEN 'stalled' ELSE status END,
          last_seen_time = datetime('now')
         WHERE work_id = ? AND issue_key = ?`,
        [maxAttempts, workId, issueKey]
      )
      return this.get<{ attempts: number }>(
        'SELECT attempts FROM story_issue_ledger WHERE work_id = ? AND issue_key = ?',
        [workId, issueKey]
      )?.attempts ?? 0
    })
  }

  listIssues(workId: number, status?: StoryIssueLedgerRow['status']): StoryIssueLedgerRow[] {
    return status
      ? this.all<StoryIssueLedgerRow>(
          'SELECT * FROM story_issue_ledger WHERE work_id = ? AND status = ? ORDER BY severity, id',
          [workId, status]
        )
      : this.all<StoryIssueLedgerRow>(
          'SELECT * FROM story_issue_ledger WHERE work_id = ? ORDER BY status, severity, id',
          [workId]
        )
  }

  createReleaseSnapshot(workId: number, label = 'release_ready'): number {
    return this.transaction(() => {
      const unresolved = this.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM story_issue_ledger WHERE work_id = ? AND status IN ('open', 'stalled')",
        [workId]
      )?.n ?? 0
      if (unresolved > 0) throw new Error(`仍有 ${unresolved} 项未关闭的短故事硬伤，禁止创建发布快照`)
      const work = this.get<Record<string, unknown>>('SELECT * FROM works WHERE id = ?', [workId])
      if (!work) throw new Error('作品不存在，无法创建发布快照')
      const chapters = this.all<ChapterSnapshotRow>(
        `SELECT c.id, c.volume_id, c.title, c.outline, c.content, c.word_count,
                c.sort, c.status, c.update_time, v.name AS volume_name, v.sort AS volume_sort
         FROM chapters c JOIN volumes v ON v.id = c.volume_id
         WHERE v.work_id = ? ORDER BY v.sort, c.sort`,
        [workId]
      )
      if (chapters.length === 0 || chapters.some(chapter => !chapter.content?.trim())) {
        throw new Error('仍有空章节，禁止创建发布快照')
      }
      const snapshot = JSON.stringify({ work, chapters })
      return this.insert(
        `INSERT INTO story_release_snapshots (work_id, label, content_hash, snapshot_json, is_frozen)
         VALUES (?, ?, ?, ?, 1)`,
        [workId, label, stableStoryHash(snapshot), snapshot]
      )
    })
  }


  listReleaseSnapshots(workId: number): StoryReleaseSnapshotRow[] {
    return this.all<StoryReleaseSnapshotRow>(
      `SELECT id, work_id, label, content_hash, is_frozen, create_time
       FROM story_release_snapshots WHERE work_id = ? ORDER BY id DESC`,
      [workId]
    )
  }
}

export const storyHarnessDAO = new StoryHarnessDAO()
