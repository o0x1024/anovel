import { ipcMain } from 'electron'
import { aiSessionManager } from './ai-session-manager'

export function registerAiIpcHandlers(): void {
  ipcMain.handle('ai:cancelSession', (_e, sessionId: string) => {
    const ok = aiSessionManager.cancel(sessionId)
    return { success: ok }
  })

  ipcMain.handle('ai:getActiveSessionId', () => ({
    sessionId: aiSessionManager.getActiveSessionId()
  }))
}
