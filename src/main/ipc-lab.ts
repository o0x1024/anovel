import { ipcMain } from 'electron'
import { labTaskDAO } from './db'
import { buildLabDeaiSystemPrompt } from './context/lab/lab-deai-prompt'
import { cancelDeaiRewrite, parseLabUploadFile, runDeaiRewrite } from './context/lab/deai-rewrite'
import { SURFACE_ANTI_AI_PRESETS, DEEP_ANTI_AI_PRESETS } from './context/anti-ai-rules'
import type { LabTaskCreateInput, LabUploadParseInput } from '../shared/lab-types'

export function registerLabIpcHandlers(): void {
  ipcMain.handle('lab:getAntiAiPresets', () => ({
    surface: SURFACE_ANTI_AI_PRESETS,
    deep: DEEP_ANTI_AI_PRESETS
  }))
  ipcMain.handle(
    'lab:buildSystemPrompt',
    (_e, styleId: number, antiAiRules?: unknown) => {
      const rules = Array.isArray(antiAiRules)
        ? antiAiRules.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        : []
      return buildLabDeaiSystemPrompt(styleId, rules)
    }
  )
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
