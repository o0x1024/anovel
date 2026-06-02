import { coreSettingDAO } from '../db'
import type { WorkContextResult } from './work-context'
import { formatQualityIssuesForGeneration } from './settings-quality'

export type CoreSettingGenerateType = 'character' | 'worldview' | 'conflict'

/** 设定 AI 生成时保留的孵化器产出（对齐 plan 步骤2：方向 + 锚点，不含诊断/对标等长文） */
export const SETTINGS_GENERATION_INCUBATOR_TYPES = [
  'incubator_expand',
  'incubator_frontstory',
  'incubator_tone',
  'incubator_microinnovation'
] as const

const SETTING_LABELS: Record<string, string> = {
  idea: '故事方向',
  character: '人设',
  worldview: '世界观',
  conflict: '核心冲突',
  incubator_expand: '方向扩写',
  incubator_frontstory: '前台故事',
  incubator_tone: '情感基调',
  incubator_microinnovation: '微创新分析'
}

const CORE_DEPENDENCIES: Record<CoreSettingGenerateType, CoreSettingGenerateType[]> = {
  character: [],
  worldview: ['character'],
  conflict: ['character', 'worldview']
}

const DEFAULT_MAX_INCUBATOR_CHARS = 3500
const DEFAULT_MAX_DEPENDENCY_CHARS = 2800

export interface SettingsGenerationContextOptions {
  /** 用户正在编辑的当前项草稿（修订模式） */
  selfDraft?: string
  maxIncubatorChars?: number
  maxDependencyChars?: number
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n…（已截断，完整内容请在编辑器中查看）`
}

/**
 * 核心设定「AI 生成」专用上下文：仅注入故事方向、精简孵化器与依赖项设定。
 */
export function buildSettingsGenerationContext(
  workId: number,
  targetType: CoreSettingGenerateType,
  options: SettingsGenerationContextOptions = {}
): WorkContextResult {
  const maxIncubator = options.maxIncubatorChars ?? DEFAULT_MAX_INCUBATOR_CHARS
  const maxDependency = options.maxDependencyChars ?? DEFAULT_MAX_DEPENDENCY_CHARS

  const settings = coreSettingDAO.listByWork(workId)
  const byType = new Map(settings.map(s => [s.type, s.content]))
  const sections: Record<string, string> = {}

  const idea = byType.get('idea')?.trim()
  if (idea) sections[SETTING_LABELS.idea] = idea

  for (const type of SETTINGS_GENERATION_INCUBATOR_TYPES) {
    const content = byType.get(type)?.trim()
    if (content) {
      sections[SETTING_LABELS[type] || type] = truncate(content, maxIncubator)
    }
  }

  for (const depType of CORE_DEPENDENCIES[targetType]) {
    const content = byType.get(depType)?.trim()
    if (content) {
      sections[SETTING_LABELS[depType]] = truncate(content, maxDependency)
    }
  }

  const selfDraft = options.selfDraft?.trim()
  if (selfDraft) {
    sections[`当前${SETTING_LABELS[targetType]}草稿`] = [
      '（请在现有草稿基础上优化与补全，勿整段重复已有结构）',
      truncate(selfDraft, maxDependency)
    ].join('\n\n')
  }

  const qualityText = formatQualityIssuesForGeneration(workId)
  if (qualityText) sections['设定自检约束'] = qualityText

  if (Object.keys(sections).length === 0) {
    return { text: '', sections: {} }
  }

  const text = [
    '【核心设定生成上下文】',
    ...Object.entries(sections).map(([label, content]) => `## ${label}\n${content}`)
  ].join('\n\n')

  return { text, sections }
}
