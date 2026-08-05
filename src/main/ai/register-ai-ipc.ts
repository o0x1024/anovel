import { ipcMain } from 'electron'
import { aiSessionManager } from './ai-session-manager'

export function registerAiIpcHandlers(): void {
  ipcMain.handle('ai:startManagedSession', (e, title: string, stepLabels: string[] = []) => {
    const session = aiSessionManager.create(e.sender, title, stepLabels)
    return { sessionId: session.id }
  })

  ipcMain.handle('ai:updateManagedSession', (e, sessionId: string, stepIndex: number, status: 'pending' | 'running' | 'done' | 'error' | 'skipped', message?: string) => {
    const session = aiSessionManager.getHandle(sessionId, e.sender)
    if (!session) return { success: false }
    if (status === 'running') session.setStepRunning(stepIndex)
    else if (status === 'done') session.setStepDone(stepIndex)
    else if (status === 'error') session.setStepError(stepIndex, message)
    else session.emitPhase(message || '', status, stepIndex)
    return { success: true }
  })

  ipcMain.handle('ai:appendManagedSessionOutput', (e, sessionId: string, content: string) => {
    const session = aiSessionManager.getHandle(sessionId, e.sender)
    if (!session) return { success: false }
    session.emitDelta(`\n\n${content.trim()}\n`)
    return { success: true }
  })

  ipcMain.handle('ai:completeManagedSession', (e, sessionId: string, success: boolean, error?: string) => {
    const session = aiSessionManager.getHandle(sessionId, e.sender)
    if (!session) return { success: false }
    session.complete(success, error)
    return { success: true }
  })

  ipcMain.handle('ai:cancelSession', (_e, sessionId: string) => {
    const ok = aiSessionManager.cancel(sessionId)
    return { success: ok }
  })

  ipcMain.handle('ai:getActiveSessionId', () => ({
    sessionId: aiSessionManager.getActiveSessionId()
  }))
}
