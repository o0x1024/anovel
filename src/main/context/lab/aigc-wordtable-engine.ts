import type { WordTableEntryRow } from '../../../shared/aigc-wordtable-types'

/**
 * 词表替换引擎
 * 支持两种模式：
 * - word: 精确词/短语匹配，直接替换（出现 >= 2 次才替换，保留首次）
 * - regex: 用户自定义正则匹配，target 支持 $1/$2... 回填捕获组，为空表示删除
 */

function pickTarget(target: string, seed: number): string {
  if (!target.trim()) return ''
  const options = target.split('|').map(s => s.trim()).filter(Boolean)
  if (options.length === 0) return ''
  return options[seed % options.length]
}

export function applyWordTable(text: string, entries: WordTableEntryRow[]): string {
  if (!text || entries.length === 0) return text

  let result = text
  let replacementCount = 0
  const maxReplacements = 200

  const wordEntries = entries.filter(e => e.type === 'word' && e.enabled)
  const regexEntries = entries.filter(e => (e.type === 'regex' || e.type === 'pattern') && e.enabled)

  // 1. 正则替换（优先，因为匹配范围更大）
  for (const entry of regexEntries) {
    if (replacementCount >= maxReplacements) break
    let regex: RegExp
    try {
      regex = new RegExp(entry.source, 'g')
    } catch {
      continue
    }

    let seed = 0
    result = result.replace(regex, (...args) => {
      if (replacementCount >= maxReplacements) return args[0]
      replacementCount++
      const targetTemplate = pickTarget(entry.target, seed++)
      if (!targetTemplate) return ''
      return targetTemplate.replace(/\$(\d+)/g, (_, raw) => {
        const idx = Number(raw)
        return idx >= 0 && idx < args.length ? String(args[idx] ?? '') : ''
      })
    })
  }

  // 2. 词/短语替换
  for (const entry of wordEntries) {
    if (replacementCount >= maxReplacements) break
    const source = entry.source

    const occurrences: number[] = []
    let searchFrom = 0
    while (true) {
      const idx = result.indexOf(source, searchFrom)
      if (idx === -1) break
      occurrences.push(idx)
      searchFrom = idx + source.length
    }

    if (occurrences.length < 2) continue

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
