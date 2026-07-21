/** 目标循环创作流水线阶段（短故事与小说共用类型，各自有独立阶段顺序） */
export type GoalRoutinePhase =
  | 'incubate_outline'
  | 'incubator_gate'
  | 'freeze_storyline'
  | 'materialize_settings'
  | 'generate_character_cards'
  | 'story_engine_gate'
  | 'emotion_engine_gate'
  | 'generate_title_hook'
  | 'overall_self_check'
  | 'generate_volumes'
  | 'generate_beats'
  | 'draft_body'
  | 'goal_check'
  | 'repair_plan'
  | 'repair_execute'

/** 短故事阶段顺序 */
export const STORY_GOAL_ROUTINE_PHASE_ORDER: GoalRoutinePhase[] = [
  'materialize_settings',
  'generate_character_cards',
  'story_engine_gate',
  'emotion_engine_gate',
  'generate_beats',
  'generate_title_hook',
  'overall_self_check',
  'draft_body',
  'goal_check',
  'repair_plan',
  'repair_execute'
]

/** 小说阶段顺序；运行器会在章节情节与正文之间按卷往返，数组仅用于界面排序。 */
export const NOVEL_GOAL_ROUTINE_PHASE_ORDER: GoalRoutinePhase[] = [
  'materialize_settings',
  'generate_character_cards',
  'emotion_engine_gate',
  'overall_self_check',
  'generate_volumes',
  'generate_beats',
  'generate_title_hook',
  'draft_body',
  'goal_check',
  'repair_plan',
  'repair_execute'
]

/** 因果小说只保留状态初始化、下一章决策、正文事务和终局验收。 */
export const CAUSAL_NOVEL_GOAL_ROUTINE_PHASE_ORDER: GoalRoutinePhase[] = [
  'materialize_settings',
  'generate_beats',
  'draft_body',
  'goal_check'
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
  story_engine_gate: '故事发动机',
  emotion_engine_gate: '情绪发动机',
  generate_title_hook: '书名导语',
  overall_self_check: '整体自检',
  generate_volumes: '分卷大纲',
  generate_beats: '节拍大纲',
  draft_body: '正文生成',
  goal_check: '目标验收',
  repair_plan: '修复计划',
  repair_execute: '执行修复'
}

/** 小说阶段标签与小说管理的创作步骤文案保持一致 */
export const NOVEL_GOAL_ROUTINE_PHASE_LABELS: Record<GoalRoutinePhase, string> = {
  incubate_outline: '孵化大纲',
  incubator_gate: '孵化门禁',
  freeze_storyline: '冻结版本',
  materialize_settings: '核心设定',
  generate_character_cards: '主角人设卡',
  story_engine_gate: '故事发动机',
  emotion_engine_gate: '情绪发动机',
  generate_title_hook: '书名导语',
  overall_self_check: '整体自检',
  generate_volumes: '分卷大纲',
  generate_beats: '章节情节',
  draft_body: '正文生成',
  goal_check: '目标验收',
  repair_plan: '修复计划',
  repair_execute: '执行修复'
}

export const CAUSAL_NOVEL_GOAL_ROUTINE_PHASE_LABELS: Record<GoalRoutinePhase, string> = {
  ...NOVEL_GOAL_ROUTINE_PHASE_LABELS,
  materialize_settings: '权威状态初始化',
  generate_beats: '下一章因果决策',
  draft_body: '正文与状态事务',
  goal_check: '终止条件与整书验收'
}

/** 向后兼容：默认导出短故事标签 */
export const GOAL_ROUTINE_PHASE_LABELS = STORY_GOAL_ROUTINE_PHASE_LABELS

/** 按作品类型获取阶段顺序 */
export function getGoalRoutinePhaseOrder(workType?: string | null): GoalRoutinePhase[] {
  if (workType === 'causal_novel') return CAUSAL_NOVEL_GOAL_ROUTINE_PHASE_ORDER
  return workType === 'novel' ? NOVEL_GOAL_ROUTINE_PHASE_ORDER : STORY_GOAL_ROUTINE_PHASE_ORDER
}

/** 按作品类型获取阶段标签 */
export function getGoalRoutinePhaseLabels(workType?: string | null): Record<GoalRoutinePhase, string> {
  if (workType === 'causal_novel') return CAUSAL_NOVEL_GOAL_ROUTINE_PHASE_LABELS
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
