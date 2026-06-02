import { createHash } from 'crypto'
import { anchorDAO, coreSettingDAO } from '../db'
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

export type { QualityConclusion, QualitySeverity, QualityVerdict }
export {
  PASS_SCORE_THRESHOLD,
  MAX_REVISE_ROUNDS,
  parseQualityConclusion,
  meetsPassCriteria
} from './settings-quality-conclusion'

const STATE_TYPE = 'settings_quality_state'
const FINGERPRINT_TYPES = ['character', 'worldview', 'conflict', 'character_cards'] as const

export type ReviseSettingType = 'character' | 'worldview' | 'conflict'

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
  character: [
    '你是资深小说编辑。根据自检报告中的问题与建议，修订「现有人设」。',
    '要求：',
    '1. 保留原人设中合理、有效的部分，只针对报告指出的问题做针对性修改',
    '2. 明确各角色的功能定位，消除功能重复或缺失',
    '3. 输出完整修订后的人设 Markdown，结构与原稿一致（## 主角 / ## 重要配角 / ## 反派 等）',
    '4. 只输出修订后的人设正文，不要复述检查报告或附加解释',
    '5. 字数约束：主角 800-1200 字，配角每人 300-500 字，全部角色合计不超过 3000 字',
    '6. 用结构化字段（性格内核/语言模式/行为习惯/核心矛盾/行为逻辑）而非叙事散文，禁止写场景示例'
  ].join('\n'),
  worldview: [
    '你是资深小说编辑。根据自检报告中的问题与建议，修订「现有世界观」。',
    '要求：',
    '1. 保留合理部分，只针对报告指出的自洽性问题修改',
    '2. 输出完整修订后的世界观 Markdown，结构与原稿一致',
    '3. 只输出修订后正文，不要复述报告',
    '4. 字数约束：总字数 800-2000 字，只写规则和限制，不写百科式描述'
  ].join('\n'),
  conflict: [
    '你是资深小说编辑。根据自检报告中的问题与建议，修订「现有核心冲突」。',
    '要求：',
    '1. 保留合理部分，强化主线/副线冲突的因果链与升级路径',
    '2. 输出完整修订后的核心冲突 Markdown，结构与原稿一致',
    '3. 只输出修订后正文，不要复述报告',
    '4. 字数约束：总字数 500-1200 字，禁止写具体场景描写或对话'
  ].join('\n')
}

export const CROSS_REVISE_TYPES: readonly ReviseSettingType[] = ['character', 'worldview', 'conflict']

export const CROSS_REVISE_TYPE_LABELS: Record<ReviseSettingType, string> = {
  character: '人设',
  worldview: '世界观',
  conflict: '核心冲突'
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
  '人设': 'character',
  '世界观': 'worldview',
  '核心冲突': 'conflict',
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
    meetsPassCriteria: meets
  }
}

export function hasSettingsQualityCheck(workId: number): boolean {
  return getSettingsQualityStatus(workId).canProceed
}

export function formatQualityIssuesForContext(workId: number): string {
  const status = getSettingsQualityStatus(workId)
  if (status.isStale) {
    return '【设定自检】报告已过期，请先重新运行设定质量自检后再继续生成。'
  }
  if (!status.unresolvedIssues.length) return ''
  return [
    '【设定自检未决问题 - 生成时须主动规避】',
    ...status.unresolvedIssues.map(i => `- ${i}`)
  ].join('\n')
}

/** 核心设定 AI 生成：仅注入未决 issue，过期占位不写入 prompt */
export function formatQualityIssuesForGeneration(workId: number): string {
  const status = getSettingsQualityStatus(workId)
  if (status.isStale || !status.unresolvedIssues.length) return ''
  return [
    '【设定自检未决问题 - 生成时须主动规避】',
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
  sectionTitle?: string
): { prompt: string; systemPrompt: string } {
  const current = coreSettingDAO.getByType(workId, type)?.content?.trim() ?? ''
  const sectionBlock = sectionTitle
    ? parseReportSections(report).find(s => s.title.includes(sectionTitle.replace(/^##\s*/, '')))
    : undefined
  const reportExcerpt = sectionBlock
    ? `## ${sectionBlock.title}\n${sectionBlock.content}`
    : report

  const typeLabels: Record<ReviseSettingType, string> = {
    character: '现有人设',
    worldview: '现有世界观',
    conflict: '现有核心冲突'
  }

  const ctx = buildWorkContext(workId, { includeCoreSettings: true, includeIdea: true, includeQualityIssues: false })

  const isCrossSection = !!sectionBlock?.title.includes('跨设定')

  const prompt = [
    ctx.text,
    '',
    ...(isCrossSection
      ? ['【修订目标】针对跨设定矛盾，修订当前设定块并与人设/世界观/核心冲突保持一致。', '']
      : []),
    `【${typeLabels[type]}】`,
    current || '（空）',
    '',
    '【自检报告相关节】',
    reportExcerpt
  ].join('\n')

  return { prompt, systemPrompt: REVISE_SYSTEM_PROMPTS[type] }
}

export function buildReviseCharacterCardsPrompt(
  workId: number,
  report: string,
  sectionTitle?: string
): { prompt: string; systemPrompt: string } {
  const cards = loadCharacterCards(workId)
  const characterMd = coreSettingDAO.getByType(workId, 'character')?.content?.trim() ?? ''
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

  return { prompt, systemPrompt: REVISE_CHARACTER_CARDS_SYSTEM_PROMPT }
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

  return { prompt, systemPrompt: REVISE_ANCHORS_SYSTEM_PROMPT }
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

export function sectionNeedsRevise(workId: number, section: ParsedReportSection): boolean {
  if (section.severity === 'none' || section.severity === 'advisory') return false
  if (section.severity === 'blocking') {
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

  // 兼容旧报告（无 severity / JSON）
  if (!section.content.trim()) return false
  if (/无问题|暂无问题|无明显问题|良好|基本一致|暂无不|无矛盾|已覆盖/.test(section.content)) return false
  if (/建议|可优化|强化|可以考虑/.test(section.content) && !/矛盾|冲突|不一致|遗漏|缺失|严重/.test(section.content)) {
    return false
  }

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

export function getReviseAllTargets(workId: number, report: string): ParsedReportSection[] {
  const conclusion = parseQualityConclusion(report)
  const sections = enrichSectionsWithConclusion(parseReportSections(report), conclusion)
  return sections.filter(s => sectionNeedsRevise(workId, s))
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
