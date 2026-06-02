import { ipcMain } from 'electron'
import type { ModelRequest } from './model/types'
import { estimateContextBudget } from './context/context-budget'
import { runConsistencyGate } from './context/consistency-gate'
import { scanCrossChapterConsistency } from './context/cross-chapter-scan'

export function registerV27IpcHandlers(): void {
  ipcMain.handle('context:estimateBudget', (_e, request: ModelRequest) =>
    estimateContextBudget(request))

  ipcMain.handle('consistency:gate', (_e, workId: number, chapterId: number, content: string) =>
    runConsistencyGate(workId, chapterId, content))

  ipcMain.handle('narrative:crossChapterScan', (_e, workId: number) =>
    scanCrossChapterConsistency(workId))
}
