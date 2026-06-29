import { BaseDAO } from './base-dao'
import type { AssistantRoleCreateInput, AssistantRoleRow } from '../../context/assistant/types'

export class AssistantRoleDAO extends BaseDAO {
  list(): AssistantRoleRow[] {
    return this.all<AssistantRoleRow>(
      'SELECT * FROM assistant_roles ORDER BY is_builtin DESC, name'
    )
  }

  getById(id: number): AssistantRoleRow | undefined {
    return this.get<AssistantRoleRow>('SELECT * FROM assistant_roles WHERE id = ?', [id])
  }

  getByName(name: string): AssistantRoleRow | undefined {
    return this.get<AssistantRoleRow>('SELECT * FROM assistant_roles WHERE name = ?', [name])
  }

  create(input: AssistantRoleCreateInput): number {
    return this.insert(
      `INSERT INTO assistant_roles
       (name, description, icon, system_prompt, analysis_rules_json, capabilities_json, is_builtin)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.description ?? null,
        input.icon ?? 'robot',
        input.system_prompt,
        input.analysis_rules_json ?? null,
        input.capabilities_json ?? null,
        input.is_builtin ?? 0
      ]
    )
  }

  update(id: number, input: Partial<AssistantRoleCreateInput>): boolean {
    const row = this.getById(id)
    if (!row) return false
    const fields: string[] = []
    const values: unknown[] = []
    if (input.name !== undefined) { fields.push('name = ?'); values.push(input.name) }
    if (input.description !== undefined) { fields.push('description = ?'); values.push(input.description) }
    if (input.icon !== undefined) { fields.push('icon = ?'); values.push(input.icon) }
    if (input.system_prompt !== undefined) { fields.push('system_prompt = ?'); values.push(input.system_prompt) }
    if (input.analysis_rules_json !== undefined) {
      fields.push('analysis_rules_json = ?'); values.push(input.analysis_rules_json)
    }
    if (input.capabilities_json !== undefined) {
      fields.push('capabilities_json = ?'); values.push(input.capabilities_json)
    }
    if (input.is_builtin !== undefined && !row.is_builtin) {
      fields.push('is_builtin = ?'); values.push(input.is_builtin)
    }
    if (fields.length === 0) return false
    fields.push("update_time = datetime('now')")
    values.push(id)
    return this.run(`UPDATE assistant_roles SET ${fields.join(', ')} WHERE id = ?`, values).changes > 0
  }

  delete(id: number): boolean {
    const row = this.getById(id)
    if (!row || row.is_builtin) return false
    return this.run('DELETE FROM assistant_roles WHERE id = ?', [id]).changes > 0
  }

  clone(id: number, newName: string): number | null {
    const row = this.getById(id)
    if (!row) return null
    return this.create({
      name: newName,
      description: row.description ?? undefined,
      icon: row.icon,
      system_prompt: row.system_prompt,
      analysis_rules_json: row.analysis_rules_json,
      capabilities_json: row.capabilities_json,
      is_builtin: 0
    })
  }
}

export const assistantRoleDAO = new AssistantRoleDAO()
