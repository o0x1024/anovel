export interface TextDiffSegment {
  text: string
  changed: boolean
}

export interface TextDiffView {
  original: TextDiffSegment[]
  modified: TextDiffSegment[]
}

type AlignOp =
  | { type: 'equal'; a: string; b: string }
  | { type: 'delete'; a: string }
  | { type: 'insert'; b: string }

const INLINE_DIFF_MAX = 8000

function pushSegment(segments: TextDiffSegment[], text: string, changed: boolean) {
  if (!text) return
  const last = segments[segments.length - 1]
  if (last && last.changed === changed) {
    last.text += text
    return
  }
  segments.push({ text, changed })
}

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line))
}

function alignLines(aLines: string[], bLines: string[]): AlignOp[] {
  const n = aLines.length
  const m = bLines.length
  const dp = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0))

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (aLines[i - 1] === bLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const ops: AlignOp[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      ops.push({ type: 'equal', a: aLines[i - 1], b: bLines[j - 1] })
      i -= 1
      j -= 1
      continue
    }
    if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'insert', b: bLines[j - 1] })
      j -= 1
      continue
    }
    ops.push({ type: 'delete', a: aLines[i - 1] })
    i -= 1
  }

  return ops.reverse()
}

function diffCharsInline(a: string, b: string): { original: TextDiffSegment[]; modified: TextDiffSegment[] } {
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0))

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  type CharOp = { type: 'equal' | 'delete' | 'insert'; char: string }
  const charOps: CharOp[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      charOps.push({ type: 'equal', char: a[i - 1] })
      i -= 1
      j -= 1
      continue
    }
    if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      charOps.push({ type: 'insert', char: b[j - 1] })
      j -= 1
      continue
    }
    charOps.push({ type: 'delete', char: a[i - 1] })
    i -= 1
  }
  charOps.reverse()

  const original: TextDiffSegment[] = []
  const modified: TextDiffSegment[] = []
  for (const op of charOps) {
    if (op.type === 'equal') {
      pushSegment(original, op.char, false)
      pushSegment(modified, op.char, false)
    } else if (op.type === 'delete') {
      pushSegment(original, op.char, true)
    } else {
      pushSegment(modified, op.char, true)
    }
  }
  return { original, modified }
}

function appendSegments(target: TextDiffSegment[], source: TextDiffSegment[]) {
  for (const seg of source) {
    pushSegment(target, seg.text, seg.changed)
  }
}

export function buildTextDiff(original: string, modified: string): TextDiffView {
  if (original === modified) {
    return {
      original: original ? [{ text: original, changed: false }] : [],
      modified: modified ? [{ text: modified, changed: false }] : []
    }
  }

  const originalSegments: TextDiffSegment[] = []
  const modifiedSegments: TextDiffSegment[] = []
  const ops = alignLines(splitLines(original), splitLines(modified))

  let index = 0
  while (index < ops.length) {
    const op = ops[index]
    if (op.type === 'equal') {
      pushSegment(originalSegments, op.a, false)
      pushSegment(modifiedSegments, op.b, false)
      index += 1
      continue
    }

    const deletes: string[] = []
    const inserts: string[] = []
    while (index < ops.length && ops[index].type !== 'equal') {
      const current = ops[index]
      if (current.type === 'delete') deletes.push(current.a)
      else if (current.type === 'insert') inserts.push(current.b)
      index += 1
    }

    const deleteText = deletes.join('')
    const insertText = inserts.join('')

    if (deleteText && insertText && deleteText.length + insertText.length <= INLINE_DIFF_MAX) {
      const inline = diffCharsInline(deleteText, insertText)
      appendSegments(originalSegments, inline.original)
      appendSegments(modifiedSegments, inline.modified)
    } else {
      if (deleteText) pushSegment(originalSegments, deleteText, true)
      if (insertText) pushSegment(modifiedSegments, insertText, true)
    }
  }

  return {
    original: originalSegments,
    modified: modifiedSegments
  }
}
