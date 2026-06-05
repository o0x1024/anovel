import type { WorkContextOptions } from './work-context'
import { isCoreSettingsCharacterGenerateStep } from './style-step-rules'

/** 正文生成 */
export function isBodyGenerationStep(step: string | undefined): boolean {
  if (!step) return false
  return step === 'body_generation' || step.startsWith('body_')
}

/** 分卷/章节情节大纲规划 */
export function isOutlinePlanningStep(step: string | undefined): boolean {
  if (!step) return false
  if (step === 'volumes_outline' || step.startsWith('volumes_outline_')) return true
  if (step === 'volume_chapters_batch' || step.startsWith('volume_chapters_batch_')) return true
  if (step === 'chapter_outline' || step.startsWith('chapter_outline_')) return true
  return false
}

/** 故事孵化器分析（产出中间产物，不应再注入其它步骤） */
export function isIncubatorStep(step: string | undefined): boolean {
  if (!step) return false
  return step === 'incubator_diagnose' ||
    step.startsWith('incubator_')
}

/** 核心设定生成/修订/自检、人设卡片 */
export function isCoreSettingsFlowStep(step: string | undefined): boolean {
  if (!step) return false
  if (step === 'character_cards_generate' || step.startsWith('character_cards_')) return true
  if (!step.startsWith('settings_')) return false
  return true
}

/**
 * 针对单段内容的分析/润色/提取（prompt 已含待处理正文）
 * 不应再灌入全书 work_context / 孵化器 / 叙事记忆体
 */
export function isFocusedAnalysisStep(step: string | undefined): boolean {
  if (!step) return false
  if (step.endsWith('_self_check')) return true
  const prefixes = [
    'critique_',
    'quality_diagnosis',
    'anti_mean_',
    'memory_extract',
    'ai_trace_',
    'lab_deai',
    'model_debate',
    'revision_checklist',
    'writer_block_'
  ]
  return prefixes.some(p => step === p || step.startsWith(p))
}

export function shouldInjectAnchors(step: string | undefined): boolean {
  if (!step) return false
  if (isIncubatorStep(step)) return false
  if (isFocusedAnalysisStep(step)) return false
  if (isCoreSettingsCharacterGenerateStep(step)) return false
  return true
}

export function shouldInjectTasteAndConditionRules(step: string | undefined): boolean {
  if (!step) return false
  if (isOutlinePlanningStep(step)) return false
  if (isIncubatorStep(step)) return false
  if (isFocusedAnalysisStep(step)) return false
  if (isCoreSettingsCharacterGenerateStep(step)) return false
  return true
}

/** 文风模板 / 分步规则 / 进化曲线（提取叙事记忆、大纲规划、孵化器探索等不需要） */
export function shouldInjectWritingStyle(step: string | undefined): boolean {
  if (!step) return false
  if (isFocusedAnalysisStep(step)) return false
  if (isOutlinePlanningStep(step)) return false
  if (isIncubatorStep(step)) return false
  if (isCoreSettingsCharacterGenerateStep(step)) return false
  return true
}

export function shouldInjectChapterOutlineLengthRules(step: string | undefined): boolean {
  if (!step) return false
  return (
    step === 'chapter_outline' ||
    step.startsWith('chapter_outline_') ||
    step === 'volume_chapters_batch' ||
    step.startsWith('volume_chapters_batch_')
  )
}

export function shouldInjectVolumeOutlineLengthRules(step: string | undefined): boolean {
  if (!step) return false
  return step === 'volumes_outline' || step.startsWith('volumes_outline_')
}

/** 规划步骤默认 workContext */
export function mergeOutlinePlanningWorkContextOptions(
  step: string | undefined,
  options: WorkContextOptions = {},
  volumeId?: number,
  chapterVolumeId?: number
): WorkContextOptions {
  if (!isOutlinePlanningStep(step)) return options

  const currentVolumeId =
    options.currentVolumeId ?? volumeId ?? chapterVolumeId

  const includeVolumes =
    options.includeVolumes ??
    (step.includes('volume_chapters_batch') ||
      step === 'chapter_outline' ||
      step.startsWith('chapter_outline_'))

  return {
    ...options,
    includeIncubator: false,
    includeQualityIssues: false,
    includeIdea: options.includeIdea ?? true,
    includeCoreSettings: options.includeCoreSettings ?? true,
    includeVolumes,
    volumeOutlineMode: options.volumeOutlineMode ?? (includeVolumes ? 'compact' : undefined),
    currentVolumeId: includeVolumes ? currentVolumeId : options.currentVolumeId
  }
}

function mergeBodyWorkContextOptions(
  options: WorkContextOptions,
  chapterVolumeId?: number
): WorkContextOptions {
  const excludeCoreTypes = [...new Set([...(options.excludeCoreTypes ?? []), 'worldview'])]
  return {
    ...options,
    includeIncubator: false,
    excludeCoreTypes,
    volumeOutlineMode: options.volumeOutlineMode ?? 'compact',
    currentVolumeId: options.currentVolumeId ?? chapterVolumeId
  }
}

function mergeFocusedAnalysisWorkContextOptions(
  options: WorkContextOptions
): WorkContextOptions {
  return {
    ...options,
    includeIncubator: false,
    includeQualityIssues: false,
    includeVolumes: false,
    includeIdea: options.includeIdea ?? false,
    includeCoreSettings: options.includeCoreSettings ?? false
  }
}

function mergeCoreSettingsFlowWorkContextOptions(
  options: WorkContextOptions
): WorkContextOptions {
  return {
    ...options,
    includeIncubator: false,
    includeQualityIssues: false,
    includeVolumes: false
  }
}

function mergeDefaultEnrichedWorkContextOptions(
  options: WorkContextOptions
): WorkContextOptions {
  return {
    ...options,
    includeIncubator: options.includeIncubator ?? false
  }
}

/**
 * 在 collectPromptSections 中统一解析 workContextOptions
 */
export function resolveWorkContextOptionsForStep(
  step: string | undefined,
  options: WorkContextOptions = {},
  volumeId?: number,
  chapterVolumeId?: number
): WorkContextOptions {
  let merged = { ...options, includeIncubator: options.includeIncubator ?? false }

  if (isOutlinePlanningStep(step)) {
    merged = mergeOutlinePlanningWorkContextOptions(step, merged, volumeId, chapterVolumeId)
  } else if (isBodyGenerationStep(step)) {
    merged = mergeBodyWorkContextOptions(merged, chapterVolumeId)
  } else if (isFocusedAnalysisStep(step)) {
    merged = mergeFocusedAnalysisWorkContextOptions(merged)
  } else if (isCoreSettingsFlowStep(step)) {
    merged = mergeCoreSettingsFlowWorkContextOptions(merged)
  } else if (isIncubatorStep(step)) {
    merged = {
      includeIdea: true,
      includeIncubator: false,
      includeCoreSettings: false,
      includeVolumes: false,
      includeQualityIssues: false,
      ...merged
    }
  } else {
    merged = mergeDefaultEnrichedWorkContextOptions(merged)
  }

  return merged
}
