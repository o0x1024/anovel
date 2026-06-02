import type { WorkSummaryResult } from './types'

export function extractWorkSummaryFromReply(content: string): WorkSummaryResult | null {
  const match = content.match(/```json\s*([\s\S]*?)```/i)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1]) as WorkSummaryResult
    if (!parsed.title?.trim() || !parsed.logline?.trim()) return null
    if (!Array.isArray(parsed.plotOutline)) return null
    return parsed
  } catch {
    return null
  }
}
