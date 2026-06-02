import { BaseDAO } from './base-dao'

export interface StyleDeviationRow {
  id: number
  chapter_id: number
  style_id: number
  deviation_score: number | null
  deviation_details: string | null
  check_time: string
}

export class StyleDeviationDAO extends BaseDAO {
  listByChapter(chapterId: number): StyleDeviationRow[] {
    return this.all<StyleDeviationRow>(
      'SELECT * FROM style_deviation_log WHERE chapter_id = ? ORDER BY check_time DESC',
      [chapterId]
    )
  }

  listByWork(workId: number): StyleDeviationRow[] {
    return this.all<StyleDeviationRow>(
      `SELECT sdl.* FROM style_deviation_log sdl
       JOIN chapters c ON sdl.chapter_id = c.id
       JOIN volumes v ON c.volume_id = v.id
       WHERE v.work_id = ?
       ORDER BY sdl.check_time DESC`,
      [workId]
    )
  }

  log(input: {
    chapter_id: number
    style_id: number
    deviation_score: number
    deviation_details: string
  }): number {
    return this.insert(
      'INSERT INTO style_deviation_log (chapter_id, style_id, deviation_score, deviation_details) VALUES (?, ?, ?, ?)',
      [input.chapter_id, input.style_id, input.deviation_score, input.deviation_details]
    )
  }
}

export const styleDeviationDAO = new StyleDeviationDAO()
