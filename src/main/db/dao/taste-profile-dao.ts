import { BaseDAO } from './base-dao'

export interface TasteProfileRow {
  id: number
  profile_name: string
  style_preferences: string | null
  character_preferences: string | null
  plot_preferences: string | null
  pacing_preferences: string | null
  reject_patterns: string | null
  choice_history_summary: string | null
  is_default: number
  extracted_from_work_id: number | null
  create_time: string
  update_time: string
}

export interface RejectPattern {
  reason: string
  label: string
  count: number
}

export class TasteProfileDAO extends BaseDAO {
  list(): TasteProfileRow[] {
    return this.all<TasteProfileRow>('SELECT * FROM taste_profile ORDER BY is_default DESC, update_time DESC')
  }

  getById(id: number): TasteProfileRow | undefined {
    return this.get<TasteProfileRow>('SELECT * FROM taste_profile WHERE id = ?', [id])
  }

  getDefault(): TasteProfileRow | undefined {
    return this.get<TasteProfileRow>(
      'SELECT * FROM taste_profile WHERE is_default = 1 ORDER BY update_time DESC LIMIT 1'
    )
  }

  getByWork(workId: number): TasteProfileRow | undefined {
    return this.get<TasteProfileRow>(
      `SELECT p.* FROM taste_profile p
       JOIN work_taste_relation r ON p.id = r.profile_id
       WHERE r.work_id = ? LIMIT 1`,
      [workId]
    )
  }

  create(input: {
    profile_name: string
    style_preferences?: string
    character_preferences?: string
    plot_preferences?: string
    pacing_preferences?: string
    reject_patterns?: string
    choice_history_summary?: string
    is_default?: boolean
    extracted_from_work_id?: number
  }): number {
    if (input.is_default) {
      this.run('UPDATE taste_profile SET is_default = 0')
    }
    return this.insert(
      `INSERT INTO taste_profile
       (profile_name, style_preferences, character_preferences, plot_preferences, pacing_preferences,
        reject_patterns, choice_history_summary, is_default, extracted_from_work_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.profile_name,
        input.style_preferences ?? null,
        input.character_preferences ?? null,
        input.plot_preferences ?? null,
        input.pacing_preferences ?? null,
        input.reject_patterns ?? null,
        input.choice_history_summary ?? null,
        input.is_default ? 1 : 0,
        input.extracted_from_work_id ?? null
      ]
    )
  }

  update(id: number, fields: Partial<Omit<TasteProfileRow, 'id' | 'create_time'>>): boolean {
    if (fields.is_default === 1) {
      this.run('UPDATE taste_profile SET is_default = 0')
    }
    const sets: string[] = []
    const vals: unknown[] = []
    const map: [keyof TasteProfileRow, string][] = [
      ['profile_name', 'profile_name'],
      ['style_preferences', 'style_preferences'],
      ['character_preferences', 'character_preferences'],
      ['plot_preferences', 'plot_preferences'],
      ['pacing_preferences', 'pacing_preferences'],
      ['reject_patterns', 'reject_patterns'],
      ['choice_history_summary', 'choice_history_summary'],
      ['is_default', 'is_default'],
      ['extracted_from_work_id', 'extracted_from_work_id']
    ]
    for (const [key, col] of map) {
      if (fields[key] !== undefined) {
        sets.push(`${col} = ?`)
        vals.push(fields[key])
      }
    }
    if (sets.length === 0) return false
    sets.push("update_time = datetime('now')")
    vals.push(id)
    return this.run(`UPDATE taste_profile SET ${sets.join(', ')} WHERE id = ?`, vals).changes > 0
  }

  delete(id: number): boolean {
    this.run('DELETE FROM work_taste_relation WHERE profile_id = ?', [id])
    return this.run('DELETE FROM taste_profile WHERE id = ?', [id]).changes > 0
  }

  bindToWork(workId: number, profileId: number): void {
    this.run('DELETE FROM work_taste_relation WHERE work_id = ?', [workId])
    this.run(
      'INSERT OR REPLACE INTO work_taste_relation (work_id, profile_id) VALUES (?, ?)',
      [workId, profileId]
    )
  }

  recordReject(profileId: number, reason: string, label: string): void {
    const profile = this.getById(profileId)
    if (!profile) return
    const patterns = parseJson<RejectPattern[]>(profile.reject_patterns, [])
    const existing = patterns.find(p => p.reason === reason)
    if (existing) existing.count += 1
    else patterns.push({ reason, label, count: 1 })
    patterns.sort((a, b) => b.count - a.count)
    this.update(profileId, { reject_patterns: JSON.stringify(patterns) })
  }

  recordChoice(profileId: number, choiceType: string, detail: string): void {
    const profile = this.getById(profileId)
    if (!profile) return
    const history = parseJson<{ type: string; detail: string; count: number }[]>(
      profile.choice_history_summary,
      []
    )
    const key = `${choiceType}:${detail.slice(0, 50)}`
    const existing = history.find(h => `${h.type}:${h.detail.slice(0, 50)}` === key)
    if (existing) existing.count += 1
    else history.push({ type: choiceType, detail: detail.slice(0, 200), count: 1 })
    this.update(profileId, { choice_history_summary: JSON.stringify(history.slice(0, 50)) })
  }
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw?.trim()) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export const tasteProfileDAO = new TasteProfileDAO()
