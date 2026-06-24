import { INCUBATOR_SLOT_FILL_ORDER } from './incubator-analysis-prompts'
import { INCUBATOR_SLOT_LABELS, INCUBATOR_SLOT_KEYS, type IncubatorSlotKey } from './incubator-slots'
import type { IncubatorWorkspaceState } from './incubator-types'

export type IncubatorWorkflowStepId =
  | 'seed'
  | 'explore'
  | 'slots'
  | 'gate'
  | 'freeze'
  | 'settings'

export interface IncubatorWorkflowStepDef {
  id: IncubatorWorkflowStepId
  label: string
  detail: string
}

/** 页面展示的推荐操作顺序（与产品文档一致） */
export const INCUBATOR_RECOMMENDED_WORKFLOW: IncubatorWorkflowStepDef[] = [
  {
    id: 'seed',
    label: '① 创作种子',
    detail: '左栏填写故事方向并保存'
  },
  {
    id: 'explore',
    label: '② 变体 / 扩写',
    detail: '右侧「AI 分析」运行变体或扩写 → 候选池评分 → 采纳入槽'
  },
  {
    id: 'slots',
    label: '③ 六槽编排',
    detail: `按序填满六槽：${INCUBATOR_SLOT_FILL_ORDER.map(k => INCUBATOR_SLOT_LABELS[k]).join(' → ')}；可运行角色/世界/情感/终局等专属分析并采纳`
  },
  {
    id: 'gate',
    label: '④ 跨槽门禁',
    detail: '主线编排面板运行 AI 门禁评审；未通过时可点「AI 自动修复」处理阻断项，或定位到对应槽位手动修改'
  },
  {
    id: 'freeze',
    label: '⑤ 冻结统合',
    detail: 'AI 门禁通过后冻结版本；修改槽位后可再次冻结为 V2、V3…，下游核心设定自动跟最新冻结'
  },
  {
    id: 'settings',
    label: '⑥ 核心设定',
    detail: '进入下一步「核心设定」；idea 已写入统合主线，可继续生成人设/世界观等'
  }
]

export function countFilledIncubatorSlots(ws: IncubatorWorkspaceState | null): number {
  if (!ws) return 0
  const order = new Set(INCUBATOR_SLOT_KEYS)
  return ws.activeDraftSlots.filter(
    s => order.has(s.slotKey as IncubatorSlotKey) && s.content?.trim()
  ).length
}

export function nextUnfilledSlotKey(
  ws: IncubatorWorkspaceState | null
): IncubatorSlotKey | null {
  for (const key of INCUBATOR_SLOT_FILL_ORDER) {
    const row = ws?.activeDraftSlots.find(s => s.slotKey === key)
    if (!row?.content?.trim()) return key
  }
  return null
}

export function resolveIncubatorWorkflowStep(input: {
  seedText: string
  workspace: IncubatorWorkspaceState | null
}): IncubatorWorkflowStepId {
  const { seedText, workspace: ws } = input
  const hasSeed = !!(seedText.trim() || ws?.seed?.content?.trim())
  if (!hasSeed) return 'seed'

  const filled = countFilledIncubatorSlots(ws)
  const hasCandidates = (ws?.candidates?.length ?? 0) > 0
  if (filled === 0 && !hasCandidates) return 'explore'
  if (filled < INCUBATOR_SLOT_FILL_ORDER.length) return 'slots'

  if (!ws?.gateSummary?.passed) return 'gate'
  if (!ws?.latestFrozenVersion && ws?.state !== 'V1Frozen') return 'freeze'
  return 'settings'
}

export function workflowStepIndex(stepId: IncubatorWorkflowStepId): number {
  return INCUBATOR_RECOMMENDED_WORKFLOW.findIndex(s => s.id === stepId)
}
