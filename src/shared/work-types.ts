export const WORK_TYPES = {
  traditionalNovel: 'novel',
  causalNovel: 'causal_novel',
  story: 'story'
} as const

export type WorkType = typeof WORK_TYPES[keyof typeof WORK_TYPES]

export function isStoryWorkTypeValue(value?: string | null): boolean {
  return value === WORK_TYPES.story
}

export function isCausalNovelWorkType(value?: string | null): boolean {
  return value === WORK_TYPES.causalNovel
}

export function isNovelWorkType(value?: string | null): boolean {
  return value === WORK_TYPES.traditionalNovel || value === WORK_TYPES.causalNovel
}
