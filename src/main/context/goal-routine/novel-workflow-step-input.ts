import { createHash } from 'node:crypto'
import type { ChapterRow } from '../../db/dao/chapter-dao'

interface NovelWorkflowStepInputOptions {
  phase: string
  operation: string
  stateRevision: number | null
  pendingReplayJobId: number | null
  repairPlan: unknown
  chapters: ChapterRow[]
  scopedChapterId?: number
}

function textHash(value: string | null): string | null {
  return value == null ? null : createHash('sha256').update(value).digest('hex')
}

/**
 * 工作流步骤身份只绑定会改变执行语义的内容。评测结果和 update_time 属于运行观测，
 * 不能把同一正文的下一次尝试伪装成一个全新输入。
 */
export function buildNovelWorkflowStepInput(options: NovelWorkflowStepInputOptions): unknown {
  const relevantChapters = options.scopedChapterId == null
    ? options.chapters
    : options.chapters.filter(chapter => chapter.id === options.scopedChapterId)
  return {
    phase: options.phase,
    operation: options.operation,
    stateRevision: options.stateRevision,
    pendingReplayJobId: options.pendingReplayJobId,
    repairPlan: options.repairPlan,
    chapters: relevantChapters.map(chapter => ({
      id: chapter.id,
      status: chapter.status,
      contentHash: textHash(chapter.content),
      outlineHash: textHash(chapter.outline)
    }))
  }
}
