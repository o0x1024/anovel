import { createHash } from 'node:crypto'
import { modelService } from '../../model'
import { volumeChapterDAO } from '../../db'
import { countWords } from '../../../shared/body-word-target'
import { isModelCapabilityUnsupported } from '../../../shared/model-capability-error'
import { classifyWorkflowError } from '../../workflow/workflow-errors'
import { requestStructuredModelOutput } from './structured-model-output'
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

function responseSchema(): Record<string, unknown> {
  const violationSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'evidence_ids'],
    properties: {
      description: { type: 'string' },
      evidence_ids: {
        type: 'array',
        minItems: 1,
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
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['requirement_id', 'verdict', 'evidence_ids', 'reason'],
          properties: {
            requirement_id: { type: 'string' },
            verdict: { type: 'string', enum: ['covered', 'partial', 'missing'] },
            evidence_ids: {
              type: 'array',
              minItems: 0,
              items: { type: 'string', pattern: '^C[0-9]{3}$' }
            },
            reason: { type: 'string' }
          }
        }
      },
      forbidden_violations: { type: 'array', items: violationSchema },
      continuity_blockers: { type: 'array', items: violationSchema },
      warnings: {
        type: 'array',
        items: { type: 'string' }
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
  const wordBlocker = actualWordCount < contract.wordMin
    || actualWordCount > contract.wordMax
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

class NovelExecutionProtocolValidationError extends Error {
  readonly code = 'EVALUATOR_PROTOCOL'

  constructor(public readonly issues: string[]) {
    super(issues.join('；') || '章节执行门禁证据协议无效')
    this.name = 'NovelExecutionProtocolValidationError'
  }
}

export function novelExecutionModelProtocolError(
  response: Awaited<ReturnType<typeof modelService.chat>>,
  fallback: string,
  outputLabel = '评估器输出'
): string {
  if (isModelCapabilityUnsupported(response.error ?? '')) {
    return `capability_failure：${response.error}`
  }
  if (response.finishReason === 'length') {
    return `truncation_failure：${outputLabel}达到长度上限（finishReason=length）`
  }
  if (!response.success || !response.content?.trim()) {
    return `transport_failure：${response.error || fallback}`
  }
  return `protocol_failure：${response.error || fallback}`
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
  const checkpoint = readNovelExecutionGateCheckpoint(
    chapterId,
    contract.sourceOutlineHash,
    contentHash
  )
  const validRequirementIds = new Set(requirements.map(item => item.id))
  const cachedCoverage = (checkpoint?.coverage ?? []).filter(row =>
    validRequirementIds.has(String(row.requirement_id ?? ''))
  )
  if (cachedCoverage.length === requirements.length && checkpoint) {
    const restored = normalizeNovelExecutionAssessment(
      {
        passed: false,
        coverage: cachedCoverage,
        forbidden_violations: checkpoint.forbidden_violations ?? [],
        continuity_blockers: checkpoint.continuity_blockers ?? [],
        warnings: checkpoint.warnings ?? []
      },
      contract,
      candidateLedger,
      countWords(content),
      previousLedger
    )
    if (!isNovelExecutionEvaluatorFailure(restored.blockers)) return restored
  }

  const schema = responseSchema()
  let lastProtocolError = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await requestStructuredModelOutput<NovelExecutionGateResult>({
        workId,
        label: '章节硬合同只读取证',
        attempts: 1,
        signal,
        schema,
        request: async () => modelService.chat(
          withGoalLoopModelOptions(workId, {
            workId,
            chapterId,
            step: 'novel_execution_gate',
            enrichWorkContext: false,
            enrichNarrativeMemory: false,
            temperature: 0,
            maxTokens: novelExecutionGateMaxTokens(requirements.length),
            forceThinkingDisabled: true,
            responseSchema: { name: 'novel_execution_gate', schema, strict: false },
            structuredOutputMode: 'prompt_json',
            systemPrompt: [
              '你是长篇小说章节执行法医。只核验大纲事件覆盖、禁止越界和跨章状态，不评价文笔。',
              `coverage 必须严格返回 ${requirements.length} 行，与 R 编号验收项一一对应。`,
              'covered/partial 的 evidence_ids 只能选择候选正文中实际列出的 C 编号；不要复制原文，不要使用上一章的 P 编号。',
              'covered 必须至少有一个 C 证据；partial 必须给出已经局部落地的 C 证据；找不到任何 C 证据时必须判 missing 并返回空数组。',
              'forbidden_violations 每项必须返回 description 和当前正文 C evidence_ids；continuity_blockers 每项必须返回 description 和相关 C/P evidence_ids。没有问题就返回空数组。',
              'missing 或 partial 都会阻止提交；不得为了通过而虚构证据编号。',
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
              [...protocolFeedback, lastProtocolError].filter(Boolean).length > 0
                ? `【上次返回的协议错误；只修正这些引用和格式问题，不改变语义判断】\n${[
                    ...protocolFeedback,
                    lastProtocolError
                  ].filter(Boolean).join('\n')}`
                : ''
            ].filter(Boolean).join('\n\n')
          }),
          { stream: false, signal }
        ),
        validate: value => {
          const assessment = normalizeNovelExecutionAssessment(
            value,
            contract,
            candidateLedger,
            countWords(content),
            previousLedger
          )
          if (isNovelExecutionEvaluatorFailure(assessment.blockers)) {
            throw new NovelExecutionProtocolValidationError(
              assessment.evaluatorProtocolErrors ?? ['整批评估证据协议无效']
            )
          }
          return assessment
        }
      })
    } catch (error) {
      const classified = classifyWorkflowError(error)
      if (
        classified.errorClass === 'cancelled'
        || classified.errorClass === 'transient_transport'
        || classified.errorClass === 'provider_rate_limit'
        || classified.errorClass === 'user_action_required'
      ) {
        throw error
      }
      lastProtocolError = classified.message
    }
  }

  return evaluatorProtocolFailure(
    `章节硬合同连续 2 次只读取证仍未形成完整 coverage/safety：${lastProtocolError}`
  )

}

export async function repairNovelExecutionCandidate(
  workId: number,
  chapterId: number,
  content: string,
  contract: ChapterExecutionContract,
  blockers: string[],
  signal?: AbortSignal,
  outputWordMax?: number
): Promise<{ success: boolean; content: string; error?: string }> {
  const previous = previousChapterTail(workId, chapterId)
  const maxTokens = outputWordMax == null
    ? Math.max(6000, Math.min(12000, Math.ceil(countWords(content) * 2)))
    : Math.max(2200, Math.ceil(outputWordMax * 1.15))
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
          outputWordMax == null
            ? ''
            : `这是长度收敛事务。输出不得超过 ${outputWordMax} 字；必须主动删去重复解释、同义心理活动、重复动作与不推进的环境描写，禁止复述被删除内容。`,
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
        ? novelExecutionModelProtocolError(response, '章节执行定向修复失败', '章节修复正文')
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
  maxAttempts = 4
): Promise<{ success: boolean; content: string; attempts: number; error?: string }> {
  const softMargin = Math.max(50, Math.round(contract.wordTarget * 0.02))

  const withinSoftBounds = (wordCount: number): boolean =>
    wordCount >= contract.wordMin - softMargin && wordCount <= contract.wordMax + softMargin

  const trimToWordMax = (text: string): string => {
    let candidate = text.trim()
    for (let guard = 0; guard < 80 && countWords(candidate) > contract.wordMax; guard++) {
      const clipped = candidate
        .replace(/(?:\n+|[。！？!?；;]+)[^。！？!?\n]*$/u, '')
        .trim()
      if (!clipped || clipped === candidate) {
        const overflow = countWords(candidate) - contract.wordMax
        candidate = candidate.slice(0, Math.max(0, candidate.length - overflow - 8)).trim()
        break
      }
      candidate = clipped
    }
    return candidate
  }

  let candidate = content.trim()
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const wordCount = countWords(candidate)
    if (wordCount >= contract.wordMin && wordCount <= contract.wordMax) {
      return { success: true, content: candidate, attempts: attempt }
    }
    if (attempt === maxAttempts) {
      if (withinSoftBounds(wordCount)) {
        return { success: true, content: candidate, attempts: attempt }
      }
      if (wordCount > contract.wordMax) {
        const trimmed = trimToWordMax(candidate)
        const trimmedCount = countWords(trimmed)
        if (
          trimmed
          && (trimmedCount <= contract.wordMax || withinSoftBounds(trimmedCount))
          && trimmedCount >= Math.max(1, contract.wordMin - softMargin)
        ) {
          return { success: true, content: trimmed, attempts: attempt }
        }
      }
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
      [
        wordCount > contract.wordMax
          ? `当前正文 ${wordCount} 字，必须压缩到 ${contract.wordTarget}-${contract.wordMax} 字，至少删除 ${wordCount - contract.wordMax} 个非推进字；不新增事实`
          : `当前正文 ${wordCount} 字，必须补足到 ${contract.wordMin}-${contract.wordTarget} 字；只补必要行动、因果和场景反馈`
      ],
      signal,
      wordCount > contract.wordMax ? contract.wordMax : undefined
    )
    if (!repaired.success || !repaired.content.trim()) {
      if (withinSoftBounds(wordCount)) {
        return { success: true, content: candidate, attempts: attempt + 1 }
      }
      if (wordCount > contract.wordMax) {
        const trimmed = trimToWordMax(candidate)
        const trimmedCount = countWords(trimmed)
        if (trimmed && withinSoftBounds(trimmedCount)) {
          return { success: true, content: trimmed, attempts: attempt + 1 }
        }
      }
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
