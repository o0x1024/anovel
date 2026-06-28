/** 篇幅类型 — 新建作品时选择，驱动目标总字数与建议章数 */
export type PresetNovelLength = 'short' | 'medium' | 'long'
export type NovelLength = PresetNovelLength | 'custom'

export const DEFAULT_WORDS_PER_CHAPTER = 4000

export interface NovelLengthPreset {
  label: string
  description: string
  targetTotalWords: number
  suggestedChapters: number
  wordsPerChapter: number
}

export const NOVEL_LENGTH_PRESETS: Record<PresetNovelLength, NovelLengthPreset> = {
  short: {
    label: '短篇小说',
    description: '单线快节奏，适合集中爆发',
    targetTotalWords: 200_000,
    suggestedChapters: 50,
    wordsPerChapter: DEFAULT_WORDS_PER_CHAPTER
  },
  medium: {
    label: '中篇小说',
    description: '主流网文体量，多卷展开',
    targetTotalWords: 800_000,
    suggestedChapters: 200,
    wordsPerChapter: DEFAULT_WORDS_PER_CHAPTER
  },
  long: {
    label: '长篇小说',
    description: '超长连载，深度分卷',
    targetTotalWords: 1_600_000,
    suggestedChapters: 400,
    wordsPerChapter: DEFAULT_WORDS_PER_CHAPTER
  }
}

export const STORY_LENGTH_PRESETS: Record<PresetNovelLength, NovelLengthPreset> = {
  short: {
    label: '短篇故事',
    description: '快速聚焦单一事件或冲突，篇幅较短',
    targetTotalWords: 10_000,
    suggestedChapters: 3,
    wordsPerChapter: 3000
  },
  medium: {
    label: '中篇故事',
    description: '情节发展较为完整，有多条冲突线',
    targetTotalWords: 30_000,
    suggestedChapters: 10,
    wordsPerChapter: 3000
  },
  long: {
    label: '长篇故事',
    description: '人物关系更为复杂，支持多节拍深度展现',
    targetTotalWords: 60_000,
    suggestedChapters: 15,
    wordsPerChapter: 4000
  }
}

export function getPresetsForType(workType?: string): Record<PresetNovelLength, NovelLengthPreset> {
  return workType === 'story' ? STORY_LENGTH_PRESETS : NOVEL_LENGTH_PRESETS
}

export const DEFAULT_NOVEL_LENGTH: PresetNovelLength = 'medium'

export const TARGET_WORD_PRESETS = [
  200_000, 300_000, 400_000, 500_000, 600_000, 700_000,
  800_000, 1_000_000, 1_200_000, 1_500_000, 1_600_000, 2_000_000
] as const

/** 每章目标字数选项 — 章节规划与正文生成共用 */
export const WORDS_PER_CHAPTER_PRESETS = [2000, 2500, 3000, 3500, 4000, 4500, 5000] as const

export function novelLengthSummary(length: PresetNovelLength, workType?: string): string {
  const p = getPresetsForType(workType)[length]
  const wan = p.targetTotalWords / 10_000
  const label = wan < 1 ? `${p.targetTotalWords} 字` : (Number.isInteger(wan) ? `${wan} 万字` : `${wan.toFixed(1)} 万字`)
  const unit = workType === 'story' ? '拍' : '章'
  const perUnitLabel = workType === 'story' ? '每拍' : '每章'
  return `${label} · 约 ${p.suggestedChapters} ${unit} · ${perUnitLabel} ${p.wordsPerChapter} 字`
}

export function planFromNovelLength(length: PresetNovelLength, workType?: string): {
  novelLength: PresetNovelLength
  targetTotalWords: number
  targetChapters: number
  wordsPerChapter: number
} {
  const p = getPresetsForType(workType)[length]
  return {
    novelLength: length,
    targetTotalWords: p.targetTotalWords,
    targetChapters: p.suggestedChapters,
    wordsPerChapter: p.wordsPerChapter
  }
}
