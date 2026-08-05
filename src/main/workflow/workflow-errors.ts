import {
  isModelCapabilityUnsupported,
  MODEL_CAPABILITY_UNSUPPORTED
} from '../../shared/model-capability-error'
import { CausalOutcomeProtocolError } from '../../shared/causal-outcome-protocol'

export type WorkflowErrorClass =
  | 'cancelled'
  | 'transient_transport'
  | 'provider_rate_limit'
  | 'response_protocol'
  | 'semantic_contract'
  | 'deterministic_invariant'
  | 'budget_exhausted'
  | 'user_action_required'
  | 'unknown'

export interface ClassifiedWorkflowError {
  errorClass: WorkflowErrorClass
  code: string
  message: string
  retryable: boolean
  retryDelayMs: number
  route:
    | 'retry_step'
    | 'repair_protocol'
    | 'repair_upstream'
    | 'replan_upstream'
    | 'rebase_authority'
    | 'pause'
    | 'cancel'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : 'Error'
}

function domainCodeOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.trim() ? code : undefined
}

export function classifyWorkflowError(error: unknown, attempt = 1): ClassifiedWorkflowError {
  const message = messageOf(error)
  const name = nameOf(error)
  const domainCode = domainCodeOf(error)
  const retryDelayMs = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt - 1))

  if (name === 'AbortError' || /^(?:已取消|取消)$/.test(message)) {
    return {
      errorClass: 'cancelled',
      code: 'CANCELLED',
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'cancel'
    }
  }
  if (error instanceof CausalOutcomeProtocolError && error.code === 'OUTCOME_BODY_CONTRACT') {
    return {
      errorClass: 'semantic_contract',
      code: error.code,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'repair_upstream'
    }
  }
  if (error instanceof CausalOutcomeProtocolError) {
    if (error.code === 'OUTCOME_TRANSPORT') {
      const exhausted = attempt >= 3
      return {
        errorClass: exhausted ? 'budget_exhausted' : 'transient_transport',
        code: exhausted ? 'OUTCOME_TRANSPORT_EXHAUSTED' : error.code,
        message,
        retryable: !exhausted,
        retryDelayMs: exhausted ? 0 : retryDelayMs,
        route: exhausted ? 'pause' : 'retry_step'
      }
    }
    if (error.code === 'OUTCOME_BUDGET') {
      return {
        errorClass: 'budget_exhausted',
        code: error.code,
        message,
        retryable: false,
        retryDelayMs: 0,
        route: 'pause'
      }
    }
    return {
      errorClass: 'deterministic_invariant',
      code: error.code,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  if (/(?:\b429\b|rate.?limit|too many requests|请求过于频繁|限流)/i.test(message)) {
    const exhausted = attempt >= 3
    return {
      errorClass: exhausted ? 'budget_exhausted' : 'provider_rate_limit',
      code: exhausted ? 'PROVIDER_RATE_LIMIT_EXHAUSTED' : 'PROVIDER_RATE_LIMIT',
      message,
      retryable: !exhausted,
      retryDelayMs: exhausted ? 0 : retryDelayMs,
      route: exhausted ? 'pause' : 'retry_step'
    }
  }
  if (
    /(?:ENOTFOUND|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|socket hang up|network error|fetch failed|timeout of \d+ms exceeded|timed out|网络错误|连接中断)/i.test(message)
  ) {
    const exhausted = attempt >= 3
    return {
      errorClass: exhausted ? 'budget_exhausted' : 'transient_transport',
      code: exhausted ? 'TRANSIENT_TRANSPORT_EXHAUSTED' : 'TRANSIENT_TRANSPORT',
      message,
      retryable: !exhausted,
      retryDelayMs: exhausted ? 0 : retryDelayMs,
      route: exhausted ? 'pause' : 'retry_step'
    }
  }
  if (
    isModelCapabilityUnsupported(error)
    || /MODEL_CONTRACT_UNAVAILABLE/.test(message)
  ) {
    return {
      errorClass: 'user_action_required',
      code: isModelCapabilityUnsupported(error)
        ? MODEL_CAPABILITY_UNSUPPORTED
        : 'MODEL_CONTRACT_UNAVAILABLE',
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  if (/MODEL_REQUEST_PROTOCOL_(?:UNSPECIFIED|INVALID)/.test(message)) {
    return {
      errorClass: 'deterministic_invariant',
      code: 'MODEL_REQUEST_PROTOCOL_INVALID',
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  // 领域错误码决定工作流路由；子类会覆写 Error.name，类名不能作为分类前提。
  if (domainCode === 'PREREQUISITE_MISSING') {
    return {
      errorClass: 'semantic_contract',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'replan_upstream'
    }
  }
  if (domainCode === 'CONTRACT_INVALID') {
    return {
      errorClass: 'semantic_contract',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'replan_upstream'
    }
  }
  if (
    domainCode === 'VOLUME_HARD_GATE_BLOCKED'
    || domainCode === 'CAUSAL_PROGRESS_GATE_BLOCKED'
  ) {
    return {
      errorClass: 'unknown',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  if (domainCode === 'PLAN_AUTHORITY_STATE_MISMATCH') {
    return {
      errorClass: 'semantic_contract',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'rebase_authority'
    }
  }
  if (
    domainCode === 'CHAPTER_TRANSACTION_PATCH_EXHAUSTED'
    || domainCode === 'PLAN_AUTHORITY_RECOVERY_EXHAUSTED'
    || domainCode === 'PLAN_REFINEMENT_EXHAUSTED'
    || domainCode === 'PLAN_REFERENCE_REPAIR_EXHAUSTED'
    || domainCode === 'AUTONOMOUS_REPAIR_NON_CONVERGENT'
  ) {
    return {
      errorClass: 'deterministic_invariant',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  if (domainCode === 'BODY_CONTRACT_REPAIR_FAILED') {
    return {
      errorClass: 'deterministic_invariant',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  if (domainCode === 'EVALUATOR_PROTOCOL') {
    return {
      errorClass: 'deterministic_invariant',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  if (domainCode === 'BODY_REVALIDATION_REQUIRED') {
    return {
      errorClass: 'semantic_contract',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'replan_upstream'
    }
  }
  if (domainCode === 'NARRATIVE_MEMORY_GATE_REPAIR_REQUIRED') {
    return {
      errorClass: 'semantic_contract',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'repair_upstream'
    }
  }
  if (
    domainCode === 'QUALITY_NON_CONVERGENT'
    || domainCode === 'EMOTION_NON_CONVERGENT'
  ) {
    return {
      errorClass: 'deterministic_invariant',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  if (domainCode === 'CHAPTER_SKELETON_PROTOCOL_EXHAUSTED') {
    return {
      errorClass: 'deterministic_invariant',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  if (domainCode === 'EXECUTION_CONTRACT_NON_CONVERGENT') {
    return {
      errorClass: 'semantic_contract',
      code: domainCode,
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'repair_upstream'
    }
  }
  if (domainCode === 'QUALITY_EVALUATOR_UNAVAILABLE') {
    return {
      errorClass: 'transient_transport',
      code: domainCode,
      message,
      retryable: true,
      retryDelayMs,
      route: 'retry_step'
    }
  }
  if (domainCode === 'QUALITY_EVALUATOR_PROTOCOL') {
    const exhausted = attempt >= 3
    return {
      errorClass: exhausted ? 'deterministic_invariant' : 'response_protocol',
      code: exhausted ? 'QUALITY_EVALUATOR_PROTOCOL_EXHAUSTED' : domainCode,
      message,
      retryable: !exhausted,
      retryDelayMs: 0,
      route: exhausted ? 'pause' : 'repair_protocol'
    }
  }
  if (
    domainCode === 'OUTPUT_INVALID' || domainCode === 'OUTPUT_TRUNCATED'
  ) {
    const exhausted = attempt >= 3
    return {
      errorClass: exhausted ? 'deterministic_invariant' : 'response_protocol',
      code: exhausted ? 'RESPONSE_PROTOCOL_EXHAUSTED' : domainCode,
      message,
      retryable: !exhausted,
      retryDelayMs: 0,
      route: exhausted ? 'pause' : 'repair_protocol'
    }
  }
  if (
    /finishReason=length/i.test(message)
    && /contentChars=0|正文为空|未返回正文/i.test(message)
    && /reasoningChars=[1-9]\d*|reasoning_content/i.test(message)
  ) {
    return {
      errorClass: 'budget_exhausted',
      code: 'REASONING_BUDGET_EXHAUSTED',
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  if (
    /(?:JSON|Schema|结构化输出|协议|finishReason=length|输出达到长度上限|解析失败|字段缺失|格式无效)/i.test(message)
  ) {
    const exhausted = attempt >= 3
    return {
      errorClass: exhausted ? 'deterministic_invariant' : 'response_protocol',
      code: exhausted ? 'RESPONSE_PROTOCOL_EXHAUSTED' : 'RESPONSE_PROTOCOL',
      message,
      retryable: !exhausted,
      retryDelayMs: 0,
      route: exhausted ? 'pause' : 'repair_protocol'
    }
  }
  if (
    /(?:相邻拍边界未形成可原子提交|BOUNDARY_ATOMIC_MISMATCH|CONTRACT_UNSATISFIABLE|状态修订冲突|expected.*revision|确定性门禁)/i.test(message)
  ) {
    const boundary = /相邻拍边界未形成可原子提交|BOUNDARY_ATOMIC_MISMATCH/i.test(message)
    return {
      errorClass: 'deterministic_invariant',
      code: boundary ? 'BOUNDARY_ATOMIC_MISMATCH' : 'DETERMINISTIC_INVARIANT',
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'replan_upstream'
    }
  }
  if (
    /(?:未兑现|蕴含|evidence|证据|连续性|合同|质量门禁|正文存在明显错词|承重句|blocking)/i.test(message)
  ) {
    return {
      errorClass: 'semantic_contract',
      code: 'SEMANTIC_CONTRACT',
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'repair_upstream'
    }
  }
  if (/(?:预算已耗尽|达到.*轮.*上限|maxTurns|轮次上限)/i.test(message)) {
    return {
      errorClass: 'budget_exhausted',
      code: 'BUDGET_EXHAUSTED',
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  if (/(?:等待作者确认|需人工|用户确认|人工事实修改)/i.test(message)) {
    return {
      errorClass: 'user_action_required',
      code: 'USER_ACTION_REQUIRED',
      message,
      retryable: false,
      retryDelayMs: 0,
      route: 'pause'
    }
  }
  return {
    errorClass: 'unknown',
    code: name || 'UNKNOWN',
    message,
    retryable: false,
    retryDelayMs: 0,
    route: 'pause'
  }
}

export async function waitForWorkflowRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  const bounded = Math.max(0, Math.min(30_000, Math.round(delayMs)))
  if (bounded === 0) return
  await new Promise<void>((resolve, reject) => {
    const finish = (callback: () => void) => {
      signal?.removeEventListener('abort', onAbort)
      callback()
    }
    const timer = setTimeout(() => finish(resolve), bounded)
    const onAbort = () => {
      clearTimeout(timer)
      finish(() => reject(new DOMException('已取消', 'AbortError')))
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
  })
}
