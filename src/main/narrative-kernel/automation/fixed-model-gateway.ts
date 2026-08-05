import axios from 'axios'
import type { ProviderProtocol } from '../../../shared/model-providers'
import { NarrativeKernelError } from '../errors'
import { sha256 } from '../hash'
import {
  type NarrativeModelGateway,
  type NarrativeModelRequest,
  type NarrativeModelResponse
} from './model-contract'
import {
  buildNarrativeTaskPrompt,
  NARRATIVE_PROMPT_PROTOCOL_VERSION
} from './task-prompts'

export interface NarrativeModelConfigRow {
  model_type: string
  model_name: string | null
  api_key: string | null
  api_base: string | null
  is_enabled: number
  provider_protocol: string | null
}

export interface FixedNarrativeProviderConfig {
  provider: string
  providerProtocol: ProviderProtocol
  apiKey: string
  apiBase: string
  model: string
  timeoutMs: number
}

interface OpenAICompatibleResponse {
  choices?: Array<{
    finish_reason?: unknown
    message?: {
      content?: unknown
      reasoning_content?: unknown
      reasoning?: unknown
    }
  }>
  usage?: {
    prompt_tokens?: unknown
    completion_tokens?: unknown
  }
  error?: { message?: unknown }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(item => {
    if (typeof item === 'string') return item
    if (!item || typeof item !== 'object') return ''
    const record = item as Record<string, unknown>
    return typeof record.text === 'string' ? record.text : ''
  }).join('')
}

function finishReason(value: unknown): NarrativeModelResponse['finishReason'] {
  const normalized = String(value ?? '').toLowerCase()
  if (normalized === 'stop' || normalized === 'end_turn' || normalized === 'stop_sequence') {
    return 'stop'
  }
  if (normalized === 'length' || normalized === 'max_tokens' || normalized === 'max_token') {
    return 'length'
  }
  if (normalized.includes('content_filter') || normalized.includes('safety')) {
    return 'content_filter'
  }
  if (normalized.includes('tool')) return 'tool'
  return 'unknown'
}

function nonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? value as number : 0
}

function strictJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new Error('结构化模型输出必须是无 Markdown 围栏的单一 JSON 对象')
  }
  const parsed = JSON.parse(trimmed) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('结构化模型输出必须是 JSON 对象')
  }
  return parsed as Record<string, unknown>
}

function uniqueQuoteEvidence(
  candidateId: string,
  content: string,
  quote: string
): { candidateId: string; startOffset: number; endOffset: number; quoteHash: string } {
  const startOffset = content.indexOf(quote)
  if (startOffset < 0 || content.indexOf(quote, startOffset + quote.length) >= 0) {
    throw new Error(
      startOffset < 0
        ? `事件证据不在候选正文中：${quote}`
        : `事件证据在候选正文中不唯一：${quote}`
    )
  }
  return {
    candidateId,
    startOffset,
    endOffset: startOffset + quote.length,
    quoteHash: sha256(quote)
  }
}

function normalizePatchOutput(
  value: Record<string, unknown>,
  request: NarrativeModelRequest
): Record<string, unknown> {
  const candidate = request.input.candidate as { id?: unknown; content?: unknown } | undefined
  if (!candidate || typeof candidate.id !== 'string' || typeof candidate.content !== 'string') {
    throw new Error('补丁请求缺少候选正文身份')
  }
  if (!Array.isArray(value.events)) throw new Error('补丁输出 events 必须是数组')
  return {
    ...value,
    events: value.events.map((rawEvent, index) => {
      if (!rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
        throw new Error(`补丁事件 ${index} 必须是对象`)
      }
      const event = rawEvent as Record<string, unknown>
      if (typeof event.evidenceQuote !== 'string' || event.evidenceQuote.length === 0) {
        throw new Error(`补丁事件 ${index} 缺少 evidenceQuote`)
      }
      const { evidenceQuote, ...payload } = event
      return {
        ...payload,
        evidence: uniqueQuoteEvidence(
          candidate.id as string,
          candidate.content as string,
          evidenceQuote
        )
      }
    })
  }
}

export function fixedProviderConfigFromModelRow(
  row: NarrativeModelConfigRow,
  timeoutMs = 240000
): FixedNarrativeProviderConfig {
  if (
    row.is_enabled !== 1 ||
    row.provider_protocol !== 'openai' ||
    !row.api_key?.trim() ||
    !row.api_base?.trim() ||
    !row.model_name?.trim()
  ) {
    throw new NarrativeKernelError(
      'WORKFLOW_STATE_INVALID',
      'V2 固定模型必须启用、明确配置，并使用 openai 协议',
      { provider: row.model_type, providerProtocol: row.provider_protocol }
    )
  }
  return {
    provider: row.model_type,
    providerProtocol: 'openai',
    apiKey: row.api_key,
    apiBase: row.api_base.replace(/\/+$/, ''),
    model: row.model_name,
    timeoutMs
  }
}

export class FixedOpenAICompatibleNarrativeModelGateway implements NarrativeModelGateway {
  constructor(private readonly config: FixedNarrativeProviderConfig) {
    if (config.providerProtocol !== 'openai') {
      throw new NarrativeKernelError(
        'WORKFLOW_STATE_INVALID',
        'FixedOpenAICompatibleNarrativeModelGateway 只接受 openai 协议'
      )
    }
  }

  async invoke(request: NarrativeModelRequest): Promise<NarrativeModelResponse> {
    if (
      request.contract.provider !== this.config.provider ||
      request.contract.providerProtocol !== this.config.providerProtocol ||
      request.contract.apiBase.replace(/\/+$/, '') !== this.config.apiBase.replace(/\/+$/, '') ||
      request.contract.model !== this.config.model ||
      request.contract.protocolVersion !== NARRATIVE_PROMPT_PROTOCOL_VERSION
    ) {
      return this.failure('MODEL_CONTRACT_MISMATCH', '运行冻结模型契约与 Gateway 固定配置不一致')
    }

    const prompt = buildNarrativeTaskPrompt(request)
    const startedAt = Date.now()
    let data: OpenAICompatibleResponse
    try {
      const response = await axios.post<OpenAICompatibleResponse>(
        `${this.config.apiBase}/chat/completions`,
        {
          model: this.config.model,
          messages: [
            { role: 'system', content: prompt.systemPrompt },
            { role: 'user', content: prompt.prompt }
          ],
          max_tokens: prompt.maxTokens,
          temperature: prompt.temperature,
          stream: false
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: this.config.timeoutMs,
          validateStatus: status => status >= 200 && status < 300
        }
      )
      data = response.data
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? String(error.response?.data?.error?.message ?? error.message)
        : error instanceof Error ? error.message : String(error)
      return {
        ...this.failure('MODEL_PROVIDER_ERROR', message),
        durationMs: Date.now() - startedAt
      }
    }

    const choice = data.choices?.[0]
    const content = contentText(choice?.message?.content)
    const reasoning = contentText(
      choice?.message?.reasoning_content ?? choice?.message?.reasoning
    )
    const base: NarrativeModelResponse = {
      status: 'completed',
      finishReason: finishReason(choice?.finish_reason),
      ...(content ? { content } : {}),
      promptTokens: nonNegativeInteger(data.usage?.prompt_tokens),
      completionTokens: nonNegativeInteger(data.usage?.completion_tokens),
      reasoningLength: reasoning.length,
      durationMs: Date.now() - startedAt
    }
    if (request.task === 'chapter_body' || request.task === 'chapter_revision') {
      return base
    }
    try {
      const parsed = strictJsonObject(content)
      return {
        ...base,
        structuredOutput: request.task === 'narrative_patch'
          ? normalizePatchOutput(parsed, request)
          : parsed
      }
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        errorCode: 'MODEL_STRUCTURED_OUTPUT_INVALID',
        errorMessage: error instanceof Error ? error.message : String(error)
      }
    }
  }

  private failure(errorCode: string, errorMessage: string): NarrativeModelResponse {
    return {
      status: 'failed',
      promptTokens: 0,
      completionTokens: 0,
      reasoningLength: 0,
      durationMs: 0,
      errorCode,
      errorMessage
    }
  }
}
