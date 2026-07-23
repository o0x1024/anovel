export interface ExtractJsonTextOptions {
  /**
   * 评估/门禁类协议中，空数组表示“没有问题”，是合法终态。
   * 列表生成场景默认仍要求至少一个元素，避免把示例空壳当成最终结果。
   */
  allowEmptyArrays?: boolean
}

/** 从 AI 回复中提取 JSON 对象或数组文本（支持 ```json 围栏或裸 JSON） */
export function extractJsonText(
  content: string,
  options: ExtractJsonTextOptions = {}
): string | null {
  const fencedBlocks = collectFencedJsonBlocks(content)
  const bestFenced = pickBestJson(fencedBlocks, options)
  if (bestFenced) return bestFenced

  const bare = extractBareArrayJson(content, options)
  if (bare) return bare

  return extractLegacyJsonTail(content, options)
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

function pickBestJson(
  candidates: string[],
  options: ExtractJsonTextOptions
): string | null {
  let best: { text: string; count: number } | null = null
  for (const text of candidates) {
    const stats = jsonArrayStats(text)
    if (!stats || !stats.hasArray) continue
    if (!options.allowEmptyArrays && stats.count <= 0) continue
    if (!best || stats.count > best.count) {
      best = { text, count: stats.count }
    }
  }
  return best?.text ?? null
}

/** 统计 JSON 顶层数组中的最大元素数量（兼容 root array 和 {key:[...]} 形式） */
function jsonArrayStats(jsonText: string): { hasArray: boolean; count: number } | null {
  try {
    const parsed = JSON.parse(jsonText) as unknown
    if (Array.isArray(parsed)) return { hasArray: true, count: parsed.length }
    if (parsed && typeof parsed === 'object') {
      let hasArray = false
      let count = 0
      for (const val of Object.values(parsed as Record<string, unknown>)) {
        if (!Array.isArray(val)) continue
        hasArray = true
        count = Math.max(count, val.length)
      }
      return { hasArray, count }
    }
    return { hasArray: false, count: 0 }
  } catch {
    return null
  }
}

/** 匹配含顶层数组键的裸 JSON 对象（"key": [...]） */
function extractBareArrayJson(
  content: string,
  options: ExtractJsonTextOptions
): string | null {
  const pattern = /\{\s*"\w+"\s*:\s*\[/gi
  const candidates: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    if (match.index == null) continue
    const slice = extractBalancedJson(content.slice(match.index))
    if (slice) candidates.push(slice)
  }
  return pickBestJson(candidates, options)
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
function extractLegacyJsonTail(
  content: string,
  options: ExtractJsonTextOptions
): string | null {
  const trimmed = content.trim()
  const objStart = trimmed.indexOf('{')
  if (objStart < 0) return null
  const balanced = extractBalancedJson(trimmed.slice(objStart))
  if (!balanced) return null
  const stats = jsonArrayStats(balanced)
  if (
    stats?.hasArray
    && (options.allowEmptyArrays || stats.count > 0)
  ) return balanced
  return null
}
