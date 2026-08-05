import { createHash } from 'node:crypto'

const OUTLINE_SECTION_LABELS = ['开场状态', '必须覆盖', '禁止越界', '结尾落点', '连续性约束'] as const
const PLANNING_PATTERN_KEYS = [
  'anticipated_opponent_adjustment', 'hook_type', 'relationship_delta', 'volume_objective_delta'
] as const

// v9：章节标题纳入全书唯一性合同；旧骨架检查点不得绕过标题校验。
export const CHAPTER_SKELETON_PROTOCOL_VERSION = 9
export const CHAPTER_SKELETON_AUTHORITY_LEDGER_VERSION = 1
export const RECENT_SKELETON_CONTEXT_CHAPTERS = 3
export const RECENT_SKELETON_SECTION_MAX_CHARS = 160
export const RECENT_SKELETON_PATTERN_FIELD_MAX_CHARS = 140
export const CHAPTER_SKELETON_COMPILED_MAX_CHARS = 1400
export const CHAPTER_SKELETON_OPENING_MAX_CHARS = 160
export const CHAPTER_SKELETON_ENDING_MAX_CHARS = 180
export const CHAPTER_SKELETON_BEAT_MAX_CHARS = 100
export const CHAPTER_SKELETON_FORESHADOW_MAX_CHARS = 120
export const CHAPTER_SKELETON_CONSTRAINT_MAX_CHARS = 100
const CHAPTER_SKELETON_TOKEN_BUDGETS = [1600, 3200, 6400] as const
export const CHAPTER_SKELETON_MAX_ATTEMPTS = CHAPTER_SKELETON_TOKEN_BUDGETS.length

export const CHAPTER_AUTHORITY_FIELDS = [
  'life_status', 'location', 'owner', 'possession', 'knowledge', 'identity',
  'relationship', 'capability', 'condition', 'promise', 'event_boundary', 'custom'
] as const
export const CHAPTER_AUTHORITY_OPERATORS = [
  'must_equal', 'must_not_equal', 'must_preserve', 'must_not_happen'
] as const

export type ChapterAuthorityField = typeof CHAPTER_AUTHORITY_FIELDS[number]
export type ChapterAuthorityOperator = typeof CHAPTER_AUTHORITY_OPERATORS[number]
export type ChapterSkeletonConstraintKind = 'forbidden' | 'continuity'

export interface ChapterSkeletonAuthorityFact {
  id: string
  subject: string
  field: ChapterAuthorityField
  value: string
  sourceChapter: number
}

export interface ChapterSkeletonAuthorityConstraint {
  id: string
  kind: ChapterSkeletonConstraintKind
  subject: string
  field: ChapterAuthorityField
  operator: ChapterAuthorityOperator
  value: string
  sourceChapter: number
}

export interface ChapterSkeletonAuthorityLedger {
  version: 1
  revision: number
  lastCommittedChapter: number
  facts: Record<string, ChapterSkeletonAuthorityFact>
  constraints: Record<string, ChapterSkeletonAuthorityConstraint>
}

export interface ProjectedChapterSkeletonDelta {
  outline: string
  ledger: ChapterSkeletonAuthorityLedger
}

export function chapterSkeletonTokenBudget(attempt: number): number {
  const index = Math.max(0, Math.min(CHAPTER_SKELETON_TOKEN_BUDGETS.length - 1, Math.trunc(attempt) - 1))
  return CHAPTER_SKELETON_TOKEN_BUDGETS[index]
}

export function chapterSkeletonRequestTokenBudget(attempt: number, lastError: string): number {
  if (attempt <= 1) return chapterSkeletonTokenBudget(1)
  if (/OUTPUT_TRUNCATED|finishReason=length|达到长度上限|Unexpected end|Unterminated string|正文为空|模型无返回|REASONING_BUDGET_EXHAUSTED/i.test(lastError)) {
    return chapterSkeletonTokenBudget(attempt)
  }
  return chapterSkeletonTokenBudget(1)
}

function clipText(value: unknown, maxChars: number): string {
  return Array.from(String(value ?? '').trim()).slice(0, Math.max(0, maxChars)).join('')
}

function stableId(prefix: 'F' | 'K', parts: unknown[]): string {
  return `${prefix}${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12)}`
}

function readOutlineSection(outline: string, label: typeof OUTLINE_SECTION_LABELS[number]): string {
  const start = outline.indexOf(`【${label}】`)
  if (start < 0) return ''
  const remaining = outline.slice(start + label.length + 2)
  const next = OUTLINE_SECTION_LABELS
    .map(candidate => remaining.indexOf(`【${candidate}】`))
    .filter(index => index >= 0)
    .sort((left, right) => left - right)[0]
  return (next == null ? remaining : remaining.slice(0, next)).trim()
}

function splitConstraintText(value: string, kind: ChapterSkeletonConstraintKind): string[] {
  return value
    .split(/[；;。\n]+/u)
    .map(item => item.trim())
    .filter(Boolean)
    .flatMap(section => section
      .split(kind === 'forbidden'
        ? /[，,](?=不得)/u
        : /[，,](?=(?:[^，,]{0,24}必须|系统(?:升级|状态)|['‘]回收者))/u)
      .map(item => item.trim())
      .filter(Boolean))
}

function inferLegacySubject(value: string): string {
  const match = value.match(/^(?:不得让)?([^，,：:]{1,16}?)(?:必须|不得|被|在|持有|状态|$)/u)
  return match?.[1]?.trim() || '历史剧情边界'
}

function inferLegacyField(value: string): ChapterAuthorityField {
  if (/死亡|复活|击杀|存活/u.test(value)) return 'life_status'
  if (/位置|地点|楼|商超|密室|下水道|通风管道/u.test(value)) return 'location'
  if (/持有|手枪|装备|终端|消防斧|纸条/u.test(value)) return 'possession'
  if (/身份|含义|揭晓|解释|知道/u.test(value)) return 'knowledge'
  if (/能力|权限|回收过程|系统/u.test(value)) return 'capability'
  if (/关系|结盟/u.test(value)) return 'relationship'
  return 'event_boundary'
}

export function buildChapterSkeletonAuthorityConstraints(
  previousOutline: string,
  sourceChapter = 0
): ChapterSkeletonAuthorityConstraint[] {
  const rows: ChapterSkeletonAuthorityConstraint[] = []
  const seen = new Set<string>()
  const append = (kind: ChapterSkeletonConstraintKind, label: '禁止越界' | '连续性约束'): void => {
    for (const value of splitConstraintText(readOutlineSection(previousOutline, label), kind)) {
      const subject = inferLegacySubject(value)
      const field = inferLegacyField(value)
      const operator: ChapterAuthorityOperator = kind === 'forbidden' ? 'must_not_happen' : 'must_preserve'
      const key = JSON.stringify([kind, subject, field, operator, value])
      if (seen.has(key)) continue
      seen.add(key)
      const id = stableId('K', [sourceChapter, rows.length, key])
      rows.push({ id, kind, subject, field, operator, value, sourceChapter })
    }
  }
  append('forbidden', '禁止越界')
  append('continuity', '连续性约束')
  return rows
}

export function materializeChapterSkeletonAuthorityLedger(
  previousOutline: string,
  lastCommittedChapter: number
): ChapterSkeletonAuthorityLedger {
  const constraints = buildChapterSkeletonAuthorityConstraints(previousOutline, lastCommittedChapter)
  return {
    version: CHAPTER_SKELETON_AUTHORITY_LEDGER_VERSION,
    revision: 0,
    lastCommittedChapter,
    facts: {},
    constraints: Object.fromEntries(constraints.map(item => [item.id, item]))
  }
}

export function validateChapterSkeletonAuthorityLedger(
  value: unknown,
  expectedLastChapter?: number
): ChapterSkeletonAuthorityLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('章节权威账本不存在')
  const ledger = value as ChapterSkeletonAuthorityLedger
  if (ledger.version !== CHAPTER_SKELETON_AUTHORITY_LEDGER_VERSION) throw new Error('章节权威账本版本不匹配')
  if (!Number.isInteger(ledger.revision) || ledger.revision < 0) throw new Error('章节权威账本 revision 非法')
  if (!Number.isInteger(ledger.lastCommittedChapter) || ledger.lastCommittedChapter < 0) {
    throw new Error('章节权威账本 lastCommittedChapter 非法')
  }
  if (expectedLastChapter != null && ledger.lastCommittedChapter !== expectedLastChapter) {
    throw new Error(`章节权威账本边界不匹配：账本 ${ledger.lastCommittedChapter}，章节 ${expectedLastChapter}`)
  }
  if (!ledger.facts || typeof ledger.facts !== 'object' || !ledger.constraints || typeof ledger.constraints !== 'object') {
    throw new Error('章节权威账本 facts/constraints 非法')
  }
  return ledger
}

export function formatChapterSkeletonAuthorityRegistry(ledger: ChapterSkeletonAuthorityLedger): string {
  const facts = Object.values(ledger.facts).map(item =>
    `${item.id} [fact] subject=${item.subject}; field=${item.field}; value=${item.value}`)
  const constraints = Object.values(ledger.constraints).map(item =>
    `${item.id} [${item.kind}] subject=${item.subject}; field=${item.field}; operator=${item.operator}; value=${item.value}`)
  return [...facts, ...constraints].join('\n') || '空账本；本章建立首批结构化事实与约束。'
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`)
  return value.map((item, index) => {
    const text = String(item ?? '').trim()
    if (!text) throw new Error(`${label}[${index}] 不能为空`)
    return text
  })
}

function authorityField(value: unknown, label: string): ChapterAuthorityField {
  const field = String(value ?? '') as ChapterAuthorityField
  if (!CHAPTER_AUTHORITY_FIELDS.includes(field)) throw new Error(`${label} 非法`)
  return field
}

function renderConstraint(item: ChapterSkeletonAuthorityConstraint): string {
  if (item.operator === 'must_equal') return `${item.subject}的${item.field}必须为${item.value}`
  if (item.operator === 'must_not_equal') return `${item.subject}的${item.field}不得为${item.value}`
  if (item.operator === 'must_preserve') return `${item.subject}的${item.field}必须保持${item.value}`
  return `不得发生：${item.subject}·${item.field}·${item.value}`
}

export function projectChapterSkeletonDelta(
  value: unknown,
  sourceLedger: ChapterSkeletonAuthorityLedger,
  chapterNumber: number
): ProjectedChapterSkeletonDelta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('章节状态增量必须是对象')
  if (chapterNumber !== sourceLedger.lastCommittedChapter + 1) {
    throw new Error(`章节状态增量边界不连续：账本 ${sourceLedger.lastCommittedChapter}，候选 ${chapterNumber}`)
  }
  const delta = value as Record<string, unknown>
  const requiredBeats = stringArray(delta.required_beats, 'required_beats')
  const facts = { ...sourceLedger.facts }
  const constraints = { ...sourceLedger.constraints }
  const factChanges = Array.isArray(delta.fact_changes) ? delta.fact_changes : []
  if (factChanges.length === 0) {
    throw new Error('fact_changes 至少需要一项状态操作')
  }
  const touchedFactIds = new Set<string>()
  const stateOperations: Array<{ beatIndex: number; text: string }> = []
  for (const [index, raw] of factChanges.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`fact_changes[${index}] 必须是对象`)
    const row = raw as Record<string, unknown>
    const subject = String(row.subject ?? '').trim()
    const field = authorityField(row.field, `fact_changes[${index}].field`)
    const after = String(row.after ?? '').trim()
    const beatIndex = Number(row.beat_index)
    if (!subject || !after) throw new Error(`fact_changes[${index}] 缺少 subject/after`)
    if (!Number.isInteger(beatIndex) || beatIndex < 1 || beatIndex > requiredBeats.length) {
      throw new Error(`fact_changes[${index}].beat_index 必须引用 required_beats`)
    }
    const factId = stableId('F', [subject, field])
    const existing = facts[factId]
    if (touchedFactIds.has(factId)) throw new Error(`权威事实 ${factId} 在本章只能操作一次`)
    if (existing?.value === after) throw new Error(`fact_changes[${index}] 未改变权威事实 ${factId}`)
    touchedFactIds.add(factId)
    facts[factId] = existing
      ? { ...existing, value: after, sourceChapter: chapterNumber }
      : { id: factId, subject, field, value: after, sourceChapter: chapterNumber }
    stateOperations.push({
      beatIndex,
      text: `${factId}@${beatIndex}`
    })
  }
  const stateTexts = stateOperations
    .sort((left, right) => left.beatIndex - right.beatIndex)
    .map(item => item.text)

  const resolved = Array.isArray(delta.resolved_constraints) ? delta.resolved_constraints : []
  const resolvedIds = new Set<string>()
  for (const [index, raw] of resolved.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`resolved_constraints[${index}] 必须是对象`)
    const row = raw as Record<string, unknown>
    const id = String(row.constraint_id ?? '').trim()
    const beatIndex = Number(row.beat_index)
    if (!constraints[id]) throw new Error(`resolved_constraints[${index}] 引用了不存在的权威约束 ${id}`)
    if (resolvedIds.has(id)) throw new Error(`权威约束 ${id} 只能解除一次`)
    if (!Number.isInteger(beatIndex) || beatIndex < 1 || beatIndex > requiredBeats.length) {
      throw new Error(`resolved_constraints[${index}].beat_index 必须引用 required_beats`)
    }
    resolvedIds.add(id)
    delete constraints[id]
  }

  const addedConstraints: ChapterSkeletonAuthorityConstraint[] = []
  const foreshadowTarget = String(delta.foreshadow_target ?? '').trim()
  if (foreshadowTarget) {
    const id = stableId('K', [chapterNumber, 'foreshadow_target', foreshadowTarget])
    const constraint: ChapterSkeletonAuthorityConstraint = {
      id,
      kind: 'continuity',
      subject: `第${chapterNumber}章伏笔`,
      field: 'promise',
      operator: 'must_preserve',
      value: foreshadowTarget,
      sourceChapter: chapterNumber
    }
    constraints[id] = constraint
    addedConstraints.push(constraint)
  }

  const nextLedger: ChapterSkeletonAuthorityLedger = {
    version: CHAPTER_SKELETON_AUTHORITY_LEDGER_VERSION,
    revision: sourceLedger.revision + 1,
    lastCommittedChapter: chapterNumber,
    facts,
    constraints
  }
  const forbidden = addedConstraints.filter(item => item.kind === 'forbidden').map(renderConstraint)
  const continuity = [
    ...addedConstraints.filter(item => item.kind === 'continuity').map(item => `承诺${item.id}`),
    ...stateTexts
  ]
  return {
    ledger: nextLedger,
    outline: [
      `【开场状态】${String(delta.opening_state ?? '').trim()}`,
      `【必须覆盖】${requiredBeats.join('；')}`,
      `【禁止越界】${forbidden.join('；')}`,
      `【结尾落点】${String(delta.ending_state ?? '').trim()}`,
      `【连续性约束】${continuity.join('；')}`
    ].join('')
  }
}

export function compactOutlineForSkeletonContext(outline: string): string {
  const source = outline.trim()
  if (!source) return ''
  const marker = new RegExp(`(?=【(?:${OUTLINE_SECTION_LABELS.join('|')})】)`, 'g')
  const sections = source.split(marker).map(value => value.trim()).filter(Boolean)
  const labeled = sections.filter(value => OUTLINE_SECTION_LABELS.some(label => value.startsWith(`【${label}】`)))
  if (labeled.length === 0) return clipText(source, RECENT_SKELETON_SECTION_MAX_CHARS * OUTLINE_SECTION_LABELS.length)
  return labeled.slice(0, OUTLINE_SECTION_LABELS.length)
    .map(value => clipText(value, RECENT_SKELETON_SECTION_MAX_CHARS)).join('\n')
}

export function compactPatternForSkeletonContext(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const source = value as Record<string, unknown>
  return Object.fromEntries(PLANNING_PATTERN_KEYS
    .map(key => [key, clipText(source[key], RECENT_SKELETON_PATTERN_FIELD_MAX_CHARS)] as const)
    .filter(([, text]) => Boolean(text)))
}
