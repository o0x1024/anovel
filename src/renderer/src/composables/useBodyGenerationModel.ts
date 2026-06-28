import { computed } from 'vue'
import type { AssistantModelOption } from '../../../shared/assistant-types'
import { useWorkModelSlot } from './useWorkModelSlot'

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
  const {
    slotModelType,
    slotModelName,
    slotThinkingEnabled,
    setModel,
    clearModel,
    modelParams
  } = useWorkModelSlot('body', workIdSource)

  return {
    bodyModelType: slotModelType,
    bodyModelName: slotModelName,
    bodyThinkingEnabled: slotThinkingEnabled,
    setModel,
    clearModel,
    modelParams
  }
}

export function useDiagnosisModel(workIdSource: () => number) {
  const {
    slotModelType,
    slotModelName,
    slotThinkingEnabled,
    setModel,
    clearModel,
    modelParams
  } = useWorkModelSlot('diagnosis', workIdSource)

  const diagModelType = computed({
    get: () => slotModelType.value,
    set: (v: string | null) => { slotModelType.value = v }
  })

  const diagModelName = computed({
    get: () => slotModelName.value,
    set: (v: string | null) => { slotModelName.value = v }
  })

  const diagThinkingEnabled = computed({
    get: () => slotThinkingEnabled.value,
    set: (v: boolean | null) => { slotThinkingEnabled.value = v }
  })

  return {
    diagModelType,
    diagModelName,
    diagThinkingEnabled,
    setModel,
    clearModel,
    modelParams
  }
}
