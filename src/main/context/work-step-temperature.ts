import { workDAO } from '../db'
import { appLogger } from '../logger/app-logger'
import {
  type WorkTemperatureGroupKey,
  type WorkStepTemperatureConfig,
  DEFAULT_WORK_STEP_TEMPERATURE,
  mergeWorkStepTemperature,
  parseWorkStepTemperatureJson,
  sampleTemperatureInRange
} from '../../shared/work-step-temperature'

export {
  DEFAULT_WORK_STEP_TEMPERATURE,
  mergeWorkStepTemperature,
  parseWorkStepTemperatureJson,
  sampleTemperatureInRange
}
export type { WorkTemperatureGroupKey, WorkStepTemperatureConfig }

const DYNAMIC_SUFFIX_GROUPS: { suffix: string; group: WorkTemperatureGroupKey }[] = [
  { suffix: '_self_check', group: 'analysis' },
  { suffix: '_micro_instruct', group: 'polish' },
  { suffix: '_ab_variants', group: 'creative' }
]

const STEP_ALIASES: Record<string, WorkTemperatureGroupKey> = {
  volumes: 'outline',
  volumes_outline: 'outline',
  chapters: 'outline',
  generate: 'body',
  incubator: 'creative',
  settings: 'character'
}

export function isWorkScopedModelRequest(workId: number | undefined | null): boolean {
  return workId != null && workId > 0
}

export function getWorkStepTemperatureConfig(workId: number): WorkStepTemperatureConfig {
  return workDAO.getStepTemperature(workId)
}

export function setWorkStepTemperatureConfig(
  workId: number,
  partial: Partial<WorkStepTemperatureConfig>
): WorkStepTemperatureConfig {
  return workDAO.setStepTemperature(workId, partial)
}

export function resolveTemperatureGroup(step: string | undefined): WorkTemperatureGroupKey {
  if (!step?.trim()) return 'creative'

  let normalized = step.trim()

  for (const { suffix, group } of DYNAMIC_SUFFIX_GROUPS) {
    if (normalized.endsWith(suffix)) return group
  }

  if (normalized.endsWith('_reject_retry')) {
    normalized = normalized.slice(0, -'_reject_retry'.length)
  }

  const alias = STEP_ALIASES[normalized]
  if (alias) return alias

  if (normalized === 'model_debate_fusion') return 'analysis'
  if (normalized === 'model_debate') return 'creative'

  if (
    normalized === 'body_style_rewrite' ||
    normalized === 'critique_apply_fixes' ||
    normalized.startsWith('settings_') && (
      normalized.includes('_revise') ||
      normalized.includes('_revise_all')
    )
  ) {
    return 'polish'
  }

  if (normalized.startsWith('ai_trace_') || normalized === 'memory_extract') {
    return 'deai'
  }

  if (
    normalized === 'critique_dual_channel' ||
    normalized.startsWith('quality_diagnosis') ||
    normalized === 'settings_overall_check' ||
    normalized === 'settings_character_check' ||
    normalized === 'revision_checklist'
  ) {
    return 'analysis'
  }

  if (
    normalized.startsWith('settings_worldview') ||
    normalized.startsWith('settings_cross_worldview')
  ) {
    return 'worldview'
  }

  if (
    normalized === 'settings_character' ||
    (normalized.startsWith('settings_character_') && !normalized.includes('_check')) ||
    normalized.startsWith('settings_cross_character') ||
    normalized.startsWith('character_cards_')
  ) {
    return 'character'
  }

  if (normalized === 'body_generation' || (normalized.startsWith('body_') && normalized !== 'body_style_rewrite')) {
    return 'body'
  }

  if (normalized === 'incubator_reverse') return 'outline'

  if (
    normalized.startsWith('volumes_outline') ||
    normalized.startsWith('volume_chapters_batch') ||
    normalized.startsWith('chapter_outline')
  ) {
    return 'outline'
  }

  if (normalized.startsWith('incubator_')) return 'creative'

  if (normalized.startsWith('writer_block_') || normalized.startsWith('anti_mean_')) {
    return 'creative'
  }

  if (normalized.startsWith('settings_conflict')) return 'creative'

  appLogger.warn('work_temperature', '未识别的创作 step，使用 creative 默认温度组', { step })
  return 'creative'
}

export function resolveWorkRequestTemperature(
  workId: number,
  step: string | undefined
): { temperature: number; group: WorkTemperatureGroupKey; range: { min: number; max: number } } {
  const config = getWorkStepTemperatureConfig(workId)
  const group = resolveTemperatureGroup(step)
  const range = config[group]
  const temperature = sampleTemperatureInRange(range.min, range.max)
  return { temperature, group, range }
}
