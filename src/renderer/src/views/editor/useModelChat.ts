import { ref } from 'vue'
import { useBodyGenerationModel } from '../../composables/useBodyGenerationModel'

export interface ContextBudgetReport {
  maxContextTokens: number
  reservedOutputTokens: number
  inputBudget: number
  usedTokens: number
  usageRatio: number
  pressure: 'safe' | 'warning' | 'critical' | 'blocking'
  warnings: string[]
  sections: {
    key: string
    label: string
    tokens: number
    included: boolean
    trimmed: boolean
    target?: 'system' | 'user'
    note?: string
  }[]
  continuityMode: 'full' | 'tail' | 'none'
}

export interface ModelChatResult {
  success: boolean
  content: string
  error?: string
  contextBudget?: ContextBudgetReport
}

export function useModelChat(workId: () => number) {
  const { modelParams: bodyModelParams } = useBodyGenerationModel(workId)
  const loading = ref(false)
  const result = ref('')
  const error = ref('')
  const contextBudget = ref<ContextBudgetReport | null>(null)

  async function chat(
    prompt: string,
    systemPrompt: string,
    step: string,
    extra?: {
      maxTokens?: number
      modelType?: string
      modelName?: string
      enrichWorkContext?: boolean
      enrichNarrativeMemory?: boolean
      chapterId?: number
      volumeId?: number
      workContextOptions?: {
        includeIdea?: boolean
        includeIncubator?: boolean
        includeCoreSettings?: boolean
        includeVolumes?: boolean
        excludeCoreTypes?: string[]
        volumeOutlineMode?: 'full' | 'compact' | 'names_only'
        currentVolumeId?: number
        includeQualityIssues?: boolean
      }
    }
  ): Promise<ModelChatResult> {
    loading.value = true
    error.value = ''
    result.value = ''
    contextBudget.value = null
    try {
      const res = await window.anovel.invoke('model:chat', {
        prompt,
        systemPrompt,
        workId: workId(),
        step,
        ...bodyModelParams(),
        ...extra
      }) as ModelChatResult
      if (res.contextBudget) {
        contextBudget.value = res.contextBudget
      }
      if (res.success) {
        result.value = res.content
      } else {
        error.value = res.error || '生成失败'
      }
      return res
    } catch (e) {
      error.value = String(e)
      return { success: false, content: '', error: error.value }
    } finally {
      loading.value = false
    }
  }

  function clearResult() {
    result.value = ''
    error.value = ''
    contextBudget.value = null
  }

  return { loading, result, error, contextBudget, chat, clearResult }
}
