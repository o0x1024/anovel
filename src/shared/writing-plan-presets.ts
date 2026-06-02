/** 篇幅类型 — 新建作品时选择，驱动目标总字数与建议章数 */
export type NovelLength = 'short' | 'medium' | 'long'

export const DEFAULT_WORDS_PER_CHAPTER = 4000

export interface NovelLengthPreset {
  label: string
  description: string
  targetTotalWords: number
  suggestedChapters: number
  wordsPerChapter: number
}

export const NOVEL_LENGTH_PRESETS: Record<NovelLength, NovelLengthPreset> = {
  short: {
    label: '短篇',
    description: '单线快节奏，适合集中爆发',
    targetTotalWords: 200_000,
    suggestedChapters: 50,
    wordsPerChapter: DEFAULT_WORDS_PER_CHAPTER
  },
  medium: {
    label: '中篇',
    description: '主流网文体量，多卷展开',
    targetTotalWords: 800_000,
    suggestedChapters: 200,
    wordsPerChapter: DEFAULT_WORDS_PER_CHAPTER
  },
  long: {
    label: '长篇',
    description: '超长连载，深度分卷',
    targetTotalWords: 1_600_000,
    suggestedChapters: 400,
    wordsPerChapter: DEFAULT_WORDS_PER_CHAPTER
  }
}

export const DEFAULT_NOVEL_LENGTH: NovelLength = 'medium'

export const TARGET_WORD_PRESETS = [
  NOVEL_LENGTH_PRESETS.short.targetTotalWords,
  NOVEL_LENGTH_PRESETS.medium.targetTotalWords,
  NOVEL_LENGTH_PRESETS.long.targetTotalWords,
  1_000_000,
  2_000_000
] as const

export const WORDS_PER_CHAPTER_PRESETS = [3500, 4000, 4500, 5000] as const

export function novelLengthSummary(length: NovelLength): string {
  const p = NOVEL_LENGTH_PRESETS[length]
  const wan = p.targetTotalWords / 10_000
  const wanLabel = Number.isInteger(wan) ? `${wan} 万字` : `${wan.toFixed(1)} 万字`
  return `${wanLabel} · 约 ${p.suggestedChapters} 章 · 每章 ${p.wordsPerChapter} 字`
}

export function planFromNovelLength(length: NovelLength): {
  novelLength: NovelLength
  targetTotalWords: number
  wordsPerChapter: number
} {
  const p = NOVEL_LENGTH_PRESETS[length]
  return {
    novelLength: length,
    targetTotalWords: p.targetTotalWords,
    wordsPerChapter: p.wordsPerChapter
  }
}
