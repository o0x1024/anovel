import { BaseDAO } from './base-dao'

export type PromptRiskLevel = 'safe' | 'caution' | 'danger'
export type PromptCategory = 'body' | 'outline' | 'quality' | 'lab' | 'tool' | 'internal'

export interface PromptTemplateRow {
  id: number
  key: string
  category: PromptCategory
  label: string
  builtin_version: number
  builtin_text: string
  user_text: string | null
  description: string | null
  variables_json: string | null
  risk_level: PromptRiskLevel
  update_time: string | null
}

export interface PromptTemplateInfo {
  key: string
  category: PromptCategory
  label: string
  builtinVersion: number
  builtinText: string
  userText: string | null
  description: string | null
  variables: string[]
  riskLevel: PromptRiskLevel
  isCustomized: boolean
}

export class PromptTemplateDAO extends BaseDAO {
  private cache: Map<string, PromptTemplateRow> | null = null

  private ensureCache(): Map<string, PromptTemplateRow> {
    if (this.cache) return this.cache
    const rows = this.all<PromptTemplateRow>('SELECT * FROM prompt_templates')
    this.cache = new Map(rows.map(r => [r.key, r]))
    return this.cache
  }

  invalidateCache(): void {
    this.cache = null
  }

  resolve(key: string): string {
    const map = this.ensureCache()
    const row = map.get(key)
    if (!row) return ''
    return row.user_text?.trim() || row.builtin_text
  }

  getByKey(key: string): PromptTemplateRow | undefined {
    const map = this.ensureCache()
    return map.get(key)
  }

  list(): PromptTemplateInfo[] {
    const map = this.ensureCache()
    return [...map.values()].map(rowToInfo)
  }

  listByCategory(category: PromptCategory): PromptTemplateInfo[] {
    return this.list().filter(p => p.category === category)
  }

  setUserText(key: string, text: string | null): PromptTemplateInfo | null {
    const trimmed = text?.trim() || null
    this.run(
      `UPDATE prompt_templates SET user_text = ?, update_time = datetime('now') WHERE key = ?`,
      [trimmed, key]
    )
    this.invalidateCache()
    const row = this.getByKey(key)
    return row ? rowToInfo(row) : null
  }

  resetToDefault(key: string): PromptTemplateInfo | null {
    return this.setUserText(key, null)
  }

  resetAll(): void {
    this.run(`UPDATE prompt_templates SET user_text = NULL, update_time = datetime('now')`)
    this.invalidateCache()
  }

  /**
   * 注册或更新内置 prompt（幂等）。
   * 如果 key 不存在则插入；如果存在且 builtinVersion 更高则更新内置文本。
   */
  register(entry: {
    key: string
    category: PromptCategory
    label: string
    builtinVersion: number
    builtinText: string
    description?: string
    variables?: string[]
    riskLevel?: PromptRiskLevel
  }): void {
    const existing = this.get<PromptTemplateRow>(
      'SELECT * FROM prompt_templates WHERE key = ?', [entry.key]
    )
    const varsJson = entry.variables?.length ? JSON.stringify(entry.variables) : null

    if (!existing) {
      this.run(
        `INSERT INTO prompt_templates (key, category, label, builtin_version, builtin_text, description, variables_json, risk_level)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [entry.key, entry.category, entry.label, entry.builtinVersion,
         entry.builtinText, entry.description ?? null, varsJson, entry.riskLevel ?? 'safe']
      )
      this.invalidateCache()
      return
    }

    if (entry.builtinVersion > existing.builtin_version) {
      this.run(
        `UPDATE prompt_templates SET
           category = ?, label = ?, builtin_version = ?, builtin_text = ?,
           description = ?, variables_json = ?, risk_level = ?
         WHERE key = ?`,
        [entry.category, entry.label, entry.builtinVersion, entry.builtinText,
         entry.description ?? existing.description, varsJson ?? existing.variables_json,
         entry.riskLevel ?? existing.risk_level, entry.key]
      )
      this.invalidateCache()
    }
  }
}

function rowToInfo(row: PromptTemplateRow): PromptTemplateInfo {
  let variables: string[] = []
  if (row.variables_json) {
    try { variables = JSON.parse(row.variables_json) } catch { /* ignore */ }
  }
  return {
    key: row.key,
    category: row.category as PromptCategory,
    label: row.label,
    builtinVersion: row.builtin_version,
    builtinText: row.builtin_text,
    userText: row.user_text,
    description: row.description,
    variables,
    riskLevel: row.risk_level as PromptRiskLevel,
    isCustomized: !!row.user_text?.trim()
  }
}

export const promptTemplateDAO = new PromptTemplateDAO()
