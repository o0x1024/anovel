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
              maxItems: 10,
              items: { type: 'string', pattern: '^C[0-9]{3}$' }
            },
            reason: { type: 'string' }
          }
        }
      },
      forbidden_violations: { type: 'array', items: violationSchema },
      continuity_blockers: { type: 'array', items: violationSchema },
      warnings: { type: 'array', items: { type: 'string' } }
    }
  }
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
    const requestedIds = strings(row.evidence_ids, 10)
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
    if (!Array.isArray(raw)) {
      protocolErrors.push(`${label} 不是数组`)
      return []
    }
    const descriptions: string[] = []
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        protocolErrors.push(`${label} 包含无证据的非对象项`)
        continue
      }
      const row = item as Record<string, unknown>
      const description = String(row.description ?? '').trim()
      const requestedIds = strings(row.evidence_ids, 6)
      const evidenceIds = requestedIds.filter(id => allowedLedger.has(id))
      const invalidIds = requestedIds.filter(id => !allowedLedger.has(id))
      if (!description) protocolErrors.push(`${label} 存在空描述`)
      if (evidenceIds.length === 0) protocolErrors.push(`${label}「${description || '空'}」没有可定位证据`)
      if (invalidIds.length > 0) warnings.push(`${label}「${description || '空'}」已忽略无效证据编号：${invalidIds.join('、')}`)
      if (description && evidenceIds.length > 0) descriptions.push(description)
    }
    return descriptions
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
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'novel_execution_gate',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0,
      maxTokens: 2200,
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
  if (!response.success || !response.content?.trim()) {
    return {
      passed: false,
      blockers: [`章节执行门禁证据协议无效：${response.error || '章节执行门禁无返回'}`],
      warnings: [],
      coverage: [],
      forbiddenViolations: [],
      evaluatorProtocolErrors: [response.error || '章节执行门禁无返回']
    }
  }
  try {
    const json = extractJsonText(response.content.trim()) ?? response.content.trim()
    const parsed = parseJsonObjectWithRepairs<Record<string, unknown>>(json).value
    return normalizeNovelExecutionAssessment(parsed, contract, candidateLedger, countWords(content), previousLedger)
  } catch {
    return {
      passed: false,
      blockers: ['章节执行门禁证据协议无效：章节执行门禁返回格式无效'],
      warnings: [],
      coverage: [],
      forbiddenViolations: [],
      evaluatorProtocolErrors: ['章节执行门禁返回格式无效']
    }
  }
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
  const response = await modelService.chat(
    withGoalLoopModelOptions(workId, {
      workId,
      chapterId,
      step: 'novel_execution_repair',
      enrichWorkContext: false,
      enrichNarrativeMemory: false,
      temperature: 0.25,
      maxTokens: Math.max(6000, Math.min(12000, Math.ceil(countWords(content) * 2))),
      systemPrompt: [
        '你是长篇小说章节执行修复编辑。只输出修复后的完整正文，不要解释、标题或 Markdown。',
        '只修复门禁指出的遗漏、概括带过、提前越界和跨章断裂；保留已通过的事件、人物表达和文风。',
        '补写遗漏时必须融入原有因果顺序，不能把情节点作为说明句硬插入；删除越界内容后要让相邻段落自然接合。',
        '开头必须写上一章末尾之后发生的新结果，禁止复述上一章。结尾必须停在合同落点。',
        `修复后的完整正文必须保持在 ${contract.wordMin}-${contract.wordMax} 字；优先替换或删除重复解释，不得靠堆叠说明句扩写。`
      ].join('\n'),
      prompt: [
        formatChapterExecutionContract(contract),
        previous ? `【上一章最终正文尾部】\n${previous}` : '',
        `【必须修复的问题】\n${blockers.map((item, index) => `${index + 1}. ${item}`).join('\n')}`,
        `【待修复正文】\n${content}`
      ].filter(Boolean).join('\n\n')
    }),
    { stream: false, signal }
  )
  if (!response.success || !response.content?.trim()) {
    return { success: false, content, error: response.error || '章节执行定向修复失败' }
  }
  return { success: true, content: response.content.trim() }
}
