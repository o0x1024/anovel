import { BaseDAO } from './base-dao'
import { parseAvailableModelsJson } from '../../context/model-catalog'

export interface ModelConfigRow {
  id: number
  model_type: string
  model_name: string | null
  api_key: string | null
  api_base: string | null
  is_enabled: number
  priority: number
  max_context_tokens: number | null
  available_models_json: string | null
}

export class ModelConfigDAO extends BaseDAO {
  list(): ModelConfigRow[] {
    return this.all<ModelConfigRow>('SELECT * FROM model_configs ORDER BY priority')
  }

  /** 获取优先级最高的已启用模型 */
  getPrimary(): ModelConfigRow | undefined {
    return this.get<ModelConfigRow>(
      'SELECT * FROM model_configs WHERE is_enabled = 1 ORDER BY priority LIMIT 1'
    )
  }

  getByType(modelType: string): ModelConfigRow | undefined {
    return this.get<ModelConfigRow>('SELECT * FROM model_configs WHERE model_type = ?', [modelType])
  }

  upsert(modelType: string, apiKey: string, apiBase?: string, modelName?: string): void {
    this.run(
      `INSERT INTO model_configs (model_type, api_key, api_base, model_name) VALUES (?, ?, ?, ?)
       ON CONFLICT(model_type) DO UPDATE SET
         api_key = excluded.api_key,
         api_base = excluded.api_base,
         model_name = excluded.model_name`,
      [modelType, apiKey, apiBase ?? null, modelName ?? null]
    )
  }

  /** 设置模型启用状态 */
  setEnabled(modelType: string, enabled: boolean): boolean {
    return this.run('UPDATE model_configs SET is_enabled = ? WHERE model_type = ?', [enabled ? 1 : 0, modelType]).changes > 0
  }

  /** 设置模型优先级 */
  setPriority(modelType: string, priority: number): boolean {
    return this.run('UPDATE model_configs SET priority = ? WHERE model_type = ?', [priority, modelType]).changes > 0
  }

  delete(modelType: string): boolean {
    return this.run('DELETE FROM model_configs WHERE model_type = ?', [modelType]).changes > 0
  }

  setMaxContextTokens(modelType: string, tokens: number): boolean {
    return this.run(
      'UPDATE model_configs SET max_context_tokens = ? WHERE model_type = ?',
      [Math.max(1024, Math.floor(tokens)), modelType]
    ).changes > 0
  }

  getAvailableModels(modelType: string): string[] {
    const row = this.getByType(modelType)
    return parseAvailableModelsJson(row?.available_models_json)
  }

  setAvailableModels(modelType: string, models: string[]): boolean {
    const unique = [...new Set(models.map(m => m.trim()).filter(Boolean))]
    return this.run(
      'UPDATE model_configs SET available_models_json = ? WHERE model_type = ?',
      [JSON.stringify(unique), modelType]
    ).changes > 0
  }
}

export const modelConfigDAO = new ModelConfigDAO()
