import type { ParsedChapter } from '../parse-chapters'

export const BEAT_SKELETON_MAX_TOKENS = 4200
export const BEAT_CONTRACT_MAX_TOKENS = 3600
export const BEAT_STAGE_MAX_ATTEMPTS = 2

export type BeatGateRecovery = 'retry_beats' | 'rebuild_contract' | 'rebuild_engine' | 'simplify'

/** 节拍失败先在本层收敛，再逐级扩大修复半径；禁止每次都销毁已通过的上游发动机。 */
export function beatGateRecoveryForFailureCount(count: number): BeatGateRecovery {
  const position = ((Math.max(1, count) - 1) % 4) + 1
  if (position === 1) return 'retry_beats'
  if (position === 2) return 'rebuild_contract'
  if (position === 3) return 'rebuild_engine'
  return 'simplify'
}

export function storyBeatStageKey(prompt: string, beatCount: number): string {
  let hash = 2166136261
  for (let index = 0; index < prompt.length; index++) {
    hash ^= prompt.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${beatCount}:${prompt.length}:${(hash >>> 0).toString(16)}`
}

export function compactBeatSkeletons(chapters: ParsedChapter[]): Array<Record<string, unknown>> {
  return chapters.map((chapter, index) => ({
    index: index + 1,
    title: chapter.title,
    plot_outline: chapter.outline,
    beat_role: chapter.beat_role,
    foreshadow_target: chapter.foreshadow_target,
    next_hook: chapter.next_hook,
    characters: chapter.characters
  }))
}

export function mergeStagedBeat(skeleton: ParsedChapter, enriched: ParsedChapter): ParsedChapter {
  return {
    ...skeleton,
    // 事件链和标题由全篇骨架锁定，单拍补全不得悄悄改写全篇结构。
    title: skeleton.title,
    outline: skeleton.outline,
    beat_role: enriched.beat_role ?? skeleton.beat_role,
    foreshadow_target: enriched.foreshadow_target ?? skeleton.foreshadow_target,
    next_hook: enriched.next_hook ?? skeleton.next_hook,
    characters: enriched.characters ?? skeleton.characters,
    dramatic_contract: enriched.dramatic_contract,
    continuity_contract: enriched.continuity_contract,
    tension_plan: enriched.tension_plan,
    emotion_contract: enriched.emotion_contract
  }
}

export function mergeStoryBlueprintDiagnosis(
  existingJson: string | null | undefined,
  patch: Pick<ParsedChapter, 'dramatic_contract' | 'continuity_contract' | 'tension_plan' | 'emotion_contract'>
): string | null {
  let existing: Record<string, unknown> = {}
  try {
    const parsed = existingJson?.trim() ? JSON.parse(existingJson) as unknown : null
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch {
    return existingJson ?? null
  }
  const merged = {
    dramatic_contract: patch.dramatic_contract ?? existing.dramatic_contract ?? null,
    continuity_contract: patch.continuity_contract ?? existing.continuity_contract ?? null,
    tension_plan: patch.tension_plan ?? existing.tension_plan ?? null,
    emotion_contract: patch.emotion_contract ?? existing.emotion_contract ?? null
  }
  return Object.values(merged).some(Boolean) ? JSON.stringify(merged) : existingJson ?? null
}

export function exactStageCountError(actual: number, expected: number, label: string): string | null {
  return actual === expected ? null : `${label}数量不符：期望 ${expected}，实际 ${actual}`
}
