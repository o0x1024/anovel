import {
  appPreferenceDAO,
  modelConfigDAO,
  workflowModelContractDAO,
  type FrozenModelSelection,
  type WorkflowModelContract
} from '../db'
import { resolveProviderProtocol } from '../../shared/model-providers'
import { stepAcceptsWorkBodySlotModel } from '../../shared/step-model-config'
import type { WorkModelOptions } from '../../shared/work-model-options'

function freezeSelection(
  provider: string,
  requestedModelName?: string | null,
  thinkingEnabled?: boolean
): FrozenModelSelection {
  const config = modelConfigDAO.getByType(provider)
  if (!config || !config.is_enabled || !config.api_key) {
    throw new Error(`MODEL_CONTRACT_UNAVAILABLE: 模型提供商「${provider}」未启用或缺少密钥`)
  }
  const modelName = requestedModelName?.trim() || config.model_name?.trim()
  if (!modelName) {
    throw new Error(`MODEL_CONTRACT_UNAVAILABLE: 模型提供商「${provider}」没有确定的模型名称`)
  }
  if (!config.api_base?.trim()) {
    throw new Error(`MODEL_CONTRACT_UNAVAILABLE: 模型提供商「${provider}」没有 API 地址`)
  }
  return {
    provider,
    modelName,
    apiBase: config.api_base,
    providerProtocol: resolveProviderProtocol(config.model_type, config.provider_protocol),
    maxContextTokens: config.max_context_tokens ?? 256_000,
    providerOptionsJson: config.provider_options_json,
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {})
  }
}

/**
 * 把一次目标循环会使用的模型解析规则冻结为不可变合同。
 * 合同不保存密钥；运行时只从同一 provider 读取当前密钥，其他参数全部使用快照。
 */
export function ensureWorkflowModelContract(
  runId: number,
  bodyOptions: WorkModelOptions
): { contract: WorkflowModelContract; created: boolean; hash: string } {
  const existing = workflowModelContractDAO.get(runId)
  if (existing) {
    return {
      contract: existing,
      created: false,
      hash: workflowModelContractDAO.getHash(runId)!
    }
  }

  const global = appPreferenceDAO.getGlobalLlmDefault()
  if (!global.provider) {
    throw new Error('MODEL_CONTRACT_UNAVAILABLE: 尚未设置全局默认模型')
  }
  const frozenGlobal = freezeSelection(global.provider, global.modelName)
  const frozenBody = bodyOptions.modelType
    ? freezeSelection(bodyOptions.modelType, bodyOptions.modelName, bodyOptions.thinkingEnabled)
    : {
        ...frozenGlobal,
        ...(bodyOptions.thinkingEnabled !== undefined
          ? { thinkingEnabled: bodyOptions.thinkingEnabled }
          : {})
      }

  const stepOverrides = Object.fromEntries(
    Object.entries(appPreferenceDAO.getStepModelOverrides()).map(([step, override]) => [
      step,
      freezeSelection(
        override.provider,
        override.modelName,
        override.thinkingEnabled
      )
    ])
  )
  const contract: WorkflowModelContract = {
    version: 1,
    global: frozenGlobal,
    body: frozenBody,
    stepOverrides,
    generationParams: appPreferenceDAO.getGenerationParams()
  }
  workflowModelContractDAO.create(runId, contract)
  return {
    contract,
    created: true,
    hash: workflowModelContractDAO.getHash(runId)!
  }
}

export function resolveWorkflowModelSelection(
  runId: number,
  step?: string
): FrozenModelSelection | null {
  const contract = workflowModelContractDAO.get(runId)
  if (!contract) return null
  if (step && contract.stepOverrides[step]) return contract.stepOverrides[step]
  return stepAcceptsWorkBodySlotModel(step) ? contract.body : contract.global
}
