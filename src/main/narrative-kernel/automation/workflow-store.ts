import type Database from 'better-sqlite3'
import type {
  FrozenNarrativeModelContract,
  NarrativeModelRequest,
  NarrativeModelResponse,
  NarrativeModelTask
} from './model-contract'
import { assertNarrativeKernel } from '../errors'
import { canonicalHash, canonicalJson, sha256 } from '../hash'
import { ensureNarrativeEventStoreSchema } from '../storage/schema'

export type NarrativeWorkflowPhase =
  | 'generate_candidate'
  | 'extract_patch'
  | 'editorial_review'
  | 'revise_candidate'
  | 'commit_chapter'
  | 'completed'

export type NarrativeWorkflowStatus = 'running' | 'blocked' | 'cancelled' | 'completed'

export interface NarrativeWorkflowRun {
  id: string
  novelId: number
  intentId: string
  status: NarrativeWorkflowStatus
  desiredState: 'running' | 'cancelled'
  currentPhase: NarrativeWorkflowPhase
  candidateId?: string
  patchId?: string
  repairCount: number
  maxRepairs: number
  phaseAttempt: number
  maxStepAttempts: number
  editorialGateIndex: number
  editorialPolicyVersion: number
  modelContract: FrozenNarrativeModelContract
  leaseOwner?: string
  leaseExpiresAt?: number
  errorCode?: string
  errorMessage?: string
}

interface RunRow {
  id: string
  novel_id: number
  intent_id: string
  status: NarrativeWorkflowStatus
  desired_state: 'running' | 'cancelled'
  current_phase: NarrativeWorkflowPhase
  candidate_id: string | null
  patch_id: string | null
  repair_count: number
  max_repairs: number
  phase_attempt: number
  max_step_attempts: number
  editorial_gate_index: number
  editorial_policy_version: number
  model_contract_json: string
  model_contract_hash: string
  lease_owner: string | null
  lease_expires_at: number | null
  error_code: string | null
  error_message: string | null
}

interface ModelCallRow {
  task: NarrativeModelTask
  provider: string
  model: string
  contract_hash: string
  status: 'running' | 'completed' | 'failed'
  finish_reason: string | null
  content: string | null
  content_hash: string | null
  structured_output_json: string | null
  structured_output_hash: string | null
  prompt_tokens: number
  completion_tokens: number
  reasoning_length: number
  duration_ms: number
  error_code: string | null
  error_message: string | null
}

export interface StartWorkflowRunInput {
  id: string
  novelId: number
  intentId: string
  maxRepairs: number
  maxStepAttempts: number
  editorialPolicyVersion: number
  modelContract: FrozenNarrativeModelContract
}

export interface WorkflowStep {
  id: string
  runId: string
  stepKey: string
  inputHash: string
  attemptNo: number
  status: 'running' | 'succeeded' | 'failed'
}

function mapRun(row: RunRow): NarrativeWorkflowRun {
  const contract = JSON.parse(row.model_contract_json) as FrozenNarrativeModelContract
  assertNarrativeKernel(
    contract.contractHash === row.model_contract_hash &&
      canonicalHash({
        provider: contract.provider,
        providerProtocol: contract.providerProtocol,
        apiBase: contract.apiBase,
        model: contract.model,
        protocolVersion: contract.protocolVersion
      }) === row.model_contract_hash,
    'PIPELINE_ARTIFACT_HASH_MISMATCH',
    '持久化模型契约哈希不一致',
    { runId: row.id }
  )
  return {
    id: row.id,
    novelId: row.novel_id,
    intentId: row.intent_id,
    status: row.status,
    desiredState: row.desired_state,
    currentPhase: row.current_phase,
    ...(row.candidate_id ? { candidateId: row.candidate_id } : {}),
    ...(row.patch_id ? { patchId: row.patch_id } : {}),
    repairCount: row.repair_count,
    maxRepairs: row.max_repairs,
    phaseAttempt: row.phase_attempt,
    maxStepAttempts: row.max_step_attempts,
    editorialGateIndex: row.editorial_gate_index,
    editorialPolicyVersion: row.editorial_policy_version,
    modelContract: contract,
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at == null ? {} : { leaseExpiresAt: row.lease_expires_at }),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {})
  }
}

export class NarrativeWorkflowStore {
  constructor(private readonly db: Database.Database) {
    ensureNarrativeEventStoreSchema(db)
  }

  createRun(input: StartWorkflowRunInput): NarrativeWorkflowRun {
    assertNarrativeKernel(
      Number.isInteger(input.maxRepairs) && input.maxRepairs >= 0 &&
        Number.isInteger(input.maxStepAttempts) && input.maxStepAttempts > 0 &&
        Number.isInteger(input.editorialPolicyVersion) && input.editorialPolicyVersion > 0,
      'WORKFLOW_STATE_INVALID',
      '工作流预算和策略版本无效'
    )
    this.db.prepare(`
      INSERT INTO narrative_workflow_runs (
        id, novel_id, intent_id, status, desired_state, current_phase,
        max_repairs, max_step_attempts, editorial_policy_version,
        model_contract_json, model_contract_hash
      ) VALUES (?, ?, ?, 'running', 'running', 'generate_candidate', ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.novelId,
      input.intentId,
      input.maxRepairs,
      input.maxStepAttempts,
      input.editorialPolicyVersion,
      canonicalJson(input.modelContract),
      input.modelContract.contractHash
    )
    return this.loadRun(input.id)
  }

  loadRun(runId: string): NarrativeWorkflowRun {
    const row = this.db.prepare(`
      SELECT * FROM narrative_workflow_runs WHERE id = ?
    `).get(runId) as RunRow | undefined
    assertNarrativeKernel(
      row,
      'WORKFLOW_RUN_NOT_FOUND',
      `自动章节运行不存在：${runId}`,
      { runId }
    )
    return mapRun(row)
  }

  listRuns(novelId: number, limit = 20): NarrativeWorkflowRun[] {
    assertNarrativeKernel(
      Number.isInteger(novelId) && novelId > 0 && Number.isInteger(limit) && limit > 0,
      'WORKFLOW_STATE_INVALID',
      '小说运行查询参数无效',
      { novelId, limit }
    )
    const rows = this.db.prepare(`
      SELECT id, novel_id, intent_id, status, desired_state, current_phase,
             candidate_id, patch_id, repair_count, max_repairs, phase_attempt,
             max_step_attempts, editorial_gate_index, editorial_policy_version,
             model_contract_json, model_contract_hash, lease_owner, lease_expires_at,
             error_code, error_message
      FROM narrative_workflow_runs
      WHERE novel_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(novelId, limit) as RunRow[]
    return rows.map(mapRun)
  }

  saveRun(run: NarrativeWorkflowRun): void {
    const updated = this.db.prepare(`
      UPDATE narrative_workflow_runs
      SET status = ?, desired_state = ?, current_phase = ?,
          candidate_id = ?, patch_id = ?, repair_count = ?,
          phase_attempt = ?, editorial_gate_index = ?,
          error_code = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      run.status,
      run.desiredState,
      run.currentPhase,
      run.candidateId ?? null,
      run.patchId ?? null,
      run.repairCount,
      run.phaseAttempt,
      run.editorialGateIndex,
      run.errorCode ?? null,
      run.errorMessage ?? null,
      run.id
    )
    assertNarrativeKernel(
      updated.changes === 1,
      'WORKFLOW_RUN_NOT_FOUND',
      `无法更新自动章节运行：${run.id}`
    )
  }

  requestCancellation(runId: string): void {
    const updated = this.db.prepare(`
      UPDATE narrative_workflow_runs
      SET desired_state = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `).run(runId)
    assertNarrativeKernel(
      updated.changes === 1,
      'WORKFLOW_STATE_INVALID',
      '只能取消正在运行的自动章节任务',
      { runId }
    )
  }

  claimRun(runId: string, owner: string, nowMs: number, leaseMs: number): NarrativeWorkflowRun {
    const run = this.loadRun(runId)
    if (run.desiredState === 'cancelled' && run.status === 'running') {
      run.status = 'cancelled'
      this.saveRun(run)
      return run
    }
    assertNarrativeKernel(
      run.status === 'running',
      'WORKFLOW_STATE_INVALID',
      '只有 running 状态可以获取执行租约',
      { runId, status: run.status }
    )
    const updated = this.db.prepare(`
      UPDATE narrative_workflow_runs
      SET lease_owner = ?, lease_expires_at = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running' AND desired_state = 'running'
        AND (lease_owner IS NULL OR lease_expires_at < ? OR lease_owner = ?)
    `).run(owner, nowMs + leaseMs, runId, nowMs, owner)
    assertNarrativeKernel(
      updated.changes === 1,
      'WORKFLOW_LEASE_UNAVAILABLE',
      '自动章节运行已经被其他执行器占用',
      { runId, owner }
    )
    return this.loadRun(runId)
  }

  releaseRun(runId: string, owner: string): void {
    this.db.prepare(`
      UPDATE narrative_workflow_runs
      SET lease_owner = NULL, lease_expires_at = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND lease_owner = ?
    `).run(runId, owner)
  }

  beginStep(input: {
    runId: string
    stepKey: string
    inputHash: string
    attemptNo: number
  }): WorkflowStep {
    const id = `${input.runId}:${input.stepKey}:${input.attemptNo}:${input.inputHash.slice(0, 12)}`
    const existing = this.db.prepare(`
      SELECT status FROM narrative_workflow_steps WHERE id = ?
    `).get(id) as { status: WorkflowStep['status'] } | undefined
    if (existing) {
      assertNarrativeKernel(
        existing.status === 'running',
        'WORKFLOW_STATE_INVALID',
        '当前工作流状态与已结束步骤不一致',
        { stepId: id, status: existing.status }
      )
      return { id, ...input, status: existing.status }
    }
    this.db.prepare(`
      INSERT INTO narrative_workflow_steps (
        id, run_id, step_key, input_hash, attempt_no, status
      ) VALUES (?, ?, ?, ?, ?, 'running')
    `).run(id, input.runId, input.stepKey, input.inputHash, input.attemptNo)
    return { id, ...input, status: 'running' }
  }

  succeedStep(stepId: string, outputRef?: string): void {
    const updated = this.db.prepare(`
      UPDATE narrative_workflow_steps
      SET status = 'succeeded', output_ref = ?, finished_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `).run(outputRef ?? null, stepId)
    assertNarrativeKernel(
      updated.changes === 1,
      'WORKFLOW_STATE_INVALID',
      '只能完成 running 状态的工作流步骤',
      { stepId }
    )
  }

  failStep(stepId: string, code: string, message: string): void {
    const updated = this.db.prepare(`
      UPDATE narrative_workflow_steps
      SET status = 'failed', error_code = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'running'
    `).run(code, message, stepId)
    assertNarrativeKernel(
      updated.changes === 1,
      'WORKFLOW_STATE_INVALID',
      '只能失败 running 状态的工作流步骤',
      { stepId }
    )
  }

  loadCompletedModelCall(
    requestId: string,
    expectedTask: NarrativeModelTask,
    expectedContract: FrozenNarrativeModelContract
  ): NarrativeModelResponse | undefined {
    const row = this.db.prepare(`
      SELECT task, provider, model, contract_hash,
             status, finish_reason, content, content_hash,
             structured_output_json, structured_output_hash,
             prompt_tokens, completion_tokens, reasoning_length, duration_ms,
             error_code, error_message
      FROM narrative_model_calls
      WHERE request_id = ?
    `).get(requestId) as ModelCallRow | undefined
    if (!row) return undefined
    assertNarrativeKernel(
      row.task === expectedTask &&
        row.provider === expectedContract.provider &&
        row.model === expectedContract.model &&
        row.contract_hash === expectedContract.contractHash,
      'PIPELINE_ARTIFACT_HASH_MISMATCH',
      '持久化模型调用与冻结执行契约不一致',
      {
        requestId,
        expectedTask,
        actualTask: row.task,
        expectedContractHash: expectedContract.contractHash,
        actualContractHash: row.contract_hash
      }
    )
    assertNarrativeKernel(
      row.status !== 'running',
      'MODEL_CALL_OUTCOME_UNKNOWN',
      '模型调用已发出但结果未知，禁止自动重复请求',
      { requestId }
    )
    if (row.content != null) {
      assertNarrativeKernel(
        sha256(row.content) === row.content_hash,
        'PIPELINE_ARTIFACT_HASH_MISMATCH',
        '持久化模型正文响应哈希不一致',
        { requestId }
      )
    }
    if (row.structured_output_json != null) {
      assertNarrativeKernel(
        sha256(row.structured_output_json) === row.structured_output_hash,
        'PIPELINE_ARTIFACT_HASH_MISMATCH',
        '持久化模型结构化响应哈希不一致',
        { requestId }
      )
    }
    return {
      status: row.status === 'completed' ? 'completed' : 'failed',
      ...(row.finish_reason ? { finishReason: row.finish_reason } : {}),
      ...(row.content == null ? {} : { content: row.content }),
      ...(row.structured_output_json == null
        ? {}
        : { structuredOutput: JSON.parse(row.structured_output_json) }),
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      reasoningLength: row.reasoning_length,
      durationMs: row.duration_ms,
      ...(row.error_code ? { errorCode: row.error_code } : {}),
      ...(row.error_message ? { errorMessage: row.error_message } : {})
    }
  }

  beginModelCall(
    runId: string,
    stepId: string,
    request: NarrativeModelRequest
  ): void {
    this.db.prepare(`
      INSERT INTO narrative_model_calls (
        id, request_id, run_id, step_id, task, provider,
        model, contract_hash, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
    `).run(
      request.requestId,
      request.requestId,
      runId,
      stepId,
      request.task,
      request.contract.provider,
      request.contract.model,
      request.contract.contractHash
    )
  }

  finishModelCall(requestId: string, response: NarrativeModelResponse): void {
    assertNarrativeKernel(
      (response.status === 'completed' || response.status === 'failed') &&
        Number.isInteger(response.promptTokens) && response.promptTokens >= 0 &&
        Number.isInteger(response.completionTokens) && response.completionTokens >= 0 &&
        Number.isInteger(response.reasoningLength) && response.reasoningLength >= 0 &&
        Number.isInteger(response.durationMs) && response.durationMs >= 0,
      'MODEL_CALL_FAILED',
      '模型响应状态或计量字段无效',
      { requestId }
    )
    const structuredOutputJson = response.structuredOutput == null
      ? null
      : canonicalJson(response.structuredOutput)
    const updated = this.db.prepare(`
      UPDATE narrative_model_calls
      SET status = ?, finish_reason = ?, content = ?, content_hash = ?,
          structured_output_json = ?, structured_output_hash = ?,
          prompt_tokens = ?, completion_tokens = ?,
          reasoning_length = ?, duration_ms = ?, error_code = ?, error_message = ?,
          finished_at = CURRENT_TIMESTAMP
      WHERE request_id = ? AND status = 'running'
    `).run(
      response.status,
      response.finishReason ?? null,
      response.content ?? null,
      response.content == null ? null : sha256(response.content),
      structuredOutputJson,
      structuredOutputJson == null ? null : sha256(structuredOutputJson),
      response.promptTokens,
      response.completionTokens,
      response.reasoningLength,
      response.durationMs,
      response.errorCode ?? null,
      response.errorMessage ?? null,
      requestId
    )
    assertNarrativeKernel(
      updated.changes === 1,
      'MODEL_CALL_OUTCOME_UNKNOWN',
      '模型调用结果不能重复完成',
      { requestId }
    )
  }

  countModelCalls(runId: string, task?: NarrativeModelTask): number {
    const row = task
      ? this.db.prepare(`
          SELECT COUNT(*) AS count FROM narrative_model_calls WHERE run_id = ? AND task = ?
        `).get(runId, task)
      : this.db.prepare(`
          SELECT COUNT(*) AS count FROM narrative_model_calls WHERE run_id = ?
        `).get(runId)
    return (row as { count: number }).count
  }
}
