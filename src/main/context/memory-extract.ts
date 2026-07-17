import { foreshadowingDAO, characterSnapshotDAO, timelineDAO, storyStateDAO } from '../db'
import type { ForeshadowingDepth } from '../db/dao/foreshadowing-dao'
import type {
  ChapterPatternFingerprintInput,
  StoryStateFactInput,
  StoryStateTransition,
  StoryStateValueType
} from '../../shared/novel-systemic-types'

export interface ExtractedMemory {
  foreshadowing_planted?: {
    description: string
    depth?: ForeshadowingDepth
    location?: string
  }[]
  foreshadowing_resolved?: {
    description: string
    location?: string
  }[]
  character_snapshots?: {
    character_name: string
    location?: string
    mental_state?: string
    known_info?: string
    relationship_changes?: string
    ability_changes?: string
    numeric_stats?: { name: string; value: string; unit?: string }[]
  }[]
  timeline_events?: {
    event_name: string
    event_description?: string
    absolute_time?: string
    relative_time?: string
  }[]
  state_facts?: StoryStateFactInput[]
  chapter_pattern?: ChapterPatternFingerprintInput
}

export interface MemoryExtractResult {
  planted: number
  resolved: number
  snapshots: number
  timelineEvents: number
  stateFacts: number
  patternFingerprint: boolean
}

export interface ForeshadowingResolutionResult {
  resolved: { id: number; evidence: string }[]
  partial: { id: number; evidence: string }[]
  pending: number[]
}

export const MEMORY_EXTRACT_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['foreshadowing_planted', 'foreshadowing_resolved', 'character_snapshots', 'timeline_events', 'state_facts', 'chapter_pattern'],
  properties: {
    foreshadowing_planted: { type: 'array', items: { type: 'object', additionalProperties: true } },
    foreshadowing_resolved: { type: 'array', items: { type: 'object', additionalProperties: true } },
    character_snapshots: { type: 'array', items: { type: 'object', additionalProperties: true } },
    timeline_events: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: true,
        required: ['event_name'],
        properties: {
          event_name: { type: 'string', minLength: 1 },
          event_description: { type: 'string' },
          absolute_time: { type: 'string' },
          relative_time: { type: 'string' }
        }
      }
    },
    state_facts: { type: 'array', items: { type: 'object', additionalProperties: true } },
    chapter_pattern: {
      type: 'object',
      additionalProperties: false,
      required: [
        'conflictType', 'protagonistMethod', 'antagonistTactic', 'antagonistOutcome',
        'opponentAdjustment', 'locationType', 'hookType', 'costType',
        'relationshipDelta', 'volumeObjectiveDelta', 'payoffType'
      ],
      properties: {
        conflictType: { type: 'string' },
        protagonistMethod: { type: 'string' },
        antagonistTactic: { type: 'string' },
        antagonistOutcome: { type: 'string' },
        opponentAdjustment: { type: 'string' },
        locationType: { type: 'string' },
        hookType: { type: 'string' },
        costType: { type: 'string' },
        relationshipDelta: { type: 'string' },
        volumeObjectiveDelta: { type: 'string' },
        payoffType: { type: 'string', enum: ['debt', 'partial', 'major', 'aftertaste'] }
      }
    }
  },
  additionalProperties: false
} as const

export function parseMemoryExtract(content: string): ExtractedMemory {
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  try {
    const parsed = JSON.parse(match?.[1] ?? content) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('根节点必须是对象')
    }
    const result = parsed as ExtractedMemory
    if (!Array.isArray(result.foreshadowing_planted)
      || !Array.isArray(result.foreshadowing_resolved)
      || !Array.isArray(result.character_snapshots)
      || !Array.isArray(result.timeline_events)) {
      throw new Error('缺少完整的叙事记忆数组字段')
    }
    result.timeline_events = normalizeTimelineEvents(result.timeline_events)
    if (result.timeline_events.length === 0) throw new Error('本章至少需要一条有效的关键时间线事件')
    result.state_facts = normalizeStateFacts(result.state_facts)
    result.chapter_pattern = normalizeChapterPattern(result.chapter_pattern)
    return result
  } catch (error) {
    throw new Error(`叙事记忆解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

function normalizeTimelineEvents(value: unknown): NonNullable<ExtractedMemory['timeline_events']> {
  if (!Array.isArray(value)) return []
  const placeholderTimes = new Set(['relative_time', 'absolute_time', 'null', 'none', '未知', '无', '无明确时间'])
  const normalizeTime = (item: unknown): string => {
    const text = typeof item === 'string' ? item.trim() : ''
    return placeholderTimes.has(text.toLowerCase()) ? '' : text
  }
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const eventName = typeof row.event_name === 'string' ? row.event_name.trim() : ''
    const absoluteTime = normalizeTime(row.absolute_time)
    const relativeTime = normalizeTime(row.relative_time)
    if (!eventName) return []
    return [{
      event_name: eventName,
      event_description: typeof row.event_description === 'string'
        ? row.event_description.trim() || undefined
        : undefined,
      absolute_time: absoluteTime || undefined,
      // 时间是派生索引，不应因弱模型漏字段而否决已经有效的事件；用保守相对锚点降级。
      relative_time: relativeTime || (absoluteTime ? undefined : '本章内')
    }]
  })
}

function compactEvidenceText(value: string): string {
  return value.replace(/[\s“”‘’'"《》]/g, '')
}

export function partitionStateFactsByEvidence(
  extracted: ExtractedMemory,
  sourceContent: string
): { valid: StoryStateFactInput[]; errors: string[] } {
  const source = compactEvidenceText(sourceContent)
  const valid: StoryStateFactInput[] = []
  const errors: string[] = []
  for (const fact of extracted.state_facts ?? []) {
    const label = `${fact.entity}.${fact.key}`
    const evidence = fact.evidence?.trim() ?? ''
    if (!evidence) {
      errors.push(`${label}缺少正文证据`)
      continue
    }
    if (evidence.replace(/\s/g, '').length > 80) {
      errors.push(`${label}证据超过80字，无法稳定定位`)
      continue
    }
    if (!source.includes(compactEvidenceText(evidence))) {
      errors.push(`${label}证据不是正文原文片段`)
      continue
    }
    valid.push(fact)
  }
  return { valid, errors }
}

/** 承重状态必须能回指正文原句；无证据的模型推断不得写入事实账本。 */
export function validateStateFactEvidence(extracted: ExtractedMemory, sourceContent: string): string[] {
  return partitionStateFactsByEvidence(extracted, sourceContent).errors
}

const STATE_VALUE_TYPES = new Set<StoryStateValueType>(['number', 'enum', 'boolean', 'set', 'text'])
const STATE_TRANSITIONS = new Set<StoryStateTransition>(['create', 'update', 'increase', 'decrease', 'unlock', 'complete', 'invalidate'])

function normalizeStateFacts(value: unknown): StoryStateFactInput[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const entity = String(row.entity ?? '').trim()
    const key = String(row.key ?? '').trim()
    const valueType = String(row.valueType ?? row.value_type ?? '') as StoryStateValueType
    const transition = String(row.transition ?? '') as StoryStateTransition
    if (!entity || !key || !STATE_VALUE_TYPES.has(valueType) || !STATE_TRANSITIONS.has(transition)) return []
    return [{
      entity, key, valueType, transition, value: row.value ?? null,
      irreversible: row.irreversible === true,
      evidence: String(row.evidence ?? '').trim() || undefined
    }]
  })
}

function normalizeChapterPattern(value: unknown): ChapterPatternFingerprintInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const payoffType = String(row.payoffType ?? row.payoff_type ?? '') as ChapterPatternFingerprintInput['payoffType']
  if (!['debt', 'partial', 'major', 'aftertaste'].includes(payoffType)) return undefined
  const field = (camel: string, snake: string) => String(row[camel] ?? row[snake] ?? '').trim()
  const result: ChapterPatternFingerprintInput = {
    conflictType: field('conflictType', 'conflict_type'),
    protagonistMethod: field('protagonistMethod', 'protagonist_method'),
    antagonistTactic: field('antagonistTactic', 'antagonist_tactic'),
    antagonistOutcome: field('antagonistOutcome', 'antagonist_outcome'),
    opponentAdjustment: field('opponentAdjustment', 'opponent_adjustment'),
    locationType: field('locationType', 'location_type'),
    hookType: field('hookType', 'hook_type'),
    costType: field('costType', 'cost_type'),
    relationshipDelta: field('relationshipDelta', 'relationship_delta'),
    volumeObjectiveDelta: field('volumeObjectiveDelta', 'volume_objective_delta'),
    payoffType
  }
  return Object.entries(result).some(([key, item]) => key !== 'payoffType' && !String(item).trim())
    ? undefined
    : result
}

export function deriveChapterPatternFromOutlineDiagnosis(
  outlineDiagnosis: string | null | undefined
): ChapterPatternFingerprintInput | undefined {
  if (!outlineDiagnosis?.trim()) return undefined
  try {
    const diagnosis = JSON.parse(outlineDiagnosis) as {
      pattern_contract?: Record<string, unknown>
      dramatic_contract?: Record<string, unknown>
      tension_plan?: { payoff_type?: unknown }
    }
    const pattern = diagnosis.pattern_contract
    if (!pattern) return undefined
    const text = (key: string) => String(pattern[key] ?? '').trim()
    const dramatic = diagnosis.dramatic_contract ?? {}
    const payoffType = String(diagnosis.tension_plan?.payoff_type ?? 'debt') as ChapterPatternFingerprintInput['payoffType']
    if (!['debt', 'partial', 'major', 'aftertaste'].includes(payoffType)) return undefined
    const result: ChapterPatternFingerprintInput = {
      conflictType: text('conflict_type'),
      protagonistMethod: text('protagonist_method'),
      antagonistTactic: text('antagonist_tactic'),
      antagonistOutcome: String(dramatic.irreversible_change ?? dramatic.payoff_or_debt ?? '').trim(),
      opponentAdjustment: text('anticipated_opponent_adjustment'),
      locationType: text('location_type'),
      hookType: text('hook_type'),
      costType: text('cost_type'),
      relationshipDelta: text('relationship_delta'),
      volumeObjectiveDelta: text('volume_objective_delta'),
      payoffType
    }
    return Object.entries(result).some(([key, item]) => key !== 'payoffType' && !String(item).trim())
      ? undefined
      : result
  } catch {
    return undefined
  }
}

export function applyMemoryExtract(
  workId: number,
  chapterId: number,
  extracted: ExtractedMemory
): MemoryExtractResult {
  let planted = 0
  let resolved = 0
  let snapshots = 0
  let timelineEvents = 0
  let stateFacts = 0
  let patternFingerprint = false

  for (const item of extracted.foreshadowing_planted ?? []) {
    if (!item.description?.trim()) continue
    foreshadowingDAO.create({
      work_id: workId,
      description: item.description.trim(),
      plant_chapter_id: chapterId,
      plant_location: item.location,
      depth: item.depth ?? 'normal'
    })
    planted++
  }

  // 硬编码匹配已移除 — 回收检测改用 AI 语义判断（foreshadowing:detectResolutions）
  for (const snap of extracted.character_snapshots ?? []) {
    if (!snap.character_name?.trim()) continue
    const numericStats = snap.numeric_stats && snap.numeric_stats.length > 0
      ? JSON.stringify(snap.numeric_stats)
      : undefined
    characterSnapshotDAO.create({
      work_id: workId,
      character_name: snap.character_name.trim(),
      chapter_id: chapterId,
      location: snap.location,
      mental_state: snap.mental_state,
      known_info: snap.known_info,
      relationship_changes: snap.relationship_changes,
      ability_changes: snap.ability_changes,
      numeric_stats: numericStats
    })
    snapshots++
  }

  for (const event of extracted.timeline_events ?? []) {
    if (!event.event_name?.trim()) continue
    timelineDAO.create({
      work_id: workId,
      chapter_id: chapterId,
      event_name: event.event_name.trim(),
      event_description: event.event_description?.trim(),
      absolute_time: event.absolute_time?.trim(),
      relative_time: event.relative_time?.trim(),
      sort_order: timelineDAO.listByWork(workId).length + 1
    })
    timelineEvents++
  }

  const facts = extracted.state_facts ?? []
  storyStateDAO.replaceChapterFacts(workId, chapterId, facts)
  stateFacts = facts.length
  if (extracted.chapter_pattern) {
    storyStateDAO.replaceFingerprint(workId, chapterId, extracted.chapter_pattern)
    patternFingerprint = true
  }

  return { planted, resolved, snapshots, timelineEvents, stateFacts, patternFingerprint }
}

export const FORESHADOWING_RESOLVE_SYSTEM_PROMPT = [
  '你是伏笔回收分析器。根据章节内容，判断每条待回收伏笔的回收状态。',
  '',
  '判断标准：',
  '- resolved：本章明确揭示了伏笔的真相/结果，读者能感知到"这个伏笔已经回收了"',
  '- partial：本章推进了该伏笔（给出线索、暗示、部分揭示），但未完全回收',
  '- pending：本章未涉及该伏笔',
  '',
  '注意：',
  '- 只看本章内容，不要推测未来章节',
  '- 伏笔回收可能是隐晦的——比如通过角色的行为、对话暗示，不一定是明说',
  '- evidence 字段摘录文中支持你判断的关键句子（不超过 50 字）',
  '',
  '输出严格 JSON：',
  '{"results":[{"id":1,"status":"resolved","evidence":"文中关键句"},{"id":2,"status":"pending","evidence":""}]}',
  '不要输出其他文字。'
].join('\n')

export function parseForeshadowingResolutions(content: string): ForeshadowingResolutionResult {
  const trimmed = content.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fenced ? fenced[1].trim() : trimmed

  let data: unknown
  try {
    data = JSON.parse(jsonText)
  } catch {
    const bare = jsonText.match(/\{[\s\S]*"results"[\s\S]*\}/)
    if (!bare) return { resolved: [], partial: [], pending: [] }
    try { data = JSON.parse(bare[0]) } catch { return { resolved: [], partial: [], pending: [] } }
  }

  if (!data || typeof data !== 'object') return { resolved: [], partial: [], pending: [] }
  const results = (data as Record<string, unknown>).results
  if (!Array.isArray(results)) return { resolved: [], partial: [], pending: [] }

  const resolved: ForeshadowingResolutionResult['resolved'] = []
  const partial: ForeshadowingResolutionResult['partial'] = []
  const pending: number[] = []

  for (const item of results) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'number' ? row.id : parseInt(String(row.id ?? ''), 10)
    if (!Number.isFinite(id)) continue
    const status = String(row.status ?? '').toLowerCase()
    const evidence = typeof row.evidence === 'string' ? row.evidence.trim() : ''
    if (status === 'resolved') resolved.push({ id, evidence })
    else if (status === 'partial') partial.push({ id, evidence })
    else pending.push(id)
  }

  return { resolved, partial, pending }
}

export function applyForeshadowingResolutions(
  workId: number,
  chapterId: number,
  result: ForeshadowingResolutionResult
): { resolved: number; partial: number } {
  let resolvedCount = 0
  let partialCount = 0

  for (const item of result.resolved) {
    const row = foreshadowingDAO.getById(item.id)
    if (!row || row.work_id !== workId) continue
    if (row.status === 'resolved') continue
    foreshadowingDAO.resolve(item.id, chapterId, item.evidence || undefined)
    resolvedCount++
  }

  for (const item of result.partial) {
    const row = foreshadowingDAO.getById(item.id)
    if (!row || row.work_id !== workId) continue
    if (row.status === 'resolved' || row.status === 'abandoned') continue
    foreshadowingDAO.updateStatus(item.id, 'partial')
    partialCount++
  }

  return { resolved: resolvedCount, partial: partialCount }
}

export const MEMORY_EXTRACT_SYSTEM_PROMPT = [
  '从章节正文中提取叙事记忆体更新信息。',
  '识别：新埋设的伏笔（标注 depth: shallow/normal/deep）、本章回收的伏笔、出场角色的状态变化、时间推进与关键事件。',
  '',
  '角色快照的 numeric_stats 字段（极重要）：',
  '提取角色在本章结束时的所有数值类状态，包括但不限于：体力/气血/法力/灵力、等级/境界、积分/贡献点/信用度、金钱/资源数量、装备耐久度等。',
  '每项格式：{"name":"属性名","value":"数值或状态","unit":"单位（可选）"}',
  '必须记录本章中发生变化的数值，以及与后续剧情可能产生冲突的关键数值。',
  '示例：[{"name":"体力","value":"50","unit":""},{"name":"信用度","value":"87","unit":"点"},{"name":"境界","value":"练气三层","unit":""}]',
  '若本章无数值类状态变化，numeric_stats 留空数组。',
  'timeline_events 必须记录本章关键事件，以及发生时间或相对上一章的时间推进；没有明确绝对时间时填写 relative_time。',
  '涉及证据、文件、钥匙、手机、武器、信物等承重道具时，必须在 timeline_events.event_description 中记录其章末持有人、所在位置、公开/隐藏/损毁状态，并在知情角色的 character_snapshots.known_info 中记录谁已经知道该状态。',
  '已经发生过的关键事件必须按本章实际时序记录，不得把回忆或复述误记为本章再次发生。',
  '',
  'state_facts 用于记录跨章承重状态。题材无关地提取：能力/境界/权限、任务状态、伤势、身份、阵营、持有物、地点控制权、对手已知情报等。',
  '只记录本章明确创建或发生变化的状态；valueType 只允许 number/enum/boolean/set/text；transition 只允许 create/update/increase/decrease/unlock/complete/invalidate。',
  '同一章的同一 entity+key 只输出一条，value 必须是章末最终状态；不得把变化前后两个值同时当作并存事实。',
  '完成任务用 complete，解锁能力或权限用 unlock；不可逆事实设置 irreversible=true；evidence 必须逐字复制正文中连续的原文片段，不得改写、概括或补充正文没有的字段名，且不超过50字。',
  'chapter_pattern 必须用抽象语义概括本章结构，不得照抄专有名词。relationshipDelta 和 volumeObjectiveDelta 无变化时明确写“无变化”。',
  'payoffType 只允许 debt/partial/major/aftertaste。opponentAdjustment 必须说明对手是否基于既有失败改变策略。',
  '',
  '输出 JSON：',
  '```json',
  '{"foreshadowing_planted":[{"description":"","depth":"normal","location":""}],"foreshadowing_resolved":[{"description":"","location":""}],"character_snapshots":[{"character_name":"","location":"","mental_state":"","known_info":"","relationship_changes":"","ability_changes":"","numeric_stats":[{"name":"","value":"","unit":""}]}],"timeline_events":[{"event_name":"","event_description":"","absolute_time":"","relative_time":""}],"state_facts":[{"entity":"","key":"","valueType":"enum","value":"","transition":"update","irreversible":false,"evidence":""}],"chapter_pattern":{"conflictType":"","protagonistMethod":"","antagonistTactic":"","antagonistOutcome":"","opponentAdjustment":"","locationType":"","hookType":"","costType":"","relationshipDelta":"","volumeObjectiveDelta":"","payoffType":"debt"}}',
  '```',
  '若无某项则留空数组。'
].join('\n')
