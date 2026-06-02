import { ipcMain, shell } from 'electron'
import { appLogger } from './logger/app-logger'

export function registerLogIpcHandlers(): void {
  ipcMain.handle('log:getInfo', () => ({
    logDir: appLogger.getLogDir(),
    todayFile: appLogger.getTodayLogPath(),
    recentLines: appLogger.readRecentLines(80)
  }))

  ipcMain.handle('log:readRecent', (_e, limit?: number) => ({
    lines: appLogger.readRecentLines(limit ?? 120),
    todayFile: appLogger.getTodayLogPath()
  }))

  ipcMain.handle('log:listFiles', () => appLogger.listLogFiles())

  ipcMain.handle('log:openDir', async () => {
    const dir = appLogger.getLogDir()
    const err = await shell.openPath(dir)
    if (err) appLogger.error('log', '打开日志目录失败', { dir, err })
    return { success: !err, path: dir, error: err || undefined }
  })

  ipcMain.handle('log:openToday', async () => {
    const file = appLogger.getTodayLogPath()
    const err = await shell.openPath(file)
    if (err) appLogger.error('log', '打开今日日志失败', { file, err })
    return { success: !err, path: file, error: err || undefined }
  })
}
