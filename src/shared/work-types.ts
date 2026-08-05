export const WORK_TYPES = {
  novel: 'novel',
  story: 'story'
} as const

export type WorkType = typeof WORK_TYPES[keyof typeof WORK_TYPES]

export function isStoryWorkTypeValue(value?: string | null): boolean {
  return value === WORK_TYPES.story
}

export function isNovelWorkType(value?: string | null): boolean {
  return value === WORK_TYPES.novel
}
