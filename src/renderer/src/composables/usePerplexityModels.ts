import { ref, onMounted } from 'vue'

export interface PplModelInfo {
  id: string
  name: string
  description: string
  sizeBytes: number
  ready: boolean
  active: boolean
  localSizeBytes: number
}

export interface DownloadProgress {
  phase: 'checking' | 'downloading' | 'ready' | 'error'
  percent: number
  downloadedBytes: number
  totalBytes: number
  message: string
}

export function usePerplexityModels() {
  const models = ref<PplModelInfo[]>([])
  const loading = ref(false)
  const downloading = ref<string | null>(null)
  const downloadProgress = ref<DownloadProgress | null>(null)

  async function refresh() {
    try {
      models.value = await window.anovel.invoke('perplexity:list-models') as PplModelInfo[]
    } catch { /* ignore */ }
  }

  async function switchModel(modelId: string) {
    loading.value = true
    try {
      await window.anovel.invoke('perplexity:switch-model', modelId)
      await refresh()
    } finally {
      loading.value = false
    }
  }

  async function deleteModel(modelId: string) {
    await window.anovel.invoke('perplexity:delete-model-by-id', modelId)
    await refresh()
  }

  async function downloadModel(modelId: string) {
    if (downloading.value) return
    downloading.value = modelId
    downloadProgress.value = { phase: 'checking', percent: 0, downloadedBytes: 0, totalBytes: 0, message: '准备中…' }

    const handler = (_e: unknown, progress: DownloadProgress) => {
      downloadProgress.value = progress
    }
    window.anovel.on('perplexity:download-progress', handler)

    try {
      await window.anovel.invoke('perplexity:download-model', modelId)
      await refresh()
    } finally {
      downloading.value = null
      downloadProgress.value = null
      window.anovel.off('perplexity:download-progress', handler)
    }
  }

  const activeModel = () => models.value.find(m => m.active)

  onMounted(refresh)

  return {
    models,
    loading,
    downloading,
    downloadProgress,
    refresh,
    switchModel,
    deleteModel,
    downloadModel,
    activeModel
  }
}
