import { incubatorVersionDAO, incubatorDraftSlotDAO } from '../../db/dao/incubator'
import { INCUBATOR_SLOT_KEYS, INCUBATOR_SLOT_LABELS } from '../../../shared/incubator-slots'
import type { IncubatorSlotKey } from '../../../shared/incubator-slots'

/** 人设 AI 生成：统合摘要 + 与角色强相关的槽位 */
export const CHARACTER_SETTING_SLOT_KEYS: IncubatorSlotKey[] = [
  'opening',
  'core_conflict',
  'role_engine'
]

export interface FrozenStorylineContextOptions {
  /** 冻结版本是否附带质量评分卡（核心设定生成不需要） */
  includeQualitySnapshot?: boolean
  /** 统合摘要后附带已采纳槽位正文 */
  includeSlots?: boolean
  /** 附带的槽位键；默认全量 */
  slotKeys?: readonly IncubatorSlotKey[]
}

const SYNTH_HEADING = '统合主线摘要'
const SYNTH_HEADING_ALIASES = ['统合主线摘要', '统合摘要'] as const

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formatSynthSection(summary: string): string {
  return `## ${SYNTH_HEADING}\n${summary.trim()}`
}

function formatSlotSections(
  slotMap: Record<string, string | undefined>,
  keys: readonly IncubatorSlotKey[]
): string[] {
  return keys
    .map((k: IncubatorSlotKey) => {
      const text = slotMap[k]?.trim()
      if (!text) return ''
      return `## ${INCUBATOR_SLOT_LABELS[k]}\n${text}`
    })
    .filter(Boolean)
}

function assembleParts(parts: string[]): string {
  return parts.filter(Boolean).join('\n\n')
}

/** 从 idea 文本解析各槽位段落（匹配孵化器槽位标题） */
export function parseSlotSectionsFromIdea(raw: string): Partial<Record<IncubatorSlotKey, string>> {
  const text = raw.trim()
  if (!text) return {}

  const result: Partial<Record<IncubatorSlotKey, string>> = {}
  for (const k of INCUBATOR_SLOT_KEYS) {
    const label = INCUBATOR_SLOT_LABELS[k]
    const re = new RegExp(
      `##\\s*${escapeRegExp(label)}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`,
      'i'
    )
    const m = text.match(re)
    if (m?.[1]?.trim()) result[k] = m[1].trim()
  }
  return result
}

/** 去掉质量评分卡、文风块，以及 `---` 之后的槽位明细区（仅取统合叙事时用） */
export function stripIdeaNoiseSuffix(text: string): string {
  let cut = text.trim()
  const noiseMarkers = [
    '## 质量评分卡',
    '【文风要求】',
    '【文风身份',
    '【文风模板】',
    '\n---\n',
    '## 槽位明细'
  ]
  for (const marker of noiseMarkers) {
    const idx = cut.indexOf(marker)
    if (idx > 0) cut = cut.slice(0, idx).trim()
  }
  return cut
}

/** 从 idea 提取统合摘要正文（兼容冻结版「统合摘要」标题） */
export function extractSynthesizedSummaryFromIdea(raw: string): string {
  const text = raw.trim()
  if (!text) return ''

  for (const alias of SYNTH_HEADING_ALIASES) {
    const re = new RegExp(
      `##\\s*${escapeRegExp(alias)}\\s*\\n([\\s\\S]*?)(?=##\\s*质量评分卡|##\\s*槽位明细|【文风|##\\s*文风|\\n---\\n|$)`,
      'i'
    )
    const m = text.match(re)
    if (m?.[1]?.trim()) return m[1].trim()
  }

  const stripped = stripIdeaNoiseSuffix(text)
  if (stripped.startsWith('#')) {
    const afterTitle = stripped.replace(/^#[^\n]*\n+/, '').trim()
    if (afterTitle && !afterTitle.startsWith('##')) {
      return afterTitle
    }
  }
  return stripped
}

function getSlotMapFromSnapshot(
  snap: { slots?: Record<string, string> },
  workId: number
): Record<string, string> {
  if (snap.slots && Object.keys(snap.slots).length > 0) {
    return snap.slots
  }
  const rows = incubatorDraftSlotDAO.listActiveByWork(workId)
  const map: Record<string, string> = {}
  for (const k of INCUBATOR_SLOT_KEYS) {
    const row = rows.find(s => s.slot_key === k)
    map[k] = row?.content?.trim() ?? ''
  }
  return map
}

function buildFromSlotMap(
  synthesizedSummary: string | null | undefined,
  slotMap: Record<string, string | undefined>,
  options: FrozenStorylineContextOptions
): string {
  const slotKeys = options.slotKeys ?? INCUBATOR_SLOT_KEYS
  const parts: string[] = []

  if (synthesizedSummary?.trim()) {
    parts.push(formatSynthSection(synthesizedSummary))
  }

  if (options.includeSlots) {
    parts.push(...formatSlotSections(slotMap, slotKeys))
  } else if (!synthesizedSummary?.trim()) {
    parts.push(...formatSlotSections(slotMap, INCUBATOR_SLOT_KEYS))
  }

  if (!parts.length) return ''
  return assembleParts(parts)
}

/** 从 core_settings.idea 拼出主线上下文（冻结快照不可用时的回退） */
export function buildStorylineContextFromIdea(
  raw: string,
  options: Pick<FrozenStorylineContextOptions, 'includeSlots' | 'slotKeys'> = {}
): string {
  const slotKeys = options.slotKeys ?? INCUBATOR_SLOT_KEYS
  const synth = extractSynthesizedSummaryFromIdea(raw)
  const parts: string[] = []
  if (synth) parts.push(formatSynthSection(synth))

  if (options.includeSlots) {
    const parsed = parseSlotSectionsFromIdea(raw)
    parts.push(...formatSlotSections(parsed as Record<string, string>, slotKeys))
  }

  if (!parts.length) return ''
  return assembleParts(parts)
}

/** 供核心设定等下游使用的冻结主线 / 草案摘要（已采纳槽位，不含 AI 分析原文） */
export function buildFrozenStorylineContext(
  workId: number,
  options: FrozenStorylineContextOptions = {}
): string {
  const includeQualitySnapshot = options.includeQualitySnapshot ?? false
  const frozen = incubatorVersionDAO.getLatestFrozen(workId)

  if (frozen) {
    try {
      const snap = JSON.parse(frozen.snapshot_json) as {
        slots?: Record<string, string>
        synthesizedSummary?: string | null
        qualitySnapshot?: string | null
      }
      const slotMap = getSlotMapFromSnapshot(snap, workId)
      const hasSynth = !!snap.synthesizedSummary?.trim()

      if (hasSynth || options.includeSlots) {
        const parts: string[] = []
        if (hasSynth) {
          parts.push(formatSynthSection(snap.synthesizedSummary!))
          if (includeQualitySnapshot && snap.qualitySnapshot?.trim()) {
            parts.push(`## 质量评分卡\n${snap.qualitySnapshot.trim()}`)
          }
        }
        if (options.includeSlots) {
          const keys = options.slotKeys ?? INCUBATOR_SLOT_KEYS
          parts.push(...formatSlotSections(slotMap, keys))
        }
        if (parts.length) return assembleParts(parts)
      }

      if (snap.slots) {
        return buildFromSlotMap(null, slotMap, {
          ...options,
          includeSlots: true,
          slotKeys: options.slotKeys ?? INCUBATOR_SLOT_KEYS
        })
      }
    } catch {
      /* fall through */
    }
  }

  const rows = incubatorDraftSlotDAO.listActiveByWork(workId)
  const slotMap: Record<string, string> = {}
  for (const k of INCUBATOR_SLOT_KEYS) {
    const row = rows.find(s => s.slot_key === k)
    slotMap[k] = row?.content?.trim() ?? ''
  }
  if (!Object.values(slotMap).some(Boolean)) return ''

  return buildFromSlotMap(null, slotMap, {
    ...options,
    includeSlots: true,
    slotKeys: options.slotKeys ?? INCUBATOR_SLOT_KEYS
  })
}
