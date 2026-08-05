import { extractJsonText } from '../parse-json-extract'
import type {
  EmotionLedgerBeliefChange,
  EmotionLedgerRelationshipChange,
  EmotionLedgerState
} from '../../../shared/emotion-contract'
import {
  isModelCapabilityUnsupported,
  MODEL_CAPABILITY_UNSUPPORTED
} from '../../../shared/model-capability-error'

export type EmotionLedgerFailureCode =
  | 'EMOTION_LEDGER_TRUNCATED'
  | 'EMOTION_LEDGER_PROTOCOL'
  | 'EMOTION_LEDGER_TRANSPORT'
  | 'MODEL_CAPABILITY_UNSUPPORTED'

export class EmotionLedgerPipelineError extends Error {
  constructor(
    public readonly code: EmotionLedgerFailureCode,
    message: string,
    public readonly outputExcerpt: string
  ) {
    super(message)
    this.name = code
  }
}

export class EmotionLedgerParseError extends EmotionLedgerPipelineError {
  constructor(
    message: string,
    outputExcerpt: string,
    code: Exclude<
      EmotionLedgerFailureCode,
      'EMOTION_LEDGER_TRANSPORT' | 'MODEL_CAPABILITY_UNSUPPORTED'
    > = 'EMOTION_LEDGER_PROTOCOL'
  ) {
    super(code, message, outputExcerpt)
  }
}

export function classifyEmotionLedgerFailure(
  message: string,
  finishReason?: string
): EmotionLedgerFailureCode {
  if (isModelCapabilityUnsupported(message)) return MODEL_CAPABILITY_UNSUPPORTED
  if (
    finishReason === 'length'
    || /Unexpected end of JSON|Unterminated string|finishReason=length|截断/i.test(message)
  ) return 'EMOTION_LEDGER_TRUNCATED'
  if (/timeout|timed out|ECONNRESET|ECONNABORTED|network|网络/i.test(message)) {
    return 'EMOTION_LEDGER_TRANSPORT'
  }
  return 'EMOTION_LEDGER_PROTOCOL'
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
    const message = error instanceof Error ? error.message : String(error)
    throw new EmotionLedgerParseError(
      `情绪账本JSON语法无效：${message}`,
      excerptAroundError(raw, error),
      classifyEmotionLedgerFailure(message) === 'EMOTION_LEDGER_TRUNCATED'
        ? 'EMOTION_LEDGER_TRUNCATED'
        : 'EMOTION_LEDGER_PROTOCOL'
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
  if (states.length > 2) {
    throw new EmotionLedgerParseError(`情绪账本单批最多 2 个角色，实际 ${states.length} 个`, raw.slice(0, 240))
  }
  for (const [index, state] of states.entries()) {
    const textLimits: Array<[keyof EmotionLedgerState, number]> = [
      ['character_name', 40],
      ['felt_state', 160],
      ['displayed_state', 160],
      ['unresolved_emotion', 160],
      ['protective_strategy', 160],
      ['behavioral_aftereffect', 180],
      ['source_event', 180]
    ]
    for (const [key, limit] of textLimits) {
      const value = state[key]
      if (typeof value === 'string' && value.length > limit) {
        throw new EmotionLedgerParseError(
          `states[${index}].${key} 超过 ${limit} 字`,
          value.slice(0, 240)
        )
      }
    }
    if (state.belief_changes.length > 3) {
      throw new EmotionLedgerParseError(`states[${index}].belief_changes 最多 3 项`, JSON.stringify(state.belief_changes).slice(0, 240))
    }
    if (state.relationship_changes.length > 3) {
      throw new EmotionLedgerParseError(`states[${index}].relationship_changes 最多 3 项`, JSON.stringify(state.relationship_changes).slice(0, 240))
    }
    for (const [beliefIndex, change] of state.belief_changes.entries()) {
      if (change.belief.length > 100 || change.change.length > 160) {
        throw new EmotionLedgerParseError(
          `states[${index}].belief_changes[${beliefIndex}] 字段过长`,
          JSON.stringify(change).slice(0, 240)
        )
      }
    }
    for (const [relationshipIndex, change] of state.relationship_changes.entries()) {
      if (change.character.length > 40 || change.state.length > 160) {
        throw new EmotionLedgerParseError(
          `states[${index}].relationship_changes[${relationshipIndex}] 字段过长`,
          JSON.stringify(change).slice(0, 240)
        )
      }
    }
  }
  return states
}

export function validateEmotionLedgerBatch(
  states: EmotionLedgerState[],
  expectedCharacters: string[]
): EmotionalStateBatchValidation {
  const actual = states.map(state => state.character_name)
  const duplicates = actual.filter((name, index) => actual.indexOf(name) !== index)
  const missing = expectedCharacters.filter(name => !actual.includes(name))
  const unexpected = actual.filter(name => !expectedCharacters.includes(name))
  return {
    valid: duplicates.length === 0 && missing.length === 0 && unexpected.length === 0,
    duplicates: [...new Set(duplicates)],
    missing,
    unexpected
  }
}

export interface EmotionalStateBatchValidation {
  valid: boolean
  duplicates: string[]
  missing: string[]
  unexpected: string[]
}

export function selectAffectedEmotionCharacters(input: {
  configuredCharacters: string[]
  povCharacter: string
  content: string
}): string[] {
  const pov = input.povCharacter.trim()
  const mentioned = input.configuredCharacters
    .map(name => name.trim())
    .filter(name => name && (name === pov || input.content.includes(name)))
  return [...new Set([pov, ...mentioned].filter(Boolean))]
}

export function planEmotionLedgerBatches(
  characters: string[],
  batchSize = 2
): string[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2) {
    throw new Error('情绪账本批次大小必须为 1-2')
  }
  const batches: string[][] = []
  for (let index = 0; index < characters.length; index += batchSize) {
    batches.push(characters.slice(index, index + batchSize))
  }
  return batches
}
