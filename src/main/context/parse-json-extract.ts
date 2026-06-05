/** 从 AI 回复中提取 JSON 对象或数组文本（支持 ```json 围栏或裸 JSON） */
export function extractJsonText(content: string): string | null {
  const fencedBlocks = collectFencedJsonBlocks(content)
  const bestFenced = pickBestJson(fencedBlocks)
  if (bestFenced) return bestFenced

  const bare = extractBareArrayJson(content)
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

function pickBestJson(candidates: string[]): string | null {
  let best: { text: string; count: number } | null = null
  for (const text of candidates) {
    const count = countJsonArrayItems(text)
    if (count <= 0) continue
    if (!best || count > best.count) {
      best = { text, count }
    }
  }
  return best?.text ?? null
}

/** 统计 JSON 中首个顶层数组的元素数量（兼容 root array 和 {key:[...]} 形式） */
function countJsonArrayItems(jsonText: string): number {
  try {
    const parsed = JSON.parse(jsonText) as unknown
    if (Array.isArray(parsed)) return parsed.length
    if (parsed && typeof parsed === 'object') {
      for (const val of Object.values(parsed as Record<string, unknown>)) {
        if (Array.isArray(val)) return val.length
      }
    }
    return 0
  } catch {
    return 0
  }
}

/** 匹配含顶层数组键的裸 JSON 对象（"key": [...]） */
function extractBareArrayJson(content: string): string | null {
  const pattern = /\{\s*"\w+"\s*:\s*\[/gi
  const candidates: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    if (match.index == null) continue
    const slice = extractBalancedJson(content.slice(match.index))
    if (slice) candidates.push(slice)
  }
  return pickBestJson(candidates)
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

/** 兼容旧逻辑：从首个 { 或 [ 截到末尾括号 */
function extractLegacyJsonTail(content: string): string | null {
  const trimmed = content.trim()
  const objStart = trimmed.indexOf('{')
  if (objStart < 0) return null
  const balanced = extractBalancedJson(trimmed.slice(objStart))
  if (balanced && countJsonArrayItems(balanced) > 0) return balanced
  return null
}
