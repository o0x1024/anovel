import { app, BrowserWindow, dialog, globalShortcut, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { initSchema, workDAO, goalRoutineDAO } from './db'
import { seedBuiltinStyles } from './db/seed'
import { seedBuiltinMaterials } from './db/seed-materials'
import { seedAssistantRoles } from './db/assistant-seed'
import { runStoryGoalLoop } from './context/goal-routine/story-goal-routine'
import { runNovelGoalLoop } from './context/goal-routine/novel-goal-routine'
import { registerIpcHandlers } from './ipc'
import { appLogger } from './logger/app-logger'
import { cleanupDuplicateNarrativeMemoryForAllWorks } from './context/memory-cleanup'
import { registerLocalFileScheme, setupLocalFileProtocol } from './protocol/local-file'

registerLocalFileScheme()

let mainWindow: BrowserWindow | null = null
const ownsSingleInstanceLock = app.requestSingleInstanceLock()

if (!ownsSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
})

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

function recoverPersistedWorkflow(run: ReturnType<typeof goalRoutineDAO.listRecoverable>[number]): void {
  let config: Record<string, unknown>
  try {
    const parsed = run.goal_config_json ? JSON.parse(run.goal_config_json) as unknown : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('goal_config_json 必须是 JSON 对象')
    }
    config = parsed as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    goalRoutineDAO.update(run.work_id, { status: 'error' })
    goalRoutineDAO.appendTurn({
      work_id: run.work_id,
      turn_no: run.turn_count,
      phase: run.current_phase,
      action: 'recovery_config_corrupt',
      summary: `启动恢复失败：持久化配置损坏（${message}）`
    })
    appLogger.error('workflow_recovery', '持久化运行配置损坏，已隔离该运行', {
      runId: run.id,
      workId: run.work_id,
      error: message
    })
    return
  }

  try {
    const task = run.workflow_type === 'novel'
      ? runNovelGoalLoop(run.work_id, config, undefined, true)
      : runStoryGoalLoop(run.work_id, config, undefined, true)
    appLogger.info('workflow_recovery', '启动自动恢复持久化运行', {
      runId: run.id,
      workId: run.work_id,
      workflowType: run.workflow_type,
      phase: run.current_phase,
      recoveryCount: run.recovery_count
    })
    void task.catch(error => {
      goalRoutineDAO.update(run.work_id, { status: 'error' })
      appLogger.error('workflow_recovery', '持久化运行自动恢复失败', {
        runId: run.id,
        workId: run.work_id,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  } catch (error) {
    goalRoutineDAO.update(run.work_id, { status: 'error' })
    appLogger.error('workflow_recovery', '持久化运行恢复调度失败', {
      runId: run.id,
      workId: run.work_id,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function bootstrapApp(): void {
  setupLocalFileProtocol()
  appLogger.startup()

  initSchema()

  const recoverableRuns = goalRoutineDAO.markInterruptedForRecovery()

  const workIds = workDAO.list().map(w => w.id)
  if (workIds.length > 0) {
    const cleaned = cleanupDuplicateNarrativeMemoryForAllWorks(workIds)
    if (cleaned.snapshotsRemoved > 0 || cleaned.foreshadowingRemoved > 0) {
      appLogger.info('memory', 'startup cleanup narrative duplicates', {
        snapshotsRemoved: cleaned.snapshotsRemoved,
        foreshadowingRemoved: cleaned.foreshadowingRemoved
      })
    }
  }

  seedBuiltinStyles()
  seedBuiltinMaterials()
  seedAssistantRoles()
  registerIpcHandlers()
  registerGlobalShortcuts()

  for (const run of recoverableRuns) recoverPersistedWorkflow(run)
}

if (ownsSingleInstanceLock) {
  void app.whenReady().then(() => {
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
}

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll()
  if (process.platform !== 'darwin') app.quit()
})

// 不在 before-quit 中把运行改为 paused。主进程退出后保留 running，
// 下次启动由持久化租约恢复器接管精确步骤。
