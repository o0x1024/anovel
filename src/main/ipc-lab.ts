import { ipcMain } from 'electron'
import { labTaskDAO, aigcWordtableDAO, appPreferenceDAO } from './db'
import { buildLabDeaiSystemPrompt } from './context/lab/lab-deai-prompt'
import { cancelDeaiRewrite, parseLabUploadFile, runDeaiRewrite } from './context/lab/deai-rewrite'
import { runAigcDetect, cancelAigcDetect, runAigcRewrite } from './context/lab/aigc-detect'
import { applyWordTable } from './context/lab/aigc-wordtable-engine'
import { SURFACE_ANTI_AI_PRESETS, DEEP_ANTI_AI_PRESETS } from './context/anti-ai-rules'
import { WORDTABLE_PRESETS } from '../shared/wordtable-presets'
import { getModelStatus, deleteModel, isModelReady, listModels, switchModel, deleteModelById, disposePerplexityWorker, ensureModelReady } from './perplexity'
import type { LabTaskCreateInput, LabUploadParseInput } from '../shared/lab-types'
import type { AigcDetectResult } from '../shared/aigc-detect-types'
import type { WordTableEntryInput } from '../shared/aigc-wordtable-types'

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
  ipcMain.handle('lab:run', async (e, taskId: number, modelOpts?: { modelType?: string; modelName?: string }) =>
    runDeaiRewrite(e.sender, taskId, modelOpts)
  )
  ipcMain.handle('lab:cancelRun', (_e, taskId: number) => cancelDeaiRewrite(taskId))
  ipcMain.handle('lab:parseFile', (_e, input: LabUploadParseInput) => parseLabUploadFile(input))

  // AIGC 检测
  ipcMain.handle('lab:aigc-detect:run', async (e, runId: string, text: string, modelOpts?: { modelType?: string; modelName?: string }) => {
    const result = await runAigcDetect(e.sender, runId, text, modelOpts)
    return result
  })
  ipcMain.handle(
    'lab:aigc-detect:rewrite',
    async (
      e,
      runId: string,
      text: string,
      detectResultJson?: string | null,
      modelOpts?: { modelType?: string; modelName?: string },
      seedOpts?: { mode: 'fast' | 'strong'; seedText?: string; workId?: number; chapterId?: number }
    ) => {
      let detectResult: AigcDetectResult | null = null
      if (detectResultJson) {
        try {
          detectResult = JSON.parse(detectResultJson) as AigcDetectResult
        } catch {
          detectResult = null
        }
      }
      return runAigcRewrite(e.sender, runId, text, detectResult, modelOpts, seedOpts)
    }
  )
  ipcMain.handle('lab:aigc-detect:cancel', (_e, runId: string) => cancelAigcDetect(runId))

  // 词表替换管理
  ipcMain.handle('lab:wordtable:list', () => aigcWordtableDAO.list())
  ipcMain.handle('lab:wordtable:create', (_e, input: WordTableEntryInput) => {
    const id = aigcWordtableDAO.create(input)
    return aigcWordtableDAO.getById(id)
  })
  ipcMain.handle('lab:wordtable:update', (_e, id: number, input: Partial<WordTableEntryInput>) => {
    return aigcWordtableDAO.update(id, input)
  })
  ipcMain.handle('lab:wordtable:toggle', (_e, id: number, enabled: boolean) => {
    return aigcWordtableDAO.toggleEnabled(id, enabled)
  })
  ipcMain.handle('lab:wordtable:delete', (_e, id: number) => {
    return aigcWordtableDAO.delete(id)
  })
  ipcMain.handle('lab:wordtable:batchCreate', (_e, entries: WordTableEntryInput[]) => {
    return aigcWordtableDAO.batchCreate(entries)
  })
  ipcMain.handle('lab:wordtable:batchDelete', (_e, ids: number[]) => {
    return aigcWordtableDAO.batchDelete(ids)
  })
  ipcMain.handle('lab:wordtable:deleteAll', () => {
    return aigcWordtableDAO.deleteAll()
  })
  ipcMain.handle('lab:wordtable:apply', (_e, text: string) => {
    const entries = aigcWordtableDAO.listEnabled()
    return applyWordTable(text, entries)
  })
  ipcMain.handle('lab:wordtable:listPresets', () =>
    WORDTABLE_PRESETS.map(p => ({ id: p.id, name: p.name, description: p.description, count: p.entries.length }))
  )
  ipcMain.handle('lab:wordtable:importPreset', (_e, presetId: string) => {
    const preset = WORDTABLE_PRESETS.find(p => p.id === presetId)
    if (!preset) return { imported: 0, skipped: 0 }
    const existing = aigcWordtableDAO.list()
    const existingKeys = new Set(existing.map(e => `${e.type}::${e.source}`))
    const toInsert = preset.entries.filter(e => !existingKeys.has(`${e.type}::${e.source}`))
    if (toInsert.length > 0) {
      aigcWordtableDAO.batchCreate(toInsert.map(e => ({ type: e.type, source: e.source, target: e.target })))
    }
    return { imported: toInsert.length, skipped: preset.entries.length - toInsert.length }
  })

  // 困惑度模型管理
  ipcMain.handle('perplexity:model-status', () => getModelStatus())
  ipcMain.handle('perplexity:model-ready', () => isModelReady())
  ipcMain.handle('perplexity:delete-model', () => deleteModel())
  ipcMain.handle('perplexity:list-models', () => listModels())
  ipcMain.handle('perplexity:switch-model', async (_e, modelId: string) => {
    const result = switchModel(modelId)
    if (result.needsReload) {
      await disposePerplexityWorker()
    }
    return result
  })
  ipcMain.handle('perplexity:delete-model-by-id', (_e, modelId: string) => deleteModelById(modelId))

  ipcMain.handle('perplexity:download-model', async (e, modelId: string) => {
    const sender = e.sender
    await ensureModelReady((progress) => {
      sender.send('perplexity:download-progress', progress)
    }, modelId)
    return { success: true }
  })

  // 困惑度 API 配置
  ipcMain.handle('perplexity:get-api-config', () => {
    return appPreferenceDAO.getPerplexityApiConfig()
  })
  ipcMain.handle('perplexity:set-api-config', (_e, config) => {
    return appPreferenceDAO.setPerplexityApiConfig(config)
  })
  ipcMain.handle('perplexity:test-api', async (_e, apiBase: string, modelName: string, apiKey?: string) => {
    const { testApiConnection } = await import('./perplexity/api-perplexity')
    return testApiConnection(apiBase, modelName, apiKey)
  })
}
