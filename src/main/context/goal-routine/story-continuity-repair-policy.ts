export const MAX_STORY_CONTINUITY_REPAIRS = 3

export function isStoryContinuityEvaluatorFailure(blockers: string[]): boolean {
  return blockers.length > 0 && blockers.every(blocker =>
    /QUALITY_EVALUATOR_(?:UNAVAILABLE|PROTOCOL)|门禁无返回|返回格式无效|timeout|超时|网络|已取消/i.test(blocker)
  )
}

export function canRepairStoryContinuity(
  completedRepairs: number,
  maxRepairs = MAX_STORY_CONTINUITY_REPAIRS
): boolean {
  return completedRepairs < maxRepairs
}
