import { extractJsonText } from '../parse-json-extract'
import type {
  EmotionLedgerBeliefChange,
  EmotionLedgerRelationshipChange,
  EmotionLedgerState
} from '../../../shared/emotion-contract'

export class EmotionLedgerParseError extends Error {
  constructor(
    message: string,
    public readonly outputExcerpt: string
  ) {
    super(message)
    this.name = 'EMOTION_LEDGER_PARSE_FAILED'
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function candidateJson(content: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content)?.[1]?.trim()
  return fenced || extractJsonText(content.trim()) || content.trim()
}

function excerptAroundError(raw: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const position = /position\s+(\d+)/i.exec(message)?.[1]
  const index = position ? Number(position) : 0
  const start = Math.max(0, index - 100)
  return raw.slice(start, Math.min(raw.length, index + 140)).replace(/\s+/g, ' ').trim()
}

function normalizeBeliefs(value: unknown): EmotionLedgerBeliefChange[] {
  if (Array.isArray(value)) {
    return value.map(item => {
      const row = record(item)
      return { belief: text(row?.belief), change: text(row?.change) }
    }).filter(item => item.belief && item.change)
  }
  const row = record(value)
  return row ? Object.entries(row).map(([belief, change]) => ({ belief: belief.trim(), change: text(change) || String(change) })) : []
}

function normalizeRelationships(value: unknown): EmotionLedgerRelationshipChange[] {
  if (Array.isArray(value)) {
    return value.map(item => {
      const row = record(item)
      return { character: text(row?.character), state: text(row?.state) }
    }).filter(item => item.character && item.state)
  }
  const row = record(value)
  return row ? Object.entries(row).map(([character, state]) => ({ character: character.trim(), state: text(state) || String(state) })) : []
}

export function parseEmotionLedgerResponse(content: string): EmotionLedgerState[] {
  const raw = candidateJson(content)
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (error) {
    throw new EmotionLedgerParseError(
      `情绪账本JSON语法无效：${error instanceof Error ? error.message : String(error)}`,
      excerptAroundError(raw, error)
    )
  }
  const root = record(parsed)
  if (!root || !Array.isArray(root.states)) {
    throw new EmotionLedgerParseError('情绪账本缺少 states 数组', raw.slice(0, 240))
  }
  const states = root.states.map((item, index) => {
    const row = record(item)
    if (!row) throw new EmotionLedgerParseError(`states[${index}] 必须是对象`, JSON.stringify(item).slice(0, 240))
    const state: EmotionLedgerState = {
      character_name: text(row.character_name),
      felt_state: text(row.felt_state),
      displayed_state: text(row.displayed_state),
      unresolved_emotion: text(row.unresolved_emotion),
      protective_strategy: text(row.protective_strategy),
      behavioral_aftereffect: text(row.behavioral_aftereffect),
      belief_changes: normalizeBeliefs(row.belief_changes ?? row.beliefs),
      relationship_changes: normalizeRelationships(row.relationship_changes ?? row.relationships),
      source_event: text(row.source_event)
    }
    const missing = [
      ['character_name', state.character_name],
      ['felt_state', state.felt_state],
      ['behavioral_aftereffect', state.behavioral_aftereffect],
      ['source_event', state.source_event]
    ].filter(([, value]) => !value).map(([key]) => key)
    if (missing.length > 0) {
      throw new EmotionLedgerParseError(`states[${index}] 缺少承重字段：${missing.join('、')}`, JSON.stringify(row).slice(0, 240))
    }
    return state
  })
  if (states.length === 0) throw new EmotionLedgerParseError('情绪账本 states 不得为空', raw.slice(0, 240))
  return states
}
