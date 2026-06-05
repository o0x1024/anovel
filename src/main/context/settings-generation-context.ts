import { coreSettingDAO } from '../db'
import type { WorkContextResult } from './work-context'
import { formatQualityIssuesForGeneration } from './settings-quality'
import {
  buildFrozenStorylineContext,
  buildStorylineContextFromIdea,
  CHARACTER_SETTING_SLOT_KEYS
} from './incubator/build-storyline-context'

export type CoreSettingGenerateType = 'character' | 'worldview' | 'conflict'

const SETTING_LABELS: Record<string, string> = {
  idea: '故事方向',
  character: '人设',
  worldview: '世界观',
  conflict: '核心冲突'
}

const CORE_DEPENDENCIES: Record<CoreSettingGenerateType, CoreSettingGenerateType[]> = {
  character: [],
  worldview: ['character'],
  conflict: ['character', 'worldview']
}

export interface SettingsGenerationContextOptions {
  /** 用户正在编辑的当前项草稿（修订模式） */
  selfDraft?: string
  /** 人设等生成时用户补充约束（姓名、禁忌等），注入 prompt 不写入设定正文 */
  userHints?: string
}

export function characterGenHintsPreferenceKey(workId: number): string {
  return `settings_character_gen_hints:${workId}`
}

function buildCharacterStorylineContext(workId: number, ideaRaw?: string): string {
  const fromFrozen = buildFrozenStorylineContext(workId, {
    includeSlots: true,
    slotKeys: CHARACTER_SETTING_SLOT_KEYS
  })
  if (fromFrozen) return fromFrozen

  if (ideaRaw) {
    return buildStorylineContextFromIdea(ideaRaw, {
      includeSlots: true,
      slotKeys: CHARACTER_SETTING_SLOT_KEYS
    })
  }
  return ''
}

function buildDownstreamStorylineContext(workId: number, ideaRaw?: string): string {
  const fromFrozen = buildFrozenStorylineContext(workId, { includeSlots: true })
  if (fromFrozen) return fromFrozen

  if (ideaRaw) {
    return buildStorylineContextFromIdea(ideaRaw, { includeSlots: true })
  }
  return ''
}

/**
 * 核心设定「AI 生成」专用上下文。
 * - 人设：统合摘要 + 角色相关槽位（优先冻结快照）
 * - 世界观/冲突：统合摘要 + 六槽 + 依赖设定
 * 不注入孵化器 incubator_* 分析原文、质量评分卡、文风约束。
 */
export function buildSettingsGenerationContext(
  workId: number,
  targetType: CoreSettingGenerateType,
  options: SettingsGenerationContextOptions = {}
): WorkContextResult {
  const settings = coreSettingDAO.listByWork(workId)
  const byType = new Map(settings.map(s => [s.type, s.content]))
  const sections: Record<string, string> = {}

  const ideaRaw = byType.get('idea')?.trim()

  if (targetType === 'character') {
    const storyline = buildCharacterStorylineContext(workId, ideaRaw)
    if (storyline) sections[SETTING_LABELS.idea] = storyline
  } else {
    const storyline = buildDownstreamStorylineContext(workId, ideaRaw)
    if (storyline) {
      sections['主线故事线'] = storyline
    }
  }

  for (const depType of CORE_DEPENDENCIES[targetType]) {
    const content = byType.get(depType)?.trim()
    if (content) {
      sections[SETTING_LABELS[depType]] = content
    }
  }

  const userHints = options.userHints?.trim()
  if (userHints) {
    sections['用户补充要求'] = userHints
  }

  const selfDraft = options.selfDraft?.trim()
  if (selfDraft) {
    sections[`当前${SETTING_LABELS[targetType]}草稿`] = [
      '（请在现有草稿基础上优化与补全，勿整段重复已有结构）',
      selfDraft
    ].join('\n\n')
  }

  if (targetType !== 'character') {
    const qualityText = formatQualityIssuesForGeneration(workId)
    if (qualityText) sections['设定自检约束'] = qualityText
  }

  if (Object.keys(sections).length === 0) {
    return { text: '', sections: {} }
  }

  const text = [
    '【核心设定生成上下文】',
    ...Object.entries(sections).map(([label, content]) => `## ${label}\n${content}`)
  ].join('\n\n')

  return { text, sections }
}
