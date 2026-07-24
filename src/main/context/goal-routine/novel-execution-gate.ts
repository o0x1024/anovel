import { createHash } from 'node:crypto'
import { modelService } from '../../model'
import { volumeChapterDAO } from '../../db'
import { countWords } from '../../../shared/body-word-target'
import { extractJsonText } from '../parse-json-extract'
import { parseJsonObjectWithRepairs } from '../../../shared/model-json-repair'
import {
  formatChapterExecutionContract,
  type ChapterExecutionContract
} from '../../../shared/chapter-execution-contract'
import { withGoalLoopModelOptions } from './story-goal-model'

export type NovelCoverageVerdict = 'covered' | 'partial' | 'missing'

export interface NovelCoverageEvidence {
  requirementId: string
  event: string
  verdict: NovelCoverageVerdict
  evidenceIds: string[]
  evidence: string[]
  reason: string
}

export interface NovelExecutionGateResult {
  passed: boolean
  blockers: string[]
  warnings: string[]
  coverage: NovelCoverageEvidence[]
  forbiddenViolations: string[]
  evaluatorProtocolErrors?: string[]
}

function responseSchema(contract: ChapterExecutionContract): Record<string, unknown> {
  const requirements = contract.requirements.length > 0
    ? contract.requirements
    : contract.requiredEvents.map((description, index) => ({ id: `R${String(index + 1).padStart(3, '0')}`, description }))
  const violationSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'evidence_ids'],
    properties: {
      description: { type: 'string' },
      evidence_ids: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: { type: 'string', pattern: '^[CP][0-9]{3}$' }
      }
    }
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['passed', 'coverage', 'forbidden_violations', 'continuity_blockers', 'warnings'],
    properties: {
      passed: { type: 'boolean' },
      coverage: {
        type: 'array',
        minItems: requirements.length,
        maxItems: requirements.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['requirement_id', 'verdict', 'evidence_ids', 'reason'],
          properties: {
            requirement_id: { type: 'string', enum: requirements.map(item => item.id) },
            verdict: { type: 'string', enum: ['covered', 'partial', 'missing'] },
            evidence_ids: {
              type: 'array',
              minItems: 0,
              maxItems: 6,
              items: { type: 'string', pattern: '^C[0-9]{3}$' }
            },
            reason: { type: 'string', maxLength: 160 }
          }
        }
      },
      forbidden_violations: { type: 'array', items: violationSchema },
      continuity_blockers: { type: 'array', items: violationSchema },
      warnings: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string', maxLength: 160 }
      }
    }
  }
}

function coverageResponseSchema(
  requirements: Array<{ id: string; description: string }>
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['coverage'],
    properties: {
      coverage: {
        type: 'array',
        minItems: requirements.length,
        maxItems: requirements.length,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['requirement_id', 'verdict', 'evidence_ids', 'reason'],
          properties: {
            requirement_id: { type: 'string', enum: requirements.map(item => item.id) },
            verdict: { type: 'string', enum: ['covered', 'partial', 'missing'] },
            evidence_ids: {
              type: 'array',
              minItems: 0,
              maxItems: 6,
              items: { type: 'string', pattern: '^C[0-9]{3}$' }
            },
            reason: { type: 'string', maxLength: 160 }
          }
        }
      }
    }
  }
}

function singleCoverageResponseSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'evidence_ids', 'reason'],
    properties: {
      verdict: { type: 'string', enum: ['covered', 'partial', 'missing'] },
      evidence_ids: {
        type: 'array',
        minItems: 0,
        maxItems: 6,
        items: { type: 'string', pattern: '^C[0-9]{3}$' }
      },
      reason: { type: 'string', maxLength: 120 }
    }
  }
}

function safetyResponseSchema(): Record<string, unknown> {
  const violationSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'evidence_ids'],
    properties: {
      description: { type: 'string', maxLength: 200 },
      evidence_ids: {
        type: 'array',
        minItems: 1,
        maxItems: 6,
        items: { type: 'string', pattern: '^[CP][0-9]{3}$' }
      }
    }
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['forbidden_violations', 'continuity_blockers', 'warnings'],
    properties: {
      forbidden_violations: { type: 'array', maxItems: 12, items: violationSchema },
      continuity_blockers: { type: 'array', maxItems: 12, items: violationSchema },
      warnings: {
        type: 'array',
        maxItems: 6,
        items: { type: 'string', maxLength: 160 }
      }
    }
  }
}

function violationResponseSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['violations'],
    properties: {
      violations: {
        type: 'array',
        maxItems: 12,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['description', 'evidence_ids'],
          properties: {
            description: { type: 'string', maxLength: 200 },
            evidence_ids: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              items: { type: 'string', pattern: '^[CP][0-9]{3}$' }
            }
          }
        }
      }
    }
  }
}

export function novelExecutionGateMaxTokens(requirementCount: number): number {
  return Math.min(6000, Math.max(3200, 2000 + Math.max(1, requirementCount) * 500))
}

export function shouldSplitNovelExecutionResponse(response: {
  success: boolean
  content?: string
  finishReason?: string
}): boolean {
  return !response.success || !response.content?.trim() || response.finishReason === 'length'
}

export function splitNovelExecutionRequirements<T>(requirements: T[], batchSize = 2): T[][] {
  const size = Math.max(1, Math.floor(batchSize))
  const batches: T[][] = []
  for (let offset = 0; offset < requirements.length; offset += size) {
    batches.push(requirements.slice(offset, offset + size))
  }
  return batches
}

export function normalizeNovelCoverageRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (Array.isArray(row.coverage)) return row.coverage
  if (Array.isArray(row.items)) return row.items
  if (typeof row.requirement_id === 'string') return [row]
  return null
}

function normalizeEvidenceReference(value: string): string | null {
  const match = value.trim().toUpperCase().match(/^([CP])0*([0-9]{1,3})$/)
  if (!match) return null
  const number = Number(match[2])
  if (!Number.isInteger(number) || number < 1 || number > 999) return null
  return `${match[1]}${String(number).padStart(3, '0')}`
}

function evidenceReferencesFromUnknown(value: unknown): string[] {
  const source = Array.isArray(value) ? value.map(String).join(',') : String(value ?? '')
  const references: string[] = []
  const rangePattern = /([CP])0*([0-9]{1,3})\s*[-~—至到]\s*(?:\1)?0*([0-9]{1,3})/gi
  let range: RegExpExecArray | null
  while ((range = rangePattern.exec(source)) !== null) {
    const prefix = range[1].toUpperCase()
    const start = Number(range[2])
    const end = Number(range[3])
    if (Number.isInteger(start) && Number.isInteger(end) && end >= start && end - start <= 20) {
      for (let number = start; number <= end; number++) {
        references.push(`${prefix}${String(number).padStart(3, '0')}`)
      }
    }
  }
  for (const token of source.match(/[CP]0*[0-9]{1,3}/gi) ?? []) {
    const normalized = normalizeEvidenceReference(token)
    if (normalized) references.push(normalized)
  }
  return [...new Set(references)].slice(0, 24)
}

function evidenceIdsFromUnknown(value: unknown): string[] {
  return evidenceReferencesFromUnknown(value)
    .filter(id => id.startsWith('C'))
    .slice(0, 6)
}

function normalizeCoverageVerdict(value: unknown): NovelCoverageVerdict | null {
  const raw = String(value ?? '').trim().toLowerCase()
  if (raw === 'covered' || /^(已覆盖|完整覆盖|通过)$/.test(raw)) return 'covered'
  if (raw === 'partial' || /^(部分覆盖|部分|不完整)$/.test(raw)) return 'partial'
  if (raw === 'missing' || /^(缺失|未覆盖|没有覆盖)$/.test(raw)) return 'missing'
  return null
}

export function coerceNovelSingleCoverageRow(
  value: unknown,
  rawText: string,
  requirementId: string
): Record<string, unknown> | null {
  let candidate: Record<string, unknown> | null = null
  const rows = normalizeNovelCoverageRows(value)
  const first = rows?.[0]
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    candidate = first as Record<string, unknown>
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    candidate = value as Record<string, unknown>
  }

  const compact = rawText.trim()
  const compactVerdict = compact.match(/^(covered|partial|missing)(?=\s*[|:：])/i)?.[1]
    ?? compact.match(/^(已覆盖|完整覆盖|通过|部分覆盖|部分|不完整|缺失|未覆盖|没有覆盖)(?=\s*[|:：])/)?.[1]
  const verdict = normalizeCoverageVerdict(
    candidate?.verdict
      ?? candidate?.status
      ?? candidate?.result
      ?? compactVerdict
  )
  if (!verdict) return null
  const evidenceIds = verdict === 'missing'
    ? []
    : evidenceIdsFromUnknown(
        candidate?.evidence_ids
          ?? candidate?.evidenceIds
          ?? candidate?.evidence
          ?? rawText
      )
  const reason = String(candidate?.reason ?? candidate?.message ?? '').trim().slice(0, 160)
  return {
    requirement_id: requirementId,
    verdict,
    evidence_ids: evidenceIds,
    reason
  }
}

export function normalizeNovelViolationRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  if (Array.isArray(row.violations)) return row.violations
  if (Array.isArray(row.items)) return row.items
  if (typeof row.description === 'string') return [row]
  return null
}

export function canonicalizeNovelViolationRows(
  value: unknown,
  allowedEvidenceIds: string[]
): { rows: Record<string, unknown>[] | null; error: string } {
  const rawRows = normalizeNovelViolationRows(value)
  if (!rawRows) return { rows: null, error: '返回值不包含 violations 数组、根数组或单项对象' }
  const allowed = new Set(allowedEvidenceIds)
  const rows: Record<string, unknown>[] = []
  for (const item of rawRows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { rows: null, error: 'violations 包含非对象项' }
    }
    const row = item as Record<string, unknown>
    const description = String(row.description ?? row.message ?? row.reason ?? '').trim()
    if (!description) return { rows: null, error: 'violations 存在空描述' }
    const requested = evidenceReferencesFromUnknown(
      row.evidence_ids
        ?? row.citations
        ?? row.evidenceIds
        ?? row.evidence
    )
    if (requested.length === 0) {
      return { rows: null, error: `violations「${description}」没有证据编号` }
    }
    const invalid = requested.filter(id => !allowed.has(id))
    if (invalid.length > 0) {
      return {
        rows: null,
        error: `violations「${description}」引用不存在的证据编号：${invalid.join('、')}`
      }
    }
    rows.push({
      description: description.slice(0, 240),
      evidence_ids: requested.slice(0, 12)
    })
  }
  return { rows, error: '' }
}

export function novelCoverageRowsMatchRequirementIds(
  rows: unknown[],
  requirementIds: string[]
): boolean {
  if (rows.length !== requirementIds.length) return false
  const counts = new Map<string, number>()
  for (const item of rows) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const id = String((item as Record<string, unknown>).requirement_id ?? '')
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return requirementIds.every(id => counts.get(id) === 1)
}

interface NovelExecutionGateCheckpoint {
  protocolVersion: 1 | 2
  contractHash: string
  contentHash: string
  coverage: Record<string, unknown>[]
  forbidden_violations?: unknown[]
  continuity_blockers?: unknown[]
  warnings?: string[]
}

export function novelExecutionContentHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex')
}

function readNovelExecutionGateCheckpoint(
  chapterId: number,
  contractHash: string,
  contentHash: string
): NovelExecutionGateCheckpoint | null {
  for (const version of volumeChapterDAO.listVersions(chapterId)) {
    if (version.model_type !== 'novel_gate_checkpoint' || !version.snapshot_json) continue
    try {
      const value = JSON.parse(version.snapshot_json) as Partial<NovelExecutionGateCheckpoint>
      if (
        (value.protocolVersion === 1 || value.protocolVersion === 2)
        && value.contractHash === contractHash
        && value.contentHash === contentHash
        && Array.isArray(value.coverage)
      ) {
        return value as NovelExecutionGateCheckpoint
      }
    } catch { /* 忽略损坏的旧检查点 */ }
  }
  return null
}

function persistNovelExecutionGateCheckpoint(
  chapterId: number,
  content: string,
  contractHash: string,
  patch: Partial<Pick<
    NovelExecutionGateCheckpoint,
    'coverage' | 'forbidden_violations' | 'continuity_blockers' | 'warnings'
  >>
): NovelExecutionGateCheckpoint {
  const contentHash = novelExecutionContentHash(content)
  const previous = readNovelExecutionGateCheckpoint(chapterId, contractHash, contentHash)
  const next: NovelExecutionGateCheckpoint = {
    protocolVersion: 2,
    contractHash,
    contentHash,
    coverage: patch.coverage ?? previous?.coverage ?? [],
    forbidden_violations: patch.forbidden_violations ?? previous?.forbidden_violations,
    continuity_blockers: patch.continuity_blockers ?? previous?.continuity_blockers,
    warnings: patch.warnings ?? previous?.warnings
  }
  const chapter = volumeChapterDAO.getChapter(chapterId)
  volumeChapterDAO.createVersion(chapterId, {
    outline: chapter?.outline ?? undefined,
    content,
    word_count: countWords(content),
    model_type: 'novel_gate_checkpoint',
    generation_round: 1,
    snapshot_json: JSON.stringify(next)
  })
  return next
}

export interface NovelEvidenceSegment {
  id: string
  text: string
}

export function buildNovelEvidenceLedger(content: string, prefix: 'C' | 'P' = 'C'): NovelEvidenceSegment[] {
  const segments: string[] = []
  for (const rawLine of content.split(/\n+/)) {
    const line = rawLine.trim()
    if (!line) continue
    const sentences = line.match(/[^。！？!?]*[。！？!?]+[”’"]?|[^。！？!?]+$/g) ?? [line]
    for (const sentence of sentences) {
      const text = sentence.trim()
      if (text.length >= 2) segments.push(text)
    }
  }
  return segments.slice(0, 999).map((text, index) => ({
    id: `${prefix}${String(index + 1).padStart(3, '0')}`,
    text
  }))
}

function formatEvidenceLedger(segments: NovelEvidenceSegment[]): string {
  return segments.map(segment => `[${segment.id}] ${segment.text}`).join('\n')
}

function contractRequirements(contract: ChapterExecutionContract): Array<{ id: string; description: string }> {
  return contract.requirements.length > 0
    ? contract.requirements
    : contract.requiredEvents.map((description, index) => ({
        id: `R${String(index + 1).padStart(3, '0')}`,
        description
      }))
}

function strings(value: unknown, limit = 20): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean).slice(0, limit)
    : []
}

function evidenceStrings(value: unknown): string[] {
  if (Array.isArray(value)) return strings(value, 6)
  // 兼容已经保存的旧版评估结果；新请求的 schema 只允许数组。
  return typeof value === 'string' && value.trim() ? [value.trim()] : []
}

function normalizeComparable(text: string): string {
  return text.replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】]/g, '')
}

function closestRequiredEvent(raw: string, required: string[]): string | null {
  const target = normalizeComparable(raw)
  if (!target) return null
  return required.find(item => normalizeComparable(item) === target)
    ?? required.find(item => {
      const normalized = normalizeComparable(item)
      return normalized.includes(target) || target.includes(normalized)
    })
    ?? null
}

export function validateNovelExecutionContract(contract: ChapterExecutionContract): string[] {
  const issues = [...contract.errors]
  if (contract.requiredEvents.length === 0) issues.push('没有可验收的必写情节节点')
  if (contractRequirements(contract).length === 0) issues.push('没有可验收的结构化验收项')
  if (contract.scenes.length === 0) issues.push('没有可执行的场景清单')
  const owned = contract.scenes.flatMap(scene => scene.mustCover)
  for (const event of contract.requiredEvents) {
    const count = owned.filter(item => normalizeComparable(item) === normalizeComparable(event)).length
    if (count !== 1) issues.push(`必写节点必须且只能归属一个场景：${event}`)
  }
  const allocated = contract.scenes.reduce((sum, scene) => sum + scene.targetWords, 0)
  if (contract.scenes.length > 0 && allocated !== contract.wordTarget) {
    issues.push(`场景字数预算合计 ${allocated}，与章节目标 ${contract.wordTarget} 不一致`)
  }
  return [...new Set(issues)]
}

export function parseNovelCoverageEvidence(
  value: unknown,
  contract: ChapterExecutionContract,
  content: string
): NovelCoverageEvidence[] {
  const rawRows = Array.isArray(value) ? value : []
  const byEvent = new Map<string, NovelCoverageEvidence>()
  for (const value of rawRows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const row = value as Record<string, unknown>
    const event = closestRequiredEvent(String(row.event ?? ''), contract.requiredEvents)
    if (!event || byEvent.has(event)) continue
    const rawVerdict = String(row.verdict ?? '')
    let verdict: NovelCoverageVerdict = rawVerdict === 'covered' || rawVerdict === 'partial'
      ? rawVerdict
      : 'missing'
    const evidence = evidenceStrings(row.evidence).filter(quote => content.includes(quote))
    let reason = String(row.reason ?? '').trim()
    if (verdict !== 'missing' && (
      evidence.length === 0
    )) {
      verdict = 'missing'
      reason = [reason, '评估器给出的证据不是正文精确原句'].filter(Boolean).join('；')
    }
    byEvent.set(event, {
      requirementId: `R${String(contract.requiredEvents.indexOf(event) + 1).padStart(3, '0')}`,
      event,
      verdict,
      evidenceIds: [],
      evidence: verdict === 'missing' ? [] : evidence,
      reason
    })
  }
  return contract.requiredEvents.map(event => byEvent.get(event) ?? {
    event,
    requirementId: `R${String(contract.requiredEvents.indexOf(event) + 1).padStart(3, '0')}`,
    verdict: 'missing',
    evidenceIds: [],
    evidence: [],
    reason: '评估器未返回该节点的覆盖证据'
  })
}

/**
 * 覆盖证据协议失效属于评估器故障，不能据此改写正文。
 * 缺失事件可以判 missing，但每个合同节点都必须有且仅有一行明确判定。
 */
export function novelCoverageProtocolErrors(
  value: unknown,
  contract: ChapterExecutionContract,
  content: string
): string[] {
  if (!Array.isArray(value)) return ['coverage 不是数组']
  const errors: string[] = []
  const counts = new Map<string, number>()
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push('coverage 包含非对象项')
      continue
    }
    const row = item as Record<string, unknown>
    const rawEvent = String(row.event ?? '').trim()
    const event = contract.requiredEvents.find(
      required => normalizeComparable(required) === normalizeComparable(rawEvent)
    ) ?? null
    if (!event) {
      errors.push(`coverage 引用了未知节点：${rawEvent || '空'}`)
      continue
    }
    counts.set(event, (counts.get(event) ?? 0) + 1)
    const verdict = String(row.verdict ?? '')
    if (!['covered', 'partial', 'missing'].includes(verdict)) {
      errors.push(`${event} 的 verdict 无效`)
      continue
    }
    if (verdict !== 'missing') {
      const evidence = evidenceStrings(row.evidence).filter(quote => content.includes(quote))
      if (evidence.length === 0) {
        errors.push(`${event} 的证据不是正文精确原句`)
      }
    }
  }
  for (const event of contract.requiredEvents) {
    const count = counts.get(event) ?? 0
    if (count === 0) errors.push(`coverage 缺少节点：${event}`)
    if (count > 1) errors.push(`coverage 重复节点：${event}`)
  }
  if (value.length !== contract.requiredEvents.length) {
    errors.push(`coverage 行数应为 ${contract.requiredEvents.length}，实际为 ${value.length}`)
  }
  return [...new Set(errors)]
}

export function normalizeNovelExecutionAssessment(
  value: Record<string, unknown>,
  contract: ChapterExecutionContract,
  candidateLedger: NovelEvidenceSegment[],
  actualWordCount: number,
  previousLedger: NovelEvidenceSegment[] = []
): NovelExecutionGateResult {
  const requirements = contractRequirements(contract)
  const ledger = new Map(candidateLedger.map(segment => [segment.id, segment.text]))
  const continuityLedger = new Map([...candidateLedger, ...previousLedger].map(segment => [segment.id, segment.text]))
  const rawCoverage = Array.isArray(value.coverage) ? value.coverage : null
  if (!rawCoverage) {
    return {
      passed: false,
      blockers: ['章节执行门禁证据协议无效：coverage 不是数组'],
      warnings: [],
      coverage: [],
      forbiddenViolations: [],
      evaluatorProtocolErrors: ['coverage 不是数组']
    }
  }

  const protocolErrors: string[] = []
  const warnings: string[] = []
  const byRequirement = new Map<string, NovelCoverageEvidence>()
  for (const raw of rawCoverage) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      protocolErrors.push('coverage 包含非对象项')
      continue
    }
    const row = raw as Record<string, unknown>
    const requirementId = String(row.requirement_id ?? '').trim()
    const requirement = requirements.find(item => item.id === requirementId)
    if (!requirement) {
      protocolErrors.push(`coverage 引用了未知验收项：${requirementId || '空'}`)
      continue
    }
    if (byRequirement.has(requirementId)) {
      protocolErrors.push(`coverage 重复验收项：${requirementId}`)
      continue
    }
    const rawVerdict = String(row.verdict ?? '')
    if (!['covered', 'partial', 'missing'].includes(rawVerdict)) {
      protocolErrors.push(`${requirementId} 的 verdict 无效`)
      continue
    }
    let verdict = rawVerdict as NovelCoverageVerdict
    const requestedIds = evidenceIdsFromUnknown(
      row.evidence_ids ?? row.citations ?? row.evidenceIds ?? row.evidence
    )
    const evidenceIds = requestedIds.filter(id => ledger.has(id))
    const invalidIds = requestedIds.filter(id => !ledger.has(id))
    if (invalidIds.length > 0) warnings.push(`${requirementId} 已忽略无效证据编号：${invalidIds.join('、')}`)
    if (verdict === 'covered' && evidenceIds.length === 0) {
      protocolErrors.push(`${requirementId} 没有可定位的当前正文证据`)
    }
    if (verdict === 'partial' && evidenceIds.length === 0) {
      verdict = 'missing'
      warnings.push(`${requirementId} 的 partial 没有任何局部落地证据，已按 missing 进入正文修复`)
    }
    byRequirement.set(requirementId, {
      requirementId,
      event: requirement.description,
      verdict,
      evidenceIds: verdict === 'missing' ? [] : evidenceIds,
      evidence: verdict === 'missing' ? [] : evidenceIds.map(id => ledger.get(id) ?? '').filter(Boolean),
      reason: String(row.reason ?? '').trim()
    })
  }

  for (const requirement of requirements) {
    if (!byRequirement.has(requirement.id)) protocolErrors.push(`coverage 缺少验收项：${requirement.id}`)
  }
  if (rawCoverage.length !== requirements.length) {
    protocolErrors.push(`coverage 行数应为 ${requirements.length}，实际为 ${rawCoverage.length}`)
  }

  const coverage = requirements.map(requirement => byRequirement.get(requirement.id) ?? {
    requirementId: requirement.id,
    event: requirement.description,
    verdict: 'missing' as const,
    evidenceIds: [],
    evidence: [],
    reason: '评估器未返回该验收项'
  })

  const parseGroundedViolations = (
    raw: unknown,
    label: string,
    allowedLedger: Map<string, string>
  ): string[] => {
    const canonical = canonicalizeNovelViolationRows(raw, [...allowedLedger.keys()])
    if (!canonical.rows) {
      protocolErrors.push(`${label} ${canonical.error}`)
      return []
    }
    return canonical.rows.map(row => String(row.description ?? '')).filter(Boolean)
  }
  const forbiddenViolations = parseGroundedViolations(
    value.forbidden_violations,
    'forbidden_violations',
    ledger
  )
  const continuity = parseGroundedViolations(
    value.continuity_blockers,
    'continuity_blockers',
    continuityLedger
  )
  if (protocolErrors.length > 0) {
    return {
      passed: false,
      blockers: [`章节执行门禁证据协议无效：${[...new Set(protocolErrors)].join('；')}`],
      warnings: [...new Set(warnings)],
      coverage,
      forbiddenViolations,
      evaluatorProtocolErrors: [...new Set(protocolErrors)]
    }
  }

  const coverageBlockers = coverage
    .filter(item => item.verdict !== 'covered')
    .map(item => `${item.verdict === 'partial' ? '情节仅部分落地' : '情节缺失'}：${item.requirementId} ${item.event}${item.reason ? `（${item.reason}）` : ''}`)
  const wordBlocker = actualWordCount < contract.wordMin || actualWordCount > contract.wordMax
    ? [`章节字数 ${actualWordCount} 不在合同范围 ${contract.wordMin}-${contract.wordMax}`]
    : []
  const blockers = [
    ...coverageBlockers,
    ...forbiddenViolations.map(item => `提前越界：${item}`),
    ...continuity,
    ...wordBlocker
  ]
  if ((value.passed === true) !== (blockers.length === 0)) {
    warnings.push('已忽略与逐项明细矛盾的顶层 passed，由系统根据验收项和阻塞项归一化')
  }
  return {
    passed: blockers.length === 0,
    blockers: [...new Set(blockers)],
    warnings: [...new Set([...warnings, ...strings(value.warnings)])],
    coverage,
    forbiddenViolations
  }
}

export function isNovelExecutionEvaluatorFailure(blockers: string[]): boolean {
  return blockers.some(blocker => blocker.startsWith('章节执行门禁证据协议无效：'))
}

function evaluatorProtocolFailure(message: string): NovelExecutionGateResult {
  return {
    passed: false,
    blockers: [`章节执行门禁证据协议无效：${message}`],
    warnings: [],
    coverage: [],
    forbiddenViolations: [],
    evaluatorProtocolErrors: [message]
  }
}

function modelProtocolError(
  response: Awaited<ReturnType<typeof modelService.chat>>,
  fallback: string,
  outputLabel = '评估器输出'
): string {
  if (response.finishReason === 'length') {
    return `truncation_failure：${outputLabel}达到长度上限（finishReason=length）`
  }
  if (!response.success || !response.content?.trim()) {
    return `transport_failure：${response.error || fallback}`
  }
  return `protocol_failure：${response.error || fallback}`
}

function parseAssessmentValue(content: string): unknown {
  const json = extractJsonText(content.trim(), { allowEmptyArrays: true }) ?? content.trim()
  return parseJsonObjectWithRepairs<Record<string, unknown>>(json).value as unknown
}

function parseAssessmentObject(content: string): Record<string, unknown> {
  const value = parseAssessmentValue(content)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('评估器没有返回 JSON 对象')
  }
  return value as Record<string, unknown>
}

function previousChapterTail(workId: number, chapterId: number): string {
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const index = chapters.findIndex(chapter => chapter.id === chapterId)
  if (index <= 0) return ''
  const content = chapters[index - 1]?.content?.trim() ?? ''
  return content.slice(Math.max(0, content.length - 1800))
}

export async function assessNovelExecutionCandidate(
  workId: number,
  chapterId: number,
  content: string,
  contract: ChapterExecutionContract,
  signal?: AbortSignal,
  protocolFeedback: string[] = []
): Promise<NovelExecutionGateResult> {
  const contractIssues = validateNovelExecutionContract(contract)
  if (contractIssues.length > 0) {
    return { passed: false, blockers: contractIssues, warnings: [], coverage: [], forbiddenViolations: [] }
  }
  const previous = previousChapterTail(workId, chapterId)
  const candidateLedger = buildNovelEvidenceLedger(content, 'C')
  const previousLedger = buildNovelEvidenceLedger(previous, 'P')
  const requirements = contractRequirements(contract)
  const contentHash = novelExecutionContentHash(content)
  let checkpoint = readNovelExecutionGateCheckpoint(
    chapterId,
    contract.sourceOutlineHash,
    contentHash
  )
  const validRequirementIds = new Set(requirements.map(item => item.id))
  const cachedCoverage = (checkpoint?.coverage ?? []).filter(row =>
    validRequirementIds.has(String(row.requirement_id ?? ''))
  )
  const response = cachedCoverage.length > 0
    ? null
    : await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'novel_execution_gate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: novelExecutionGateMaxTokens(requirements.length),
      forceThinkingDisabled: true,
      responseSchema: { name: 'novel_execution_gate', schema: responseSchema(contract), strict: false },
      systemPrompt: [
        '你是长篇小说章节执行法医。只核验大纲事件覆盖、禁止越界和跨章状态，不评价文笔。',
        `coverage 必须严格返回 ${requirements.length} 行，与 R 编号验收项一一对应。`,
        'covered/partial 的 evidence_ids 只能选择候选正文中实际列出的 C 编号；不要复制原文，不要使用上一章的 P 编号。',
        'covered 必须至少有一个 C 证据；partial 必须给出已经局部落地的 C 证据；找不到任何 C 证据时必须判 missing 并返回空数组。一个验收项可引用多个不连续的 C 编号。',
        'forbidden_violations 每项必须返回 description 和当前正文 C evidence_ids；continuity_blockers 每项必须返回 description 和相关 C/P evidence_ids。没有问题就返回空数组。',
        'partial 只表示合同要求的关键动作、选择或结果确实缺少；动作链分散在多个句段、使用同义表达或与下一验收项连续衔接，不得因此判 partial。',
        '若正文通过可定位动作表现出目标结果（例如藏匿、遮盖、压住物资已经实现“保住物资”），即使没有复述合同原句也应判 covered。',
        '相邻验收项存在先后转折时分别按各自阶段判断，例如先避战保护物资、后被迫交战；不得因为后续行为不同而否定前一阶段已经完成的动作。missing 或 partial 都会阻止提交。',
        '以下情况必须 continuity_blockers：开头复述上一章；时间地点无过渡跳变；人物位置、伤势、资源或知情状态无来源变化；上一章未完成动作被跳过；结尾越过合同落点。',
        'reason 每项不超过 80 个汉字，warnings 最多 6 项；不要复述正文。',
        '不要按关键词机械匹配，要判断语义事件是否真实发生。只输出 JSON。'
      ].join('\n'),
      prompt: [
        formatChapterExecutionContract(contract),
        `【逐项验收合同】\n${requirements.map(item => `${item.id} ${item.description}`).join('\n')}`,
        previousLedger.length > 0
          ? `【上一章参考句段；仅供连续性判断，禁止作为 coverage 证据】\n${formatEvidenceLedger(previousLedger)}`
          : '【上一章】无，这是第一章',
        `【候选正文证据账本，系统计数 ${countWords(content)} 字】\n${formatEvidenceLedger(candidateLedger)}`,
        protocolFeedback.length > 0
          ? `【上次返回的协议错误；只修正这些格式问题，不改变语义判断】\n${protocolFeedback.join('\n')}`
          : ''
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  let fullProtocolError = ''
  if (!response) {
    fullProtocolError = `已恢复 ${cachedCoverage.length}/${requirements.length} 个逐项证据检查点`
  } else if (shouldSplitNovelExecutionResponse(response)) {
    fullProtocolError = modelProtocolError(response, '章节执行门禁无返回')
  } else {
    try {
      const assessment = normalizeNovelExecutionAssessment(
        parseAssessmentObject(response.content),
        contract,
        candidateLedger,
        countWords(content),
        previousLedger
      )
      if (!isNovelExecutionEvaluatorFailure(assessment.blockers)) return assessment
      fullProtocolError = assessment.evaluatorProtocolErrors?.join('；')
        || '整批评估证据协议无效'
    } catch (error) {
      fullProtocolError = error instanceof Error
        ? error.message
        : '章节执行门禁返回格式无效'
    }
  }

  // 整批响应一旦截断或协议失效，就缩成最多两个验收项一批。
  // 每批仍读取完整证据账本，但只产生很小的 JSON；最终 passed 由程序计算。
  const coverage: unknown[] = [...cachedCoverage]
  const completedRequirementIds = new Set(
    cachedCoverage.map(row => String(row.requirement_id ?? ''))
  )
  for (const plannedBatch of splitNovelExecutionRequirements(requirements)) {
    const batch = plannedBatch.filter(item => !completedRequirementIds.has(item.id))
    if (batch.length === 0) continue
    const batchResponse = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        chapterId,
        step: 'novel_execution_gate_coverage',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        temperature: 0,
        maxTokens: Math.max(1800, batch.length * 700),
        forceThinkingDisabled: true,
        responseSchema: {
          name: 'novel_execution_gate_coverage',
          schema: coverageResponseSchema(batch),
          strict: false
        },
        systemPrompt: [
          '你是章节情节点取证器，只核验本批指定验收项。',
          '每个验收项必须返回一行。covered/partial 只能引用当前正文 C 编号；missing 返回空 evidence_ids。',
          'reason 不超过 80 个汉字，不要复述正文，只输出 JSON。'
        ].join('\n'),
        prompt: [
          `【本批验收项】\n${batch.map(item => `${item.id} ${item.description}`).join('\n')}`,
          `【候选正文证据账本】\n${formatEvidenceLedger(candidateLedger)}`,
          `【降级原因】整批协议失败：${fullProtocolError}。本次只返回本批 coverage。`
        ].join('\n\n')
      }),
      { stream: false, signal }
    )
    let batchRows: unknown[] | null = null
    let batchError = ''
    try {
      if (shouldSplitNovelExecutionResponse(batchResponse)) {
        batchError = modelProtocolError(batchResponse, '模型未返回内容')
      } else {
        batchRows = normalizeNovelCoverageRows(parseAssessmentValue(batchResponse.content))
        if (!batchRows) {
          batchError = '返回值不包含 coverage 数组、根数组或单项对象'
        } else if (!novelCoverageRowsMatchRequirementIds(
          batchRows,
          batch.map(item => item.id)
        )) {
          batchError = '返回的验收项缺失、重复或编号不匹配'
          batchRows = null
        } else {
          const canonicalRows: Record<string, unknown>[] = []
          for (const requirement of batch) {
            const raw = batchRows.find(item =>
              item
              && typeof item === 'object'
              && !Array.isArray(item)
              && String((item as Record<string, unknown>).requirement_id ?? '') === requirement.id
            )
            const coerced = coerceNovelSingleCoverageRow(
              raw,
              raw ? JSON.stringify(raw) : '',
              requirement.id
            )
            const verdict = String(coerced?.verdict ?? '')
            const requestedEvidence = strings(coerced?.evidence_ids, 6)
            const validEvidence = requestedEvidence.filter(id =>
              candidateLedger.some(segment => segment.id === id)
            )
            if (
              !coerced
              || requestedEvidence.length !== validEvidence.length
              || ((verdict === 'covered' || verdict === 'partial') && validEvidence.length === 0)
            ) {
              batchError = `${requirement.id} 的判定或证据编号无效`
              batchRows = null
              break
            }
            canonicalRows.push({ ...coerced, evidence_ids: validEvidence })
          }
          if (batchRows) batchRows = canonicalRows
        }
      }
    } catch (error) {
      batchError = error instanceof Error ? error.message : '无法解析 JSON'
    }
    if (batchRows) {
      coverage.push(...batchRows)
      for (const item of batchRows) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          completedRequirementIds.add(String((item as Record<string, unknown>).requirement_id ?? ''))
        }
      }
      checkpoint = persistNovelExecutionGateCheckpoint(
        chapterId,
        content,
        contract.sourceOutlineHash,
        { coverage: coverage.filter((item): item is Record<string, unknown> => (
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
        )) }
      )
      continue
    }

    // 两项批次失败后继续缩成单项；单项第二次重试提高预算，绝不原样重放。
    for (const requirement of batch) {
      let row: unknown | null = null
      let singleError = batchError
      for (let attempt = 1; attempt <= 2 && row == null; attempt++) {
        const singleResponse = await modelService.chat(
          withGoalLoopModelOptions(workId, {
            workId,
            chapterId,
            step: 'novel_execution_gate_coverage',
            enrichWorkContext: false,
            enrichNarrativeMemory: false,
            temperature: 0,
            maxTokens: attempt === 1 ? 1800 : 800,
            forceThinkingDisabled: true,
            ...(attempt === 1
              ? {
                  responseSchema: {
                    name: 'novel_execution_gate_coverage_single_v2',
                    schema: singleCoverageResponseSchema(),
                    strict: false
                  }
                }
              : {}),
            systemPrompt: attempt === 1
              ? [
                  '你是章节单项情节点取证器，本次只核验一个验收项。',
                  '不要返回 requirement_id，验收项身份由程序绑定。',
                  '只输出对象：{"verdict":"covered|partial|missing","evidence_ids":["C001"],"reason":"不超过60字"}。',
                  'covered/partial 只能引用当前正文 C 编号；missing 必须返回空 evidence_ids。'
                ].join('\n')
              : [
                  '你是章节单项情节点取证器。不要输出 JSON、解释或思考过程。',
                  '只输出一行：covered|C001,C002|原因，或 partial|C001|原因，或 missing||原因。',
                  '证据只能使用输入中真实存在的 C 编号。'
                ].join('\n'),
            prompt: [
              `【唯一验收项】\n${requirement.id} ${requirement.description}`,
              `【候选正文证据账本】\n${formatEvidenceLedger(candidateLedger)}`,
              `【上次失败】${singleError || fullProtocolError}。本次只判断该验收项，禁止回传或改写其编号。`
            ].join('\n\n')
          }),
          { stream: false, signal }
        )
        if (shouldSplitNovelExecutionResponse(singleResponse)) {
          singleError = modelProtocolError(singleResponse, '模型未返回内容')
          continue
        }
        let parsed: unknown = null
        try {
          parsed = parseAssessmentValue(singleResponse.content)
        } catch { /* 第二协议允许非 JSON 紧凑行 */ }
        const coerced = coerceNovelSingleCoverageRow(
          parsed,
          singleResponse.content,
          requirement.id
        )
        if (!coerced) {
          singleError = '没有返回可识别的 covered/partial/missing 判定'
          continue
        }
        const verdict = String(coerced.verdict ?? '')
        const requestedEvidence = strings(coerced.evidence_ids, 6)
        const validEvidence = requestedEvidence.filter(id =>
          candidateLedger.some(segment => segment.id === id)
        )
        if (requestedEvidence.length !== validEvidence.length) {
          singleError = '返回了当前正文证据账本中不存在的 C 编号'
          continue
        }
        if ((verdict === 'covered' || verdict === 'partial') && validEvidence.length === 0) {
          singleError = `${verdict} 没有当前正文可定位证据`
          continue
        }
        row = { ...coerced, evidence_ids: validEvidence }
      }
      if (!row) {
        return evaluatorProtocolFailure(
          `单项 coverage ${requirement.id} 自适应重试失败：${singleError}`
        )
      }
      coverage.push(row)
      completedRequirementIds.add(requirement.id)
      checkpoint = persistNovelExecutionGateCheckpoint(
        chapterId,
        content,
        contract.sourceOutlineHash,
        { coverage: coverage.filter((item): item is Record<string, unknown> => (
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
        )) }
      )
    }
  }

  const candidateEvidenceIds = candidateLedger.map(item => item.id)
  const continuityEvidenceIds = [...candidateLedger, ...previousLedger].map(item => item.id)
  const cachedForbidden = checkpoint && Array.isArray(checkpoint.forbidden_violations)
    ? canonicalizeNovelViolationRows(checkpoint.forbidden_violations, candidateEvidenceIds)
    : { rows: null, error: '' }
  const cachedContinuity = checkpoint && Array.isArray(checkpoint.continuity_blockers)
    ? canonicalizeNovelViolationRows(checkpoint.continuity_blockers, continuityEvidenceIds)
    : { rows: null, error: '' }
  let forbiddenRows = cachedForbidden.rows
  let continuityRows = cachedContinuity.rows
  const hasCachedSafety = forbiddenRows != null && continuityRows != null
  const checkpointContainedSafety = Array.isArray(checkpoint?.forbidden_violations)
    || Array.isArray(checkpoint?.continuity_blockers)
  if (hasCachedSafety && checkpoint?.protocolVersion === 1) {
    checkpoint = persistNovelExecutionGateCheckpoint(
      chapterId,
      content,
      contract.sourceOutlineHash,
      {
        coverage: coverage.filter((item): item is Record<string, unknown> => (
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
        )),
        forbidden_violations: forbiddenRows ?? [],
        continuity_blockers: continuityRows ?? [],
        warnings: checkpoint.warnings ?? []
      }
    )
  }
  const safetyResponse = hasCachedSafety || checkpointContainedSafety
    ? null
    : await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'novel_execution_gate_safety',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 2600,
      forceThinkingDisabled: true,
      responseSchema: {
        name: 'novel_execution_gate_safety',
        schema: safetyResponseSchema(),
        strict: false
      },
      systemPrompt: [
        '你是章节边界取证器，只检查提前越界和跨章连续性，不评价文笔和情节点覆盖。',
        '所有问题必须引用当前正文 C 编号；连续性问题还可引用上一章 P 编号。没有问题返回空数组。',
        'description 不超过 100 个汉字，warnings 最多 6 项，不要复述正文，只输出 JSON。'
      ].join('\n'),
      prompt: [
        formatChapterExecutionContract(contract),
        previousLedger.length > 0
          ? `【上一章尾部证据账本】\n${formatEvidenceLedger(previousLedger)}`
          : '【上一章】无，这是第一章',
        `【候选正文证据账本】\n${formatEvidenceLedger(candidateLedger)}`
      ].join('\n\n')
    }),
    { stream: false, signal }
  )
  let safety: Record<string, unknown> | null = hasCachedSafety
    ? {
        forbidden_violations: forbiddenRows ?? [],
        continuity_blockers: continuityRows ?? [],
        warnings: checkpoint?.warnings ?? []
      }
    : null
  let safetyError = ''
  if (safetyResponse) {
    try {
      if (shouldSplitNovelExecutionResponse(safetyResponse)) {
        safetyError = modelProtocolError(safetyResponse, '模型未返回内容')
      } else {
        const parsed = parseAssessmentObject(safetyResponse.content)
        if (
          Array.isArray(parsed.forbidden_violations)
          && Array.isArray(parsed.continuity_blockers)
        ) {
          const forbidden = canonicalizeNovelViolationRows(
            parsed.forbidden_violations,
            candidateEvidenceIds
          )
          const continuity = canonicalizeNovelViolationRows(
            parsed.continuity_blockers,
            continuityEvidenceIds
          )
          forbiddenRows = forbidden.rows
          continuityRows = continuity.rows
          if (forbiddenRows != null && continuityRows != null) {
            safety = {
              forbidden_violations: forbiddenRows,
              continuity_blockers: continuityRows,
              warnings: strings(parsed.warnings, 6)
            }
            checkpoint = persistNovelExecutionGateCheckpoint(
              chapterId,
              content,
              contract.sourceOutlineHash,
              {
                coverage: coverage.filter((item): item is Record<string, unknown> => (
                  Boolean(item) && typeof item === 'object' && !Array.isArray(item)
                )),
                forbidden_violations: forbiddenRows,
                continuity_blockers: continuityRows,
                warnings: strings(parsed.warnings, 6)
              }
            )
          } else {
            safetyError = [
              forbidden.rows == null ? `forbidden：${forbidden.error}` : '',
              continuity.rows == null ? `continuity：${continuity.error}` : ''
            ].filter(Boolean).join('；')
          }
        } else {
          safetyError = '返回值缺少 forbidden_violations 或 continuity_blockers 数组'
        }
      }
    } catch (error) {
      safetyError = error instanceof Error ? error.message : '无法解析 JSON'
    }
  }

  if (!safety) {
    const requestViolationRows = async (
      kind: 'forbidden' | 'continuity'
    ): Promise<{ rows: unknown[] | null; error: string }> => {
      let lastError = safetyError
      for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await modelService.chat(
          withGoalLoopModelOptions(workId, {
            workId,
            chapterId,
            step: 'novel_execution_gate_safety',
            enrichWorkContext: false,
            enrichNarrativeMemory: false,
            temperature: 0,
            maxTokens: attempt === 1 ? 1800 : 3000,
            forceThinkingDisabled: true,
            responseSchema: {
              name: `novel_execution_gate_${kind}`,
              schema: violationResponseSchema(),
              strict: false
            },
            systemPrompt: kind === 'forbidden'
              ? [
                  '你是章节提前越界单项取证器，只检查正文是否发生合同禁止事件或越过结尾落点。',
                  '问题只能引用当前正文 C 编号。没有问题返回空 violations 数组。',
                  'description 不超过 80 个汉字，不要复述正文，不要输出思考过程。'
                ].join('\n')
              : [
                  '你是章节连续性单项取证器，只检查上一章到本章的状态衔接。',
                  '问题必须引用当前正文 C 编号，可同时引用上一章 P 编号。没有问题返回空 violations 数组。',
                  'description 不超过 80 个汉字，不要复述正文，不要输出思考过程。'
                ].join('\n'),
            prompt: [
              formatChapterExecutionContract(contract),
              kind === 'continuity' && previousLedger.length > 0
                ? `【上一章尾部证据账本】\n${formatEvidenceLedger(previousLedger)}`
                : '',
              `【候选正文证据账本】\n${formatEvidenceLedger(candidateLedger)}`,
              `【上次失败】${lastError || '整批安全协议无效'}。本次只返回 ${kind} violations。`
            ].filter(Boolean).join('\n\n')
          }),
          { stream: false, signal }
        )
        if (shouldSplitNovelExecutionResponse(response)) {
          lastError = modelProtocolError(response, '模型未返回内容')
          continue
        }
        try {
          const canonical = canonicalizeNovelViolationRows(
            parseAssessmentValue(response.content),
            kind === 'forbidden' ? candidateEvidenceIds : continuityEvidenceIds
          )
          if (canonical.rows) return { rows: canonical.rows, error: '' }
          lastError = canonical.error
        } catch (error) {
          lastError = error instanceof Error ? error.message : '无法解析 JSON'
        }
      }
      return { rows: null, error: lastError }
    }

    if (forbiddenRows == null) {
      const forbidden = await requestViolationRows('forbidden')
      if (!forbidden.rows) {
        return evaluatorProtocolFailure(
          `提前越界单项评估失败：${forbidden.error || cachedForbidden.error}`
        )
      }
      forbiddenRows = forbidden.rows
    }
    if (continuityRows == null) {
      const continuity = await requestViolationRows('continuity')
      if (!continuity.rows) {
        return evaluatorProtocolFailure(
          `连续性单项评估失败：${continuity.error || cachedContinuity.error}`
        )
      }
      continuityRows = continuity.rows
    }
    safety = {
      forbidden_violations: forbiddenRows,
      continuity_blockers: continuityRows,
      warnings: []
    }
    checkpoint = persistNovelExecutionGateCheckpoint(
      chapterId,
      content,
      contract.sourceOutlineHash,
      {
        coverage: coverage.filter((item): item is Record<string, unknown> => (
          Boolean(item) && typeof item === 'object' && !Array.isArray(item)
        )),
        forbidden_violations: forbiddenRows,
        continuity_blockers: continuityRows,
        warnings: []
      }
    )
  }
  return normalizeNovelExecutionAssessment({
    passed: false,
    coverage,
    forbidden_violations: safety.forbidden_violations,
    continuity_blockers: safety.continuity_blockers,
    warnings: safety.warnings
  }, contract, candidateLedger, countWords(content), previousLedger)
}

export async function repairNovelExecutionCandidate(
  workId: number,
  chapterId: number,
  content: string,
  contract: ChapterExecutionContract,
  blockers: string[],
  signal?: AbortSignal
): Promise<{ success: boolean; content: string; error?: string }> {
  const previous = previousChapterTail(workId, chapterId)
  const maxTokens = Math.max(6000, Math.min(12000, Math.ceil(countWords(content) * 2)))
  let response: Awaited<ReturnType<typeof modelService.chat>> | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        chapterId,
        step: 'novel_execution_repair',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        forceThinkingDisabled: true,
        temperature: attempt === 0 ? 0.25 : 0.1,
        maxTokens,
        systemPrompt: [
          '你是长篇小说章节执行修复编辑。只输出修复后的完整正文，不要解释、标题或 Markdown。',
          '只修复门禁指出的遗漏、概括带过、提前越界和跨章断裂；保留已通过的事件、人物表达和文风。',
          '补写遗漏时必须融入原有因果顺序，不能把情节点作为说明句硬插入；删除越界内容后要让相邻段落自然接合。',
          '开头必须写上一章末尾之后发生的新结果，禁止复述上一章。结尾必须停在合同落点。',
          `修复后的完整正文必须保持在 ${contract.wordMin}-${contract.wordMax} 字；优先替换或删除重复解释，不得靠堆叠说明句扩写。`,
          attempt > 0
            ? `上一轮输出触及长度上限。本轮必须在 ${contract.wordMax} 字以内完整收尾；只改阻塞项，每个阻塞项使用最少必要句段，删除重复动作、解释和氛围铺陈。`
            : ''
        ].filter(Boolean).join('\n'),
        prompt: [
          formatChapterExecutionContract(contract),
          previous ? `【上一章最终正文尾部】\n${previous}` : '',
          `【必须修复的问题】\n${blockers.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
          `【待修复正文】\n${content}`
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
    if (response.success && response.content?.trim() && response.finishReason !== 'length') {
      return { success: true, content: response.content.trim() }
    }
    if (response.cancelled || response.finishReason !== 'length') break
  }
  if (!response || !response.success || !response.content?.trim() || response.finishReason === 'length') {
    return {
      success: false,
      content,
      error: response
        ? modelProtocolError(response, '章节执行定向修复失败', '章节修复正文')
        : '章节执行定向修复失败'
    }
  }
  return { success: true, content: response.content.trim() }
}

export async function convergeNovelExecutionWordRange(
  workId: number,
  chapterId: number,
  content: string,
  contract: ChapterExecutionContract,
  signal?: AbortSignal,
  maxAttempts = 2
): Promise<{ success: boolean; content: string; attempts: number; error?: string }> {
  let candidate = content.trim()
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const wordCount = countWords(candidate)
    if (wordCount >= contract.wordMin && wordCount <= contract.wordMax) {
      return { success: true, content: candidate, attempts: attempt }
    }
    if (attempt === maxAttempts) {
      return {
        success: false,
        content: candidate,
        attempts: attempt,
        error: `章节字数 ${wordCount} 经过 ${attempt} 轮收敛仍不在合同范围 ${contract.wordMin}-${contract.wordMax}`
      }
    }
    const repaired = await repairNovelExecutionCandidate(
      workId,
      chapterId,
      candidate,
      contract,
      [`章节字数 ${wordCount} 不在合同范围 ${contract.wordMin}-${contract.wordMax}；只做删减或必要补足，不新增事实`],
      signal
    )
    if (!repaired.success || !repaired.content.trim()) {
      return {
        success: false,
        content: candidate,
        attempts: attempt + 1,
        error: repaired.error || '章节字数预收敛失败'
      }
    }
    candidate = repaired.content.trim()
  }
  return { success: false, content: candidate, attempts: maxAttempts, error: '章节字数预收敛失败' }
}
