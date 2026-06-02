import { ref, computed, onMounted, onUnmounted } from 'vue'

export type AiStepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

export interface AiSessionStep {
  id: string
  label: string
  status: AiStepStatus
}

export interface AiHistoryEntry {
  sessionId: string
  title: string
  success: boolean
  error?: string
  durationMs: number
  endedAt: number
  contentPreview: string
}

export interface AiActivityState {
  sessionId: string
  title: string
  steps: AiSessionStep[]
  startedAt: number
  content: string
  thinkingContent: string
  currentPhase: string
  modelType?: string
  modelName?: string
  status: 'idle' | 'running' | 'success' | 'error' | 'cancelled'
  error?: string
  durationMs?: number
}

const MAX_HISTORY = 8

const active = ref<AiActivityState | null>(null)
const minimized = ref(false)
const history = ref<AiHistoryEntry[]>([])
const showHistory = ref(false)
const thinkingExpanded = ref(true)
let tickTimer: ReturnType<typeof setInterval> | null = null
const elapsedMs = ref(0)

function startTick(startedAt: number) {
  stopTick()
  elapsedMs.value = Date.now() - startedAt
  tickTimer = setInterval(() => {
    elapsedMs.value = Date.now() - startedAt
  }, 1000)
}

function stopTick() {
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
}

function pushHistory(state: AiActivityState) {
  history.value = [
    {
      sessionId: state.sessionId,
      title: state.title,
      success: state.status === 'success',
      error: state.error,
      durationMs: state.durationMs ?? elapsedMs.value,
      endedAt: Date.now(),
      contentPreview: state.content.slice(0, 200)
    },
    ...history.value
  ].slice(0, MAX_HISTORY)
}

let eventsBound = false

export function useAiActivity() {
  const isRunning = computed(() => active.value?.status === 'running')
  const isVisible = computed(() => !!active.value && !minimized.value)
  const isMinimized = computed(() => !!active.value && minimized.value)

  function bindEvents() {
    if (eventsBound) return
    eventsBound = true

    window.anovel.on('ai:session-start', (payload: unknown) => {
      const p = payload as {
        sessionId: string
        title: string
        steps: AiSessionStep[]
        startedAt: number
      }
      minimized.value = false
      showHistory.value = false
      active.value = {
        sessionId: p.sessionId,
        title: p.title,
        steps: p.steps ?? [],
        startedAt: p.startedAt,
        content: '',
        thinkingContent: '',
        currentPhase: '准备中…',
        status: 'running'
      }
      thinkingExpanded.value = true
      startTick(p.startedAt)
    })

    window.anovel.on('ai:phase', (payload: unknown) => {
      const p = payload as { sessionId: string; label: string; status: AiStepStatus; stepIndex?: number }
      if (!active.value || active.value.sessionId !== p.sessionId) return
      active.value.currentPhase = p.label
      if (p.stepIndex !== undefined && active.value.steps[p.stepIndex]) {
        active.value.steps[p.stepIndex].status = p.status
      }
    })

    window.anovel.on('ai:delta', (payload: unknown) => {
      const p = payload as { sessionId: string; content: string }
      if (!active.value || active.value.sessionId !== p.sessionId) return
      active.value.content = p.content
    })

    window.anovel.on('ai:thinking-delta', (payload: unknown) => {
      const p = payload as { sessionId: string; thinking: string }
      if (!active.value || active.value.sessionId !== p.sessionId) return
      active.value.thinkingContent = p.thinking
      thinkingExpanded.value = true
    })

    window.anovel.on('ai:model-info', (payload: unknown) => {
      const p = payload as { sessionId: string; modelType: string; modelName?: string }
      if (!active.value || active.value.sessionId !== p.sessionId) return
      active.value.modelType = p.modelType
      active.value.modelName = p.modelName
    })

    window.anovel.on('ai:session-end', (payload: unknown) => {
      const p = payload as {
        sessionId: string
        success: boolean
        error?: string
        durationMs: number
        modelType?: string
        modelName?: string
      }
      if (!active.value || active.value.sessionId !== p.sessionId) return
      active.value.status = p.success ? 'success' : 'error'
      active.value.error = p.error
      active.value.durationMs = p.durationMs
      active.value.modelType = p.modelType ?? active.value.modelType
      active.value.modelName = p.modelName ?? active.value.modelName
      stopTick()
      elapsedMs.value = p.durationMs
      pushHistory(active.value)
    })

    window.anovel.on('ai:session-cancelled', (payload: unknown) => {
      const p = payload as { sessionId: string }
      if (!active.value || active.value.sessionId !== p.sessionId) return
      active.value.status = 'cancelled'
      active.value.error = '已取消'
      stopTick()
      pushHistory(active.value)
    })
  }

  async function cancelSession() {
    if (!active.value || active.value.status !== 'running') return
    await window.anovel.invoke('ai:cancelSession', active.value.sessionId)
  }

  function minimize() {
    minimized.value = true
  }

  function restore() {
    minimized.value = false
  }

  function dismiss() {
    stopTick()
    active.value = null
    minimized.value = false
  }

  function toggleHistory() {
    showHistory.value = !showHistory.value
  }

  function formatDuration(ms: number): string {
    const sec = Math.floor(ms / 1000)
    if (sec < 60) return `${sec}s`
    return `${Math.floor(sec / 60)}m ${sec % 60}s`
  }

  return {
    active,
    minimized,
    history,
    showHistory,
    thinkingExpanded,
    elapsedMs,
    isRunning,
    isVisible,
    isMinimized,
    bindEvents,
    cancelSession,
    minimize,
    restore,
    dismiss,
    toggleHistory,
    formatDuration
  }
}

export function useAiActivityLifecycle() {
  const activity = useAiActivity()

  onMounted(() => {
    activity.bindEvents()
  })

  onUnmounted(() => {
    stopTick()
  })

  return activity
}
