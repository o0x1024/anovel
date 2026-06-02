import { ipcMain } from 'electron'
import { registerV15IpcHandlers } from './ipc-v15'
import { registerV20IpcHandlers } from './ipc-v20'
import { registerV25IpcHandlers } from './ipc-v25'
import { registerV26IpcHandlers } from './ipc-v26'
import { registerV27IpcHandlers } from './ipc-v27'
import { registerLogIpcHandlers } from './ipc-log'
import { registerAiIpcHandlers } from './ai/register-ai-ipc'
import { registerAssistantIpcHandlers } from './ipc-assistant'
import { registerLabIpcHandlers } from './ipc-lab'
import {
  workDAO, volumeChapterDAO, writingStyleDAO,
  modelConfigDAO, anchorDAO, ideaFragmentDAO, aiFavoriteDAO,
  generationLogDAO, coreSettingDAO, appPreferenceDAO
} from './db'
import type { StyleCreateInput, AnchorCreateInput } from './db'
import { modelService, ModelRequest } from './model'
import { fetchProviderModelCatalog, buildAssistantModelOptions } from './context/model-catalog'
import { buildWorkContext } from './context/work-context'
import {
  buildSettingsGenerationContext,
  type CoreSettingGenerateType
} from './context/settings-generation-context'
import { parseVolumeSuggestions } from './context/parse-volumes'
import { parseAnchorSuggestions } from './context/parse-anchors'
import { parseChapterSuggestions, parseChapterAbcFromAi, stripOutlineJsonFooter } from './context/parse-chapters'
import { getWorkStepProgress } from './context/work-progress'
import { checkAnchorAlignment } from './context/anchor-alignment'
import { mergeIdeaToTarget } from './context/idea-merge'
import { parseExpansionVersions } from './context/parse-expansion'
import { parseIncubatorVariants } from './context/parse-variants'
import { getConditionRules, setConditionRules } from './context/condition-rules'
import { getAntiAiRules, setAntiAiRules, appendAntiAiRules, suggestRulesFromAiTrace, checkAntiAiRuleViolations, stripEmDashes, getWorkReferenceText, setWorkReferenceText, getAllAntiAiPresets, getCustomAntiAiPresets, setCustomAntiAiPresets, type AntiAiPreset } from './context/anti-ai-rules'
import { detectAnchorConflicts } from './context/anchor-conflict'
import { exportWorkContent } from './context/export-content'
import {
  getWritingPlanStatus,
  initWritingPlanForWork,
  loadWritingPlan,
  saveWritingPlan,
  applyNovelLengthPreset,
  suggestBatchChapterCount
} from './context/writing-plan'
import type { NovelLength } from '../../shared/writing-plan-presets'
import {
  deleteWorkCoverFile,
  pickAndSetWorkCover,
  removeWorkCover,
  setWorkCoverFromBase64
} from './context/work-cover'
import { getWorkBodyText } from './context/assistant/work-reference'

/**
 * 注册所有 IPC 处理器，桥接渲染进程与数据库层
 */
export function registerIpcHandlers(): void {
  // ==================== 作品 ====================
  ipcMain.handle('work:list', () => workDAO.list())
  ipcMain.handle('work:get', (_e, id: number) => workDAO.getById(id))
  ipcMain.handle('work:create', (_e, input: { title: string; description?: string; novelLength?: NovelLength }) => {
    const id = workDAO.create(input)
    initWritingPlanForWork(id, input.novelLength ?? 'medium')
    return id
  })
  ipcMain.handle('work:update', (_e, id: number, input: Record<string, unknown>) => workDAO.update(id, input))
  ipcMain.handle('work:delete', (_e, id: number) => {
    const work = workDAO.getById(id)
    deleteWorkCoverFile(work?.cover_image)
    return workDAO.delete(id)
  })
  ipcMain.handle('work:pickCover', (_e, workId: number) => pickAndSetWorkCover(workId))
  ipcMain.handle('work:setCoverFromBase64', (_e, workId: number, base64: string, fileName: string) =>
    setWorkCoverFromBase64(workId, base64, fileName))
  ipcMain.handle('work:removeCover', (_e, workId: number) => removeWorkCover(workId))
  ipcMain.handle('work:getStepProgress', (_e, workId: number) => getWorkStepProgress(workId))
  ipcMain.handle('work:getBodyText', (_e, workId: number, chapterId?: number | null) =>
    getWorkBodyText(workId, chapterId ?? null))

  // ==================== 分卷 & 章节 ====================
  ipcMain.handle('volume:list', (_e, workId: number) => volumeChapterDAO.listVolumes(workId))
  ipcMain.handle('volume:create', (_e, workId: number, name: string, desc?: string) =>
    volumeChapterDAO.createVolume(workId, name, desc))
  ipcMain.handle('volume:update', (_e, id: number, fields: Record<string, unknown>) =>
    volumeChapterDAO.updateVolume(id, fields))
  ipcMain.handle('volume:delete', (_e, id: number) => volumeChapterDAO.deleteVolume(id))
  ipcMain.handle('volume:batchUpsert', (_e, workId: number, items: { name: string; description?: string }[], mode?: 'append' | 'replace') =>
    volumeChapterDAO.batchUpsertVolumes(workId, items, mode ?? 'append'))
  ipcMain.handle('volume:parseSuggestions', (_e, content: string) => parseVolumeSuggestions(content))

  ipcMain.handle('chapter:list', (_e, volumeId: number) => volumeChapterDAO.listChapters(volumeId))
  ipcMain.handle('chapter:listByWork', (_e, workId: number) => volumeChapterDAO.listChaptersByWork(workId))
  ipcMain.handle('chapter:get', (_e, id: number) => volumeChapterDAO.getChapter(id))
  ipcMain.handle('chapter:create', (_e, volumeId: number, title: string, outline?: string) =>
    volumeChapterDAO.createChapter(volumeId, title, outline))
  ipcMain.handle('chapter:update', (_e, id: number, fields: Record<string, unknown>) =>
    volumeChapterDAO.updateChapter(id, fields))
  ipcMain.handle('chapter:delete', (_e, id: number) => volumeChapterDAO.deleteChapter(id))
  ipcMain.handle('chapter:batchCreate', (_e, volumeId: number, items: { title: string; outline?: string }[], mode?: 'append' | 'replace') =>
    volumeChapterDAO.batchCreateChapters(volumeId, items, mode ?? 'append'))
  ipcMain.handle('chapter:parseSuggestions', (_e, content: string) => parseChapterSuggestions(content, false))
  ipcMain.handle('chapter:parseAbc', (_e, content: string) => parseChapterAbcFromAi(content))
  ipcMain.handle('chapter:stripOutline', (_e, content: string) => stripOutlineJsonFooter(content))

  ipcMain.handle('writingPlan:get', (_e, workId: number) => loadWritingPlan(workId))
  ipcMain.handle('writingPlan:update', (_e, workId: number, input: { targetTotalWords?: number; wordsPerChapter?: number; novelLength?: NovelLength }) =>
    saveWritingPlan(workId, input))
  ipcMain.handle('writingPlan:applyNovelLength', (_e, workId: number, novelLength: NovelLength) =>
    applyNovelLengthPreset(workId, novelLength))
  ipcMain.handle('writingPlan:getStatus', (_e, workId: number) => getWritingPlanStatus(workId))
  ipcMain.handle('writingPlan:suggestBatchCount', (_e, workId: number, volumeId: number) => {
    const status = getWritingPlanStatus(workId)
    const vol = status.volumes.find(v => v.id === volumeId)
    return suggestBatchChapterCount(vol)
  })

  ipcMain.handle('chapter:versionList', (_e, chapterId: number) => volumeChapterDAO.listVersions(chapterId))
  ipcMain.handle('chapter:versionCreate', (_e, chapterId: number, data: Record<string, unknown>) =>
    volumeChapterDAO.createVersion(chapterId, data))
  ipcMain.handle('chapter:versionRestore', (_e, chapterId: number, versionId: number) =>
    volumeChapterDAO.restoreVersion(chapterId, versionId))

  // ==================== 文风 ====================
  ipcMain.handle('style:list', () => writingStyleDAO.list())
  ipcMain.handle('style:get', (_e, id: number) => writingStyleDAO.getById(id))
  ipcMain.handle('style:create', (_e, input: Record<string, unknown>) => writingStyleDAO.create(input as unknown as StyleCreateInput))
  ipcMain.handle('style:update', (_e, id: number, input: Record<string, unknown>) => writingStyleDAO.update(id, input))
  ipcMain.handle('style:delete', (_e, id: number) => writingStyleDAO.delete(id))
  ipcMain.handle('style:bindToWork', (_e, workId: number, styleId: number, curve?: string) =>
    writingStyleDAO.bindToWork(workId, styleId, curve))
  ipcMain.handle('style:unbindFromWork', (_e, workId: number, styleId: number) =>
    writingStyleDAO.unbindFromWork(workId, styleId))
  ipcMain.handle('style:getByWork', (_e, workId: number) => writingStyleDAO.getByWork(workId))
  ipcMain.handle('style:getWorkStyleId', (_e, workId: number) => writingStyleDAO.getWorkStyleId(workId))
  ipcMain.handle('style:setWorkStyle', (_e, workId: number, styleId: number | null) =>
    writingStyleDAO.setWorkStyle(workId, styleId))
  ipcMain.handle('style:getWorkStyleBinding', (_e, workId: number) =>
    writingStyleDAO.getWorkStyleBinding(workId))
  ipcMain.handle('style:setWorkEvolutionCurve', (_e, workId: number, curveJson: string | null) =>
    writingStyleDAO.setWorkEvolutionCurve(workId, curveJson))

  // ==================== 模型配置 ====================
  ipcMain.handle('model:list', () => modelConfigDAO.list())
  ipcMain.handle('model:listAssistantOptions', () =>
    buildAssistantModelOptions(modelConfigDAO.list()))
  ipcMain.handle('model:upsert', (_e, type: string, apiKey: string, apiBase?: string, modelName?: string) => {
    try {
      console.log('[IPC] model:upsert called with:', { type, apiKey: apiKey ? '***' : '', apiBase, modelName })
      return modelConfigDAO.upsert(type, apiKey, apiBase, modelName)
    } catch (err) {
      console.error('[IPC Error] model:upsert failed:', err)
      throw err
    }
  })
  ipcMain.handle('model:setEnabled', (_e, type: string, enabled: boolean) => {
    try {
      console.log('[IPC] model:setEnabled called with:', { type, enabled })
      return modelConfigDAO.setEnabled(type, enabled)
    } catch (err) {
      console.error('[IPC Error] model:setEnabled failed:', err)
      throw err
    }
  })
  ipcMain.handle('model:setPriority', (_e, type: string, priority: number) =>
    modelConfigDAO.setPriority(type, priority))
  ipcMain.handle('model:delete', (_e, type: string) => modelConfigDAO.delete(type))
  ipcMain.handle('model:setMaxContextTokens', (_e, type: string, tokens: number) =>
    modelConfigDAO.setMaxContextTokens(type, tokens))
  ipcMain.handle('model:getGlobalDefault', () => appPreferenceDAO.getGlobalLlmDefault())
  ipcMain.handle('model:setGlobalDefault', (_e, provider: string | null, modelName: string | null) =>
    appPreferenceDAO.setGlobalLlmDefault(provider, modelName))
  ipcMain.handle('model:getGenerationParams', () => appPreferenceDAO.getGenerationParams())
  ipcMain.handle('model:setGenerationParams', (_e, params) => appPreferenceDAO.setGenerationParams(params))
  ipcMain.handle('model:refreshCatalog', async (_e, modelType: string) => {
    const config = modelConfigDAO.getByType(modelType)
    if (!config?.api_key) {
      throw new Error('请先配置 API Key')
    }
    const models = await fetchProviderModelCatalog(modelType, config.api_key, config.api_base)
    if (!models.length) {
      throw new Error('未获取到任何模型')
    }
    modelConfigDAO.setAvailableModels(modelType, models)
    if (config.model_name && !models.includes(config.model_name)) {
      modelConfigDAO.upsert(modelType, config.api_key, config.api_base ?? undefined, models[0])
    }
    return models
  })

  // ==================== 锚点 ====================
  ipcMain.handle('anchor:listByWork', (_e, workId: number) => anchorDAO.listByWork(workId))
  ipcMain.handle('anchor:listActive', (_e, workId: number) => anchorDAO.listActiveByWork(workId))
  ipcMain.handle('anchor:create', (_e, input: Record<string, unknown>) => anchorDAO.create(input as unknown as AnchorCreateInput))
  ipcMain.handle('anchor:update', (_e, id: number, fields: Record<string, unknown>) => anchorDAO.update(id, fields))
  ipcMain.handle('anchor:toggleActive', (_e, id: number, active: boolean) => anchorDAO.toggleActive(id, active))
  ipcMain.handle('anchor:delete', (_e, id: number) => anchorDAO.delete(id))
  ipcMain.handle('anchor:parseSuggestions', (_e, content: string) => parseAnchorSuggestions(content))
  ipcMain.handle('anchor:batchCreate', (_e, inputs: AnchorCreateInput[]) => anchorDAO.batchCreate(inputs))
  ipcMain.handle('anchor:checkConflict', (_e, workId: number, input: Record<string, unknown>, excludeId?: number) =>
    detectAnchorConflicts(workId, input as Pick<AnchorCreateInput, 'title' | 'content' | 'type'>, excludeId))

  // ==================== 灵感碎片 ====================
  ipcMain.handle('idea:listByWork', (_e, workId: number) => ideaFragmentDAO.listByWork(workId))
  ipcMain.handle('idea:listOrphan', () => ideaFragmentDAO.listOrphan())
  ipcMain.handle('idea:create', (_e, input: Record<string, unknown>) => ideaFragmentDAO.create(input as unknown as { type: string; content: string; work_id?: number; tags?: string }))
  ipcMain.handle('idea:update', (_e, id: number, fields: Record<string, unknown>) => ideaFragmentDAO.update(id, fields))
  ipcMain.handle('idea:markMerged', (_e, id: number, target: string) => ideaFragmentDAO.markMerged(id, target))
  ipcMain.handle('idea:linkToWork', (_e, id: number, workId: number) => ideaFragmentDAO.linkToWork(id, workId))
  ipcMain.handle('idea:delete', (_e, id: number) => ideaFragmentDAO.delete(id))
  ipcMain.handle('idea:mergeToTarget', (_e, ideaId: number, target: string) => {
    mergeIdeaToTarget(ideaId, target)
  })

  // ==================== AI 收藏 ====================
  ipcMain.handle('favorite:listByWork', (_e, workId: number) => aiFavoriteDAO.listByWork(workId))
  ipcMain.handle('favorite:create', (_e, input: Record<string, unknown>) =>
    aiFavoriteDAO.create(input as {
      work_id: number
      source_step: string
      source_label: string
      content: string
      title?: string
      source_input?: string
    }))
  ipcMain.handle('favorite:update', (_e, id: number, fields: Record<string, unknown>) =>
    aiFavoriteDAO.update(id, fields as { title?: string }))
  ipcMain.handle('favorite:delete', (_e, id: number) => aiFavoriteDAO.delete(id))

  // ==================== 生成记录 ====================
  ipcMain.handle('genlog:listByWork', (_e, workId: number) => generationLogDAO.listByWork(workId))
  ipcMain.handle('genlog:tokenUsage', (_e, workId: number) => generationLogDAO.getTokenUsage(workId))
  ipcMain.handle('genlog:log', (_e, input: Record<string, unknown>) => generationLogDAO.log(input as unknown as { work_id: number; step: string; model_type: string; style_id?: number; prompt_tokens?: number; completion_tokens?: number; duration_ms?: number }))
  ipcMain.handle('genlog:recordReject', (_e, workId: number, step: string, reason: string) => {
    generationLogDAO.log({
      work_id: workId,
      step,
      model_type: 'user_action',
      author_action: 'reject',
      reject_reason: reason
    })
  })

  ipcMain.handle('export:content', (_e, workId: number, title: string, format: 'markdown' | 'txt' | 'html', scope?: { volumeId?: number; chapterId?: number }) =>
    exportWorkContent(workId, title, format, scope))

  // ==================== 核心设定 ====================
  ipcMain.handle('setting:listByWork', (_e, workId: number) => coreSettingDAO.listByWork(workId))
  ipcMain.handle('setting:getMeta', (_e, workId: number, type: string) =>
    coreSettingDAO.getMeta(workId, type))
  ipcMain.handle('setting:versionList', (_e, workId: number, type: string) =>
    coreSettingDAO.listVersions(workId, type))
  ipcMain.handle('setting:restoreVersion', (_e, workId: number, type: string, versionId: number) =>
    coreSettingDAO.restoreVersion(workId, type, versionId))
  ipcMain.handle('setting:upsert', (_e, workId: number, type: string, content: string) =>
    coreSettingDAO.upsert(workId, type, content))
  ipcMain.handle('setting:getConditionRules', (_e, workId: number) => getConditionRules(workId))
  ipcMain.handle('setting:setConditionRules', (_e, workId: number, rules: string[]) => {
    setConditionRules(workId, rules)
    return getConditionRules(workId)
  })
  ipcMain.handle('setting:getAntiAiRules', (_e, workId: number) => getAntiAiRules(workId))
  ipcMain.handle('setting:setAntiAiRules', (_e, workId: number, rules: string[]) => setAntiAiRules(workId, rules))
  ipcMain.handle('setting:appendAntiAiRules', (_e, workId: number, rules: string[]) => appendAntiAiRules(workId, rules))
  ipcMain.handle('setting:getAllAntiAiPresets', (_e, workId: number) => getAllAntiAiPresets(workId))
  ipcMain.handle('setting:getCustomAntiAiPresets', (_e, workId: number) => getCustomAntiAiPresets(workId))
  ipcMain.handle('setting:setCustomAntiAiPresets', (_e, workId: number, presets: AntiAiPreset[]) => setCustomAntiAiPresets(workId, presets))
  ipcMain.handle('antiai:checkViolations', (_e, workId: number, content: string) =>
    checkAntiAiRuleViolations(workId, content))
  ipcMain.handle('antiai:stripEmDashes', (_e, content: string, mode: 'comma' | 'delete' = 'comma') =>
    stripEmDashes(content, mode))
  ipcMain.handle('setting:getWorkReferenceText', (_e, workId: number) =>
    getWorkReferenceText(workId))
  ipcMain.handle('setting:setWorkReferenceText', (_e, workId: number, text: string) =>
    setWorkReferenceText(workId, text))

  ipcMain.handle('antiai:humanize', (_e, content: string, opts?: Record<string, unknown>) => {
    const { humanizeText } = require('./context/humanize-text')
    return humanizeText(content, opts ?? {})
  })
  ipcMain.handle('antiai:measureAiSignature', (_e, content: string) => {
    const { measureAiSignature } = require('./context/humanize-text')
    return measureAiSignature(content)
  })

  ipcMain.handle('context:buildWork', (_e, workId: number, options?: Record<string, boolean>) =>
    buildWorkContext(workId, options ?? {}))

  ipcMain.handle(
    'context:buildSettingsGeneration',
    (
      _e,
      workId: number,
      targetType: CoreSettingGenerateType,
      options?: { selfDraft?: string }
    ) => buildSettingsGenerationContext(workId, targetType, options ?? {})
  )

  ipcMain.handle('alignment:checkContent', (_e, workId: number, content: string, options?: {
    chapterId?: number
    step?: string
    persist?: boolean
  }) => checkAnchorAlignment(workId, content, options))

  ipcMain.handle('incubator:parseExpansion', (_e, content: string) => parseExpansionVersions(content))
  ipcMain.handle('incubator:parseVariants', (_e, content: string) => parseIncubatorVariants(content))

  // ==================== 模型调用 ====================
  ipcMain.handle('model:chat', (e, request: ModelRequest) =>
    modelService.chat(request, { webContents: e.sender }))

  // ==================== 应用信息 ====================
  ipcMain.handle('app:getInfo', () => ({
    version: '2.5.0',
    name: 'ANovel',
    platform: process.platform
  }))

  // ==================== V1.5 叙事记忆体 ====================
  registerV15IpcHandlers()

  // ==================== V2.0 智能进化 ====================
  registerV20IpcHandlers()

  // ==================== V2.5 体验优化 ====================
  registerV25IpcHandlers()

  // ==================== V2.6 写作技巧融合 ====================
  registerV26IpcHandlers()

  // ==================== V2.7 Token 预算与一致性门禁 ====================
  registerV27IpcHandlers()

  // ==================== 应用日志 ====================
  registerLogIpcHandlers()

  // ==================== AI 活动会话 ====================
  registerAiIpcHandlers()

  // ==================== AI 助手（独立 IM） ====================
  registerAssistantIpcHandlers()

  // ==================== AI 实验室 ====================
  registerLabIpcHandlers()
}
