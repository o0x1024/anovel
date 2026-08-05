import { ModelRequest, ModelResponse, ModelType, ChatOptions } from './types'
import { getAdapterForProtocol } from './adapters'
import { resolveProviderProtocol } from '../../shared/model-providers'
import {
  modelConfigDAO,
  writingStyleDAO,
  generationLogDAO,
  modelCallAttemptDAO,
  appPreferenceDAO,
  goalRoutineDAO,
  workflowModelContractDAO,
  type FrozenModelSelection
} from '../db'
import {
  collectPromptSections,
  assembleBudgetedPrompt,
  getMaxContextTokens
} from '../context/context-budget'
import { appLogger } from '../logger/app-logger'
import { aiSessionManager, type AiSessionHandle } from '../ai/ai-session-manager'
import { resolveSessionTitle } from '../ai/step-titles'
import { normalizeModelBodyOutput } from '../../shared/normalize-body-text'
import {
  isDeepSeekProvider,
  parseDeepSeekProviderOptions
} from '../../shared/deepseek-api-params'
import {
  isDoubaoProvider,
  parseDoubaoProviderOptions
} from '../../shared/doubao-api-params'
import {
  isWorkScopedModelRequest,
  resolveWorkRequestTemperature
} from '../context/work-step-temperature'
import { getStepLabel, stepAcceptsRequestModel } from '../../shared/step-model-config'
import { resolveGenerationMaxTokens } from './generation-token-budget'
import { getWorkflowExecutionContext } from '../workflow/workflow-execution-context'
import { classifyWorkflowError } from '../workflow/workflow-errors'
import { buildPromptJsonSchemaInstruction } from '../../shared/prompt-json-schema'
import { resolveWorkflowModelSelection } from '../workflow/workflow-model-contract'
import { nativeJsonSchemaCapabilityError } from '../../shared/model-capability-error'
import {
  formatPromptJsonSchemaIssueValue,
  PromptJsonSchemaValidationError,
  validatePromptJsonSchema
} from '../../shared/prompt-json-schema-validator'
import { isFullProseOutputStep } from '../context/style-step-rules'

function validateStructuredResponse(request: ModelRequest, response: ModelResponse): string | null {
  if (
    !response.success
    || !request.structuredOutputMode
    || !request.responseSchema
  ) return null
  if (response.finishReason === 'length') {
    return 'OUTPUT_TRUNCATED: 结构化响应达到长度上限，拒绝进入业务校验'
  }
  const content = response.content?.trim() ?? ''
  if (!content) return 'OUTPUT_INVALID: 结构化响应正文为空'
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(content)?.[1]?.trim()
  try {
    const value = JSON.parse(fenced ?? content) as unknown
    validatePromptJsonSchema(value, request.responseSchema.schema)
    return null
  } catch (error) {
    const detail = error instanceof PromptJsonSchemaValidationError && error.issue
      ? `${error.message}；actual=${formatPromptJsonSchemaIssueValue(error.issue.actual, 240)}`
        + `${error.issue.allowed ? `；allowed=${formatPromptJsonSchemaIssueValue(error.issue.allowed, 600)}` : ''}`
      : error instanceof Error ? error.message : String(error)
    return `OUTPUT_INVALID: ${request.responseSchema.name} 本地 Schema 校验失败：${detail}`
  }
}

/**
 * 模型服务 - 统一调用入口
 * 职责：模型选择、上下文预算组装、调用日志、AI 活动会话
 */
export class ModelService {
  /**
   * 发送聊天请求
   * 自动选择优先级最高的已启用模型，按 Token 预算分层注入上下文
   */
  async chat(request: ModelRequest, options?: ChatOptions): Promise<ModelResponse> {
    const startTime = Date.now()
    const requestId = `llm-${startTime}-${Math.random().toString(36).slice(2, 8)}`
    let attemptStarted = false
    let attemptFinished = false
    let session: AiSessionHandle | null = options?.sessionHandle ?? null
    let ownsSession = false

    if (!session && options?.webContents) {
      const title = resolveSessionTitle(request.step, options.sessionTitle)
      session = aiSessionManager.create(options.webContents, title)
      ownsSession = !options.keepSession
    }

    const signal = session?.getSignal() ?? options?.signal
    const streamEnabled = options?.stream !== false

    try {
      if (request.responseSchema && !request.structuredOutputMode) {
        return this.failResponse(
          'MODEL_REQUEST_PROTOCOL_UNSPECIFIED: 结构化请求必须显式声明 prompt_json 或 native_json_schema',
          startTime,
          session,
          ownsSession
        )
      }
      if (
        request.structuredOutputMode === 'native_json_schema'
        && request.requireResponseSchema !== true
      ) {
        return this.failResponse(
          'MODEL_REQUEST_PROTOCOL_INVALID: 原生 JSON Schema 请求必须显式声明 requireResponseSchema=true',
          startTime,
          session,
          ownsSession
        )
      }
      if (session?.isCancelled()) {
        return this.cancelledResponse(startTime)
      }

      if (session && !options?.suppressPhases) {
        session.emitPhase('组装上下文', 'running')
      }

      const workflowContext = getWorkflowExecutionContext(request.workId)
      const frozenSelection = workflowContext
        ? resolveWorkflowModelSelection(workflowContext.runId, request.step)
        : null
      const {
        config,
        stepOverrideThinking,
        providerProtocol
      } = frozenSelection
        ? this.selectFrozenModel(frozenSelection)
        : this.selectModelWithStep(request.modelType, request.modelName, request.step)
      if (!config) {
        const error = '没有可用的模型配置，请先在设置中配置并启用至少一个模型'
        appLogger.error('model', error, { step: request.step, workId: request.workId })
        return this.failResponse(error, startTime, session, ownsSession)
      }

      if (request.structuredOutputMode === 'native_json_schema') {
        let nativeJsonSchemaSupported = false
        try {
          const options = JSON.parse(config.provider_options_json ?? '{}') as {
            nativeJsonSchemaSupported?: unknown
          }
          nativeJsonSchemaSupported = options.nativeJsonSchemaSupported === true
        } catch {
          nativeJsonSchemaSupported = false
        }
        if (!nativeJsonSchemaSupported) {
          return this.failResponse(
            nativeJsonSchemaCapabilityError({
              modelName: config.model_name ?? config.model_type,
              stepLabel: getStepLabel(request.step ?? request.responseSchema.name),
              upstreamMessage: '运行前能力合同未声明 nativeJsonSchemaSupported=true'
            }),
            startTime,
            session,
            ownsSession
          )
        }
      }

      const protocol = providerProtocol
        ?? resolveProviderProtocol(config.model_type, config.provider_protocol)
      const adapter = getAdapterForProtocol(protocol)

      const maxContext = config.max_context_tokens && config.max_context_tokens > 0
        ? config.max_context_tokens
        : getMaxContextTokens(config.model_type)

      const frozenGenerationParams = workflowContext
        ? workflowModelContractDAO.get(workflowContext.runId)?.generationParams
        : undefined
      const stepDefaults = getStepGenerationDefaults(
        request.step,
        request.workId,
        frozenGenerationParams
      )
      const requestedMaxTokens = request.maxTokens ?? stepDefaults.maxTokens
      const globalMaxTokens = stepDefaults.maxTokens
      const resolvedMaxTokens = resolveGenerationMaxTokens(requestedMaxTokens, globalMaxTokens)
      const reservedOutput = resolvedMaxTokens

      const enrichMemory = request.workId && request.enrichNarrativeMemory !== false && (
        request.enrichNarrativeMemory === true ||
        request.step === 'body_generation' ||
        request.step?.startsWith('body_')
      )

      const sections = collectPromptSections(
        enrichMemory
          ? request
          : { ...request, enrichNarrativeMemory: false }
      )

      const { systemPrompt, userPrompt, report } = assembleBudgetedPrompt(
        request.prompt,
        sections,
        maxContext,
        reservedOutput
      )

      if (report.pressure === 'blocking') {
        const error = report.warnings.join('；') || '上下文超出模型上限'
        appLogger.warn('model', '上下文预算 blocking', {
          step: request.step,
          workId: request.workId,
          modelType: config.model_type,
          warnings: report.warnings
        })
        return this.failResponse(error, startTime, session, ownsSession, report)
      }

      let styleId: number | undefined = request.styleId
      if (!styleId && request.workId) {
        const workStyles = writingStyleDAO.getByWork(request.workId)
        if (workStyles.length > 0) styleId = workStyles[0].id
      }

      const resolvedTemperature = request.temperature ?? stepDefaults.temperature

      const enrichedRequest: ModelRequest = {
        ...stepDefaults,
        ...request,
        systemPrompt,
        prompt: userPrompt,
        maxTokens: resolvedMaxTokens,
        temperature: resolvedTemperature,
        frequencyPenalty: request.frequencyPenalty ?? stepDefaults.frequencyPenalty,
        presencePenalty: request.presencePenalty ?? stepDefaults.presencePenalty,
        topP: request.topP ?? stepDefaults.topP
      }
      if (
        enrichedRequest.structuredOutputMode === 'prompt_json'
        && enrichedRequest.responseSchema
      ) {
        enrichedRequest.systemPrompt = [
          enrichedRequest.systemPrompt ?? '',
          buildPromptJsonSchemaInstruction(enrichedRequest.responseSchema)
        ].filter(Boolean).join('\n\n')
      }

      const proseOutputThinkingDisabled = isFullProseOutputStep(request.step)
      if (request.forceThinkingDisabled || proseOutputThinkingDisabled) {
        enrichedRequest.thinkingEnabled = false
      } else if (stepOverrideThinking !== undefined) {
        enrichedRequest.thinkingEnabled = stepOverrideThinking
      }

      if (isDeepSeekProvider(config.model_type)) {
        enrichedRequest.deepseekOptions = parseDeepSeekProviderOptions(config.provider_options_json)
        if (enrichedRequest.thinkingEnabled !== undefined) {
          enrichedRequest.deepseekOptions.thinkingEnabled = enrichedRequest.thinkingEnabled
        }
      }

      if (isDoubaoProvider(config.model_type)) {
        enrichedRequest.doubaoOptions = parseDoubaoProviderOptions(config.provider_options_json)
        if (enrichedRequest.thinkingEnabled !== undefined) {
          enrichedRequest.doubaoOptions.thinkingEnabled = enrichedRequest.thinkingEnabled
        }
      }

      const thinkingSource = request.forceThinkingDisabled
        ? 'forced_disabled'
        : proseOutputThinkingDisabled
          ? 'prose_output_policy'
          : stepOverrideThinking !== undefined
            ? 'step_override'
            : request.thinkingEnabled !== undefined
              ? 'request'
              : isDeepSeekProvider(config.model_type) || isDoubaoProvider(config.model_type)
                ? 'provider_default'
                : 'model_default'
      const resolvedThinkingEnabled = enrichedRequest.thinkingEnabled
        ?? enrichedRequest.deepseekOptions?.thinkingEnabled
        ?? enrichedRequest.doubaoOptions?.thinkingEnabled

      const tempLog: Record<string, unknown> = {
        temperature: enrichedRequest.temperature ?? 0.7,
        thinkingRequested: request.thinkingEnabled ?? null,
        thinkingResolved: resolvedThinkingEnabled ?? null,
        thinkingSource
      }
      const styleSections = (report.sections || [])
        .filter(section => section.included && ['style', 'style_fewshot', 'style_anchor', 'anti_ai_rules'].includes(section.key))
        .map(section => `${section.key}:${section.tokens}`)
      if (stepDefaults.temperatureGroup) {
        tempLog.temperatureGroup = stepDefaults.temperatureGroup
        tempLog.temperatureRange = stepDefaults.temperatureRange
      }
      if (styleSections.length > 0) {
        tempLog.styleSections = styleSections
      }

      appLogger.info('llm', 'LLM 请求已发送', {
        requestId,
        modelType: config.model_type,
        modelName: config.model_name || undefined,
        step: request.step,
        workId: request.workId,
        maxTokens: enrichedRequest.maxTokens ?? 4096,
        requestedMaxTokens,
        globalMaxTokens,
        ...tempLog,
        systemPrompt: enrichedRequest.systemPrompt ?? '',
        userPrompt: enrichedRequest.prompt,
        contextBudget: report
      })

      modelCallAttemptDAO.start({
        requestId,
        runId: workflowContext?.runId,
        stepInstanceId: workflowContext?.stepInstanceId,
        workId: request.workId,
        generationStep: request.step,
        modelType: config.model_type,
        modelName: config.model_name || undefined
      })
      attemptStarted = true

      if (session && !options?.suppressPhases) {
        session.emitPhase('调用模型', 'running')
        session.setModelInfo(config.model_type, config.model_name || undefined)
      } else if (session) {
        session.setModelInfo(config.model_type, config.model_name || undefined)
      }

      if (session?.isCancelled()) {
        attemptFinished = true
        modelCallAttemptDAO.finish(requestId, {
          status: 'cancelled',
          errorClass: 'cancelled',
          errorCode: 'CANCELLED',
          errorMessage: '已取消',
          durationMs: Date.now() - startTime
        })
        return this.cancelledResponse(startTime, report)
      }

      const response = await adapter.chat(
        enrichedRequest,
        config.api_key || '',
        config.api_base || '',
        config.model_name || undefined,
        {
          onDelta: streamEnabled
            ? (delta) => {
                options?.onDelta?.(delta)
                session?.emitDelta(delta)
              }
            : undefined,
          onThinkingDelta: streamEnabled
            ? (delta) => {
                options?.onThinkingDelta?.(delta)
                session?.emitThinkingDelta(delta)
              }
            : undefined,
          signal,
          stream: streamEnabled,
          modelType: config.model_type
        }
      )

      const structuredResponseError = validateStructuredResponse(enrichedRequest, response)
      if (structuredResponseError) {
        if (workflowContext) {
          goalRoutineDAO.recordStepArtifact(
            workflowContext.stepInstanceId,
            'structured_response_rejected',
            {
              generationStep: request.step ?? 'unknown',
              schemaName: enrichedRequest.responseSchema?.name ?? null,
              error: structuredResponseError,
              finishReason: response.finishReason ?? null,
              rawContent: response.content?.slice(0, 180_000) ?? ''
            }
          )
        }
        response.success = false
        response.error = structuredResponseError
      }

      if (response.cancelled) {
        attemptFinished = true
        modelCallAttemptDAO.finish(requestId, {
          status: 'cancelled',
          errorClass: 'cancelled',
          errorCode: 'CANCELLED',
          errorMessage: response.error || '已取消',
          durationMs: response.durationMs ?? Date.now() - startTime,
          finishReason: response.finishReason
        })
        return { ...response, contextBudget: report }
      }

      if (response.success) {
        attemptFinished = true
        modelCallAttemptDAO.finish(requestId, {
          status: 'success',
          promptTokens: response.usage?.promptTokens ?? 0,
          completionTokens: response.usage?.completionTokens ?? 0,
          durationMs: response.durationMs ?? Date.now() - startTime,
          finishReason: response.finishReason
        })
        appLogger.info('llm', 'LLM 请求成功', {
          requestId,
          modelType: config.model_type,
          modelName: config.model_name || undefined,
          step: request.step,
          workId: request.workId,
          durationMs: response.durationMs ?? 0,
          usage: response.usage,
          finishReason: response.finishReason,
          content: response.content
        })

        if (request.workId && request.workId > 0) {
          generationLogDAO.log({
            work_id: request.workId,
            step: request.step || 'unknown',
            model_type: config.model_type,
            style_id: styleId,
            prompt_tokens: response.usage?.promptTokens ?? 0,
            completion_tokens: response.usage?.completionTokens ?? 0,
            duration_ms: response.durationMs ?? 0
          })
        }

        if (ownsSession && session) {
          session.complete(true)
        }

        return this.withNormalizedBody(response, request.step, report)
      }

      const finalError = response.error || '模型调用失败'
      const classified = classifyWorkflowError(new Error(finalError))
      attemptFinished = true
      modelCallAttemptDAO.finish(requestId, {
        status: 'failed',
        errorClass: classified.errorClass,
        errorCode: classified.code,
        errorMessage: finalError,
        durationMs: response.durationMs ?? Date.now() - startTime,
        finishReason: response.finishReason
      })
      appLogger.error('model', finalError, {
        requestId,
        modelType: config.model_type,
        step: request.step,
        workId: request.workId,
        error: finalError
      })

      if (ownsSession && session) {
        session.complete(false, finalError)
      }

      return {
        success: false,
        content: response.content ?? '',
        error: finalError,
        contextBudget: report,
        durationMs: Date.now() - startTime
      }
    } catch (err) {
      const message = String(err)
      if (attemptStarted && !attemptFinished) {
        attemptFinished = true
        const classified = classifyWorkflowError(err)
        modelCallAttemptDAO.finish(requestId, {
          status: classified.errorClass === 'cancelled' ? 'cancelled' : 'failed',
          errorClass: classified.errorClass,
          errorCode: classified.code,
          errorMessage: classified.message,
          durationMs: Date.now() - startTime
        })
      }
      appLogger.error('llm', 'LLM 请求异常', {
        requestId,
        step: request.step,
        workId: request.workId,
        error: message,
        stack: err instanceof Error ? err.stack?.slice(0, 4000) : undefined
      })
      if (ownsSession && session) {
        session.complete(false, message)
      }
      return {
        success: false,
        content: '',
        error: message,
        durationMs: Date.now() - startTime
      }
    }
  }

  private cancelledResponse(startTime: number, contextBudget?: ModelResponse['contextBudget']): ModelResponse {
    return {
      success: false,
      content: '',
      error: '已取消',
      cancelled: true,
      contextBudget,
      durationMs: Date.now() - startTime
    }
  }

  private failResponse(
    error: string,
    startTime: number,
    session: AiSessionHandle | null,
    ownsSession: boolean,
    contextBudget?: ModelResponse['contextBudget']
  ): ModelResponse {
    if (ownsSession && session) {
      session.complete(false, error)
    }
    return {
      success: false,
      content: '',
      error,
      contextBudget,
      durationMs: Date.now() - startTime
    }
  }

  private selectModelWithStep(
    preferredType?: ModelType,
    preferredModelName?: string | null,
    step?: string
  ): {
    config: ReturnType<typeof modelConfigDAO.getByType> | null
    stepOverrideThinking?: boolean
    providerProtocol?: 'openai' | 'gemini' | 'anthropic'
  } {
    // 1. 步骤模型分配（设置页「模型分配」）
    if (step) {
      const overrides = appPreferenceDAO.getStepModelOverrides()
      const override = overrides[step]
      if (override) {
        const config = modelConfigDAO.getByType(override.provider)
        if (config && config.is_enabled && config.api_key) {
          return {
            config: { ...config, model_name: override.modelName },
            stepOverrideThinking: override.thinkingEnabled
          }
        }
      }
    }

    // 2. 作品编辑器槽位 / 调用方显式指定（仅限白名单 step）
    if (preferredType && stepAcceptsRequestModel(step)) {
      const config = modelConfigDAO.getByType(preferredType)
      if (config && config.is_enabled && config.api_key) {
        if (preferredModelName?.trim()) {
          return { config: { ...config, model_name: preferredModelName.trim() } }
        }
        return { config }
      }
    }

    // 3. 全局默认
    const global = appPreferenceDAO.getGlobalLlmDefault()
    if (global.provider) {
      const config = modelConfigDAO.getByType(global.provider)
      if (config && config.is_enabled && config.api_key) {
        if (global.modelName) {
          return { config: { ...config, model_name: global.modelName } }
        }
        return { config }
      }
    }

    // 4. 非白名单 step 的兜底：仍尝试请求级模型（如助手手动选模）
    if (preferredType) {
      const config = modelConfigDAO.getByType(preferredType)
      if (config && config.is_enabled && config.api_key) {
        if (preferredModelName?.trim()) {
          return { config: { ...config, model_name: preferredModelName.trim() } }
        }
        return { config }
      }
    }

    const allConfigs = modelConfigDAO.list()
    return { config: allConfigs.find(c => c.is_enabled && c.api_key) ?? null }
  }

  private selectFrozenModel(selection: FrozenModelSelection): {
    config: ReturnType<typeof modelConfigDAO.getByType> | null
    stepOverrideThinking?: boolean
    providerProtocol?: 'openai' | 'gemini' | 'anthropic'
  } {
    const live = modelConfigDAO.getByType(selection.provider)
    if (!live?.api_key) return { config: null }
    return {
      config: {
        ...live,
        model_name: selection.modelName,
        api_base: selection.apiBase,
        provider_protocol: selection.providerProtocol,
        max_context_tokens: selection.maxContextTokens,
        provider_options_json: selection.providerOptionsJson
      },
      stepOverrideThinking: selection.thinkingEnabled,
      providerProtocol: selection.providerProtocol
    }
  }

  private withNormalizedBody(
    response: ModelResponse,
    step: string | undefined,
    contextBudget: ModelResponse['contextBudget']
  ): ModelResponse {
    if (!response.success || !response.content) {
      return { ...response, contextBudget }
    }
    const content = normalizeModelBodyOutput(response.content, step)
    if (content === response.content) {
      return { ...response, contextBudget }
    }
    return { ...response, content, contextBudget }
  }

}

type StepGenerationDefaults = Partial<ModelRequest> & {
  temperatureGroup?: string
  temperatureRange?: { min: number; max: number }
}

/**
 * 生成参数默认值。
 * - 带 workId 的作品创作：temperature 由作品 8 组区间随机采样，忽略全局温度
 * - 其它场景：使用「设置 > AI 服务 > 高级配置」；润色类 step 仅微调 penalty/topP
 */
function getStepGenerationDefaults(
  step?: string,
  workId?: number,
  frozen?: ReturnType<typeof appPreferenceDAO.getGenerationParams>
): StepGenerationDefaults {
  const saved = frozen ?? appPreferenceDAO.getGenerationParams()
  const base: StepGenerationDefaults = {
    maxTokens: saved.maxTokens,
    frequencyPenalty: saved.frequencyPenalty,
    presencePenalty: saved.presencePenalty,
    topP: saved.topP
  }

  if (isWorkScopedModelRequest(workId)) {
    const sampled = resolveWorkRequestTemperature(workId!, step)
    const result: StepGenerationDefaults = {
      ...base,
      temperature: sampled.temperature,
      temperatureGroup: sampled.group,
      temperatureRange: sampled.range
    }
    // 正文生成：强制叠加频率/存在惩罚，打破模型反复套用偏爱句式的自强化，
    // 直击困惑度信号（检测器 70% 权重）；topP 收紧兜住提温后的连贯性。
    if (step === 'body_generation') {
      result.frequencyPenalty = Math.min(saved.frequencyPenalty + 0.35, 2)
      result.presencePenalty = Math.min(saved.presencePenalty + 0.25, 2)
      result.topP = Math.min(saved.topP, 0.9)
    }
    // 去 AI 重写：高随机性以拉高困惑度，覆盖被检出段落
    if (sampled.group === 'deai') {
      result.frequencyPenalty = Math.min(saved.frequencyPenalty + 0.2, 2)
      result.presencePenalty = Math.min(saved.presencePenalty + 0.15, 2)
    }
    return result
  }

  base.temperature = saved.temperature

  if (step === 'body_style_rewrite') {
    return {
      ...base,
      temperature: Math.min(saved.temperature + 0.03, 2),
      frequencyPenalty: Math.min(saved.frequencyPenalty + 0.1, 2),
      presencePenalty: Math.min(saved.presencePenalty + 0.05, 2),
      topP: Math.max(saved.topP - 0.02, 0)
    }
  }
  if (step === 'ai_trace_polish') {
    return {
      ...base,
      temperature: Math.min(saved.temperature + 0.03, 2),
      frequencyPenalty: Math.min(saved.frequencyPenalty + 0.05, 2),
      presencePenalty: Math.min(saved.presencePenalty + 0.05, 2),
      topP: Math.max(saved.topP - 0.05, 0)
    }
  }
  return base
}

export const modelService = new ModelService()
