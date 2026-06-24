/** 主线草案槽位 — 分层架构 */
export const INCUBATOR_SLOT_KEYS = [
  'premise',
  'core_conflict',
  'world_rules',
  'role_engine',
  'opening',
  'ending'
] as const

export type IncubatorSlotKey = (typeof INCUBATOR_SLOT_KEYS)[number]

export const INCUBATOR_SLOT_LABELS: Record<IncubatorSlotKey, string> = {
  premise: '主题前提',
  core_conflict: '核心冲突',
  world_rules: '世界规则',
  role_engine: '角色驱动',
  opening: '开局设计',
  ending: '终局设计'
}

/**
 * 承重槽位 — 必须全部填写才能进入 DraftReady。
 * premise（主题统领）、core_conflict（核心张力）、opening（叙事起点）、ending（叙事收束）缺一不可。
 * world_rules 与 role_engine 为强推荐但非阻断（现实题材可能无世界规则）。
 */
export const INCUBATOR_REQUIRED_SLOTS: readonly IncubatorSlotKey[] = [
  'premise',
  'core_conflict',
  'opening',
  'ending'
]

/**
 * rhythm_curve 已从槽位体系降级为派生分析。
 * 5 槽全满后可自动生成，存入版本快照供下游参考，但不作为独立槽位参与门禁和状态判断。
 */
export const INCUBATOR_DERIVED_ANALYSIS_KEYS = ['rhythm_curve'] as const

export function isIncubatorSlotKey(value: string): value is IncubatorSlotKey {
  return (INCUBATOR_SLOT_KEYS as readonly string[]).includes(value)
}

export function getIncubatorSlotLabel(key: IncubatorSlotKey, workType?: string | null): string {
  const isStory = workType === 'story'
  if (isStory) {
    if (key === 'world_rules') return '背景规则'
    if (key === 'role_engine') return '反差人设'
    if (key === 'opening') return '黄金开局'
    if (key === 'ending') return '清算终局'
  }
  return INCUBATOR_SLOT_LABELS[key]
}
