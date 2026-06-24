import type { InjectionKey, Ref } from 'vue'

export type WorkflowStepKey = 'incubator' | 'settings' | 'volumes' | 'chapters' | 'generate'

export type StepStatus = 'pending' | 'ready' | 'review' | 'done'

export type QualitySeverity = 'none' | 'advisory' | 'blocking'
export type QualityVerdict = 'pass' | 'review' | 'fail'

/** 与写作技巧「优秀 / 及格 / 不合格」对齐的 UI 文案（内部仍用 none/advisory/blocking） */
export const QUALITY_SEVERITY_LEGEND =
  '优秀：推动剧情·可开写 · 及格：服务剧情·待优化 · 不合格：结构矛盾·须修复'

export function qualitySeverityLabel(severity?: QualitySeverity): string {
  if (severity === 'blocking') return '不合格'
  if (severity === 'advisory') return '及格'
  if (severity === 'none') return '优秀'
  return ''
}

export function qualitySeverityTitle(severity?: QualitySeverity): string {
  if (severity === 'blocking') return '结构矛盾或毒点级问题，须修复'
  if (severity === 'advisory') return '及格线：为剧情服务，可按建议优化'
  if (severity === 'none') return '优秀：逻辑自洽，可开写'
  return ''
}

export function formatQualityBlockingCount(count: number): string {
  return count > 0 ? `不合格 ${count}` : ''
}

export function formatQualityAdvisoryCount(count: number): string {
  return count > 0 ? `及格·待优化 ${count}` : ''
}

export interface SettingsQualityStatus {
  hasOverallCheck: boolean
  isStale: boolean
  needsReview: boolean
  canProceed: boolean
  checkedAt: string | null
  staleReason: string | null
  unresolvedIssues: string[]
  overallScore: number | null
  blockingCount: number
  advisoryCount: number
  verdict: QualityVerdict | null
  reviseRound: number
  maxReviseRounds: number
  convergenceStalled: boolean
  manuallyAccepted: boolean
  canReviseBlocking: boolean
  canReviseAdvisory: boolean
  advisoryOptimizeCount: number
  meetsPassCriteria: boolean
}

export interface WorkStepProgress {
  steps: Record<WorkflowStepKey, StepStatus>
  hints: Partial<Record<WorkflowStepKey, string>>
  completionPercent: number
  settingsQuality?: SettingsQualityStatus
}

export interface EditorNav {
  goToStep: (key: WorkflowStepKey) => void
  goToPanel?: (key: string) => void
  refreshProgress: () => Promise<void>
  stepProgress: Ref<WorkStepProgress | null>
  quickIdeaTrigger: Ref<number>
}

export const editorNavKey: InjectionKey<EditorNav> = Symbol('editorNav')

export const NEXT_STEP_LABELS: Record<WorkflowStepKey, string> = {
  incubator: '进入核心设定',
  settings: '进入分卷大纲',
  volumes: '进入章节情节',
  chapters: '进入正文生成',
  generate: ''
}

export function getWorkflowStepOrder(workType?: string | null): WorkflowStepKey[] {
  if (workType === 'story') {
    return ['incubator', 'settings', 'chapters', 'generate']
  }
  return ['incubator', 'settings', 'volumes', 'chapters', 'generate']
}

export function getNextStepLabel(current: WorkflowStepKey, workType?: string | null): string {
  if (workType === 'story') {
    if (current === 'settings') return '进入节拍大纲'
    if (current === 'chapters') return '进入正文生成'
  }
  return NEXT_STEP_LABELS[current]
}

export function getNextStep(current: WorkflowStepKey, workType?: string | null): WorkflowStepKey | null {
  const order = getWorkflowStepOrder(workType)
  const idx = order.indexOf(current)
  return idx >= 0 && idx < order.length - 1
    ? order[idx + 1]
    : null
}

export const STEP_MENU_LABELS: Record<WorkflowStepKey, string> = {
  incubator: '大岗孵化',
  settings: '核心设定',
  volumes: '分卷大纲',
  chapters: '章节情节',
  generate: '正文生成'
}

export function getStepMenuLabel(step: WorkflowStepKey, workType?: string | null): string {
  if (workType === 'story' && step === 'chapters') return '节拍大纲'
  return STEP_MENU_LABELS[step]
}
