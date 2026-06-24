import { BrowserWindow } from 'electron'

/** 模型配置变更后通知所有窗口刷新模型选择器（配合渲染层 KeepAlive） */
export function broadcastModelConfigChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('model:config-changed')
    }
  }
}
