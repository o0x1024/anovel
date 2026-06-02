import { ModelRequest, ModelResponse, ModelType, ChatOptions } from './types'
import {
  createDeepSeekAdapter, createOpenAIAdapter, createGeminiAdapter,
  OpenAICompatibleAdapter, GeminiAdapter
} from './adapters'
import { modelConfigDAO, writingStyleDAO, generationLogDAO, appPreferenceDAO } from '../db'
import {
  collectPromptSections,
  assembleBudgetedPrompt,
  getMaxContextTokens
} from '../context/context-budget'
import { appLogger } from '../logger/app-logger'
import { aiSessionManager, type AiSessionHandle } from '../ai/ai-session-manager'
import { resolveSessionTitle } from '../ai/step-titles'
import { normalizeModelBodyOutput } from '../../shared/normalize-body-text'

/**
 * 模型服务 - 统一调用入口
 * 职责：模型选择、上下文预算组装、自动重试、调用日志、AI 活动会话
 */
export class ModelService {
  private adapters: Map<ModelType, OpenAICompatibleAdapter | GeminiAdapter>

  constructor() {
    this.adapters = new Map()
    this.adapters.set('deepseek', createDeepSeekAdapter())
    this.adapters.set('openai', createOpenAIAdapter())
    this.adapters.set('gemini', createGeminiAdapter())
  }

  /**
   * 发送聊天请求
   * 自动选择优先级最高的已启用模型，按 Token 预算分层注入上下文
   */
  async chat(request: ModelRequest, options?: ChatOptions): Promise<ModelResponse> {
    const startTime = Date.now()
    const requestId = `llm-${startTime}-${Math.random().toString(36).slice(2, 8)}`
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
      if (session?.isCancelled()) {
        return this.cancelledResponse(startTime)
      }

      if (session && !options?.suppressPhases) {
        session.emitPhase('组装上下文', 'running')
      }

      const config = this.selectModel(request.modelType, request.modelName)
      if (!config) {
        const error = '没有可用的模型配置，请先在设置中配置并启用至少一个模型'
        appLogger.error('model', error, { step: request.step, workId: request.workId })
        return this.failResponse(error, startTime, session, ownsSession)
      }

      const adapter = this.adapters.get(config.model_type as ModelType)
      if (!adapter) {
        return this.failResponse(`不支持的模型类型: ${config.model_type}`, startTime, session, ownsSession)
      }

      const maxContext = config.max_context_tokens && config.max_context_tokens > 0
        ? config.max_context_tokens
        : getMaxContextTokens(config.model_type)
      const reservedOutput = request.maxTokens ?? 4096

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

      const stepDefaults = getStepGenerationDefaults(request.step)
      const enrichedRequest: ModelRequest = {
        ...stepDefaults,
        ...request,
        systemPrompt,
        prompt: userPrompt,
        maxTokens: request.maxTokens ?? stepDefaults.maxTokens,
        temperature: request.temperature ?? stepDefaults.temperature,
        frequencyPenalty: request.frequencyPenalty ?? stepDefaults.frequencyPenalty,
        presencePenalty: request.presencePenalty ?? stepDefaults.presencePenalty,
        topP: request.topP ?? stepDefaults.topP
      }

      appLogger.info('llm', 'LLM 请求已发送', {
        requestId,
        modelType: config.model_type,
        modelName: config.model_name || undefined,
        step: request.step,
        workId: request.workId,
        maxTokens: enrichedRequest.maxTokens ?? 4096,
        temperature: enrichedRequest.temperature ?? 0.7,
        systemPrompt: enrichedRequest.systemPrompt ?? '',
        userPrompt: enrichedRequest.prompt,
        contextBudget: report
      })

      if (session && !options?.suppressPhases) {
        session.emitPhase('调用模型', 'running')
        session.setModelInfo(config.model_type, config.model_name || undefined)
      } else if (session) {
        session.setModelInfo(config.model_type, config.model_name || undefined)
      }

      const MAX_RETRIES = 3
      let lastError: string | undefined
      let lastResponse: ModelResponse | null = null

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (session?.isCancelled()) {
          return this.cancelledResponse(startTime, report)
        }

        if (attempt > 1 && session && !options?.suppressPhases) {
          session.emitPhase(`重试 (${attempt}/${MAX_RETRIES})`, 'running')
          session.clearStream()
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
            stream: streamEnabled
          }
        )

        lastResponse = response

        if (response.cancelled) {
          return { ...response, contextBudget: report }
        }

        if (response.success) {
          appLogger.info('llm', 'LLM 请求成功', {
            requestId,
            modelType: config.model_type,
            modelName: config.model_name || undefined,
            step: request.step,
            workId: request.workId,
            durationMs: response.durationMs ?? 0,
            usage: response.usage
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

        lastError = response.error
        appLogger.warn('model', `模型调用失败，第 ${attempt}/${MAX_RETRIES} 次`, {
          requestId,
          modelType: config.model_type,
          step: request.step,
          workId: request.workId,
          error: lastError
        })

        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
        }
      }

      const fallbackConfig = this.getFallbackModel(config.model_type as ModelType)
      if (fallbackConfig) {
        appLogger.warn('llm', '主模型失败，尝试降级模型', {
          requestId,
          failedModelType: config.model_type,
          fallbackModelType: fallbackConfig.model_type,
          step: request.step,
          workId: request.workId
        })
        console.warn(`[ModelService] 降级到 ${fallbackConfig.model_type}`)
        if (session) {
          session.emitPhase(`降级到 ${fallbackConfig.model_type}`, 'running')
          session.clearStream()
        }
        const fallbackAdapter = this.adapters.get(fallbackConfig.model_type as ModelType)
        if (fallbackAdapter) {
          const fallbackResponse = await fallbackAdapter.chat(
            enrichedRequest,
            fallbackConfig.api_key || '',
            fallbackConfig.api_base || '',
            fallbackConfig.model_name || undefined,
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
              stream: streamEnabled
            }
          )
          if (fallbackResponse.success) {
            appLogger.info('llm', '降级模型请求成功', {
              requestId,
              modelType: fallbackConfig.model_type,
              modelName: fallbackConfig.model_name || undefined,
              step: request.step,
              workId: request.workId,
              durationMs: fallbackResponse.durationMs ?? 0,
              usage: fallbackResponse.usage
            })
            if (ownsSession && session) {
              session.complete(true)
            }
            return this.withNormalizedBody(fallbackResponse, request.step, report)
          }
          lastError = fallbackResponse.error
          lastResponse = fallbackResponse
        }
      }

      const finalError = `调用失败(已重试${MAX_RETRIES}次): ${lastError}`
      appLogger.error('model', finalError, {
        requestId,
        modelType: config.model_type,
        step: request.step,
        workId: request.workId
      })

      if (ownsSession && session) {
        session.complete(false, finalError)
      }

      return {
        success: false,
        content: lastResponse?.content ?? '',
        error: finalError,
        contextBudget: report,
        durationMs: Date.now() - startTime
      }
    } catch (err) {
      const message = String(err)
      appLogger.error('llm', 'LLM 请求异常', {
        requestId,
        step: request.step,
        workId: request.workId,
        error: message
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

  private selectModel(preferredType?: ModelType, preferredModelName?: string | null) {
    if (preferredType) {
      const config = modelConfigDAO.getByType(preferredType)
      if (config && config.is_enabled && config.api_key) {
        if (preferredModelName?.trim()) {
          return { ...config, model_name: preferredModelName.trim() }
        }
        return config
      }
    }

    const global = appPreferenceDAO.getGlobalLlmDefault()
    if (global.provider) {
      const config = modelConfigDAO.getByType(global.provider)
      if (config && config.is_enabled && config.api_key) {
        if (global.modelName) {
          return { ...config, model_name: global.modelName }
        }
        return config
      }
    }

    const allConfigs = modelConfigDAO.list()
    return allConfigs.find(c => c.is_enabled && c.api_key) ?? null
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

  private getFallbackModel(failedType: ModelType) {
    const allConfigs = modelConfigDAO.list()
    return allConfigs.find(
      c => c.model_type !== failedType && c.is_enabled && c.api_key
    ) ?? null
  }
}

/**
 * 按创作步骤返回生成参数。
 * 以用户在「设置 > AI 服务 > 生成参数」中持久化的值为基准，
 * body_style_rewrite / ai_trace_polish 在此基础上微调 temperature。
 */
function getStepGenerationDefaults(step?: string): Partial<ModelRequest> {
  const saved = appPreferenceDAO.getGenerationParams()

  if (step === 'body_style_rewrite') {
    return {
      temperature: Math.min(saved.temperature + 0.03, 2),
      maxTokens: saved.maxTokens,
      frequencyPenalty: Math.min(saved.frequencyPenalty + 0.1, 2),
      presencePenalty: Math.min(saved.presencePenalty + 0.05, 2),
      topP: Math.max(saved.topP - 0.02, 0)
    }
  }
  if (step === 'body_generation' || step?.startsWith('body_')) {
    return {
      temperature: saved.temperature,
      maxTokens: saved.maxTokens,
      frequencyPenalty: saved.frequencyPenalty,
      presencePenalty: saved.presencePenalty,
      topP: saved.topP
    }
  }
  if (step === 'ai_trace_polish') {
    return {
      temperature: Math.min(saved.temperature + 0.03, 2),
      maxTokens: saved.maxTokens,
      frequencyPenalty: Math.min(saved.frequencyPenalty + 0.05, 2),
      presencePenalty: Math.min(saved.presencePenalty + 0.05, 2),
      topP: Math.max(saved.topP - 0.05, 0)
    }
  }
  return {}
}

export const modelService = new ModelService()
