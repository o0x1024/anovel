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

export function loadCharacterCards(workId: number): CharacterCard[] {
  const row = coreSettingDAO.getByType(workId, STORAGE_TYPE)
  if (!row?.content) return []
  try {
    const parsed = JSON.parse(row.content) as CharacterCardsBundle
    return Array.isArray(parsed.cards) ? parsed.cards : []
  } catch {
    return []
  }
}

export function saveCharacterCards(workId: number, cards: CharacterCard[]): void {
  if (cards.length === 0) {
    const row = coreSettingDAO.getByType(workId, STORAGE_TYPE)
    if (row) coreSettingDAO.delete(row.id)
    return
  }
  coreSettingDAO.upsert(workId, STORAGE_TYPE, JSON.stringify({ cards }, null, 2))
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
