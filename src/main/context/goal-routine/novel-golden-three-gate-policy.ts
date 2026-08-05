const GOLDEN_THREE_GATE_TOKEN_BUDGETS = [1600, 3200, 6400] as const

export const GOLDEN_THREE_GATE_MAX_ATTEMPTS = GOLDEN_THREE_GATE_TOKEN_BUDGETS.length

export function goldenThreeGateTokenBudget(attempt: number): number {
  const index = Math.max(0, Math.min(
    GOLDEN_THREE_GATE_TOKEN_BUDGETS.length - 1,
    Math.trunc(attempt) - 1
  ))
  return GOLDEN_THREE_GATE_TOKEN_BUDGETS[index]
}
