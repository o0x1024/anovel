/**
 * 核心设定类型定义（V3 重构）
 *
 * 从网文第一性原理出发，将核心设定重组为 6 类：
 * 主角设计 → 金手指 → 世界观压力 → 冲突升级 → 爽点机制 → 配角功能组
 */

export const CORE_SETTING_TYPES = [
  'protagonist',
  'golden_finger',
  'pleasure_engine',
  'world_pressure',
  'conflict_engine',
  'supporting_cast'
] as const

export type CoreSettingType = (typeof CORE_SETTING_TYPES)[number]

/** 旧类型 → 新类型映射（数据迁移用） */
export const LEGACY_TO_NEW_TYPE: Record<string, CoreSettingType> = {
  character: 'supporting_cast',
  worldview: 'world_pressure',
  conflict: 'conflict_engine'
}

export const CORE_SETTING_LABELS: Record<CoreSettingType, string> = {
  protagonist: '主角设计',
  golden_finger: '金手指系统',
  pleasure_engine: '爽点机制',
  world_pressure: '世界观压力规则',
  conflict_engine: '冲突升级引擎',
  supporting_cast: '配角功能组'
}

export const STORY_SETTING_LABELS: Record<CoreSettingType, string> = {
  protagonist: '主角与反差设定',
  golden_finger: '核心钩子与信息差',
  pleasure_engine: '情绪节奏与爽点',
  world_pressure: '世界观压力规则',
  conflict_engine: '冲突升级引擎',
  supporting_cast: '功能性配角'
}

export function getCoreSettingLabel(type: CoreSettingType, isStory: boolean): string {
  return isStory ? STORY_SETTING_LABELS[type] : CORE_SETTING_LABELS[type]
}

export const CORE_SETTING_ICONS: Record<CoreSettingType, string> = {
  protagonist: 'crown',
  golden_finger: 'star',
  pleasure_engine: 'fire',
  world_pressure: 'scale-balanced',
  conflict_engine: 'arrows-spin',
  supporting_cast: 'users'
}

export const CORE_SETTING_DESCRIPTIONS: Record<CoreSettingType, string> = {
  protagonist: '主角的身份标签、核心欲望、性格驱动力、致命缺陷、决策模式与魅力点',
  golden_finger: '核心能力的名称形态、限制条件、反噬机制、升级路径与信息差优势',
  pleasure_engine: '主要爽点类型、触发条件、频率设计、对抗设计与情绪节奏锚点',
  world_pressure: '核心铁律、权力结构、资源稀缺性、规则代价与对主角的压迫升级路径',
  conflict_engine: '对立双方的价值观冲突、不可调和点、三层赌注、升级机制与终局收束',
  supporting_cast: '按催化剂/对照组/阻力/情感锚/信息/喜剧六种功能组织的配角群'
}

/** AI 生成时的依赖链：后面的类型依赖前面的类型 */
export const CORE_SETTING_DEPENDENCIES: Record<CoreSettingType, CoreSettingType[]> = {
  protagonist: [],
  golden_finger: ['protagonist'],
  pleasure_engine: ['protagonist', 'golden_finger', 'conflict_engine'],
  world_pressure: ['protagonist', 'golden_finger'],
  conflict_engine: ['protagonist', 'world_pressure'],
  supporting_cast: ['protagonist', 'conflict_engine']
}

/** 推荐填充顺序 */
export const CORE_SETTING_FILL_ORDER: CoreSettingType[] = [
  'protagonist',
  'golden_finger',
  'world_pressure',
  'conflict_engine',
  'pleasure_engine',
  'supporting_cast'
]

/** 可独立生成（不依赖其他设定）的类型 */
export const INDEPENDENT_TYPES: CoreSettingType[] = ['protagonist']

/** 依赖主线孵化器上下文（生成时须注入 frozen storyline）的类型 */
export function isCoreSettingType(value: string): value is CoreSettingType {
  return (CORE_SETTING_TYPES as readonly string[]).includes(value)
}

/** AI 生成步骤名 */
export function settingGenStep(type: CoreSettingType): string {
  return `settings_${type}`
}

/** 用户生成提示持久化 key */
export function settingGenHintsPreferenceKey(workId: number, type: CoreSettingType | 'character_cards'): string {
  return `settings_${type}_gen_hints:${workId}`
}

export function settingWorldviewGenreDetectModePreferenceKey(workId: number): string {
  return `settings_worldview_genre_detect_mode:${workId}`
}
