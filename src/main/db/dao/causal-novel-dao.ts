import { BaseDAO } from './base-dao'
import type {
  CausalChapterDecisionRecord,
  CausalChapterOutcome,
  CausalChapterPlan,
  CausalNarrativeState
} from '../../../shared/causal-novel-types'

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

export class CausalNovelDAO extends BaseDAO {
  getState(workId: number): CausalNarrativeState | null {
    const row = this.get<CausalNarrativeStateRow>(
      'SELECT work_id, revision, state_json FROM causal_narrative_states WHERE work_id = ?',
      [workId]
    )
    if (!row) return null
    const state = JSON.parse(row.state_json) as CausalNarrativeState
    return { ...state, revision: row.revision }
  }

  createState(workId: number, state: CausalNarrativeState): void {
    this.run(
      `INSERT INTO causal_narrative_states (work_id, revision, state_json)
       VALUES (?, ?, ?)`,
      [workId, state.revision, JSON.stringify(state)]
    )
  }

  replaceState(workId: number, expectedRevision: number, state: CausalNarrativeState): void {
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
      let volume = this.get<{ id: number }>(
        `SELECT id FROM volumes WHERE work_id = ? AND name = '滚动正文'`, [input.workId]
      )
      if (!volume) {
        const id = this.insert(
          `INSERT INTO volumes (work_id, name, description, sort)
           VALUES (?, '滚动正文', '由当前世界状态滚动产生，不设置分卷大纲', 1)`,
          [input.workId]
        )
        volume = { id }
      }
      const nextSort = this.get<{ value: number }>(
        'SELECT COALESCE(MAX(sort), 0) + 1 AS value FROM chapters WHERE volume_id = ?',
        [volume.id]
      )?.value ?? 1
      const decision = input.plan.decision
      const chapterId = this.insert(
        `INSERT INTO chapters (
          volume_id, title, outline, sort, status, characters, next_hook,
          outline_diagnosis, emotion_contract_json
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        [
          volume.id, decision.title, input.decisionCard, nextSort,
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
  }): void {
    const commit = (): void => {
      const decision = this.getDecision(input.chapterId)
      if (!decision || decision.workId !== input.workId) throw new Error('因果章节决策不存在')
      if (decision.status !== 'planned') throw new Error('因果章节决策已经提交或拒绝')
      if (decision.stateRevision !== input.expectedStateRevision) throw new Error('章节决策基于过期的因果状态')
      this.replaceState(input.workId, input.expectedStateRevision, input.nextState)
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
