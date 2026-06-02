import { defineStore } from 'pinia'
import { ref } from 'vue'

interface ModelConfig {
  modelType: string
  apiKey: string
  apiBase: string
  isEnabled: boolean
  priority: number
}

export const useModelStore = defineStore('model', () => {
  const configs = ref<ModelConfig[]>([
    { modelType: 'deepseek', apiKey: '', apiBase: 'https://api.deepseek.com/v1', isEnabled: true, priority: 1 },
    { modelType: 'openai', apiKey: '', apiBase: 'https://api.openai.com/v1', isEnabled: false, priority: 2 }
  ])

  const activeModel = ref<string | null>(null)

  function getActiveConfig(): ModelConfig | null {
    const enabled = configs.value
      .filter(c => c.isEnabled && c.apiKey)
      .sort((a, b) => a.priority - b.priority)
    return enabled[0] || null
  }

  return { configs, activeModel, getActiveConfig }
})
