import type { IncubatorSlotKey } from '../../../shared/incubator-slots'
import { isIncubatorSlotKey } from '../../../shared/incubator-slots'
import { incubatorDraftSlotDAO } from '../../db/dao/incubator'
import { updateDraftSlotContent } from './update-slot'

export interface GateReplacementInput {
  slotKey: IncubatorSlotKey
  replacements: { original: string; replacement: string }[]
}

// ---------- fuzzy-match helpers ----------

const NOISE = new Set(
  " \t\n\r\u3000\u200B" +
  "，。、；：\"\"''「」『』（）【】〈〉《》！？…—～·" +
  "-,.;:!'()[]{}~"
)

/** Level 3 仅对较短文本启用，避免主进程长时间阻塞导致界面卡死 */
const FUZZY_MAX_CONTENT_LEN = 3000
const FUZZY_MAX_TARGET_LEN = 400
const FUZZY_SCORE_THRESHOLD = 0.65
const FUZZY_EARLY_EXIT_SCORE = 0.95

interface StrippedText {
  text: string
  pos: number[]
}

function isNoise(ch: string): boolean {
  return NOISE.has(ch)
}

function stripWithPositions(s: string): StrippedText {
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

function spanFromStripped(sc: StrippedText, sIdx: number, sLen: number): { start: number; end: number } {
  const start = sc.pos[sIdx]
  const endIdx = Math.min(sIdx + sLen - 1, sc.pos.length - 1)
  return { start, end: sc.pos[endIdx] + 1 }
}

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

/** 用前缀锚点快速定位候选位置，再局部比对 */
function findAnchorFuzzySpan(sc: StrippedText, st: StrippedText): { start: number; end: number } | null {
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

/**
 * 粗搜 + 局部精搜；使用滚动 bigram 计数，避免 O(n²) 全窗口切片。
 */
function findRollingFuzzySpan(sc: StrippedText, st: StrippedText): { start: number; end: number } | null {
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

  // 在粗搜最佳点附近精搜
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

function findMatchSpan(
  content: string,
  target: string,
  cachedStripped?: StrippedText
): { start: number; end: number } | null {
  if (!target || !content) return null

  const idx = content.indexOf(target)
  if (idx !== -1) return { start: idx, end: idx + target.length }

  const sc = cachedStripped ?? stripWithPositions(content)
  const st = stripWithPositions(target)
  if (st.text.length < 2) return null

  const sIdx = sc.text.indexOf(st.text)
  if (sIdx !== -1) return spanFromStripped(sc, sIdx, st.text.length)

  if (st.text.length < 6) return null
  if (sc.text.length > FUZZY_MAX_CONTENT_LEN || st.text.length > FUZZY_MAX_TARGET_LEN) return null

  return findAnchorFuzzySpan(sc, st) ?? findRollingFuzzySpan(sc, st)
}

// ---------- public API ----------

export function applyGateReplacements(
  workId: number,
  items: GateReplacementInput[]
): { applied: number; failed: number; slotKeys: IncubatorSlotKey[] } {
  const slotKeys: IncubatorSlotKey[] = []
  let applied = 0
  let failed = 0

  const activeSlots = incubatorDraftSlotDAO.listActiveByWork(workId)

  for (const item of items) {
    if (!isIncubatorSlotKey(item.slotKey) || !item.replacements?.length) continue

    const slotRow = activeSlots.find(s => s.slot_key === item.slotKey)
    let content = slotRow?.content ?? ''
    let strippedCache = stripWithPositions(content)

    let slotModified = false
    for (const { original, replacement } of item.replacements) {
      if (!original) {
        failed++
        continue
      }
      const span = findMatchSpan(content, original, strippedCache)
      if (span) {
        content = content.slice(0, span.start) + replacement + content.slice(span.end)
        strippedCache = stripWithPositions(content)
        applied++
        slotModified = true
      } else {
        failed++
      }
    }

    if (slotModified) {
      updateDraftSlotContent(workId, item.slotKey, content)
      if (!slotKeys.includes(item.slotKey)) slotKeys.push(item.slotKey)
    }
  }

  return { applied, failed, slotKeys }
}
