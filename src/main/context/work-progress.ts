import { coreSettingDAO, volumeChapterDAO } from '../db'
import { incubatorDraftSlotDAO, incubatorVersionDAO } from '../db/dao/incubator'
import { getSettingsQualityStatus, type SettingsQualityStatus } from './settings-quality'

export type WorkflowStepKey = 'incubator' | 'settings' | 'volumes' | 'chapters' | 'generate'

export type StepStatus = 'pending' | 'ready' | 'review' | 'done'

export interface WorkStepProgress {
  steps: Record<WorkflowStepKey, StepStatus>
  hints: Partial<Record<WorkflowStepKey, string>>
  completionPercent: number
  settingsQuality?: SettingsQualityStatus
}

const CORE_TYPES = ['character', 'worldview', 'conflict'] as const

function hasContent(map: Map<string, string>, type: string): boolean {
  return !!map.get(type)?.trim()
}

/**
 * 根据数据库内容推断各创作步骤完成度（不持久化，实时计算）
 */
export function getWorkStepProgress(workId: number): WorkStepProgress {
  const settings = coreSettingDAO.listByWork(workId)
  const byType = new Map(settings.map(s => [s.type, s.content]))

  const hasIdea = hasContent(byType, 'idea')
  const frozenStoryline = !!incubatorVersionDAO.getLatestFrozen(workId)
  const filledStorylineSlots = incubatorDraftSlotDAO.countFilledSlots(workId)
  const coreDone = CORE_TYPES.every(t => hasContent(byType, t))

  const volumes = volumeChapterDAO.listVolumes(workId)
  const chapters = volumeChapterDAO.listChaptersByWork(workId)
  const hasVolumes = volumes.length > 0
  const chaptersWithOutline = chapters.filter(c => c.outline?.trim())
  const chaptersWithContent = chapters.filter(c => c.content?.trim())

  const hasChapters = chapters.length > 0
  const hasOutlines = chaptersWithOutline.length > 0
  const hasBody = chaptersWithContent.length > 0

  const qualityStatus = getSettingsQualityStatus(workId)

  const steps: Record<WorkflowStepKey, StepStatus> = {
    incubator: frozenStoryline
      ? 'done'
      : filledStorylineSlots >= 2
        ? 'review'
        : hasIdea
          ? 'ready'
          : 'pending',
    settings: !coreDone
      ? (hasIdea ? 'ready' : 'pending')
      : qualityStatus.canProceed
        ? 'done'
        : 'review',
    volumes: hasVolumes ? 'done' : coreDone ? 'ready' : 'pending',
    chapters: hasOutlines ? 'done' : hasChapters ? 'ready' : hasVolumes ? 'ready' : 'pending',
    generate: hasBody ? 'done' : hasOutlines ? 'ready' : 'pending'
  }

  const hints: Partial<Record<WorkflowStepKey, string>> = {}
  if (!hasIdea) hints.incubator = '请先输入并保存创作种子'
  else if (!frozenStoryline && filledStorylineSlots < 2) {
    hints.incubator = '建议从变体/扩写采纳到主线槽位，拼装故事线后冻结版本'
  } else if (!frozenStoryline) {
    hints.incubator = '主线槽位已部分填充，可继续采纳或运行门禁后冻结版本'
  } else if (!coreDone) hints.settings = '请补全人设、世界观、核心冲突'
  else if (qualityStatus.needsReview) {
    if (qualityStatus.isStale) {
      hints.settings = '设定已变更，请重新运行设定质量自检'
    } else if (!qualityStatus.hasOverallCheck) {
      hints.settings = '建议运行设定质量自检后再进入分卷'
    } else if (qualityStatus.blockingCount > 0) {
      hints.settings = `自检有 ${qualityStatus.blockingCount} 个不合格项，可修订或接受当前设定`
    } else if (qualityStatus.convergenceStalled) {
      hints.settings = '自动修订未收敛，建议人工审阅或接受当前设定'
    } else {
      hints.settings = '设定质量自检未达标，可重新自检或接受当前设定'
    }
  } else if (!hasVolumes) hints.volumes = '请创建分卷或应用 AI 分卷建议'
  else if (!hasOutlines) hints.chapters = '请为本卷添加章节并生成大纲'
  else if (!hasBody) hints.generate = '请选择章节生成正文并保存'

  const doneCount = Object.values(steps).filter(s => s === 'done').length
  const completionPercent = Math.round((doneCount / Object.keys(steps).length) * 100)

  return { steps, hints, completionPercent, settingsQuality: qualityStatus }
}

export const WORKFLOW_STEP_ORDER: WorkflowStepKey[] = [
  'incubator',
  'settings',
  'volumes',
  'chapters',
  'generate'
]

export function getNextWorkflowStep(current: WorkflowStepKey): WorkflowStepKey | null {
  const idx = WORKFLOW_STEP_ORDER.indexOf(current)
  return idx >= 0 && idx < WORKFLOW_STEP_ORDER.length - 1
    ? WORKFLOW_STEP_ORDER[idx + 1]
    : null
}

export const NEXT_STEP_LABELS: Record<WorkflowStepKey, string> = {
  incubator: '进入核心设定',
  settings: '进入分卷大纲',
  volumes: '进入章节情节',
  chapters: '进入正文生成',
  generate: ''
}
