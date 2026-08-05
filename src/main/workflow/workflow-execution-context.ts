export interface WorkflowExecutionContext {
  runId: number
  stepInstanceId: number
  workId: number
  stepKey: string
}

/**
 * 这里只保存“当前模型调用属于哪个持久化步骤”的关联缓存，不保存运行状态。
 * 每个作品由运行器和数据库租约保证单实例，因此按 workId 关联不会成为第二权威源。
 */
const activeContexts = new Map<number, WorkflowExecutionContext>()

export function getWorkflowExecutionContext(workId?: number): WorkflowExecutionContext | undefined {
  if (workId == null) return undefined
  return activeContexts.get(workId)
}

export function setWorkflowExecutionContext(context: WorkflowExecutionContext): void {
  activeContexts.set(context.workId, context)
}

export function clearWorkflowExecutionContext(workId: number, stepInstanceId: number): void {
  if (activeContexts.get(workId)?.stepInstanceId === stepInstanceId) {
    activeContexts.delete(workId)
  }
}
