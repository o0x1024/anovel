import { BrowserWindow } from 'electron'
import { goalRoutineDAO } from '../../db'

const activeNovelGoalLoops = new Map<number, AbortController>()

export function isNovelGoalLoopRunning(workId: number): boolean {
  return activeNovelGoalLoops.has(workId)
}

export function registerNovelGoalLoop(workId: number, controller: AbortController): void {
  activeNovelGoalLoops.set(workId, controller)
}

export function unregisterNovelGoalLoop(workId: number): void {
  activeNovelGoalLoops.delete(workId)
}

export function cancelNovelGoalLoop(workId: number): boolean {
  const controller = activeNovelGoalLoops.get(workId)
  if (!controller) return false
  goalRoutineDAO.setStatus(workId, 'cancelled')
  controller.abort()
  return true
}

export function cancelAllNovelGoalLoops(): void {
  for (const [workId, controller] of activeNovelGoalLoops) {
    controller.abort()
    try {
      goalRoutineDAO.update(workId, {
        status: 'waiting',
        desired_state: 'running'
      })
    } catch {
      // 关闭进程期间数据库可能已释放；保留自动恢复意图即可。
    }
  }
  activeNovelGoalLoops.clear()
}

export function broadcastNovelGoalProgress(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch {
      // 接收窗口已销毁。
    }
  }
}
