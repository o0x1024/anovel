import {
  NOVEL_LENGTH_PRESETS,
  type NovelLength
} from '../../../../shared/writing-plan-presets'

export type { NovelLength, NovelLengthPreset } from '../../../../shared/writing-plan-presets'
export {
  NOVEL_LENGTH_PRESETS,
  TARGET_WORD_PRESETS,
  WORDS_PER_CHAPTER_PRESETS,
  DEFAULT_WORDS_PER_CHAPTER,
  DEFAULT_NOVEL_LENGTH,
  novelLengthSummary,
  planFromNovelLength
} from '../../../../shared/writing-plan-presets'

export interface WritingPlan {
  novelLength: NovelLength
  targetTotalWords: number
  wordsPerChapter: number
}

export interface VolumePlanStatus {
  id: number
  name: string
  sort: number
  chapterCount: number
  suggestedChapters: number
  gap: number
}

export interface WritingPlanStatus {
  plan: WritingPlan
  suggestedTotalChapters: number
  actualTotalChapters: number
  chaptersWithContent: number
  writtenWords: number
  writtenProgressPercent: number
  outlineProgressPercent: number
  volumes: VolumePlanStatus[]
}

export function formatWordCount(n: number): string {
  if (n >= 10_000) {
    const wan = n / 10_000
    return Number.isInteger(wan) ? `${wan} 万字` : `${wan.toFixed(1)} 万字`
  }
  return `${n.toLocaleString('zh-CN')} 字`
}

export function volumePlanLabel(vol: VolumePlanStatus): string {
  if (vol.suggestedChapters <= 0) return `${vol.chapterCount} 章`
  return `${vol.chapterCount}/${vol.suggestedChapters} 章`
}

export function novelLengthLabel(length: NovelLength): string {
  return NOVEL_LENGTH_PRESETS[length].label
}
