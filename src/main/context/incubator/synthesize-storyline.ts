import { INCUBATOR_SLOT_KEYS, INCUBATOR_SLOT_LABELS } from '../../../shared/incubator-slots'
import type { IncubatorSlotKey } from '../../../shared/incubator-slots'
import { INCUBATOR_SYNTHESIZE_SYSTEM } from '../../../shared/incubator-analysis-prompts'
import { modelService } from '../../model'

export interface StorylineSynthesisResult {
  synthesizedSummary: string
  qualitySnapshot: string
  raw: string
}

export function buildSlotsPromptBody(slotMap: Record<string, string>): string {
  return INCUBATOR_SLOT_KEYS.map((k: IncubatorSlotKey) => {
    const text = slotMap[k]?.trim()
    return text ? `## ${INCUBATOR_SLOT_LABELS[k]}\n${text}` : ''
  })
    .filter(Boolean)
    .join('\n\n')
}

/**
 * 冻结前 LLM 统合六槽；失败时返回 null，由调用方回退拼接。
 */
export async function synthesizeStorylineForFreeze(
  workId: number,
  slotMap: Record<string, string>
): Promise<StorylineSynthesisResult | null> {
  const body = buildSlotsPromptBody(slotMap)
  if (!body.trim()) return null

  const res = await modelService.chat({
    prompt: body,
    systemPrompt: INCUBATOR_SYNTHESIZE_SYSTEM,
    workId,
    step: 'incubator_synthesize_freeze',
    enrichWorkContext: false,
    enrichNarrativeMemory: false,
    maxTokens: 4096
  })

  if (!res.success || !res.content.trim()) return null

  const raw = res.content.trim()
  const summaryMatch = raw.match(/##\s*统合主线摘要\s*([\s\S]*?)(?=##\s*质量评分卡|$)/i)
  const qualityMatch = raw.match(/##\s*质量评分卡\s*([\s\S]*?)$/i)

  const synthesizedSummary = (summaryMatch?.[1] ?? raw).trim()
  const qualitySnapshot = (qualityMatch?.[1] ?? '').trim()

  return {
    synthesizedSummary,
    qualitySnapshot,
    raw
  }
}
