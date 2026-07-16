/**
 * 阶段已经用完自己的语义修复预算。外层不得再把整个阶段重复三遍，
 * 否则会把 3 轮门禁放大成 9 轮相同调用。
 */
export class GoalPhaseExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GOAL_PHASE_EXHAUSTED'
  }
}
