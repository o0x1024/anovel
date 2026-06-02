import { onUnmounted, ref } from 'vue'

const STORAGE_KEY = 'anovel:ai-activity-panel-size'

const DEFAULT_WIDTH = 420
const DEFAULT_HEIGHT = 520
const MIN_WIDTH = 300
const MIN_HEIGHT = 260
const VIEWPORT_MARGIN = 32

export function maxPanelWidth() {
  return Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_MARGIN)
}

export function maxPanelHeight() {
  return Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_MARGIN)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function loadSize(): { width: number; height: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
    const parsed = JSON.parse(raw) as { width?: number; height?: number }
    return {
      width: clamp(parsed.width ?? DEFAULT_WIDTH, MIN_WIDTH, maxPanelWidth()),
      height: clamp(parsed.height ?? DEFAULT_HEIGHT, MIN_HEIGHT, maxPanelHeight())
    }
  } catch {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT }
  }
}

function saveSize(width: number, height: number) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ width, height }))
}

type ResizeEdge = 'corner' | 'top' | 'left'

export function useAiPanelResize() {
  const saved = loadSize()
  const panelWidth = ref(saved.width)
  const panelHeight = ref(saved.height)
  const isResizing = ref(false)

  let startX = 0
  let startY = 0
  let startWidth = 0
  let startHeight = 0
  let activeEdge: ResizeEdge = 'corner'

  function clampToViewport() {
    panelWidth.value = clamp(panelWidth.value, MIN_WIDTH, maxPanelWidth())
    panelHeight.value = clamp(panelHeight.value, MIN_HEIGHT, maxPanelHeight())
  }

  function onResizeMove(e: MouseEvent) {
    if (activeEdge === 'corner' || activeEdge === 'left') {
      const deltaX = startX - e.clientX
      panelWidth.value = clamp(startWidth + deltaX, MIN_WIDTH, maxPanelWidth())
    }
    if (activeEdge === 'corner' || activeEdge === 'top') {
      const deltaY = startY - e.clientY
      panelHeight.value = clamp(startHeight + deltaY, MIN_HEIGHT, maxPanelHeight())
    }
  }

  function onResizeEnd() {
    isResizing.value = false
    clampToViewport()
    saveSize(panelWidth.value, panelHeight.value)
    window.removeEventListener('mousemove', onResizeMove)
    window.removeEventListener('mouseup', onResizeEnd)
  }

  function startResize(e: MouseEvent, edge: ResizeEdge) {
    e.preventDefault()
    e.stopPropagation()
    isResizing.value = true
    activeEdge = edge
    startX = e.clientX
    startY = e.clientY
    startWidth = panelWidth.value
    startHeight = panelHeight.value
    window.addEventListener('mousemove', onResizeMove)
    window.addEventListener('mouseup', onResizeEnd)
  }

  function onWindowResize() {
    clampToViewport()
  }

  window.addEventListener('resize', onWindowResize)
  onUnmounted(() => {
    window.removeEventListener('resize', onWindowResize)
    onResizeEnd()
  })

  return {
    panelWidth,
    panelHeight,
    isResizing,
    startResize,
    clampToViewport
  }
}
