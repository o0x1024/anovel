import type { WordTableEntryRow } from '../../../shared/aigc-wordtable-types'

/**
 * 词表替换引擎
 * 支持两种模式：
 * - word: 精确词/短语匹配，直接替换
 * - pattern: 句式模板匹配，用 ... 表示中间可变内容（最短匹配）
 *
 * target 支持 | 分隔的多个候选：
 * - 词级替换：直接替换，target 为空表示删除
 * - 句式替换：支持 {1} / {2}... 占位符回填捕获内容
 */

function pickTarget(target: string, seed: number): string {
  if (!target.trim()) return ''
  const options = target.split('|').map(s => s.trim()).filter(Boolean)
  if (options.length === 0) return ''
  return options[seed % options.length]
}

function buildPatternRegex(source: string): { regex: RegExp; groupCount: number } | null {
  const parts = source.split('...')
  if (parts.length < 2) return null

  const escaped = parts.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = escaped.join('([\\s\\S]{1,40}?)')
  const groupCount = parts.length - 1
  try {
    return { regex: new RegExp(pattern, 'g'), groupCount }
  } catch {
    return null
  }
}

function renderPatternTarget(targetTemplate: string, captures: string[]): string {
  // 允许 target 使用 {1}/{2} 占位符回填匹配到的可变片段
  return targetTemplate.replace(/\{(\d+)\}/g, (_, raw) => {
    const idx = Number(raw) - 1
    return idx >= 0 && idx < captures.length ? captures[idx] : ''
  })
}

export function applyWordTable(text: string, entries: WordTableEntryRow[]): string {
  if (!text || entries.length === 0) return text

  let result = text
  let replacementCount = 0
  const maxReplacements = 200

  const wordEntries = entries.filter(e => e.type === 'word' && e.enabled)
  const patternEntries = entries.filter(e => e.type === 'pattern' && e.enabled)

  // 1. 句式模板替换（优先，因为匹配范围更大）
  for (const entry of patternEntries) {
    if (replacementCount >= maxReplacements) break
    const compiled = buildPatternRegex(entry.source)
    if (!compiled) continue

    let seed = 0
    result = result.replace(compiled.regex, (match, ...args) => {
      if (replacementCount >= maxReplacements) return match
      replacementCount++
      const captures = args.slice(0, compiled.groupCount).map(v => String(v ?? '').trim())
      const targetTemplate = pickTarget(entry.target, seed++)
      if (!targetTemplate) return match
      return renderPatternTarget(targetTemplate, captures)
    })
  }

  // 2. 词/短语替换
  for (const entry of wordEntries) {
    if (replacementCount >= maxReplacements) break
    const source = entry.source

    // 对同一词的出现次数做频率控制：出现 >= 2 次才替换（保留首次出现）
    const occurrences: number[] = []
    let searchFrom = 0
    while (true) {
      const idx = result.indexOf(source, searchFrom)
      if (idx === -1) break
      occurrences.push(idx)
      searchFrom = idx + source.length
    }

    if (occurrences.length < 2) continue

    // 从后往前替换，跳过第一次出现
    let seed = 0
    for (let i = occurrences.length - 1; i >= 1; i--) {
      if (replacementCount >= maxReplacements) break
      const idx = occurrences[i]
      const replacement = pickTarget(entry.target, seed++)
      result = result.slice(0, idx) + replacement + result.slice(idx + source.length)
      replacementCount++
    }
  }

  return result
}
