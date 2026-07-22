import { createHash } from 'node:crypto'
import { BaseDAO } from './base-dao'
import type {
  CausalChapterDecisionRecord,
  CausalChapterOutcome,
  CausalChapterPlan,
  CausalNarrativeState
} from '../../../shared/causal-novel-types'
import { normalizeCausalNarrativeState } from '../../../shared/causal-novel-types'

interface CausalNarrativeStateRow {
  work_id: number
  revision: number
  state_json: string
}

interface CausalChapterDecisionRow {
  chapter_id: number
  work_id: number
  state_revision: number
  status: CausalChapterDecisionRecord['status']
  plan_json: string
  outcome_json: string | null
}

export interface CausalStateRevisionRecord {
  workId: number
  revision: number
  state: CausalNarrativeState
  sourceChapterId: number | null
  transitionType: string
  bodyHash: string | null
  createTime: string
}

interface CausalStateRevisionRow {
  work_id: number
  revision: number
  state_json: string
  source_chapter_id: number | null
  transition_type: string
  body_hash: string | null
  create_time: string
}

export interface CausalPlanAttemptRecord {
  id: number
  workId: number
  stateRevision: number
  stage: string
  status: 'accepted' | 'rejected'
  errorCode: string | null
  errorMessage: string | null
  responseHash: string | null
  responseJson: string | null
  createTime: string
}

interface CausalPlanAttemptRow {
  id: number
  work_id: number
  state_revision: number
  stage: string
  status: CausalPlanAttemptRecord['status']
  error_code: string | null
  error_message: string | null
  response_hash: string | null
  response_json: string | null
  create_time: string
}

export type CausalEditKind = 'generated' | 'expression' | 'factual' | 'structural'
export type CausalReplayStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'cancelled'

export interface CausalContentVersionRecord {
  id: number
  workId: number
  chapterId: number
  parentVersionId: number | null
  bodyHash: string
  content: string
  wordCount: number
  source: string
  editKind: CausalEditKind
  status: string
  createTime: string
}

export interface CausalChapterBindingRecord {
  chapterId: number
  workId: number
  contentVersionId: number
  stateBeforeRevision: number | null
  stateAfterRevision: number | null
  decisionStatus: string
  bindingStatus: string
  updateTime: string
}

export interface CausalReplayJobRecord {
  id: number
  workId: number
  chapterId: number
  baseStateRevision: number
  sourceVersionId: number
  targetVersionId: number
  editKind: CausalEditKind
  status: CausalReplayStatus
  affectedChapterIds: number[]
  errorMessage: string | null
  createTime: string
  updateTime: string
}

export interface CausalStageCheckpointRecord {
  id: number
  workId: number
  chapterId: number
  contentVersionId: number
  bodyHash: string
  protocolVersion: number
  stage: string
  status: string
  payload: unknown
  errorMessage: string | null
}

interface CausalContentVersionRow {
  id: number; work_id: number; chapter_id: number; parent_version_id: number | null
  body_hash: string; content: string; word_count: number; source: string
  edit_kind: CausalEditKind; status: string; create_time: string
}

interface CausalChapterBindingRow {
  chapter_id: number; work_id: number; content_version_id: number
  state_before_revision: number | null; state_after_revision: number | null
  decision_status: string; binding_status: string; update_time: string
}

interface CausalReplayJobRow {
  id: number; work_id: number; chapter_id: number; base_state_revision: number
  source_version_id: number; target_version_id: number; edit_kind: CausalEditKind
  status: CausalReplayStatus; affected_chapters_json: string
  error_message: string | null; create_time: string; update_time: string
}

interface CausalStageCheckpointRow {
  id: number; work_id: number; chapter_id: number; content_version_id: number
  body_hash: string; protocol_version: number; stage: string; status: string
  payload_json: string | null; error_message: string | null
}

export class CausalNovelDAO extends BaseDAO {
  private bodyHash(content: string): string {
    return createHash('sha256').update(content).digest('hex')
  }

  ensureCurrentContentVersion(
    workId: number,
    chapterId: number,
    source = 'system',
    editKind: CausalEditKind = 'generated'
  ): CausalContentVersionRecord {
    const chapter = this.get<{ content: string | null; word_count: number }>(
      'SELECT content, word_count FROM chapters WHERE id = ?', [chapterId]
    )
    if (!chapter) throw new Error('章节不存在')
    const content = chapter.content ?? ''
    const hash = this.bodyHash(content)
    const bound = this.get<CausalContentVersionRow>(
      `SELECT v.* FROM causal_chapter_bindings b
       JOIN causal_content_versions v ON v.id = b.content_version_id
       WHERE b.chapter_id = ?`, [chapterId]
    )
    if (bound?.body_hash === hash) return this.parseContentVersion(bound)
    const existing = this.get<CausalContentVersionRow>(
      `SELECT * FROM causal_content_versions
       WHERE chapter_id = ? AND body_hash = ? AND status = 'active'
       ORDER BY id DESC LIMIT 1`, [chapterId, hash]
    )
    const id = existing?.id ?? this.insert(
      `INSERT INTO causal_content_versions (
        work_id, chapter_id, parent_version_id, body_hash, content, word_count,
        source, edit_kind, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      [workId, chapterId, bound?.id ?? null, hash, content, chapter.word_count ?? this.wordCount(content), source, editKind]
    )
    this.run(
      `UPDATE causal_content_versions SET status = 'superseded'
       WHERE chapter_id = ? AND id <> ? AND status = 'active'`,
      [chapterId, id]
    )
    const decision = this.get<CausalChapterDecisionRow>(
      'SELECT * FROM causal_chapter_decisions WHERE chapter_id = ?', [chapterId]
    )
    this.upsertBinding({
      workId, chapterId, contentVersionId: id,
      stateBeforeRevision: decision?.state_revision ?? null,
      stateAfterRevision: decision?.status === 'committed' ? decision.state_revision + 1 : null,
      decisionStatus: decision?.status ?? 'unmanaged', bindingStatus: 'active'
    })
    return this.getContentVersion(id)!
  }

  createContentVersion(input: {
    workId: number; chapterId: number; parentVersionId: number | null
    content: string; source: string; editKind: CausalEditKind; status?: string
  }): CausalContentVersionRecord {
    const id = this.insert(
      `INSERT INTO causal_content_versions (
        work_id, chapter_id, parent_version_id, body_hash, content, word_count,
        source, edit_kind, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.workId, input.chapterId, input.parentVersionId, this.bodyHash(input.content),
        input.content, this.wordCount(input.content), input.source, input.editKind, input.status ?? 'candidate']
    )
    return this.getContentVersion(id)!
  }

  getContentVersion(id: number): CausalContentVersionRecord | null {
    const row = this.get<CausalContentVersionRow>('SELECT * FROM causal_content_versions WHERE id = ?', [id])
    return row ? this.parseContentVersion(row) : null
  }

  listContentVersions(chapterId: number): CausalContentVersionRecord[] {
    return this.all<CausalContentVersionRow>(
      'SELECT * FROM causal_content_versions WHERE chapter_id = ? ORDER BY id DESC', [chapterId]
    ).map(row => this.parseContentVersion(row))
  }

  getChapterBinding(chapterId: number): CausalChapterBindingRecord | null {
    const row = this.get<CausalChapterBindingRow>(
      'SELECT * FROM causal_chapter_bindings WHERE chapter_id = ?', [chapterId]
    )
    return row ? this.parseBinding(row) : null
  }

  activateContentVersion(input: {
    workId: number; chapterId: number; contentVersionId: number
    stateBeforeRevision: number | null; stateAfterRevision: number | null
    decisionStatus: string; bindingStatus?: string
  }): void {
    this.transaction(() => {
      this.run(
        `UPDATE causal_content_versions SET status = 'superseded'
         WHERE chapter_id = ? AND status = 'active' AND id <> ?`,
        [input.chapterId, input.contentVersionId]
      )
      this.run(`UPDATE causal_content_versions SET status = 'active' WHERE id = ?`, [input.contentVersionId])
      this.upsertBinding({ ...input, bindingStatus: input.bindingStatus ?? 'active' })
    })
  }

  invalidateCheckpoints(workId: number, chapterId: number): number {
    return this.run(
      `UPDATE causal_stage_checkpoints
       SET status = 'invalidated', update_time = CURRENT_TIMESTAMP
       WHERE work_id = ? AND chapter_id = ? AND status <> 'invalidated'`,
      [workId, chapterId]
    ).changes
  }

  getCheckpoint(
    chapterId: number,
    contentVersionId: number,
    stage: string,
    protocolVersion = 1
  ): CausalStageCheckpointRecord | null {
    const row = this.get<CausalStageCheckpointRow>(
      `SELECT * FROM causal_stage_checkpoints
       WHERE chapter_id = ? AND content_version_id = ? AND stage = ? AND protocol_version = ?`,
      [chapterId, contentVersionId, stage, protocolVersion]
    )
    if (!row) return null
    let payload: unknown = null
    try { payload = row.payload_json ? JSON.parse(row.payload_json) : null } catch { /* 损坏检查点视为空载荷 */ }
    return {
      id: row.id, workId: row.work_id, chapterId: row.chapter_id,
      contentVersionId: row.content_version_id, bodyHash: row.body_hash,
      protocolVersion: row.protocol_version, stage: row.stage, status: row.status,
      payload, errorMessage: row.error_message
    }
  }

  saveCheckpoint(input: {
    workId: number; chapterId: number; contentVersionId: number; bodyHash: string
    stage: string; status: 'completed' | 'failed'; payload?: unknown
    errorMessage?: string | null; protocolVersion?: number
  }): void {
    this.run(
      `INSERT INTO causal_stage_checkpoints (
        work_id, chapter_id, content_version_id, body_hash, protocol_version,
        stage, status, payload_json, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chapter_id, content_version_id, protocol_version, stage) DO UPDATE SET
        body_hash = excluded.body_hash,
        status = excluded.status,
        payload_json = excluded.payload_json,
        error_message = excluded.error_message,
        update_time = CURRENT_TIMESTAMP`,
      [input.workId, input.chapterId, input.contentVersionId, input.bodyHash,
        input.protocolVersion ?? 1, input.stage, input.status,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        input.errorMessage?.slice(0, 4000) ?? null]
    )
  }

  queueReplay(input: {
    workId: number; chapterId: number; baseStateRevision: number
    sourceVersionId: number; targetVersionId: number; editKind: CausalEditKind
    affectedChapterIds: number[]
  }): CausalReplayJobRecord {
    return this.transaction(() => {
      this.run(
        `UPDATE causal_replay_jobs SET status = 'cancelled', update_time = CURRENT_TIMESTAMP
         WHERE work_id = ? AND chapter_id = ? AND status IN ('pending', 'blocked')`,
        [input.workId, input.chapterId]
      )
      const id = this.insert(
        `INSERT INTO causal_replay_jobs (
          work_id, chapter_id, base_state_revision, source_version_id,
          target_version_id, edit_kind, status, affected_chapters_json
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [input.workId, input.chapterId, input.baseStateRevision, input.sourceVersionId,
          input.targetVersionId, input.editKind, JSON.stringify(input.affectedChapterIds)]
      )
      this.run(
        `UPDATE causal_chapter_bindings SET binding_status = 'pending_replay', update_time = CURRENT_TIMESTAMP
         WHERE chapter_id = ?`, [input.chapterId]
      )
      if (input.affectedChapterIds.length) {
        const placeholders = input.affectedChapterIds.map(() => '?').join(',')
        this.run(
          `UPDATE causal_chapter_bindings SET binding_status = 'stale', update_time = CURRENT_TIMESTAMP
           WHERE chapter_id IN (${placeholders})`, input.affectedChapterIds
        )
      }
      return this.getReplayJob(id)!
    })
  }

  getReplayJob(id: number): CausalReplayJobRecord | null {
    const row = this.get<CausalReplayJobRow>('SELECT * FROM causal_replay_jobs WHERE id = ?', [id])
    return row ? this.parseReplayJob(row) : null
  }

  getPendingReplay(workId: number): CausalReplayJobRecord | null {
    const row = this.get<CausalReplayJobRow>(
      `SELECT * FROM causal_replay_jobs
       WHERE work_id = ? AND status IN ('pending', 'running', 'blocked')
       ORDER BY id LIMIT 1`, [workId]
    )
    return row ? this.parseReplayJob(row) : null
  }

  listReplayJobs(workId: number, limit = 50): CausalReplayJobRecord[] {
    return this.all<CausalReplayJobRow>(
      'SELECT * FROM causal_replay_jobs WHERE work_id = ? ORDER BY id DESC LIMIT ?',
      [workId, Math.max(1, Math.min(500, Math.round(limit)))]
    ).map(row => this.parseReplayJob(row))
  }

  updateReplayStatus(id: number, status: CausalReplayStatus, errorMessage?: string | null): void {
    this.run(
      `UPDATE causal_replay_jobs
       SET status = ?, error_message = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, errorMessage?.slice(0, 4000) ?? null, id]
    )
  }

  updateReplayTargetVersion(id: number, targetVersionId: number): void {
    this.run(
      `UPDATE causal_replay_jobs
       SET target_version_id = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?`,
      [targetVersionId, id]
    )
  }

  applyReplayTransition(input: {
    replayJobId: number
    workId: number
    chapterId: number
    contentVersionId: number
    expectedStateRevision: number
    nextState: CausalNarrativeState
    outcome: CausalChapterOutcome
  }): void {
    const contentVersion = this.getContentVersion(input.contentVersionId)
    if (!contentVersion || contentVersion.chapterId !== input.chapterId) {
      throw new Error('重放正文版本与章节不匹配')
    }
    this.replaceState(input.workId, input.expectedStateRevision, input.nextState, {
      transitionType: 'manual_replay', sourceChapterId: input.chapterId, bodyHash: contentVersion.bodyHash
    })
    this.run(
      `UPDATE causal_chapter_decisions
       SET state_revision = ?, status = 'committed', outcome_json = ?, update_time = CURRENT_TIMESTAMP
       WHERE chapter_id = ?`,
      [input.expectedStateRevision, JSON.stringify(input.outcome), input.chapterId]
    )
    this.activateContentVersion({
      workId: input.workId, chapterId: input.chapterId, contentVersionId: input.contentVersionId,
      stateBeforeRevision: input.expectedStateRevision, stateAfterRevision: input.nextState.revision,
      decisionStatus: 'committed', bindingStatus: 'active'
    })
    this.recordOutcomeVersion({
      workId: input.workId, chapterId: input.chapterId, contentVersionId: input.contentVersionId,
      replayJobId: input.replayJobId, stateBeforeRevision: input.expectedStateRevision,
      stateAfterRevision: input.nextState.revision, outcome: input.outcome
    })
  }

  completeReplay(id: number): void {
    this.updateReplayStatus(id, 'completed')
  }

  retryReplay(id: number): void {
    this.transaction(() => {
      this.run(`UPDATE causal_replay_conflicts SET resolved = 1 WHERE replay_job_id = ?`, [id])
      this.updateReplayStatus(id, 'pending')
    })
  }

  cancelReplay(id: number): void {
    const job = this.getReplayJob(id)
    if (!job) throw new Error('因果重放任务不存在')
    this.transaction(() => {
      this.updateReplayStatus(id, 'cancelled')
      this.run(`UPDATE causal_replay_conflicts SET resolved = 1 WHERE replay_job_id = ?`, [id])
      if (job.affectedChapterIds.length) {
        const placeholders = job.affectedChapterIds.map(() => '?').join(',')
        this.run(
          `UPDATE causal_chapter_bindings SET binding_status = 'active', update_time = CURRENT_TIMESTAMP
           WHERE chapter_id IN (${placeholders})`, job.affectedChapterIds
        )
      }
    })
  }

  blockReplay(id: number, chapterId: number, message: string, conflictType = 'downstream_conflict'): void {
    this.transaction(() => {
      this.insert(
        `INSERT INTO causal_replay_conflicts (
          replay_job_id, chapter_id, conflict_type, message
        ) VALUES (?, ?, ?, ?)`,
        [id, chapterId, conflictType, message.slice(0, 4000)]
      )
      this.updateReplayStatus(id, 'blocked', message)
    })
  }

  private recordOutcomeVersion(input: {
    workId: number; chapterId: number; contentVersionId: number; replayJobId?: number | null
    stateBeforeRevision: number; stateAfterRevision: number; outcome: CausalChapterOutcome
  }): void {
    this.run(
      `UPDATE causal_outcome_versions SET status = 'superseded'
       WHERE work_id = ? AND chapter_id = ? AND status = 'active'`,
      [input.workId, input.chapterId]
    )
    this.insert(
      `INSERT INTO causal_outcome_versions (
        work_id, chapter_id, content_version_id, replay_job_id,
        state_before_revision, state_after_revision, outcome_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [input.workId, input.chapterId, input.contentVersionId, input.replayJobId ?? null,
        input.stateBeforeRevision, input.stateAfterRevision, JSON.stringify(input.outcome)]
    )
  }

  private wordCount(content: string): number {
    return content.replace(/\s/g, '').length
  }

  private upsertBinding(input: {
    workId: number; chapterId: number; contentVersionId: number
    stateBeforeRevision: number | null; stateAfterRevision: number | null
    decisionStatus: string; bindingStatus: string
  }): void {
    this.run(
      `INSERT INTO causal_chapter_bindings (
        chapter_id, work_id, content_version_id, state_before_revision,
        state_after_revision, decision_status, binding_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chapter_id) DO UPDATE SET
        content_version_id = excluded.content_version_id,
        state_before_revision = excluded.state_before_revision,
        state_after_revision = excluded.state_after_revision,
        decision_status = excluded.decision_status,
        binding_status = excluded.binding_status,
        update_time = CURRENT_TIMESTAMP`,
      [input.chapterId, input.workId, input.contentVersionId, input.stateBeforeRevision,
        input.stateAfterRevision, input.decisionStatus, input.bindingStatus]
    )
  }
  private ensureRollingVolume(workId: number): number {
    let volume = this.get<{ id: number }>(
      `SELECT id FROM volumes WHERE work_id = ? AND name = '滚动正文'`, [workId]
    )
    if (!volume) {
      const id = this.insert(
        `INSERT INTO volumes (work_id, name, description, sort)
         VALUES (?, '滚动正文', '由当前世界状态滚动产生，不设置分卷大纲', 1)`,
        [workId]
      )
      volume = { id }
    }
    return volume.id
  }

  getState(workId: number): CausalNarrativeState | null {
    const row = this.get<CausalNarrativeStateRow>(
      'SELECT work_id, revision, state_json FROM causal_narrative_states WHERE work_id = ?',
      [workId]
    )
    if (!row) return null
    const state = normalizeCausalNarrativeState(JSON.parse(row.state_json) as CausalNarrativeState)
    return { ...state, revision: row.revision }
  }

  createState(workId: number, state: CausalNarrativeState): void {
    this.transaction(() => {
      const normalized = normalizeCausalNarrativeState(state)
      this.run(
        `INSERT INTO causal_narrative_states (work_id, revision, state_json)
         VALUES (?, ?, ?)`,
        [workId, normalized.revision, JSON.stringify(normalized)]
      )
      this.insertStateRevision(workId, normalized, 'initial', null, null)
    })
  }

  replaceState(
    workId: number,
    expectedRevision: number,
    state: CausalNarrativeState,
    metadata: { transitionType: string; sourceChapterId?: number | null; bodyHash?: string | null }
  ): void {
    const replace = (): void => {
      if (state.revision !== expectedRevision + 1) {
        throw new Error(`因果状态版本不连续：${expectedRevision} -> ${state.revision}`)
      }
      const result = this.run(
        `UPDATE causal_narrative_states
         SET revision = ?, state_json = ?, update_time = CURRENT_TIMESTAMP
         WHERE work_id = ? AND revision = ?`,
        [state.revision, JSON.stringify(state), workId, expectedRevision]
      )
      if (result.changes !== 1) throw new Error('因果状态已被其他写入更新，请刷新后重试')
      this.insertStateRevision(
        workId,
        state,
        metadata.transitionType,
        metadata.sourceChapterId ?? null,
        metadata.bodyHash ?? null
      )
    }
    if (this.db.inTransaction) replace()
    else this.transaction(replace)
  }

  getStateRevision(workId: number, revision: number): CausalStateRevisionRecord | null {
    const row = this.get<CausalStateRevisionRow>(
      'SELECT * FROM causal_state_revisions WHERE work_id = ? AND revision = ?',
      [workId, revision]
    )
    return row ? this.parseStateRevision(row) : null
  }

  listStateRevisions(workId: number, limit = 100): CausalStateRevisionRecord[] {
    return this.all<CausalStateRevisionRow>(
      `SELECT * FROM causal_state_revisions
       WHERE work_id = ? ORDER BY revision DESC LIMIT ?`,
      [workId, Math.max(1, Math.min(1000, Math.round(limit)))]
    ).map(row => this.parseStateRevision(row))
  }

  recordPlanAttempt(input: {
    workId: number
    stateRevision: number
    stage: string
    status: CausalPlanAttemptRecord['status']
    errorCode?: string | null
    errorMessage?: string | null
    responseJson?: string | null
  }): number {
    const responseJson = input.responseJson?.slice(0, 200_000) ?? null
    const responseHash = responseJson
      ? createHash('sha256').update(responseJson).digest('hex')
      : null
    return this.insert(
      `INSERT INTO causal_plan_attempts (
        work_id, state_revision, stage, status, error_code, error_message,
        response_hash, response_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.workId,
        input.stateRevision,
        input.stage,
        input.status,
        input.errorCode ?? null,
        input.errorMessage?.slice(0, 4000) ?? null,
        responseHash,
        responseJson
      ]
    )
  }

  listPlanAttempts(workId: number, limit = 100): CausalPlanAttemptRecord[] {
    return this.all<CausalPlanAttemptRow>(
      `SELECT * FROM causal_plan_attempts
       WHERE work_id = ? ORDER BY id DESC LIMIT ?`,
      [workId, Math.max(1, Math.min(1000, Math.round(limit)))]
    ).map(row => ({
      id: row.id,
      workId: row.work_id,
      stateRevision: row.state_revision,
      stage: row.stage,
      status: row.status,
      errorCode: row.error_code,
      errorMessage: row.error_message,
      responseHash: row.response_hash,
      responseJson: row.response_json,
      createTime: row.create_time
    }))
  }

  createDecision(input: {
    workId: number
    chapterId: number
    stateRevision: number
    plan: CausalChapterPlan
  }): void {
    this.run(
      `INSERT INTO causal_chapter_decisions (
        chapter_id, work_id, state_revision, status, plan_json
      ) VALUES (?, ?, ?, 'planned', ?)`,
      [input.chapterId, input.workId, input.stateRevision, JSON.stringify(input.plan)]
    )
  }

  createPlannedChapter(input: {
    workId: number
    stateRevision: number
    plan: CausalChapterPlan
    decisionCard: string
  }): number {
    return this.transaction(() => {
      const volumeId = this.ensureRollingVolume(input.workId)
      const nextSort = this.get<{ value: number }>(
        'SELECT COALESCE(MAX(sort), 0) + 1 AS value FROM chapters WHERE volume_id = ?',
        [volumeId]
      )?.value ?? 1
      const decision = input.plan.decision
      const chapterId = this.insert(
        `INSERT INTO chapters (
          volume_id, title, outline, sort, status, characters, next_hook,
          outline_diagnosis, emotion_contract_json
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        [
          volumeId, decision.title, input.decisionCard, nextSort,
          JSON.stringify(decision.characters), decision.newQuestion,
          JSON.stringify({
            causal_mode: true,
            state_revision: input.stateRevision,
            selected_candidate_id: input.plan.selectedCandidateId,
            emotion_grounding_refs: input.plan.emotionContract.grounding_refs
          }),
          JSON.stringify(input.plan.emotionContract)
        ]
      )
      this.createDecision({
        workId: input.workId,
        chapterId,
        stateRevision: input.stateRevision,
        plan: input.plan
      })
      return chapterId
    })
  }

  getDecision(chapterId: number): CausalChapterDecisionRecord | null {
    const row = this.get<CausalChapterDecisionRow>(
      'SELECT * FROM causal_chapter_decisions WHERE chapter_id = ?', [chapterId]
    )
    return row ? this.parseDecision(row) : null
  }

  listDecisions(workId: number): CausalChapterDecisionRecord[] {
    return this.all<CausalChapterDecisionRow>(
      'SELECT * FROM causal_chapter_decisions WHERE work_id = ? ORDER BY chapter_id', [workId]
    ).map(row => this.parseDecision(row))
  }

  commitDecision(input: {
    workId: number
    chapterId: number
    expectedStateRevision: number
    nextState: CausalNarrativeState
    outcome: CausalChapterOutcome
    expectedBodyHash?: string
  }): void {
    const commit = (): void => {
      const decision = this.getDecision(input.chapterId)
      if (!decision || decision.workId !== input.workId) throw new Error('因果章节决策不存在')
      if (decision.status !== 'planned') throw new Error('因果章节决策已经提交或拒绝')
      if (decision.stateRevision !== input.expectedStateRevision) throw new Error('章节决策基于过期的因果状态')
      const chapter = this.get<{ content: string | null }>('SELECT content FROM chapters WHERE id = ?', [input.chapterId])
      const bodyHash = createHash('sha256').update(chapter?.content ?? '').digest('hex')
      if (input.expectedBodyHash && input.expectedBodyHash !== bodyHash) {
        throw new Error('章节正文已在因果提取后发生变化，拒绝提交过期状态')
      }
      this.replaceState(input.workId, input.expectedStateRevision, input.nextState, {
        transitionType: 'chapter_commit',
        sourceChapterId: input.chapterId,
        bodyHash
      })
      this.run(
        `UPDATE causal_chapter_decisions
         SET status = 'committed', outcome_json = ?, update_time = CURRENT_TIMESTAMP
         WHERE chapter_id = ? AND status = 'planned'`,
        [JSON.stringify(input.outcome), input.chapterId]
      )
      const contentVersion = this.ensureCurrentContentVersion(input.workId, input.chapterId, 'generation', 'generated')
      this.activateContentVersion({
        workId: input.workId,
        chapterId: input.chapterId,
        contentVersionId: contentVersion.id,
        stateBeforeRevision: input.expectedStateRevision,
        stateAfterRevision: input.nextState.revision,
        decisionStatus: 'committed'
      })
      this.recordOutcomeVersion({
        workId: input.workId,
        chapterId: input.chapterId,
        contentVersionId: contentVersion.id,
        stateBeforeRevision: input.expectedStateRevision,
        stateAfterRevision: input.nextState.revision,
        outcome: input.outcome
      })
    }
    if (this.db.inTransaction) commit()
    else this.transaction(commit)
  }

  rejectDecision(chapterId: number, outcome?: CausalChapterOutcome): void {
    this.run(
      `UPDATE causal_chapter_decisions
       SET status = 'rejected', outcome_json = ?, update_time = CURRENT_TIMESTAMP
       WHERE chapter_id = ? AND status = 'planned'`,
      [outcome ? JSON.stringify(outcome) : null, chapterId]
    )
  }

  confirmCompletion(workId: number, expectedRevision: number, reason: string): CausalNarrativeState {
    const current = this.getState(workId)
    if (!current || current.revision !== expectedRevision) throw new Error('因果状态已变化，无法确认完结')
    if (current.completionStatus !== 'proposed') throw new Error('因果状态尚未进入待确认完结阶段')
    const next: CausalNarrativeState = {
      ...current,
      revision: current.revision + 1,
      completionStatus: 'completed',
      completionAuditFeedback: [],
      completed: true,
      completionReason: reason.trim() || current.completionReason
    }
    this.transaction(() => this.replaceState(workId, expectedRevision, next, {
      transitionType: 'completion_confirmed'
    }))
    return next
  }

  rejectProposedCompletion(
    workId: number,
    expectedRevision: number,
    feedback: string[]
  ): CausalNarrativeState {
    const current = this.getState(workId)
    if (!current || current.revision !== expectedRevision) throw new Error('因果状态已变化，无法退回完结提案')
    if (current.completionStatus !== 'proposed') throw new Error('因果状态没有待退回的完结提案')
    const next: CausalNarrativeState = {
      ...current,
      revision: current.revision + 1,
      completionStatus: 'writing',
      completionAuditFeedback: [...new Set(feedback.map(item => item.trim()).filter(Boolean))].slice(-12),
      completed: false,
      completionReason: ''
    }
    this.transaction(() => this.replaceState(workId, expectedRevision, next, {
      transitionType: 'completion_rejected'
    }))
    return next
  }

  private insertStateRevision(
    workId: number,
    state: CausalNarrativeState,
    transitionType: string,
    sourceChapterId: number | null,
    bodyHash: string | null
  ): void {
    this.run(
      `INSERT INTO causal_state_revisions (
        work_id, revision, state_json, source_chapter_id, transition_type, body_hash
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [workId, state.revision, JSON.stringify(state), sourceChapterId, transitionType, bodyHash]
    )
  }

  private parseStateRevision(row: CausalStateRevisionRow): CausalStateRevisionRecord {
    return {
      workId: row.work_id,
      revision: row.revision,
      state: normalizeCausalNarrativeState(JSON.parse(row.state_json) as CausalNarrativeState),
      sourceChapterId: row.source_chapter_id,
      transitionType: row.transition_type,
      bodyHash: row.body_hash,
      createTime: row.create_time
    }
  }

  private parseContentVersion(row: CausalContentVersionRow): CausalContentVersionRecord {
    return {
      id: row.id,
      workId: row.work_id,
      chapterId: row.chapter_id,
      parentVersionId: row.parent_version_id,
      bodyHash: row.body_hash,
      content: row.content,
      wordCount: row.word_count,
      source: row.source,
      editKind: row.edit_kind,
      status: row.status,
      createTime: row.create_time
    }
  }

  private parseBinding(row: CausalChapterBindingRow): CausalChapterBindingRecord {
    return {
      chapterId: row.chapter_id,
      workId: row.work_id,
      contentVersionId: row.content_version_id,
      stateBeforeRevision: row.state_before_revision,
      stateAfterRevision: row.state_after_revision,
      decisionStatus: row.decision_status,
      bindingStatus: row.binding_status,
      updateTime: row.update_time
    }
  }

  private parseReplayJob(row: CausalReplayJobRow): CausalReplayJobRecord {
    let affectedChapterIds: number[] = []
    try {
      const parsed = JSON.parse(row.affected_chapters_json) as unknown
      if (Array.isArray(parsed)) {
        affectedChapterIds = parsed.filter((value): value is number => Number.isInteger(value))
      }
    } catch { /* 损坏的历史字段按空列表降级，保留任务本身供人工检查。 */ }
    return {
      id: row.id,
      workId: row.work_id,
      chapterId: row.chapter_id,
      baseStateRevision: row.base_state_revision,
      sourceVersionId: row.source_version_id,
      targetVersionId: row.target_version_id,
      editKind: row.edit_kind,
      status: row.status,
      affectedChapterIds,
      errorMessage: row.error_message,
      createTime: row.create_time,
      updateTime: row.update_time
    }
  }

  private parseDecision(row: CausalChapterDecisionRow): CausalChapterDecisionRecord {
    return {
      chapterId: row.chapter_id,
      workId: row.work_id,
      stateRevision: row.state_revision,
      status: row.status,
      plan: JSON.parse(row.plan_json) as CausalChapterPlan,
      outcome: row.outcome_json ? JSON.parse(row.outcome_json) as CausalChapterOutcome : null
    }
  }
}

export const causalNovelDAO = new CausalNovelDAO()
