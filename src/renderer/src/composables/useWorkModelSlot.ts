import { computed, ref, watch, type Ref } from 'vue'

export type ModelSlotName = 'body' | 'diagnosis'

const STORAGE_PREFIX_MAP: Record<ModelSlotName, string> = {
  body: 'bodyGenModel:',
  diagnosis: 'diagModel:'
}

interface SlotModelState {
  modelType: Ref<string | null>
  modelName: Ref<string | null>
  thinkingEnabled: Ref<boolean | null>
}

const stores = new Map<string, SlotModelState>()

function compositeKey(slot: ModelSlotName, workId: number): string {
  return `${slot}:${workId}`
}

function storageKey(slot: ModelSlotName, workId: number): string {
  return `${STORAGE_PREFIX_MAP[slot]}${workId}`
}

function loadStored(slot: ModelSlotName, workId: number): {
  modelType: string | null
  modelName: string | null
  thinkingEnabled: boolean | null
} {
  try {
    const raw = localStorage.getItem(storageKey(slot, workId))
    if (!raw) return { modelType: null, modelName: null, thinkingEnabled: null }
    const parsed = JSON.parse(raw) as {
      modelType?: string | null
      modelName?: string | null
      thinkingEnabled?: boolean | null
    }
    return {
      modelType: parsed.modelType?.trim() || null,
      modelName: parsed.modelName?.trim() || null,
      thinkingEnabled: typeof parsed.thinkingEnabled === 'boolean' ? parsed.thinkingEnabled : null
    }
  } catch {
    return { modelType: null, modelName: null, thinkingEnabled: null }
  }
}

function saveStored(
  slot: ModelSlotName,
  workId: number,
  modelType: string | null,
  modelName: string | null,
  thinkingEnabled: boolean | null
): void {
  try {
    if (!modelType && thinkingEnabled === null) {
      localStorage.removeItem(storageKey(slot, workId))
      return
    }
    localStorage.setItem(
      storageKey(slot, workId),
      JSON.stringify({ modelType, modelName, thinkingEnabled })
    )
  } catch {
    // ignore quota / private mode
  }
}

function getOrCreateState(slot: ModelSlotName, workId: number): SlotModelState {
  const key = compositeKey(slot, workId)
  let state = stores.get(key)
  if (!state) {
    const stored = loadStored(slot, workId)
    state = {
      modelType: ref(stored.modelType),
      modelName: ref(stored.modelName),
      thinkingEnabled: ref(stored.thinkingEnabled)
    }
    watch([state.modelType, state.modelName, state.thinkingEnabled], ([type, name, thinking]) => {
      saveStored(slot, workId, type, name, thinking)
    })
    stores.set(key, state)
  }
  return state
}

/**
 * Per-work model slot: each slot (body / diagnosis / ...) independently stores
 * the user's preferred provider, model, and thinking-mode toggle.
 */
export function useWorkModelSlot(slot: ModelSlotName, workIdSource: () => number) {
  const workId = computed(workIdSource)

  const slotModelType = computed({
    get: () => getOrCreateState(slot, workId.value).modelType.value,
    set: (v: string | null) => { getOrCreateState(slot, workId.value).modelType.value = v }
  })

  const slotModelName = computed({
    get: () => getOrCreateState(slot, workId.value).modelName.value,
    set: (v: string | null) => { getOrCreateState(slot, workId.value).modelName.value = v }
  })

  const slotThinkingEnabled = computed({
    get: () => getOrCreateState(slot, workId.value).thinkingEnabled.value,
    set: (v: boolean | null) => { getOrCreateState(slot, workId.value).thinkingEnabled.value = v }
  })

  function setModel(modelType: string | null, modelName: string | null): void {
    const state = getOrCreateState(slot, workId.value)
    state.modelType.value = modelType
    state.modelName.value = modelName
  }

  function clearModel(): void {
    setModel(null, null)
  }

  /** Default thinkingEnabled per slot: null = 未设置（由步骤模型分配决定），true/false = 显式覆盖 */
  function modelParams(): { modelType?: string; modelName?: string; thinkingEnabled?: boolean } {
    const state = getOrCreateState(slot, workId.value)
    const result: { modelType?: string; modelName?: string; thinkingEnabled?: boolean } = {}
    if (state.modelType.value) {
      result.modelType = state.modelType.value
      result.modelName = state.modelName.value ?? undefined
    }
    if (state.thinkingEnabled.value !== null) {
      result.thinkingEnabled = state.thinkingEnabled.value
    }
    return result
  }

  return {
    slotModelType,
    slotModelName,
    slotThinkingEnabled,
    setModel,
    clearModel,
    modelParams
  }
}
