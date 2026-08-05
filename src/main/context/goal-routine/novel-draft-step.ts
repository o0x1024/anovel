export type NovelDraftWorkflowStep =
  | 'causal_state_init'
  | 'chapter_decision'
  | 'body_generation'
  | 'body_acceptance'
  | 'precommit_artifacts'
  | 'chapter_commit'

export const NOVEL_DRAFT_WORKFLOW_STEP_LABELS: Record<NovelDraftWorkflowStep, string> = {
  causal_state_init: '权威因果状态初始化',
  chapter_decision: '章级因果决策',
  body_generation: '正文生成',
  body_acceptance: '章节硬合同验收',
  precommit_artifacts: '叙事记忆与因果结果预提交',
  chapter_commit: '记忆与因果原子提交'
}

export function novelDraftWorkflowStepLabel(step: NovelDraftWorkflowStep): string {
  return NOVEL_DRAFT_WORKFLOW_STEP_LABELS[step]
}

export function resolveNovelDraftWorkflowStep(input: {
  hasCausalState: boolean
  decisionReady: boolean
  needsGeneration: boolean
  needsAcceptance: boolean
  precommitReady: boolean
}): NovelDraftWorkflowStep {
  if (!input.hasCausalState) return 'causal_state_init'
  if (!input.decisionReady) return 'chapter_decision'
  if (input.needsGeneration) return 'body_generation'
  if (input.needsAcceptance) return 'body_acceptance'
  if (!input.precommitReady) return 'precommit_artifacts'
  return 'chapter_commit'
}
