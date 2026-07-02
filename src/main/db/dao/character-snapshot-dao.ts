import { BaseDAO } from './base-dao'

export interface CharacterSnapshotRow {
  id: number
  work_id: number
  character_name: string
  chapter_id: number
  location: string | null
  mental_state: string | null
  known_info: string | null
  relationship_changes: string | null
  ability_changes: string | null
  numeric_stats: string | null
  snapshot_time: string
}

export class CharacterSnapshotDAO extends BaseDAO {
  listByWork(workId: number): CharacterSnapshotRow[] {
    return this.all<CharacterSnapshotRow>(
      'SELECT * FROM character_snapshots WHERE work_id = ? ORDER BY character_name, snapshot_time',
      [workId]
    )
  }

  /** 获取指定角色的最新快照（同章多条时取最新一条） */
  getLatest(workId: number, characterName: string): CharacterSnapshotRow | undefined {
    return this.get<CharacterSnapshotRow>(
      `SELECT * FROM character_snapshots
       WHERE work_id = ? AND character_name = ?
       ORDER BY chapter_id DESC, snapshot_time DESC, id DESC
       LIMIT 1`,
      [workId, characterName]
    )
  }

  /** 获取某章节所有角色的快照 */
  listByChapter(chapterId: number): CharacterSnapshotRow[] {
    return this.all<CharacterSnapshotRow>(
      'SELECT * FROM character_snapshots WHERE chapter_id = ? ORDER BY character_name',
      [chapterId]
    )
  }

  /** 获取作品下某角色的全部快照历史 */
  listByCharacter(workId: number, characterName: string): CharacterSnapshotRow[] {
    return this.all<CharacterSnapshotRow>(
      'SELECT * FROM character_snapshots WHERE work_id = ? AND character_name = ? ORDER BY chapter_id',
      [workId, characterName]
    )
  }

  /** 获取作品中所有角色名列表 */
  listCharacterNames(workId: number): string[] {
    const rows = this.all<{ character_name: string }>(
      'SELECT DISTINCT character_name FROM character_snapshots WHERE work_id = ? ORDER BY character_name',
      [workId]
    )
    return rows.map(r => r.character_name)
  }

  create(input: {
    work_id: number
    character_name: string
    chapter_id: number
    location?: string
    mental_state?: string
    known_info?: string
    relationship_changes?: string
    ability_changes?: string
    numeric_stats?: string
  }): number {
    return this.insert(
      `INSERT INTO character_snapshots
       (work_id, character_name, chapter_id, location, mental_state, known_info, relationship_changes, ability_changes, numeric_stats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.work_id, input.character_name, input.chapter_id,
        input.location ?? null, input.mental_state ?? null,
        input.known_info ?? null, input.relationship_changes ?? null,
        input.ability_changes ?? null, input.numeric_stats ?? null
      ]
    )
  }

  delete(id: number): boolean {
    return this.run('DELETE FROM character_snapshots WHERE id = ?', [id]).changes > 0
  }

  deleteByChapter(chapterId: number): boolean {
    return this.run('DELETE FROM character_snapshots WHERE chapter_id = ?', [chapterId]).changes > 0
  }
}

export const characterSnapshotDAO = new CharacterSnapshotDAO()
