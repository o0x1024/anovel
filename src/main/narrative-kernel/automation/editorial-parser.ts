import type {
  ChapterCandidate,
  EditorialGateResult,
  EditorialGateType
} from '../chapter-contracts'
import { NarrativeKernelError } from '../errors'
import { sha256 } from '../hash'

type JsonObject = Record<string, unknown>

function invalid(message: string): never {
  throw new NarrativeKernelError('EDITORIAL_GATE_INCOMPLETE', message)
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('文学门输出必须是对象')
  }
  const object = value as JsonObject
  const allowed = new Set(['status', 'score', 'report', 'evidenceQuotes'])
  const unexpected = Object.keys(object).filter(key => !allowed.has(key))
  if (unexpected.length > 0) invalid(`文学门输出包含额外字段：${unexpected.join(', ')}`)
  for (const key of allowed) {
    if (!(key in object)) invalid(`文学门输出缺少字段：${key}`)
  }
  return object
}

function uniqueQuoteOffset(content: string, quote: string): number {
  const first = content.indexOf(quote)
  if (first < 0 || content.indexOf(quote, first + quote.length) >= 0) {
    throw new NarrativeKernelError(
      'EDITORIAL_EVIDENCE_AMBIGUOUS',
      first < 0 ? '文学门证据不在候选正文中' : '文学门证据在候选正文中不唯一',
      { quote }
    )
  }
  return first
}

export function parseEditorialGateOutput(input: {
  id: string
  candidate: ChapterCandidate
  gateType: EditorialGateType
  policyVersion: number
  value: unknown
}): Omit<EditorialGateResult, 'reportHash' | 'resultHash'> {
  const object = asObject(input.value)
  if (object.status !== 'passed' && object.status !== 'failed') {
    invalid('文学门 status 必须是 passed 或 failed')
  }
  if (typeof object.score !== 'number' || !Number.isFinite(object.score)) {
    invalid('文学门 score 必须是有限数字')
  }
  if (typeof object.report !== 'string' || object.report.trim().length === 0) {
    invalid('文学门 report 必须是非空字符串')
  }
  if (!Array.isArray(object.evidenceQuotes) || object.evidenceQuotes.length === 0) {
    invalid('文学门 evidenceQuotes 必须是非空数组')
  }
  const evidence = object.evidenceQuotes.map((quote, index) => {
    if (typeof quote !== 'string' || quote.length === 0) {
      invalid(`文学门 evidenceQuotes[${index}] 必须是非空字符串`)
    }
    const startOffset = uniqueQuoteOffset(input.candidate.content, quote as string)
    return {
      candidateId: input.candidate.id,
      startOffset,
      endOffset: startOffset + (quote as string).length,
      quoteHash: sha256(quote as string)
    }
  })
  return {
    id: input.id,
    candidateId: input.candidate.id,
    gateType: input.gateType,
    policyVersion: input.policyVersion,
    status: object.status,
    score: object.score,
    report: object.report,
    evidence
  }
}
