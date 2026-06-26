import { coreSettingDAO, volumeChapterDAO, workDAO } from '../db'
import { getWritingStats } from './writing-stats'
import {
  DEFAULT_NOVEL_LENGTH,
  NOVEL_LENGTH_PRESETS,
  TARGET_WORD_PRESETS,
  WORDS_PER_CHAPTER_PRESETS,
  planFromNovelLength,
  getPresetsForType,
  type NovelLength,
  type PresetNovelLength
} from '../../shared/writing-plan-presets'

export const WRITING_PLAN_TYPE = 'writing_plan'

export type { NovelLength }

export interface WritingPlan {
  novelLength: NovelLength
  targetTotalWords: number
  targetChapters: number
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

export const DEFAULT_WRITING_PLAN: WritingPlan = {
  ...planFromNovelLength(DEFAULT_NOVEL_LENGTH),
  workType: 'novel'
}

export { TARGET_WORD_PRESETS, WORDS_PER_CHAPTER_PRESETS, NOVEL_LENGTH_PRESETS }

function isNovelLength(value: unknown): value is NovelLength {
  return value === 'short' || value === 'medium' || value === 'long' || value === 'custom'
}

function isPresetNovelLength(value: unknown): value is PresetNovelLength {
  return value === 'short' || value === 'medium' || value === 'long'
}

function normalizePlan(raw: Partial<WritingPlan> | null | undefined, workType: string = 'novel'): WritingPlan {
  const finalWorkType = raw?.workType || workType
  const novelLength = isNovelLength(raw?.novelLength) ? raw.novelLength : DEFAULT_NOVEL_LENGTH
  const presetLength = isPresetNovelLength(novelLength) ? novelLength : DEFAULT_NOVEL_LENGTH
  const presets = getPresetsForType(finalWorkType)
  const preset = presets[presetLength]
  const targetTotalWords = Number(raw?.targetTotalWords)
  const targetChapters = Number(raw?.targetChapters)
  const wordsPerChapter = Number(raw?.wordsPerChapter)

  const minWords = 1
  const maxWords = finalWorkType === 'story' ? 1_000_000 : 50_000_000
  const normalizedTotalWords = targetTotalWords >= minWords && targetTotalWords <= maxWords
    ? Math.round(targetTotalWords)
    : preset.targetTotalWords
  const normalizedTargetChapters = targetChapters >= 1 && targetChapters <= 100_000
    ? Math.round(targetChapters)
    : Math.max(1, Math.ceil(normalizedTotalWords / preset.wordsPerChapter))
  const normalizedWordsPerChapter = wordsPerChapter >= 1 && wordsPerChapter <= 100_000
    ? Math.round(wordsPerChapter)
    : Math.max(1, Math.round(normalizedTotalWords / normalizedTargetChapters))

  return {
    novelLength,
    targetTotalWords: normalizedTotalWords,
    targetChapters: normalizedTargetChapters,
    wordsPerChapter: normalizedWordsPerChapter,
    workType: finalWorkType
  }
}

export function initWritingPlanForWork(workId: number, input: Partial<WritingPlan> | PresetNovelLength = DEFAULT_NOVEL_LENGTH): WritingPlan {
  const work = workDAO.getById(workId)
  const workType = work?.work_type ?? 'novel'
  const presetInput = typeof input === 'string' ? planFromNovelLength(input, workType) : input
  const plan = normalizePlan({
    ...presetInput,
    novelLength: presetInput.novelLength ?? DEFAULT_NOVEL_LENGTH,
    workType
  })
  workDAO.update(workId, {
    novelLength: plan.novelLength,
    targetTotalWords: plan.targetTotalWords,
    targetChapters: plan.targetChapters,
    wordsPerChapter: plan.wordsPerChapter
  })
  // 同时写入 core_settings 保持向后兼容
  coreSettingDAO.upsert(workId, WRITING_PLAN_TYPE, JSON.stringify(plan))
  return plan
}

export function loadWritingPlan(workId: number): WritingPlan {
  const work = workDAO.getById(workId)
  const workType = work?.work_type ?? 'novel'
  // 优先从 works 表列读取
  if (work?.novel_length && work?.target_total_words) {
    const plan = normalizePlan({
      novelLength: isNovelLength(work.novel_length) ? work.novel_length : undefined,
      targetTotalWords: work.target_total_words ?? undefined,
      targetChapters: work.target_chapters ?? undefined,
      wordsPerChapter: work.words_per_chapter ?? undefined,
      workType
    })
    // 回填 core_settings 保持数据一致
    coreSettingDAO.upsert(workId, WRITING_PLAN_TYPE, JSON.stringify(plan))
    return plan
  }

  // 回退到 core_settings JSON（旧数据）
  const row = coreSettingDAO.getByType(workId, WRITING_PLAN_TYPE)
  if (row?.content) {
    try {
      const parsed = JSON.parse(row.content) as Partial<WritingPlan>
      const plan = normalizePlan({
        ...parsed,
        workType: parsed.workType || workType
      })
      // 升迁到 works 表列
      workDAO.update(workId, {
        novelLength: plan.novelLength,
        targetTotalWords: plan.targetTotalWords,
        targetChapters: plan.targetChapters,
        wordsPerChapter: plan.wordsPerChapter
      })
      return plan
    } catch {
      // fall through to default
    }
  }

  return normalizePlan({ workType })
}

export function saveWritingPlan(workId: number, input: Partial<WritingPlan>): WritingPlan {
  const work = workDAO.getById(workId)
  const workType = work?.work_type ?? 'novel'
  const plan = normalizePlan({ ...loadWritingPlan(workId), ...input, workType })
  workDAO.update(workId, {
    novelLength: plan.novelLength,
    targetTotalWords: plan.targetTotalWords,
    targetChapters: plan.targetChapters,
    wordsPerChapter: plan.wordsPerChapter
  })
  coreSettingDAO.upsert(workId, WRITING_PLAN_TYPE, JSON.stringify(plan))
  return plan
}

export function applyNovelLengthPreset(workId: number, novelLength: PresetNovelLength): WritingPlan {
  const work = workDAO.getById(workId)
  const workType = work?.work_type ?? 'novel'
  return saveWritingPlan(workId, planFromNovelLength(novelLength, workType))
}

export function suggestTotalChapters(plan: WritingPlan): number {
  return Math.max(1, Math.round(plan.targetChapters || Math.ceil(plan.targetTotalWords / plan.wordsPerChapter)))
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
