import { BaseDAO } from './base-dao'

export type GoalRoutineStatus =
  | 'idle' | 'running' | 'paused' | 'goal_met' | 'timeout' | 'error' | 'cancelled'

export interface GoalRoutineStateRow {
  work_id: number
  status: GoalRoutineStatus
  turn_count: number
  max_turns: number
  current_phase: string | null
  last_ai_percent: number | null
  last_quality_score: number | null
  goal_met: number
  goal_config_json: string | null
  state_json: string | null
  update_time: string
}

export interface GoalRoutineTurnRow {
  id: number
  work_id: number
  turn_no: number
  phase: string | null
  action: string | null
  target_chapter_id: number | null
  ai_percent_before: number | null
  ai_percent_after: number | null
  score: number | null
  summary: string | null
  create_time: string
}

export interface GoalStateUpdate {
  status?: GoalRoutineStatus
  turn_count?: number
  max_turns?: number
  current_phase?: string | null
  last_ai_percent?: number | null
  last_quality_score?: number | null
  goal_met?: boolean
  goal_config_json?: string | null
  state_json?: string | null
}

export class GoalRoutineDAO extends BaseDAO {
  getByWork(workId: number): GoalRoutineStateRow | undefined {
    return super.get<GoalRoutineStateRow>(
      'SELECT * FROM goal_routine_states WHERE work_id = ?',
      [workId]
    )
  }

  ensure(workId: number): GoalRoutineStateRow {
    const existing = this.getByWork(workId)
    if (existing) return existing
    this.insert(
      'INSERT INTO goal_routine_states (work_id, status) VALUES (?, ?)',
      [workId, 'idle']
    )
    return this.getByWork(workId)!
  }

  update(workId: number, patch: GoalStateUpdate): void {
    this.ensure(workId)
    const fields: string[] = []
    const values: unknown[] = []
    if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status) }
    if (patch.turn_count !== undefined) { fields.push('turn_count = ?'); values.push(patch.turn_count) }
    if (patch.max_turns !== undefined) { fields.push('max_turns = ?'); values.push(patch.max_turns) }
    if (patch.current_phase !== undefined) { fields.push('current_phase = ?'); values.push(patch.current_phase) }
    if (patch.last_ai_percent !== undefined) { fields.push('last_ai_percent = ?'); values.push(patch.last_ai_percent) }
    if (patch.last_quality_score !== undefined) { fields.push('last_quality_score = ?'); values.push(patch.last_quality_score) }
    if (patch.goal_met !== undefined) { fields.push('goal_met = ?'); values.push(patch.goal_met ? 1 : 0) }
    if (patch.goal_config_json !== undefined) { fields.push('goal_config_json = ?'); values.push(patch.goal_config_json) }
    if (patch.state_json !== undefined) { fields.push('state_json = ?'); values.push(patch.state_json) }
    if (fields.length === 0) return
    fields.push("update_time = CURRENT_TIMESTAMP")
    values.push(workId)
    this.run(`UPDATE goal_routine_states SET ${fields.join(', ')} WHERE work_id = ?`, values)
  }

  setStatus(workId: number, status: GoalRoutineStatus): void {
    this.update(workId, { status })
  }

  /** 将所有 running 态重置为 paused（启动时 reconcile 用，避免 LLM 中途失控自动续跑） */
  resetRunningToPaused(): number {
    const result = this.run(
      `UPDATE goal_routine_states SET status = 'paused', update_time = CURRENT_TIMESTAMP WHERE status = 'running'`
    )
    return result.changes
  }

  appendTurn(input: {
    work_id: number
    turn_no: number
    phase?: string | null
    action?: string | null
    target_chapter_id?: number | null
    ai_percent_before?: number | null
    ai_percent_after?: number | null
    score?: number | null
    summary?: string | null
  }): number {
    return this.insert(
      `INSERT INTO goal_routine_turns
       (work_id, turn_no, phase, action, target_chapter_id, ai_percent_before, ai_percent_after, score, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.work_id, input.turn_no, input.phase ?? null, input.action ?? null,
        input.target_chapter_id ?? null, input.ai_percent_before ?? null,
        input.ai_percent_after ?? null, input.score ?? null, input.summary ?? null]
    )
  }

  listTurns(workId: number, limit = 50): GoalRoutineTurnRow[] {
    return this.all<GoalRoutineTurnRow>(
      'SELECT * FROM goal_routine_turns WHERE work_id = ? ORDER BY turn_no DESC LIMIT ?',
      [workId, limit]
    )
  }
}

export const goalRoutineDAO = new GoalRoutineDAO()
