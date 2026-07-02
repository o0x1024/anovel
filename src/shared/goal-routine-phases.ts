/** 目标循环创作流水线阶段（短故事与小说共用类型，各自有独立阶段顺序） */
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

/** 短故事阶段顺序 */
export const STORY_GOAL_ROUTINE_PHASE_ORDER: GoalRoutinePhase[] = [
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

/** 小说阶段顺序（跳过孵化器；先生成章节大纲再自检设定后做书名导语） */
export const NOVEL_GOAL_ROUTINE_PHASE_ORDER: GoalRoutinePhase[] = [
  'materialize_settings',
  'generate_character_cards',
  'generate_beats',
  'overall_self_check',
  'generate_title_hook',
  'draft_body',
  'goal_check',
  'repair_plan',
  'repair_execute'
]

/** 向后兼容：默认导出短故事顺序 */
export const GOAL_ROUTINE_PHASE_ORDER = STORY_GOAL_ROUTINE_PHASE_ORDER

/** 短故事阶段标签 */
export const STORY_GOAL_ROUTINE_PHASE_LABELS: Record<GoalRoutinePhase, string> = {
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

/** 小说阶段标签（generate_beats 显示为「章节大纲」） */
export const NOVEL_GOAL_ROUTINE_PHASE_LABELS: Record<GoalRoutinePhase, string> = {
  incubate_outline: '孵化大纲',
  incubator_gate: '孵化门禁',
  freeze_storyline: '冻结版本',
  materialize_settings: '核心设定',
  generate_character_cards: '主角人设卡',
  generate_title_hook: '书名导语',
  overall_self_check: '整体自检',
  generate_beats: '章节大纲',
  draft_body: '正文生成',
  goal_check: '目标验收',
  repair_plan: '修复计划',
  repair_execute: '执行修复'
}

/** 向后兼容：默认导出短故事标签 */
export const GOAL_ROUTINE_PHASE_LABELS = STORY_GOAL_ROUTINE_PHASE_LABELS

/** 按作品类型获取阶段顺序 */
export function getGoalRoutinePhaseOrder(workType?: string | null): GoalRoutinePhase[] {
  return workType === 'novel' ? NOVEL_GOAL_ROUTINE_PHASE_ORDER : STORY_GOAL_ROUTINE_PHASE_ORDER
}

/** 按作品类型获取阶段标签 */
export function getGoalRoutinePhaseLabels(workType?: string | null): Record<GoalRoutinePhase, string> {
  return workType === 'novel' ? NOVEL_GOAL_ROUTINE_PHASE_LABELS : STORY_GOAL_ROUTINE_PHASE_LABELS
}

export function isGoalRoutinePhase(value: string): value is GoalRoutinePhase {
  return (GOAL_ROUTINE_PHASE_ORDER as string[]).includes(value) ||
    (NOVEL_GOAL_ROUTINE_PHASE_ORDER as string[]).includes(value)
}

export function goalRoutinePhaseLabel(phase: string | null | undefined, workType?: string | null): string {
  if (!phase) return '-'
  const labels = getGoalRoutinePhaseLabels(workType)
  return labels[phase as GoalRoutinePhase] ?? phase
}
