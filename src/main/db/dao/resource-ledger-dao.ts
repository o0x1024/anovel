import { BaseDAO } from './base-dao'

export interface ResourceConstraintInput {
  owner?: string | null
  resource: string
  unit?: string | null
  initial_value?: number | null
  min_value?: number | null
  max_value?: number | null
  hard_rules_json?: string | null
  milestones_json?: string | null
  spend_rules_json?: string | null
  recover_rules_json?: string | null
  source_types?: string | null
}

export interface ResourceConstraintRow extends ResourceConstraintInput {
  id: number
  work_id: number
  create_time: string
  update_time: string
}

export interface ChapterResourceBudgetInput {
  owner?: string | null
  resource: string
  unit?: string | null
  start_min?: number | null
  start_max?: number | null
  end_min?: number | null
  end_max?: number | null
  allowed_events?: string | null
  forbidden_events?: string | null
  reason?: string | null
}

export interface ChapterResourceBudgetRow extends ChapterResourceBudgetInput {
  id: number
  work_id: number
  chapter_id: number
  create_time: string
  update_time: string
}

export class ResourceLedgerDAO extends BaseDAO {
  replaceConstraints(workId: number, constraints: ResourceConstraintInput[]): number {
    return this.transaction(() => {
      this.run('DELETE FROM resource_constraints WHERE work_id = ?', [workId])
      let count = 0
      for (const c of constraints) {
        if (!c.resource?.trim()) continue
        this.insert(
          `INSERT INTO resource_constraints (
            work_id, owner, resource, unit, initial_value, min_value, max_value,
            hard_rules_json, milestones_json, spend_rules_json, recover_rules_json, source_types
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            workId,
            c.owner ?? null,
            c.resource.trim(),
            c.unit ?? null,
            c.initial_value ?? null,
            c.min_value ?? null,
            c.max_value ?? null,
            c.hard_rules_json ?? null,
            c.milestones_json ?? null,
            c.spend_rules_json ?? null,
            c.recover_rules_json ?? null,
            c.source_types ?? null
          ]
        )
        count++
      }
      return count
    })
  }

  listConstraints(workId: number): ResourceConstraintRow[] {
    return this.all<ResourceConstraintRow>(
      'SELECT * FROM resource_constraints WHERE work_id = ? ORDER BY id',
      [workId]
    )
  }

  replaceBudgetsForChapter(workId: number, chapterId: number, budgets: ChapterResourceBudgetInput[]): number {
    return this.transaction(() => {
      this.run('DELETE FROM chapter_resource_budgets WHERE work_id = ? AND chapter_id = ?', [workId, chapterId])
      let count = 0
      for (const b of budgets) {
        if (!b.resource?.trim()) continue
        this.insert(
          `INSERT INTO chapter_resource_budgets (
            work_id, chapter_id, owner, resource, unit, start_min, start_max, end_min, end_max,
            allowed_events, forbidden_events, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            workId,
            chapterId,
            b.owner ?? null,
            b.resource.trim(),
            b.unit ?? null,
            b.start_min ?? null,
            b.start_max ?? null,
            b.end_min ?? null,
            b.end_max ?? null,
            b.allowed_events ?? null,
            b.forbidden_events ?? null,
            b.reason ?? null
          ]
        )
        count++
      }
      return count
    })
  }

  listBudgetsByChapter(workId: number, chapterId: number): ChapterResourceBudgetRow[] {
    return this.all<ChapterResourceBudgetRow>(
      'SELECT * FROM chapter_resource_budgets WHERE work_id = ? AND chapter_id = ? ORDER BY id',
      [workId, chapterId]
    )
  }

  listBudgetsByWork(workId: number): ChapterResourceBudgetRow[] {
    return this.all<ChapterResourceBudgetRow>(
      'SELECT * FROM chapter_resource_budgets WHERE work_id = ? ORDER BY chapter_id, id',
      [workId]
    )
  }
}

export const resourceLedgerDAO = new ResourceLedgerDAO()
