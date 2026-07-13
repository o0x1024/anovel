import { BaseDAO } from './base-dao'

export interface EmotionalStateLedgerRow {
  id: number
  work_id: number
  chapter_id: number
  character_name: string
  felt_state: string
  displayed_state: string
  unresolved_emotion: string
  protective_strategy: string
  behavioral_aftereffect: string
  beliefs_json: string | null
  relationships_json: string | null
  source_event: string
  create_time: string
}

export interface EmotionalStateLedgerInput {
  work_id: number
  chapter_id: number
  character_name: string
  felt_state: string
  displayed_state: string
  unresolved_emotion: string
  protective_strategy: string
  behavioral_aftereffect: string
  beliefs_json?: string
  relationships_json?: string
  source_event: string
}

class EmotionalStateDAO extends BaseDAO {
  listByWork(workId: number): EmotionalStateLedgerRow[] {
    return this.all<EmotionalStateLedgerRow>(
      'SELECT * FROM emotional_state_ledger WHERE work_id = ? ORDER BY chapter_id, id', [workId]
    )
  }

  listByChapter(chapterId: number): EmotionalStateLedgerRow[] {
    return this.all<EmotionalStateLedgerRow>(
      'SELECT * FROM emotional_state_ledger WHERE chapter_id = ? ORDER BY id', [chapterId]
    )
  }

  latestByCharacter(workId: number, characterName: string): EmotionalStateLedgerRow | undefined {
    return this.get<EmotionalStateLedgerRow>(
      `SELECT * FROM emotional_state_ledger WHERE work_id = ? AND character_name = ?
       ORDER BY chapter_id DESC, id DESC LIMIT 1`, [workId, characterName]
    )
  }

  latestForWork(workId: number, limit = 12): EmotionalStateLedgerRow[] {
    return this.all<EmotionalStateLedgerRow>(
      `SELECT e.* FROM emotional_state_ledger e
       JOIN (SELECT character_name, MAX(id) AS max_id FROM emotional_state_ledger
             WHERE work_id = ? GROUP BY character_name) latest ON latest.max_id = e.id
       ORDER BY e.id DESC LIMIT ?`, [workId, limit]
    )
  }

  replaceChapter(chapterId: number, rows: EmotionalStateLedgerInput[]): void {
    this.transaction(() => {
      this.run('DELETE FROM emotional_state_ledger WHERE chapter_id = ?', [chapterId])
      for (const row of rows) {
        this.insert(
          `INSERT INTO emotional_state_ledger (
            work_id, chapter_id, character_name, felt_state, displayed_state,
            unresolved_emotion, protective_strategy, behavioral_aftereffect,
            beliefs_json, relationships_json, source_event
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [row.work_id, row.chapter_id, row.character_name, row.felt_state,
            row.displayed_state, row.unresolved_emotion, row.protective_strategy,
            row.behavioral_aftereffect, row.beliefs_json ?? null,
            row.relationships_json ?? null, row.source_event]
        )
      }
    })
  }

  deleteByChapter(chapterId: number): number {
    return this.run('DELETE FROM emotional_state_ledger WHERE chapter_id = ?', [chapterId]).changes
  }
}

export const emotionalStateDAO = new EmotionalStateDAO()
