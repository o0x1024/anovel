/** 主线草案槽位 — 分层架构 */

/** 全部可能的槽位 key（小说与短故事的并集） */
export type IncubatorSlotKey =
  | 'premise'
  | 'core_conflict'
  | 'world_rules'
  | 'role_engine'
  | 'opening'
  | 'ending'
  | 'rhythm_ending'

/** 小说向 6 槽 */
export const NOVEL_SLOT_KEYS = [
  'premise',
  'core_conflict',
  'world_rules',
  'role_engine',
  'opening',
  'ending'
] as const

/** 短故事向 5 槽（合并 rhythm_curve + ending → rhythm_ending，移除 world_rules） */
export const STORY_SLOT_KEYS = [
  'premise',
  'core_conflict',
  'opening',
  'role_engine',
  'rhythm_ending'
] as const

/** 向后兼容：小说向槽位全集（等同于 NOVEL_SLOT_KEYS） */
export const INCUBATOR_SLOT_KEYS = NOVEL_SLOT_KEYS

/** 全部槽位 key 的超集（用于类型校验和文本解析） */
export const ALL_SLOT_KEYS: readonly IncubatorSlotKey[] = [...NOVEL_SLOT_KEYS, ...STORY_SLOT_KEYS]

export const INCUBATOR_SLOT_LABELS: Record<IncubatorSlotKey, string> = {
  premise: '主题前提',
  core_conflict: '核心冲突',
  world_rules: '世界规则',
  role_engine: '角色驱动',
  opening: '开局设计',
  ending: '终局设计',
  rhythm_ending: '节奏与清算'
}

/**
 * 小说承重槽位 — 必须全部填写才能进入 DraftReady。
 * premise、core_conflict、opening、ending 缺一不可。
 * world_rules 与 role_engine 为强推荐但非阻断。
 */
export const INCUBATOR_REQUIRED_SLOTS: readonly IncubatorSlotKey[] = [
  'premise',
  'core_conflict',
  'opening',
  'ending'
]

/**
 * 短故事承重槽位 — 4 个必填（role_engine 选填）。
 */
export const STORY_REQUIRED_SLOTS: readonly IncubatorSlotKey[] = [
  'premise',
  'core_conflict',
  'opening',
  'rhythm_ending'
]

/** 按作品类型获取槽位列表 */
export function getSlotKeysForWorkType(workType?: string | null): readonly IncubatorSlotKey[] {
  return workType === 'story' ? STORY_SLOT_KEYS : NOVEL_SLOT_KEYS
}

/** 按作品类型获取承重槽位 */
export function getRequiredSlotsForWorkType(workType?: string | null): readonly IncubatorSlotKey[] {
  return workType === 'story' ? STORY_REQUIRED_SLOTS : INCUBATOR_REQUIRED_SLOTS
}

/**
 * rhythm_curve 已从槽位体系降级为派生分析（小说向）。
 * 短故事向已将其合并入 rhythm_ending 槽位。
 */
export const INCUBATOR_DERIVED_ANALYSIS_KEYS = ['rhythm_curve'] as const

export function isIncubatorSlotKey(value: string): value is IncubatorSlotKey {
  return (ALL_SLOT_KEYS as readonly string[]).includes(value)
}

export function getIncubatorSlotLabel(key: IncubatorSlotKey, workType?: string | null): string {
  if (workType === 'story') {
    if (key === 'premise') return '情绪定位'
    if (key === 'core_conflict') return '核心冲突'
    if (key === 'role_engine') return '反差人设'
    if (key === 'opening') return '黄金开局'
    if (key === 'rhythm_ending') return '节奏与清算'
    if (key === 'world_rules') return '背景规则'
    if (key === 'ending') return '清算终局'
    return INCUBATOR_SLOT_LABELS[key]
  }
  // 网文向 — 与 AI 分析按钮名称对齐
  if (key === 'premise') return '爽点公式定位'
  if (key === 'core_conflict') return '套路变体'
  if (key === 'world_rules') return '世界体系'
  if (key === 'role_engine') return '人设标签'
  if (key === 'opening') return '黄金开局'
  if (key === 'ending') return '爽点终局'
  if (key === 'rhythm_ending') return '节奏与清算'
  return INCUBATOR_SLOT_LABELS[key]
}
