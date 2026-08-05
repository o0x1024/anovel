import type Database from 'better-sqlite3'
import type {
  ChapterContentRegistry,
  NarrativeCommit,
  NarrativeEvent,
  NarrativeState
} from '../domain'
import { NARRATIVE_KERNEL_SCHEMA_VERSION } from '../domain'
import { assertNarrativeKernel } from '../errors'
import { canonicalHash, canonicalJson, sha256 } from '../hash'
import {
  applyNarrativeCommit,
  createEmptyNarrativeState
} from '../reducer'
import {
  NARRATIVE_EVENT_STORE_SCHEMA_VERSION,
  ensureNarrativeEventStoreSchema
} from './schema'

interface StreamRow {
  novel_id: number
  head_revision: number
  state_hash: string
}

interface CommitRow {
  id: string
  novel_id: number
  chapter_version_id: string
  chapter_ordinal: number
  base_revision: number
  revision: number
  commit_hash: string
}

interface EventRow {
  event_json: string
  event_hash: string
  chapter_version_id: string
  start_offset: number
  end_offset: number
  quote_hash: string
}

interface RevisionRow {
  state_hash: string
}

class DatabaseContentRegistry implements ChapterContentRegistry {
  constructor(
    private readonly db: Database.Database,
    private readonly staged?: Readonly<{ id: string; content: string }>
  ) {}

  getChapterContent(chapterVersionId: string): string | undefined {
    if (this.staged?.id === chapterVersionId) return this.staged.content
    const row = this.db.prepare(
      'SELECT content, content_hash FROM narrative_chapter_versions WHERE id = ?'
    ).get(chapterVersionId) as { content: string; content_hash: string } | undefined
    if (row) {
      assertNarrativeKernel(
        sha256(row.content) === row.content_hash,
        'CONTENT_HASH_MISMATCH',
        '已提交章节正文与内容哈希不一致',
        { chapterVersionId }
      )
    }
    return row?.content
  }
}

export interface CreateNarrativeNovelInput {
  id: number
  title: string
}

export interface AppendNarrativeCommitInput {
  commit: NarrativeCommit
  content: string
}

export interface CommittedNarrativeChapter {
  id: string
  chapterOrdinal: number
  content: string
  contentHash: string
  committedRevision: number
}

export interface NarrativeNovelSummary {
  id: number
  title: string
  revision: number
  stateHash: string
  chapterCount: number
}

export class NarrativeEventStore {
  constructor(private readonly db: Database.Database) {
    ensureNarrativeEventStoreSchema(db)
  }

  createNovel(input: CreateNarrativeNovelInput): NarrativeState {
    const emptyState = createEmptyNarrativeState(input.id)
    const create = this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT id FROM narrative_novels WHERE id = ?'
      ).get(input.id)
      assertNarrativeKernel(
        !existing,
        'STREAM_ALREADY_EXISTS',
        `小说事件流已经存在：${input.id}`,
        { workId: input.id }
      )
      this.db.prepare(
        'INSERT INTO narrative_novels (id, title) VALUES (?, ?)'
      ).run(input.id, input.title)
      this.db.prepare(`
        INSERT INTO narrative_streams (novel_id, head_revision, state_hash)
        VALUES (?, 0, ?)
      `).run(input.id, emptyState.stateHash)
    })
    create()
    return emptyState
  }

  createNovelWithGeneratedId(title: string): NarrativeState {
    const trimmedTitle = title.trim()
    assertNarrativeKernel(
      trimmedTitle.length > 0,
      'WORKFLOW_STATE_INVALID',
      '小说标题不能为空'
    )
    const create = this.db.transaction(() => {
      const row = this.db.prepare(
        'SELECT COALESCE(MAX(id), 0) + 1 AS id FROM narrative_novels'
      ).get() as { id: number }
      return this.createNovel({ id: row.id, title: trimmedTitle })
    })
    return create()
  }

  listNovels(): NarrativeNovelSummary[] {
    const rows = this.db.prepare(`
      SELECT novel.id, novel.title, stream.head_revision, stream.state_hash,
             COUNT(chapter.id) AS chapter_count
      FROM narrative_novels novel
      JOIN narrative_streams stream ON stream.novel_id = novel.id
      LEFT JOIN narrative_chapter_versions chapter ON chapter.novel_id = novel.id
      GROUP BY novel.id, novel.title, stream.head_revision, stream.state_hash
      ORDER BY novel.id DESC
    `).all() as Array<{
      id: number
      title: string
      head_revision: number
      state_hash: string
      chapter_count: number
    }>
    return rows.map(row => ({
      id: row.id,
      title: row.title,
      revision: row.head_revision,
      stateHash: row.state_hash,
      chapterCount: row.chapter_count
    }))
  }

  loadState(workId: number): NarrativeState {
    const stream = this.getStream(workId)
    const commits = this.loadCommits(workId)
    const contentRegistry = new DatabaseContentRegistry(this.db)
    const state = commits.reduce((current, commit) => {
      const next = applyNarrativeCommit(current, commit, contentRegistry)
      const revision = this.db.prepare(`
        SELECT state_hash
        FROM narrative_state_revisions
        WHERE novel_id = ? AND revision = ?
      `).get(workId, commit.revision) as RevisionRow | undefined
      assertNarrativeKernel(
        revision?.state_hash === next.stateHash,
        'STATE_HASH_MISMATCH',
        '中间状态修订哈希与事件重放结果不一致',
        {
          workId,
          revision: commit.revision,
          persistedStateHash: revision?.state_hash,
          replayStateHash: next.stateHash
        }
      )
      return next
    }, createEmptyNarrativeState(workId))
    assertNarrativeKernel(
      state.revision === stream.head_revision && state.stateHash === stream.state_hash,
      'STATE_HASH_MISMATCH',
      '事件重放结果与事件流权威头不一致',
      {
        workId,
        streamRevision: stream.head_revision,
        replayRevision: state.revision,
        streamStateHash: stream.state_hash,
        replayStateHash: state.stateHash
      }
    )
    return state
  }

  appendChapterCommit(input: AppendNarrativeCommitInput): NarrativeState {
    const append = this.db.transaction(() => {
      const stream = this.getStream(input.commit.workId)
      const current = this.loadState(input.commit.workId)
      assertNarrativeKernel(
        stream.head_revision === input.commit.baseRevision,
        'STATE_REVISION_STALE',
        '数据库事件流已经前进，当前章节提交已过期',
        {
          currentRevision: stream.head_revision,
          baseRevision: input.commit.baseRevision
        }
      )
      assertNarrativeKernel(
        input.content.trim().length > 0,
        'EVIDENCE_SCOPE_MISMATCH',
        '不可提交空章节正文',
        { chapterVersionId: input.commit.chapterVersionId }
      )

      const contentRegistry = new DatabaseContentRegistry(this.db, {
        id: input.commit.chapterVersionId,
        content: input.content
      })
      const next = applyNarrativeCommit(current, input.commit, contentRegistry)
      const contentHash = sha256(input.content)

      this.db.prepare(`
        INSERT INTO narrative_chapter_versions (
          id, novel_id, chapter_ordinal, content, content_hash, committed_revision
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.commit.chapterVersionId,
        input.commit.workId,
        input.commit.chapterOrdinal,
        input.content,
        contentHash,
        input.commit.revision
      )

      this.db.prepare(`
        INSERT INTO narrative_commits (
          id, novel_id, chapter_version_id, chapter_ordinal,
          base_revision, revision, commit_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.commit.id,
        input.commit.workId,
        input.commit.chapterVersionId,
        input.commit.chapterOrdinal,
        input.commit.baseRevision,
        input.commit.revision,
        canonicalHash(input.commit)
      )

      input.commit.events.forEach((event, index) => {
        this.insertEvent(input.commit, event, index)
      })

      this.db.prepare(`
        INSERT INTO narrative_state_revisions (
          novel_id, revision, parent_revision, commit_id,
          state_hash, reducer_version
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        input.commit.workId,
        input.commit.revision,
        input.commit.baseRevision,
        input.commit.id,
        next.stateHash,
        NARRATIVE_KERNEL_SCHEMA_VERSION
      )

      const updated = this.db.prepare(`
        UPDATE narrative_streams
        SET head_revision = ?, state_hash = ?, updated_at = CURRENT_TIMESTAMP
        WHERE novel_id = ? AND head_revision = ?
      `).run(
        input.commit.revision,
        next.stateHash,
        input.commit.workId,
        input.commit.baseRevision
      )
      assertNarrativeKernel(
        updated.changes === 1,
        'STATE_REVISION_STALE',
        '事件流 CAS 更新失败，章节提交已回滚',
        {
          workId: input.commit.workId,
          baseRevision: input.commit.baseRevision,
          revision: input.commit.revision
        }
      )
      return next
    })
    return append()
  }

  integrityCheck(): string[] {
    const integrityRows = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>
    const foreignKeyRows = this.db.pragma('foreign_key_check') as Array<Record<string, unknown>>
    return [
      ...integrityRows
        .filter(row => row.integrity_check !== 'ok')
        .map(row => row.integrity_check),
      ...foreignKeyRows.map(row => canonicalJson(row))
    ]
  }

  schemaVersion(): number {
    return NARRATIVE_EVENT_STORE_SCHEMA_VERSION
  }

  loadNovelTitle(workId: number): string {
    const row = this.db.prepare(
      'SELECT title FROM narrative_novels WHERE id = ?'
    ).get(workId) as { title: string } | undefined
    assertNarrativeKernel(
      row,
      'STREAM_NOT_FOUND',
      `小说事件流不存在：${workId}`,
      { workId }
    )
    return row.title
  }

  listCommittedChapters(workId: number): CommittedNarrativeChapter[] {
    this.getStream(workId)
    const rows = this.db.prepare(`
      SELECT id, chapter_ordinal, content, content_hash, committed_revision
      FROM narrative_chapter_versions
      WHERE novel_id = ?
      ORDER BY chapter_ordinal ASC, committed_revision ASC
    `).all(workId) as Array<{
      id: string
      chapter_ordinal: number
      content: string
      content_hash: string
      committed_revision: number
    }>
    return rows.map(row => {
      assertNarrativeKernel(
        sha256(row.content) === row.content_hash,
        'CONTENT_HASH_MISMATCH',
        '已提交章节正文与内容哈希不一致',
        { chapterVersionId: row.id }
      )
      return {
        id: row.id,
        chapterOrdinal: row.chapter_ordinal,
        content: row.content,
        contentHash: row.content_hash,
        committedRevision: row.committed_revision
      }
    })
  }

  private getStream(workId: number): StreamRow {
    const stream = this.db.prepare(`
      SELECT novel_id, head_revision, state_hash
      FROM narrative_streams
      WHERE novel_id = ?
    `).get(workId) as StreamRow | undefined
    assertNarrativeKernel(
      stream,
      'STREAM_NOT_FOUND',
      `小说事件流不存在：${workId}`,
      { workId }
    )
    return stream
  }

  private loadCommits(workId: number): NarrativeCommit[] {
    const commitRows = this.db.prepare(`
      SELECT id, novel_id, chapter_version_id, chapter_ordinal,
             base_revision, revision, commit_hash
      FROM narrative_commits
      WHERE novel_id = ?
      ORDER BY revision ASC
    `).all(workId) as CommitRow[]

    const readEvents = this.db.prepare(`
      SELECT event.event_json, event.event_hash,
             evidence.chapter_version_id, evidence.start_offset,
             evidence.end_offset, evidence.quote_hash
      FROM narrative_events event
      JOIN narrative_evidence_spans evidence ON evidence.id = event.evidence_span_id
      WHERE event.commit_id = ?
      ORDER BY sequence_in_commit ASC
    `)
    return commitRows.map(row => {
      const events = (readEvents.all(row.id) as EventRow[]).map(eventRow => {
        assertNarrativeKernel(
          sha256(eventRow.event_json) === eventRow.event_hash,
          'EVENT_HASH_MISMATCH',
          '持久化事件内容与事件哈希不一致',
          { commitId: row.id }
        )
        const event = JSON.parse(eventRow.event_json) as NarrativeEvent
        assertNarrativeKernel(
          event.evidence.chapterVersionId === eventRow.chapter_version_id &&
            event.evidence.startOffset === eventRow.start_offset &&
            event.evidence.endOffset === eventRow.end_offset &&
            event.evidence.quoteHash === eventRow.quote_hash,
          'EVIDENCE_HASH_MISMATCH',
          '事件中的证据与独立证据记录不一致',
          { eventId: event.id, commitId: row.id }
        )
        return event
      })
      const commit: NarrativeCommit = {
        id: row.id,
        workId: row.novel_id,
        chapterVersionId: row.chapter_version_id,
        chapterOrdinal: row.chapter_ordinal,
        baseRevision: row.base_revision,
        revision: row.revision,
        events
      }
      assertNarrativeKernel(
        canonicalHash(commit) === row.commit_hash,
        'COMMIT_HASH_MISMATCH',
        '章节提交内容与提交哈希不一致',
        { commitId: row.id }
      )
      return commit
    })
  }

  private insertEvent(
    commit: NarrativeCommit,
    event: NarrativeEvent,
    sequence: number
  ): void {
    const evidenceId = `${event.id}:evidence`
    this.db.prepare(`
      INSERT INTO narrative_evidence_spans (
        id, chapter_version_id, start_offset, end_offset, quote_hash
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      evidenceId,
      event.evidence.chapterVersionId,
      event.evidence.startOffset,
      event.evidence.endOffset,
      event.evidence.quoteHash
    )
    const eventJson = canonicalJson(event)
    this.db.prepare(`
      INSERT INTO narrative_events (
        id, commit_id, novel_id, stream_revision, sequence_in_commit,
        event_type, event_json, event_hash, evidence_span_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      commit.id,
      commit.workId,
      commit.revision,
      sequence,
      event.type,
      eventJson,
      sha256(eventJson),
      evidenceId
    )
  }
}
