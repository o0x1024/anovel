/** 主线草案槽位 */
export const INCUBATOR_SLOT_KEYS = [
  'core_conflict',
  'hook',
  'world_rules',
  'role_engine',
  'rhythm_curve',
  'ending_structure'
] as const

export type IncubatorSlotKey = (typeof INCUBATOR_SLOT_KEYS)[number]

export const INCUBATOR_SLOT_LABELS: Record<IncubatorSlotKey, string> = {
  core_conflict: '主冲突轴',
  hook: '前台钩子',
  world_rules: '世界规则轴',
  role_engine: '角色驱动轴',
  rhythm_curve: '节奏曲线轴',
  ending_structure: '终局结构'
}

export function isIncubatorSlotKey(value: string): value is IncubatorSlotKey {
  return (INCUBATOR_SLOT_KEYS as readonly string[]).includes(value)
}

export function getIncubatorSlotLabel(key: IncubatorSlotKey, workType?: string | null): string {
  const isStory = workType === 'story'
  if (isStory) {
    if (key === 'world_rules') return '背景规则轴'
    if (key === 'role_engine') return '反差人设轴'
    if (key === 'rhythm_curve') return '极速节奏曲线'
    if (key === 'ending_structure') return '清算终局结构'
  }
  return INCUBATOR_SLOT_LABELS[key]
}
