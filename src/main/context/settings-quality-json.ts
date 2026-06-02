/** 从 AI 回复中提取可能的 JSON 文本候选（按优先级） */
export function extractJsonCandidates(content: string): string[] {
  const candidates: string[] = []
  const trimmed = content.trim()

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const block = match[1]?.trim()
    if (block) candidates.push(block)
  }

  if (trimmed) candidates.push(trimmed)

  const braceStart = trimmed.indexOf('{')
  const braceEnd = trimmed.lastIndexOf('}')
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidates.push(trimmed.slice(braceStart, braceEnd + 1))
  }

  return [...new Set(candidates.filter(Boolean))]
}
