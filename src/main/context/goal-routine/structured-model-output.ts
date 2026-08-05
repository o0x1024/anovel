import type { ModelResponse } from '../../model/types'
import { appLogger } from '../../logger/app-logger'
import { parseJsonObjectWithRepairs } from '../../../shared/model-json-repair'
import { isModelCapabilityUnsupported } from '../../../shared/model-capability-error'
import { extractJsonText } from '../parse-json-extract'
import { validatePromptJsonSchema } from '../../../shared/prompt-json-schema-validator'
import { goalRoutineDAO } from '../../db'
import { getWorkflowExecutionContext } from '../../workflow/workflow-execution-context'

export interface StructuredModelOutputOptions<T> {
  workId: number
  label: string
  attempts?: number
  signal?: AbortSignal
  request: (attempt: number, lastError: string) => Promise<ModelResponse>
  validate?: (value: Record<string, unknown>) => T
  schema?: Record<string, unknown>
  repairValidationError?: (input: {
    value: Record<string, unknown>
    error: unknown
    attempt: number
  }) => Promise<T>
  shouldRepairValidationError?: (error: unknown) => boolean
  shouldRetryError?: (error: unknown) => boolean
  arrayBeforeProperties?: string[]
  onAttemptFailure?: (input: {
    attempt: number
    maxAttempts: number
    error: string
    response?: ModelResponse
  }) => void | Promise<void>
  /** 仅供纯 Node 回归测试关闭 Electron 日志；生产默认开启。 */
  log?: boolean
}

export interface ParsedStructuredModelContent<T> {
  value: T
  repairs: string[]
}

/**
 * 结构化响应唯一解析入口。质量评估器等只读调用也必须复用这里，避免各模块
 * 分别实现 JSON 截取、确定性修复与 Schema 校验。
 */
export function parseStructuredModelContent<T>(input: {
  content: string
  schema?: Record<string, unknown>
  validate?: (value: Record<string, unknown>) => T
  arrayBeforeProperties?: string[]
}): ParsedStructuredModelContent<T> {
  const content = input.content.trim()
  const json = extractJsonText(content, { allowEmptyArrays: true }) ?? content
  const parsed = parseJsonObjectWithRepairs<Record<string, unknown>>(json, {
    arrayBeforeProperties: input.arrayBeforeProperties
  })
  if (input.schema) validatePromptJsonSchema(parsed.value, input.schema)
  return {
    value: input.validate ? input.validate(parsed.value) : parsed.value as T,
    repairs: parsed.repairs
  }
}

export function persistRejectedStructuredArtifact(input: {
  workId: number
  label: string
  attempt: number
  stage: 'parse_or_schema' | 'business_validation'
  content: string
  error: unknown
}): void {
  const context = getWorkflowExecutionContext(input.workId)
  if (!context) return
  const record = input.error && typeof input.error === 'object'
    ? input.error as { code?: unknown; issues?: unknown }
    : undefined
  goalRoutineDAO.recordStepArtifact(
    context.stepInstanceId,
    'structured_response_rejected',
    {
      label: input.label,
      attempt: input.attempt,
      stage: input.stage,
      errorCode: typeof record?.code === 'string' ? record.code : null,
      error: input.error instanceof Error ? input.error.message : String(input.error),
      issues: record?.issues ?? null,
      rawContent: input.content.slice(0, 180_000)
    }
  )
}

/**
 * 结构化模型调用的统一故障边界：格式/截断只在当前业务轮次内重试，
 * 不把一次弱模型漂移直接升级为整个目标循环失败。
 */
export async function requestStructuredModelOutput<T>(
  options: StructuredModelOutputOptions<T>
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 2)
  let lastError = '未知结构化输出错误'
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) throw new Error('已取消')
    let response: ModelResponse | undefined
    let validationRepairAttempted = false
    let rejectedArtifactPersisted = false
    try {
      response = await options.request(attempt, lastError)
      if (!response.success || !response.content?.trim()) {
        lastError = response.error || '模型无返回'
        if (isModelCapabilityUnsupported(lastError)) {
          throw new Error(lastError)
        }
      } else if (response.finishReason === 'length') {
        lastError = '输出达到长度上限（finishReason=length）'
      } else {
        const content = response.content.trim()
        const parsed = parseStructuredModelContent<Record<string, unknown>>({
          content,
          schema: options.schema,
          arrayBeforeProperties: options.arrayBeforeProperties
        })
        if (parsed.repairs.length > 0 && options.log !== false) {
          appLogger.warn('goal_structured_output', `${options.label} JSON 已做确定性闭合修复`, {
            workId: options.workId,
            attempt,
            repairs: parsed.repairs
          })
        }
        if (!options.validate) return parsed.value as T
        try {
          return options.validate(parsed.value)
        } catch (error) {
          persistRejectedStructuredArtifact({
            workId: options.workId,
            label: options.label,
            attempt,
            stage: 'business_validation',
            content,
            error
          })
          rejectedArtifactPersisted = true
          if (
            !options.repairValidationError
            || (options.shouldRepairValidationError && !options.shouldRepairValidationError(error))
          ) throw error
          validationRepairAttempted = true
          return await options.repairValidationError({
            value: parsed.value,
            error,
            attempt
          })
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw new Error('已取消')
      if (isModelCapabilityUnsupported(error)) {
        await options.onAttemptFailure?.({
          attempt,
          maxAttempts: attempts,
          error: error instanceof Error ? error.message : String(error),
          response
        })
        throw error
      }
      if (validationRepairAttempted) throw error
      if (options.shouldRetryError && !options.shouldRetryError(error)) throw error
      if (response?.success && response.content?.trim() && !rejectedArtifactPersisted) {
        persistRejectedStructuredArtifact({
          workId: options.workId,
          label: options.label,
          attempt,
          stage: 'parse_or_schema',
          content: response.content.trim(),
          error
        })
      }
      lastError = error instanceof Error ? error.message : String(error)
    }
    await options.onAttemptFailure?.({
      attempt,
      maxAttempts: attempts,
      error: lastError,
      response
    })
    if (options.log !== false) {
      appLogger.warn('goal_structured_output', `${options.label}结构化输出无效，局部重试`, {
        workId: options.workId,
        attempt,
        finishReason: response?.finishReason,
        error: lastError
      })
    }
  }
  throw new Error(`${options.label}连续 ${attempts} 次结构化输出无效：${lastError}`)
}
