import { coreSettingDAO, workDAO } from '../db'
import { GENRE_TREE, getChecksByGenre, getGenreNode, isGenreId } from '../../shared/genre-worldview-config'
import {
  CORE_SETTING_LABELS,
  CORE_SETTING_DEPENDENCIES,
  type CoreSettingType,
  getCoreSettingLabel
} from '../../shared/settings-types'
import type { WorkContextResult } from './work-context'
import { formatQualityIssuesForGeneration } from './settings-quality'
import { modelService } from '../model'
import { formatAllCharacterCardsSummary, loadCharacterCards } from './character-cards'
import {
  buildFrozenStorylineContext,
  buildStorylineContextFromIdea,
  CHARACTER_SETTING_SLOT_KEYS
} from './incubator/build-storyline-context'

export type { CoreSettingType }
export type CoreSettingGenerateType = CoreSettingType // 向后兼容旧调用

export type GenreDetectMode = 'strict' | 'balanced' | 'loose'

const GENRE_DETECT_MODES: readonly GenreDetectMode[] = ['strict', 'balanced', 'loose']

export interface SettingsGenerationContextOptions {
  selfDraft?: string
  userHints?: string
  genreIdOverride?: string
  genreDetectMode?: GenreDetectMode
}

export interface SettingsGenerationContextResult extends WorkContextResult {
  meta?: {
    worldviewGenre?: {
      inferredGenreId: string | null
      inferredGenreLabel: string
      resolvedGenreId: string
      resolvedGenreLabel: string
      overridden: boolean
      source: 'keyword' | 'ai_fallback'
    }
  }
}

export type SettingGenHintsKind = CoreSettingType | 'character_cards'

export function normalizeGenreDetectMode(mode: string | null | undefined): GenreDetectMode {
  if (!mode) return 'balanced'
  return (GENRE_DETECT_MODES as readonly string[]).includes(mode)
    ? mode as GenreDetectMode
    : 'balanced'
}

// ==================== 体裁检测（仅用于 world_pressure） ====================

function countKeywordMatches(text: string, keywords: string[]): number {
  if (!text.trim()) return 0
  let score = 0
  for (const kw of keywords) {
    const token = kw.trim()
    if (!token) continue
    if (text.includes(token)) score += 1
  }
  return score
}

interface GenreKeywordCandidate {
  id: string
  score: number
}

function inferGenreByKeywords(text: string): {
  genreId: string | null
  candidates: GenreKeywordCandidate[]
  bestScore: number
  scoreGap: number
} {
  const source = text.trim()
  if (!source) return { genreId: null, candidates: [], bestScore: 0, scoreGap: 0 }

  const candidates: GenreKeywordCandidate[] = []
  for (const genre of GENRE_TREE) {
    const score = countKeywordMatches(source, [genre.label, ...genre.children])
    if (score <= 0) continue
    candidates.push({ id: genre.id, score })
  }
  candidates.sort((a, b) => b.score - a.score)

  const best = candidates[0] ?? null
  const second = candidates[1] ?? null
  const bestScore = best?.score ?? 0
  const scoreGap = best && second ? best.score - second.score : best ? best.score : 0

  return { genreId: best?.id ?? null, candidates, bestScore, scoreGap }
}

function shouldUseGenreAiFallback(input: {
  mode: GenreDetectMode
  hasBest: boolean
  bestScore: number
  scoreGap: number
  hasSecond: boolean
}): boolean {
  if (!input.hasBest) return true
  if (input.mode === 'strict') {
    return input.bestScore <= 2 || (input.hasSecond && input.scoreGap <= 1)
  }
  if (input.mode === 'loose') {
    return input.hasSecond && input.scoreGap <= 0
  }
  return input.bestScore <= 1 || (input.hasSecond && input.scoreGap <= 0)
}

interface GenreAiJudgeResult {
  genreId: string | null
}

function parseGenreAiJudge(content: string): GenreAiJudgeResult | null {
  const trimmed = content.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim()
  const inline = trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed : null
  const tail = (() => {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    return start >= 0 && end > start ? trimmed.slice(start, end + 1).trim() : null
  })()
  const candidates = [fenced, inline, tail].filter((x): x is string => !!x)

  for (const jsonText of candidates) {
    try {
      const parsed = JSON.parse(jsonText) as unknown
      if (!parsed || typeof parsed !== 'object') continue
      const genreId = typeof (parsed as { genreId?: unknown }).genreId === 'string'
        ? (parsed as { genreId: string }).genreId.trim()
        : ''
      if (!genreId || genreId === 'default') return { genreId: null }
      if (isGenreId(genreId)) return { genreId }
    } catch { continue }
  }
  return null
}

async function inferGenreIdWithAiFallback(input: {
  source: string
  keywordGenreId: string | null
  keywordCandidates: GenreKeywordCandidate[]
  workId: number
}): Promise<{ genreId: string | null; source: 'keyword' | 'ai_fallback' }> {
  const candidateLines = GENRE_TREE
    .map(g => `- ${g.id}: ${g.label}（子类：${g.children.join('、')}）`)
    .join('\n')
  const keywordTop = input.keywordCandidates
    .slice(0, 5)
    .map(c => `${c.id}:${c.score}`)
    .join(', ')

  const prompt = [
    '请根据下述故事信息判断最匹配的小说题材。',
    '输出严格 JSON：{"genreId":"<id或default>"}',
    '仅可从候选 id 中选择；不确定时输出 default。',
    '',
    `关键词初判：${input.keywordGenreId ?? 'default'}${keywordTop ? `（候选分数：${keywordTop}）` : ''}`,
    '',
    '【候选题材】',
    candidateLines,
    '',
    '【故事信息】',
    input.source
  ].join('\n')

  const res = await modelService.chat({
    prompt,
    systemPrompt: [
      '你是小说题材分类器。',
      '必须只返回一个 JSON 代码块或裸 JSON，不要解释。',
      '若文本不足以判断，输出 {"genreId":"default"}。'
    ].join('\n'),
    workId: input.workId,
    step: 'settings_worldview_genre_detect',
    enrichWorkContext: false,
    enrichNarrativeMemory: false,
    temperature: 0.1,
    maxTokens: 160
  })

  if (!res.success) return { genreId: input.keywordGenreId, source: 'keyword' }
  const judged = parseGenreAiJudge(res.content)
  if (!judged) return { genreId: input.keywordGenreId, source: 'keyword' }
  return { genreId: judged.genreId, source: 'ai_fallback' }
}

async function buildWorldviewGenreChecksSection(input: {
  workId: number
  storyline: string
  ideaRaw?: string
  userHints?: string
  genreIdOverride?: string
  genreDetectMode?: GenreDetectMode
}): Promise<{
  text: string
  meta: NonNullable<SettingsGenerationContextResult['meta']>['worldviewGenre']
}> {
  const source = [
    input.userHints?.trim() ?? '',
    input.storyline.trim(),
    input.ideaRaw?.trim() ?? ''
  ].filter(Boolean).join('\n')

  const detectMode = normalizeGenreDetectMode(input.genreDetectMode)
  const keywordResult = inferGenreByKeywords(source)
  let inferredGenreId = keywordResult.genreId
  let inferredSource: 'keyword' | 'ai_fallback' = 'keyword'
  const shouldFallback = shouldUseGenreAiFallback({
    mode: detectMode,
    hasBest: !!keywordResult.genreId,
    bestScore: keywordResult.bestScore,
    scoreGap: keywordResult.scoreGap,
    hasSecond: keywordResult.candidates.length > 1
  })
  if (shouldFallback) {
    const aiFallback = await inferGenreIdWithAiFallback({
      source,
      keywordGenreId: keywordResult.genreId,
      keywordCandidates: keywordResult.candidates,
      workId: input.workId
    })
    inferredGenreId = aiFallback.genreId
    inferredSource = aiFallback.source
  }
  const inferredNode = inferredGenreId ? getGenreNode(inferredGenreId) : null
  const overrideGenreId = input.genreIdOverride?.trim()
  const useOverride = !!(overrideGenreId && isGenreId(overrideGenreId))
  const resolved = getChecksByGenre(useOverride ? overrideGenreId : inferredGenreId ?? undefined)
  const resolvedNode = getGenreNode(resolved.genreId)
  const resolvedLabel = resolvedNode?.label ?? '通用'

  const required = resolved.required.map(item =>
    `- [阻断] ${item.label}：${item.question}`
  )
  const extra = resolved.extra.map(item =>
    `- [建议] ${item.label}：${item.question}`
  )

  const lines = [
    `识别题材：${inferredNode?.label ?? '未识别（通用）'}`,
    useOverride
      ? `已手动指定题材：${resolvedLabel}（覆盖自动识别）`
      : inferredGenreId
        ? '请优先满足下列题材适配检查项。'
        : '未识别到明确题材，使用通用检查项。'
  ]
  if (required.length) lines.push('', '### 必须覆盖（阻断项）', ...required)
  if (extra.length) lines.push('', '### 建议覆盖（优化项）', ...extra)
  return {
    text: lines.join('\n'),
    meta: {
      inferredGenreId,
      inferredGenreLabel: inferredNode?.label ?? '未识别（通用）',
      resolvedGenreId: resolved.genreId,
      resolvedGenreLabel: resolvedLabel,
      overridden: useOverride,
      source: inferredSource
    }
  }
}

// ==================== 主线上下文 ====================

function buildCharacterStorylineContext(workId: number, ideaRaw?: string): string {
  const fromFrozen = buildFrozenStorylineContext(workId, {
    includeSlots: true,
    slotKeys: CHARACTER_SETTING_SLOT_KEYS
  })
  if (fromFrozen) return fromFrozen
  if (ideaRaw) {
    return buildStorylineContextFromIdea(ideaRaw, {
      includeSlots: true,
      slotKeys: CHARACTER_SETTING_SLOT_KEYS
    })
  }
  return ''
}

function buildDownstreamStorylineContext(workId: number, ideaRaw?: string): string {
  const fromFrozen = buildFrozenStorylineContext(workId, { includeSlots: true })
  if (fromFrozen) return fromFrozen
  if (ideaRaw) {
    return buildStorylineContextFromIdea(ideaRaw, { includeSlots: true })
  }
  return ''
}

function buildConflictStructureChecklist(workId: number): string {
  const cards = loadCharacterCards(workId)
  const keyRoles = cards.slice(0, 8).map(card => `${card.name}（${card.role}）`)
  const lines = [
    '请按"可执行冲突引擎"来组织冲突：',
    '- 对立双方：谁要达成什么，谁在阻止什么',
    '- 不可调和点：双方底线为何无法共存',
    '- 失败代价（赌注）：主角失败后将失去什么（至少两项）',
    '- 升级路径：至少 3 个阶段（触发 → 加压 → 反转/爆发）',
    '- 角色绑定：每个阶段对应到具体角色的选择，而非抽象设定'
  ]
  if (keyRoles.length > 0) {
    lines.push('', `优先绑定角色：${keyRoles.join('、')}`)
  }
  return lines.join('\n')
}

// ==================== 各类型独立上下文构建 ====================

/** 主角设计：优先从冻结快照获取角色相关槽位 + 结构化人设卡片 */
function buildProtagonistContext(workId: number, ideaRaw?: string): string {
  const parts: string[] = []
  const storyline = buildCharacterStorylineContext(workId, ideaRaw)
  if (storyline) parts.push(storyline)

  const cardsSummary = formatAllCharacterCardsSummary(workId).trim()
  if (cardsSummary) parts.push('## 已有角色信息\n' + cardsSummary)

  return parts.join('\n\n')
}

/** 金手指：依赖主角 + 主线 */
function buildGoldenFingerContext(
  workId: number,
  ideaRaw?: string,
  protagonistContent?: string,
  isStory = false
): string {
  const parts: string[] = []
  const storyline = buildCharacterStorylineContext(workId, ideaRaw)
  if (storyline) parts.push(storyline)

  if (protagonistContent?.trim()) {
    parts.push(`## ${getCoreSettingLabel('protagonist', isStory)}\n${protagonistContent.trim()}`)
  }

  return parts.join('\n\n')
}

/** 世界观压力规则：依赖主角 + 金手指 + 主线 + 体裁检测 */
function buildWorldPressureContext(
  workId: number,
  ideaRaw?: string,
  protagonistContent?: string,
  goldenFingerContent?: string,
  isStory = false
): string {
  const parts: string[] = []
  const storyline = buildDownstreamStorylineContext(workId, ideaRaw)
  if (storyline) parts.push(storyline)

  if (protagonistContent?.trim()) {
    parts.push(`## ${getCoreSettingLabel('protagonist', isStory)}\n${protagonistContent.trim()}`)
  }
  if (goldenFingerContent?.trim()) {
    parts.push(`## ${getCoreSettingLabel('golden_finger', isStory)}\n${goldenFingerContent.trim()}`)
  }

  return parts.join('\n\n')
}

/** 冲突升级引擎：依赖主角 + 世界观压力 + 主线 */
function buildConflictEngineContext(
  workId: number,
  ideaRaw?: string,
  protagonistContent?: string,
  worldPressureContent?: string,
  isStory = false
): string {
  const parts: string[] = []
  const storyline = buildDownstreamStorylineContext(workId, ideaRaw)
  if (storyline) parts.push(storyline)

  if (protagonistContent?.trim()) {
    parts.push(`## ${getCoreSettingLabel('protagonist', isStory)}\n${protagonistContent.trim()}`)
  }
  if (worldPressureContent?.trim()) {
    parts.push(`## ${getCoreSettingLabel('world_pressure', isStory)}\n${worldPressureContent.trim()}`)
  }

  return parts.join('\n\n')
}

/** 爽点机制：依赖主角 + 金手指 + 冲突升级 + 主线 */
function buildPleasureEngineContext(
  workId: number,
  ideaRaw?: string,
  protagonistContent?: string,
  goldenFingerContent?: string,
  conflictEngineContent?: string,
  isStory = false
): string {
  const parts: string[] = []
  const storyline = buildDownstreamStorylineContext(workId, ideaRaw)
  if (storyline) parts.push(storyline)

  if (protagonistContent?.trim()) {
    parts.push(`## ${getCoreSettingLabel('protagonist', isStory)}\n${protagonistContent.trim()}`)
  }
  if (goldenFingerContent?.trim()) {
    parts.push(`## ${getCoreSettingLabel('golden_finger', isStory)}\n${goldenFingerContent.trim()}`)
  }
  if (conflictEngineContent?.trim()) {
    parts.push(`## ${getCoreSettingLabel('conflict_engine', isStory)}\n${conflictEngineContent.trim()}`)
  }

  return parts.join('\n\n')
}

/** 配角功能组：依赖主角 + 冲突升级 + 主线 + 结构化人设卡片 */
function buildSupportingCastContext(
  workId: number,
  ideaRaw?: string,
  protagonistContent?: string,
  conflictEngineContent?: string,
  isStory = false
): string {
  const parts: string[] = []
  const storyline = buildDownstreamStorylineContext(workId, ideaRaw)
  if (storyline) parts.push(storyline)

  if (protagonistContent?.trim()) {
    parts.push(`## ${getCoreSettingLabel('protagonist', isStory)}\n${protagonistContent.trim()}`)
  }
  if (conflictEngineContent?.trim()) {
    parts.push(`## ${getCoreSettingLabel('conflict_engine', isStory)}\n${conflictEngineContent.trim()}`)
  }

  const cardsSummary = formatAllCharacterCardsSummary(workId).trim()
  if (cardsSummary) parts.push('## 已有结构化人设卡片\n' + cardsSummary)

  return parts.join('\n\n')
}

// ==================== 主入口 ====================

/**
 * 核心设定「AI 生成」专用上下文。
 * 按依赖链自动加载已填槽位和依赖设定，确保 AI 产出与已有设定自洽。
 */
export async function buildSettingsGenerationContext(
  workId: number,
  targetType: CoreSettingType,
  options: SettingsGenerationContextOptions = {}
): Promise<SettingsGenerationContextResult> {
  const work = workDAO.getById(workId)
  const isStory = work?.work_type === 'story'

  const settings = coreSettingDAO.listByWork(workId)
  const byType = new Map(settings.map(s => [s.type, s.content]))
  const sections: Record<string, string> = {}
  const meta: NonNullable<SettingsGenerationContextResult['meta']> = {}

  const ideaRaw = byType.get('idea')?.trim()

  // 加载依赖设定
  const deps: Partial<Record<CoreSettingType, string>> = {}
  for (const depType of CORE_SETTING_DEPENDENCIES[targetType]) {
    const content = byType.get(depType)?.trim()
    if (content) deps[depType] = content
  }

  // 按类型构建上下文
  switch (targetType) {
    case 'protagonist': {
      const ctx = buildProtagonistContext(workId, ideaRaw)
      if (ctx) sections['主线故事线'] = ctx

      // 用户补充
      const userHints = options.userHints?.trim()
      if (userHints) sections['用户补充要求'] = userHints

      // 草稿优化
      const selfDraft = options.selfDraft?.trim()
      if (selfDraft) {
        sections[`当前${getCoreSettingLabel('protagonist', isStory)}草稿`] = [
          '（请在现有草稿基础上优化与补全，勿整段重复已有结构）',
          selfDraft
        ].join('\n\n')
      }
      break
    }

    case 'golden_finger': {
      const ctx = buildGoldenFingerContext(workId, ideaRaw, deps.protagonist, isStory)
      if (ctx) sections['主线故事线'] = ctx

      // 依赖设定
      for (const depType of CORE_SETTING_DEPENDENCIES.golden_finger) {
        const content = deps[depType]
        if (content) sections[getCoreSettingLabel(depType, isStory)] = content
      }

      const userHints = options.userHints?.trim()
      if (userHints) sections['用户补充要求'] = userHints

      const selfDraft = options.selfDraft?.trim()
      if (selfDraft) {
        sections[`当前${getCoreSettingLabel('golden_finger', isStory)}草稿`] = [
          '（请在现有草稿基础上优化与补全）',
          selfDraft
        ].join('\n\n')
      }
      break
    }

    case 'world_pressure': {
      const storyline = buildDownstreamStorylineContext(workId, ideaRaw)
      if (storyline) sections['主线故事线'] = storyline

      // 依赖设定
      for (const depType of CORE_SETTING_DEPENDENCIES.world_pressure) {
        const content = deps[depType]
        if (content) sections[getCoreSettingLabel(depType, isStory)] = content
      }

      // 体裁检测
      const worldviewChecks = await buildWorldviewGenreChecksSection({
        workId,
        storyline: storyline || ideaRaw || '',
        ideaRaw,
        userHints: options.userHints,
        genreIdOverride: options.genreIdOverride,
        genreDetectMode: options.genreDetectMode
      })
      sections['题材世界观检查项'] = worldviewChecks.text
      meta.worldviewGenre = worldviewChecks.meta

      const userHints = options.userHints?.trim()
      if (userHints) sections['用户补充要求'] = userHints

      const selfDraft = options.selfDraft?.trim()
      if (selfDraft) {
        sections[`当前${getCoreSettingLabel('world_pressure', isStory)}草稿`] = [
          '（请在现有草稿基础上优化与补全）',
          selfDraft
        ].join('\n\n')
      }

      // 设定质量约束
      const qualityText = formatQualityIssuesForGeneration(workId)
      if (qualityText) sections['设定自检约束'] = qualityText
      break
    }

    case 'conflict_engine': {
      const storyline = buildDownstreamStorylineContext(workId, ideaRaw)
      if (storyline) sections['主线故事线'] = storyline

      for (const depType of CORE_SETTING_DEPENDENCIES.conflict_engine) {
        const content = deps[depType]
        if (content) sections[getCoreSettingLabel(depType, isStory)] = content
      }

      // 冲突结构检查
      sections['核心冲突结构检查项'] = buildConflictStructureChecklist(workId)

      // 人设卡片
      const cardsSummary = formatAllCharacterCardsSummary(workId).trim()
      if (cardsSummary) sections['结构化人设卡片'] = cardsSummary

      const userHints = options.userHints?.trim()
      if (userHints) sections['用户补充要求'] = userHints

      const selfDraft = options.selfDraft?.trim()
      if (selfDraft) {
        sections[`当前${getCoreSettingLabel('conflict_engine', isStory)}草稿`] = [
          '（请在现有草稿基础上优化与补全）',
          selfDraft
        ].join('\n\n')
      }

      const qualityText = formatQualityIssuesForGeneration(workId)
      if (qualityText) sections['设定自检约束'] = qualityText
      break
    }

    case 'pleasure_engine': {
      const storyline = buildDownstreamStorylineContext(workId, ideaRaw)
      if (storyline) sections['主线故事线'] = storyline

      for (const depType of CORE_SETTING_DEPENDENCIES.pleasure_engine) {
        const content = deps[depType]
        if (content) sections[getCoreSettingLabel(depType, isStory)] = content
      }

      const userHints = options.userHints?.trim()
      if (userHints) sections['用户补充要求'] = userHints

      const selfDraft = options.selfDraft?.trim()
      if (selfDraft) {
        sections[`当前${getCoreSettingLabel('pleasure_engine', isStory)}草稿`] = [
          '（请在现有草稿基础上优化与补全）',
          selfDraft
        ].join('\n\n')
      }
      break
    }

    case 'supporting_cast': {
      const storyline = buildDownstreamStorylineContext(workId, ideaRaw)
      if (storyline) sections['主线故事线'] = storyline

      for (const depType of CORE_SETTING_DEPENDENCIES.supporting_cast) {
        const content = deps[depType]
        if (content) sections[getCoreSettingLabel(depType, isStory)] = content
      }

      const cardsSummary = formatAllCharacterCardsSummary(workId).trim()
      if (cardsSummary) sections['已有结构化人设卡片'] = cardsSummary

      const userHints = options.userHints?.trim()
      if (userHints) sections['用户补充要求'] = userHints

      const selfDraft = options.selfDraft?.trim()
      if (selfDraft) {
        sections[`当前${getCoreSettingLabel('supporting_cast', isStory)}草稿`] = [
          '（请在现有草稿基础上优化与补全）',
          selfDraft
        ].join('\n\n')
      }
      break
    }
  }

  if (Object.keys(sections).length === 0) {
    return { text: '', sections: {} }
  }

  const text = [
    '【核心设定生成上下文】',
    ...Object.entries(sections).map(([label, content]) => `## ${label}\n${content}`)
  ].join('\n\n')

  return Object.keys(meta).length > 0
    ? { text, sections, meta }
    : { text, sections }
}

// ==================== 向后兼容：旧类型映射 ====================

/** 将旧类型映射到新类型（兼容历史调用） */
function mapLegacyType(type: string): CoreSettingType {
  const legacyMap: Record<string, CoreSettingType> = {
    character: 'supporting_cast',
    worldview: 'world_pressure',
    conflict: 'conflict_engine'
  }
  return legacyMap[type] ?? type as CoreSettingType
}

/**
 * @deprecated 使用 buildSettingsGenerationContext(workId, type, options)
 * 旧版入口，自动将旧类型映射到新类型
 */
export async function buildSettingsGenerationContextLegacy(
  workId: number,
  targetType: string,
  options: SettingsGenerationContextOptions = {}
): Promise<SettingsGenerationContextResult> {
  return buildSettingsGenerationContext(workId, mapLegacyType(targetType), options)
}
