import { createHash, randomUUID } from 'node:crypto'
import { BaseDAO } from './base-dao'

export type GoalRoutineStatus =
  | 'idle' | 'running' | 'waiting' | 'paused' | 'goal_met'
  | 'timeout' | 'error' | 'cancelled' | 'superseded'

export type WorkflowType = 'story' | 'novel'

export interface GoalRoutineStateRow {
  id: number
  run_id: number
  work_id: number
  run_seq: number
  workflow_type: WorkflowType
  status: GoalRoutineStatus
  desired_state: 'running' | 'paused' | 'cancelled'
  turn_count: number
  max_turns: number
  current_phase: string | null
  last_ai_percent: number | null
  last_quality_score: number | null
  goal_met: number
  goal_config_json: string | null
  state_json: string | null
  lease_owner: string | null
  lease_expires_at: string | null
  heartbeat_at: string | null
  recovery_count: number
  create_time: string
  update_time: string
}

export interface GoalRoutineTurnRow {
  id: number
  run_id: number
  work_id: number
  turn_no: number
  phase: string | null
  action: string | null
  target_chapter_id: number | null
  ai_percent_before: number | null
  ai_percent_after: number | null
  score: number | null
  summary: string | null
  payload_json: string | null
  create_time: string
}

export interface GoalStateUpdate {
  status?: GoalRoutineStatus
  desired_state?: 'running' | 'paused' | 'cancelled'
  turn_count?: number
  max_turns?: number
  current_phase?: string | null
  last_ai_percent?: number | null
  last_quality_score?: number | null
  goal_met?: boolean
  goal_config_json?: string | null
  state_json?: string | null
}

export interface WorkflowStepRow {
  id: number
  run_id: number
  step_key: string
  scope_key: string
  input_hash: string
  protocol_version: number
  attempt_no: number
  status: 'running' | 'completed' | 'failed' | 'waiting' | 'cancelled'
  error_class: string | null
  error_code: string | null
  error_message: string | null
  retry_at: string | null
  output_artifact_id: number | null
  started_at: string
  finished_at: string | null
  update_time: string
  generation_step?: string | null
  model_type?: string | null
  model_name?: string | null
  model_duration_ms?: number | null
  model_finish_reason?: string | null
}

export interface BeginWorkflowRunInput {
  workId: number
  workflowType: WorkflowType
  resume: boolean
  maxTurns: number
  currentPhase: string
  goalConfigJson: string
  resetTurnCount?: boolean
}

export interface BeginWorkflowStepInput {
  workId: number
  stepKey: string
  /** 运行状态机阶段；省略时与持久化子步骤相同。 */
  phaseKey?: string
  scopeKey: string
  input: unknown
  protocolVersion?: number
}

const LEASE_SECONDS = 90

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, stableValue(nested)])
  )
}

export function workflowInputHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex')
}

/**
 * 新工作流运行 DAO。
 *
 * 公开名称暂沿用 goalRoutineDAO 以避免领域模块出现两套运行权威；所有方法只读写
 * workflow_* 表，旧 goal_routine_* 表不再参与运行。
 */
export class GoalRoutineDAO extends BaseDAO {
  private readonly leaseOwner = `${process.pid}:${randomUUID()}`

  private normalize(row: Omit<GoalRoutineStateRow, 'run_id'> | undefined): GoalRoutineStateRow | undefined {
    return row ? { ...row, run_id: row.id } : undefined
  }

  getByWork(workId: number): GoalRoutineStateRow | undefined {
    return this.normalize(super.get<Omit<GoalRoutineStateRow, 'run_id'>>(
      'SELECT * FROM workflow_runs WHERE work_id = ? ORDER BY id DESC LIMIT 1',
      [workId]
    ))
  }

  getById(runId: number): GoalRoutineStateRow | undefined {
    return this.normalize(super.get<Omit<GoalRoutineStateRow, 'run_id'>>(
      'SELECT * FROM workflow_runs WHERE id = ?',
      [runId]
    ))
  }

  beginRun(input: BeginWorkflowRunInput): GoalRoutineStateRow {
    return this.transaction(() => {
      const latest = this.getByWork(input.workId)
      const canResume = input.resume && latest && !latest.goal_met && [
        'running', 'waiting', 'paused', 'cancelled', 'timeout', 'error'
      ].includes(latest.status)
      const canActivateIdle = latest?.status === 'idle' && !latest.goal_met
      if (canResume || canActivateIdle) {
        const turnCount = input.resetTurnCount || canActivateIdle ? 0 : latest.turn_count
        const acquired = this.run(
          `UPDATE workflow_runs
           SET status = 'running', desired_state = 'running', max_turns = ?,
               turn_count = ?, current_phase = ?, goal_config_json = ?,
               lease_owner = ?, lease_expires_at = datetime('now', ?),
               heartbeat_at = CURRENT_TIMESTAMP, update_time = CURRENT_TIMESTAMP
           WHERE id = ?
             AND (
               lease_owner IS NULL OR lease_owner = ?
               OR lease_expires_at IS NULL OR lease_expires_at <= CURRENT_TIMESTAMP
             )`,
          [
            input.maxTurns,
            turnCount,
            input.currentPhase,
            input.goalConfigJson,
            this.leaseOwner,
            `+${LEASE_SECONDS} seconds`,
            latest.id,
            this.leaseOwner
          ]
        )
        if (acquired.changes !== 1) {
          throw new Error(`工作流运行 ${latest.id} 已被其他执行器持有`)
        }
        return this.getById(latest.id)!
      }

      if (latest && !latest.goal_met && latest.status !== 'superseded') {
        this.run(
          `UPDATE workflow_runs
           SET status = 'superseded', desired_state = 'cancelled',
               lease_owner = NULL, lease_expires_at = NULL, update_time = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [latest.id]
        )
      }
      const seq = (super.get<{ seq: number }>(
        'SELECT COALESCE(MAX(run_seq), 0) + 1 AS seq FROM workflow_runs WHERE work_id = ?',
        [input.workId]
      )?.seq ?? 1)
      const id = this.insert(
        `INSERT INTO workflow_runs (
           work_id, run_seq, workflow_type, status, desired_state, turn_count, max_turns,
           current_phase, goal_met, goal_config_json, state_json,
           lease_owner, lease_expires_at, heartbeat_at
         ) VALUES (?, ?, ?, 'running', 'running', 0, ?, ?, 0, ?, '{}', ?, datetime('now', ?), CURRENT_TIMESTAMP)`,
        [
          input.workId,
          seq,
          input.workflowType,
          input.maxTurns,
          input.currentPhase,
          input.goalConfigJson,
          this.leaseOwner,
          `+${LEASE_SECONDS} seconds`
        ]
      )
      return this.getById(id)!
    })
  }

  ensure(workId: number): GoalRoutineStateRow {
    const existing = this.getByWork(workId)
    if (existing) return existing
    return this.transaction(() => {
      const concurrent = this.getByWork(workId)
      if (concurrent) return concurrent
      const workflowType = super.get<{ work_type: WorkflowType }>(
        'SELECT work_type FROM works WHERE id = ?',
        [workId]
      )?.work_type ?? 'story'
      const seq = (super.get<{ seq: number }>(
        'SELECT COALESCE(MAX(run_seq), 0) + 1 AS seq FROM workflow_runs WHERE work_id = ?',
        [workId]
      )?.seq ?? 1)
      const id = this.insert(
        `INSERT INTO workflow_runs (
           work_id, run_seq, workflow_type, status, desired_state, turn_count, max_turns,
           current_phase, goal_met, goal_config_json, state_json
         ) VALUES (?, ?, ?, 'idle', 'paused', 0, 30, NULL, 0, '{}', '{}')`,
        [workId, seq, workflowType]
      )
      return this.getById(id)!
    })
  }

  update(workId: number, patch: GoalStateUpdate): void {
    const current = this.ensure(workId)
    const fields: string[] = []
    const values: unknown[] = []
    if (patch.status !== undefined) { fields.push('status = ?'); values.push(patch.status) }
    if (patch.desired_state !== undefined) { fields.push('desired_state = ?'); values.push(patch.desired_state) }
    if (patch.turn_count !== undefined) { fields.push('turn_count = ?'); values.push(patch.turn_count) }
    if (patch.max_turns !== undefined) { fields.push('max_turns = ?'); values.push(patch.max_turns) }
    if (patch.current_phase !== undefined) { fields.push('current_phase = ?'); values.push(patch.current_phase) }
    if (patch.last_ai_percent !== undefined) { fields.push('last_ai_percent = ?'); values.push(patch.last_ai_percent) }
    if (patch.last_quality_score !== undefined) { fields.push('last_quality_score = ?'); values.push(patch.last_quality_score) }
    if (patch.goal_met !== undefined) { fields.push('goal_met = ?'); values.push(patch.goal_met ? 1 : 0) }
    if (patch.goal_config_json !== undefined) { fields.push('goal_config_json = ?'); values.push(patch.goal_config_json) }
    if (patch.state_json !== undefined) { fields.push('state_json = ?'); values.push(patch.state_json) }
    if (fields.length === 0) return
    const resultingStatus = patch.status ?? current.status
    const terminal = [
      'waiting', 'paused', 'goal_met', 'timeout', 'error', 'cancelled', 'superseded'
    ].includes(resultingStatus)
    if (terminal) {
      fields.push('lease_owner = NULL', 'lease_expires_at = NULL')
    } else if (resultingStatus === 'running') {
      fields.push('lease_owner = ?', "lease_expires_at = datetime('now', ?)", 'heartbeat_at = CURRENT_TIMESTAMP')
      values.push(this.leaseOwner, `+${LEASE_SECONDS} seconds`)
    }
    fields.push('update_time = CURRENT_TIMESTAMP')
    values.push(current.id)
    this.run(`UPDATE workflow_runs SET ${fields.join(', ')} WHERE id = ?`, values)
  }

  setStatus(workId: number, status: GoalRoutineStatus): void {
    const desiredState = status === 'cancelled'
      ? 'cancelled'
      : status === 'paused' ? 'paused' : undefined
    this.update(workId, { status, ...(desiredState ? { desired_state: desiredState } : {}) })
  }

  /**
   * 续期当前执行器持有的运行租约。
   *
   * 长模型调用期间不能使用普通 update：普通 update 会无条件重写
   * lease_owner，旧执行器可能在租约已被接管后反向夺回运行。心跳必须以
   * 当前 lease_owner 为条件，续期失败时只代表该执行器已失去所有权。
   */
  heartbeat(workId: number, currentPhase?: string): boolean {
    const current = this.getByWork(workId)
    if (!current) return false
    const result = this.run(
      `UPDATE workflow_runs
       SET current_phase = COALESCE(?, current_phase),
           heartbeat_at = CURRENT_TIMESTAMP,
           lease_expires_at = datetime('now', ?),
           update_time = CURRENT_TIMESTAMP
       WHERE id = ?
         AND status = 'running'
         AND desired_state = 'running'
         AND lease_owner = ?`,
      [currentPhase ?? null, `+${LEASE_SECONDS} seconds`, current.id, this.leaseOwner]
    )
    return result.changes === 1
  }

  beginStep(input: BeginWorkflowStepInput): WorkflowStepRow {
    const run = this.ensure(input.workId)
    if (run.status !== 'running' || run.desired_state !== 'running') {
      throw new Error(`工作流运行 ${run.id} 当前状态为 ${run.status}，不能启动步骤`)
    }
    const inputHash = workflowInputHash(input.input)
    const protocolVersion = input.protocolVersion ?? 1
    const attemptNo = (super.get<{ attempt: number }>(
      `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt
       FROM workflow_step_instances
       WHERE run_id = ? AND step_key = ? AND scope_key = ? AND input_hash = ?`,
      [run.id, input.stepKey, input.scopeKey, inputHash]
    )?.attempt ?? 1)
    const id = this.insert(
      `INSERT INTO workflow_step_instances (
         run_id, step_key, scope_key, input_hash, protocol_version, attempt_no, status
       ) VALUES (?, ?, ?, ?, ?, ?, 'running')`,
      [run.id, input.stepKey, input.scopeKey, inputHash, protocolVersion, attemptNo]
    )
    this.update(input.workId, { current_phase: input.phaseKey ?? input.stepKey })
    return super.get<WorkflowStepRow>(
      'SELECT * FROM workflow_step_instances WHERE id = ?',
      [id]
    )!
  }

  completeStep(
    stepInstanceId: number,
    nextPhase: string,
    output?: unknown,
    disposition: 'completed' | 'needs_repair' = 'completed'
  ): void {
    this.transaction(() => {
      const step = super.get<WorkflowStepRow>(
        'SELECT * FROM workflow_step_instances WHERE id = ?',
        [stepInstanceId]
      )
      if (!step || step.status === 'completed') return
      let artifactId: number | null = null
      if (output !== undefined) {
        const contentHash = workflowInputHash(output)
        this.run(
          `INSERT OR IGNORE INTO workflow_artifacts (
             run_id, step_instance_id, artifact_kind, scope_key, content_hash, protocol_version, payload_json
           ) VALUES (?, ?, 'step_output', ?, ?, ?, ?)`,
          [
            step.run_id,
            step.id,
            step.scope_key,
            contentHash,
            step.protocol_version,
            JSON.stringify(output)
          ]
        )
        artifactId = super.get<{ id: number }>(
          `SELECT id FROM workflow_artifacts
           WHERE run_id = ? AND artifact_kind = 'step_output' AND scope_key = ?
             AND content_hash = ? AND protocol_version = ?`,
          [step.run_id, step.scope_key, contentHash, step.protocol_version]
        )?.id ?? null
      }
      this.run(
        `UPDATE workflow_step_instances
         SET status = ?, output_artifact_id = ?, finished_at = CURRENT_TIMESTAMP,
             update_time = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [disposition, artifactId, step.id]
      )
      this.run(
        `UPDATE workflow_runs
         SET current_phase = ?,
             heartbeat_at = CASE WHEN status = 'running' THEN CURRENT_TIMESTAMP ELSE heartbeat_at END,
             lease_expires_at = CASE WHEN status = 'running' THEN datetime('now', ?) ELSE NULL END,
             lease_owner = CASE WHEN status = 'running' THEN lease_owner ELSE NULL END,
             update_time = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [nextPhase, `+${LEASE_SECONDS} seconds`, step.run_id]
      )
    })
  }

  recordStepArtifact(
    stepInstanceId: number,
    artifactKind: string,
    payload: unknown
  ): number | null {
    return this.transaction(() => {
      const step = super.get<WorkflowStepRow>(
        'SELECT * FROM workflow_step_instances WHERE id = ?',
        [stepInstanceId]
      )
      if (!step) return null
      const serialized = JSON.stringify(payload)
      const payloadJson = serialized.length <= 200_000
        ? serialized
        : JSON.stringify({
            truncated: true,
            originalChars: serialized.length,
            preview: serialized.slice(0, 190_000)
          })
      const contentHash = workflowInputHash(payloadJson)
      this.run(
        `INSERT OR IGNORE INTO workflow_artifacts (
           run_id, step_instance_id, artifact_kind, scope_key, content_hash, protocol_version, payload_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          step.run_id,
          step.id,
          artifactKind.slice(0, 60),
          step.scope_key,
          contentHash,
          step.protocol_version,
          payloadJson
        ]
      )
      const artifactId = super.get<{ id: number }>(
        `SELECT id FROM workflow_artifacts
         WHERE run_id = ? AND artifact_kind = ? AND scope_key = ?
           AND content_hash = ? AND protocol_version = ?`,
        [step.run_id, artifactKind.slice(0, 60), step.scope_key, contentHash, step.protocol_version]
      )?.id ?? null
      if (artifactId != null) {
        this.run(
          `UPDATE workflow_step_instances
           SET output_artifact_id = ?, update_time = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [artifactId, step.id]
        )
      }
      return artifactId
    })
  }

  failStep(
    stepInstanceId: number,
    failure: { errorClass: string; errorCode: string; message: string; retryAt?: string }
  ): void {
    this.run(
      `UPDATE workflow_step_instances
       SET status = ?, error_class = ?, error_code = ?, error_message = ?, retry_at = ?,
           finished_at = CURRENT_TIMESTAMP, update_time = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        failure.retryAt ? 'waiting' : 'failed',
        failure.errorClass,
        failure.errorCode,
        failure.message,
        failure.retryAt ?? null,
        stepInstanceId
      ]
    )
  }

  getStepAttemptCount(step: Pick<WorkflowStepRow, 'run_id' | 'step_key' | 'scope_key' | 'input_hash'>): number {
    return super.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workflow_step_instances
       WHERE run_id = ? AND step_key = ? AND scope_key = ? AND input_hash = ?`,
      [step.run_id, step.step_key, step.scope_key, step.input_hash]
    )?.count ?? 0
  }

  getProtocolStepAttemptCount(
    step: Pick<WorkflowStepRow, 'run_id' | 'step_key' | 'scope_key' | 'input_hash' | 'protocol_version'>
  ): number {
    return super.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM workflow_step_instances
       WHERE run_id = ? AND step_key = ? AND scope_key = ? AND input_hash = ?
         AND protocol_version = ?`,
      [step.run_id, step.step_key, step.scope_key, step.input_hash, step.protocol_version]
    )?.count ?? 0
  }

  getConsecutiveStepFailureCount(
    step: Pick<WorkflowStepRow, 'run_id' | 'step_key' | 'scope_key' | 'input_hash' | 'protocol_version'>,
    errorClass: string,
    errorCode: string
  ): number {
    const recent = this.all<Pick<WorkflowStepRow, 'status' | 'error_class' | 'error_code'>>(
      `SELECT status, error_class, error_code
       FROM workflow_step_instances
       WHERE run_id = ? AND step_key = ? AND scope_key = ? AND input_hash = ?
         AND protocol_version = ?
       ORDER BY attempt_no DESC
       LIMIT 32`,
      [step.run_id, step.step_key, step.scope_key, step.input_hash, step.protocol_version]
    )
    let count = 0
    for (const failure of recent) {
      if (failure.status !== 'failed' && failure.status !== 'waiting') break
      if (failure.error_class !== errorClass || failure.error_code !== errorCode) break
      count++
    }
    return count
  }

  getConsecutiveScopedStepFailureCount(
    step: Pick<WorkflowStepRow, 'run_id' | 'step_key' | 'scope_key' | 'protocol_version'>,
    errorClass: string,
    errorCode: string
  ): number {
    const recent = this.all<Pick<WorkflowStepRow, 'status' | 'error_class' | 'error_code'>>(
      `SELECT status, error_class, error_code
       FROM workflow_step_instances
       WHERE run_id = ? AND step_key = ? AND scope_key = ? AND protocol_version = ?
       ORDER BY id DESC
       LIMIT 32`,
      [step.run_id, step.step_key, step.scope_key, step.protocol_version]
    )
    let count = 0
    for (const failure of recent) {
      if (failure.status !== 'failed' && failure.status !== 'waiting') break
      if (failure.error_class !== errorClass || failure.error_code !== errorCode) break
      count++
    }
    return count
  }

  getConsecutiveWorkflowFailureCount(
    step: Pick<WorkflowStepRow, 'run_id' | 'step_key' | 'scope_key' | 'input_hash' | 'protocol_version'>,
    errorClass: string,
    errorCode: string
  ): number {
    return Math.max(
      this.getConsecutiveStepFailureCount(step, errorClass, errorCode),
      this.getConsecutiveScopedStepFailureCount(step, errorClass, errorCode)
    )
  }

  markInterruptedForRecovery(): GoalRoutineStateRow[] {
    return this.transaction(() => {
      this.run(
        `UPDATE workflow_runs
         SET status = 'waiting', lease_owner = NULL, lease_expires_at = NULL,
             recovery_count = recovery_count + 1, update_time = CURRENT_TIMESTAMP
         WHERE status = 'paused' AND desired_state = 'running' AND goal_met = 0`
      )
      this.run(
        `UPDATE workflow_runs
         SET status = 'waiting', lease_owner = NULL, lease_expires_at = NULL,
             recovery_count = recovery_count + 1, update_time = CURRENT_TIMESTAMP
         WHERE status = 'error' AND desired_state = 'running' AND goal_met = 0
           AND current_phase = 'repair_execute'
           AND json_extract(state_json, '$.repairPlan') IS NOT NULL
           AND json_extract(state_json, '$.autonomousTerminal') IS NULL`
      )
      this.run(
        `UPDATE workflow_runs
         SET status = 'waiting',
             state_json = json_remove(state_json, '$.autonomousTerminal'),
             lease_owner = NULL, lease_expires_at = NULL,
             recovery_count = recovery_count + 1, update_time = CURRENT_TIMESTAMP
         WHERE status = 'error' AND desired_state = 'running' AND goal_met = 0
           AND current_phase = 'repair_execute'
           AND json_extract(state_json, '$.autonomousTerminal.code') = 'CausalOutcomeProtocolError'`
      )
      this.run(
        `UPDATE model_call_attempts
         SET status = 'failed', error_class = 'process_interrupted',
             error_code = 'PROCESS_INTERRUPTED', error_message = '主进程退出，模型调用结果未知',
             update_time = CURRENT_TIMESTAMP
         WHERE status = 'running'`
      )
      this.run(
        `UPDATE workflow_step_instances
         SET status = 'waiting', error_class = 'process_interrupted',
             error_code = 'PROCESS_INTERRUPTED', error_message = '主进程退出，等待持久化恢复',
             retry_at = CURRENT_TIMESTAMP, update_time = CURRENT_TIMESTAMP
         WHERE status = 'running'`
      )
      this.run(
        `UPDATE workflow_runs
         SET status = 'waiting', lease_owner = NULL, lease_expires_at = NULL,
             recovery_count = recovery_count + 1, update_time = CURRENT_TIMESTAMP
         WHERE status = 'running' AND desired_state = 'running'`
      )
      return this.listRecoverable()
    })
  }

  listRecoverable(): GoalRoutineStateRow[] {
    return this.all<Omit<GoalRoutineStateRow, 'run_id'>>(
      `SELECT * FROM workflow_runs
       WHERE status = 'waiting' AND desired_state = 'running' AND goal_met = 0
         AND id IN (SELECT MAX(id) FROM workflow_runs GROUP BY work_id)
       ORDER BY id`
    ).map(row => ({ ...row, run_id: row.id }))
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
    payload?: unknown
  }): number {
    const run = this.ensure(input.work_id)
    const id = this.insert(
      `INSERT INTO workflow_events (
         run_id, work_id, turn_no, phase, action, target_chapter_id,
         ai_percent_before, ai_percent_after, score, summary, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.id,
        input.work_id,
        input.turn_no,
        input.phase ?? null,
        input.action ?? null,
        input.target_chapter_id ?? null,
        input.ai_percent_before ?? null,
        input.ai_percent_after ?? null,
        input.score ?? null,
        input.summary ?? null,
        input.payload === undefined ? null : JSON.stringify(input.payload)
      ]
    )
    this.run(
      `INSERT INTO workflow_outbox (run_id, event_type, payload_json)
       VALUES (?, 'workflow_event', ?)`,
      [run.id, JSON.stringify({ eventId: id, workId: input.work_id })]
    )
    return id
  }

  listTurns(workId: number, limit = 50): GoalRoutineTurnRow[] {
    const run = this.getByWork(workId)
    if (!run) return []
    return this.all<GoalRoutineTurnRow>(
      'SELECT * FROM workflow_events WHERE run_id = ? ORDER BY id DESC LIMIT ?',
      [run.id, limit]
    )
  }

  listSteps(workId: number, limit = 20): WorkflowStepRow[] {
    const run = this.getByWork(workId)
    if (!run) return []
    return this.all<WorkflowStepRow>(
      `SELECT s.*,
              m.generation_step,
              m.model_type,
              m.model_name,
              m.duration_ms AS model_duration_ms,
              m.finish_reason AS model_finish_reason
       FROM workflow_step_instances s
       LEFT JOIN model_call_attempts m ON m.id = (
         SELECT MAX(latest.id)
         FROM model_call_attempts latest
         WHERE latest.step_instance_id = s.id
       )
       WHERE s.run_id = ?
       ORDER BY s.id DESC
       LIMIT ?`,
      [run.id, limit]
    )
  }

  listChapterIdsByAction(workId: number, action: string): number[] {
    const run = this.getByWork(workId)
    if (!run) return []
    return this.all<{ target_chapter_id: number }>(
      `SELECT DISTINCT target_chapter_id FROM workflow_events
       WHERE run_id = ? AND action = ? AND target_chapter_id IS NOT NULL`,
      [run.id, action]
    ).map(row => row.target_chapter_id)
  }

  listAll(): GoalRoutineStateRow[] {
    return this.all<Omit<GoalRoutineStateRow, 'run_id'>>(
      'SELECT * FROM workflow_runs ORDER BY update_time DESC'
    ).map(row => ({ ...row, run_id: row.id }))
  }
}

export const goalRoutineDAO = new GoalRoutineDAO()
