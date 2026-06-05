import type { ModelRequest } from '../model/types'
import { modelConfigDAO, writingStyleDAO, anchorDAO, appPreferenceDAO } from '../db'
import type { AnchorRow } from '../db'
import { buildWorkContext } from './work-context'
import { formatConditionRulesForPrompt } from './condition-rules'
import {
  formatAntiAiRulesForPrompt,
  buildStyleFewShot,
  buildAntiAiPersonaForWork,
  hasStyleReferenceText
} from './anti-ai-rules'
import {
  buildNarrativeMemorySections,
  type NarrativeMemoryResult
} from './narrative-memory'
import { formatTasteForPrompt } from './taste-profile'
import { isCoreSettingsAiGenerateStep, resolveStepStyleInjection } from './style-step-rules'
import { computeWorkChapterProgress, formatEvolutionPrompt } from './style-evolution'
import {
  getPreviousChapterContext,
  formatContinuityPrompt,
  trimContinuityToTail,
  type ChapterContinuityContext
} from './chapter-continuity'
import {
  retrieveRelevantChapters,
  formatRetrievedChapters
} from './chapter-retrieval'
import {
  MAX_ACTIVE_ANCHORS,
  BODY_CONTINUITY_RULE,
  CHAPTER_OUTLINE_LENGTH_RULES,
  VOLUME_OUTLINE_LENGTH_RULES
} from './writing-techniques'
import { resolvePrompt } from './prompt-registry'
import {
  estimateTokens,
  DEFAULT_MAX_CONTEXT_TOKENS,
  MESSAGE_OVERHEAD_TOKENS
} from './token-estimate'
import { volumeChapterDAO } from '../db'
import {
  shouldInjectAnchors,
  shouldInjectTasteAndConditionRules,
  shouldInjectWritingStyle
} from './step-prompt-policy'
import { resolveChapterCharacterNames, buildFocusCharacterHint } from './character-cards'
import { filterAnchorsForChapter, filterAnchorsForVolume } from './anchor-scope'

export type ContextPressure = 'safe' | 'warning' | 'critical' | 'blocking'

export interface ContextBudgetSection {
  key: string
  label: string
  tokens: number
  included: boolean
  trimmed: boolean
  /** 固定规则 → system；作品/章节上下文 → user */
  target: 'system' | 'user'
  note?: string
}

export interface ContextBudgetReport {
  maxContextTokens: number
  reservedOutputTokens: number
  inputBudget: number
  usedTokens: number
  usageRatio: number
  pressure: ContextPressure
  warnings: string[]
  sections: ContextBudgetSection[]
  continuityMode: 'full' | 'tail' | 'none'
}

export interface PromptSection {
  key: string
  label: string
  /** 固定规则 → system；作品/章节上下文 → user */
  target: 'system' | 'user'
  /** 数字越小越重要，预算不足时从大到小裁剪 */
  priority: number
  /**
   * 在最终 prompt 中的排列位置（数字越小越靠前）。
   * 与 priority（裁剪权重）解耦，用于对抗 Lost in the Middle 效应：
   *   Zone 1 (0-29): prompt 开头 — 高注意力区，放写作规则/人设/关键约束
   *   Zone 2 (30-69): prompt 中部 — 低注意力区，放大段参考性上下文
   *   Zone 3 (70-99): prompt 末尾 — 高注意力区，放锚点/示范/自检规则
   * 未指定时默认等于 priority。
   */
  renderOrder?: number
  text: string
  trimStrategy: 'none' | 'tail' | 'drop'
}

function userContextSection(section: Omit<PromptSection, 'target'>): PromptSection {
  return { ...section, target: 'user' }
}

function systemRuleSection(section: Omit<PromptSection, 'target'>): PromptSection {
  return { ...section, target: 'system' }
}

const USER_TASK_SEPARATOR = '\n\n---\n\n'

const ANCHOR_TYPE_LABELS: Record<string, string> = {
  scene: '场景锚点',
  character: '角色锚点',
  plot: '情节锚点',
  emotion: '情感锚点',
  structure: '结构锚点',
  memory: '记忆锚点',
  contrast: '反差锚点'
}

function formatAnchorsForPrompt(anchors: AnchorRow[]): string {
  const priority = (t: string) => {
    if (t === 'plot' || t === 'memory' || t === 'contrast') return 0
    if (t === 'character' || t === 'emotion') return 1
    return 2
  }
  const sorted = [...anchors].sort((a, b) => priority(a.type) - priority(b.type))
  const limited = sorted.slice(0, MAX_ACTIVE_ANCHORS)
  const lines = limited.map(a => {
    const label = ANCHOR_TYPE_LABELS[a.type] || `${a.type}锚点`
    return `- [${label}] ${a.content}`
  })
  const overflowNote = anchors.length > MAX_ACTIVE_ANCHORS
    ? `\n（另有 ${anchors.length - MAX_ACTIVE_ANCHORS} 个活跃锚点未注入，请在锚点管理中精简活跃数量≤${MAX_ACTIVE_ANCHORS}）`
    : ''
  return [
    '【创作锚点约束 - 必须严格遵守】',
    '以下锚点是作者的核心创作意图，不可更改或忽略：',
    ...lines,
    overflowNote
  ].filter(Boolean).join('\n')
}

function resolveStyleTexts(request: ModelRequest): {
  languageText: string
  stepRulesText: string
  styleId?: number
} {
  let styleId = request.styleId
  let languageText = ''
  let stepRulesText = ''

  if (!styleId && request.workId) {
    const workStyles = writingStyleDAO.getByWork(request.workId)
    if (workStyles.length > 0) styleId = workStyles[0].id
  }

  if (styleId) {
    const style = writingStyleDAO.getById(styleId)
    const workBinding = request.workId
      ? writingStyleDAO.getWorkStyleBinding(request.workId)
      : null
    const evolutionJson =
      workBinding?.style_id === styleId ? workBinding.evolution_curve_json : null

    if (style) {
      const injection = resolveStepStyleInjection(
        request.step,
        style.prompt_template,
        style.step_rules_json
      )
      languageText = injection.languageText ?? ''
      stepRulesText = injection.stepRulesText ?? ''

      if (request.workId && !isCoreSettingsAiGenerateStep(request.step)) {
        const progress = computeWorkChapterProgress(request.workId, request.chapterId)
        const evolutionText = formatEvolutionPrompt(evolutionJson, progress)
        if (evolutionText) {
          if (languageText) languageText = `${languageText}\n\n${evolutionText}`
          else if (stepRulesText) stepRulesText = `${stepRulesText}\n\n${evolutionText}`
          else stepRulesText = evolutionText
        }
      }

    }
  }

  return { languageText, stepRulesText, styleId }
}

export function collectPromptSections(
  request: ModelRequest,
  continuity?: ChapterContinuityContext,
  narrativeMemory?: NarrativeMemoryResult
): PromptSection[] {
  const sections: PromptSection[] = []
  const workId = request.workId

  const isBodyStep =
    request.step === 'body_generation' || !!request.step?.startsWith('body_')

  const shouldEnrichMemory = request.enrichNarrativeMemory !== false && (
    request.enrichNarrativeMemory === true ||
    isBodyStep
  )

  let chapterCharacterNames: string[] | undefined
  if (isBodyStep && workId && request.chapterId) {
    const ch = volumeChapterDAO.getChapter(request.chapterId)
    if (ch) {
      chapterCharacterNames = resolveChapterCharacterNames(workId, ch)
    }
  }

  // ── System Zone 1: prompt 开头（高注意力）── 写作规则 / 人设 / 关键约束
  if (request.systemPrompt?.trim()) {
    let baseSystemText = request.systemPrompt.trim()
    if (workId && isBodyStep && hasStyleReferenceText(workId)) {
      const styleDirective = resolvePrompt('body_generation.style_core_directive')?.trim()
      if (styleDirective && !baseSystemText.includes('【目标范文】')) {
        baseSystemText = `${baseSystemText}\n${styleDirective}`
      }
    }
    sections.push(systemRuleSection({
      key: 'base_system',
      label: '基础系统提示',
      priority: 0,
      renderOrder: 0,
      text: baseSystemText,
      trimStrategy: 'none'
    }))
  }

  if (workId && isBodyStep) {
    const persona = buildAntiAiPersonaForWork(workId)
    if (persona) {
      sections.push(systemRuleSection({
        key: 'anti_ai_persona',
        label: '写作人设',
        priority: 1,
        renderOrder: 2,
        text: persona,
        trimStrategy: 'none'
      }))
    }
  }

  if (shouldInjectWritingStyle(request.step)) {
    const { languageText, stepRulesText } = resolveStyleTexts(request)
    if (languageText) {
      sections.push(systemRuleSection({
        key: 'style',
        label: '文风模板',
        priority: 9,
        renderOrder: 5,
        text: languageText,
        trimStrategy: 'none'
      }))
    }
    if (stepRulesText) {
      sections.push(systemRuleSection({
        key: 'style_step_rules',
        label: '文风分步规则',
        priority: 9,
        renderOrder: 6,
        text: stepRulesText,
        trimStrategy: 'none'
      }))
    }
  }

  if (
    workId &&
    (request.step === 'body_generation' || request.step?.startsWith('body_'))
  ) {
    const antiAiText = formatAntiAiRulesForPrompt(workId)
    if (antiAiText) {
      sections.push(systemRuleSection({
        key: 'anti_ai_rules',
        label: '去AI味强制规则',
        priority: 15,
        renderOrder: 10,
        text: antiAiText,
        trimStrategy: 'none'
      }))
    }

    sections.push(systemRuleSection({
      key: 'body_continuity_rule',
      label: '正文连贯性约束',
      priority: 12,
      renderOrder: 15,
      text: resolvePrompt('body_generation.continuity_rule') || BODY_CONTINUITY_RULE,
      trimStrategy: 'none'
    }))
  }

  if (isBodyStep && chapterCharacterNames?.length) {
    const focusHint = buildFocusCharacterHint(chapterCharacterNames)
    if (focusHint) {
      sections.push(systemRuleSection({
        key: 'focus_characters',
        label: '本章焦点角色',
        priority: 2,
        renderOrder: 20,
        text: focusHint,
        trimStrategy: 'none'
      }))
    }
  }

  // ── User context ── 排列顺序不变
  if (workId && request.chapterId && shouldEnrichMemory) {
    const ctx = continuity ?? getPreviousChapterContext(workId, request.chapterId)
    const continuityText = formatContinuityPrompt(ctx)
    if (continuityText) {
      sections.push(userContextSection({
        key: 'continuity',
        label: '上一章全文',
        priority: 1,
        text: continuityText,
        trimStrategy: 'tail'
      }))
    }
  }

  const memory = shouldEnrichMemory
    ? (narrativeMemory ?? (workId
      ? buildNarrativeMemorySections(workId, request.chapterId, {
        includeChapterOutline: !isBodyStep
      })
      : null))
    : null
  if (memory?.sections.chapterMeta) {
    sections.push(userContextSection({
      key: 'chapter_meta',
      label: '本章大纲/ABC/人设',
      priority: 2,
      text: memory.sections.chapterMeta,
      trimStrategy: 'drop'
    }))
  }

  if (memory?.sections.foreshadowing) {
    sections.push(userContextSection({
      key: 'foreshadowing',
      label: '待回收伏笔',
      priority: 3,
      text: memory.sections.foreshadowing,
      trimStrategy: 'drop'
    }))
  }

  if (memory?.sections.snapshots) {
    sections.push(userContextSection({
      key: 'snapshots',
      label: '角色快照',
      priority: 3,
      text: memory.sections.snapshots,
      trimStrategy: 'drop'
    }))
  }

  if (workId && request.chapterId && shouldEnrichMemory) {
    const ch = volumeChapterDAO.getChapter(request.chapterId)
    const retrieved = retrieveRelevantChapters(workId, request.chapterId, ch?.outline || '')
    const retrievedText = formatRetrievedChapters(retrieved)
    if (retrievedText) {
      sections.push(userContextSection({
        key: 'retrieved_chapters',
        label: '相关历史章节',
        priority: 4,
        text: retrievedText,
        trimStrategy: 'drop'
      }))
    }
  }

  // ── System Zone 2: prompt 中段（低注意力）── 大段参考性上下文
  if (memory?.sections.worldview) {
    sections.push(systemRuleSection({
      key: 'worldview',
      label: '世界观规则',
      priority: 6,
      renderOrder: 40,
      text: memory.sections.worldview,
      trimStrategy: 'drop'
    }))
  }

  if (memory?.sections.timeline) {
    sections.push(systemRuleSection({
      key: 'timeline',
      label: '故事时间线',
      priority: 7,
      renderOrder: 45,
      text: memory.sections.timeline,
      trimStrategy: 'drop'
    }))
  }

  if (workId && request.enrichWorkContext !== false) {
    let workCtxOptions = request.workContextOptions ?? {}
    const hasWorldviewSection = !!memory?.sections.worldview
    if (isBodyStep && request.chapterId) {
      const ch = volumeChapterDAO.getChapter(request.chapterId)
      workCtxOptions = {
        ...workCtxOptions,
        volumeOutlineMode: workCtxOptions.volumeOutlineMode ?? 'compact',
        currentVolumeId: workCtxOptions.currentVolumeId ?? ch?.volume_id
      }
    }
    if (hasWorldviewSection) {
      workCtxOptions = {
        ...workCtxOptions,
        excludeCoreTypes: [...(workCtxOptions.excludeCoreTypes ?? []), 'worldview']
      }
    }
    const ctx = buildWorkContext(workId, workCtxOptions)
    if (ctx.text) {
      sections.push(systemRuleSection({
        key: 'work_context',
        label: '作品上下文',
        priority: 8,
        renderOrder: 50,
        text: ctx.text,
        trimStrategy: 'drop'
      }))
    }
  }

  // ── System Zone 3: prompt 末尾（高注意力）── 锚点 / 偏好 / 示范 / 自检
  if (workId && shouldInjectAnchors(request.step)) {
    const allActive = anchorDAO.listActiveByWork(workId)
    let anchors = allActive

    if (anchors.length > 0) {
      const chId = request.chapterId
      const volId = request.volumeId
      if (chId) {
        const ch = volumeChapterDAO.getChapter(chId)
        if (ch) {
          anchors = filterAnchorsForChapter(anchors, ch).applicable
        }
      } else if (volId) {
        anchors = filterAnchorsForVolume(anchors, volId).applicable
      }
    }

    if (anchors.length > 0) {
      const scopeNote = anchors.length < allActive.length
        ? `创作锚点（${anchors.length}/${allActive.length}）`
        : '创作锚点'
      sections.push(systemRuleSection({
        key: 'anchors',
        label: scopeNote,
        priority: 5,
        renderOrder: 75,
        text: formatAnchorsForPrompt(anchors),
        trimStrategy: 'drop'
      }))
    }
  }

  if (workId && shouldInjectTasteAndConditionRules(request.step)) {
    const tasteText = formatTasteForPrompt(workId)
    if (tasteText) {
      sections.push(systemRuleSection({
        key: 'taste',
        label: '品味偏好',
        priority: 10,
        renderOrder: 80,
        text: tasteText,
        trimStrategy: 'none'
      }))
    }

    const rulesText = formatConditionRulesForPrompt(workId)
    if (rulesText) {
      sections.push(systemRuleSection({
        key: 'condition_rules',
        label: '全局创作规则',
        priority: 11,
        renderOrder: 85,
        text: rulesText,
        trimStrategy: 'none'
      }))
    }
  }

  if (workId && request.step === 'volumes_outline') {
    sections.push(systemRuleSection({
      key: 'volume_outline_length',
      label: '分卷大纲体裁',
      priority: 12,
      renderOrder: 90,
      text: VOLUME_OUTLINE_LENGTH_RULES,
      trimStrategy: 'none'
    }))
  }

  if (
    workId &&
    (request.step === 'chapter_outline' ||
      request.step === 'volume_chapters_batch' ||
      request.step?.startsWith('chapter_outline_'))
  ) {
    sections.push(systemRuleSection({
      key: 'chapter_outline_length',
      label: '章节大纲体裁',
      priority: 12,
      renderOrder: 90,
      text: CHAPTER_OUTLINE_LENGTH_RULES,
      trimStrategy: 'none'
    }))
  }

  if (
    workId &&
    (request.step === 'body_generation' || request.step?.startsWith('body_'))
  ) {
    const fewShotText = buildStyleFewShot(workId)
    if (fewShotText) {
      sections.push(systemRuleSection({
        key: 'style_fewshot',
        label: '目标范文',
        priority: 8,
        renderOrder: 4,
        text: fewShotText,
        trimStrategy: 'tail'
      }))

      if (hasStyleReferenceText(workId)) {
        const anchorTemplate = resolvePrompt('body_generation.style_anchor')
        if (anchorTemplate) {
          sections.push(userContextSection({
            key: 'style_anchor',
            label: '文风尾注锚定',
            priority: 0,
            renderOrder: 9999,
            text: anchorTemplate,
            trimStrategy: 'drop'
          }))
        }
      }
    }
  }

  return sections
}

function calcPressure(usageRatio: number): ContextPressure {
  if (usageRatio >= 1) return 'blocking'
  if (usageRatio >= 0.95) return 'critical'
  if (usageRatio >= 0.85) return 'warning'
  return 'safe'
}

function tailTrimSection(text: string, targetTokens: number): string {
  const marker = '【上一章全文 - 本章须从此文自然延续】'
  const idx = text.indexOf(marker)
  if (idx < 0) {
    const chars = Math.max(500, Math.floor(targetTokens * 1.5))
    return trimContinuityToTail(text, chars)
  }
  const header = text.slice(0, idx)
  const body = text.slice(idx)
  const titleEnd = body.indexOf('\n\n')
  const prefix = titleEnd >= 0 ? body.slice(0, titleEnd + 2) : marker + '\n\n'
  const content = titleEnd >= 0 ? body.slice(titleEnd + 2) : body
  const footerIdx = content.lastIndexOf('\n\n（禁止重述')
  const mainContent = footerIdx >= 0 ? content.slice(0, footerIdx) : content
  const footer = footerIdx >= 0 ? content.slice(footerIdx) : '\n\n（禁止重述上一章已写内容；从结尾情境、对话或动作直接承接往下写）'
  const budgetChars = Math.max(800, Math.floor(targetTokens * 1.5))
  return header + prefix + trimContinuityToTail(mainContent, budgetChars) + footer
}

export function assembleBudgetedPrompt(
  taskPrompt: string,
  sections: PromptSection[],
  maxContextTokens: number,
  reservedOutputTokens: number
): { systemPrompt: string; userPrompt: string; report: ContextBudgetReport } {
  const warnings: string[] = []
  const taskTokens = estimateTokens(taskPrompt)
  const overhead = MESSAGE_OVERHEAD_TOKENS * 2

  type Working = PromptSection & { workingText: string; included: boolean; trimmed: boolean; note?: string }
  const working: Working[] = sections.map(s => ({
    ...s,
    workingText: s.text,
    included: !!s.text,
    trimmed: false
  }))

  const fixedSystemWorking = working.filter(w => w.target === 'system' && w.trimStrategy === 'none')
  const droppableSystemWorking = working.filter(w => w.target === 'system' && w.trimStrategy !== 'none')
  const userContextWorking = working.filter(w => w.target === 'user')

  function totalFixedSystemTokens(): number {
    return fixedSystemWorking
      .filter(w => w.included && w.workingText)
      .reduce((sum, w) => sum + estimateTokens(w.workingText), 0)
  }

  function totalDroppableSystemTokens(): number {
    return droppableSystemWorking
      .filter(w => w.included && w.workingText)
      .reduce((sum, w) => sum + estimateTokens(w.workingText), 0)
  }

  function totalUserContextTokens(): number {
    return userContextWorking
      .filter(w => w.included && w.workingText)
      .reduce((sum, w) => sum + estimateTokens(w.workingText), 0)
  }

  const fixedSystemTokens = totalFixedSystemTokens()
  let droppableSystemTokens = totalDroppableSystemTokens()
  let userContextTokens = totalUserContextTokens()
  let continuityMode: ContextBudgetReport['continuityMode'] = 'none'
  const continuity = userContextWorking.find(w => w.key === 'continuity')
  if (continuity?.included) continuityMode = 'full'

  const separatorTokens = userContextTokens > 0 && taskPrompt.trim()
    ? estimateTokens(USER_TASK_SEPARATOR)
    : 0
  const fixedInputTokens = fixedSystemTokens + taskTokens + separatorTokens + overhead + reservedOutputTokens
  let contextBudget = Math.max(0, maxContextTokens - fixedInputTokens)
  let flexibleTokens = droppableSystemTokens + userContextTokens

  if (flexibleTokens > contextBudget) {
    // Phase 1: trim user context sections first (lower tier)
    const sortedUser = [...userContextWorking]
      .filter(w => w.included && w.trimStrategy !== 'none')
      .sort((a, b) => b.priority - a.priority)

    for (const item of sortedUser) {
      flexibleTokens = totalDroppableSystemTokens() + totalUserContextTokens()
      if (flexibleTokens <= contextBudget) break

      if (item.trimStrategy === 'drop') {
        item.included = false
        item.workingText = ''
        warnings.push(`已移除「${item.label}」以控制上下文体积`)
        continue
      }

      if (item.trimStrategy === 'tail' && item.key === 'continuity') {
        const overflow = flexibleTokens - contextBudget
        const currentTokens = estimateTokens(item.workingText)
        const targetTokens = Math.max(800, currentTokens - overflow - 500)
        item.workingText = tailTrimSection(item.text, targetTokens)
        item.trimmed = true
        continuityMode = 'tail'
        warnings.push(`上一章全文已裁剪为末尾约 ${Math.floor(targetTokens * 1.5)} 字以适配模型上下文上限`)
      }
    }

    flexibleTokens = totalDroppableSystemTokens() + totalUserContextTokens()
    if (flexibleTokens > contextBudget) {
      for (const item of sortedUser.filter(w => w.included && w.trimStrategy === 'tail')) {
        flexibleTokens = totalDroppableSystemTokens() + totalUserContextTokens()
        if (flexibleTokens <= contextBudget) break
        const targetTokens = Math.max(400, Math.floor(contextBudget * 0.15))
        item.workingText = tailTrimSection(item.text, targetTokens)
        item.trimmed = true
        continuityMode = 'tail'
      }
    }

    // Phase 2a: trim system sections with 'tail' strategy (head-truncate for reference text)
    flexibleTokens = totalDroppableSystemTokens() + totalUserContextTokens()
    if (flexibleTokens > contextBudget) {
      const tailSystemItems = droppableSystemWorking.filter(w => w.included && w.trimStrategy === 'tail')
      for (const item of tailSystemItems) {
        flexibleTokens = totalDroppableSystemTokens() + totalUserContextTokens()
        if (flexibleTokens <= contextBudget) break
        const overflow = flexibleTokens - contextBudget
        const currentTokens = estimateTokens(item.workingText)
        const targetTokens = Math.max(400, currentTokens - overflow - 200)
        const targetChars = Math.max(600, Math.floor(targetTokens * 1.5))
        if (targetChars < item.workingText.length) {
          item.workingText = item.workingText.slice(0, targetChars) + '\n……（范文已截断以适配上下文）'
          item.trimmed = true
          warnings.push(`「${item.label}」已截断为约 ${targetChars} 字以控制上下文体积`)
        }
      }
    }

    // Phase 2b: if still over budget, drop system sections marked as droppable
    flexibleTokens = totalDroppableSystemTokens() + totalUserContextTokens()
    if (flexibleTokens > contextBudget) {
      const sortedDroppableSystem = [...droppableSystemWorking]
        .filter(w => w.included && w.trimStrategy === 'drop')
        .sort((a, b) => b.priority - a.priority)

      for (const item of sortedDroppableSystem) {
        flexibleTokens = totalDroppableSystemTokens() + totalUserContextTokens()
        if (flexibleTokens <= contextBudget) break
        item.included = false
        item.workingText = ''
        warnings.push(`已移除系统设定「${item.label}」以控制上下文体积`)
      }
    }
  }

  const renderOrderOf = (w: Working) => w.renderOrder ?? w.priority

  const includedUserContext = userContextWorking
    .filter(w => w.included && w.workingText)
    .sort((a, b) => renderOrderOf(a) - renderOrderOf(b))
  const contextBlock = includedUserContext.map(w => w.workingText).join('\n\n')
  const userPrompt = contextBlock && taskPrompt.trim()
    ? `${contextBlock}${USER_TASK_SEPARATOR}${taskPrompt.trim()}`
    : contextBlock || taskPrompt

  const allSystemWorking = [...fixedSystemWorking, ...droppableSystemWorking]
  const systemTokens = allSystemWorking
    .filter(w => w.included && w.workingText)
    .reduce((sum, w) => sum + estimateTokens(w.workingText), 0)

  const userTokens = estimateTokens(userPrompt)
  const usedTokens = systemTokens + userTokens + overhead + reservedOutputTokens
  const usageRatio = maxContextTokens > 0 ? usedTokens / maxContextTokens : 1
  const pressure = calcPressure(usageRatio)
  const inputBudget = Math.max(0, maxContextTokens - reservedOutputTokens - overhead - userTokens)

  if (pressure === 'warning') {
    warnings.push(`上下文使用率 ${Math.round(usageRatio * 100)}%，接近模型上限`)
  } else if (pressure === 'critical') {
    warnings.push(`上下文使用率 ${Math.round(usageRatio * 100)}%，已触发严重预警`)
  } else if (pressure === 'blocking') {
    warnings.push(`上下文预估超出模型上限（${maxContextTokens.toLocaleString()} tokens），请精简设定或提高「最大上下文」配置`)
  }

  const includedSystem = allSystemWorking
    .filter(w => w.included && w.workingText)
    .sort((a, b) => renderOrderOf(a) - renderOrderOf(b))
  const systemPrompt = includedSystem.map(w => w.workingText).join('\n\n')

  const reportSections: ContextBudgetSection[] = working.map(w => ({
    key: w.key,
    label: w.label,
    tokens: w.included ? estimateTokens(w.workingText) : 0,
    included: w.included && !!w.workingText,
    trimmed: w.trimmed,
    target: w.target,
    note: w.note
  }))

  return {
    systemPrompt,
    userPrompt,
    report: {
      maxContextTokens,
      reservedOutputTokens,
      inputBudget,
      usedTokens,
      usageRatio,
      pressure,
      warnings: [...new Set(warnings)],
      sections: reportSections,
      continuityMode
    }
  }
}

export function getMaxContextTokens(modelType?: string): number {
  if (modelType) {
    const cfg = modelConfigDAO.getByType(modelType)
    if (cfg?.max_context_tokens && cfg.max_context_tokens > 0) {
      return cfg.max_context_tokens
    }
  }
  const primary = modelConfigDAO.getPrimary()
  if (primary?.max_context_tokens && primary.max_context_tokens > 0) {
    return primary.max_context_tokens
  }
  return DEFAULT_MAX_CONTEXT_TOKENS
}

export function estimateContextBudget(request: ModelRequest): ContextBudgetReport {
  const maxContext = getMaxContextTokens(request.modelType)
  const saved = appPreferenceDAO.getGenerationParams()
  const reservedOutput = request.maxTokens ?? saved.maxTokens ?? 4096
  const sections = collectPromptSections(request)
  const { report } = assembleBudgetedPrompt(request.prompt, sections, maxContext, reservedOutput)
  return report
}
