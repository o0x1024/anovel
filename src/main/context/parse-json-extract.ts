/** 从 AI 回复中提取 JSON 对象或数组文本（支持 ```json 围栏或裸 JSON） */
export function extractJsonText(content: string): string | null {
  const fencedBlocks = collectFencedJsonBlocks(content)
  const bestFenced = pickBestChaptersJson(fencedBlocks)
  if (bestFenced) return bestFenced

  const bare = extractBareChaptersJson(content)
  if (bare) return bare

  return extractLegacyJsonTail(content)
}

function collectFencedJsonBlocks(content: string): string[] {
  const blocks: string[] = []
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = fenceRegex.exec(content)) !== null) {
    const text = match[1]?.trim()
    if (text) blocks.push(text)
  }
  return blocks
}

function pickBestChaptersJson(candidates: string[]): string | null {
  let best: { text: string; count: number } | null = null
  for (const text of candidates) {
    const count = countChaptersInJson(text)
    if (count <= 0) continue
    if (!best || count > best.count) {
      best = { text, count }
    }
  }
  return best?.text ?? null
}

function countChaptersInJson(jsonText: string): number {
  try {
    const parsed = JSON.parse(jsonText) as unknown
    if (Array.isArray(parsed)) return parsed.length
    const chapters = (parsed as Record<string, unknown>)?.chapters
    return Array.isArray(chapters) ? chapters.length : 0
  } catch {
    return 0
  }
}

/** 优先匹配含 chapters 键的裸 JSON 对象 */
function extractBareChaptersJson(content: string): string | null {
  const pattern = /\{\s*"chapters"\s*:\s*\[/gi
  const candidates: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    if (match.index == null) continue
    const slice = extractBalancedJson(content.slice(match.index))
    if (slice) candidates.push(slice)
  }
  return pickBestChaptersJson(candidates)
}

function extractBalancedJson(text: string): string | null {
  const start = text.search(/[\[{]/)
  if (start < 0) return null

  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 兼容旧逻辑：从首个 { 或 [ 截到末尾括号（可能误匹配，仅作最后回退） */
function extractLegacyJsonTail(content: string): string | null {
  const trimmed = content.trim()
  const objStart = trimmed.indexOf('{')
  if (objStart < 0) return null
  const balanced = extractBalancedJson(trimmed.slice(objStart))
  if (balanced && countChaptersInJson(balanced) > 0) return balanced
  return null
}
