import type { ChapterContentRegistry, EvidenceSpan } from './domain'
import { assertNarrativeKernel } from './errors'
import { sha256 } from './hash'

export function validateEvidenceSpan(
  evidence: EvidenceSpan,
  expectedChapterVersionId: string,
  contentRegistry: ChapterContentRegistry
): void {
  assertNarrativeKernel(
    evidence.chapterVersionId === expectedChapterVersionId,
    'EVIDENCE_SCOPE_MISMATCH',
    '事件证据不属于当前提交的章节版本',
    {
      expectedChapterVersionId,
      actualChapterVersionId: evidence.chapterVersionId
    }
  )

  const content = contentRegistry.getChapterContent(evidence.chapterVersionId)
  assertNarrativeKernel(
    typeof content === 'string',
    'EVIDENCE_SCOPE_MISMATCH',
    '事件证据引用了不存在的章节版本',
    { chapterVersionId: evidence.chapterVersionId }
  )
  assertNarrativeKernel(
    Number.isInteger(evidence.startOffset) &&
      Number.isInteger(evidence.endOffset) &&
      evidence.startOffset >= 0 &&
      evidence.endOffset > evidence.startOffset &&
      evidence.endOffset <= content.length,
    'EVIDENCE_RANGE_INVALID',
    '事件证据偏移超出章节正文范围',
    {
      chapterVersionId: evidence.chapterVersionId,
      startOffset: evidence.startOffset,
      endOffset: evidence.endOffset,
      contentLength: content.length
    }
  )

  const quote = content.slice(evidence.startOffset, evidence.endOffset)
  assertNarrativeKernel(
    sha256(quote) === evidence.quoteHash,
    'EVIDENCE_HASH_MISMATCH',
    '事件证据正文哈希不匹配',
    {
      chapterVersionId: evidence.chapterVersionId,
      startOffset: evidence.startOffset,
      endOffset: evidence.endOffset
    }
  )
}
