import type { StyleAnalysisResult } from './types'

export function extractStyleAnalysisFromReply(content: string): StyleAnalysisResult | null {
  const match = content.match(/```json\s*([\s\S]*?)```/i)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1]) as StyleAnalysisResult
    if (!parsed.styleName?.trim() || !parsed.promptTemplate?.trim()) return null
    return parsed
  } catch {
    return null
  }
}

export function stripJsonBlockFromDisplay(content: string): string {
  return content.replace(/```json[\s\S]*?```/gi, '').trim()
}
