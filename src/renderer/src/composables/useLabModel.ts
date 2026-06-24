import { ref, watch } from 'vue'

const STORAGE_KEY = 'anovel:lab-model'

interface LabModelStored {
  modelType: string | null
  modelName: string | null
}

function loadStored(): LabModelStored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { modelType: null, modelName: null }
    const parsed = JSON.parse(raw) as Partial<LabModelStored>
    return {
      modelType: parsed.modelType?.trim() || null,
      modelName: parsed.modelName?.trim() || null
    }
  } catch {
    return { modelType: null, modelName: null }
  }
}

function saveStored(modelType: string | null, modelName: string | null): void {
  try {
    if (!modelType) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ modelType, modelName }))
  } catch { /* ignore */ }
}

const stored = loadStored()
const labModelType = ref<string | null>(stored.modelType)
const labModelName = ref<string | null>(stored.modelName)

watch([labModelType, labModelName], ([type, name]) => {
  saveStored(type, name)
})

export function useLabModel() {
  function modelParams(): { modelType?: string; modelName?: string } {
    if (!labModelType.value) return {}
    return {
      modelType: labModelType.value,
      modelName: labModelName.value ?? undefined
    }
  }

  return {
    labModelType,
    labModelName,
    modelParams
  }
}
