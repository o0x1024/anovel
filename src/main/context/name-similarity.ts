/**
 * 中文名称近义/谐音检测（轻量启发式，无外部拼音库）
 */

import type { NameSimilarityKind, NameSimilarityMatch } from '../../shared/name-registry-types'

export type { NameSimilarityKind, NameSimilarityMatch }

/** 常见同音/近音字分组（每组内字符视为同音候选） */
const HOMOPHONE_GROUPS: readonly string[][] = [
  ['明', '铭', '鸣', '冥', '茗', '溟'],
  ['峰', '锋', '枫', '风', '丰'],
  ['琳', '林', '霖', '临', '淋'],
  ['瑶', '遥', '尧', '姚', '窑'],
  ['轩', '萱', '暄', '宣', '璇'],
  ['涵', '寒', '韩', '晗', '瀚'],
  ['悦', '越', '跃', '岳', '粤'],
  ['晨', '辰', '尘', '臣', '谌'],
  ['逸', '意', '毅', '艺', '翼'],
  ['泽', '择', '则', '责', '赜'],
  ['清', '青', '轻', '倾', '卿'],
  ['云', '芸', '筠', '匀', '昀'],
  ['天', '添', '田', '甜', '恬'],
  ['龙', '隆', '笼', '珑', '胧'],
  ['雪', '血', '学', '薛', '鳕'],
  ['剑', '建', '健', '鉴', '渐'],
  ['心', '欣', '新', '辛', '芯'],
  ['安', '岸', '案', '暗', '氨'],
  ['宁', '凝', '柠', '狞', '甯'],
  ['华', '花', '化', '桦', '骅']
]

const CHAR_TO_GROUP = new Map<string, number>()
for (let i = 0; i < HOMOPHONE_GROUPS.length; i++) {
  for (const ch of HOMOPHONE_GROUPS[i]) {
    CHAR_TO_GROUP.set(ch, i)
  }
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, '')
}

/** 将名称转为同音签名（未分组字符保留原字） */
export function toHomophoneSignature(name: string): string {
  const n = normalizeName(name)
  let sig = ''
  for (const ch of n) {
    const group = CHAR_TO_GROUP.get(ch)
    sig += group != null ? `@${group}` : ch
  }
  return sig
}

function isHomophone(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (na.length !== nb.length || na.length < 2) return false
  if (na === nb) return false
  return toHomophoneSignature(na) === toHomophoneSignature(nb)
}

function editDistanceOne(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (na === nb) return false
  if (Math.abs(na.length - nb.length) > 1) return false

  if (na.length === nb.length) {
    let diff = 0
    for (let i = 0; i < na.length; i++) {
      if (na[i] !== nb[i]) diff++
      if (diff > 1) return false
    }
    return diff === 1
  }

  const [short, long] = na.length < nb.length ? [na, nb] : [nb, na]
  let i = 0
  let j = 0
  let edits = 0
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++
      j++
    } else {
      edits++
      if (edits > 1) return false
      j++
    }
  }
  return edits + (long.length - j) <= 1
}

function sharesStrongPrefix(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (na === nb || na.length < 2 || nb.length < 2) return false
  const prefixLen = Math.min(2, na.length, nb.length)
  return na.slice(0, prefixLen) === nb.slice(0, prefixLen) && na.length >= 2 && nb.length >= 2
}

function isSubstringCollision(a: string, b: string): boolean {
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (na === nb || na.length < 2 || nb.length < 2) return false
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na]
  return long.includes(short) && short.length >= 2
}

/** 检测 candidate 与 existing 之间的相似关系 */
export function compareNameSimilarity(candidate: string, existing: string): NameSimilarityMatch | null {
  const c = normalizeName(candidate)
  const e = normalizeName(existing)
  if (!c || !e) return null
  if (c.toLowerCase() === e.toLowerCase()) return null

  if (isHomophone(c, e)) {
    return { name: existing, kind: 'homophone', message: `与「${existing}」谐音相近` }
  }
  if (editDistanceOne(c, e)) {
    return { name: existing, kind: 'near', message: `与「${existing}」仅差一字` }
  }
  if (sharesStrongPrefix(c, e) && c.length >= 2 && e.length >= 2) {
    return { name: existing, kind: 'prefix', message: `与「${existing}」前缀相同，易混淆` }
  }
  if (isSubstringCollision(c, e)) {
    return { name: existing, kind: 'contains', message: `与「${existing}」存在包含关系` }
  }
  return null
}

/** 在已有名称列表中查找所有相似项 */
export function findSimilarNames(candidate: string, existingNames: string[]): NameSimilarityMatch[] {
  const seen = new Set<string>()
  const matches: NameSimilarityMatch[] = []
  for (const existing of existingNames) {
    const key = existing.toLowerCase()
    if (seen.has(key)) continue
    const match = compareNameSimilarity(candidate, existing)
    if (match) {
      seen.add(key)
      matches.push(match)
    }
  }
  return matches
}
