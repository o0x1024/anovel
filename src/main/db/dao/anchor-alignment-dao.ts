import { BaseDAO } from './base-dao'

export interface AnchorAlignmentRow {
  id: number
  anchor_id: number
  chapter_id: number | null
  step: string
  aligned: 0 | 1 | 2
  detail: string | null
  check_time: string
}

export class AnchorAlignmentDAO extends BaseDAO {
  listByAnchor(anchorId: number): AnchorAlignmentRow[] {
    return this.all<AnchorAlignmentRow>(
      'SELECT * FROM anchor_alignment_log WHERE anchor_id = ? ORDER BY check_time DESC',
      [anchorId]
    )
  }

  listByChapter(chapterId: number): AnchorAlignmentRow[] {
    return this.all<AnchorAlignmentRow>(
      'SELECT * FROM anchor_alignment_log WHERE chapter_id = ? ORDER BY check_time DESC',
      [chapterId]
    )
  }

  log(input: {
    anchor_id: number
    chapter_id?: number
    step: string
    aligned: 0 | 1 | 2
    detail?: string
  }): number {
    return this.insert(
      'INSERT INTO anchor_alignment_log (anchor_id, chapter_id, step, aligned, detail) VALUES (?, ?, ?, ?, ?)',
      [input.anchor_id, input.chapter_id ?? null, input.step, input.aligned, input.detail ?? null]
    )
  }

  /** 获取某作品最近一次各锚点的对齐状态摘要 */
  latestByWork(workId: number): AnchorAlignmentRow[] {
    return this.all<AnchorAlignmentRow>(
      `SELECT aal.* FROM anchor_alignment_log aal
       INNER JOIN anchors a ON aal.anchor_id = a.id
       WHERE a.work_id = ?
       AND aal.id = (
         SELECT MAX(id) FROM anchor_alignment_log WHERE anchor_id = aal.anchor_id
       )
       ORDER BY aal.anchor_id`,
      [workId]
    )
  }
}

export const anchorAlignmentDAO = new AnchorAlignmentDAO()
