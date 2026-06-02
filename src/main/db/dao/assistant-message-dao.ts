import type {
  AssistantMessageCreateInput,
  AssistantMessageRow,
  AssistantMessageType
} from '../../context/assistant/types'
import { BaseDAO } from './base-dao'

export class AssistantMessageDAO extends BaseDAO {
  listByConversation(conversationId: number): AssistantMessageRow[] {
    return this.all<AssistantMessageRow>(
      `SELECT * FROM assistant_messages
       WHERE conversation_id = ?
       ORDER BY create_time ASC, id ASC`,
      [conversationId]
    )
  }

  getById(id: number): AssistantMessageRow | undefined {
    return this.get<AssistantMessageRow>(
      'SELECT * FROM assistant_messages WHERE id = ?',
      [id]
    )
  }

  deleteFromId(conversationId: number, fromMessageId: number): void {
    this.run(
      `DELETE FROM assistant_messages WHERE conversation_id = ? AND id >= ?`,
      [conversationId, fromMessageId]
    )
  }

  create(input: AssistantMessageCreateInput): number {
    return this.insert(
      `INSERT INTO assistant_messages
       (conversation_id, role, content, message_type, metadata_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.conversation_id,
        input.role,
        input.content,
        input.message_type ?? 'text',
        input.metadata_json ?? null
      ]
    )
  }

  updateContent(
    id: number,
    content: string,
    metadataJson?: string | null,
    messageType?: AssistantMessageType
  ): boolean {
    if (messageType !== undefined && metadataJson !== undefined) {
      return this.run(
        `UPDATE assistant_messages SET content = ?, metadata_json = ?, message_type = ? WHERE id = ?`,
        [content, metadataJson, messageType, id]
      ).changes > 0
    }
    if (metadataJson !== undefined) {
      return this.run(
        `UPDATE assistant_messages SET content = ?, metadata_json = ? WHERE id = ?`,
        [content, metadataJson, id]
      ).changes > 0
    }
    return this.run(
      `UPDATE assistant_messages SET content = ? WHERE id = ?`,
      [content, id]
    ).changes > 0
  }

  deleteByConversation(conversationId: number): void {
    this.run('DELETE FROM assistant_messages WHERE conversation_id = ?', [conversationId])
  }
}

export const assistantMessageDAO = new AssistantMessageDAO()
