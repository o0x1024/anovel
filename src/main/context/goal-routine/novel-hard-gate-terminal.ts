import { goalRoutineDAO } from '../../db'
import type { GoalRoutinePhase } from '../../../shared/goal-routine-phases'
import { markNovelAutonomousTerminal } from './novel-autonomous-control'

export function stopNovelOnHardGate(input: {
  workId: number
  phase: GoalRoutinePhase
  errorCode: 'VOLUME_HARD_GATE_BLOCKED' | 'CAUSAL_PROGRESS_GATE_BLOCKED'
  message: string
  turn: number
  emit: (message: string, status: 'error') => void
}): void {
  markNovelAutonomousTerminal({
    workId: input.workId,
    phase: input.phase,
    code: input.errorCode,
    message: input.message
  })
  goalRoutineDAO.appendTurn({
    work_id: input.workId,
    turn_no: input.turn,
    phase: input.phase,
    action: input.errorCode === 'VOLUME_HARD_GATE_BLOCKED'
      ? 'volume_hard_gate_blocked'
      : 'causal_progress_gate_blocked',
    summary: `目标循环硬门禁未通过，已保留检查点并停止后续生成：${input.message}`
  })
  input.emit(`目标循环硬门禁未通过，已保留检查点并停止生成：${input.message}`, 'error')
}
