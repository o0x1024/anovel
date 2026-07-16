import { BaseDAO } from './base-dao'
import type {
  ChapterPatternFingerprintInput,
  StoryStateFactInput,
  StoryStateTransition,
  StoryStateValueType
} from '../../../shared/novel-systemic-types'

export interface StoryStateFactRow {
  id: number
  work_id: number
  chapter_id: number
  entity: string
  state_key: string
  value_type: StoryStateValueType
  value_json: string
  transition: StoryStateTransition
  irreversible: number
  evidence: string | null
  create_time: string
}

export interface ChapterPatternFingerprintRow {
  chapter_id: number
  work_id: number
  conflict_type: string
  protagonist_method: string
  antagonist_tactic: string
  antagonist_outcome: string
  opponent_adjustment: string
  location_type: string
  hook_type: string
  cost_type: string
  relationship_delta: string
  volume_objective_delta: string
  payoff_type: ChapterPatternFingerprintInput['payoffType']
  create_time: string
  update_time: string
}

export class StoryStateDAO extends BaseDAO {
  replaceChapterFacts(workId: number, chapterId: number, facts: StoryStateFactInput[]): void {
    this.transaction(() => {
      this.run('DELETE FROM story_state_facts WHERE work_id = ? AND chapter_id = ?', [workId, chapterId])
      for (const fact of facts) {
        this.run(
          `INSERT INTO story_state_facts (
            work_id, chapter_id, entity, state_key, value_type, value_json,
            transition, irreversible, evidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            workId, chapterId, fact.entity.trim(), fact.key.trim(), fact.valueType,
            JSON.stringify(fact.value ?? null), fact.transition, fact.irreversible ? 1 : 0,
            fact.evidence?.trim() || null
          ]
        )
      }
    })
  }

  listFactsByWork(workId: number): StoryStateFactRow[] {
    return this.all<StoryStateFactRow>(
      `SELECT f.* FROM story_state_facts f
       JOIN chapters c ON c.id = f.chapter_id
       JOIN volumes v ON v.id = c.volume_id
       WHERE f.work_id = ?
       ORDER BY v.sort, c.sort, f.id`,
      [workId]
    )
  }

  listFactsByChapter(workId: number, chapterId: number): StoryStateFactRow[] {
    return this.all<StoryStateFactRow>(
      'SELECT * FROM story_state_facts WHERE work_id = ? AND chapter_id = ? ORDER BY id',
      [workId, chapterId]
    )
  }

  replaceFingerprint(workId: number, chapterId: number, value: ChapterPatternFingerprintInput): void {
    this.run(
      `INSERT INTO chapter_pattern_fingerprints (
        chapter_id, work_id, conflict_type, protagonist_method, antagonist_tactic,
        antagonist_outcome, opponent_adjustment, location_type, hook_type, cost_type,
        relationship_delta, volume_objective_delta, payoff_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chapter_id) DO UPDATE SET
        work_id = excluded.work_id,
        conflict_type = excluded.conflict_type,
        protagonist_method = excluded.protagonist_method,
        antagonist_tactic = excluded.antagonist_tactic,
        antagonist_outcome = excluded.antagonist_outcome,
        opponent_adjustment = excluded.opponent_adjustment,
        location_type = excluded.location_type,
        hook_type = excluded.hook_type,
        cost_type = excluded.cost_type,
        relationship_delta = excluded.relationship_delta,
        volume_objective_delta = excluded.volume_objective_delta,
        payoff_type = excluded.payoff_type,
        update_time = CURRENT_TIMESTAMP`,
      [
        chapterId, workId, value.conflictType.trim(), value.protagonistMethod.trim(),
        value.antagonistTactic.trim(), value.antagonistOutcome.trim(), value.opponentAdjustment.trim(),
        value.locationType.trim(), value.hookType.trim(), value.costType.trim(),
        value.relationshipDelta.trim(), value.volumeObjectiveDelta.trim(), value.payoffType
      ]
    )
  }

  listFingerprintsByWork(workId: number): ChapterPatternFingerprintRow[] {
    return this.all<ChapterPatternFingerprintRow>(
      `SELECT f.* FROM chapter_pattern_fingerprints f
       JOIN chapters c ON c.id = f.chapter_id
       JOIN volumes v ON v.id = c.volume_id
       WHERE f.work_id = ?
       ORDER BY v.sort, c.sort`,
      [workId]
    )
  }

  deleteByChapter(workId: number, chapterId: number): { facts: number; fingerprints: number } {
    const facts = this.run('DELETE FROM story_state_facts WHERE work_id = ? AND chapter_id = ?', [workId, chapterId]).changes
    const fingerprints = this.run('DELETE FROM chapter_pattern_fingerprints WHERE work_id = ? AND chapter_id = ?', [workId, chapterId]).changes
    return { facts, fingerprints }
  }
}

export const storyStateDAO = new StoryStateDAO()
