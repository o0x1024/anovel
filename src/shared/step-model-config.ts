export interface StepDef {
  step: string
  label: string
}

export interface StepModelGroupDef {
  groupLabel: string
  steps: StepDef[]
}

export const STEP_MODEL_GROUPS: StepModelGroupDef[] = [
  {
    groupLabel: '大纲孵化',
    steps: [
      { step: 'incubator_premise', label: '爽点公式' },
      { step: 'incubator_variants', label: '套路变体' },
      { step: 'incubator_expand', label: '黄金开局' },
      { step: 'incubator_role_engine', label: '角色引擎' },
      { step: 'incubator_world_rules', label: '世界规则' },
      { step: 'incubator_rhythm_curve', label: '节奏曲线' },
      { step: 'incubator_ending', label: '结局设计' },
      { step: 'incubator_diagnose', label: '爆款诊断' },
      { step: 'incubator_reverse', label: '反转设计' },
      { step: 'incubator_anchors', label: '锚点提取' },
      { step: 'incubator_benchmark', label: '对标分析' },
      { step: 'incubator_tone', label: '基调设计' },
      { step: 'incubator_frontstory', label: '前情提要' },
      { step: 'incubator_microinnovation', label: '微创新' },
      { step: 'incubator_rhythm_ending', label: '节奏结局' },
      { step: 'incubator_title_intro', label: '标题简介' },
      { step: 'incubator_tweak', label: '故事线微调' },
      { step: 'incubator_diagnose_apply', label: '诊断修复' },
      { step: 'incubator_synthesize_freeze', label: '综合冻结' },
      { step: 'incubator_gate_check', label: '关卡检测' },
      { step: 'incubator_gate_fix', label: '关卡修复' },
    ]
  },
  {
    groupLabel: '核心设定',
    steps: [
      { step: 'settings_protagonist', label: '主角设计' },
      { step: 'settings_golden_finger', label: '金手指' },
      { step: 'settings_pleasure_engine', label: '爽点引擎' },
      { step: 'settings_world_pressure', label: '世界压力' },
      { step: 'settings_conflict_engine', label: '冲突引擎' },
      { step: 'settings_supporting_cast', label: '配角设计' },
      { step: 'settings_main_plotline', label: '主线设定' },
      { step: 'settings_worldview', label: '世界观' },
      { step: 'settings_overall_check', label: '整体检查' },
      { step: 'settings_character_check', label: '角色检查' },
      { step: 'settings_character_cards_revise', label: '角色卡修订' },
      { step: 'settings_anchors_revise', label: '锚点修订' },
      { step: 'settings_conflict_coverage_suggest', label: '冲突覆盖建议' },
      { step: 'character_cards_generate', label: '角色卡生成' },
    ]
  },
  {
    groupLabel: '大纲 & 章节',
    steps: [
      { step: 'volume_chapters_batch', label: '章节批量生成' },
      { step: 'volume_diagnose', label: '分卷诊断' },
      { step: 'volume_diagnose_fix', label: '分卷修复' },
      { step: 'story_title_hook_gen', label: '短故事标题与钩子' },
      { step: 'novel_title_hook_gen', label: '小说标题与钩子' },
    ]
  },
  {
    groupLabel: '正文生成',
    steps: [
      { step: 'body_generation', label: '正文生成' },
      { step: 'body_style_rewrite', label: '风格重写' },
      { step: 'lab_deai', label: '去 AI 重写' },
    ]
  },
  {
    groupLabel: 'AI 诊断',
    steps: [
      { step: 'quality_diagnosis_ai', label: 'AI 质量诊断' },
      { step: 'critique_dual_channel', label: '双通道批判' },
      { step: 'critique_apply_fixes', label: '批判修复' },
      { step: 'milestone_audit_scan', label: '里程碑审计' },
      { step: 'milestone_audit_deep', label: '深度审计' },
      { step: 'milestone_audit_fix', label: '审计修复' },
    ]
  },
  {
    groupLabel: '叙事记忆',
    steps: [
      { step: 'memory_extract', label: '记忆提取' },
      { step: 'foreshadowing_resolve', label: '伏笔回收' },
      { step: 'timeline_generate', label: '时间线生成' },
      { step: 'anchor_auto_match', label: '锚点匹配' },
    ]
  },
  {
    groupLabel: '写作辅助',
    steps: [
      { step: 'writer_block_inspiration', label: '灵感激发' },
      { step: 'writer_block_directions', label: '方向建议' },
      { step: 'writer_block_whatif', label: 'What If' },
      { step: 'revision_checklist', label: '修订清单' },
      { step: 'anti_mean_surprise', label: '反套路惊喜' },
      { step: 'anti_mean_disruptor', label: '反套路破局' },
      { step: 'anti_mean_genre', label: '反套路类型' },
    ]
  },
  {
    groupLabel: '目标循环',
    steps: [
      { step: 'goal_slot_candidate_score', label: '候选评分' },
      { step: 'goal_semantic_check', label: '语义检查' },
    ]
  },
  {
    groupLabel: '其他',
    steps: [
      { step: 'assistant_chat', label: 'AI 助手对话' },
    ]
  }
]

export function getAllStepDefs(): StepDef[] {
  return STEP_MODEL_GROUPS.flatMap(g => g.steps)
}

export function getStepLabel(step: string): string {
  for (const group of STEP_MODEL_GROUPS) {
    const found = group.steps.find(s => s.step === step)
    if (found) return found.label
  }
  return step
}

/** 仅正文生成采纳作品「正文模型槽位」（正文工作台 / 目标循环正文配置） */
export const WORK_BODY_SLOT_STEPS = new Set(['body_generation'])

/**
 * 采纳调用方显式传入的模型（诊断槽位、助手选模等），非正文槽位。
 * 风格重写、去 AI 重写、批判修复等走「步骤模型分配 → 全局默认」，不在此列。
 */
export const EXPLICIT_REQUEST_MODEL_STEPS = new Set([
  'quality_diagnosis_ai',
  'critique_dual_channel',
  'assistant_chat'
])

/** 会采纳请求 modelType/modelName 的全部 step（正文槽位 + 显式传入） */
export const REQUEST_MODEL_STEPS = new Set([
  ...WORK_BODY_SLOT_STEPS,
  ...EXPLICIT_REQUEST_MODEL_STEPS
])

export function stepAcceptsWorkBodySlotModel(step?: string): boolean {
  return !!step && WORK_BODY_SLOT_STEPS.has(step)
}

export function stepAcceptsRequestModel(step?: string): boolean {
  return !!step && REQUEST_MODEL_STEPS.has(step)
}
