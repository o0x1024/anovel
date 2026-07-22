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
  generationLogDAO, coreSettingDAO, appPreferenceDAO, imageDAO, storyHarnessDAO, causalNovelDAO,
  storyStateDAO, emotionalStateDAO
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
import {
  applyCausalStyleRewrite,
  generateCausalStyleRewritePreview
} from './context/causal-chapter-style-rewrite'
import {
  applyCausalChapterEdit,
  cancelCausalChapterReplay,
  previewCausalChapterEdit,
  type CausalManualEditKind
} from './context/causal-chapter-edit'
import {
  runStoryGoalLoop,
  cancelGoalLoop,
  isGoalLoopRunning,
  applyGoalTitleHookSelection,
  type Phase
} from './context/goal-routine/story-goal-routine'
import { runNovelGoalLoop, cancelNovelGoalLoop, isNovelGoalLoopRunning } from './context/goal-routine/novel-goal-routine'
import {
  runCausalNovelGoalLoop,
  cancelCausalNovelGoalLoop,
  isCausalNovelGoalLoopRunning
} from './context/goal-routine/causal-novel-routine'
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
import type { NovelLength, PresetNovelLength } from '../shared/writing-plan-presets'
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
import { ensureChapterEmotionContract } from './context/goal-routine/emotion-engine'
import { assessChapterEmotion } from './context/goal-routine/emotion-gate'
import {
  invalidateNovelGoalStateAfterVolumeDeletion,
  resetNovelGoalStateFromVolumePlan
} from './context/goal-routine/novel-outline-pipeline'
import { getChapterPlanningDetails } from './context/chapter-planning-details'

/**
 * 注册所有 IPC 处理器，桥接渲染进程与数据库层
 */
export function registerIpcHandlers(): void {
  const assertCausalChapterDirectMutationAllowed = (chapterId: number, action: string): void => {
    const workId = volumeChapterDAO.getWorkIdForChapter(chapterId)
    if (workId == null || workDAO.getById(workId)?.work_type !== 'causal_novel') return
    if (isCausalNovelGoalLoopRunning(workId)) {
      throw new Error(`滚动因果正在运行，请暂停后再${action}`)
    }
    const decision = causalNovelDAO.getDecision(chapterId)
    if (decision?.status === 'committed') {
      throw new Error('已提交章节已冻结；如只调整表达，请使用“AI 按当前文风重写”。涉及事实的修改必须通过因果重放流程')
    }
  }
  const assertCausalVolumeDirectMutationAllowed = (volumeId: number, action: string): void => {
    const volume = volumeChapterDAO.getVolume(volumeId)
    if (!volume || workDAO.getById(volume.work_id)?.work_type !== 'causal_novel') return
    if (isCausalNovelGoalLoopRunning(volume.work_id)) throw new Error(`滚动因果正在运行，请暂停后再${action}`)
    throw new Error('因果小说的“滚动正文”由权威状态管理，不能通过通用分卷入口修改')
  }
  const assertCausalChapterStructuralMutationAllowed = (chapterId: number, action: string): void => {
    const workId = volumeChapterDAO.getWorkIdForChapter(chapterId)
    if (workId == null || workDAO.getById(workId)?.work_type !== 'causal_novel') return
    if (isCausalNovelGoalLoopRunning(workId)) throw new Error(`滚动因果正在运行，请暂停后再${action}`)
    throw new Error('因果小说的章节顺序由状态修订号决定，不能直接移动或重排')
  }

  // ==================== 作品 ====================
  ipcMain.handle('work:list', (_e, workType?: string) => workDAO.list(workType))
  ipcMain.handle('work:get', (_e, id: number) => workDAO.getById(id))
  ipcMain.handle('work:create', (_e, input: { title: string; description?: string; novelLength?: NovelLength; targetTotalWords?: number; targetChapters?: number; wordsPerChapter?: number; workType?: string; genre?: string; tags?: string }) => {
    const id = workDAO.create(input)
    initWritingPlanForWork(id, {
      novelLength: input.novelLength ?? 'medium',
      targetTotalWords: input.targetTotalWords,
      targetChapters: input.targetChapters,
      wordsPerChapter: input.wordsPerChapter
    })
    const defaults = appPreferenceDAO.getDefaultWritingStyles()
    const defaultStyleId = input.workType === 'story'
      ? defaults.storyStyleId
      : defaults.novelStyleId
    if (defaultStyleId && writingStyleDAO.getById(defaultStyleId)) {
      writingStyleDAO.setWorkStyle(id, defaultStyleId)
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
  ipcMain.handle('volume:update', (_e, id: number, fields: Record<string, unknown>) => {
    assertCausalVolumeDirectMutationAllowed(id, '修改分卷')
    return volumeChapterDAO.updateVolume(id, fields)
  })
  ipcMain.handle('volume:delete', (_e, id: number) => {
    assertCausalVolumeDirectMutationAllowed(id, '删除分卷')
    const volume = volumeChapterDAO.getVolume(id)
    const deleted = volumeChapterDAO.deleteVolume(id)
    if (deleted && volume && workDAO.getById(volume.work_id)?.work_type !== 'story') {
      invalidateNovelGoalStateAfterVolumeDeletion(volume.work_id, volume.name)
    }
    return deleted
  })
  ipcMain.handle('volume:batchUpsert', (_e, workId: number, items: { name: string; description?: string }[], mode?: 'append' | 'replace') => {
    if (workDAO.getById(workId)?.work_type === 'causal_novel') {
      throw new Error('因果小说不支持通用分卷批量写入')
    }
    const resolvedMode = mode ?? 'append'
    const ids = volumeChapterDAO.batchUpsertVolumes(workId, items, resolvedMode)
    if (resolvedMode === 'replace' && workDAO.getById(workId)?.work_type !== 'story') {
      resetNovelGoalStateFromVolumePlan(workId)
    }
    return ids
  })
  ipcMain.handle('volume:parseSuggestions', (_e, content: string) => parseVolumeSuggestions(content))

  ipcMain.handle('chapter:list', (_e, volumeId: number) => volumeChapterDAO.listChapters(volumeId))
  ipcMain.handle('chapter:listByWork', (_e, workId: number) => volumeChapterDAO.listChaptersByWork(workId))
  ipcMain.handle('chapter:get', (_e, id: number) => volumeChapterDAO.getChapter(id))
  ipcMain.handle('chapter:getPlanningDetails', (_e, workId: number, chapterId: number) =>
    getChapterPlanningDetails(workId, chapterId))
  ipcMain.handle('chapter:create', (_e, volumeId: number, title: string, outline?: string) => {
    const volume = volumeChapterDAO.getVolume(volumeId)
    if (volume && workDAO.getById(volume.work_id)?.work_type === 'causal_novel') {
      throw new Error('因果小说不能通过通用章节入口新增正文，请使用因果章节管理中的“新增非权威草稿”')
    }
    return volumeChapterDAO.createChapter(volumeId, title, outline)
  })
  ipcMain.handle('chapter:update', (_e, id: number, fields: Record<string, unknown>) => {
    assertCausalChapterDirectMutationAllowed(id, '修改章节')
    const causalDecision = causalNovelDAO.getDecision(id)
    if (causalDecision && typeof fields.title === 'string') {
      const currentTitle = volumeChapterDAO.getChapter(id)?.title ?? ''
      if (fields.title.trim() !== currentTitle) {
        throw new Error('因果决策已冻结章节标题，不能通过通用章节入口修改')
      }
    }
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
  ipcMain.handle('chapter:delete', (_e, id: number) => {
    assertCausalChapterDirectMutationAllowed(id, '删除章节')
    return volumeChapterDAO.deleteChapter(id)
  })
  ipcMain.handle('chapter:listVersions', (_e, chapterId: number) =>
    volumeChapterDAO.listVersions(chapterId))
  ipcMain.handle('chapter:getVersion', (_e, versionId: number, chapterId: number) =>
    volumeChapterDAO.getVersion(versionId, chapterId))
  ipcMain.handle('chapter:batchCreate', (_e, volumeId: number, items: { title: string; outline?: string }[], mode?: 'append' | 'replace') => {
    const volume = volumeChapterDAO.getVolume(volumeId)
    if (volume && workDAO.getById(volume.work_id)?.work_type === 'causal_novel') {
      throw new Error('因果小说不支持通用章节批量写入')
    }
    return volumeChapterDAO.batchCreateChapters(volumeId, items, mode ?? 'append')
  })
  ipcMain.handle('chapter:parseSuggestions', (_e, content: string) => parseChapterSuggestions(content, false))
  ipcMain.handle('chapter:parseAbc', (_e, content: string) => parseChapterAbcFromAi(content))
  ipcMain.handle('chapter:stripOutline', (_e, content: string) => stripOutlineJsonFooter(content))
  ipcMain.handle('chapter:reorder', (_e, orderedIds: number[]) => {
    for (const id of orderedIds) assertCausalChapterStructuralMutationAllowed(id, '调整章节顺序')
    return volumeChapterDAO.reorderChapters(orderedIds)
  })
  ipcMain.handle('chapter:move', (_e, chapterId: number, targetVolumeId: number, targetSort: number) => {
    assertCausalChapterStructuralMutationAllowed(chapterId, '移动章节')
    return volumeChapterDAO.moveChapter(chapterId, targetVolumeId, targetSort)
  })

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
    if (ok) {
      const defaults = appPreferenceDAO.getDefaultWritingStyles()
      if (defaults.novelStyleId === id) appPreferenceDAO.setDefaultWritingStyle('novel', null)
      if (defaults.storyStyleId === id) appPreferenceDAO.setDefaultWritingStyle('story', null)
      broadcastStyleChanged(null)
    }
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
  ipcMain.handle('style:getDefaults', () => {
    const defaults = appPreferenceDAO.getDefaultWritingStyles()
    return {
      novelStyleId: defaults.novelStyleId && writingStyleDAO.getById(defaults.novelStyleId)
        ? defaults.novelStyleId
        : null,
      storyStyleId: defaults.storyStyleId && writingStyleDAO.getById(defaults.storyStyleId)
        ? defaults.storyStyleId
        : null
    }
  })
  ipcMain.handle('style:setDefault', (_e, workType: 'novel' | 'story', styleId: number | null) => {
    if (workType !== 'novel' && workType !== 'story') throw new Error('无效的作品类型')
    if (styleId !== null && (!Number.isInteger(styleId) || !writingStyleDAO.getById(styleId))) {
      throw new Error('所选文风不存在')
    }
    return appPreferenceDAO.setDefaultWritingStyle(workType, styleId)
  })
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

  ipcMain.handle('setting:getStructured', (_e, workId: number, type: string) => {
    const raw = coreSettingDAO.getStructuredContent(workId, type)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  })

  ipcMain.handle('setting:upsertStructured', (_e, workId: number, type: string, content: string, structured: unknown) => {
    coreSettingDAO.upsertStructured(workId, type, (content as string).trim(), JSON.stringify(structured))
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

  ipcMain.handle('emotion:ensureContract', async (_e, workId: number, chapterId: number, goal = '') =>
    ensureChapterEmotionContract(workId, chapterId, goal))
  ipcMain.handle('emotion:assessChapter', async (
    _e,
    workId: number,
    chapterId: number,
    content: string,
    persistLedger = false,
    persistAssessment = true
  ) => assessChapterEmotion(workId, chapterId, content, undefined, persistLedger, persistAssessment))

  // ==================== 目标循环（goal routine）====================
  function isNovelWork(workId: number): boolean {
    const workType = workDAO.getById(workId)?.work_type
    return workType === 'novel' || workType === 'causal_novel'
  }

  function isCausalNovelWork(workId: number): boolean {
    return workDAO.getById(workId)?.work_type === 'causal_novel'
  }

  function resolveGoalForcePhase(config?: Record<string, unknown>): { forcePhase?: Phase; cfg: Record<string, unknown> } {
    if (!config) return { cfg: {} }
    const { forcePhase: fp, ...rest } = config
    const forcePhase = typeof fp === 'string' && isGoalRoutinePhase(fp) ? fp : undefined
    return { forcePhase, cfg: rest }
  }

  ipcMain.handle('goal:start', (e, workId: number, config?: Record<string, unknown>) => {
    const { forcePhase, cfg } = resolveGoalForcePhase(config)
    const runner = isCausalNovelWork(workId)
      ? runCausalNovelGoalLoop(workId, cfg, e.sender, false)
      : isNovelWork(workId)
      ? runNovelGoalLoop(workId, cfg, e.sender, false, forcePhase)
      : runStoryGoalLoop(workId, cfg, e.sender, false, forcePhase)
    void runner.catch((err) => {
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
    const runner = isCausalNovelWork(workId)
      ? runCausalNovelGoalLoop(workId, config, e.sender, true)
      : isNovelWork(workId)
      ? runNovelGoalLoop(workId, config, e.sender, true, forcePhase)
      : runStoryGoalLoop(workId, config, e.sender, true, forcePhase)
    void runner.catch((err) => {
      appLogger.error('goal_routine', '目标循环续跑失败', { workId, error: String(err) })
    })
    return true
  })
  ipcMain.handle('goal:cancel', (_e, workId: number) => {
    return isCausalNovelWork(workId)
      ? cancelCausalNovelGoalLoop(workId)
      : isNovelWork(workId) ? cancelNovelGoalLoop(workId) : cancelGoalLoop(workId)
  })
  ipcMain.handle('goal:selectTitleHook', (_e, workId: number, candidateIndex: number) => {
    if (isNovelWork(workId)) throw new Error('小说目标循环暂不支持此书名导语确认流程')
    return applyGoalTitleHookSelection(workId, candidateIndex)
  })
  ipcMain.handle('goal:getState', (_e, workId: number) => {
    const state = goalRoutineDAO.getByWork(workId)
    const turns = goalRoutineDAO.listTurns(workId, 30)
    const harnessIssues = isNovelWork(workId) ? [] : storyHarnessDAO.listIssues(workId)
    return { state: state ?? null, turns, harnessIssues }
  })
  ipcMain.handle('causal:getState', (_e, workId: number) => ({
    state: causalNovelDAO.getState(workId),
    decisions: causalNovelDAO.listDecisions(workId),
    planAttempts: causalNovelDAO.listPlanAttempts(workId, 20).map(item => ({
      id: item.id,
      stateRevision: item.stateRevision,
      stage: item.stage,
      status: item.status,
      errorCode: item.errorCode,
      errorMessage: item.errorMessage,
      responseHash: item.responseHash,
      createTime: item.createTime
    })),
    chapters: volumeChapterDAO.listChaptersByWork(workId).map(chapter => ({
      id: chapter.id,
      title: chapter.title,
      status: chapter.status,
      hasContent: Boolean(chapter.content?.trim()),
      wordCount: chapter.word_count
    }))
  }))
  ipcMain.handle('causal:listStateRevisions', (_e, workId: number, limit = 100) => {
    if (!isCausalNovelWork(workId)) throw new Error('该作品不是因果小说')
    return causalNovelDAO.listStateRevisions(workId, limit).map(item => ({
      revision: item.revision,
      sourceChapterId: item.sourceChapterId,
      transitionType: item.transitionType,
      bodyHash: item.bodyHash,
      createTime: item.createTime
    }))
  })
  ipcMain.handle('causal:getStateRevision', (_e, workId: number, revision: number) => {
    if (!isCausalNovelWork(workId)) throw new Error('该作品不是因果小说')
    return causalNovelDAO.getStateRevision(workId, revision)
  })
  ipcMain.handle('causal:createChapter', (_e, workId: number, rawTitle: string) => {
    if (!isCausalNovelWork(workId)) throw new Error('该作品不是因果小说')
    void rawTitle
    throw new Error('因果小说正文只能由“候选决策 → 正文门禁 → 状态提交”事务创建，不支持手动新增章节')
  })
  ipcMain.handle('causal:updateChapter', (_e, workId: number, chapterId: number, input: {
    title?: string
    content?: string
    expectedUpdateTime?: string
  }) => {
    if (!isCausalNovelWork(workId)) throw new Error('该作品不是因果小说')
    if (volumeChapterDAO.getWorkIdForChapter(chapterId) !== workId) throw new Error('章节不属于当前因果小说')
    assertCausalChapterDirectMutationAllowed(chapterId, '修改章节')
    const current = volumeChapterDAO.getChapter(chapterId)
    if (!current) throw new Error('章节不存在')
    if (input.expectedUpdateTime && input.expectedUpdateTime !== current.update_time) {
      throw new Error('章节已被其他操作修改，请刷新后重试')
    }
    const fields: Parameters<typeof volumeChapterDAO.updateChapterWithVersion>[1] = {}
    if (input.title !== undefined) {
      const title = input.title.trim()
      if (!title) throw new Error('章节标题不能为空')
      if (title !== current.title && causalNovelDAO.getDecision(chapterId)) {
        throw new Error('因果决策已冻结章节标题；如需更换决策，请删除尚未提交的自动草稿后重新滚动')
      }
      if (title !== current.title) fields.title = title
    }
    if (input.content !== undefined && input.content !== (current.content ?? '')) {
      fields.content = input.content
      fields.word_count = input.content.replace(/\s/g, '').length
    }
    if (Object.keys(fields).length === 0) return true
    fields.expectedUpdateTime = input.expectedUpdateTime
    return fields.content !== undefined
      ? volumeChapterDAO.updateChapterWithVersion(chapterId, fields, { model_type: 'manual' })
      : volumeChapterDAO.updateChapter(chapterId, fields)
  })
  ipcMain.handle('causal:previewChapterEdit', async (_e, input: {
    workId: number
    chapterId: number
    candidateContent: string
    editKind: CausalManualEditKind
  }) => {
    if (!isCausalNovelWork(input.workId)) throw new Error('该作品不是因果小说')
    if (isCausalNovelGoalLoopRunning(input.workId)) throw new Error('滚动因果正在运行，请暂停后再编辑章节')
    return previewCausalChapterEdit(input)
  })
  ipcMain.handle('causal:applyChapterEdit', (_e, input: {
    workId: number
    chapterId: number
    candidateContent: string
    editKind: CausalManualEditKind
    currentVersionId: number
    expectedUpdateTime: string
    validationToken: string
  }) => {
    if (!isCausalNovelWork(input.workId)) throw new Error('该作品不是因果小说')
    if (isCausalNovelGoalLoopRunning(input.workId)) throw new Error('滚动因果正在运行，请暂停后再编辑章节')
    return applyCausalChapterEdit(input)
  })
  ipcMain.handle('causal:listReplayJobs', (_e, workId: number, limit = 50) => {
    if (!isCausalNovelWork(workId)) throw new Error('该作品不是因果小说')
    return causalNovelDAO.listReplayJobs(workId, limit)
  })
  ipcMain.handle('causal:retryReplay', (_e, workId: number, replayJobId: number) => {
    if (!isCausalNovelWork(workId)) throw new Error('该作品不是因果小说')
    if (isCausalNovelGoalLoopRunning(workId)) throw new Error('滚动因果正在运行，请先暂停')
    const job = causalNovelDAO.getReplayJob(replayJobId)
    if (!job || job.workId !== workId) throw new Error('因果重放任务不存在')
    if (job.status !== 'blocked') throw new Error('只有冲突停止的重放任务可以重试')
    causalNovelDAO.retryReplay(replayJobId)
    return true
  })
  ipcMain.handle('causal:cancelReplay', (_e, workId: number, replayJobId: number) => {
    if (!isCausalNovelWork(workId)) throw new Error('该作品不是因果小说')
    if (isCausalNovelGoalLoopRunning(workId)) throw new Error('滚动因果正在运行，请先暂停')
    return cancelCausalChapterReplay(workId, replayJobId)
  })
  ipcMain.handle('causal:deleteChapter', (_e, workId: number, chapterId: number) => {
    if (!isCausalNovelWork(workId)) throw new Error('该作品不是因果小说')
    if (volumeChapterDAO.getWorkIdForChapter(chapterId) !== workId) throw new Error('章节不属于当前因果小说')
    assertCausalChapterDirectMutationAllowed(chapterId, '删除章节')
    return volumeChapterDAO.deleteChapter(chapterId)
  })
  ipcMain.handle('causal:rewriteChapterPreview', async (_e, workId: number, chapterId: number) => {
    if (!isCausalNovelWork(workId)) throw new Error('该作品不是因果小说')
    if (isCausalNovelGoalLoopRunning(workId)) throw new Error('滚动因果正在运行，请暂停后再重写章节')
    return generateCausalStyleRewritePreview(workId, chapterId)
  })
  ipcMain.handle('causal:applyChapterRewrite', (_e, input: {
    workId: number
    chapterId: number
    candidateContent: string
    expectedUpdateTime: string
    validationToken: string
  }) => {
    if (!isCausalNovelWork(input.workId)) throw new Error('该作品不是因果小说')
    if (isCausalNovelGoalLoopRunning(input.workId)) throw new Error('滚动因果正在运行，请暂停后再应用重写')
    return applyCausalStyleRewrite(input)
  })
  ipcMain.handle('causal:getChapterDetail', (_e, workId: number, chapterId: number) => {
    if (!isCausalNovelWork(workId)) throw new Error('该作品不是因果小说')
    if (volumeChapterDAO.getWorkIdForChapter(chapterId) !== workId) throw new Error('章节不属于当前因果小说')
    const chapter = volumeChapterDAO.getChapter(chapterId)
    if (!chapter) throw new Error('章节不存在')
    const parseJson = (value: string | null): unknown => {
      if (!value?.trim()) return null
      try { return JSON.parse(value) as unknown } catch { return null }
    }
    return {
      chapter: {
        id: chapter.id,
        title: chapter.title,
        content: chapter.content ?? '',
        wordCount: chapter.word_count,
        status: chapter.status,
        updateTime: chapter.update_time,
        decisionCard: chapter.outline ?? '',
        qualityAssessment: parseJson(chapter.quality_assessment_json),
        emotionAssessment: parseJson(chapter.emotion_assessment_json)
      },
      decision: causalNovelDAO.getDecision(chapterId),
      contentBinding: causalNovelDAO.getChapterBinding(chapterId),
      contentVersions: causalNovelDAO.listContentVersions(chapterId).map(version => ({
        id: version.id,
        parentVersionId: version.parentVersionId,
        bodyHash: version.bodyHash,
        wordCount: version.wordCount,
        source: version.source,
        editKind: version.editKind,
        status: version.status,
        createTime: version.createTime
      })),
      replayJobs: causalNovelDAO.listReplayJobs(workId, 50).filter(job => job.chapterId === chapterId),
      stateFacts: storyStateDAO.listFactsByChapter(workId, chapterId).map(fact => ({
        id: fact.id,
        entity: fact.entity,
        key: fact.state_key,
        value: parseJson(fact.value_json),
        transition: fact.transition,
        irreversible: Boolean(fact.irreversible),
        evidence: fact.evidence
      })),
      emotionalStates: emotionalStateDAO.listByChapter(chapterId).map(item => ({
        characterName: item.character_name,
        feltState: item.felt_state,
        displayedState: item.displayed_state,
        unresolvedEmotion: item.unresolved_emotion,
        behavioralAftereffect: item.behavioral_aftereffect,
        sourceEvent: item.source_event
      })),
      versions: volumeChapterDAO.listVersions(chapterId).map(version => ({
        id: version.id,
        versionNumber: version.version_number,
        wordCount: version.word_count,
        modelType: version.model_type,
        generationRound: version.generation_round,
        createTime: version.create_time,
        hasContent: Boolean(version.content?.trim())
      }))
    }
  })
  ipcMain.handle('causal:getChapterVersion', (_e, workId: number, chapterId: number, versionId: number) => {
    if (!isCausalNovelWork(workId)) throw new Error('该作品不是因果小说')
    if (volumeChapterDAO.getWorkIdForChapter(chapterId) !== workId) throw new Error('章节不属于当前因果小说')
    const version = volumeChapterDAO.getVersion(versionId, chapterId)
    if (!version) throw new Error('章节版本不存在')
    return {
      id: version.id,
      versionNumber: version.version_number,
      content: version.content ?? '',
      wordCount: version.word_count,
      modelType: version.model_type,
      createTime: version.create_time
    }
  })
  ipcMain.handle('goal:getEvaluationData', (_e, workId: number) => {
    const state = goalRoutineDAO.getByWork(workId)
    const work = workDAO.getById(workId)
    let runtime: Record<string, unknown> = {}
    let config: Record<string, unknown> = {}
    try { runtime = state?.state_json ? JSON.parse(state.state_json) as Record<string, unknown> : {} } catch { /* ignore */ }
    try { config = state?.goal_config_json ? JSON.parse(state.goal_config_json) as Record<string, unknown> : {} } catch { /* ignore */ }
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      work: work ? { id: work.id, title: work.title, genre: work.genre, tags: work.tags, workType: work.work_type } : null,
      config,
      evaluations: Array.isArray(runtime.evaluationHistory) ? runtime.evaluationHistory : [],
      turns: goalRoutineDAO.listTurns(workId, 200),
      harness: isNovelWork(workId)
        ? undefined
        : {
            issues: storyHarnessDAO.listIssues(workId),
            candidates: storyHarnessDAO.listCandidatesByWork(workId, 200),
            releaseSnapshots: storyHarnessDAO.listReleaseSnapshots(workId)
          }
    }
  })
  ipcMain.handle('goal:isRunning', (_e, workId: number) => {
    return isCausalNovelWork(workId)
      ? isCausalNovelGoalLoopRunning(workId)
      : isNovelWork(workId) ? isNovelGoalLoopRunning(workId) : isGoalLoopRunning(workId)
  })

  ipcMain.handle('goal:listAllStates', () => {
    const rows = goalRoutineDAO.listAll()
    return rows.map(r => ({
      workId: r.work_id,
      status: r.status,
      turnCount: r.turn_count,
      maxTurns: r.max_turns,
      currentPhase: r.current_phase,
      lastQualityScore: r.last_quality_score,
      goalMet: Boolean(r.goal_met),
      updateTime: r.update_time
    }))
  })

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
