import { coreSettingDAO } from '../db'

export type CharacterRole = 'protagonist' | 'supporting' | 'antagonist'

export interface CharacterCard {
  name: string
  role: CharacterRole
  memoryTag?: string
  coreConflict?: string
  reactions?: { instinct?: string; rational?: string; hidden?: string }
  speechStyle?: string
  growthTriggers?: string[]
  relationBinding?: string
}

export interface CharacterCardsBundle {
  cards: CharacterCard[]
}

export interface CharacterCardsSanitizeResult {
  cards: CharacterCard[]
  droppedCount: number
  duplicateNames: string[]
}

export interface CharacterCardsValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export const CHARACTER_CARD_TEMPLATE: CharacterCard = {
  name: '',
  role: 'supporting',
  memoryTag: '一个独特记忆标签（刀疤/口头禅/配饰）',
  coreConflict: '价值观/行为/认知矛盾',
  reactions: {
    instinct: '本能反应（如被背叛立即拔剑）',
    rational: '理性反应（强压怒火分析利弊）',
    hidden: '隐藏反应（指尖掐入掌心）'
  },
  speechStyle: '语言习惯与身份匹配',
  growthTriggers: ['黑化/觉醒触发事件1', '触发事件2'],
  relationBinding: '利益捆绑/信息差/情感负债'
}

export const ROLE_LABELS: Record<CharacterRole, string> = {
  protagonist: '主角',
  supporting: '配角',
  antagonist: '反派'
}

const STORAGE_TYPE = 'character_cards'
const CHARACTER_CARD_REQUIRED_FIELDS = [
  { key: 'memoryTag', label: '记忆标签' },
  { key: 'coreConflict', label: '核心矛盾' },
  { key: 'relationBinding', label: '关系绑定' }
] as const

function normalizeRole(value: unknown): CharacterRole {
  if (value === 'protagonist' || value === 'supporting' || value === 'antagonist') {
    return value
  }
  return 'supporting'
}

function trimOptional(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || undefined
}

function normalizeCard(card: CharacterCard): CharacterCard | null {
  const name = (card.name ?? '').trim()
  if (!name) return null

  const reactions = {
    instinct: trimOptional(card.reactions?.instinct),
    rational: trimOptional(card.reactions?.rational),
    hidden: trimOptional(card.reactions?.hidden)
  }
  const hasReactions = !!(reactions.instinct || reactions.rational || reactions.hidden)
  const growthTriggers = (card.growthTriggers ?? [])
    .map(v => v.trim())
    .filter(Boolean)

  return {
    name,
    role: normalizeRole(card.role),
    memoryTag: trimOptional(card.memoryTag),
    coreConflict: trimOptional(card.coreConflict),
    reactions: hasReactions ? reactions : undefined,
    speechStyle: trimOptional(card.speechStyle),
    growthTriggers: growthTriggers.length ? [...new Set(growthTriggers)] : undefined,
    relationBinding: trimOptional(card.relationBinding)
  }
}

export function sanitizeCharacterCards(cards: CharacterCard[]): CharacterCardsSanitizeResult {
  const normalized: CharacterCard[] = []
  const seen = new Set<string>()
  const duplicateNames: string[] = []
  let droppedCount = 0

  for (const card of cards) {
    const next = normalizeCard(card)
    if (!next) {
      droppedCount += 1
      continue
    }
    const key = next.name.toLowerCase()
    if (seen.has(key)) {
      duplicateNames.push(next.name)
      continue
    }
    seen.add(key)
    normalized.push(next)
  }

  return { cards: normalized, droppedCount, duplicateNames }
}

export function validateCharacterCards(cards: CharacterCard[]): CharacterCardsValidationResult {
  if (cards.length === 0) return { valid: true, errors: [], warnings: [] }

  const errors: string[] = []
  const warnings: string[] = []
  const protagonistCount = cards.filter(c => c.role === 'protagonist').length
  const antagonistCount = cards.filter(c => c.role === 'antagonist').length

  if (protagonistCount === 0) {
    errors.push('至少需要 1 个主角（protagonist）卡片')
  }
  if (antagonistCount === 0) {
    warnings.push('当前无反派（antagonist）卡片，建议补充主要对手')
  }

  for (const card of cards) {
    for (const field of CHARACTER_CARD_REQUIRED_FIELDS) {
      const value = card[field.key]
      if (typeof value !== 'string' || !value.trim()) {
        errors.push(`角色「${card.name}」缺少${field.label}`)
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  }
}

export function loadCharacterCards(workId: number): CharacterCard[] {
  const row = coreSettingDAO.getByType(workId, STORAGE_TYPE)
  if (!row?.content) return []
  try {
    const parsed = JSON.parse(row.content) as CharacterCardsBundle
    if (!Array.isArray(parsed.cards)) return []
    return sanitizeCharacterCards(parsed.cards).cards
  } catch {
    return []
  }
}

export function saveCharacterCards(workId: number, cards: CharacterCard[]): void {
  const sanitized = sanitizeCharacterCards(cards).cards
  if (sanitized.length === 0) {
    const row = coreSettingDAO.getByType(workId, STORAGE_TYPE)
    if (row) coreSettingDAO.delete(row.id)
    return
  }
  coreSettingDAO.upsert(workId, STORAGE_TYPE, JSON.stringify({ cards: sanitized }, null, 2))
}

export { parseCharacterCardsFromAi } from './parse-character-cards'

/** 解析本章出场角色名列表（优先读显式标注，fallback 到大纲文本匹配） */
export function resolveChapterCharacterNames(
  workId: number,
  chapter: { characters?: string | null; outline?: string | null }
): string[] {
  if (chapter.characters?.trim()) {
    return chapter.characters.split(',').map(s => s.trim()).filter(Boolean)
  }
  const cards = loadCharacterCards(workId)
  if (cards.length === 0) return []
  const text = chapter.outline || ''
  const matched = cards.filter(c => c.name && text.includes(c.name))
  if (matched.length > 0) return matched.map(c => c.name)
  return cards.filter(c => c.role === 'protagonist').slice(0, 2).map(c => c.name)
}

/** 格式化所有角色卡片摘要（全量注入，不按出场角色过滤） */
export function formatCharacterCardsForChapter(workId: number): string {
  const cards = loadCharacterCards(workId)
  if (cards.length === 0) return ''

  const lines = cards.map(c => {
    const parts = [
      `${c.name}（${ROLE_LABELS[c.role] || c.role}）`,
      c.memoryTag ? `记忆标签：${c.memoryTag}` : '',
      c.coreConflict ? `核心矛盾：${c.coreConflict}` : '',
      c.speechStyle ? `语言：${c.speechStyle}` : '',
      c.reactions?.instinct ? `本能：${c.reactions.instinct}` : ''
    ].filter(Boolean)
    return `- ${parts.join(' | ')}`
  })

  return ['【角色人设约束 - 言行须一致，勿每段复述】', ...lines].join('\n')
}

/** formatCharacterCardsForChapter 的别名，保持向后兼容 */
export const formatAllCharacterCardsSummary = formatCharacterCardsForChapter

/** 构建本章焦点角色标注行（不用于过滤，仅提示 AI 重点刻画对象） */
export function buildFocusCharacterHint(chapterCharacterNames: string[]): string {
  if (chapterCharacterNames.length === 0) return ''
  return `【本章出场角色：${chapterCharacterNames.join('、')}】请重点刻画这些角色的言行与心理，其他角色信息作为背景参考。`
}
