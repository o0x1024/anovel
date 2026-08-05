import { BaseDAO } from './base-dao'

export interface ModelCallAttemptInput {
  requestId: string
  runId?: number
  stepInstanceId?: number
  workId?: number
  generationStep?: string
  modelType?: string
  modelName?: string
}

export interface ModelCallAttemptFinish {
  status: 'success' | 'failed' | 'cancelled'
  errorClass?: string
  errorCode?: string
  errorMessage?: string
  promptTokens?: number
  completionTokens?: number
  durationMs?: number
  finishReason?: string
}

export class ModelCallAttemptDAO extends BaseDAO {
  start(input: ModelCallAttemptInput): void {
    this.run(
      `INSERT INTO model_call_attempts (
         request_id, run_id, step_instance_id, work_id, generation_step,
         model_type, model_name, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
      [
        input.requestId,
        input.runId ?? null,
        input.stepInstanceId ?? null,
        input.workId ?? null,
        input.generationStep ?? null,
        input.modelType ?? null,
        input.modelName ?? null
      ]
    )
  }

  finish(requestId: string, input: ModelCallAttemptFinish): void {
    this.run(
      `UPDATE model_call_attempts
       SET status = ?, error_class = ?, error_code = ?, error_message = ?,
           prompt_tokens = ?, completion_tokens = ?, duration_ms = ?,
           finish_reason = ?, update_time = CURRENT_TIMESTAMP
       WHERE request_id = ?`,
      [
        input.status,
        input.errorClass ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.promptTokens ?? 0,
        input.completionTokens ?? 0,
        input.durationMs ?? 0,
        input.finishReason ?? null,
        requestId
      ]
    )
  }
}

export const modelCallAttemptDAO = new ModelCallAttemptDAO()
