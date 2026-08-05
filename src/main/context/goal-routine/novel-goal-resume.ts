import { goalRoutineDAO } from '../../db'

export function isResumableNovelGoalStatus(status: string | null | undefined): boolean {
  return status === 'paused' || status === 'running' || status === 'waiting'
    || status === 'cancelled' || status === 'timeout' || status === 'error'
}

export function shouldResumeNovelGoalLoop(workId: number): boolean {
  const existing = goalRoutineDAO.getByWork(workId)
  if (!existing || existing.goal_met) return false
  if (!isResumableNovelGoalStatus(existing.status)) return false
  if (existing.status === 'timeout') return true
  if (existing.status === 'paused' || existing.status === 'waiting'
    || existing.status === 'cancelled' || existing.status === 'error') {
    return (existing.turn_count ?? 0) > 0 || Boolean(existing.current_phase)
  }
  return false
}
