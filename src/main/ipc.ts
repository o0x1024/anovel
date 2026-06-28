import { ipcMain } from 'electron'
import { existsSync, unlinkSync } from 'fs'
import { registerV15IpcHandlers } from './ipc-v15'
import { registerV20IpcHandlers } from './ipc-v20'
import { registerV25IpcHandlers } from './ipc-v25'
import { registerV26IpcHandlers } from './ipc-v26'
import { registerV27IpcHandlers } from './ipc-v27'
import { registerLogIpcHandlers } from './ipc-log'
import { registerAiIpcHandlers } from './ai/register-ai-ipc'
import { registerAssistantIpcHandlers } from './ipc-assistant'
import { registerLabIpcHandlers } from './ipc-lab'
import { registerNamesIpcHandlers } from './ipc-names'
import { registerKnowledgeBaseIpcHandlers } from './ipc-knowledge-base'
import { safeIpcHandle } from './ipc/ipc-safe'
import {
  workDAO, volumeChapterDAO, writingStyleDAO,
  modelConfigDAO, anchorDAO, ideaFragmentDAO, aiFavoriteDAO,
  generationLogDAO, coreSettingDAO, appPreferenceDAO, imageDAO
} from './db'
import type { StyleCreateInput, AnchorCreateInput } from './db'
import { modelService, ModelRequest } from './model'
import { fetchProviderModelCatalog, buildAssistantModelOptions } from './context/model-catalog'
import { appLogger } from './logger/app-logger'
import { generateCustomProviderId, defaultBaseForProtocol, defaultModelForProtocol } from '../shared/model-providers'
import { broadcastStyleChanged } from './style-events'
import { broadcastModelConfigChanged } from './model-events'
import { generateStyleFromDescription } from './context/style-generate'
import { buildWorkContext } from './context/work-context'
import {
  buildSettingsGenerationContext,
  normalizeGenreDetectMode,
  type CoreSettingGenerateType,
  type GenreDetectMode,
  type SettingGenHintsKind,
  type SettingsGenerationContextOptions
} from './context/settings-generation-context'
import {
  settingGenHintsPreferenceKey,
  settingWorldviewGenreDetectModePreferenceKey
} from '../shared/settings-types'
import { parseVolumeSuggestions } from './context/parse-volumes'
import { parseAnchorSuggestions } from './context/parse-anchors'
import { parseChapterSuggestions, parseChapterAbcFromAi, stripOutlineJsonFooter } from './context/parse-chapters'
import { getWorkStepProgress } from './context/work-progress'
import { mergeIdeaToTarget } from './context/idea-merge'
import { parseExpansionVersions } from './context/parse-expansion'
import { parseIncubatorVariants } from './context/parse-variants'
import { registerIncubatorIpcHandlers } from './ipc/incubator-ipc'
import { getConditionRules, setConditionRules } from './context/condition-rules'
import { getAntiAiRules, setAntiAiRules, appendAntiAiRules, suggestRulesFromAiTrace, checkAntiAiRuleViolations, stripEmDashes, getWorkReferenceText, setWorkReferenceText, getAllAntiAiPresets, getCustomAntiAiPresets, setCustomAntiAiPresets, type AntiAiPreset } from './context/anti-ai-rules'
import { humanizeText, measureAiSignature, type HumanizeOptions } from './context/humanize-text'
import { autoRewriteBody } from './context/lab/body-auto-rewrite'
import { runStoryGoalLoop, cancelGoalLoop, isGoalLoopRunning, shouldResumeGoalLoop, type Phase } from './context/goal-routine/story-goal-routine'
import { isGoalRoutinePhase } from '../shared/goal-routine-phases'
import { goalRoutineDAO } from './db'
import { detectAnchorConflicts } from './context/anchor-conflict'
import { exportWorkContent } from './context/export-content'
import { exportWorkBundle, importWorkBundle } from './backup/work-backup'
import {
  getWritingPlanStatus,
  initWritingPlanForWork,
  loadWritingPlan,
  saveWritingPlan,
  applyNovelLengthPreset,
  suggestBatchChapterCount
} from './context/writing-plan'
import type { NovelLength, PresetNovelLength } from '../../shared/writing-plan-presets'
import {
  deleteWorkCoverFile,
  pickAndSetWorkCover,
  removeWorkCover,
  setWorkCoverFromBase64
} from './context/work-cover'
import { pickAndImportManuscript } from './context/work-import'
import {
  clearChapterNarrativeMemory,
  isEmptyChapterContent,
  resolveWorkIdForChapter
} from './context/memory-cleanup'
import { getWorkBodyText } from './context/assistant/work-reference'

/**
 * 注册所有 IPC 处理器，桥接渲染进程与数据库层
 */
export function registerIpcHandlers(): void {
  // ==================== 作品 ====================
  ipcMain.handle('work:list', (_e, workType?: string) => workDAO.list(workType))
  ipcMain.handle('work:get', (_e, id: number) => workDAO.getById(id))
  ipcMain.handle('work:create', (_e, input: { title: string; description?: string; novelLength?: NovelLength; targetTotalWords?: number; targetChapters?: number; wordsPerChapter?: number; workType?: string }) => {
    const id = workDAO.create(input)
    initWritingPlanForWork(id, {
      novelLength: input.novelLength ?? 'medium',
      targetTotalWords: input.targetTotalWords,
      targetChapters: input.targetChapters,
      wordsPerChapter: input.wordsPerChapter
    })
    if (input.workType === 'story') {
      const volumeId = volumeChapterDAO.createVolume(id, '正文', '短故事主线剧情')
      volumeChapterDAO.createChapter(volumeId, '正文', '短故事正文内容')
    }
    return id
  })
  ipcMain.handle('work:update', (_e, id: number, input: Record<string, unknown>) => workDAO.update(id, input))
  // 删除作品：默认软删除进回收站，可恢复；仅 work:purge 彻底清除
  ipcMain.handle('work:delete', (_e, id: number) => workDAO.softDelete(id))
  ipcMain.handle('work:listTrash', (_e, workType?: string) => workDAO.listTrash(workType))
  ipcMain.handle('work:restore', (_e, id: number) => workDAO.restore(id))
  ipcMain.handle('work:importManuscript', (_e, workType: 'novel' | 'story') =>
    pickAndImportManuscript(workType))
  ipcMain.handle('work:purge', (_e, id: number) => {
    const work = workDAO.getById(id)
    deleteWorkCoverFile(work?.cover_image)
    // 清理作品关联的生成图片文件
    const images = imageDAO.listByWork(id)
    for (const img of images) {
      try {
        if (img.local_path && existsSync(img.local_path)) unlinkSync(img.local_path)
      } catch {
        // 忽略文件不存在或锁定
      }
    }
    return workDAO.delete(id)
  })
  ipcMain.handle('work:duplicate', (_e, id: number, newTitle?: string) => {
    const bundle = exportWorkBundle(id)
    if (newTitle) bundle.work.title = newTitle
    return importWorkBundle(bundle)
  })
  ipcMain.handle('work:pickCover', (_e, workId: number) => pickAndSetWorkCover(workId))
  ipcMain.handle('work:setCoverFromBase64', (_e, workId: number, base64: string, fileName: string) =>
    setWorkCoverFromBase64(workId, base64, fileName))
  ipcMain.handle('work:removeCover', (_e, workId: number) => removeWorkCover(workId))
  safeIpcHandle('work:getStepProgress', (_e, workId) => getWorkStepProgress(workId as number))
  ipcMain.handle('work:getStepTemperature', (_e, workId: number) => workDAO.getStepTemperature(workId))
  ipcMain.handle('work:setStepTemperature', (_e, workId: number, partial: Record<string, unknown>) =>
    workDAO.setStepTemperature(workId, partial as Parameters<typeof workDAO.setStepTemperature>[1]))
  ipcMain.handle('work:resetStepTemperature', (_e, workId: number) =>
    workDAO.resetStepTemperature(workId))
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
  ipcMain.handle('chapter:update', (_e, id: number, fields: Record<string, unknown>) => {
    // 若修改了正文内容，自动创建历史快照
    if (fields.content !== undefined) {
      if (isEmptyChapterContent(fields.content)) {
        const workId = resolveWorkIdForChapter(id)
        if (workId != null) {
          clearChapterNarrativeMemory(workId, id)
        }
      }
      return volumeChapterDAO.updateChapterWithVersion(id, fields as Parameters<typeof volumeChapterDAO.updateChapterWithVersion>[1])
    }
    return volumeChapterDAO.updateChapter(id, fields as Parameters<typeof volumeChapterDAO.updateChapter>[1])
  })
  ipcMain.handle('chapter:delete', (_e, id: number) => volumeChapterDAO.deleteChapter(id))
  ipcMain.handle('chapter:listVersions', (_e, chapterId: number) =>
    volumeChapterDAO.listVersions(chapterId))
  ipcMain.handle('chapter:getVersion', (_e, versionId: number, chapterId: number) =>
    volumeChapterDAO.getVersion(versionId, chapterId))
  ipcMain.handle('chapter:batchCreate', (_e, volumeId: number, items: { title: string; outline?: string }[], mode?: 'append' | 'replace') =>
    volumeChapterDAO.batchCreateChapters(volumeId, items, mode ?? 'append'))
  ipcMain.handle('chapter:parseSuggestions', (_e, content: string) => parseChapterSuggestions(content, false))
  ipcMain.handle('chapter:parseAbc', (_e, content: string) => parseChapterAbcFromAi(content))
  ipcMain.handle('chapter:stripOutline', (_e, content: string) => stripOutlineJsonFooter(content))
  ipcMain.handle('chapter:reorder', (_e, orderedIds: number[]) =>
    volumeChapterDAO.reorderChapters(orderedIds))
  ipcMain.handle('chapter:move', (_e, chapterId: number, targetVolumeId: number, targetSort: number) =>
    volumeChapterDAO.moveChapter(chapterId, targetVolumeId, targetSort))

  ipcMain.handle('volume:reorder', (_e, orderedIds: number[]) =>
    volumeChapterDAO.reorderVolumes(orderedIds))

  ipcMain.handle('writingPlan:get', (_e, workId: number) => loadWritingPlan(workId))
  ipcMain.handle('writingPlan:update', (_e, workId: number, input: { targetTotalWords?: number; targetChapters?: number; wordsPerChapter?: number; novelLength?: NovelLength }) =>
    saveWritingPlan(workId, input))
  ipcMain.handle('writingPlan:applyNovelLength', (_e, workId: number, novelLength: PresetNovelLength) =>
    applyNovelLengthPreset(workId, novelLength))
  ipcMain.handle('writingPlan:getStatus', (_e, workId: number) => getWritingPlanStatus(workId))
  ipcMain.handle('writingPlan:suggestBatchCount', (_e, workId: number, volumeId: number) => {
    const status = getWritingPlanStatus(workId)
    const vol = status.volumes.find(v => v.id === volumeId)
    if (status.plan.workType === 'story') {
      const remaining = Math.max(0, vol?.gap ?? 0)
      return remaining > 0 ? Math.min(10, remaining) : 1
    }
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
  ipcMain.handle('style:create', (_e, input: Record<string, unknown>) => {
    const id = writingStyleDAO.create(input as unknown as StyleCreateInput)
    broadcastStyleChanged(id)
    return id
  })
  ipcMain.handle('style:update', (_e, id: number, input: Record<string, unknown>) => {
    const ok = writingStyleDAO.update(id, input)
    if (ok) broadcastStyleChanged(id)
    return ok
  })
  ipcMain.handle('style:delete', (_e, id: number) => {
    const ok = writingStyleDAO.delete(id)
    if (ok) broadcastStyleChanged(null)
    return ok
  })
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
  ipcMain.handle('style:generateFromDescription', (e, description: string) =>
    generateStyleFromDescription(description, { webContents: e.sender }))

  // ==================== 模型配置 ====================
  ipcMain.handle('model:list', () => modelConfigDAO.list())
  ipcMain.handle('model:listAssistantOptions', () =>
    buildAssistantModelOptions(modelConfigDAO.list()))
  ipcMain.handle('model:upsert', (_e, type: string, apiKey: string, apiBase?: string, modelName?: string, displayName?: string, providerProtocol?: string) => {
    try {
      console.log('[IPC] model:upsert called with:', { type, apiKey: apiKey ? '***' : '', apiBase, modelName, displayName, providerProtocol })
      modelConfigDAO.upsert(type, apiKey, apiBase, modelName, displayName ?? null, providerProtocol ?? null)
      broadcastModelConfigChanged()
    } catch (err) {
      console.error('[IPC Error] model:upsert failed:', err)
      throw err
    }
  })
  ipcMain.handle('model:createCustom', (_e, displayName: string, providerProtocol: string, apiKey?: string, apiBase?: string, modelName?: string) => {
    const modelType = generateCustomProviderId()
    const protocol = providerProtocol as 'openai' | 'gemini' | 'anthropic'
    modelConfigDAO.createCustom(
      modelType,
      displayName.trim(),
      protocol,
      apiKey?.trim() ?? '',
      apiBase?.trim() || defaultBaseForProtocol(protocol),
      modelName?.trim() || defaultModelForProtocol(protocol)
    )
    broadcastModelConfigChanged()
    return modelType
  })
  ipcMain.handle('model:setEnabled', (_e, type: string, enabled: boolean) => {
    try {
      console.log('[IPC] model:setEnabled called with:', { type, enabled })
      const ok = modelConfigDAO.setEnabled(type, enabled)
      if (ok) broadcastModelConfigChanged()
      return ok
    } catch (err) {
      console.error('[IPC Error] model:setEnabled failed:', err)
      throw err
    }
  })
  ipcMain.handle('model:setPriority', (_e, type: string, priority: number) =>
    modelConfigDAO.setPriority(type, priority))
  ipcMain.handle('model:delete', (_e, type: string) => {
    const ok = modelConfigDAO.delete(type)
    if (ok) broadcastModelConfigChanged()
    return ok
  })
  ipcMain.handle('model:setMaxContextTokens', (_e, type: string, tokens: number) =>
    modelConfigDAO.setMaxContextTokens(type, tokens))
  ipcMain.handle('model:setProviderOptions', (_e, type: string, optionsJson: string | null) =>
    modelConfigDAO.setProviderOptions(type, optionsJson))
  ipcMain.handle('model:getGlobalDefault', () => appPreferenceDAO.getGlobalLlmDefault())
  ipcMain.handle('model:setGlobalDefault', (_e, provider: string | null, modelName: string | null) => {
    const result = appPreferenceDAO.setGlobalLlmDefault(provider, modelName)
    broadcastModelConfigChanged()
    return result
  })
  ipcMain.handle('model:getGenerationParams', () => appPreferenceDAO.getGenerationParams())
  ipcMain.handle('model:setGenerationParams', (_e, params) => appPreferenceDAO.setGenerationParams(params))
  ipcMain.handle('model:refreshCatalog', async (_e, modelType: string) => {
    const config = modelConfigDAO.getByType(modelType)
    if (!config?.api_key) {
      throw new Error('请先配置 API Key')
    }
    try {
      const models = await fetchProviderModelCatalog(
        modelType,
        config.api_key,
        config.api_base,
        config.provider_protocol
      )
      if (!models.length) {
        throw new Error('未获取到任何模型')
      }
      modelConfigDAO.setAvailableModels(modelType, models)
      if (config.model_name && !models.includes(config.model_name)) {
        modelConfigDAO.upsert(modelType, config.api_key, config.api_base ?? undefined, models[0])
      }
      appLogger.info('settings', '刷新模型列表成功', {
        modelType,
        apiBase: config.api_base,
        modelCount: models.length
      })
      broadcastModelConfigChanged()
      return models
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      appLogger.error('settings', '刷新模型列表失败', {
        modelType,
        apiBase: config.api_base,
        error: message
      })
      throw err
    }
  })

  ipcMain.handle('model:getStepModelOverrides', () =>
    appPreferenceDAO.getStepModelOverrides())
  ipcMain.handle('model:setStepModelOverrides', (_e, overrides: Record<string, { provider: string; modelName: string; thinkingEnabled?: boolean }>) => {
    appPreferenceDAO.setStepModelOverrides(overrides)
    return appPreferenceDAO.getStepModelOverrides()
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

  ipcMain.handle('export:content', (_e, workId: number, title: string, format: 'markdown' | 'txt' | 'html', scope?: { volumeId?: number; chapterId?: number }, mode?: 'full' | 'body') =>
    exportWorkContent(workId, title, format, scope, mode ?? 'full'))

  // ==================== 核心设定 ====================
  ipcMain.handle('setting:listByWork', (_e, workId: number) => coreSettingDAO.listByWork(workId))
  ipcMain.handle('setting:getMeta', (_e, workId: number, type: string) =>
    coreSettingDAO.getMeta(workId, type))
  ipcMain.handle('setting:versionList', (_e, workId: number, type: string) =>
    coreSettingDAO.listVersions(workId, type))
  ipcMain.handle('setting:restoreVersion', (_e, workId: number, type: string, versionId: number) =>
    coreSettingDAO.restoreVersion(workId, type, versionId))
  ipcMain.handle('setting:upsert', (_e, workId: number, type: string, content: string) => {
    const trimmed = (content as string).trim()
    const clearable = type === 'protagonist' || type === 'golden_finger' || type === 'pleasure_engine' || type === 'world_pressure' || type === 'conflict_engine' || type === 'supporting_cast'
    if (!trimmed && clearable) {
      const row = coreSettingDAO.getByType(workId, type)
      if (row) coreSettingDAO.delete(row.id)
      return
    }
    coreSettingDAO.upsert(workId, type, trimmed)
  })
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
  ipcMain.handle('setting:getGenHints', (_e, workId: number, kind: SettingGenHintsKind) =>
    appPreferenceDAO.getPreference(settingGenHintsPreferenceKey(workId, kind)) ?? '')
  ipcMain.handle('setting:setGenHints', (_e, workId: number, kind: SettingGenHintsKind, text: string) => {
    appPreferenceDAO.setPreference(settingGenHintsPreferenceKey(workId, kind), (text as string).trim())
    return true
  })
  ipcMain.handle('setting:getWorldviewGenreDetectMode', (_e, workId: number) =>
    normalizeGenreDetectMode(appPreferenceDAO.getPreference(settingWorldviewGenreDetectModePreferenceKey(workId))))
  ipcMain.handle('setting:setWorldviewGenreDetectMode', (_e, workId: number, mode: GenreDetectMode) => {
    appPreferenceDAO.setPreference(
      settingWorldviewGenreDetectModePreferenceKey(workId),
      normalizeGenreDetectMode(mode)
    )
    return true
  })
  ipcMain.handle('setting:getCharacterGenHints', (_e, workId: number) =>
    appPreferenceDAO.getPreference(settingGenHintsPreferenceKey(workId, 'supporting_cast')) ?? '')
  ipcMain.handle('setting:setCharacterGenHints', (_e, workId: number, text: string) => {
    appPreferenceDAO.setPreference(settingGenHintsPreferenceKey(workId, 'supporting_cast'), (text as string).trim())
    return true
  })

  ipcMain.handle('antiai:humanize', (_e, content: string, opts?: HumanizeOptions) =>
    humanizeText(content, opts ?? {}))
  ipcMain.handle('antiai:measureAiSignature', (_e, content: string) =>
    measureAiSignature(content))
  ipcMain.handle('antiai:autoRewriteBody', (_e, content: string) =>
    autoRewriteBody(content))

  // ==================== 目标循环（goal routine）====================
  ipcMain.handle('goal:start', (e, workId: number, config?: Record<string, unknown>) => {
    let forcePhase: Phase | undefined
    let cfg: Record<string, unknown> = config ?? {}
    if (config) {
      const { forcePhase: fp, ...rest } = config
      forcePhase = typeof fp === 'string' && isGoalRoutinePhase(fp) ? fp : undefined
      cfg = rest
    }
    const resume = shouldResumeGoalLoop(workId) || Boolean(forcePhase)
    void runStoryGoalLoop(workId, cfg, e.sender, resume, forcePhase).catch((err) => {
      appLogger.error('goal_routine', '目标循环启动失败', { workId, error: String(err) })
    })
    return true
  })
  ipcMain.handle('goal:resume', (e, workId: number, options?: Record<string, unknown> | string) => {
    let forcePhase: Phase | undefined
    let config: Record<string, unknown> = {}
    if (typeof options === 'string') {
      forcePhase = isGoalRoutinePhase(options) ? options : undefined
    } else if (options) {
      const { forcePhase: fp, ...rest } = options
      forcePhase = typeof fp === 'string' && isGoalRoutinePhase(fp) ? fp : undefined
      config = rest
    }
    void runStoryGoalLoop(workId, config, e.sender, true, forcePhase).catch((err) => {
      appLogger.error('goal_routine', '目标循环续跑失败', { workId, error: String(err) })
    })
    return true
  })
  ipcMain.handle('goal:cancel', (_e, workId: number) => cancelGoalLoop(workId))
  ipcMain.handle('goal:getState', (_e, workId: number) => {
    const state = goalRoutineDAO.getByWork(workId)
    const turns = goalRoutineDAO.listTurns(workId, 30)
    return { state: state ?? null, turns }
  })
  ipcMain.handle('goal:isRunning', (_e, workId: number) => isGoalLoopRunning(workId))

  ipcMain.handle('context:buildWork', (_e, workId: number, options?: Record<string, boolean>) =>
    buildWorkContext(workId, options ?? {}))

  ipcMain.handle(
    'context:buildSettingsGeneration',
    async (
      _e,
      workId: number,
      targetType: CoreSettingGenerateType,
      options?: SettingsGenerationContextOptions
    ) => await buildSettingsGenerationContext(workId, targetType, options ?? {})
  )

  safeIpcHandle('incubator:parseExpansion', (_e, content) =>
    parseExpansionVersions(content as string))
  safeIpcHandle('incubator:parseVariants', (_e, content, legacyFallback) =>
    parseIncubatorVariants(content as string, (legacyFallback as boolean | undefined) ?? false))
  safeIpcHandle('incubator:parseAnchors', (_e, content) => {
    const text = (content as string).trim()
    // 提取 JSON 数组
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
      ?? text.match(/(\[[\s\S]*\])/)
    if (!fenced) return []
    try {
      const arr = JSON.parse(fenced[1] ?? fenced[0])
      if (!Array.isArray(arr)) return []
      return arr.map((a: Record<string, unknown>) => ({
        title: String(a.title ?? ''),
        summary: String(a.content ?? ''),
        dimension: [String(a.type ?? 'plot'), a.scope ? `范围:${a.scope}` : ''].filter(Boolean).join(' · ')
      }))
    } catch {
      return []
    }
  })

  registerIncubatorIpcHandlers()

  // ==================== 模型调用 ====================
  safeIpcHandle('model:chat', (e, request) =>
    modelService.chat(request as ModelRequest, { webContents: e.sender }))

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

  // ==================== 名称库 ====================
  registerNamesIpcHandlers()

  // ==================== 知识库 ====================
  registerKnowledgeBaseIpcHandlers()

}
