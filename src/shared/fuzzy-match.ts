/**
 * Robust fuzzy text matching for AI-generated patch application.
 *
 * AI models frequently output `find` strings that don't exactly match the
 * original text — punctuation differs, whitespace varies, characters are
 * paraphrased. This module provides multi-strategy matching that handles
 * these common failure modes:
 *
 * 1. Exact match (fast path)
 * 2. Noise-stripped match (ignore punctuation/whitespace differences)
 * 3. Anchor-based fuzzy match (locate via prefix anchor, score via bigram Dice)
 * 4. Rolling-window fuzzy match (sliding bigram similarity)
 */

// ---------- types ----------

export interface StrippedText {
  text: string
  pos: number[]
}

export interface MatchSpan {
  start: number
  end: number
}

// ---------- config ----------

const NOISE = new Set(
  " \t\n\r\u3000\u200B" +
  "，。、；：\"\"''「」『』（）【】〈〉《》！？…—～·" +
  "-,.;:!'()[]{}~"
)

const FUZZY_MAX_CONTENT_LEN = 3000
const FUZZY_MAX_TARGET_LEN = 400
const FUZZY_SCORE_THRESHOLD = 0.65
const FUZZY_EARLY_EXIT_SCORE = 0.95

// ---------- noise stripping ----------

function isNoise(ch: string): boolean {
  return NOISE.has(ch)
}

export function stripWithPositions(s: string): StrippedText {
  const textParts: string[] = []
  const pos: number[] = []
  for (let i = 0; i < s.length; i++) {
    if (!isNoise(s[i])) {
      textParts.push(s[i])
      pos.push(i)
    }
  }
  return { text: textParts.join(''), pos }
}

// ---------- bigram Dice coefficient ----------

function buildBigramFreq(s: string): Map<string, number> {
  const freq = new Map<string, number>()
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s[i] + s[i + 1]
    freq.set(bg, (freq.get(bg) || 0) + 1)
  }
  return freq
}

function diceFromFreq(
  freqA: Map<string, number>,
  freqB: Map<string, number>,
  lenA: number,
  lenB: number
): number {
  if (lenA < 2 || lenB < 2) return lenA === lenB ? 1 : 0
  let shared = 0
  for (const [bg, count] of freqA) {
    shared += Math.min(count, freqB.get(bg) || 0)
  }
  const denom = (lenA - 1) + (lenB - 1)
  return denom > 0 ? (2 * shared) / denom : 0
}

function adjustBigramFreq(freq: Map<string, number>, bg: string, delta: number): void {
  const next = (freq.get(bg) || 0) + delta
  if (next <= 0) freq.delete(bg)
  else freq.set(bg, next)
}

// ---------- span mapping ----------

function spanFromStripped(sc: StrippedText, sIdx: number, sLen: number): MatchSpan {
  const start = sc.pos[sIdx]
  const endIdx = Math.min(sIdx + sLen - 1, sc.pos.length - 1)
  return { start, end: sc.pos[endIdx] + 1 }
}

// ---------- window scoring ----------

function scoreWindow(
  content: string,
  start: number,
  wLen: number,
  targetFreq: Map<string, number>,
  targetLen: number
): number {
  if (wLen < 2 || targetLen < 2) return wLen === targetLen ? 1 : 0
  const winFreq = buildBigramFreq(content.slice(start, start + wLen))
  return diceFromFreq(winFreq, targetFreq, wLen, targetLen)
}

// ---------- anchor-based fuzzy search ----------

function findAnchorFuzzySpan(sc: StrippedText, st: StrippedText): MatchSpan | null {
  const content = sc.text
  const target = st.text
  const targetFreq = buildBigramFreq(target)
  const targetLen = target.length

  const anchorLen = Math.min(12, Math.max(4, Math.floor(targetLen * 0.2)))
  const anchor = target.slice(0, anchorLen)
  const lo = Math.max(4, Math.floor(targetLen * 0.85))
  const hi = Math.min(content.length, Math.ceil(targetLen * 1.15))

  let bestScore = 0
  let bestPos = -1
  let bestWin = -1

  const tryAt = (pos: number) => {
    for (let wLen = lo; wLen <= hi; wLen++) {
      if (pos + wLen > content.length) break
      const score = scoreWindow(content, pos, wLen, targetFreq, targetLen)
      if (score > bestScore) {
        bestScore = score
        bestPos = pos
        bestWin = wLen
        if (score >= FUZZY_EARLY_EXIT_SCORE) return true
      }
    }
    return false
  }

  let idx = 0
  while (idx <= content.length - anchorLen) {
    const found = content.indexOf(anchor, idx)
    if (found === -1) break
    if (tryAt(found)) break
    idx = found + 1
  }

  if (bestScore >= FUZZY_SCORE_THRESHOLD && bestPos >= 0) {
    return spanFromStripped(sc, bestPos, bestWin)
  }
  return null
}

// ---------- rolling-window fuzzy search ----------

function findRollingFuzzySpan(sc: StrippedText, st: StrippedText): MatchSpan | null {
  const content = sc.text
  const target = st.text
  const targetFreq = buildBigramFreq(target)
  const targetLen = target.length

  const lo = Math.max(4, Math.floor(targetLen * 0.85))
  const hi = Math.min(content.length, Math.ceil(targetLen * 1.15))
  const coarseStep = targetLen > 80 ? 4 : targetLen > 40 ? 2 : 1

  let bestScore = 0
  let bestPos = -1
  let bestWin = -1

  for (let wLen = lo; wLen <= hi; wLen++) {
    if (wLen < 2 || wLen > content.length) continue

    const winFreq = buildBigramFreq(content.slice(0, wLen))
    let score = diceFromFreq(winFreq, targetFreq, wLen, targetLen)
    if (score > bestScore) {
      bestScore = score
      bestPos = 0
      bestWin = wLen
    }

    for (let i = coarseStep; i <= content.length - wLen; i += coarseStep) {
      const removeBg = content[i - 1] + content[i]
      const addBg = content[i + wLen - 1] + content[i + wLen]
      adjustBigramFreq(winFreq, removeBg, -1)
      adjustBigramFreq(winFreq, addBg, 1)

      score = diceFromFreq(winFreq, targetFreq, wLen, targetLen)
      if (score > bestScore) {
        bestScore = score
        bestPos = i
        bestWin = wLen
        if (score >= FUZZY_EARLY_EXIT_SCORE) break
      }
    }
    if (bestScore >= FUZZY_EARLY_EXIT_SCORE) break
  }

  if (bestScore < FUZZY_SCORE_THRESHOLD || bestPos < 0) return null

  const refineRadius = coarseStep * 2
  const refineLo = Math.max(0, bestPos - refineRadius)
  const refineHi = Math.min(content.length - bestWin, bestPos + refineRadius)

  for (let i = refineLo; i <= refineHi; i++) {
    const score = scoreWindow(content, i, bestWin, targetFreq, targetLen)
    if (score > bestScore) {
      bestScore = score
      bestPos = i
    }
  }

  if (bestScore >= FUZZY_SCORE_THRESHOLD) {
    return spanFromStripped(sc, bestPos, bestWin)
  }
  return null
}

// ---------- public API ----------

/**
 * Find the best-matching span of `target` within `content`.
 *
 * Strategies (in order of decreasing precision):
 * 1. Exact substring match
 * 2. Noise-stripped exact match (ignores punctuation/whitespace)
 * 3. Anchor-based fuzzy match (bigram Dice coefficient)
 * 4. Rolling-window fuzzy match (sliding bigram similarity)
 *
 * Returns `{ start, end }` indices into the original `content`, or `null`.
 */
export function fuzzyFindSpan(
  content: string,
  target: string,
  from = 0,
  cachedStripped?: StrippedText
): MatchSpan | null {
  if (!target || !content) return null

  const searchContent = from > 0 ? content.slice(from) : content
  const offset = from

  const idx = searchContent.indexOf(target)
  if (idx !== -1) return { start: offset + idx, end: offset + idx + target.length }

  const sc = cachedStripped ?? stripWithPositions(content)
  const st = stripWithPositions(target)
  if (st.text.length < 2) return null

  const sIdx = sc.text.indexOf(st.text)
  if (sIdx !== -1) return spanFromStripped(sc, sIdx, st.text.length)

  if (st.text.length < 6) return null
  if (sc.text.length > FUZZY_MAX_CONTENT_LEN || st.text.length > FUZZY_MAX_TARGET_LEN) return null

  const span = findAnchorFuzzySpan(sc, st) ?? findRollingFuzzySpan(sc, st)
  return span
}

/**
 * Replace the best-matching occurrence of `find` in `content` with `replace`.
 *
 * Returns the patched text, or `null` if no match was found.
 */
export function fuzzyReplace(content: string, find: string, replace: string): string | null {
  if (!find?.trim()) return null
  const span = fuzzyFindSpan(content, find)
  if (!span) return null
  return content.slice(0, span.start) + replace + content.slice(span.end)
}

/**
 * Find the span between two anchor strings (inclusive).
 *
 * Useful for section rewrites where `findStart` and `findEnd` delimit a range.
 */
export function fuzzyFindRangeSpan(
  content: string,
  findStart: string,
  findEnd: string
): MatchSpan | null {
  const start = fuzzyFindSpan(content, findStart)
  if (!start) return null
  const end = fuzzyFindSpan(content, findEnd, start.end)
  if (!end) return null
  if (end.end <= start.start) return null
  return { start: start.start, end: end.end }
}
