/**
 * 校验用户为目标循环设置的轮次上限。
 * 运行层不得截断、抬高或用默认值替换用户提交的预算。
 */
export function requireGoalTurnLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('轮次上限必须是大于等于 1 的整数')
  }
  return value
}
