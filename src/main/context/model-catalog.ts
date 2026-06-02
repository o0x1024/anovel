/**
 * 从提供商 API 拉取可用模型列表
 */
export async function fetchProviderModelCatalog(
  modelType: string,
  apiKey: string,
  apiBase?: string | null
): Promise<string[]> {
  if (!apiKey.trim()) {
    throw new Error('请先配置 API Key')
  }

  if (modelType === 'gemini') {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=100`
    )
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
    }
    const data = await response.json() as {
      models?: { name: string; supportedGenerationMethods?: string[] }[]
    }
    return (data.models ?? [])
      .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(Boolean)
  }

  const base = (apiBase || 'https://api.openai.com/v1').replace(/\/$/, '')
  const response = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const data = await response.json() as {
    data?: { id?: string; name?: string }[]
    models?: { id?: string; name?: string }[]
  }
  const list = data.data ?? data.models ?? []
  return list
    .map(m => m.id ?? m.name ?? '')
    .filter(Boolean)
}

export function parseAvailableModelsJson(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  } catch {
    return []
  }
}

export interface AssistantModelOption {
  model_type: string
  model_name: string
}

interface ModelConfigLike {
  model_type: string
  model_name: string | null
  is_enabled: number
  api_key: string | null
  available_models_json?: string | null
}

/** 已启用提供商 × 模型目录，供 AI 助手模型切换使用 */
export function buildAssistantModelOptions(configs: ModelConfigLike[]): AssistantModelOption[] {
  const options: AssistantModelOption[] = []
  for (const config of configs) {
    if (!config.is_enabled || !config.api_key?.trim()) continue
    const catalog = parseAvailableModelsJson(config.available_models_json)
    const models = catalog.length
      ? catalog
      : config.model_name?.trim()
        ? [config.model_name.trim()]
        : []
    for (const modelName of models) {
      options.push({ model_type: config.model_type, model_name: modelName })
    }
  }
  return options
}
