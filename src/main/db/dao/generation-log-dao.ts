import { BaseDAO } from './base-dao'

export interface GenerationLogRow {
  id: number
  work_id: number
  step: string
  model_type: string
  style_id: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  ai_self_score: number | null
  author_action: string | null
  reject_reason: string | null
  duration_ms: number | null
  create_time: string
}

export class GenerationLogDAO extends BaseDAO {
  /** 记录生成 */
  log(input: {
    work_id: number
    step: string
    model_type: string
    style_id?: number
    prompt_tokens?: number
    completion_tokens?: number
    ai_self_score?: number
    author_action?: string
    reject_reason?: string
    duration_ms?: number
  }): number {
    return this.insert(
      `INSERT INTO generation_log (work_id, step, model_type, style_id, prompt_tokens, completion_tokens,
        ai_self_score, author_action, reject_reason, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.work_id, input.step, input.model_type, input.style_id ?? null,
        input.prompt_tokens ?? null, input.completion_tokens ?? null,
        input.ai_self_score ?? null, input.author_action ?? null,
        input.reject_reason ?? null, input.duration_ms ?? null]
    )
  }

  /** 获取作品的全部生成记录 */
  listByWork(workId: number, limit = 50): GenerationLogRow[] {
    return this.all<GenerationLogRow>(
      'SELECT * FROM generation_log WHERE work_id = ? ORDER BY create_time DESC LIMIT ?',
      [workId, limit]
    )
  }

  /** 统计作品 Token 消耗 */
  getTokenUsage(workId: number): { total_prompt: number; total_completion: number } {
    const row = this.get<{ total_prompt: number; total_completion: number }>(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS total_prompt,
              COALESCE(SUM(completion_tokens), 0) AS total_completion
       FROM generation_log WHERE work_id = ?`,
      [workId]
    )
    return row ?? { total_prompt: 0, total_completion: 0 }
  }

  /** 统计各模型调用次数 */
  getModelCallCount(workId: number): { model_type: string; count: number }[] {
    return this.all(
      `SELECT model_type, COUNT(*) AS count
       FROM generation_log WHERE work_id = ?
       GROUP BY model_type ORDER BY count DESC`,
      [workId]
    )
  }
}

export const generationLogDAO = new GenerationLogDAO()
