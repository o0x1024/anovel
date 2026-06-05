import { BaseDAO } from '../base-dao'

export interface IncubatorSeedRow {
  id: number
  work_id: number
  content: string
  create_time: string
  update_time: string
}

export class IncubatorSeedDAO extends BaseDAO {
  getByWork(workId: number): IncubatorSeedRow | undefined {
    return this.get<IncubatorSeedRow>(
      'SELECT * FROM incubator_seeds WHERE work_id = ?',
      [workId]
    )
  }

  upsert(workId: number, content: string): void {
    const existing = this.getByWork(workId)
    if (existing) {
      this.run(
        `UPDATE incubator_seeds SET content = ?, update_time = CURRENT_TIMESTAMP WHERE work_id = ?`,
        [content, workId]
      )
    } else {
      this.insert(
        'INSERT INTO incubator_seeds (work_id, content) VALUES (?, ?)',
        [workId, content]
      )
    }
  }
}

export const incubatorSeedDAO = new IncubatorSeedDAO()
