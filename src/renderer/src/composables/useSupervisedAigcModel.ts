import { onMounted, ref } from 'vue'
import type { DownloadProgress } from './usePerplexityModels'

export interface SupervisedAigcModelInfo {
  id: string
  name: string
  description: string
  sizeBytes: number
  ready: boolean
  localSizeBytes: number
  sourceModel: string
}

export function useSupervisedAigcModel() {
  const model = ref<SupervisedAigcModelInfo | null>(null)
  const downloading = ref(false)
  const downloadProgress = ref<DownloadProgress | null>(null)

  async function refresh() {
    model.value = await window.anovel.invoke('supervised-aigc:model-info') as SupervisedAigcModelInfo
  }

  async function download() {
    if (downloading.value) return
    downloading.value = true
    const handler = (...args: unknown[]) => {
      downloadProgress.value = args[1] as DownloadProgress
    }
    window.anovel.on('supervised-aigc:download-progress', handler)
    try {
      await window.anovel.invoke('supervised-aigc:download-model')
      await refresh()
    } finally {
      window.anovel.off('supervised-aigc:download-progress', handler)
      downloading.value = false
      downloadProgress.value = null
    }
  }

  async function remove() {
    await window.anovel.invoke('supervised-aigc:delete-model')
    await refresh()
  }

  onMounted(refresh)
  return { model, downloading, downloadProgress, refresh, download, remove }
}
