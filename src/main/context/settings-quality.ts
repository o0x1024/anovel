import { createHash } from 'crypto'
import { anchorDAO, coreSettingDAO, workDAO } from '../db'
import type { CharacterCard } from './character-cards'
import { formatAllCharacterCardsSummary, loadCharacterCards, saveCharacterCards } from './character-cards'
import { buildWorkContext } from './work-context'
import {
  type QualityConclusion,
  type QualitySeverity,
  type QualityVerdict,
  PASS_SCORE_THRESHOLD,
  MAX_REVISE_ROUNDS,
  parseQualityConclusion,
  enrichSectionsWithConclusion,
  countSectionSeverities,
  meetsPassCriteria,
  meetsPassCriteriaReconciled,
  detectConvergenceStalled
} from './settings-quality-conclusion'
import { parseRevisedAnchorsFromAi, type RevisedAnchor } from './parse-anchors'
import { validateGoldenFinger, goldenFingerCrossSettingIssues } from './golden-finger-validation'

export type { QualityConclusion, QualitySeverity, QualityVerdict }
export {
  PASS_SCORE_THRESHOLD,
  MAX_REVISE_ROUNDS,
  parseQualityConclusion,
  meetsPassCriteria
} from './settings-quality-conclusion'

const STATE_TYPE = 'settings_quality_state'
const FINGERPRINT_TYPES = ['protagonist', 'golden_finger', 'pleasure_engine', 'world_pressure', 'conflict_engine', 'supporting_cast', 'character_cards'] as const

export type ReviseSettingType = 'protagonist' | 'golden_finger' | 'pleasure_engine' | 'world_pressure' | 'conflict_engine' | 'supporting_cast'

export interface QualityReportEntry {
  report: string
  checkedAt: string
}

export interface SettingsQualityState {
  overall?: QualityReportEntry
  characterFunction?: QualityReportEntry
  checkedFingerprint?: string
  conclusion?: QualityConclusion
  reviseMeta?: {
    round: number
    lastBlockingCount: number | null
    lastOverallScore: number | null
  }
  manuallyAccepted?: boolean
  acceptedAt?: string | null
}

export interface SettingsQualityStatus {
  hasOverallCheck: boolean
  isStale: boolean
  needsReview: boolean
  canProceed: boolean
  checkedAt: string | null
  staleReason: string | null
  unresolvedIssues: string[]
  overallScore: number | null
  blockingCount: number
  advisoryCount: number
  verdict: QualityVerdict | null
  reviseRound: number
  maxReviseRounds: number
  convergenceStalled: boolean
  manuallyAccepted: boolean
  canReviseBlocking: boolean
  canReviseAdvisory: boolean
  advisoryOptimizeCount: number
  meetsPassCriteria: boolean
}

export type SectionReviseAction = 'revise-cards' | 'revise-anchors' | 'revise-cross'

export interface ParsedReportSection {
  title: string
  content: string
  reviseType?: ReviseSettingType
  action?: SectionReviseAction
  severity?: QualitySeverity
}

export interface ConflictCardCoverageItem {
  name: string
  role: CharacterCard['role']
  coreConflict: string
  covered: boolean
  matchedTerms: string[]
  reason: string
}

export interface ConflictCardCoverageReport {
  hasConflict: boolean
  hasCards: boolean
  totalCards: number
  coveredCount: number
  missingCount: number
  fullyCovered: boolean
  missingItems: ConflictCardCoverageItem[]
  items: ConflictCardCoverageItem[]
}

export {
  OVERALL_CHECK_SYSTEM_PROMPT,
  CHARACTER_FUNCTION_SYSTEM_PROMPT
} from './settings-quality-check-prompts'

import {
  REVISE_CHARACTER_CARDS_SYSTEM_PROMPT,
  REVISE_ANCHORS_SYSTEM_PROMPT
} from './settings-quality-revise-prompts'

export {
  REVISE_CHARACTER_CARDS_SYSTEM_PROMPT,
  REVISE_ANCHORS_SYSTEM_PROMPT
}
export { extractJsonCandidates } from './settings-quality-json'

const REVISE_SYSTEM_PROMPTS: Record<ReviseSettingType, string> = {
  protagonist: [
    '你是资深小说编辑。根据自检报告中的问题与建议，修订「主角设计」。',
    '要求：',
    '1. 保留原有合理设定，只针对报告的硬矛盾或功能缺失做修改',
    '2. 输出完整修订后的主角设计 Markdown',
    '3. 只输出修订后正文，不要复述报告',
    '4. 结构化字段：身份标签/核心欲望/性格驱动力/致命缺陷/决策模式/底线/魅力点',
    '5. 总字数 500-1000 字，禁止写叙事段落或场景示例'
  ].join('\n'),
  golden_finger: [
    '你是资深小说编辑。根据自检报告中的问题与建议，修订「金手指系统」。',
    '要求：',
    '1. 保留原有合理设定，强化限制条件与反噬机制（限制比能力更重要）',
    '2. 输出完整修订后的金手指系统 Markdown',
    '3. 只输出修订后正文，不要复述报告',
    '4. 结构化字段：名称形态/核心能力/获取方式/限制条件/反噬机制/升级路径/信息差优势',
    '5. 总字数 400-800 字'
  ].join('\n'),
  pleasure_engine: [
    '你是资深小说编辑。根据自检报告中的问题与建议，修订「爽点机制」。',
    '要求：',
    '1. 确保爽点类型与金手指、冲突引擎对齐，避免空洞描述',
    '2. 输出完整修订后的爽点机制 Markdown',
    '3. 只输出修订后正文，不要复述报告',
    '4. 结构化字段：主要爽点类型/触发条件/频率设计/对抗设计/情绪节奏锚点',
    '5. 总字数 300-600 字'
  ].join('\n'),
  world_pressure: [
    '你是资深小说编辑。根据自检报告中的问题与建议，修订「世界观压力规则」。',
    '要求：',
    '1. 保留合理部分，只针对规则自洽性或压力不足做修改',
    '2. 输出完整修订后的世界观压力规则 Markdown',
    '3. 只输出修订后正文，不要复述报告',
    '4. 结构化字段：核心铁律/权力结构/资源稀缺性/规则代价/规则漏洞/压迫升级路径',
    '5. 总字数 600-1500 字，只写规则和限制，禁止百科式描述'
  ].join('\n'),
  conflict_engine: [
    '你是资深小说编辑。根据自检报告中的问题与建议，修订「冲突升级引擎」。',
    '要求：',
    '1. 保留合理部分，强化升级机制的因果链与触发事件',
    '2. 输出完整修订后的冲突升级引擎 Markdown',
    '3. 只输出修订后正文，不要复述报告',
    '4. 结构化字段：对立双方/不可调和点/三层赌注/升级机制/冲突反转点/终局收束',
    '5. 总字数 500-1200 字'
  ].join('\n'),
  supporting_cast: [
    '你是资深小说编辑。根据自检报告中的问题与建议，修订「配角功能组」。',
    '要求：',
    '1. 按六种功能类型组织（催化剂/对照组/阻力/情感锚/信息/喜剧），消除功能重复或缺失',
    '2. 每个配角注明与主角的关系动力学和关键互动场景',
    '3. 输出完整修订后的配角功能组 Markdown',
    '4. 只输出修订后正文，不要复述报告',
    '5. 每个配角 200-400 字，配角标准：记忆点>完整性'
  ].join('\n')
}

/** 跨设定修订依赖顺序：主角 → 金手指 → 世界观压力 → 冲突引擎 → 爽点机制 → 配角功能组 */
export const CROSS_REVISE_TYPES: readonly ReviseSettingType[] = [
  'protagonist',
  'golden_finger',
  'world_pressure',
  'conflict_engine',
  'pleasure_engine',
  'supporting_cast'
]

export const CROSS_REVISE_TYPE_LABELS: Record<ReviseSettingType, string> = {
  protagonist: '主角设计',
  golden_finger: '金手指系统',
  pleasure_engine: '爽点机制',
  world_pressure: '世界观压力规则',
  conflict_engine: '冲突升级引擎',
  supporting_cast: '配角功能组'
}

export type ReviseAllWorkItem =
  | { kind: 'section'; section: ParsedReportSection }
  | { kind: 'cross'; section: ParsedReportSection; reviseType: ReviseSettingType }

export function listCrossReviseTypes(workId: number): ReviseSettingType[] {
  return CROSS_REVISE_TYPES.filter(t => !!coreSettingDAO.getByType(workId, t)?.content?.trim())
}

export function flattenReviseAllWorkItems(targets: ParsedReportSection[]): ReviseAllWorkItem[] {
  const items: ReviseAllWorkItem[] = []
  for (const section of targets) {
    if (section.action === 'revise-cross') {
      for (const reviseType of CROSS_REVISE_TYPES) {
        items.push({ kind: 'cross', section, reviseType })
      }
    } else {
      items.push({ kind: 'section', section })
    }
  }
  return items
}

export function buildReviseAllStepLabels(targets: ParsedReportSection[]): string[] {
  const labels: string[] = []
  for (const section of targets) {
    if (section.action === 'revise-cross') {
      for (const type of CROSS_REVISE_TYPES) {
        labels.push(`${section.title} · 修订${CROSS_REVISE_TYPE_LABELS[type]}`)
      }
    } else {
      labels.push(section.title)
    }
  }
  labels.push('重新整体自检')
  return labels
}

const SECTION_REVISE_MAP: Record<string, ReviseSettingType | SectionReviseAction> = {
  '主角与反差设定': 'protagonist',
  '主角设计': 'protagonist',
  '设定与微创新': 'golden_finger',
  '金手指': 'golden_finger',
  '金手指系统': 'golden_finger',
  '情绪节奏与爽点': 'pleasure_engine',
  '爽点机制': 'pleasure_engine',
  '世界观': 'world_pressure',
  '世界观压力规则': 'world_pressure',
  '核心冲突': 'conflict_engine',
  '冲突升级引擎': 'conflict_engine',
  '功能性配角': 'supporting_cast',
  '配角功能组': 'supporting_cast',
  '人设': 'supporting_cast',        // 向后兼容旧报告
  '卡片与 Markdown 一致性': 'revise-cards',
  '锚点对齐': 'revise-anchors',
  '跨设定矛盾': 'revise-cross'
}

export function computeSettingsContentFingerprint(workId: number): string {
  const parts = FINGERPRINT_TYPES.map(t => coreSettingDAO.getByType(workId, t)?.content ?? '')
  return createHash('sha256').update(parts.join('\n---\n')).digest('hex').slice(0, 16)
}

export function loadSettingsQualityState(workId: number): SettingsQualityState {
  const row = coreSettingDAO.getByType(workId, STATE_TYPE)
  if (!row?.content) return {}
  try {
    return JSON.parse(row.content) as SettingsQualityState
  } catch {
    return {}
  }
}

export function saveSettingsQualityState(workId: number, state: SettingsQualityState): void {
  coreSettingDAO.upsert(workId, STATE_TYPE, JSON.stringify(state, null, 2))
}

export function isSettingsQualityStale(workId: number): boolean {
  const state = loadSettingsQualityState(workId)
  if (!state.overall?.checkedAt || !state.checkedFingerprint) return false
  return state.checkedFingerprint !== computeSettingsContentFingerprint(workId)
}

export function extractUnresolvedIssues(report: string, conclusion?: QualityConclusion | null): string[] {
  const parsed = conclusion ?? parseQualityConclusion(report)
  const sections = enrichSectionsWithConclusion(parseReportSections(report), parsed)

  const issues: string[] = []
  for (const section of sections) {
    if (section.title.includes('总体评价') || section.title.includes('角色功能矩阵')) continue
    if (section.severity !== 'blocking') continue
    if (!section.content.trim()) continue

    const bulletLines = section.content
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^[-*•]\s+|^\d+[.)]\s+/.test(l))

    if (bulletLines.length > 0) {
      for (const line of bulletLines.slice(0, 3)) {
        const plain = line.replace(/^[-*•]\s+|^\d+[.)]\s+/, '').trim()
        if (plain) issues.push(`[不合格·${section.title}] ${plain}`)
      }
    } else {
      issues.push(`[不合格·${section.title}] ${section.content.slice(0, 100).replace(/\s+/g, ' ')}`)
    }
  }

  return issues.slice(0, 15)
}

function getEffectiveConclusion(state: SettingsQualityState): QualityConclusion | null {
  if (state.conclusion) return state.conclusion
  if (state.overall?.report) return parseQualityConclusion(state.overall.report)
  return null
}

export function getSettingsQualityStatus(workId: number): SettingsQualityStatus {
  const state = loadSettingsQualityState(workId)
  const hasOverallCheck = !!(state.overall?.report?.trim() && state.overall.checkedAt)
  const isStale = hasOverallCheck && isSettingsQualityStale(workId)
  const coreDone = FINGERPRINT_TYPES.slice(0, 3).every(t => !!coreSettingDAO.getByType(workId, t)?.content?.trim())
  const conclusion = !isStale ? getEffectiveConclusion(state) : null
  const enrichedSections = !isStale && state.overall?.report
    ? parseEnrichedReportSections(workId, state.overall.report)
    : []
  const severityCounts = countSectionSeverities(enrichedSections)
  const reviseMeta = state.reviseMeta ?? { round: 0, lastBlockingCount: null, lastOverallScore: null }
  const meets = meetsPassCriteriaReconciled(conclusion, enrichedSections)
  const manuallyAccepted = !!state.manuallyAccepted && hasOverallCheck && !isStale
  const blockingCount = severityCounts.blockingCount
  const targets = state.overall?.report && !isStale
    ? getReviseAllTargets(workId, state.overall.report)
    : []
  const advisoryTargets = state.overall?.report && !isStale
    ? getReviseAdvisoryTargets(workId, state.overall.report)
    : []

  return {
    hasOverallCheck,
    isStale,
    needsReview: coreDone && (!hasOverallCheck || isStale || (!meets && !manuallyAccepted)),
    canProceed: hasOverallCheck && !isStale && (meets || manuallyAccepted),
    checkedAt: state.overall?.checkedAt ?? null,
    staleReason: isStale ? '设定内容已变更，自检报告已过期' : null,
    unresolvedIssues: state.overall?.report && !isStale
      ? extractUnresolvedIssues(state.overall.report, conclusion)
      : [],
    overallScore: conclusion?.overallScore ?? null,
    blockingCount,
    advisoryCount: severityCounts.advisoryCount,
    verdict: conclusion?.verdict ?? null,
    reviseRound: reviseMeta.round,
    maxReviseRounds: MAX_REVISE_ROUNDS,
    convergenceStalled: !!reviseMeta.lastBlockingCount && reviseMeta.round >= MAX_REVISE_ROUNDS
      && blockingCount >= (reviseMeta.lastBlockingCount ?? blockingCount),
    manuallyAccepted,
    canReviseBlocking: targets.length > 0 && reviseMeta.round < MAX_REVISE_ROUNDS,
    canReviseAdvisory: advisoryTargets.length > 0,
    advisoryOptimizeCount: advisoryTargets.length,
    meetsPassCriteria: meets
  }
}

export function hasSettingsQualityCheck(workId: number): boolean {
  return getSettingsQualityStatus(workId).canProceed
}

function getGoldenFingerHardIssues(workId: number): string[] {
  const gfCheck = validateGoldenFinger(workId)
  const crossIssues = goldenFingerCrossSettingIssues(workId, gfCheck.structured)
  return [...gfCheck.issues, ...crossIssues]
}

export function formatQualityIssuesForContext(workId: number): string {
  const status = getSettingsQualityStatus(workId)
  const gfIssues = getGoldenFingerHardIssues(workId)
  if (status.isStale) {
    return '【设定自检】报告已过期，请先重新运行设定质量自检后再继续生成。'
  }
  const allIssues = [...gfIssues, ...status.unresolvedIssues]
  if (!allIssues.length) return ''
  return [
    '【设定自检未决问题 - 生成时须主动规避】',
    ...allIssues.map(i => `- ${i}`)
  ].join('\n')
}

/** 核心设定 AI 生成：仅注入未决 issue，过期占位不写入 prompt */
export function formatQualityIssuesForGeneration(workId: number): string {
  const status = getSettingsQualityStatus(workId)
  const gfIssues = getGoldenFingerHardIssues(workId)
  if (status.isStale || (!gfIssues.length && !status.unresolvedIssues.length)) return ''
  return [
    '【设定自检未决问题 - 生成时须主动规避】',
    ...gfIssues.map(i => `[硬性校验] ${i}`),
    ...status.unresolvedIssues.map(i => `- ${i}`)
  ].join('\n')
}

export function getSettingsQualityGateHints(workId: number): { warnings: string[]; blockers: string[] } {
  const status = getSettingsQualityStatus(workId)
  const warnings: string[] = []
  const blockers: string[] = []

  if (!status.hasOverallCheck) {
    warnings.push('尚未运行设定整体自检')
  }
  if (status.isStale) {
    warnings.push('设定内容已变更，质量自检报告已过期，建议重新运行')
  }
  for (const issue of status.unresolvedIssues) {
    warnings.push(`设定约束：${issue}`)
  }

  return { warnings, blockers }
}

export function buildSettingsQualityInput(workId: number): string {
  const ctx = buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true, includeQualityIssues: false })
  const parts: string[] = []

  if (ctx.text.trim()) {
    parts.push(ctx.text)
  }

  const cards = loadCharacterCards(workId)
  if (cards.length > 0) {
    parts.push('')
    parts.push('【结构化人设卡片】')
    parts.push(formatAllCharacterCardsSummary(workId) || cards.map(c => `- ${c.name}（${c.role}）`).join('\n'))
  } else {
    parts.push('')
    parts.push('【结构化人设卡片】（尚未设定）')
  }

  const anchors = anchorDAO.listActiveByWork(workId)
  parts.push('')
  parts.push('【活跃锚点清单】')
  if (anchors.length === 0) {
    parts.push('（无活跃锚点）')
  } else {
    for (const a of anchors) {
      parts.push(`- [${a.type}] ${a.title}：${a.content.slice(0, 120)}${a.content.length > 120 ? '…' : ''}`)
    }
  }

  return parts.join('\n')
}

function extractConflictKeywords(text: string): string[] {
  const source = text.trim()
  if (!source) return []
  const raw = source.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,}/g) ?? []
  const stopwords = new Set(['核心冲突', '主线冲突', '副线冲突', '冲突升级路径'])
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of raw) {
    const normalized = token.trim()
    if (!normalized || stopwords.has(normalized)) continue
    if (seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
  }
  return out
}

function buildCoverageItem(card: CharacterCard, conflictText: string): ConflictCardCoverageItem {
  const core = card.coreConflict?.trim() ?? ''
  const matchedTerms: string[] = []

  if (card.name && conflictText.includes(card.name)) {
    matchedTerms.push(card.name)
  }
  for (const kw of extractConflictKeywords(core)) {
    if (conflictText.includes(kw)) matchedTerms.push(kw)
  }

  const covered = matchedTerms.length > 0
  const reason = !core
    ? '角色卡未填写核心矛盾'
    : covered
      ? `已匹配：${matchedTerms.slice(0, 4).join('、')}`
      : '核心冲突正文未体现该角色矛盾'

  return {
    name: card.name,
    role: card.role,
    coreConflict: core,
    covered,
    matchedTerms,
    reason
  }
}

export function buildConflictCardCoverageReport(workId: number): ConflictCardCoverageReport {
  const conflictText = (coreSettingDAO.getByType(workId, 'conflict_engine')?.content?.trim() || coreSettingDAO.getByType(workId, 'conflict')?.content?.trim()) ?? ''
  const cards = loadCharacterCards(workId)
  const hasConflict = !!conflictText
  const hasCards = cards.length > 0

  if (!hasCards) {
    return {
      hasConflict,
      hasCards: false,
      totalCards: 0,
      coveredCount: 0,
      missingCount: 0,
      fullyCovered: true,
      missingItems: [],
      items: []
    }
  }

  const items = cards.map(card => buildCoverageItem(card, conflictText))
  const missingItems = items.filter(item => !item.covered)
  const coveredCount = items.length - missingItems.length

  return {
    hasConflict,
    hasCards: true,
    totalCards: items.length,
    coveredCount,
    missingCount: missingItems.length,
    fullyCovered: missingItems.length === 0,
    missingItems,
    items
  }
}

export function parseReportSections(report: string): ParsedReportSection[] {
  const lines = report.split('\n')
  const sections: ParsedReportSection[] = []
  let current: ParsedReportSection | null = null

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)/)
    if (heading) {
      if (current) sections.push(current)
      const title = heading[1].trim()
      let reviseType: ReviseSettingType | undefined
      let action: SectionReviseAction | undefined
      for (const [key, val] of Object.entries(SECTION_REVISE_MAP)) {
        if (title.includes(key)) {
          if (val === 'revise-cards' || val === 'revise-anchors' || val === 'revise-cross') {
            action = val
          } else {
            reviseType = val
          }
          break
        }
      }
      current = { title, content: '', reviseType, action }
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line
    }
  }
  if (current) sections.push(current)

  return sections.map(s => ({ ...s, content: s.content.trim() }))
}

export function buildRevisePrompt(
  workId: number,
  type: ReviseSettingType,
  report: string,
  sectionTitle?: string,
  mode: 'fix' | 'optimize' = 'fix'
): { prompt: string; systemPrompt: string } {
  const current = coreSettingDAO.getByType(workId, type)?.content?.trim() ?? ''
  const sectionBlock = sectionTitle
    ? parseReportSections(report).find(s => s.title.includes(sectionTitle.replace(/^##\s*/, '')))
    : undefined
  const reportExcerpt = sectionBlock
    ? `## ${sectionBlock.title}\n${sectionBlock.content}`
    : report

  const typeLabels: Record<ReviseSettingType, string> = {
    protagonist: '现有主角设计',
    golden_finger: '现有金手指系统',
    pleasure_engine: '现有爽点机制',
    world_pressure: '现有世界观压力规则',
    conflict_engine: '现有冲突升级引擎',
    supporting_cast: '现有配角功能组'
  }

  const ctx = buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true, includeQualityIssues: false })

  const isCrossSection = !!sectionBlock?.title.includes('跨设定')

  const optimizeNote = mode === 'optimize'
    ? '【优化模式】本次为及格线抛光（非结构修复）。重点落实报告中的「建议：」，强化推动力/分场挂靠/表现力，勿改动已自洽的核心结构。'
    : ''

  const prompt = [
    ctx.text,
    '',
    ...(optimizeNote ? [optimizeNote, ''] : []),
    ...(isCrossSection
      ? ['【修订目标】针对跨设定矛盾，修订当前设定块并与人设/世界观/核心冲突保持一致。', '']
      : []),
    `【${typeLabels[type]}】`,
    current || '（空）',
    '',
    '【自检报告相关节】',
    reportExcerpt
  ].join('\n')

  const workInfo = workDAO.getById(workId)
  const isStory = workInfo?.work_type === 'story'
  const sysPrompt = REVISE_SYSTEM_PROMPTS[type]
  const finalSysPrompt = isStory ? sysPrompt.replace(/小说编辑/g, '短故事编辑') : sysPrompt

  return { prompt, systemPrompt: finalSysPrompt }
}

export function buildReviseCharacterCardsPrompt(
  workId: number,
  report: string,
  sectionTitle?: string
): { prompt: string; systemPrompt: string } {
  const cards = loadCharacterCards(workId)
  const characterMd = (coreSettingDAO.getByType(workId, 'supporting_cast')?.content?.trim() || coreSettingDAO.getByType(workId, 'character')?.content?.trim()) ?? ''
  const sectionBlock = sectionTitle
    ? parseReportSections(report).find(s => s.title.includes(sectionTitle.replace(/^##\s*/, '')))
    : parseReportSections(report).find(s => s.title.includes('卡片'))
  const reportExcerpt = sectionBlock
    ? `## ${sectionBlock.title}\n${sectionBlock.content}`
    : report

  const prompt = [
    buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true, includeQualityIssues: false }).text,
    '',
    '【Markdown 人设】',
    characterMd || '（空）',
    '',
    '【现有人设卡片 JSON】',
    JSON.stringify({ cards }, null, 2),
    '',
    '【自检报告相关节】',
    reportExcerpt
  ].join('\n')

  const workInfo = workDAO.getById(workId)
  const isStory = workInfo?.work_type === 'story'
  const finalSysPrompt = isStory 
    ? REVISE_CHARACTER_CARDS_SYSTEM_PROMPT.replace(/小说编辑/g, '短故事编辑') 
    : REVISE_CHARACTER_CARDS_SYSTEM_PROMPT

  return { prompt, systemPrompt: finalSysPrompt }
}

function findReportSectionBlock(report: string, sectionTitle?: string, fallbackKeyword?: string) {
  if (sectionTitle) {
    return parseReportSections(report).find(s => s.title.includes(sectionTitle.replace(/^##\s*/, '')))
  }
  if (fallbackKeyword) {
    return parseReportSections(report).find(s => s.title.includes(fallbackKeyword))
  }
  return undefined
}

export function buildReviseAnchorsPrompt(
  workId: number,
  report: string,
  sectionTitle?: string
): { prompt: string; systemPrompt: string } {
  const anchors = anchorDAO.listActiveByWork(workId)
  const sectionBlock = findReportSectionBlock(report, sectionTitle, '锚点')
  const reportExcerpt = sectionBlock
    ? `## ${sectionBlock.title}\n${sectionBlock.content}`
    : report

  const prompt = [
    buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true, includeQualityIssues: false }).text,
    '',
    '【现活跃锚点 JSON】',
    JSON.stringify({
      anchors: anchors.map(a => ({
        id: a.id,
        type: a.type,
        title: a.title,
        content: a.content
      }))
    }, null, 2),
    '',
    '【自检报告相关节】',
    reportExcerpt
  ].join('\n')

  const workInfo = workDAO.getById(workId)
  const isStory = workInfo?.work_type === 'story'
  const finalSysPrompt = isStory 
    ? REVISE_ANCHORS_SYSTEM_PROMPT.replace(/小说编辑/g, '短故事编辑') 
    : REVISE_ANCHORS_SYSTEM_PROMPT

  return { prompt, systemPrompt: finalSysPrompt }
}

export function applyRevisedAnchors(workId: number, revisions: RevisedAnchor[]): number {
  const existing = anchorDAO.listActiveByWork(workId)
  let count = 0

  for (const rev of revisions) {
    if (rev.id) {
      const row = anchorDAO.getById(rev.id)
      if (row?.work_id === workId) {
        anchorDAO.update(rev.id, { title: rev.title, content: rev.content, type: rev.type })
        count++
      }
      continue
    }

    const match = existing.find(e => e.title === rev.title)
    if (match) {
      anchorDAO.update(match.id, { title: rev.title, content: rev.content, type: rev.type })
      count++
    } else {
      anchorDAO.create({
        work_id: workId,
        type: rev.type,
        title: rev.title,
        content: rev.content,
        created_step: 'settings_anchor_revise'
      })
      count++
    }
  }

  return count
}

export function applyRevisedAnchorsFromAi(workId: number, content: string): {
  success: boolean
  error?: string
  count?: number
} {
  const revisions = parseRevisedAnchorsFromAi(content)
  if (revisions.length === 0) {
    return { success: false, error: '未能解析修订后的锚点 JSON' }
  }
  const count = applyRevisedAnchors(workId, revisions)
  if (count === 0) {
    return { success: false, error: '未能匹配或更新任何锚点' }
  }
  return { success: true, count }
}

function isSkippedQualitySectionTitle(title: string): boolean {
  return title.includes('总体评价') || title.includes('自检结论')
}

export function sectionHasReviseCapability(workId: number, section: ParsedReportSection): boolean {
  if (isSkippedQualitySectionTitle(section.title)) return false
  if (!section.reviseType && !section.action) return false

  if (section.reviseType) {
    return !!coreSettingDAO.getByType(workId, section.reviseType)?.content?.trim()
  }
  if (section.action === 'revise-cards') {
    return loadCharacterCards(workId).length > 0
  }
  if (section.action === 'revise-anchors') {
    return anchorDAO.listActiveByWork(workId).length > 0
  }
  if (section.action === 'revise-cross') {
    return FINGERPRINT_TYPES.slice(0, 3).some(t => !!coreSettingDAO.getByType(workId, t)?.content?.trim())
  }
  return false
}

/** 非优秀项且具备可修订/优化能力（blocking + advisory） */
export function sectionCanOptimize(workId: number, section: ParsedReportSection): boolean {
  if (section.severity === 'none' || !section.severity) return false
  return sectionHasReviseCapability(workId, section)
}

export function sectionNeedsRevise(workId: number, section: ParsedReportSection): boolean {
  if (section.severity === 'blocking') {
    return sectionCanOptimize(workId, section)
  }

  // 兼容旧报告（无 severity / JSON）
  if (section.severity) return false
  if (!section.content.trim()) return false
  if (/无问题|暂无问题|无明显问题|良好|基本一致|暂无不|无矛盾|已覆盖/.test(section.content)) return false
  if (/建议|可优化|强化|可以考虑/.test(section.content) && !/矛盾|冲突|不一致|遗漏|缺失|严重/.test(section.content)) {
    return false
  }
  return sectionHasReviseCapability(workId, section)
}

export function getReviseTargets(
  workId: number,
  report: string,
  severities: QualitySeverity[]
): ParsedReportSection[] {
  const conclusion = parseQualityConclusion(report)
  const sections = enrichSectionsWithConclusion(parseReportSections(report), conclusion)
  return sections.filter(s =>
    !!s.severity
    && severities.includes(s.severity)
    && sectionCanOptimize(workId, s)
  )
}

export function getReviseAllTargets(workId: number, report: string): ParsedReportSection[] {
  return getReviseTargets(workId, report, ['blocking'])
}

export function getReviseAdvisoryTargets(workId: number, report: string): ParsedReportSection[] {
  return getReviseTargets(workId, report, ['advisory'])
}

export function parseEnrichedReportSections(workId: number, report: string): ParsedReportSection[] {
  const state = loadSettingsQualityState(workId)
  const conclusion = state.conclusion ?? parseQualityConclusion(report)
  return enrichSectionsWithConclusion(parseReportSections(report), conclusion)
}

export function recordQualityCheck(workId: number, patch: Partial<SettingsQualityState>): SettingsQualityState {
  const prev = loadSettingsQualityState(workId)
  const state: SettingsQualityState = { ...prev, ...patch }

  if (patch.overall?.report) {
    state.conclusion = patch.conclusion ?? parseQualityConclusion(patch.overall.report) ?? undefined
  }

  if (patch.overall?.report && patch.reviseMeta === undefined && patch.manuallyAccepted === undefined) {
    state.reviseMeta = {
      round: 0,
      lastBlockingCount: state.conclusion?.blockingCount ?? null,
      lastOverallScore: state.conclusion?.overallScore ?? null
    }
    state.manuallyAccepted = false
    state.acceptedAt = null
  }

  state.checkedFingerprint = computeSettingsContentFingerprint(workId)
  saveSettingsQualityState(workId, state)
  return state
}

export function acceptSettingsQualityPass(workId: number): SettingsQualityState {
  const state = loadSettingsQualityState(workId)
  if (!state.overall?.report?.trim()) {
    throw new Error('请先运行整体自检')
  }
  return recordQualityCheck(workId, {
    manuallyAccepted: true,
    acceptedAt: new Date().toISOString()
  })
}

export function prepareReviseAdvisoryAll(workId: number): {
  ok: boolean
  error?: string
  targets: ParsedReportSection[]
  prevAdvisory: number
  prevScore: number | null
} {
  const state = loadSettingsQualityState(workId)
  const report = state.overall?.report?.trim()
  if (!report) {
    return { ok: false, error: '请先运行整体自检', targets: [], prevAdvisory: 0, prevScore: null }
  }
  if (isSettingsQualityStale(workId)) {
    return {
      ok: false,
      error: '设定内容已变更，请先重新运行整体自检',
      targets: [],
      prevAdvisory: 0,
      prevScore: null
    }
  }

  const targets = getReviseAdvisoryTargets(workId, report)
  if (targets.length === 0) {
    return {
      ok: false,
      error: '当前没有可优化的及格项',
      targets: [],
      prevAdvisory: 0,
      prevScore: null
    }
  }

  const conclusion = getEffectiveConclusion(state)
  return {
    ok: true,
    targets,
    prevAdvisory: conclusion?.advisoryCount ?? targets.length,
    prevScore: conclusion?.overallScore ?? null
  }
}

export function finalizeReviseOptimizeAll(
  workId: number,
  recheckReport?: string
): { conclusion: QualityConclusion | null } {
  if (!recheckReport?.trim()) {
    return { conclusion: null }
  }
  const conclusion = parseQualityConclusion(recheckReport) ?? undefined
  recordQualityCheck(workId, {
    overall: { report: recheckReport.trim(), checkedAt: new Date().toISOString() },
    conclusion
  })
  return { conclusion: conclusion ?? null }
}

export function prepareReviseAll(workId: number): {
  ok: boolean
  error?: string
  targets: ParsedReportSection[]
  prevBlocking: number
  prevScore: number | null
  round: number
} {
  const state = loadSettingsQualityState(workId)
  const report = state.overall?.report?.trim()
  if (!report) {
    return { ok: false, error: '请先运行整体自检', targets: [], prevBlocking: 0, prevScore: null, round: 0 }
  }

  const meta = state.reviseMeta ?? { round: 0, lastBlockingCount: null, lastOverallScore: null }
  if (meta.round >= MAX_REVISE_ROUNDS) {
    return {
      ok: false,
      error: `已达最大自动修订轮次（${MAX_REVISE_ROUNDS}），请人工审阅或使用「接受当前设定」`,
      targets: [],
      prevBlocking: 0,
      prevScore: null,
      round: meta.round
    }
  }

  const targets = getReviseAllTargets(workId, report)
  if (targets.length === 0) {
    return {
      ok: false,
      error: '当前没有可自动修订的不合格项',
      targets: [],
      prevBlocking: 0,
      prevScore: null,
      round: meta.round
    }
  }

  const conclusion = getEffectiveConclusion(state)
  return {
    ok: true,
    targets,
    prevBlocking: conclusion?.blockingCount ?? targets.length,
    prevScore: conclusion?.overallScore ?? null,
    round: meta.round
  }
}

export function finalizeReviseAll(
  workId: number,
  input: {
    prevBlocking: number
    prevScore: number | null
    round: number
    recheckReport?: string
    revisedCount: number
  }
): { convergenceStalled: boolean; conclusion: QualityConclusion | null } {
  const conclusion = input.recheckReport ? parseQualityConclusion(input.recheckReport) : null
  const newBlocking = input.recheckReport
    ? countSectionSeverities(
        enrichSectionsWithConclusion(
          parseReportSections(input.recheckReport),
          conclusion
        )
      ).blockingCount
    : input.prevBlocking
  const newScore = conclusion?.overallScore ?? input.prevScore ?? 0
  const stalled = input.revisedCount > 0 && detectConvergenceStalled(
    input.prevBlocking,
    newBlocking,
    input.prevScore,
    newScore
  )

  const patch: Partial<SettingsQualityState> = {
    manuallyAccepted: false,
    acceptedAt: null,
    reviseMeta: {
      round: input.round + 1,
      lastBlockingCount: newBlocking,
      lastOverallScore: newScore
    }
  }
  if (input.recheckReport) {
    patch.overall = { report: input.recheckReport, checkedAt: new Date().toISOString() }
    patch.conclusion = conclusion ?? undefined
  }

  recordQualityCheck(workId, patch)
  return { convergenceStalled: stalled, conclusion }
}

export function getSettingsQualitySummaryForReport(workId: number): {
  hasCheck: boolean
  isStale: boolean
  issueCount: number
  checkedAt: string | null
  warnings: string[]
} {
  const status = getSettingsQualityStatus(workId)
  const warnings: string[] = []
  if (!status.hasOverallCheck) warnings.push('尚未运行设定整体自检')
  if (status.isStale) warnings.push('设定自检报告已过期（设定内容已变更）')
  if (status.unresolvedIssues.length > 0) {
    warnings.push(`有 ${status.unresolvedIssues.length} 条设定自检未决问题`)
  }
  return {
    hasCheck: status.hasOverallCheck,
    isStale: status.isStale,
    issueCount: status.unresolvedIssues.length,
    checkedAt: status.checkedAt,
    warnings
  }
}

export { saveCharacterCards }
export type { CharacterCard }
