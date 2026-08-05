import { createHash } from 'node:crypto'
import { BaseDAO } from './base-dao'
import type { ChapterResourceBudgetInput } from './resource-ledger-dao'
import type { EmotionContract } from '../../../shared/emotion-contract'

export interface NovelOutlineBatchItem {
  title: string
  outline: string
  arcPhase: string
  payoffRole: string
  foreshadowTarget: string | null
  nextHook: string
  characters: string[]
  outlineDiagnosis: string
  /** 正文生成前由独立情绪引擎按章补全，章节骨架批次不再承担该高维合同。 */
  emotionContract: EmotionContract | null
  resourceBudgets: ChapterResourceBudgetInput[]
}

/** 长篇章节大纲批次写入。章节与资源预算必须在同一事务中提交。 */
export class NovelOutlineDAO extends BaseDAO {
  commitBatch(input: {
    workId: number
    volumeName: string
    volumeDescription: string
    volumeSort: number
    volumeStartChapter: number
    volumeEndChapter: number
    chapterStartSort: number
    items: NovelOutlineBatchItem[]
    authorityStateUpdate?: {
      expectedRevision: number
      stateJson: string
    }
  }): number[] {
    return this.transaction(() => {
      let volume = this.get<{ id: number; description: string | null }>(
        'SELECT id, description FROM volumes WHERE work_id = ? AND name = ?',
        [input.workId, input.volumeName]
      )
      if (!volume) {
        const volumeId = this.insert(
          `INSERT INTO volumes (
            work_id, name, description, sort, planned_start_chapter, planned_end_chapter
          ) VALUES (?, ?, ?, ?, ?, ?)`,
          [
            input.workId, input.volumeName, input.volumeDescription, input.volumeSort,
            input.volumeStartChapter, input.volumeEndChapter
          ]
        )
        volume = { id: volumeId, description: input.volumeDescription }
      } else {
        this.run(
          `UPDATE volumes SET description = ?, sort = ?, planned_start_chapter = ?, planned_end_chapter = ? WHERE id = ?`,
          [input.volumeDescription, input.volumeSort, input.volumeStartChapter, input.volumeEndChapter, volume.id]
        )
      }

      const ids: number[] = []
      for (let i = 0; i < input.items.length; i++) {
        const item = input.items[i]
        const sort = input.chapterStartSort + i
        const duplicate = this.get<{ id: number }>(
          'SELECT id FROM chapters WHERE volume_id = ? AND sort = ?',
          [volume.id, sort]
        )
        if (duplicate) throw new Error(`章节批次提交冲突：${input.volumeName} 第 ${sort} 位已存在章节`)

        const chapterId = this.insert(
          `INSERT INTO chapters (
            volume_id, title, outline, sort, beat_role, foreshadow_target,
            next_hook, characters, outline_diagnosis, emotion_contract_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            volume.id,
            item.title,
            item.outline,
            sort,
            item.payoffRole,
            item.foreshadowTarget,
            item.nextHook,
            JSON.stringify(item.characters),
            item.outlineDiagnosis,
            item.emotionContract ? JSON.stringify(item.emotionContract) : null
          ]
        )
        ids.push(chapterId)

        for (const budget of item.resourceBudgets) {
          this.insert(
            `INSERT INTO chapter_resource_budgets (
              work_id, chapter_id, owner, resource, unit, start_min, start_max,
              end_min, end_max, allowed_events, forbidden_events, reason
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              input.workId,
              chapterId,
              budget.owner ?? null,
              budget.resource,
              budget.unit ?? null,
              budget.start_min ?? null,
              budget.start_max ?? null,
              budget.end_min ?? null,
              budget.end_max ?? null,
              budget.allowed_events ?? null,
              budget.forbidden_events ?? null,
              budget.reason ?? null
            ]
          )
        }
      }
      if (input.authorityStateUpdate) {
        const stateHash = createHash('sha256').update(input.authorityStateUpdate.stateJson).digest('hex')
        const result = this.run(
          `UPDATE novel_authority_states
           SET revision = revision + 1,
               state_hash = ?,
               state_json = ?,
               update_time = CURRENT_TIMESTAMP
           WHERE work_id = ? AND revision = ?`,
          [
            stateHash,
            input.authorityStateUpdate.stateJson,
            input.workId,
            input.authorityStateUpdate.expectedRevision
          ]
        )
        if (result.changes !== 1) {
          throw new Error(`作品 ${input.workId} 的章节批次权威状态修订冲突`)
        }
      }
      return ids
    })
  }
}

export const novelOutlineDAO = new NovelOutlineDAO()
