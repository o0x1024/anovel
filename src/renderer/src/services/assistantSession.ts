const LAST_CONVERSATION_KEY = 'assistant:lastConversationId'
const LAST_ROLE_KEY = 'assistant:lastRoleId'

export function getLastAssistantConversationId(): number | null {
  try {
    const raw = localStorage.getItem(LAST_CONVERSATION_KEY)
    if (!raw) return null
    const id = Number(raw)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function setLastAssistantConversationId(id: number | null): void {
  try {
    if (id && id > 0) {
      localStorage.setItem(LAST_CONVERSATION_KEY, String(id))
    } else {
      localStorage.removeItem(LAST_CONVERSATION_KEY)
    }
  } catch {
    // ignore quota / private mode
  }
}

export function getLastAssistantRoleId(): number | null {
  try {
    const raw = localStorage.getItem(LAST_ROLE_KEY)
    if (!raw) return null
    const id = Number(raw)
    return Number.isFinite(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

export function setLastAssistantRoleId(id: number | null): void {
  try {
    if (id && id > 0) {
      localStorage.setItem(LAST_ROLE_KEY, String(id))
    } else {
      localStorage.removeItem(LAST_ROLE_KEY)
    }
  } catch {
    // ignore quota / private mode
  }
}

export const ASSISTANT_MODEL_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  mimo: 'MiMo AI',
  bailian: 'Bailian',
  doubao: '豆包',
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Anthropic'
}

export function assistantModelLabel(
  modelType: string,
  modelName?: string | null,
  options?: { showProvider?: boolean; providerLabel?: string }
): string {
  const name = modelName?.trim()
  const provider = options?.providerLabel ?? ASSISTANT_MODEL_LABELS[modelType] ?? modelType
  if (name) {
    if (options?.showProvider) {
      return `${provider} · ${name}`
    }
    return name
  }
  return provider
}

export function isSameAssistantModel(
  a: { modelType: string | null; modelName: string | null },
  b: { model_type: string; model_name: string }
): boolean {
  return a.modelType === b.model_type && (a.modelName ?? null) === b.model_name
}
