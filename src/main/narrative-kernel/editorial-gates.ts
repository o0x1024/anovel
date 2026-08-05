import {
  REQUIRED_EDITORIAL_GATES,
  type ChapterCandidate,
  type EditorialGateResult
} from './chapter-contracts'
import type { ChapterContentRegistry } from './domain'
import { assertNarrativeKernel } from './errors'
import { validateEvidenceSpan } from './evidence'
import { canonicalHash } from './hash'

class EditorialCandidateRegistry implements ChapterContentRegistry {
  constructor(private readonly candidate: ChapterCandidate) {}

  getChapterContent(chapterVersionId: string): string | undefined {
    return chapterVersionId === this.candidate.id ? this.candidate.content : undefined
  }
}

export function validateEditorialGateResult(
  candidate: ChapterCandidate,
  result: EditorialGateResult
): void {
  assertNarrativeKernel(
    result.candidateId === candidate.id,
    'EDITORIAL_GATE_INCOMPLETE',
    '文学门结果不属于当前候选正文',
    { candidateId: candidate.id, resultCandidateId: result.candidateId }
  )
  const { resultHash: _resultHash, ...payload } = result
  assertNarrativeKernel(
    canonicalHash(payload) === result.resultHash,
    'PIPELINE_ARTIFACT_HASH_MISMATCH',
    '文学门结果哈希无效',
    { resultId: result.id, gateType: result.gateType }
  )
  const registry = new EditorialCandidateRegistry(candidate)
  for (const evidence of result.evidence) {
    assertNarrativeKernel(
      evidence.candidateId === candidate.id,
      'EVIDENCE_SCOPE_MISMATCH',
      '文学门证据不属于当前候选正文',
      { resultId: result.id, candidateId: candidate.id }
    )
    validateEvidenceSpan(
      {
        chapterVersionId: candidate.id,
        startOffset: evidence.startOffset,
        endOffset: evidence.endOffset,
        quoteHash: evidence.quoteHash
      },
      candidate.id,
      registry
    )
  }
}

export function assertEditorialGatesPassed(
  candidate: ChapterCandidate,
  results: EditorialGateResult[],
  policyVersion: number
): void {
  const relevant = results.filter(result =>
    result.candidateId === candidate.id && result.policyVersion === policyVersion
  )
  relevant.forEach(result => validateEditorialGateResult(candidate, result))
  for (const gateType of REQUIRED_EDITORIAL_GATES) {
    const matches = relevant.filter(result => result.gateType === gateType)
    assertNarrativeKernel(
      matches.length === 1,
      'EDITORIAL_GATE_INCOMPLETE',
      '候选正文缺少唯一、明确的文学门结果',
      {
        candidateId: candidate.id,
        gateType,
        policyVersion,
        resultCount: matches.length
      }
    )
    assertNarrativeKernel(
      matches[0].status === 'passed',
      'EDITORIAL_GATE_FAILED',
      '候选正文存在未通过的文学门',
      {
        candidateId: candidate.id,
        gateType,
        policyVersion,
        report: matches[0].report
      }
    )
  }
}
