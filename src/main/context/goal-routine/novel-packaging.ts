import { modelService } from '../../model'
import { saveCharacterCards } from '../character-cards'
import { buildWorkContext } from '../work-context'
import { CHARACTER_CARDS_AI_PROMPT } from '../writing-techniques'
import { retentionPackagingRules } from './reader-retention'
import { assertNovelGoalNotAborted } from './novel-runtime-utils'
import { withGoalLoopModelOptions } from './story-goal-model'
import { requestStructuredModelOutput } from './structured-model-output'
import {
  CHARACTER_CARDS_RESPONSE_SCHEMA,
  parseStrictCharacterCards
} from './strict-character-card-output'

export interface NovelTitleHookCandidate {
  title: string
  hook: string
  summary?: string
}

const NOVEL_TITLE_HOOK_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['preferredIndex', 'candidates'],
  properties: {
    preferredIndex: { type: 'integer' },
    candidates: {
      type: 'array', minItems: 3, maxItems: 3,
      items: {
        type: 'object',
        required: ['title', 'hook', 'summary'],
        properties: {
          title: { type: 'string' }, hook: { type: 'string' }, summary: { type: 'string' }
        }
      }
    }
  }
}

function parseNovelTitleHook(value: Record<string, unknown>): {
  preferred: NovelTitleHookCandidate
  preferredIndex: number
  candidates: NovelTitleHookCandidate[]
} {
  if (!Array.isArray(value.candidates) || value.candidates.length !== 3) {
    throw new Error('必须返回3套 candidates')
  }
  const candidates = value.candidates.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`第${index + 1}套候选不是对象`)
    }
    const row = item as Record<string, unknown>
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    const hook = typeof row.hook === 'string' ? row.hook.trim() : ''
    const summary = typeof row.summary === 'string' ? row.summary.trim() : ''
    if (!title || !hook || !summary) throw new Error(`第${index + 1}套候选字段不完整`)
    return { title, hook, summary }
  })
  const preferredIndex = Number(value.preferredIndex)
  if (!Number.isInteger(preferredIndex) || preferredIndex < 0 || preferredIndex >= candidates.length) {
    throw new Error('preferredIndex 非法')
  }
  return { preferred: candidates[preferredIndex], preferredIndex, candidates }
}

export async function generateNovelCharacterCards(
  workId: number,
  signal?: AbortSignal
): Promise<number> {
  assertNovelGoalNotAborted(signal)
  const ctx = buildWorkContext(workId, { includeVolumes: true, includeCoreSettings: true })
  const cards = await requestStructuredModelOutput({
    workId,
    label: '长篇小说主角人设卡',
    signal,
    schema: CHARACTER_CARDS_RESPONSE_SCHEMA,
    validate: parseStrictCharacterCards,
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'character_cards_generate',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        systemPrompt: CHARACTER_CARDS_AI_PROMPT,
        prompt: [
          `请基于以下作品上下文，生成主角人设卡片。\n\n${ctx.text.slice(0, 8000)}`,
          attempt > 1 ? `【协议重试】${error}。只返回完整且更短的 JSON。` : ''
        ].filter(Boolean).join('\n\n'),
        responseSchema: { name: 'novel_character_cards', schema: CHARACTER_CARDS_RESPONSE_SCHEMA, strict: false },
        structuredOutputMode: 'prompt_json'
      }),
      { stream: false, signal }
    )
  })
  saveCharacterCards(workId, cards)
  return cards.length
}

export async function generateNovelTitleHook(
  workId: number,
  goal: string,
  signal?: AbortSignal
): Promise<{
  preferred: NovelTitleHookCandidate
  preferredIndex: number
  candidates: NovelTitleHookCandidate[]
}> {
  assertNovelGoalNotAborted(signal)
  const ctx = buildWorkContext(workId, { includeVolumes: true, includeCoreSettings: true })
  return requestStructuredModelOutput({
    workId,
    label: '长篇小说书名导语',
    signal,
    schema: NOVEL_TITLE_HOOK_RESPONSE_SCHEMA,
    validate: parseNovelTitleHook,
    request: (attempt, error) => modelService.chat(
      withGoalLoopModelOptions(workId, {
        workId,
        step: 'goal_title_hook',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        responseSchema: { name: 'novel_title_hook', schema: NOVEL_TITLE_HOOK_RESPONSE_SCHEMA, strict: false },
        structuredOutputMode: 'prompt_json',
        systemPrompt: [
          '你是长篇小说书名与导语策划。根据已冻结的分卷和章节结构生成3套差异明显的候选，并给出推荐序号。只输出 JSON。',
          '格式：{"preferredIndex":0,"candidates":[{"title":"...","hook":"...","summary":"..."}]}',
          'title 要爆款吸睛；hook 为 80-150 字长篇导语，必须同时承诺开篇核心冲突、主角差异和前三章首次兑现方向，但不能提前剧透终局；summary 是 100 字以内核心卖点；三套候选不得只是同义替换。',
          retentionPackagingRules('novel')
        ].join('\n'),
        prompt: [
          `【用户创作目标】\n${goal.trim() || '请策划一部长篇小说。'}`,
          `【作品上下文】\n${ctx.text.slice(0, 6000)}`,
          attempt > 1 ? `【协议重试】${error}。只返回完整且更短的 JSON。` : ''
        ].filter(Boolean).join('\n\n')
      }),
      { stream: false, signal }
    )
  })
}
