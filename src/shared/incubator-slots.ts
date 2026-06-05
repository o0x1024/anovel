/** 主线草案槽位 */
export const INCUBATOR_SLOT_KEYS = [
  'hook',
  'core_conflict',
  'role_engine',
  'world_rules',
  'emotion_curve',
  'ending_image'
] as const

export type IncubatorSlotKey = (typeof INCUBATOR_SLOT_KEYS)[number]

export const INCUBATOR_SLOT_LABELS: Record<IncubatorSlotKey, string> = {
  hook: '前台钩子',
  core_conflict: '主冲突轴',
  role_engine: '角色驱动轴',
  world_rules: '世界规则轴',
  emotion_curve: '情感曲线轴',
  ending_image: '终局意象'
}

export function isIncubatorSlotKey(value: string): value is IncubatorSlotKey {
  return (INCUBATOR_SLOT_KEYS as readonly string[]).includes(value)
}
