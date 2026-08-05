import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { ProviderProtocol } from '../../shared/model-providers'
import { NarrativeKernelError } from '../narrative-kernel/errors'

export interface NarrativeApplicationConfig {
  databasePath: string
  model: {
    provider: string
    providerProtocol: ProviderProtocol
    apiBase: string
    apiKey: string
    model: string
    timeoutMs: number
  }
  automation: {
    maxRepairs: number
    maxStepAttempts: number
    editorialPolicyVersion: number
  }
}

type JsonObject = Record<string, unknown>

function invalid(message: string): never {
  throw new NarrativeKernelError('WORKFLOW_STATE_INVALID', `V2 应用配置无效：${message}`)
}

function asObject(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${path} 必须是对象`)
  return value as JsonObject
}

function exactKeys(value: JsonObject, keys: readonly string[], path: string): void {
  const expected = new Set(keys)
  const unexpected = Object.keys(value).filter(key => !expected.has(key))
  const missing = keys.filter(key => !(key in value))
  if (unexpected.length > 0) invalid(`${path} 包含未声明字段：${unexpected.join(', ')}`)
  if (missing.length > 0) invalid(`${path} 缺少字段：${missing.join(', ')}`)
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid(`${path} 必须是非空字符串`)
  return value.trim()
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) invalid(`${path} 必须是正整数`)
  return value as number
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) invalid(`${path} 必须是非负整数`)
  return value as number
}

function providerProtocol(value: unknown): ProviderProtocol {
  if (value !== 'openai') {
    invalid('model.providerProtocol 当前只能为 openai；不提供协议自动转换')
  }
  return value
}

export function parseNarrativeApplicationConfig(
  value: unknown,
  configPath: string
): NarrativeApplicationConfig {
  const root = asObject(value, '$')
  exactKeys(root, ['databasePath', 'model', 'automation'], '$')
  const model = asObject(root.model, '$.model')
  const automation = asObject(root.automation, '$.automation')
  exactKeys(
    model,
    ['provider', 'providerProtocol', 'apiBase', 'apiKey', 'model', 'timeoutMs'],
    '$.model'
  )
  exactKeys(
    automation,
    ['maxRepairs', 'maxStepAttempts', 'editorialPolicyVersion'],
    '$.automation'
  )
  const databasePath = nonEmptyString(root.databasePath, '$.databasePath')
  return {
    databasePath: resolve(dirname(configPath), databasePath),
    model: {
      provider: nonEmptyString(model.provider, '$.model.provider'),
      providerProtocol: providerProtocol(model.providerProtocol),
      apiBase: nonEmptyString(model.apiBase, '$.model.apiBase').replace(/\/+$/, ''),
      apiKey: nonEmptyString(model.apiKey, '$.model.apiKey'),
      model: nonEmptyString(model.model, '$.model.model'),
      timeoutMs: positiveInteger(model.timeoutMs, '$.model.timeoutMs')
    },
    automation: {
      maxRepairs: nonNegativeInteger(automation.maxRepairs, '$.automation.maxRepairs'),
      maxStepAttempts: positiveInteger(automation.maxStepAttempts, '$.automation.maxStepAttempts'),
      editorialPolicyVersion: positiveInteger(
        automation.editorialPolicyVersion,
        '$.automation.editorialPolicyVersion'
      )
    }
  }
}

export function loadNarrativeApplicationConfig(configPath: string): NarrativeApplicationConfig {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch (error) {
    invalid(`无法读取 JSON 文件 ${configPath}：${error instanceof Error ? error.message : String(error)}`)
  }
  return parseNarrativeApplicationConfig(value, configPath)
}
