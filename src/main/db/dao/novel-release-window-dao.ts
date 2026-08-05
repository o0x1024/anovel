import { BaseDAO } from './base-dao'

export type NovelReleaseWindowStatus = 'running' | 'blocked' | 'passed'

export interface NovelReleaseWindowAuditRow {
  id: number
  work_id: number
  start_chapter_id: number
  end_chapter_id: number
  start_index: number
  end_index: number
  source_hash: string
  authority_revision: number
  protocol_version: number
  status: NovelReleaseWindowStatus
  overall_score: number | null
  scores_json: string
  blocker_count: number
  summary: string | null
  create_time: string
  update_time: string
}

export interface NovelReleaseWindowIssueInput {
  code: string
  severity: 'blocker' | 'warning'
  chapterIds: number[]
  evidence: string[]
  message: string
  requiredFix: string
}

export class NovelReleaseWindowDAO extends BaseDAO {
  findPassed(workId: number, startIndex: number, endIndex: number, sourceHash: string): NovelReleaseWindowAuditRow | undefined {
    return this.get<NovelReleaseWindowAuditRow>(
      `SELECT * FROM novel_release_window_audits
       WHERE work_id = ? AND start_index = ? AND end_index = ?
         AND source_hash = ? AND status = 'passed'
       ORDER BY id DESC LIMIT 1`,
      [workId, startIndex, endIndex, sourceHash]
    )
  }

  latestForRange(workId: number, startIndex: number, endIndex: number): NovelReleaseWindowAuditRow | undefined {
    return this.get<NovelReleaseWindowAuditRow>(
      `SELECT * FROM novel_release_window_audits
       WHERE work_id = ? AND start_index = ? AND end_index = ?
       ORDER BY id DESC LIMIT 1`,
      [workId, startIndex, endIndex]
    )
  }

  start(input: {
    workId: number
    startChapterId: number
    endChapterId: number
    startIndex: number
    endIndex: number
    sourceHash: string
    authorityRevision: number
    protocolVersion: number
  }): number {
    return this.insert(
      `INSERT INTO novel_release_window_audits (
         work_id, start_chapter_id, end_chapter_id, start_index, end_index,
         source_hash, authority_revision, protocol_version, status, scores_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', '{}')`,
      [
        input.workId, input.startChapterId, input.endChapterId,
        input.startIndex, input.endIndex, input.sourceHash,
        input.authorityRevision, input.protocolVersion
      ]
    )
  }

  finish(input: {
    auditId: number
    status: Exclude<NovelReleaseWindowStatus, 'running'>
    overallScore: number
    scores: unknown
    blockers: string[]
    summary: string
    issues: NovelReleaseWindowIssueInput[]
  }): number | null {
    return this.transaction(() => {
      const audit = this.get<NovelReleaseWindowAuditRow>(
        'SELECT * FROM novel_release_window_audits WHERE id = ?',
        [input.auditId]
      )
      if (!audit) throw new Error(`首发窗口审读记录不存在：${input.auditId}`)
      this.run('DELETE FROM novel_release_window_issues WHERE audit_id = ?', [input.auditId])
      for (const issue of input.issues) {
        this.insert(
          `INSERT INTO novel_release_window_issues (
             audit_id, code, severity, chapter_ids_json, evidence_json,
             message, required_fix, status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
          [
            input.auditId, issue.code, issue.severity,
            JSON.stringify(issue.chapterIds), JSON.stringify(issue.evidence),
            issue.message, issue.requiredFix
          ]
        )
      }
      this.run(
        `UPDATE novel_release_window_audits
         SET status = ?, overall_score = ?, scores_json = ?, blocker_count = ?,
             summary = ?, update_time = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          input.status, input.overallScore, JSON.stringify(input.scores),
          input.blockers.length, input.summary, input.auditId
        ]
      )
      if (input.status !== 'passed') return null
      return this.insert(
        `INSERT INTO novel_release_window_snapshots (
           audit_id, work_id, source_hash, proof_json
         )
         SELECT id, work_id, source_hash, ?
         FROM novel_release_window_audits WHERE id = ?`,
        [JSON.stringify({
          auditId: audit.id,
          workId: audit.work_id,
          startChapterId: audit.start_chapter_id,
          endChapterId: audit.end_chapter_id,
          startIndex: audit.start_index,
          endIndex: audit.end_index,
          sourceHash: audit.source_hash,
          authorityRevision: audit.authority_revision,
          protocolVersion: audit.protocol_version,
          blockers: input.blockers,
          scores: input.scores
        }), input.auditId]
      )
    })
  }
}

export const novelReleaseWindowDAO = new NovelReleaseWindowDAO()
