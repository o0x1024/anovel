import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import type {
  AigcDetectResult,
  AigcRewriteSelectionView,
  AigcRewriteCompareView
} from '../../../shared/aigc-detect-types'
import type { WorkModelOptions } from '../../../shared/work-model-options'
import type {
  AigcSentencePatch,
  AigcSentencePatchDecision,
  AigcRewriteGoalResult,
  AigcSentenceRewriteEvent,
  AigcSentenceRewriteResult
} from '../../../shared/aigc-sentence-rewrite-types'
import { AIGC_REWRITE_REQUIRED_TARGET_COVERAGE_PERCENT } from '../../../shared/aigc-sentence-rewrite-types'
import { applySentencePatches } from '../../../shared/aigc-sentence-patches'

export interface AigcSeedOpts {
  mode: 'fast' | 'strong'
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
  const rewriteBaseText = ref('')
  const rewritePatches = ref<AigcSentencePatch[]>([])
  const rewriteGoal = ref<AigcRewriteGoalResult | null>(null)
  const rewriteDecisions = ref<Record<string, AigcSentencePatchDecision>>({})
  const needsManualRecheck = ref(false)
  const errorMessage = ref('')
  const result = ref<AigcDetectResult | null>(null)
  const streamingContent = ref('')
  const currentRunId = ref('')
  const currentRewriteRunId = ref('')
  const seedOpts = ref<AigcSeedOpts>({ mode: 'strong' })

  let runIdCounter = 0
  let applyingAcceptedPatches = false

  const rewritePreviewText = computed(() => {
    if (!rewriteBaseText.value) return ''
    const visibleIds = rewritePatches.value
      .filter(patch => patch.status === 'passed' && rewriteDecisions.value[patch.id] !== 'rejected')
      .map(patch => patch.id)
    return applySentencePatches(rewriteBaseText.value, rewritePatches.value, visibleIds)
  })

  const acceptedRewriteCoveragePercent = computed(() => {
    const targetPatches = rewritePatches.value
    const total = targetPatches.reduce(
      (sum, patch) => sum + Math.max(1, patch.originalText.replace(/\s+/g, '').length),
      0
    )
    if (total === 0) return 0
    const accepted = targetPatches.reduce((sum, patch) => {
      if (patch.status !== 'passed' || rewriteDecisions.value[patch.id] !== 'accepted') return sum
      return sum + Math.max(1, patch.originalText.replace(/\s+/g, '').length)
    }, 0)
    return Math.round(accepted / total * 1000) / 10
  })

  function clearSentenceRewrite() {
    rewriteBaseText.value = ''
    rewritePatches.value = []
    rewriteDecisions.value = {}
    rewriteProgress.value = null
    rewriteGoal.value = null
  }

  async function run(labModelParams?: WorkModelOptions) {
    const text = inputText.value.trim()
    if (!text) throw new Error('请输入待检测文本')

    const runId = `aigc-${Date.now()}-${++runIdCounter}`
    currentRunId.value = runId
    status.value = 'running'
    errorMessage.value = ''
    result.value = null
    rewriteSelection.value = null
    clearSentenceRewrite()
    streamingContent.value = ''

    try {
      const detectResult = await window.anovel.invoke(
        'lab:aigc-detect:run', runId, text, labModelParams ?? {}
      ) as AigcDetectResult
      result.value = detectResult
      status.value = 'done'
      needsManualRecheck.value = false
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'AIGC 检测失败'
      if (msg !== '已取消') {
        status.value = 'error'
        errorMessage.value = msg
      }
      throw error
    }
  }

  async function rewrite(labModelParams?: WorkModelOptions) {
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
      rewriteBaseText.value = originalText
      rewritePatches.value = []
      rewriteDecisions.value = {}
      const detectResultJson = result.value ? JSON.stringify(result.value) : null
      const plainSeedOpts = JSON.parse(JSON.stringify(seedOpts.value))
      const rewriteResult = await window.anovel.invoke(
        'lab:aigc-detect:rewrite',
        runId,
        text,
        detectResultJson,
        labModelParams ?? {},
        plainSeedOpts
      ) as AigcSentenceRewriteResult
      rewriteBaseText.value = rewriteResult.originalText
      rewritePatches.value = rewriteResult.patches
      rewriteGoal.value = rewriteResult.goal
      const decisions = { ...rewriteDecisions.value }
      for (const patch of rewriteResult.patches) {
        if (patch.status === 'passed' && !decisions[patch.id]) decisions[patch.id] = 'pending'
      }
      rewriteDecisions.value = decisions
    } catch (error) {
      const msg = error instanceof Error ? error.message : '一键改写失败'
      if (msg !== '已取消') {
        status.value = 'error'
        errorMessage.value = msg
      }
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
    const runId = rewriting.value ? currentRewriteRunId.value : currentRunId.value
    if (!runId) return
    await window.anovel.invoke('lab:aigc-detect:cancel', runId)
    if (!rewriting.value) status.value = 'idle'
    streamingContent.value = ''
  }

  function decideSentencePatch(id: string, decision: Exclude<AigcSentencePatchDecision, 'pending'>) {
    const patch = rewritePatches.value.find(item => item.id === id)
    if (!patch || patch.status !== 'passed') return
    rewriteDecisions.value = { ...rewriteDecisions.value, [id]: decision }
  }

  function acceptAllSentencePatches() {
    const decisions = { ...rewriteDecisions.value }
    for (const patch of rewritePatches.value) {
      if (patch.status === 'passed') decisions[patch.id] = 'accepted'
    }
    rewriteDecisions.value = decisions
  }

  function applyAcceptedSentencePatches() {
    const acceptedIds = Object.entries(rewriteDecisions.value)
      .filter(([, decision]) => decision === 'accepted')
      .map(([id]) => id)
    if (acceptedIds.length === 0) throw new Error('请先接受至少一个语义块改写补丁')
    if (acceptedRewriteCoveragePercent.value < AIGC_REWRITE_REQUIRED_TARGET_COVERAGE_PERCENT) {
      throw new Error(
        `已接受补丁仅覆盖目标文本 ${acceptedRewriteCoveragePercent.value}%，至少需要 ${AIGC_REWRITE_REQUIRED_TARGET_COVERAGE_PERCENT}%`
      )
    }
    const applied = applySentencePatches(rewriteBaseText.value, rewritePatches.value, acceptedIds)
    applyingAcceptedPatches = true
    inputText.value = applied
    applyingAcceptedPatches = false
    status.value = 'idle'
    result.value = null
    streamingContent.value = ''
    clearSentenceRewrite()
    needsManualRecheck.value = true
  }

  function reset() {
    inputText.value = ''
    status.value = 'idle'
    errorMessage.value = ''
    result.value = null
    streamingContent.value = ''
    currentRunId.value = ''
    currentRewriteRunId.value = ''
    needsManualRecheck.value = false
    rewriteSelection.value = null
    rewriteCompare.value = null
    clearSentenceRewrite()
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

  function onSentenceRewrite(payload: unknown) {
    const event = payload as AigcSentenceRewriteEvent
    if (!event?.patch || event.runId !== currentRewriteRunId.value) return
    const index = rewritePatches.value.findIndex(item => item.id === event.patch.id)
    if (index < 0) {
      rewritePatches.value = [...rewritePatches.value, event.patch].sort((a, b) => a.start - b.start)
    } else {
      const next = [...rewritePatches.value]
      next[index] = event.patch
      rewritePatches.value = next
    }
    if (event.patch.status === 'passed' && !rewriteDecisions.value[event.patch.id]) {
      rewriteDecisions.value = { ...rewriteDecisions.value, [event.patch.id]: 'pending' }
    }
  }

  watch(inputText, (next) => {
    if (!applyingAcceptedPatches && rewriteBaseText.value && next.trim() !== rewriteBaseText.value) {
      clearSentenceRewrite()
    }
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
    window.anovel.on('supervised-aigc:download-progress', onDownloadProgress)
    window.anovel.on('lab:aigc-rewrite:progress', onRewriteProgress)
    window.anovel.on('lab:aigc-rewrite:selection', onRewriteSelection)
    window.anovel.on('lab:aigc-rewrite:sentence', onSentenceRewrite)
  })

  onUnmounted(() => {
    window.anovel.off('lab:aigc-detect:delta', onDelta)
    window.anovel.off('lab:aigc-detect:end', onEnd)
    window.anovel.off('perplexity:download-progress', onDownloadProgress)
    window.anovel.off('supervised-aigc:download-progress', onDownloadProgress)
    window.anovel.off('lab:aigc-rewrite:progress', onRewriteProgress)
    window.anovel.off('lab:aigc-rewrite:selection', onRewriteSelection)
    window.anovel.off('lab:aigc-rewrite:sentence', onSentenceRewrite)
  })

  return {
    inputText,
    status,
    rewriting,
    applyingWordTable,
    rewriteProgress,
    rewriteSelection,
    rewriteCompare,
    rewriteBaseText,
    rewritePatches,
    rewriteGoal,
    needsManualRecheck,
    rewriteDecisions,
    rewritePreviewText,
    errorMessage,
    result,
    streamingContent,
    seedOpts,
    downloadProgress,
    run,
    rewrite,
    applyWordTableReplace,
    decideSentencePatch,
    acceptAllSentencePatches,
    applyAcceptedSentencePatches,
    cancel,
    reset
  }
}
