import { coreSettingDAO, volumeChapterDAO, workDAO } from '../db'
import type { VolumeRow } from '../db'
import { formatQualityIssuesForContext } from './settings-quality'
import { VOLUME_OUTLINE_TARGET_CHARS } from './writing-techniques'
import {
  CORE_SETTING_TYPES,
  getCoreSettingLabel,
  type CoreSettingType
} from '../../shared/settings-types'

export const INCUBATOR_SETTING_TYPES = [
  'incubator_diagnose',
  'incubator_variants',
  'incubator_reverse',
  'incubator_anchors',
  'incubator_expand',
  'incubator_benchmark',
  'incubator_tone',
  'incubator_frontstory',
  'incubator_microinnovation'
] as const

const SETTING_LABELS: Record<string, string> = {
  idea: '故事方向',
  character: '人设',
  worldview: '世界观',
  conflict: '核心冲突',
  incubator_diagnose: '大岗诊断',
  incubator_variants: '变体探索',
  incubator_reverse: '倒推大纲',
  incubator_anchors: '提炼锚点',
  incubator_expand: '方向扩写',
  incubator_benchmark: '对标分析',
  incubator_tone: '情感基调',
  incubator_frontstory: '前台故事',
  incubator_microinnovation: '微创新分析'
}

export interface WorkContextOptions {
  includeIdea?: boolean
  includeIncubator?: boolean
  includeCoreSettings?: boolean
  includeVolumes?: boolean
  /** 注入设定自检未决问题（默认 true，与核心设定联动） */
  includeQualityIssues?: boolean
  /** 排除指定核心设定类型（如已由 narrative-memory 独立注入的 worldview） */
  excludeCoreTypes?: string[]
  /**
   * 分卷注入模式（仅 includeVolumes 时生效）
   * - full：卷名 + 完整 description
   * - compact：非当前卷 description 截断；当前卷不重复 description
   * - names_only：仅卷名列表
   */
  volumeOutlineMode?: 'full' | 'compact' | 'names_only'
  /** 正文生成时当前卷 ID，配合 compact 避免与 task prompt重复 */
  currentVolumeId?: number
  /**
   * idea 字段注入模式
   * - full：完整注入（默认）
   * - goal_only：仅保留创作目标摘要，剥离孵化器槽位原文
   *   （槽位信息已由 core settings 以精炼展开版注入，避免双重注入）
   */
  ideaMode?: 'full' | 'goal_only'
}

export interface WorkContextResult {
  text: string
  sections: Record<string, string>
}

/**
 * 聚合作品各步骤产出，供 AI Prompt 统一引用
 */
export function buildWorkContext(workId: number, options: WorkContextOptions = {}): WorkContextResult {
  const {
    includeIdea = true,
    includeIncubator = false,
    includeCoreSettings = true,
    includeVolumes = false,
    includeQualityIssues = true
  } = options

  const work = workDAO.getById(workId)
  const isStory = work?.work_type === 'story'

  const settings = coreSettingDAO.listByWork(workId)
  const byType = new Map(settings.map(s => [s.type, s.content]))
  const sections: Record<string, string> = {}

  if (includeIdea) {
    const raw = byType.get('idea')?.trim()
    if (raw) {
      sections[SETTING_LABELS.idea] = options.ideaMode === 'goal_only'
        ? trimIdeaToGoal(raw)
        : raw
    }
  }

  if (includeIncubator) {
    for (const type of INCUBATOR_SETTING_TYPES) {
      const content = byType.get(type)?.trim()
      if (content) sections[SETTING_LABELS[type] || type] = content
    }
  }

  if (includeCoreSettings) {
    const excluded = new Set(options.excludeCoreTypes)
    for (const type of CORE_SETTING_TYPES) {
      if (excluded.has(type)) continue
      const content = byType.get(type)?.trim()
      if (!content) continue
      sections[getCoreSettingLabel(type, isStory)] = content
    }
  }

  if (includeQualityIssues && includeCoreSettings) {
    const qualityText = formatQualityIssuesForContext(workId)
    if (qualityText) sections['设定自检约束'] = qualityText
  }

  if (includeVolumes) {
    const volumes = volumeChapterDAO.listVolumes(workId)
    if (volumes.length > 0) {
      sections['分卷大纲'] = formatVolumesForContext(
        volumes,
        options.volumeOutlineMode ?? 'full',
        options.currentVolumeId
      )
    }
  }

  if (Object.keys(sections).length === 0) {
    return { text: '', sections: {} }
  }

  const text = [
    '【作品创作上下文 - 后续生成须与此保持一致】',
    ...Object.entries(sections).map(([label, content]) => `## ${label}\n${content}`)
  ].join('\n\n')

  return { text, sections: Object.fromEntries(Object.entries(sections)) }
}

/**
 * 从 idea 全文中只保留标题和【创作目标】段，
 * 去掉目标循环拼接的孵化器槽位（## 开头的子章节）。
 * 这些槽位信息已由 core settings 以精炼展开版注入。
 */
function trimIdeaToGoal(idea: string): string {
  const slotStart = idea.indexOf('\n## ')
  if (slotStart < 0) return idea
  const goalPart = idea.slice(0, slotStart).trim()
  return goalPart || idea
}

function truncateChars(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}…`
}

function formatVolumesForContext(
  volumes: VolumeRow[],
  mode: NonNullable<WorkContextOptions['volumeOutlineMode']>,
  currentVolumeId?: number
): string {
  const compactMax = VOLUME_OUTLINE_TARGET_CHARS.compactInject

  if (mode === 'names_only') {
    return volumes.map(v => `- ${v.name}`).join('\n')
  }

  return volumes
    .map(v => {
      const desc = v.description?.trim()
      if (mode === 'full') {
        return desc ? `- ${v.name}：${desc}` : `- ${v.name}`
      }
      // compact
      if (currentVolumeId != null && v.id === currentVolumeId) {
        return `- ${v.name}（当前卷，分卷说明见下方任务，此处不重复）`
      }
      if (!desc) return `- ${v.name}`
      return `- ${v.name}：${truncateChars(desc, compactMax)}`
    })
    .join('\n')
}
