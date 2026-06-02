import { ipcMain, dialog } from 'electron'
import { readdirSync, statSync } from 'fs'
import path from 'path'
import { materialDAO } from './db'
import {
  exportWorkBundle, importWorkBundle, backupDatabase, restoreDatabase,
  createAutoBackup, getDatabasePath, ensureBackupDir
} from './backup/work-backup'
import { getWritingStats } from './context/writing-stats'
import { getStyleStabilityReport } from './context/style-stability'
import { WRITER_BLOCK_PROMPTS, parseDirections } from './context/writer-block'
import { modelService } from './model'
import { buildWorkContext } from './context/work-context'
import { volumeChapterDAO } from './db'

export function registerV25IpcHandlers(): void {
  // ==================== 作品备份/恢复 ====================
  ipcMain.handle('backup:exportWork', (_e, workId: number) => exportWorkBundle(workId))

  ipcMain.handle('backup:importWork', (_e, bundle: Parameters<typeof importWorkBundle>[0]) =>
    importWorkBundle(bundle))

  ipcMain.handle('backup:getDbPath', () => getDatabasePath())

  ipcMain.handle('backup:auto', () => createAutoBackup())

  ipcMain.handle('backup:saveDatabase', async () => {
    const result = await dialog.showSaveDialog({
      title: '保存数据库备份',
      defaultPath: `anovel-backup-${Date.now()}.db`,
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
    })
    if (result.canceled || !result.filePath) return { success: false }
    backupDatabase(result.filePath)
    return { success: true, path: result.filePath }
  })

  ipcMain.handle('backup:restoreDatabase', async () => {
    const result = await dialog.showOpenDialog({
      title: '恢复数据库备份',
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return { success: false }
    restoreDatabase(result.filePaths[0])
    return { success: true, needsRestart: true }
  })

  ipcMain.handle('backup:listAuto', () => {
    const dir = ensureBackupDir()
    try {
      return readdirSync(dir)
        .filter(f => f.endsWith('.db'))
        .map(f => {
          const full = path.join(dir, f)
          const stat = statSync(full)
          return { name: f, path: full, size: stat.size, mtime: stat.mtime.toISOString() }
        })
        .sort((a, b) => b.mtime.localeCompare(a.mtime))
    } catch {
      return []
    }
  })

  // ==================== 写作统计 ====================
  ipcMain.handle('stats:get', (_e, workId: number) => getWritingStats(workId))

  // ==================== 文风稳定性 ====================
  ipcMain.handle('styleStability:get', (_e, workId: number) => getStyleStabilityReport(workId))

  // ==================== 写作障碍应对 ====================
  ipcMain.handle('writerBlock:randomInspiration', async (e, workId: number) => {
    const ctx = buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true })
    return modelService.chat({
      prompt: ctx ? `作品背景：\n${ctx.slice(0, 2000)}\n\n${WRITER_BLOCK_PROMPTS.randomInspiration}` : WRITER_BLOCK_PROMPTS.randomInspiration,
      workId,
      step: 'writer_block_inspiration',
      enrichWorkContext: false
    }, { webContents: e.sender })
  })

  ipcMain.handle('writerBlock:plotDirections', async (e, workId: number) => {
    const ctx = buildWorkContext(workId, { includeCoreSettings: true, includeVolumes: true })
    const res = await modelService.chat({
      prompt: ctx ? `${ctx.slice(0, 3000)}\n\n${WRITER_BLOCK_PROMPTS.plotDirections}` : WRITER_BLOCK_PROMPTS.plotDirections,
      workId,
      step: 'writer_block_directions',
      enrichWorkContext: false
    }, { webContents: e.sender })
    if (!res.success) return res
    return { ...res, directions: parseDirections(res.content) }
  })

  ipcMain.handle('writerBlock:characterWhatIf', async (e, workId: number) => {
    const ctx = buildWorkContext(workId, { includeCoreSettings: true })
    const res = await modelService.chat({
      prompt: ctx ? `${ctx.slice(0, 2500)}\n\n${WRITER_BLOCK_PROMPTS.characterWhatIf}` : WRITER_BLOCK_PROMPTS.characterWhatIf,
      workId,
      step: 'writer_block_whatif',
      enrichWorkContext: false
    }, { webContents: e.sender })
    if (!res.success) return res
    return { ...res, experiments: parseDirections(res.content) }
  })

  ipcMain.handle('writerBlock:revisionChecklist', async (e, workId: number, chapterId: number) => {
    const ch = volumeChapterDAO.getChapter(chapterId)
    if (!ch?.content?.trim()) return { success: false, error: '章节暂无正文' }
    return modelService.chat({
      prompt: `【章节】${ch.title}\n\n${ch.content.slice(0, 8000)}\n\n${WRITER_BLOCK_PROMPTS.revisionChecklist}`,
      workId,
      chapterId,
      step: 'revision_checklist',
      enrichWorkContext: false,
      enrichNarrativeMemory: false
    }, { webContents: e.sender })
  })

  // ==================== 素材库 ====================
  ipcMain.handle('material:listGlobal', () => materialDAO.listGlobal())
  ipcMain.handle('material:listByWork', (_e, workId: number) => materialDAO.listByWork(workId))
  ipcMain.handle('material:create', (_e, input: { work_id?: number; category: string; title?: string; content: string }) =>
    materialDAO.create(input))
  ipcMain.handle('material:delete', (_e, id: number) => materialDAO.delete(id))
}
