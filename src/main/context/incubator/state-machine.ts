import type { IncubatorWorkflowState } from '../../../shared/incubator-types'
import { getRequiredSlotsForWorkType, type IncubatorSlotKey } from '../../../shared/incubator-slots'

const ALLOWED: Record<IncubatorWorkflowState, IncubatorWorkflowState[]> = {
  SeedReady: ['CandidatesGenerated', 'Composing'],
  CandidatesGenerated: ['CandidatesEvaluated', 'Composing', 'SeedReady'],
  CandidatesEvaluated: ['Composing', 'CandidatesGenerated'],
  Composing: ['DraftReady', 'CandidatesEvaluated', 'V1Frozen'],
  DraftReady: ['GateChecking', 'Composing', 'V1Frozen'],
  GateChecking: ['V1Frozen', 'DraftReady', 'Composing'],
  V1Frozen: ['Composing', 'GateChecking']
}

export function canTransition(from: IncubatorWorkflowState, to: IncubatorWorkflowState): boolean {
  if (from === to) return true
  return ALLOWED[from]?.includes(to) ?? false
}

export function assertTransition(from: IncubatorWorkflowState, to: IncubatorWorkflowState): void {
  if (!canTransition(from, to)) {
    throw new Error(`不允许的状态迁移：${from} → ${to}`)
  }
}

/**
 * 判断是否满足 DraftReady 条件：所有承重槽位均已填写。
 * 小说向：premise/core_conflict/opening/ending
 * 短故事向：premise/core_conflict/opening/rhythm_ending
 */
export function isDraftReady(filledSlotKeys: IncubatorSlotKey[], workType?: string | null): boolean {
  const filled = new Set(filledSlotKeys)
  return getRequiredSlotsForWorkType(workType).every(k => filled.has(k))
}

export function inferStateAfterAdopt(
  filledSlots: number,
  filledSlotKeys?: IncubatorSlotKey[],
  workType?: string | null
): IncubatorWorkflowState {
  if (filledSlotKeys && isDraftReady(filledSlotKeys, workType)) return 'DraftReady'
  if (filledSlotKeys && getRequiredSlotsForWorkType(workType).every(k => filledSlotKeys.includes(k))) return 'DraftReady'
  return 'Composing'
}

/** 采纳/改槽后按状态机允许的中间态依次迁移（避免 CandidatesGenerated → DraftReady 等非法直跳） */
export function resolveStatePathAfterAdopt(
  from: IncubatorWorkflowState,
  filledSlots: number,
  filledSlotKeys?: IncubatorSlotKey[],
  workType?: string | null
): IncubatorWorkflowState[] {
  const target = inferStateAfterAdopt(filledSlots, filledSlotKeys, workType)
  if (from === target) return []

  const path: IncubatorWorkflowState[] = []
  let current = from

  if (target === 'DraftReady' && !canTransition(current, 'DraftReady')) {
    if (canTransition(current, 'Composing')) {
      path.push('Composing')
      current = 'Composing'
    }
  }

  if (target !== current && canTransition(current, target)) {
    path.push(target)
  } else if (target === 'Composing' && canTransition(current, 'Composing')) {
    path.push('Composing')
  }

  return path
}

export function applyStatePathAfterAdopt(
  from: IncubatorWorkflowState,
  filledSlots: number,
  filledSlotKeys?: IncubatorSlotKey[],
  workType?: string | null
): IncubatorWorkflowState {
  const path = resolveStatePathAfterAdopt(from, filledSlots, filledSlotKeys, workType)
  let current = from
  for (const next of path) {
    assertTransition(current, next)
    current = next
  }
  return current
}

export function inferStateAfterCandidates(count: number): IncubatorWorkflowState {
  return count > 0 ? 'CandidatesGenerated' : 'SeedReady'
}
