import { createHash } from 'node:crypto'

export interface CachedQualityAssessment {
  contentHash: string
  scoreTotal: number
  hardFail: boolean
  report: string
  checkedAt: string
  acceptedDeferred?: boolean
}

export function chapterContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function parseCachedQualityAssessment(
  raw: string | null | undefined,
  content: string
): CachedQualityAssessment | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<CachedQualityAssessment>
    if (
      parsed.contentHash !== chapterContentHash(content)
      || typeof parsed.scoreTotal !== 'number'
      || typeof parsed.hardFail !== 'boolean'
      || typeof parsed.report !== 'string'
    ) return null
    return parsed as CachedQualityAssessment
  } catch {
    return null
  }
}

export function serializeQualityAssessment(input: {
  content: string
  scoreTotal: number
  hardFail: boolean
  report?: string
  acceptedDeferred?: boolean
}): string {
  return JSON.stringify({
    contentHash: chapterContentHash(input.content),
    scoreTotal: input.scoreTotal,
    hardFail: input.hardFail,
    report: input.report ?? '',
    checkedAt: new Date().toISOString(),
    acceptedDeferred: input.acceptedDeferred || undefined
  } satisfies CachedQualityAssessment)
}
