import { BrowserWindow } from 'electron'

/** 文风增删改后通知所有窗口刷新列表（配合渲染层 KeepAlive） */
export function broadcastStyleChanged(styleId?: number | null): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('style:changed', styleId ?? null)
    }
  }
}
