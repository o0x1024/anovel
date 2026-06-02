import { BaseDAO } from './base-dao'

export interface WritingStyleRow {
  id: number
  name: string
  description: string | null
  sample_text: string | null
  reference_text: string | null
  prompt_template: string
  fingerprint_json: string | null
  step_rules_json: string | null
  is_builtin: number
  create_time: string
  update_time: string
}

export interface StyleCreateInput {
  name: string
  description?: string | null
  sample_text?: string | null
  reference_text?: string | null
  prompt_template: string
  fingerprint_json?: string | null
  step_rules_json?: string | null
  is_builtin?: number
}

export class WritingStyleDAO extends BaseDAO {
  list(): WritingStyleRow[] {
    return this.all<WritingStyleRow>('SELECT * FROM writing_styles ORDER BY is_builtin DESC, name')
  }

  getById(id: number): WritingStyleRow | undefined {
    return this.get<WritingStyleRow>('SELECT * FROM writing_styles WHERE id = ?', [id])
  }

  getByName(name: string): WritingStyleRow | undefined {
    return this.get<WritingStyleRow>('SELECT * FROM writing_styles WHERE name = ?', [name])
  }

  create(input: StyleCreateInput): number {
    return this.insert(
      `INSERT INTO writing_styles (name, description, sample_text, reference_text, prompt_template, fingerprint_json, step_rules_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [input.name, input.description ?? null, input.sample_text ?? null,
       input.reference_text ?? null, input.prompt_template,
       input.fingerprint_json ?? null, input.step_rules_json ?? null]
    )
  }

  update(id: number, input: Partial<StyleCreateInput>): boolean {
    const fields: string[] = []
    const values: unknown[] = []
    if (input.name !== undefined) { fields.push('name = ?'); values.push(input.name) }
    if (input.description !== undefined) { fields.push('description = ?'); values.push(input.description) }
    if (input.sample_text !== undefined) { fields.push('sample_text = ?'); values.push(input.sample_text) }
    if (input.reference_text !== undefined) { fields.push('reference_text = ?'); values.push(input.reference_text) }
    if (input.prompt_template !== undefined) { fields.push('prompt_template = ?'); values.push(input.prompt_template) }
    if (input.fingerprint_json !== undefined) { fields.push('fingerprint_json = ?'); values.push(input.fingerprint_json) }
    if (input.step_rules_json !== undefined) { fields.push('step_rules_json = ?'); values.push(input.step_rules_json) }
    if (fields.length === 0) return false
    fields.push("update_time = datetime('now')")
    values.push(id)
    return this.run(`UPDATE writing_styles SET ${fields.join(', ')} WHERE id = ?`, values).changes > 0
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM writing_styles WHERE id = ? AND is_builtin = 0', [id]).changes > 0
  }

  // ==================== 作品-文风关联 ====================

  /** 绑定文风到作品 */
  bindToWork(workId: number, styleId: number, evolutionCurve?: string): void {
    this.run(
      `INSERT OR REPLACE INTO work_style_relation (work_id, style_id, evolution_curve_json) VALUES (?, ?, ?)`,
      [workId, styleId, evolutionCurve ?? null]
    )
  }

  /** 解绑作品文风 */
  unbindFromWork(workId: number, styleId: number): boolean {
    return this.run(
      'DELETE FROM work_style_relation WHERE work_id = ? AND style_id = ?',
      [workId, styleId]
    ).changes > 0
  }

  /** 获取作品绑定的所有文风 */
  getByWork(workId: number): (WritingStyleRow & { evolution_curve_json: string | null })[] {
    return this.all(
      `SELECT s.*, r.evolution_curve_json
       FROM writing_styles s
       JOIN work_style_relation r ON s.id = r.style_id
       WHERE r.work_id = ?
       ORDER BY s.name`,
      [workId]
    )
  }

  /** 设置作品唯一绑定文风（styleId 为 null 则解绑全部） */
  setWorkStyle(workId: number, styleId: number | null): void {
    const prev = this.getWorkStyleBinding(workId)
    const keepCurve =
      prev && styleId && prev.style_id === styleId ? prev.evolution_curve_json : null
    this.run('DELETE FROM work_style_relation WHERE work_id = ?', [workId])
    if (styleId) {
      this.bindToWork(workId, styleId, keepCurve ?? undefined)
    }
  }

  getWorkStyleBinding(workId: number): {
    style_id: number
    evolution_curve_json: string | null
  } | null {
    return this.get(
      'SELECT style_id, evolution_curve_json FROM work_style_relation WHERE work_id = ? LIMIT 1',
      [workId]
    ) ?? null
  }

  setWorkEvolutionCurve(workId: number, evolutionCurveJson: string | null): boolean {
    const binding = this.getWorkStyleBinding(workId)
    if (!binding) return false
    return this.run(
      'UPDATE work_style_relation SET evolution_curve_json = ? WHERE work_id = ? AND style_id = ?',
      [evolutionCurveJson, workId, binding.style_id]
    ).changes > 0
  }

  getWorkStyleId(workId: number): number | null {
    const row = this.get<{ style_id: number }>(
      'SELECT style_id FROM work_style_relation WHERE work_id = ? LIMIT 1',
      [workId]
    )
    return row?.style_id ?? null
  }
}

export const writingStyleDAO = new WritingStyleDAO()
