import type { ClassifiedWorkflowError } from '../../workflow/workflow-errors'
import type { GoalRoutinePhase } from '../../../shared/goal-routine-phases'

const CONTINUABLE_LEAF_CLASSES = new Set<ClassifiedWorkflowError['errorClass']>([
  'transient_transport',
  'provider_rate_limit',
  'response_protocol',
  'deterministic_invariant',
  'budget_exhausted'
])

/**
 * A model call or chapter-repair step is a leaf transaction. Its failure may
 * reject that candidate, but must not own the lifecycle of the autonomous run.
 * Only explicit cancellation/user intervention or an unsafe persistence
 * boundary may stop the run supervisor.
 */
export function shouldContinueNovelRunAfterLeafFailure(input: {
  failure: ClassifiedWorkflowError
  chapterId?: number
  phase?: GoalRoutinePhase
}): boolean {
  if (input.failure.errorClass === 'cancelled') return false
  if (input.failure.errorClass === 'user_action_required') return false
  // 首发窗口是工作级发布门禁，不是可丢弃的章节候选；模型预算、协议或
  // 证据失败必须停在同一正文哈希上，等待明确修复后重新审读。
  if (input.phase === 'release_window_audit') return false
  // 没有章节目标时不存在可隔离的“叶子候选”。分卷、章节大纲和工作级
  // 合同失败必须停在持久化检查点，不能把同一份无效响应循环重放。
  if (!input.chapterId && (
    input.failure.errorClass === 'budget_exhausted'
    || input.failure.errorClass === 'response_protocol'
    || input.failure.errorClass === 'deterministic_invariant'
  )) return false
  if (CONTINUABLE_LEAF_CLASSES.has(input.failure.errorClass)) return true
  return input.chapterId != null && (
    input.failure.route === 'repair_protocol'
    || input.failure.route === 'repair_upstream'
    || input.failure.route === 'replan_upstream'
  )
}

export function leafFailureContinuationDelay(
  failure: ClassifiedWorkflowError
): number {
  if (
    failure.errorClass === 'transient_transport'
    || failure.errorClass === 'provider_rate_limit'
    || failure.errorClass === 'budget_exhausted'
  ) {
    return Math.max(1_000, Math.min(30_000, failure.retryDelayMs || 5_000))
  }
  // Deterministic failures still belong to the supervisor, but they must
  // yield the event loop.  Without a delay a non-progressing gate can append
  // turns in a tight loop, monopolising SQLite and freezing the renderer.
  if (failure.errorClass === 'deterministic_invariant') return 1_000
  if (failure.errorClass === 'response_protocol') return 1_000
  return 0
}
