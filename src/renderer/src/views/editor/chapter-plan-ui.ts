import {
  NOVEL_LENGTH_PRESETS,
  STORY_LENGTH_PRESETS,
  getPresetsForType,
  type NovelLength
} from '../../../../shared/writing-plan-presets'

export type { NovelLength, NovelLengthPreset } from '../../../../shared/writing-plan-presets'
export {
  NOVEL_LENGTH_PRESETS,
  STORY_LENGTH_PRESETS,
  getPresetsForType,
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
  workType?: string
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

export function volumePlanLabel(vol: VolumePlanStatus, workType?: string): string {
  const unit = workType === 'story' ? '拍' : '章'
  if (vol.suggestedChapters <= 0) return `${vol.chapterCount} ${unit}`
  return `${vol.chapterCount}/${vol.suggestedChapters} ${unit}`
}

export function novelLengthLabel(length: NovelLength, workType?: string): string {
  const presets = getPresetsForType(workType)
  return presets[length].label
}

export function getTargetWordPresets(workType?: string): number[] {
  if (workType === 'story') {
    return [6000, 10000, 20000, 30000, 40000, 60000, 80000]
  }
  return [200000, 300000, 400000, 500000, 600000, 700000, 800000, 1000000, 1200000, 1500000, 1600000, 2000000]
}

export function getWordsPerChapterPresets(workType?: string): number[] {
  if (workType === 'story') {
    return [1000, 1500, 2000, 2500, 3000, 4000, 5000]
  }
  return [2000, 2500, 3000, 3500, 4000, 4500, 5000]
}
