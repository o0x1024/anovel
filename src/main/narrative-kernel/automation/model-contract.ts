import { assertNarrativeKernel } from '../errors'
import { canonicalHash } from '../hash'
import type { ProviderProtocol } from '../../../shared/model-providers'

export type NarrativeModelTask =
  | 'novel_blueprint'
  | 'chapter_intent'
  | 'chapter_body'
  | 'narrative_patch'
  | 'editorial_gate'
  | 'chapter_revision'

export interface FrozenNarrativeModelContractInput {
  provider: string
  providerProtocol: ProviderProtocol
  apiBase: string
  model: string
  protocolVersion: number
}

export interface FrozenNarrativeModelContract extends FrozenNarrativeModelContractInput {
  contractHash: string
}

export interface NarrativeModelRequest {
  requestId: string
  task: NarrativeModelTask
  contract: FrozenNarrativeModelContract
  input: Readonly<Record<string, unknown>>
}

export interface NarrativeModelResponse {
  status: 'completed' | 'failed'
  finishReason?: string
  content?: string
  structuredOutput?: unknown
  promptTokens: number
  completionTokens: number
  reasoningLength: number
  durationMs: number
  errorCode?: string
  errorMessage?: string
}

export interface NarrativeModelGateway {
  invoke(request: NarrativeModelRequest): Promise<NarrativeModelResponse>
}

export function createFrozenNarrativeModelContract(
  input: FrozenNarrativeModelContractInput
): FrozenNarrativeModelContract {
  assertNarrativeKernel(
    input.provider.trim().length > 0 &&
      ['openai', 'anthropic', 'gemini'].includes(input.providerProtocol) &&
      input.apiBase.trim().length > 0 &&
      input.model.trim().length > 0 &&
      Number.isInteger(input.protocolVersion) &&
      input.protocolVersion > 0,
    'WORKFLOW_STATE_INVALID',
    '模型契约必须指定 provider、providerProtocol、apiBase、model 和正整数协议版本'
  )
  const payload: FrozenNarrativeModelContractInput = {
    provider: input.provider,
    providerProtocol: input.providerProtocol,
    apiBase: input.apiBase,
    model: input.model,
    protocolVersion: input.protocolVersion
  }
  return { ...payload, contractHash: canonicalHash(payload) }
}

export function assertCompletedModelResponse(
  response: NarrativeModelResponse,
  outputKind: 'content' | 'structured'
): void {
  assertNarrativeKernel(
    response.status === 'completed',
    'MODEL_CALL_FAILED',
    response.errorMessage || '模型调用失败',
    { errorCode: response.errorCode }
  )
  assertNarrativeKernel(
    response.finishReason === 'stop',
    'MODEL_OUTPUT_TRUNCATED',
    '模型输出没有正常结束',
    { finishReason: response.finishReason }
  )
  assertNarrativeKernel(
    Number.isInteger(response.completionTokens) && response.completionTokens > 0,
    'MODEL_OUTPUT_EMPTY',
    '模型没有产生有效 completion token'
  )
  if (outputKind === 'content') {
    assertNarrativeKernel(
      typeof response.content === 'string' && response.content.trim().length > 0,
      'MODEL_OUTPUT_EMPTY',
      '模型正文输出为空'
    )
  } else {
    assertNarrativeKernel(
      response.structuredOutput != null,
      'MODEL_OUTPUT_EMPTY',
      '模型结构化输出为空'
    )
  }
}
