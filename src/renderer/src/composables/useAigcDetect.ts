import { ref, watch, onMounted, onUnmounted } from 'vue'
import type {
  AigcDetectResult,
  AigcRewriteSelectionView,
  AigcRewriteCompareView
} from '../../../shared/aigc-detect-types'

export interface AigcSeedOpts {
  mode: 'fast' | 'strong'
  seedText?: string
  workId?: number
  chapterId?: number
}

interface AigcDeltaPayload {
  runId: string
  delta: string
  content: string
}

interface AigcEndPayload {
  runId: string
  success: boolean
  result?: AigcDetectResult
  error?: string
}

interface AigcRewriteSelectionPayload extends AigcRewriteSelectionView {}

export function useAigcDetect() {
  const inputText = ref('')
  const status = ref<'idle' | 'running' | 'done' | 'error'>('idle')
  const rewriting = ref(false)
  const applyingWordTable = ref(false)
  const rewriteProgress = ref<{ message: string; level?: 'info' | 'warn' } | null>(null)
  const rewriteSelection = ref<AigcRewriteSelectionView | null>(null)
  const rewriteCompare = ref<AigcRewriteCompareView | null>(null)
  const errorMessage = ref('')
  const result = ref<AigcDetectResult | null>(null)
  const streamingContent = ref('')
  const currentRunId = ref('')
  const currentRewriteRunId = ref('')
  const seedOpts = ref<AigcSeedOpts>({ mode: 'fast' })

  let runIdCounter = 0

  async function run(labModelParams?: { modelType?: string; modelName?: string }) {
    const text = inputText.value.trim()
    if (!text) throw new Error('请输入待检测文本')

    const runId = `aigc-${Date.now()}-${++runIdCounter}`
    currentRunId.value = runId
    status.value = 'running'
    errorMessage.value = ''
    result.value = null
    rewriteSelection.value = null
    streamingContent.value = ''

    try {
      const detectResult = await window.anovel.invoke(
        'lab:aigc-detect:run', runId, text, labModelParams ?? {}
      ) as AigcDetectResult
      result.value = detectResult
      status.value = 'done'
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'AIGC 检测失败'
      if (msg !== '已取消') {
        status.value = 'error'
        errorMessage.value = msg
      }
      throw error
    }
  }

  async function rewrite(labModelParams?: { modelType?: string; modelName?: string }) {
    const text = inputText.value.trim()
    if (!text) throw new Error('请输入待改写文本')
    if (rewriting.value || applyingWordTable.value) return

    rewriting.value = true
    rewriteProgress.value = null
    rewriteSelection.value = null
    rewriteCompare.value = null
    errorMessage.value = ''
    try {
      const runId = `aigc-rw-${Date.now()}-${++runIdCounter}`
      currentRewriteRunId.value = runId
      const originalText = text
      const detectResultJson = result.value ? JSON.stringify(result.value) : null
      const plainSeedOpts = JSON.parse(JSON.stringify(seedOpts.value))
      const rewritten = await window.anovel.invoke(
        'lab:aigc-detect:rewrite',
        runId,
        text,
        detectResultJson,
        labModelParams ?? {},
        plainSeedOpts
      ) as string
      inputText.value = rewritten
      rewriteCompare.value = {
        originalText,
        rewrittenText: rewritten
      }
      status.value = 'idle'
      result.value = null
      streamingContent.value = ''
    } catch (error) {
      const msg = error instanceof Error ? error.message : '一键改写失败'
      status.value = 'error'
      errorMessage.value = msg
      throw error
    } finally {
      rewriting.value = false
    }
  }

  async function applyWordTableReplace() {
    const text = inputText.value.trim()
    if (!text) throw new Error('请输入待替换文本')
    if (applyingWordTable.value || rewriting.value) return

    applyingWordTable.value = true
    errorMessage.value = ''
    try {
      const originalText = text
      const replaced = await window.anovel.invoke('lab:wordtable:apply', text) as string
      inputText.value = replaced
      rewriteCompare.value = {
        originalText,
        rewrittenText: replaced
      }
      rewriteSelection.value = null
      status.value = 'idle'
      result.value = null
      streamingContent.value = ''
    } catch (error) {
      const msg = error instanceof Error ? error.message : '词表替换失败'
      status.value = 'error'
      errorMessage.value = msg
      throw error
    } finally {
      applyingWordTable.value = false
    }
  }

  async function cancel() {
    if (!currentRunId.value) return
    await window.anovel.invoke('lab:aigc-detect:cancel', currentRunId.value)
    status.value = 'idle'
    streamingContent.value = ''
  }

  function reset() {
    inputText.value = ''
    status.value = 'idle'
    errorMessage.value = ''
    result.value = null
    streamingContent.value = ''
    currentRunId.value = ''
    currentRewriteRunId.value = ''
    rewriteSelection.value = null
    rewriteCompare.value = null
  }

  function onDelta(payload: unknown) {
    const p = payload as AigcDeltaPayload
    streamingContent.value = p.content
  }

  function onEnd(payload: unknown) {
    const p = payload as AigcEndPayload
    if (p.success && p.result) {
      result.value = p.result
      status.value = 'done'
    } else if (p.error === '已取消') {
      status.value = 'idle'
    } else {
      status.value = 'error'
      errorMessage.value = p.error ?? '检测失败'
    }
  }

  const downloadProgress = ref<{ phase: string; percent: number; message: string } | null>(null)

  function onDownloadProgress(payload: unknown) {
    const p = payload as { phase: string; percent: number; message: string }
    if (p.phase === 'ready' || p.phase === 'error') {
      downloadProgress.value = null
    } else {
      downloadProgress.value = p
    }
  }

  function onRewriteProgress(payload: unknown) {
    const p = payload as { runId: string; message: string; level?: 'info' | 'warn' }
    rewriteProgress.value = { message: p.message || '', level: p.level }
  }

  function onRewriteSelection(payload: unknown) {
    const p = payload as AigcRewriteSelectionPayload
    if (!p || typeof p.runId !== 'string') return
    if (currentRewriteRunId.value && p.runId !== currentRewriteRunId.value) return
    rewriteSelection.value = p
  }

  watch(inputText, (next) => {
    const current = rewriteCompare.value
    if (!current) return
    // 用户手改后，旧的改写对比失效，自动清空避免误导。
    if (next !== current.rewrittenText) {
      rewriteCompare.value = null
    }
  })

  onMounted(() => {
    window.anovel.on('lab:aigc-detect:delta', onDelta)
    window.anovel.on('lab:aigc-detect:end', onEnd)
    window.anovel.on('perplexity:download-progress', onDownloadProgress)
    window.anovel.on('lab:aigc-rewrite:progress', onRewriteProgress)
    window.anovel.on('lab:aigc-rewrite:selection', onRewriteSelection)
  })

  onUnmounted(() => {
    window.anovel.off('lab:aigc-detect:delta', onDelta)
    window.anovel.off('lab:aigc-detect:end', onEnd)
    window.anovel.off('perplexity:download-progress', onDownloadProgress)
    window.anovel.off('lab:aigc-rewrite:progress', onRewriteProgress)
    window.anovel.off('lab:aigc-rewrite:selection', onRewriteSelection)
  })

  return {
    inputText,
    status,
    rewriting,
    applyingWordTable,
    rewriteProgress,
    rewriteSelection,
    rewriteCompare,
    errorMessage,
    result,
    streamingContent,
    seedOpts,
    downloadProgress,
    run,
    rewrite,
    applyWordTableReplace,
    cancel,
    reset
  }
}
