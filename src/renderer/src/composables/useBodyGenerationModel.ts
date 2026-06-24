import { computed, ref, watch, type Ref } from 'vue'
import type { AssistantModelOption } from '../../../shared/assistant-types'

const STORAGE_PREFIX = 'bodyGenModel:'

interface BodyModelState {
  modelType: Ref<string | null>
  modelName: Ref<string | null>
  thinkingEnabled: Ref<boolean | null>
}

const store = new Map<number, BodyModelState>()

function storageKey(workId: number): string {
  return `${STORAGE_PREFIX}${workId}`
}

function loadStored(workId: number): { modelType: string | null; modelName: string | null; thinkingEnabled: boolean | null } {
  try {
    const raw = localStorage.getItem(storageKey(workId))
    if (!raw) return { modelType: null, modelName: null, thinkingEnabled: null }
    const parsed = JSON.parse(raw) as { modelType?: string | null; modelName?: string | null; thinkingEnabled?: boolean | null }
    const modelType = parsed.modelType?.trim() || null
    const modelName = parsed.modelName?.trim() || null
    const thinkingEnabled = typeof parsed.thinkingEnabled === 'boolean' ? parsed.thinkingEnabled : null
    return { modelType, modelName, thinkingEnabled }
  } catch {
    return { modelType: null, modelName: null, thinkingEnabled: null }
  }
}

function saveStored(workId: number, modelType: string | null, modelName: string | null, thinkingEnabled: boolean | null): void {
  try {
    if (!modelType && thinkingEnabled === null) {
      localStorage.removeItem(storageKey(workId))
      return
    }
    localStorage.setItem(storageKey(workId), JSON.stringify({ modelType, modelName, thinkingEnabled }))
  } catch {
    // ignore quota / private mode
  }
}

function getOrCreateState(workId: number): BodyModelState {
  let state = store.get(workId)
  if (!state) {
    const stored = loadStored(workId)
    state = {
      modelType: ref(stored.modelType),
      modelName: ref(stored.modelName),
      thinkingEnabled: ref(stored.thinkingEnabled)
    }
    watch([state.modelType, state.modelName, state.thinkingEnabled], ([type, name, thinking]) => {
      saveStored(workId, type, name, thinking)
    })
    store.set(workId, state)
  }
  return state
}

export const BODY_MODEL_OPTION_SEP = '\0'

export function bodyModelOptionKey(modelType: string, modelName: string): string {
  return `${modelType}${BODY_MODEL_OPTION_SEP}${modelName}`
}

export function parseBodyModelOptionKey(key: string): { modelType: string; modelName: string } | null {
  if (!key) return null
  const idx = key.indexOf(BODY_MODEL_OPTION_SEP)
  if (idx <= 0) return null
  return {
    modelType: key.slice(0, idx),
    modelName: key.slice(idx + 1)
  }
}

export function isSameBodyModelOption(
  modelType: string | null,
  modelName: string | null,
  option: AssistantModelOption
): boolean {
  return modelType === option.model_type && (modelName ?? null) === option.model_name
}

export function useBodyGenerationModel(workIdSource: () => number) {
  const workId = computed(workIdSource)

  const bodyModelType = computed({
    get: () => getOrCreateState(workId.value).modelType.value,
    set: (value: string | null) => {
      getOrCreateState(workId.value).modelType.value = value
    }
  })

  const bodyModelName = computed({
    get: () => getOrCreateState(workId.value).modelName.value,
    set: (value: string | null) => {
      getOrCreateState(workId.value).modelName.value = value
    }
  })

  const bodyThinkingEnabled = computed({
    get: () => getOrCreateState(workId.value).thinkingEnabled.value,
    set: (value: boolean | null) => {
      getOrCreateState(workId.value).thinkingEnabled.value = value
    }
  })

  function setModel(modelType: string | null, modelName: string | null): void {
    const state = getOrCreateState(workId.value)
    state.modelType.value = modelType
    state.modelName.value = modelName
  }

  function clearModel(): void {
    setModel(null, null)
  }

  function modelParams(): { modelType?: string; modelName?: string; thinkingEnabled: boolean } {
    const state = getOrCreateState(workId.value)
    const result: { modelType?: string; modelName?: string; thinkingEnabled: boolean } = {
      // 与右上角开关一致：未设置时视为开启
      thinkingEnabled: state.thinkingEnabled.value ?? true
    }
    if (state.modelType.value) {
      result.modelType = state.modelType.value
      result.modelName = state.modelName.value ?? undefined
    }
    return result
  }

  return {
    bodyModelType,
    bodyModelName,
    bodyThinkingEnabled,
    setModel,
    clearModel,
    modelParams
  }
}
