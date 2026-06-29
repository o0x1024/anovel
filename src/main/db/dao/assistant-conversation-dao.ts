import type {
  AssistantConversationCreateInput,
  AssistantConversationRow
} from '../../context/assistant/types'
import { BaseDAO } from './base-dao'

export class AssistantConversationDAO extends BaseDAO {
  list(): AssistantConversationRow[] {
    return this.all<AssistantConversationRow>(
      'SELECT * FROM assistant_conversations ORDER BY update_time DESC, id DESC'
    )
  }

  getById(id: number): AssistantConversationRow | undefined {
    return this.get<AssistantConversationRow>(
      'SELECT * FROM assistant_conversations WHERE id = ?',
      [id]
    )
  }

  listByWorkAndSetting(workId: number, settingType: string): AssistantConversationRow[] {
    return this.all<AssistantConversationRow>(
      `SELECT * FROM assistant_conversations
       WHERE work_id = ? AND setting_type = ?
       ORDER BY update_time DESC, id DESC`,
      [workId, settingType]
    )
  }

  create(input: AssistantConversationCreateInput): number {
    const documentIdsJson = input.document_ids?.length
      ? JSON.stringify(input.document_ids)
      : null
    return this.insert(
      `INSERT INTO assistant_conversations (role_id, work_id, setting_type, title, document_ids_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.role_id,
        input.work_id ?? null,
        input.setting_type ?? null,
        input.title?.trim() || '新对话',
        documentIdsJson
      ]
    )
  }

  updateTitle(id: number, title: string): boolean {
    return this.run(
      `UPDATE assistant_conversations SET title = ?, update_time = datetime('now') WHERE id = ?`,
      [title.trim() || '新对话', id]
    ).changes > 0
  }

  updateRole(id: number, roleId: number | null): boolean {
    return this.run(
      `UPDATE assistant_conversations SET role_id = ?, update_time = datetime('now') WHERE id = ?`,
      [roleId, id]
    ).changes > 0
  }

  updateModel(id: number, modelType: string | null, modelName: string | null): boolean {
    return this.run(
      `UPDATE assistant_conversations SET model_type = ?, model_name = ?, update_time = datetime('now') WHERE id = ?`,
      [modelType, modelName, id]
    ).changes > 0
  }

  touch(id: number): void {
    this.run(
      `UPDATE assistant_conversations SET update_time = datetime('now') WHERE id = ?`,
      [id]
    )
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM assistant_conversations WHERE id = ?', [id]).changes > 0
  }
}

export const assistantConversationDAO = new AssistantConversationDAO()
