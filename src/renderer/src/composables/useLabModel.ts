import { ref, watch } from 'vue'
import type { WorkModelOptions } from '../../../shared/work-model-options'

const STORAGE_KEY = 'anovel:lab-model'

interface LabModelStored {
  modelType: string | null
  modelName: string | null
  thinkingEnabled: boolean
}

function loadStored(): LabModelStored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { modelType: null, modelName: null, thinkingEnabled: false }
    const parsed = JSON.parse(raw) as Partial<LabModelStored>
    return {
      modelType: parsed.modelType?.trim() || null,
      modelName: parsed.modelName?.trim() || null,
      thinkingEnabled: parsed.thinkingEnabled === true
    }
  } catch {
    return { modelType: null, modelName: null, thinkingEnabled: false }
  }
}

function saveStored(modelType: string | null, modelName: string | null, thinkingEnabled: boolean): void {
  try {
    if (!modelType && !thinkingEnabled) {
      localStorage.removeItem(STORAGE_KEY)
      return
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ modelType, modelName, thinkingEnabled }))
  } catch { /* ignore */ }
}

const stored = loadStored()
const labModelType = ref<string | null>(stored.modelType)
const labModelName = ref<string | null>(stored.modelName)
const labThinkingEnabled = ref<boolean>(stored.thinkingEnabled)

watch([labModelType, labModelName, labThinkingEnabled], ([type, name, thinking]) => {
  saveStored(type, name, thinking)
})

export function useLabModel() {
  function modelParams(): WorkModelOptions {
    const result: WorkModelOptions = {
      thinkingEnabled: labThinkingEnabled.value
    }
    if (labModelType.value) {
      result.modelType = labModelType.value
      result.modelName = labModelName.value ?? undefined
    }
    return result
  }

  return {
    labModelType,
    labModelName,
    labThinkingEnabled,
    modelParams
  }
}
