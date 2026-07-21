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

export class CausalNovelDAO extends BaseDAO {
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
