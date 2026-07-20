import type {
  AigcSentencePatch,
  StableRewriteBlock,
  StableSentenceUnit
} from './aigc-sentence-rewrite-types'

const SENTENCE_END = new Set(['。', '！', '？', '!', '?', '；', ';', '…'])
const CLOSING_PUNCTUATION = new Set(['”', '’', '"', "'", '）', ')', '】', ']', '》', '」', '』'])

function stableSentenceId(start: number, end: number): string {
  return `sentence:${start}:${end}`
}

export function splitStableSentences(text: string, baseOffset = 0): StableSentenceUnit[] {
  const units: StableSentenceUnit[] = []
  let start = 0
  let paragraphIndex = 0
  let sentenceIndex = 0

  const push = (end: number) => {
    if (end <= start) return
    const value = text.slice(start, end)
    if (!value.trim()) {
      const previous = units[units.length - 1]
      if (previous) {
        previous.end = baseOffset + end
        previous.id = stableSentenceId(previous.start, previous.end)
        previous.text += value
        start = end
      } else {
        return
      }
    } else {
      const absoluteStart = baseOffset + start
      const absoluteEnd = baseOffset + end
      units.push({
        id: stableSentenceId(absoluteStart, absoluteEnd),
        start: absoluteStart,
        end: absoluteEnd,
        paragraphIndex,
        sentenceIndex,
        text: value
      })
      sentenceIndex++
      start = end
    }
    const newlines = value.match(/\n/g)?.length ?? 0
    if (newlines > 0) {
      paragraphIndex += newlines
      sentenceIndex = 0
    }
  }

  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (SENTENCE_END.has(char) || char === '\n') {
      let end = index + 1
      if (char !== '\n') {
        if (char === '…' && text[end] === '…') end++
        while (end < text.length && CLOSING_PUNCTUATION.has(text[end])) end++
        while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++
      }
      push(end)
      index = end
      continue
    }
    index++
  }
  push(text.length)
  return units
}

export function preservesStableSentenceTopology(
  originalText: string,
  start: number,
  end: number,
  replacement: string
): boolean {
  if (start < 0 || end < start || end > originalText.length) return false
  const originalCount = splitStableSentences(originalText).length
  const replaced = `${originalText.slice(0, start)}${replacement}${originalText.slice(end)}`
  return splitStableSentences(replaced).length === originalCount
}

export function planStableRewriteBlocks(
  units: StableSentenceUnit[],
  maximumSentences = 4
): StableRewriteBlock[] {
  if (maximumSentences < 2) throw new Error('语义块最大句数必须至少为2')
  const raw: StableSentenceUnit[][] = []
  let current: StableSentenceUnit[] = []
  const flush = () => {
    if (current.length > 0) raw.push(current)
    current = []
  }

  units.forEach((unit, index) => {
    current.push(unit)
    const next = units[index + 1]
    const paragraphEnds = !next || next.paragraphIndex !== unit.paragraphIndex
    if (current.length >= maximumSentences || (paragraphEnds && current.length >= 2)) flush()
  })
  flush()

  for (let index = raw.length - 1; index >= 0; index--) {
    if (raw[index].length !== 1 || raw.length === 1) continue
    const previous = raw[index - 1]
    const next = raw[index + 1]
    if (previous && previous.length + 1 <= maximumSentences) {
      previous.push(...raw[index])
      raw.splice(index, 1)
    } else if (next && next.length + 1 <= maximumSentences) {
      next.unshift(...raw[index])
      raw.splice(index, 1)
    }
  }

  return raw.map(group => {
    const first = group[0]
    const last = group[group.length - 1]
    return {
      id: `block:${first.start}:${last.end}`,
      start: first.start,
      end: last.end,
      paragraphIndex: first.paragraphIndex,
      sentenceIndex: first.sentenceIndex,
      sentenceIds: group.map(unit => unit.id),
      text: group.map(unit => unit.text).join('')
    }
  })
}

/**
 * 为整篇重写规划连续场景块。块可以跨越短段落，以免短对白和人物反应被孤立保留；
 * 原始起止位置仍然作为稳定补丁边界，块内允许重新分句和调整段落。
 */
export function planSceneRewriteBlocks(
  units: StableSentenceUnit[],
  options: {
    targetCharacters?: number
    maximumCharacters?: number
    maximumSentences?: number
  } = {}
): StableRewriteBlock[] {
  const targetCharacters = options.targetCharacters ?? 240
  const maximumCharacters = options.maximumCharacters ?? 380
  const maximumSentences = options.maximumSentences ?? 6
  if (targetCharacters < 80) throw new Error('场景块目标字数不能小于80')
  if (maximumCharacters < targetCharacters) throw new Error('场景块最大字数不能小于目标字数')
  if (maximumSentences < 2) throw new Error('场景块最大句数必须至少为2')

  const groups: StableSentenceUnit[][] = []
  let current: StableSentenceUnit[] = []
  let currentCharacters = 0
  const flush = () => {
    if (current.length > 0) groups.push(current)
    current = []
    currentCharacters = 0
  }

  for (const unit of units) {
    const unitCharacters = Math.max(1, unit.text.replace(/\s+/g, '').length)
    if (
      current.length >= 2 &&
      (current.length >= maximumSentences || currentCharacters + unitCharacters > maximumCharacters)
    ) {
      flush()
    }
    current.push(unit)
    currentCharacters += unitCharacters
    if (current.length >= maximumSentences || currentCharacters >= targetCharacters) flush()
  }
  flush()

  if (groups.length > 1) {
    const last = groups[groups.length - 1]
    const previous = groups[groups.length - 2]
    const combinedCharacters = [...previous, ...last]
      .reduce((sum, unit) => sum + Math.max(1, unit.text.replace(/\s+/g, '').length), 0)
    if (last.length === 1 && previous.length + last.length <= maximumSentences && combinedCharacters <= maximumCharacters) {
      previous.push(...last)
      groups.pop()
    }
  }

  return groups.map(group => {
    const first = group[0]
    const last = group[group.length - 1]
    return {
      id: `scene:${first.start}:${last.end}`,
      start: first.start,
      end: last.end,
      paragraphIndex: first.paragraphIndex,
      sentenceIndex: first.sentenceIndex,
      sentenceIds: group.map(unit => unit.id),
      text: group.map(unit => unit.text).join('')
    }
  })
}

export function applySentencePatches(
  originalText: string,
  patches: AigcSentencePatch[],
  acceptedIds: Iterable<string>
): string {
  const accepted = new Set(acceptedIds)
  const selected = patches
    .filter(patch => accepted.has(patch.id) && patch.status === 'passed' && typeof patch.rewrittenText === 'string')
    .sort((a, b) => b.start - a.start)

  let result = originalText
  let previousStart = originalText.length + 1
  for (const patch of selected) {
    if (patch.start < 0 || patch.end < patch.start || patch.end > originalText.length) {
      throw new Error(`句子补丁 ${patch.id} 的文本范围无效`)
    }
    if (patch.end > previousStart) throw new Error(`句子补丁 ${patch.id} 与其他补丁重叠`)
    if (originalText.slice(patch.start, patch.end) !== patch.originalText) {
      throw new Error(`句子补丁 ${patch.id} 已过期，原文位置不再匹配`)
    }
    result = `${result.slice(0, patch.start)}${patch.rewrittenText}${result.slice(patch.end)}`
    previousStart = patch.start
  }
  return result
}
