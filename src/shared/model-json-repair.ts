export interface JsonRepairResult<T> {
  value: T
  repairedText: string
  repairs: string[]
}

function stackBefore(text: string, end: number): string[] | null {
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (let index = 0; index < end; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '['
      if (stack.pop() !== expected) return null
    }
  }
  return inString ? null : stack
}

/**
 * 修复弱模型常见的 `[..., "last","next_key":...]`：数组元素已经完整，
 * 但模型漏写了数组闭合符。只有当目标属性出现时栈顶确实是数组才修改。
 */
export function repairMissingArrayClosuresBeforeProperties(
  source: string,
  propertyNames: string[]
): { text: string; repairs: string[] } {
  let text = source
  const repairs: string[] = []
  for (const property of propertyNames) {
    const marker = `"${property}"`
    let searchFrom = 0
    while (searchFrom < text.length) {
      const index = text.indexOf(marker, searchFrom)
      if (index < 0) break
      let colon = index + marker.length
      while (colon < text.length && /\s/.test(text[colon])) colon++
      if (text[colon] !== ':') {
        searchFrom = index + marker.length
        continue
      }
      const stack = stackBefore(text, index)
      if (stack?.[stack.length - 1] !== '[') {
        searchFrom = index + marker.length
        continue
      }

      let separator = index - 1
      while (separator >= 0 && /\s/.test(text[separator])) separator--
      if (text[separator] === ',') {
        text = `${text.slice(0, separator)}],${text.slice(separator + 1)}`
      } else {
        text = `${text.slice(0, index)}],${text.slice(index)}`
      }
      repairs.push(`closed_array_before:${property}`)
      searchFrom = index + marker.length + 1
    }
  }
  return { text, repairs }
}

function appendTrailingClosures(source: string): { text: string; repairs: string[] } {
  const trimmed = source.trim()
  const stack = stackBefore(trimmed, trimmed.length)
  // 结尾若是分隔符或刚打开容器，说明模型还没输出下一个值；此时闭合会把
  // “内容被截断”伪装成合法空值，不能修。
  if (!stack || stack.length === 0 || /[,:\[{]\s*$/.test(trimmed)) {
    return { text: trimmed, repairs: [] }
  }
  const suffix = [...stack]
    .reverse()
    .map(open => open === '{' ? '}' : ']')
    .join('')
  return {
    text: `${trimmed}${suffix}`,
    repairs: [`appended_trailing_closures:${suffix}`]
  }
}

/**
 * 只做结构可证明的修复；不会补写被截断的字符串或业务字段。
 * `finishReason=length` 的响应应在调用方直接拒绝，不得交给这里猜内容。
 */
export function parseJsonObjectWithRepairs<T extends Record<string, unknown>>(
  source: string,
  options: { arrayBeforeProperties?: string[]; appendTrailingClosures?: boolean } = {}
): JsonRepairResult<T> {
  const direct = source.trim()
  try {
    return { value: JSON.parse(direct) as T, repairedText: direct, repairs: [] }
  } catch { /* 进入确定性结构修复 */ }

  const arrayRepair = repairMissingArrayClosuresBeforeProperties(
    direct,
    options.arrayBeforeProperties ?? []
  )
  let repairedText = arrayRepair.text
  const repairs = [...arrayRepair.repairs]
  if (options.appendTrailingClosures !== false) {
    const trailing = appendTrailingClosures(repairedText)
    repairedText = trailing.text
    repairs.push(...trailing.repairs)
  }
  return {
    value: JSON.parse(repairedText) as T,
    repairedText,
    repairs
  }
}
