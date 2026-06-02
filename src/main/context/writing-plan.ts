import { coreSettingDAO, volumeChapterDAO } from '../db'
import { getWritingStats } from './writing-stats'
import {
  DEFAULT_NOVEL_LENGTH,
  NOVEL_LENGTH_PRESETS,
  TARGET_WORD_PRESETS,
  WORDS_PER_CHAPTER_PRESETS,
  planFromNovelLength,
  type NovelLength
} from '../../shared/writing-plan-presets'

export const WRITING_PLAN_TYPE = 'writing_plan'

export type { NovelLength }

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

export const DEFAULT_WRITING_PLAN: WritingPlan = {
  ...planFromNovelLength(DEFAULT_NOVEL_LENGTH)
}

export { TARGET_WORD_PRESETS, WORDS_PER_CHAPTER_PRESETS, NOVEL_LENGTH_PRESETS }

function isNovelLength(value: unknown): value is NovelLength {
  return value === 'short' || value === 'medium' || value === 'long'
}

function normalizePlan(raw: Partial<WritingPlan> | null | undefined): WritingPlan {
  const novelLength = isNovelLength(raw?.novelLength) ? raw.novelLength : DEFAULT_NOVEL_LENGTH
  const preset = NOVEL_LENGTH_PRESETS[novelLength]
  const targetTotalWords = Number(raw?.targetTotalWords)
  const wordsPerChapter = Number(raw?.wordsPerChapter)
  return {
    novelLength,
    targetTotalWords: targetTotalWords >= 50_000 && targetTotalWords <= 5_000_000
      ? Math.round(targetTotalWords)
      : preset.targetTotalWords,
    wordsPerChapter: (WORDS_PER_CHAPTER_PRESETS as readonly number[]).includes(wordsPerChapter)
      ? wordsPerChapter
      : preset.wordsPerChapter
  }
}

export function initWritingPlanForWork(workId: number, novelLength: NovelLength = DEFAULT_NOVEL_LENGTH): WritingPlan {
  const plan = normalizePlan(planFromNovelLength(novelLength))
  coreSettingDAO.upsert(workId, WRITING_PLAN_TYPE, JSON.stringify(plan))
  return plan
}

export function loadWritingPlan(workId: number): WritingPlan {
  const row = coreSettingDAO.getByType(workId, WRITING_PLAN_TYPE)
  if (!row?.content) return { ...DEFAULT_WRITING_PLAN }
  try {
    return normalizePlan(JSON.parse(row.content) as Partial<WritingPlan>)
  } catch {
    return { ...DEFAULT_WRITING_PLAN }
  }
}

export function saveWritingPlan(workId: number, input: Partial<WritingPlan>): WritingPlan {
  const plan = normalizePlan({ ...loadWritingPlan(workId), ...input })
  coreSettingDAO.upsert(workId, WRITING_PLAN_TYPE, JSON.stringify(plan))
  return plan
}

export function applyNovelLengthPreset(workId: number, novelLength: NovelLength): WritingPlan {
  return saveWritingPlan(workId, planFromNovelLength(novelLength))
}

export function suggestTotalChapters(plan: WritingPlan): number {
  return Math.max(1, Math.ceil(plan.targetTotalWords / plan.wordsPerChapter))
}

/** 将总章数均分到各卷，余数优先分给前几卷 */
export function distributeChaptersPerVolume(totalChapters: number, volumeCount: number): number[] {
  if (volumeCount <= 0) return []
  const base = Math.floor(totalChapters / volumeCount)
  const remainder = totalChapters % volumeCount
  return Array.from({ length: volumeCount }, (_, i) => base + (i < remainder ? 1 : 0))
}

export function getWritingPlanStatus(workId: number): WritingPlanStatus {
  const plan = loadWritingPlan(workId)
  const volumes = volumeChapterDAO.listVolumes(workId)
  const suggestedTotalChapters = suggestTotalChapters(plan)
  const perVolume = distributeChaptersPerVolume(suggestedTotalChapters, volumes.length)
  const stats = getWritingStats(workId)

  const volumeStatuses: VolumePlanStatus[] = volumes.map((vol, index) => {
    const chapterCount = volumeChapterDAO.listChapters(vol.id).length
    const suggestedChapters = perVolume[index] ?? 0
    return {
      id: vol.id,
      name: vol.name,
      sort: vol.sort,
      chapterCount,
      suggestedChapters,
      gap: Math.max(0, suggestedChapters - chapterCount)
    }
  })

  const writtenProgressPercent = plan.targetTotalWords > 0
    ? Math.min(100, Math.round((stats.totalWords / plan.targetTotalWords) * 100))
    : 0
  const outlineProgressPercent = suggestedTotalChapters > 0
    ? Math.min(100, Math.round((stats.chapterCount / suggestedTotalChapters) * 100))
    : 0

  return {
    plan,
    suggestedTotalChapters,
    actualTotalChapters: stats.chapterCount,
    chaptersWithContent: stats.chaptersWithContent,
    writtenWords: stats.totalWords,
    writtenProgressPercent,
    outlineProgressPercent,
    volumes: volumeStatuses
  }
}

/** 本卷建议下一批生成的章数（用于 UI 默认值） */
export function suggestBatchChapterCount(volumeStatus: VolumePlanStatus | undefined): number {
  if (!volumeStatus) return 5
  if (volumeStatus.gap <= 0) return 5
  const options = [3, 4, 5, 6, 8, 10]
  const target = Math.min(volumeStatus.gap, 10)
  return options.reduce((best, n) =>
    Math.abs(n - target) < Math.abs(best - target) ? n : best
  )
}
