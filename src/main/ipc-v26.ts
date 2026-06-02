import { ipcMain, type WebContents } from 'electron'
import {
  loadCharacterCards, saveCharacterCards, parseCharacterCardsFromAi,
  formatCharacterCardsForChapter, formatAllCharacterCardsSummary, CHARACTER_CARD_TEMPLATE
} from './context/character-cards'
import { WRITER_BLOCK_TYPES, CHARACTER_CARDS_AI_PROMPT, MAX_ACTIVE_ANCHORS } from './context/writing-techniques'
import { anchorDAO, coreSettingDAO } from './db'
import { modelService } from './model'
import { buildWorkContext } from './context/work-context'
import { appLogger } from './logger/app-logger'
import {
  buildSettingsQualityInput,
  buildRevisePrompt,
  buildReviseCharacterCardsPrompt,
  buildReviseAnchorsPrompt,
  applyRevisedAnchorsFromAi,
  listCrossReviseTypes,
  flattenReviseAllWorkItems,
  buildReviseAllStepLabels,
  CROSS_REVISE_TYPE_LABELS,
  loadSettingsQualityState,
  recordQualityCheck,
  getSettingsQualityStatus,
  prepareReviseAll,
  finalizeReviseAll,
  acceptSettingsQualityPass,
  parseEnrichedReportSections,
  parseQualityConclusion,
  OVERALL_CHECK_SYSTEM_PROMPT,
  CHARACTER_FUNCTION_SYSTEM_PROMPT,
  type ReviseSettingType
} from './context/settings-quality'
import { aiSessionManager } from './ai/ai-session-manager'

type ReviseChatOpts = {
  sessionHandle?: ReturnType<typeof aiSessionManager.create>
  keepSession?: boolean
  suppressPhases?: boolean
  webContents?: WebContents
}

async function runCrossSettingRevision(
  sender: WebContents,
  workId: number,
  report: string,
  sectionTitle: string | undefined,
  chatOpts: ReviseChatOpts = {},
  stepSuffix = 'revise'
): Promise<{ revised: string[]; errors: string[] }> {
  const revised: string[] = []
  const errors: string[] = []

  for (const type of listCrossReviseTypes(workId)) {
    const { prompt, systemPrompt } = buildRevisePrompt(workId, type, report, sectionTitle)
    const res = await modelService.chat({
      prompt,
      systemPrompt,
      workId,
      step: `settings_cross_${type}_${stepSuffix}`,
      enrichWorkContext: false
    }, { webContents: sender, ...chatOpts })

    if (res.success && res.content.trim()) {
      coreSettingDAO.upsert(workId, type, res.content.trim())
      revised.push(type)
    } else {
      errors.push(`${CROSS_REVISE_TYPE_LABELS[type]}：${res.error || '修订失败'}`)
    }
  }

  return { revised, errors }
}

export function registerV26IpcHandlers(): void {
  // ==================== 人设卡片 ====================
  ipcMain.handle('characterCards:list', (_e, workId: number) => loadCharacterCards(workId))

  ipcMain.handle('characterCards:save', (_e, workId: number, cards: Parameters<typeof saveCharacterCards>[1]) => {
    saveCharacterCards(workId, cards)
    return { success: true }
  })

  ipcMain.handle('characterCards:template', () => CHARACTER_CARD_TEMPLATE)

  ipcMain.handle('characterCards:formatForChapter', (_e, workId: number, _outline: string) =>
    formatCharacterCardsForChapter(workId))

  ipcMain.handle('characterCards:formatAll', (_e, workId: number) =>
    formatAllCharacterCardsSummary(workId))

  ipcMain.handle('characterCards:aiGenerate', async (e, workId: number) => {
    const ctx = buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true })
    const prompt = ctx.text || '（请先填写故事方向）'
    const logHint = appLogger.getTodayLogPath()

    appLogger.info('character_cards', '开始 AI 生成人设卡片', {
      workId,
      promptLength: prompt.length
    })

    const res = await modelService.chat({
      prompt,
      systemPrompt: CHARACTER_CARDS_AI_PROMPT,
      workId,
      step: 'character_cards_generate',
      enrichWorkContext: false
    }, { webContents: e.sender })

    if (!res.success) {
      appLogger.error('character_cards', '模型调用失败', {
        workId,
        error: res.error,
        modelType: res.modelType,
        durationMs: res.durationMs
      })
      return { ...res, logHint }
    }

    const cards = parseCharacterCardsFromAi(res.content)
    if (cards.length === 0) {
      const error = 'AI 返回成功，但未能解析人设卡片。请重试；若仍失败，可手动添加或检查日志中的原始输出。'
      appLogger.error('character_cards', error, {
        workId,
        contentLength: res.content.length,
        contentPreview: res.content.slice(0, 800)
      })
      return {
        success: false,
        content: res.content,
        error,
        parseError: true,
        logHint
      }
    }

    appLogger.info('character_cards', `人设卡片解析成功，共 ${cards.length} 张`, {
      workId,
      names: cards.map(c => c.name)
    })

    return { ...res, cards, logHint }
  })

  // ==================== 章节衔接 ====================
  ipcMain.handle('continuity:getPrevious', (_e, workId: number, chapterId: number) =>
    getPreviousChapterContext(workId, chapterId))

  // ==================== 锚点上限 ====================
  ipcMain.handle('anchor:activeLimitStatus', (_e, workId: number) => {
    const active = anchorDAO.listActiveByWork(workId)
    return {
      activeCount: active.length,
      maxActive: MAX_ACTIVE_ANCHORS,
      overLimit: active.length > MAX_ACTIVE_ANCHORS,
      message: active.length > MAX_ACTIVE_ANCHORS
        ? `活跃锚点 ${active.length} 个，超过建议上限 ${MAX_ACTIVE_ANCHORS}，正文生成时仅注入前 ${MAX_ACTIVE_ANCHORS} 个`
        : null
    }
  })

  // ==================== 写作障碍类型 ====================
  ipcMain.handle('writerBlock:types', () => WRITER_BLOCK_TYPES)

  // ==================== 设定质量中心 ====================
  ipcMain.handle('settingsQuality:getState', (_e, workId: number) =>
    loadSettingsQualityState(workId))

  ipcMain.handle('settingsQuality:buildInput', (_e, workId: number) =>
    buildSettingsQualityInput(workId))

  ipcMain.handle('settingsQuality:parseSections', (_e, workId: number, report: string) =>
    parseEnrichedReportSections(workId, report))

  ipcMain.handle('settingsQuality:parseConclusion', (_e, report: string) =>
    parseQualityConclusion(report))

  ipcMain.handle('settingsQuality:acceptPass', (_e, workId: number) => {
    try {
      acceptSettingsQualityPass(workId)
      return { success: true }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  })

  ipcMain.handle('settingsQuality:runOverallCheck', async (e, workId: number) => {
    const prompt = buildSettingsQualityInput(workId)
    if (!prompt.replace(/（尚未设定）|（无活跃锚点）/g, '').trim()) {
      return { success: false, error: '请先填写故事方向或核心设定后再运行自检' }
    }
    const res = await modelService.chat({
      prompt,
      systemPrompt: OVERALL_CHECK_SYSTEM_PROMPT,
      workId,
      step: 'settings_overall_check',
      enrichWorkContext: false
    }, { webContents: e.sender })
    if (res.success && res.content.trim()) {
      recordQualityCheck(workId, {
        overall: { report: res.content, checkedAt: new Date().toISOString() }
      })
    }
    return res
  })

  ipcMain.handle('settingsQuality:runCharacterFunctionCheck', async (e, workId: number) => {
    const character = coreSettingDAO.getByType(workId, 'character')?.content?.trim()
    if (!character) {
      return { success: false, error: '请先填写人设后再运行角色功能检查' }
    }
    const ctx = buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true, includeQualityIssues: false })
    const res = await modelService.chat({
      prompt: `${ctx.text}\n\n【人设】\n${character}`,
      systemPrompt: CHARACTER_FUNCTION_SYSTEM_PROMPT,
      workId,
      step: 'settings_character_check',
      enrichWorkContext: false
    }, { webContents: e.sender })
    if (res.success && res.content.trim()) {
      recordQualityCheck(workId, {
        characterFunction: { report: res.content, checkedAt: new Date().toISOString() }
      })
    }
    return res
  })

  ipcMain.handle('settingsQuality:getStatus', (_e, workId: number) =>
    getSettingsQualityStatus(workId))

  ipcMain.handle('settingsQuality:reviseSetting', async (
    e,
    workId: number,
    type: ReviseSettingType,
    report: string,
    sectionTitle?: string
  ) => {
    const current = coreSettingDAO.getByType(workId, type)?.content?.trim()
    if (!current) {
      return { success: false, error: '当前设定为空，无法修订' }
    }
    const { prompt, systemPrompt } = buildRevisePrompt(workId, type, report, sectionTitle)
    const res = await modelService.chat({
      prompt,
      systemPrompt,
      workId,
      step: `settings_${type}_revise`,
      enrichWorkContext: false
    }, { webContents: e.sender })
    return res
  })

  ipcMain.handle('settingsQuality:reviseCharacterCards', async (
    e,
    workId: number,
    report: string,
    sectionTitle?: string
  ) => {
    const cards = loadCharacterCards(workId)
    if (cards.length === 0) {
      return { success: false, error: '暂无人设卡片，请先添加或 AI 生成' }
    }
    const { prompt, systemPrompt } = buildReviseCharacterCardsPrompt(workId, report, sectionTitle)
    const res = await modelService.chat({
      prompt,
      systemPrompt,
      workId,
      step: 'settings_character_cards_revise',
      enrichWorkContext: false
    }, { webContents: e.sender })
    if (!res.success) return res

    const parsed = parseCharacterCardsFromAi(res.content)
    if (parsed.length === 0) {
      return { success: false, error: 'AI 返回成功，但未能解析修订后的人设卡片', content: res.content }
    }
    saveCharacterCards(workId, parsed)
    return { ...res, cards: parsed }
  })

  ipcMain.handle('settingsQuality:reviseAnchors', async (
    e,
    workId: number,
    report: string,
    sectionTitle?: string
  ) => {
    const anchors = anchorDAO.listActiveByWork(workId)
    if (anchors.length === 0) {
      return { success: false, error: '暂无活跃锚点，请先添加锚点' }
    }
    const { prompt, systemPrompt } = buildReviseAnchorsPrompt(workId, report, sectionTitle)
    const res = await modelService.chat({
      prompt,
      systemPrompt,
      workId,
      step: 'settings_anchors_revise',
      enrichWorkContext: false
    }, { webContents: e.sender })
    if (!res.success) return res

    const applied = applyRevisedAnchorsFromAi(workId, res.content)
    if (!applied.success) {
      return { success: false, error: applied.error, content: res.content }
    }
    return { ...res, count: applied.count }
  })

  ipcMain.handle('settingsQuality:reviseCross', async (
    e,
    workId: number,
    report: string,
    sectionTitle?: string
  ) => {
    if (listCrossReviseTypes(workId).length === 0) {
      return { success: false, error: '人设/世界观/核心冲突为空，无法修订' }
    }

    const { revised, errors } = await runCrossSettingRevision(
      e.sender,
      workId,
      report,
      sectionTitle
    )

    if (revised.length === 0) {
      return { success: false, error: errors.join('；') || '跨设定修订失败' }
    }

    return {
      success: errors.length === 0,
      revised,
      errors,
      error: errors.length > 0 ? errors.join('；') : undefined
    }
  })

  ipcMain.handle('settingsQuality:reviseAll', async (e, workId: number) => {
    const prep = prepareReviseAll(workId)
    if (!prep.ok) {
      return { success: false, error: prep.error, revised: [], errors: [], targets: [] }
    }

    const { targets, prevBlocking, prevScore, round } = prep
    const report = loadSettingsQualityState(workId).overall!.report
    const workItems = flattenReviseAllWorkItems(targets)
    const stepLabels = buildReviseAllStepLabels(targets)
    const session = aiSessionManager.create(e.sender, '修订不合格项', stepLabels)
    const chatOpts = { sessionHandle: session, keepSession: true as const, suppressPhases: true as const }

    const revised: string[] = []
    const errors: string[] = []

    try {
      for (let i = 0; i < workItems.length; i++) {
        const item = workItems[i]
        session.setStepRunning(i)
        session.clearStream()

        if (item.kind === 'cross') {
          const type = item.reviseType
          if (!coreSettingDAO.getByType(workId, type)?.content?.trim()) {
            session.setStepDone(i)
            continue
          }
          const { prompt, systemPrompt } = buildRevisePrompt(workId, type, report, item.section.title)
          const res = await modelService.chat({
            prompt,
            systemPrompt,
            workId,
            step: `settings_cross_${type}_revise_all`,
            enrichWorkContext: false
          }, chatOpts)
          if (res.success && res.content.trim()) {
            coreSettingDAO.upsert(workId, type, res.content.trim())
            revised.push(type)
            session.setStepDone(i)
          } else {
            errors.push(`${item.section.title} · ${CROSS_REVISE_TYPE_LABELS[type]}：${res.error || '修订失败'}`)
            session.setStepError(i, res.error)
          }
          continue
        }

        const section = item.section

        if (section.reviseType) {
          const { prompt, systemPrompt } = buildRevisePrompt(workId, section.reviseType, report, section.title)
          const res = await modelService.chat({
            prompt,
            systemPrompt,
            workId,
            step: `settings_${section.reviseType}_revise_all`,
            enrichWorkContext: false
          }, chatOpts)
          if (res.success && res.content.trim()) {
            coreSettingDAO.upsert(workId, section.reviseType, res.content.trim())
            revised.push(section.reviseType)
            session.setStepDone(i)
          } else {
            errors.push(`${section.title}：${res.error || '修订失败'}`)
            session.setStepError(i, res.error)
          }
          continue
        }

        if (section.action === 'revise-cards') {
          const cards = loadCharacterCards(workId)
          if (cards.length === 0) {
            session.setStepDone(i)
            continue
          }
          const { prompt, systemPrompt } = buildReviseCharacterCardsPrompt(workId, report, section.title)
          const res = await modelService.chat({
            prompt,
            systemPrompt,
            workId,
            step: 'settings_character_cards_revise_all',
            enrichWorkContext: false
          }, chatOpts)
          if (!res.success) {
            errors.push(`${section.title}：${res.error || '修订失败'}`)
            session.setStepError(i, res.error)
            continue
          }
          const parsed = parseCharacterCardsFromAi(res.content)
          if (parsed.length === 0) {
            errors.push(`${section.title}：未能解析修订后的人设卡片`)
            session.setStepError(i, '未能解析修订后的人设卡片')
            continue
          }
          saveCharacterCards(workId, parsed)
          revised.push('character_cards')
          session.setStepDone(i)
          continue
        }

        if (section.action === 'revise-anchors') {
          const anchors = anchorDAO.listActiveByWork(workId)
          if (anchors.length === 0) {
            session.setStepDone(i)
            continue
          }
          const { prompt, systemPrompt } = buildReviseAnchorsPrompt(workId, report, section.title)
          const res = await modelService.chat({
            prompt,
            systemPrompt,
            workId,
            step: 'settings_anchors_revise_all',
            enrichWorkContext: false
          }, chatOpts)
          if (!res.success) {
            errors.push(`${section.title}：${res.error || '修订失败'}`)
            session.setStepError(i, res.error)
            continue
          }
          const applied = applyRevisedAnchorsFromAi(workId, res.content)
          if (!applied.success) {
            errors.push(`${section.title}：${applied.error || '未能应用锚点修订'}`)
            session.setStepError(i, applied.error)
            continue
          }
          revised.push('anchors')
          session.setStepDone(i)
          continue
        }
      }

      let recheckSuccess = false
      let recheckContent: string | undefined
      const recheckIndex = workItems.length
      if (revised.length > 0) {
        session.setStepRunning(recheckIndex)
        session.clearStream()
        const prompt = buildSettingsQualityInput(workId)
        const recheck = await modelService.chat({
          prompt,
          systemPrompt: OVERALL_CHECK_SYSTEM_PROMPT,
          workId,
          step: 'settings_overall_check',
          enrichWorkContext: false
        }, chatOpts)
        if (recheck.success && recheck.content.trim()) {
          recheckContent = recheck.content.trim()
          recheckSuccess = true
          session.setStepDone(recheckIndex)
        } else {
          session.setStepError(recheckIndex, recheck.error)
        }
      }

      const { convergenceStalled } = finalizeReviseAll(workId, {
        prevBlocking,
        prevScore,
        round,
        recheckReport: recheckContent,
        revisedCount: revised.length
      })

      const qualityAfterRevise = getSettingsQualityStatus(workId)
      const needsManualAccept = convergenceStalled && !qualityAfterRevise.canProceed

      const success = errors.length === 0 && revised.length > 0
      session.complete(
        success,
        errors.length > 0 ? errors.join('；') : revised.length === 0 ? '没有成功修订任何项' : undefined
      )

      return {
        success,
        revised,
        errors,
        recheckSuccess,
        convergenceStalled,
        blockingCount: recheckContent ? parseQualityConclusion(recheckContent)?.blockingCount : undefined,
        error: errors.length > 0
          ? errors.join('；')
          : revised.length === 0
            ? '没有成功修订任何不合格项'
            : needsManualAccept
              ? '修订后不合格项未明显减少，建议人工审阅或使用「接受当前设定并标记通过」'
              : undefined
      }
    } catch (err) {
      session.complete(false, String(err))
      throw err
    }
  })
}
