import { ipcMain } from 'electron'
import type { ModelRequest } from './model/types'
import { estimateContextBudget } from './context/context-budget'
import { runConsistencyGate } from './context/consistency-gate'
import { scanCrossChapterConsistency } from './context/cross-chapter-scan'
import { workDAO } from './db'
import { persistChapterExecutionContract } from './context/chapter-execution-context'
import {
  assessNovelExecutionCandidate,
  repairNovelExecutionCandidate
} from './context/goal-routine/novel-execution-gate'

export function registerV27IpcHandlers(): void {
  ipcMain.handle('context:estimateBudget', (_e, request: ModelRequest) =>
    estimateContextBudget(request))

  ipcMain.handle('consistency:gate', async (_e, workId: number, chapterId: number, content: string) => {
    // 编辑器保存的是尚未提取派生记忆的候选正文；完整时间线门禁由记忆提交阶段执行。
    const base = runConsistencyGate(workId, chapterId, content, { requireTimeline: false })
    if (workDAO.getById(workId)?.work_type !== 'novel' || !content.trim()) return base
    const contract = persistChapterExecutionContract(workId, chapterId)
    if (!contract) {
      return { passed: false, blockers: [...base.blockers, '章节执行合同无法编译'], warnings: base.warnings }
    }
    const execution = await assessNovelExecutionCandidate(workId, chapterId, content, contract)
    return {
      passed: base.passed && execution.passed,
      blockers: [...base.blockers, ...execution.blockers],
      warnings: [...base.warnings, ...execution.warnings],
      execution
    }
  })

  ipcMain.handle('narrative:crossChapterScan', (_e, workId: number) =>
    scanCrossChapterConsistency(workId))

  ipcMain.handle('novel:repairExecutionCandidate', async (
    _e,
    workId: number,
    chapterId: number,
    content: string,
    blockers: string[]
  ) => {
    const contract = persistChapterExecutionContract(workId, chapterId)
    if (!contract) return { success: false, content, error: '章节执行合同无法编译' }
    return repairNovelExecutionCandidate(workId, chapterId, content, contract, blockers)
  })
}
