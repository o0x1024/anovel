import { ipcMain, type WebContents } from 'electron'
import {
  loadCharacterCards, saveCharacterCards, parseCharacterCardsFromAi,
  formatCharacterCardsForChapter, formatAllCharacterCardsSummary, CHARACTER_CARD_TEMPLATE,
  sanitizeCharacterCards, validateCharacterCards
} from './context/character-cards'
import { WRITER_BLOCK_TYPES, CHARACTER_CARDS_AI_PROMPT, MAX_ACTIVE_ANCHORS } from './context/writing-techniques'
import { STORY_OVERALL_CHECK_SYSTEM_PROMPT, STORY_CHARACTER_FUNCTION_CHECK_SYSTEM_PROMPT } from './context/story-settings-quality'
import { anchorDAO, coreSettingDAO, workDAO } from './db'
import { modelService } from './model'
import { buildWorkContext } from './context/work-context'
import { appLogger } from './logger/app-logger'
import {
  buildSettingsQualityInput,
  buildConflictCardCoverageReport,
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
  prepareReviseAdvisoryAll,
  finalizeReviseAll,
  finalizeReviseOptimizeAll,
  acceptSettingsQualityPass,
  parseEnrichedReportSections,
  parseQualityConclusion,
  OVERALL_CHECK_SYSTEM_PROMPT,
  CHARACTER_FUNCTION_SYSTEM_PROMPT,
  type ReviseSettingType,
  type ParsedReportSection
} from './context/settings-quality'
import { aiSessionManager } from './ai/ai-session-manager'
import { withWorkModelOptions, type WorkModelOptions } from '../shared/work-model-options'
import type { ModelRequest } from './model/types'

type ReviseChatOpts = {
  sessionHandle?: ReturnType<typeof aiSessionManager.create>
  keepSession?: boolean
  suppressPhases?: boolean
  webContents?: WebContents
}

function chatWithWorkModel(
  request: ModelRequest,
  chatOpts: ReviseChatOpts,
  modelOpts?: WorkModelOptions
) {
  return modelService.chat(withWorkModelOptions(request, modelOpts), chatOpts)
}

function validateConflictMarkdown(content: string): boolean {
  return (
    /^#{2,3}\s*主线冲突/m.test(content) &&
    /^#{2,3}\s*副线冲突/m.test(content) &&
    /^#{2,3}\s*冲突升级路径/m.test(content)
  )
}

function extractConflictReplacementFromSuggestion(markdown: string): string | null {
  const lines = markdown.split('\n')
  const sectionStart = lines.findIndex(line => /^##\s*可直接替换的核心冲突/.test(line.trim()))

  let candidate = ''
  if (sectionStart >= 0) {
    const body: string[] = []
    for (let i = sectionStart + 1; i < lines.length; i++) {
      if (/^##\s+/.test(lines[i].trim())) break
      body.push(lines[i])
    }
    candidate = body.join('\n').trim()
  }

  const fromBodyIdx = candidate.search(/^#{2,3}\s*主线冲突/m)
  if (fromBodyIdx >= 0) {
    candidate = candidate.slice(fromBodyIdx).trim()
  } else {
    const fromAllIdx = markdown.search(/^#{2,3}\s*主线冲突/m)
    if (fromAllIdx >= 0) {
      candidate = markdown.slice(fromAllIdx).trim()
    }
  }

  if (!candidate || !validateConflictMarkdown(candidate)) {
    return null
  }
  return candidate
}

function buildConflictCoverageSuggestionPrompt(workId: number) {
  const coverage = buildConflictCardCoverageReport(workId)
  if (!coverage.hasConflict) {
    return { ok: false as const, error: '请先填写核心冲突后再生成补齐建议' }
  }
  if (!coverage.hasCards) {
    return { ok: false as const, error: '暂无结构化人设卡片，无法生成映射建议' }
  }
  if (coverage.missingCount === 0) {
    return { ok: false as const, error: '当前核心冲突已覆盖全部角色矛盾，无需补齐' }
  }

  const conflict = (coreSettingDAO.getByType(workId, 'conflict_engine')?.content?.trim()
    || coreSettingDAO.getByType(workId, 'conflict')?.content?.trim()) ?? ''
  const missingLines = coverage.missingItems.map(item =>
    `- ${item.name}（${item.role}）：卡片矛盾=${item.coreConflict || '（未填写）'}；原因=${item.reason}`
  )
  const ctx = buildWorkContext(workId, {
    includeCoreSettings: true,
    includeIdea: true,
    includeIncubator: false,
    includeQualityIssues: false
  })

  const prompt = [
    '请基于下述信息，补齐「核心冲突」中尚未映射到角色卡矛盾的部分。',
    '目标：不改写整体方向，只补齐缺失角色矛盾与升级触发点。',
    '',
    '【当前核心冲突】',
    conflict,
    '',
    '【未覆盖角色矛盾】',
    ...missingLines,
    '',
    ctx.text,
    '',
    '请输出 Markdown，严格使用以下结构：',
    '## 角色矛盾补齐建议',
    '- 每个未覆盖角色 1 条，写成“角色名：应补入的冲突句”',
    '## 可直接替换的核心冲突（完整版）',
    '- 给出完整可替换文本，保持「主线冲突 / 副线冲突 / 冲突升级路径」结构'
  ].join('\n')

  return { ok: true as const, prompt }
}

type ReviseBatchMode = 'fix' | 'optimize'

async function runCrossSettingRevision(
  sender: WebContents,
  workId: number,
  report: string,
  sectionTitle: string | undefined,
  chatOpts: ReviseChatOpts = {},
  stepSuffix = 'revise',
  mode: ReviseBatchMode = 'fix',
  modelOpts?: WorkModelOptions
): Promise<{ revised: string[]; errors: string[] }> {
  const revised: string[] = []
  const errors: string[] = []

  for (const type of listCrossReviseTypes(workId)) {
    const { prompt, systemPrompt } = buildRevisePrompt(workId, type, report, sectionTitle, mode)
    const res = await chatWithWorkModel({
      prompt,
      systemPrompt,
      workId,
      step: `settings_cross_${type}_${stepSuffix}`,
      enrichWorkContext: false
    }, { webContents: sender, ...chatOpts }, modelOpts)

    if (res.success && res.content.trim()) {
      coreSettingDAO.upsert(workId, type, res.content.trim())
      revised.push(type)
    } else {
      errors.push(`${CROSS_REVISE_TYPE_LABELS[type]}：${res.error || '修订失败'}`)
    }
  }

  return { revised, errors }
}

async function runSettingsReviseBatch(
  sender: WebContents,
  workId: number,
  input: {
    sessionTitle: string
    targets: ParsedReportSection[]
    mode: ReviseBatchMode
    prevBlocking?: number
    prevScore?: number | null
    round?: number
    modelOpts?: WorkModelOptions
  }
) {
  const { mode, targets, modelOpts } = input
  const stepSuffix = mode === 'optimize' ? 'optimize_all' : 'revise_all'
  const actionVerb = mode === 'optimize' ? '优化' : '修订'
  const report = loadSettingsQualityState(workId).overall!.report
  const workItems = flattenReviseAllWorkItems(targets)
  const stepLabels = buildReviseAllStepLabels(targets).map((label, i, arr) =>
    i === arr.length - 1 ? label : label.replace(/修订/g, actionVerb)
  )
  const session = aiSessionManager.create(sender, input.sessionTitle, stepLabels)
  const chatOpts = { sessionHandle: session, keepSession: true as const, suppressPhases: true as const }
  const reviseMode = mode === 'optimize' ? 'optimize' as const : 'fix' as const

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
        const { prompt, systemPrompt } = buildRevisePrompt(workId, type, report, item.section.title, reviseMode)
        const res = await chatWithWorkModel({
          prompt,
          systemPrompt,
          workId,
          step: `settings_cross_${type}_${stepSuffix}`,
          enrichWorkContext: false
        }, chatOpts, modelOpts)
        if (res.success && res.content.trim()) {
          coreSettingDAO.upsert(workId, type, res.content.trim())
          revised.push(type)
          session.setStepDone(i)
        } else {
          errors.push(`${item.section.title} · ${CROSS_REVISE_TYPE_LABELS[type]}：${res.error || `${actionVerb}失败`}`)
          session.setStepError(i, res.error)
        }
        continue
      }

      const section = item.section

      if (section.reviseType) {
        const { prompt, systemPrompt } = buildRevisePrompt(
          workId,
          section.reviseType,
          report,
          section.title,
          reviseMode
        )
        const res = await chatWithWorkModel({
          prompt,
          systemPrompt,
          workId,
          step: `settings_${section.reviseType}_${stepSuffix}`,
          enrichWorkContext: false
        }, chatOpts, modelOpts)
        if (res.success && res.content.trim()) {
          coreSettingDAO.upsert(workId, section.reviseType, res.content.trim())
          revised.push(section.reviseType)
          session.setStepDone(i)
        } else {
          errors.push(`${section.title}：${res.error || `${actionVerb}失败`}`)
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
        const res = await chatWithWorkModel({
          prompt,
          systemPrompt,
          workId,
          step: mode === 'optimize' ? 'settings_character_cards_optimize_all' : 'settings_character_cards_revise_all',
          enrichWorkContext: false
        }, chatOpts, modelOpts)
        if (!res.success) {
          errors.push(`${section.title}：${res.error || `${actionVerb}失败`}`)
          session.setStepError(i, res.error)
          continue
        }
        const parsed = parseCharacterCardsFromAi(res.content)
        if (parsed.length === 0) {
          errors.push(`${section.title}：未能解析${actionVerb}后的人设卡片`)
          session.setStepError(i, `未能解析${actionVerb}后的人设卡片`)
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
        const res = await chatWithWorkModel({
          prompt,
          systemPrompt,
          workId,
          step: mode === 'optimize' ? 'settings_anchors_optimize_all' : 'settings_anchors_revise_all',
          enrichWorkContext: false
        }, chatOpts, modelOpts)
        if (!res.success) {
          errors.push(`${section.title}：${res.error || `${actionVerb}失败`}`)
          session.setStepError(i, res.error)
          continue
        }
        const applied = applyRevisedAnchorsFromAi(workId, res.content)
        if (!applied.success) {
          errors.push(`${section.title}：${applied.error || `未能应用锚点${actionVerb}`}`)
          session.setStepError(i, applied.error)
          continue
        }
        revised.push('anchors')
        session.setStepDone(i)
      }
    }

    let recheckSuccess = false
    let recheckContent: string | undefined
    const recheckIndex = workItems.length
    if (revised.length > 0) {
      session.setStepRunning(recheckIndex)
      session.clearStream()
      const prompt = buildSettingsQualityInput(workId)
      const recheck = await chatWithWorkModel({
        prompt,
        systemPrompt: OVERALL_CHECK_SYSTEM_PROMPT,
        workId,
        step: 'settings_overall_check',
        enrichWorkContext: false
      }, chatOpts, modelOpts)
      if (recheck.success && recheck.content.trim()) {
        recheckContent = recheck.content.trim()
        recheckSuccess = true
        session.setStepDone(recheckIndex)
      } else {
        session.setStepError(recheckIndex, recheck.error)
      }
    }

    let convergenceStalled = false
    if (mode === 'fix') {
      const result = finalizeReviseAll(workId, {
        prevBlocking: input.prevBlocking ?? 0,
        prevScore: input.prevScore ?? null,
        round: input.round ?? 0,
        recheckReport: recheckContent,
        revisedCount: revised.length
      })
      convergenceStalled = result.convergenceStalled
    } else {
      finalizeReviseOptimizeAll(workId, recheckContent)
    }

    const qualityAfterRevise = getSettingsQualityStatus(workId)
    const needsManualAccept = mode === 'fix' && convergenceStalled && !qualityAfterRevise.canProceed
    const success = errors.length === 0 && revised.length > 0
    session.complete(
      success,
      errors.length > 0 ? errors.join('；') : revised.length === 0 ? `没有成功${actionVerb}任何项` : undefined
    )

    const emptyError = mode === 'fix'
      ? `没有成功修订任何不合格项`
      : `没有成功优化任何及格项`

    return {
      success,
      revised,
      errors,
      recheckSuccess,
      convergenceStalled,
      advisoryCount: recheckContent ? parseQualityConclusion(recheckContent)?.advisoryCount : undefined,
      blockingCount: recheckContent ? parseQualityConclusion(recheckContent)?.blockingCount : undefined,
      error: errors.length > 0
        ? errors.join('；')
        : revised.length === 0
          ? emptyError
          : needsManualAccept
            ? '修订后不合格项未明显减少，建议人工审阅或使用「接受当前设定并标记通过」'
            : undefined
    }
  } catch (err) {
    session.complete(false, String(err))
    throw err
  }
}

export function registerV26IpcHandlers(): void {
  // ==================== 人设卡片 ====================
  ipcMain.handle('characterCards:list', (_e, workId: number) => loadCharacterCards(workId))

  ipcMain.handle('characterCards:save', (_e, workId: number, cards: Parameters<typeof saveCharacterCards>[1]) => {
    const sanitized = sanitizeCharacterCards(cards)
    const validation = validateCharacterCards(sanitized.cards)
    if (!validation.valid) {
      return {
        success: false,
        error: validation.errors[0] ?? '人设卡片校验失败',
        errors: validation.errors,
        warnings: [
          ...validation.warnings,
          ...(sanitized.duplicateNames.length ? [`检测到重名卡片，已忽略：${sanitized.duplicateNames.join('、')}`] : []),
          ...(sanitized.droppedCount > 0 ? [`有 ${sanitized.droppedCount} 张空角色名卡片已忽略`] : [])
        ],
        cards: sanitized.cards
      }
    }

    saveCharacterCards(workId, sanitized.cards)
    return {
      success: true,
      cards: sanitized.cards,
      warnings: [
        ...validation.warnings,
        ...(sanitized.duplicateNames.length ? [`检测到重名卡片，已忽略：${sanitized.duplicateNames.join('、')}`] : []),
        ...(sanitized.droppedCount > 0 ? [`有 ${sanitized.droppedCount} 张空角色名卡片已忽略`] : [])
      ]
    }
  })

  ipcMain.handle('characterCards:template', () => CHARACTER_CARD_TEMPLATE)

  ipcMain.handle('characterCards:formatForChapter', (_e, workId: number, _outline: string) =>
    formatCharacterCardsForChapter(workId))

  ipcMain.handle('characterCards:formatAll', (_e, workId: number) =>
    formatAllCharacterCardsSummary(workId))

  ipcMain.handle('characterCards:aiGenerate', async (e, workId: number, userHints?: string, modelOpts?: WorkModelOptions) => {
    const ctx = buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true })
    const hints = userHints?.trim()
    let prompt = ctx.text || '（请先填写故事方向）'
    if (hints) {
      prompt = `${prompt}\n\n## 用户补充要求\n${hints}`
    }
    const logHint = appLogger.getTodayLogPath()

    appLogger.info('character_cards', '开始 AI 生成人设卡片', {
      workId,
      promptLength: prompt.length
    })

    const res = await chatWithWorkModel({
      prompt,
      systemPrompt: CHARACTER_CARDS_AI_PROMPT,
      workId,
      step: 'character_cards_generate',
      enrichWorkContext: false
    }, { webContents: e.sender }, modelOpts)

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

    const sanitized = sanitizeCharacterCards(cards)
    const validation = validateCharacterCards(sanitized.cards)
    if (!validation.valid) {
      const error = `AI 返回卡片未通过结构校验：${validation.errors[0] ?? '未知错误'}`
      appLogger.error('character_cards', error, {
        workId,
        errors: validation.errors,
        warnings: validation.warnings,
        droppedCount: sanitized.droppedCount,
        duplicateNames: sanitized.duplicateNames,
        contentPreview: res.content.slice(0, 800)
      })
      return {
        success: false,
        content: res.content,
        error,
        parseError: true,
        logHint,
        validationErrors: validation.errors
      }
    }

    appLogger.info('character_cards', `人设卡片解析成功，共 ${sanitized.cards.length} 张`, {
      workId,
      names: sanitized.cards.map(c => c.name)
    })

    return {
      ...res,
      cards: sanitized.cards,
      logHint,
      warnings: [
        ...validation.warnings,
        ...(sanitized.duplicateNames.length ? [`检测到重名卡片，已忽略：${sanitized.duplicateNames.join('、')}`] : []),
        ...(sanitized.droppedCount > 0 ? [`有 ${sanitized.droppedCount} 张空角色名卡片已忽略`] : [])
      ]
    }
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

  ipcMain.handle('settingsQuality:getConflictCardCoverage', (_e, workId: number) =>
    buildConflictCardCoverageReport(workId))

  ipcMain.handle('settingsQuality:suggestConflictCoverageFix', async (e, workId: number, modelOpts?: WorkModelOptions) => {
    const payload = buildConflictCoverageSuggestionPrompt(workId)
    if (!payload.ok) return { success: false, error: payload.error }

    const workInfo = workDAO.getById(workId)
    const isStory = workInfo?.work_type === 'story'

    return chatWithWorkModel({
      prompt: payload.prompt,
      systemPrompt: [
        `你是资深${isStory ? '短故事' : '小说'}编辑，擅长将角色矛盾映射到核心冲突。`,
        '输出必须是可执行的修订文本，禁止空泛建议。',
        '只输出 Markdown 正文，不要额外解释。'
      ].join('\n'),
      workId,
      step: 'settings_conflict_coverage_suggest',
      enrichWorkContext: false
    }, { webContents: e.sender }, modelOpts)
  })

  ipcMain.handle('settingsQuality:applyConflictCoverageFix', (_e, workId: number, suggestionMarkdown: string) => {
    const suggestion = (suggestionMarkdown ?? '').trim()
    if (!suggestion) {
      return { success: false, error: '补齐建议为空，请先生成建议' }
    }
    const replacement = extractConflictReplacementFromSuggestion(suggestion)
    if (!replacement) {
      return { success: false, error: '建议中未识别到可替换的核心冲突正文（需包含主线/副线/升级路径）' }
    }
    coreSettingDAO.upsert(workId, 'conflict_engine', replacement)
    return { success: true, content: replacement }
  })

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

  ipcMain.handle('settingsQuality:runOverallCheck', async (e, workId: number, modelOpts?: WorkModelOptions) => {
    const prompt = buildSettingsQualityInput(workId)
    if (!prompt.replace(/（尚未设定）|（无活跃锚点）/g, '').trim()) {
      return { success: false, error: '请先填写故事方向或核心设定后再运行自检' }
    }
    const workInfo = workDAO.getById(workId)
    const isStory = workInfo?.work_type === 'story'
    const res = await chatWithWorkModel({
      prompt,
      systemPrompt: isStory ? STORY_OVERALL_CHECK_SYSTEM_PROMPT : OVERALL_CHECK_SYSTEM_PROMPT,
      workId,
      step: 'settings_overall_check',
      enrichWorkContext: false
    }, { webContents: e.sender }, modelOpts)
    if (res.success && res.content.trim()) {
      recordQualityCheck(workId, {
        overall: { report: res.content, checkedAt: new Date().toISOString() }
      })
    }
    return res
  })

  ipcMain.handle('settingsQuality:runCharacterFunctionCheck', async (e, workId: number, modelOpts?: WorkModelOptions) => {
    const character = coreSettingDAO.getByType(workId, 'supporting_cast')?.content?.trim()
      || coreSettingDAO.getByType(workId, 'character')?.content?.trim()
    if (!character) {
      return { success: false, error: '请先填写配角功能组后再运行角色功能检查' }
    }
    const workInfo = workDAO.getById(workId)
    const isStory = workInfo?.work_type === 'story'
    const ctx = buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true, includeQualityIssues: false })
    const res = await chatWithWorkModel({
      prompt: `${ctx.text}\n\n【人设】\n${character}`,
      systemPrompt: isStory ? STORY_CHARACTER_FUNCTION_CHECK_SYSTEM_PROMPT : CHARACTER_FUNCTION_SYSTEM_PROMPT,
      workId,
      step: 'settings_character_check',
      enrichWorkContext: false
    }, { webContents: e.sender }, modelOpts)
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
    sectionTitle?: string,
    mode: ReviseBatchMode = 'fix',
    modelOpts?: WorkModelOptions
  ) => {
    const current = coreSettingDAO.getByType(workId, type)?.content?.trim()
    if (!current) {
      return { success: false, error: '当前设定为空，无法修订' }
    }
    const { prompt, systemPrompt } = buildRevisePrompt(workId, type, report, sectionTitle, mode)
    const res = await chatWithWorkModel({
      prompt,
      systemPrompt,
      workId,
      step: mode === 'optimize' ? `settings_${type}_optimize` : `settings_${type}_revise`,
      enrichWorkContext: false
    }, { webContents: e.sender }, modelOpts)
    return res
  })

  ipcMain.handle('settingsQuality:reviseCharacterCards', async (
    e,
    workId: number,
    report: string,
    sectionTitle?: string,
    modelOpts?: WorkModelOptions
  ) => {
    const cards = loadCharacterCards(workId)
    if (cards.length === 0) {
      return { success: false, error: '暂无人设卡片，请先添加或 AI 生成' }
    }
    const { prompt, systemPrompt } = buildReviseCharacterCardsPrompt(workId, report, sectionTitle)
    const res = await chatWithWorkModel({
      prompt,
      systemPrompt,
      workId,
      step: 'settings_character_cards_revise',
      enrichWorkContext: false
    }, { webContents: e.sender }, modelOpts)
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
    sectionTitle?: string,
    modelOpts?: WorkModelOptions
  ) => {
    const anchors = anchorDAO.listActiveByWork(workId)
    if (anchors.length === 0) {
      return { success: false, error: '暂无活跃锚点，请先添加锚点' }
    }
    const { prompt, systemPrompt } = buildReviseAnchorsPrompt(workId, report, sectionTitle)
    const res = await chatWithWorkModel({
      prompt,
      systemPrompt,
      workId,
      step: 'settings_anchors_revise',
      enrichWorkContext: false
    }, { webContents: e.sender }, modelOpts)
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
    sectionTitle?: string,
    modelOpts?: WorkModelOptions
  ) => {
    if (listCrossReviseTypes(workId).length === 0) {
      return { success: false, error: '人设/世界观/核心冲突为空，无法修订' }
    }

    const { revised, errors } = await runCrossSettingRevision(
      e.sender,
      workId,
      report,
      sectionTitle,
      {},
      'revise',
      'fix',
      modelOpts
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

  ipcMain.handle('settingsQuality:reviseAll', async (e, workId: number, modelOpts?: WorkModelOptions) => {
    const prep = prepareReviseAll(workId)
    if (!prep.ok) {
      return { success: false, error: prep.error, revised: [], errors: [], targets: [] }
    }

    return runSettingsReviseBatch(e.sender, workId, {
      sessionTitle: '修订不合格项',
      targets: prep.targets,
      mode: 'fix',
      prevBlocking: prep.prevBlocking,
      prevScore: prep.prevScore,
      round: prep.round,
      modelOpts
    })
  })

  ipcMain.handle('settingsQuality:reviseAdvisoryAll', async (e, workId: number, modelOpts?: WorkModelOptions) => {
    const prep = prepareReviseAdvisoryAll(workId)
    if (!prep.ok) {
      return { success: false, error: prep.error, revised: [], errors: [], targets: [] }
    }

    return runSettingsReviseBatch(e.sender, workId, {
      sessionTitle: '优化及格项',
      targets: prep.targets,
      mode: 'optimize',
      prevScore: prep.prevScore,
      modelOpts
    })
  })
}
