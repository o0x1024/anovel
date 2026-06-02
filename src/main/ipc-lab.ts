import { ipcMain } from 'electron'
import { labTaskDAO } from './db'
import { cancelDeaiRewrite, parseLabUploadFile, runDeaiRewrite } from './context/lab/deai-rewrite'
import type { LabTaskCreateInput, LabUploadParseInput } from '../shared/lab-types'

export function registerLabIpcHandlers(): void {
  ipcMain.handle('lab:taskList', () => labTaskDAO.list())
  ipcMain.handle('lab:taskGet', (_e, id: number) => labTaskDAO.getById(id))
  ipcMain.handle('lab:taskDelete', (_e, id: number) => labTaskDAO.delete(id))
  ipcMain.handle('lab:taskCreate', (_e, input: LabTaskCreateInput) => {
    const id = labTaskDAO.create(input)
    return labTaskDAO.getById(id)
  })
  ipcMain.handle('lab:run', async (e, taskId: number) => runDeaiRewrite(e.sender, taskId))
  ipcMain.handle('lab:cancelRun', (_e, taskId: number) => cancelDeaiRewrite(taskId))
  ipcMain.handle('lab:parseFile', (_e, input: LabUploadParseInput) => parseLabUploadFile(input))
}
