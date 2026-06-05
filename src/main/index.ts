import { app, BrowserWindow, globalShortcut, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { initSchema, workDAO } from './db'
import { seedBuiltinStyles } from './db/seed'
import { seedBuiltinMaterials } from './db/seed-materials'
import { seedAssistantRoles } from './db/assistant-seed'
import { registerBuiltinPrompts } from './context/prompt-registry'
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
    title: 'ANovel - AI小说创作助手',
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (process.env.NODE_ENV === 'development' || process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  setupLocalFileProtocol()
  appLogger.startup()

  // 初始化数据库
  initSchema()

  // 清理叙事记忆重复数据（同章多次提取遗留）
  const workIds = workDAO.list().map(w => w.id)
  if (workIds.length > 0) {
    const cleaned = cleanupDuplicateNarrativeMemoryForAllWorks(workIds)
    if (cleaned.snapshotsRemoved > 0 || cleaned.foreshadowingRemoved > 0) {
      appLogger.info('memory', 'startup cleanup narrative duplicates', cleaned)
    }
  }

  // 写入内置文风预设
  seedBuiltinStyles()
  seedBuiltinMaterials()
  seedAssistantRoles()
  registerBuiltinPrompts()

  registerIpcHandlers()

  applyDockIcon()
  createWindow()

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') app.quit()
})
