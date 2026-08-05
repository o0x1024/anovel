import type { CharacterCard, CharacterRole } from '../character-cards'
import { validateCharacterCards } from '../character-cards'

const ROLES: CharacterRole[] = ['protagonist', 'supporting', 'antagonist']

export const CHARACTER_CARDS_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'object',
        required: [
          'name', 'role', 'memoryTag', 'coreConflict', 'reactions',
          'speechStyle', 'growthTriggers', 'relationBinding'
        ],
        properties: {
          name: { type: 'string' },
          role: { type: 'string', enum: ROLES },
          memoryTag: { type: 'string' },
          coreConflict: { type: 'string' },
          reactions: {
            type: 'object',
            required: ['instinct', 'rational', 'hidden'],
            properties: {
              instinct: { type: 'string' },
              rational: { type: 'string' },
              hidden: { type: 'string' }
            }
          },
          speechStyle: { type: 'string' },
          growthTriggers: { type: 'array', items: { type: 'string' } },
          relationBinding: { type: 'string' }
        }
      }
    }
  }
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} 不能为空`)
  return value.trim()
}

export function parseStrictCharacterCards(value: Record<string, unknown>): CharacterCard[] {
  if (!Array.isArray(value.cards) || value.cards.length < 3 || value.cards.length > 5) {
    throw new Error('cards 必须包含 3-5 张人设卡')
  }
  const cards = value.cards.map((item, index): CharacterCard => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`cards[${index}] 必须是对象`)
    }
    const row = item as Record<string, unknown>
    const role = row.role
    if (typeof role !== 'string' || !ROLES.includes(role as CharacterRole)) {
      throw new Error(`cards[${index}].role 非法`)
    }
    const reactions = row.reactions
    if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) {
      throw new Error(`cards[${index}].reactions 必须是对象`)
    }
    const reactionRow = reactions as Record<string, unknown>
    if (!Array.isArray(row.growthTriggers) || row.growthTriggers.length === 0) {
      throw new Error(`cards[${index}].growthTriggers 不得为空`)
    }
    const growthTriggers = row.growthTriggers.map((trigger, triggerIndex) =>
      requiredText(trigger, `cards[${index}].growthTriggers[${triggerIndex}]`)
    )
    return {
      name: requiredText(row.name, `cards[${index}].name`),
      role: role as CharacterRole,
      memoryTag: requiredText(row.memoryTag, `cards[${index}].memoryTag`),
      coreConflict: requiredText(row.coreConflict, `cards[${index}].coreConflict`),
      reactions: {
        instinct: requiredText(reactionRow.instinct, `cards[${index}].reactions.instinct`),
        rational: requiredText(reactionRow.rational, `cards[${index}].reactions.rational`),
        hidden: requiredText(reactionRow.hidden, `cards[${index}].reactions.hidden`)
      },
      speechStyle: requiredText(row.speechStyle, `cards[${index}].speechStyle`),
      growthTriggers,
      relationBinding: requiredText(row.relationBinding, `cards[${index}].relationBinding`)
    }
  })
  const validation = validateCharacterCards(cards)
  if (!validation.valid) throw new Error(validation.errors.join('；'))
  return cards
}
