import { app, BrowserWindow, dialog, globalShortcut, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { initSchema, workDAO, goalRoutineDAO } from './db'
import { seedBuiltinStyles } from './db/seed'
import { seedBuiltinMaterials } from './db/seed-materials'
import { seedAssistantRoles } from './db/assistant-seed'
import { cancelAllGoalLoops } from './context/goal-routine/story-goal-routine'
import { cancelAllNovelGoalLoops } from './context/goal-routine/novel-goal-routine'
import { registerIpcHandlers } from './ipc'
import { appLogger } from './logger/app-logger'
import { cleanupDuplicateNarrativeMemoryForAllWorks } from './context/memory-cleanup'
import { registerLocalFileScheme, setupLocalFileProtocol } from './protocol/local-file'

registerLocalFileScheme()

let mainWindow: BrowserWindow | null = null

function resolveAppIconPath(): string | undefined {
  const candidates = [
    join(app.getAppPath(), 'build/icon.png'),
    join(process.resourcesPath, 'icon.png')
  ]
  return candidates.find(p => existsSync(p))
}

function createAppIcon(): ReturnType<typeof nativeImage.createFromPath> | undefined {
  const iconPath = resolveAppIconPath()
  if (!iconPath) return undefined
  return nativeImage.createFromPath(iconPath)
}

function applyDockIcon(): void {
  const icon = createAppIcon()
  if (icon && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }
}

function createWindow(): void {
  const icon = createAppIcon()
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    center: true,
    title: 'ANovel - AI小说创作助手',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error('[window] did-fail-load', code, description, url)
    dialog.showErrorBox(
      '页面加载失败',
      `无法加载应用界面 (${code}): ${description}\n${url}`
    )
  })

  if (process.env.NODE_ENV === 'development' || process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerGlobalShortcuts(): void {
  const quickIdea = process.platform === 'darwin' ? 'Command+Shift+I' : 'Control+Shift+I'
  const openExport = process.platform === 'darwin' ? 'Command+Shift+E' : 'Control+Shift+E'
  const writerBlock = process.platform === 'darwin' ? 'Command+Shift+B' : 'Control+Shift+B'

  globalShortcut.register(quickIdea, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:quickIdea')
      mainWindow.focus()
    }
  })

  globalShortcut.register(openExport, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:openExport')
      mainWindow.focus()
    }
  })

  globalShortcut.register(writerBlock, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('app:writerBlock')
      mainWindow.focus()
    }
  })
}

function bootstrapApp(): void {
  setupLocalFileProtocol()
  appLogger.startup()

  initSchema()

  // 目标循环：启动时将中断的 running 态重置为 paused，避免 LLM 自动续跑失控（需用户手动恢复）
  try {
    const reset = goalRoutineDAO.resetRunningToPaused()
    if (reset > 0) appLogger.info('goal_routine', '启动 reconcile：running→paused', { count: reset })
  } catch (e) {
    appLogger.warn('goal_routine', '启动 reconcile 失败', { error: String(e) })
  }

  const workIds = workDAO.list().map(w => w.id)
  if (workIds.length > 0) {
    const cleaned = cleanupDuplicateNarrativeMemoryForAllWorks(workIds)
    if (cleaned.snapshotsRemoved > 0 || cleaned.foreshadowingRemoved > 0) {
      appLogger.info('memory', 'startup cleanup narrative duplicates', cleaned)
    }
  }

  seedBuiltinStyles()
  seedBuiltinMaterials()
  seedAssistantRoles()
  registerIpcHandlers()
  registerGlobalShortcuts()
}

app.whenReady().then(() => {
  applyDockIcon()
  createWindow()

  try {
    bootstrapApp()
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err)
    console.error('[boot] FATAL startup error:', message)
    appLogger.error('app', 'startup failed', { message })
    dialog.showErrorBox('ANovel 启动失败', message)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  try {
    cancelAllGoalLoops()
    cancelAllNovelGoalLoops()
  } catch (e) {
    appLogger.warn('goal_routine', '关闭时中止目标循环失败', { error: String(e) })
  }
})
