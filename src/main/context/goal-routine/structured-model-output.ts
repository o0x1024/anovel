import type { ModelResponse } from '../../model/types'
import { appLogger } from '../../logger/app-logger'
import { parseJsonObjectWithRepairs } from '../../../shared/model-json-repair'
import { extractJsonText } from '../parse-json-extract'

export interface StructuredModelOutputOptions<T> {
  workId: number
  label: string
  attempts?: number
  signal?: AbortSignal
  request: (attempt: number, lastError: string) => Promise<ModelResponse>
  validate?: (value: Record<string, unknown>) => T
  arrayBeforeProperties?: string[]
  /** 仅供纯 Node 回归测试关闭 Electron 日志；生产默认开启。 */
  log?: boolean
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
    try {
      response = await options.request(attempt, lastError)
      if (!response.success || !response.content?.trim()) {
        lastError = response.error || '模型无返回'
      } else if (response.finishReason === 'length') {
        lastError = '输出达到长度上限（finishReason=length）'
      } else {
        const content = response.content.trim()
        const json = extractJsonText(content) ?? content
        const parsed = parseJsonObjectWithRepairs<Record<string, unknown>>(json, {
          arrayBeforeProperties: options.arrayBeforeProperties
        })
        if (parsed.repairs.length > 0 && options.log !== false) {
          appLogger.warn('goal_structured_output', `${options.label} JSON 已做确定性闭合修复`, {
            workId: options.workId,
            attempt,
            repairs: parsed.repairs
          })
        }
        return options.validate
          ? options.validate(parsed.value)
          : parsed.value as T
      }
    } catch (error) {
      if (options.signal?.aborted) throw new Error('已取消')
      lastError = error instanceof Error ? error.message : String(error)
    }
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
