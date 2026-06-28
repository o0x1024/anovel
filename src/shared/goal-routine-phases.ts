/** 目标循环创作流水线阶段（与 story-goal-routine 状态机一致） */
export type GoalRoutinePhase =
  | 'incubate_outline'
  | 'incubator_gate'
  | 'freeze_storyline'
  | 'materialize_settings'
  | 'generate_character_cards'
  | 'generate_title_hook'
  | 'overall_self_check'
  | 'generate_beats'
  | 'draft_body'
  | 'goal_check'
  | 'repair_plan'
  | 'repair_execute'

export const GOAL_ROUTINE_PHASE_ORDER: GoalRoutinePhase[] = [
  'incubate_outline',
  'incubator_gate',
  'freeze_storyline',
  'materialize_settings',
  'generate_character_cards',
  'generate_title_hook',
  'overall_self_check',
  'generate_beats',
  'draft_body',
  'goal_check',
  'repair_plan',
  'repair_execute'
]

export const GOAL_ROUTINE_PHASE_LABELS: Record<GoalRoutinePhase, string> = {
  incubate_outline: '孵化大纲',
  incubator_gate: '孵化门禁',
  freeze_storyline: '冻结版本',
  materialize_settings: '核心设定',
  generate_character_cards: '主角人设卡',
  generate_title_hook: '书名导语',
  overall_self_check: '整体自检',
  generate_beats: '节拍大纲',
  draft_body: '正文生成',
  goal_check: '目标验收',
  repair_plan: '修复计划',
  repair_execute: '执行修复'
}

export function isGoalRoutinePhase(value: string): value is GoalRoutinePhase {
  return (GOAL_ROUTINE_PHASE_ORDER as string[]).includes(value)
}

export function goalRoutinePhaseLabel(phase: string | null | undefined): string {
  if (!phase) return '-'
  return isGoalRoutinePhase(phase) ? GOAL_ROUTINE_PHASE_LABELS[phase] : phase
}
