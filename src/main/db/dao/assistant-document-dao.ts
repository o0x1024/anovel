import { extractStyleFingerprint } from '../../context/style-fingerprint'
import type { AssistantDocumentCreateInput, AssistantDocumentRow } from '../../context/assistant/types'
import { BaseDAO } from './base-dao'

const MAX_CONTENT_CHARS = 2_000_000

export class AssistantDocumentDAO extends BaseDAO {
  list(): AssistantDocumentRow[] {
    return this.all<AssistantDocumentRow>(
      'SELECT * FROM assistant_documents ORDER BY create_time DESC'
    )
  }

  getById(id: number): AssistantDocumentRow | undefined {
    return this.get<AssistantDocumentRow>(
      'SELECT * FROM assistant_documents WHERE id = ?',
      [id]
    )
  }

  create(input: AssistantDocumentCreateInput): number {
    const content = input.content_text.trim()
    if (!content) throw new Error('文档内容不能为空')
    if (content.length > MAX_CONTENT_CHARS) {
      throw new Error(`文档超过 ${MAX_CONTENT_CHARS} 字符上限`)
    }
    const fp = extractStyleFingerprint(content)
    return this.insert(
      `INSERT INTO assistant_documents
       (title, file_name, content_text, char_count, fingerprint_json)
       VALUES (?, ?, ?, ?, ?)`,
      [
        input.title.trim() || '未命名文档',
        input.file_name ?? null,
        content,
        content.length,
        JSON.stringify(fp)
      ]
    )
  }

  update(id: number, input: AssistantDocumentCreateInput): boolean {
    const content = input.content_text.trim()
    if (!content) throw new Error('文档内容不能为空')
    if (content.length > MAX_CONTENT_CHARS) {
      throw new Error(`文档超过 ${MAX_CONTENT_CHARS} 字符上限`)
    }
    const fp = extractStyleFingerprint(content)
    return this.run(
      `UPDATE assistant_documents
       SET title = ?, file_name = ?, content_text = ?, char_count = ?, fingerprint_json = ?
       WHERE id = ?`,
      [
        input.title.trim() || '未命名文档',
        input.file_name ?? null,
        content,
        content.length,
        JSON.stringify(fp),
        id
      ]
    ).changes > 0
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM assistant_documents WHERE id = ?', [id]).changes > 0
  }
}

export const assistantDocumentDAO = new AssistantDocumentDAO()
