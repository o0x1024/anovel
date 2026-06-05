import type { LabTaskCreateInput, LabTaskRow } from '../../../shared/lab-types'
import { normalizeBodyParagraphSpacing } from '../../../shared/normalize-body-text'
import { BaseDAO } from './base-dao'

const MAX_INPUT_CHARS = 50_000

function serializeAntiAiRules(rules: string[] | undefined): string | null {
  const cleaned = (rules ?? []).map(r => r.trim()).filter(Boolean)
  return cleaned.length ? JSON.stringify(cleaned) : null
}

export function parseLabAntiAiRulesJson(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
  } catch {
    return []
  }
}

export class LabTaskDAO extends BaseDAO {
  list(): LabTaskRow[] {
    return this.all<LabTaskRow>(
      `SELECT id, original_text, result_text, style_id, system_prompt, anti_ai_rules_json, status, error_message, source_file, char_count, create_time, update_time
       FROM lab_task WHERE style_id IS NOT NULL ORDER BY id DESC`
    )
  }

  getById(id: number): LabTaskRow | undefined {
    return this.get<LabTaskRow>(
      `SELECT id, original_text, result_text, style_id, system_prompt, anti_ai_rules_json, status, error_message, source_file, char_count, create_time, update_time
       FROM lab_task WHERE id = ?`,
      [id]
    )
  }

  create(input: LabTaskCreateInput): number {
    const original = normalizeBodyParagraphSpacing(input.originalText)
    if (!original) throw new Error('原文不能为空')
    if (original.length > MAX_INPUT_CHARS) throw new Error(`文本超过 ${MAX_INPUT_CHARS} 字符上限`)
    if (!input.styleId || input.styleId <= 0) throw new Error('请选择文风')
    const systemPrompt = input.systemPrompt.trim()
    if (!systemPrompt) throw new Error('System Prompt 不能为空')
    return this.insert(
      `INSERT INTO lab_task (
        original_text,
        style_id,
        system_prompt,
        anti_ai_rules_json,
        source_file,
        char_count,
        status,
        update_time
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`,
      [
        original,
        input.styleId,
        systemPrompt,
        serializeAntiAiRules(input.antiAiRules),
        input.sourceFile?.trim() || null,
        original.length
      ]
    )
  }

  setRunning(id: number): void {
    this.run(
      `UPDATE lab_task
       SET status = 'running', error_message = NULL, result_text = NULL, update_time = datetime('now')
       WHERE id = ?`,
      [id]
    )
  }

  setDone(id: number, resultText: string): void {
    this.run(
      `UPDATE lab_task
       SET status = 'done', result_text = ?, error_message = NULL, update_time = datetime('now')
       WHERE id = ?`,
      [resultText, id]
    )
  }

  setError(id: number, message: string): void {
    this.run(
      `UPDATE lab_task
       SET status = 'error', error_message = ?, update_time = datetime('now')
       WHERE id = ?`,
      [message.slice(0, 400), id]
    )
  }

  updateStreamingResult(id: number, partialResult: string): void {
    this.run(
      `UPDATE lab_task
       SET result_text = ?, update_time = datetime('now')
       WHERE id = ?`,
      [partialResult, id]
    )
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM lab_task WHERE id = ?', [id]).changes > 0
  }
}

export const labTaskDAO = new LabTaskDAO()
