import { onMounted, onUnmounted, ref } from 'vue'

const STORAGE_KEY = 'anovel:sidebar-width'
const DEFAULT_WIDTH = 256
const MIN_WIDTH = 180
const MAX_WIDTH = 480

function clampWidth(width: number): number {
  const maxByViewport = Math.min(MAX_WIDTH, Math.floor(window.innerWidth * 0.45))
  return Math.min(maxByViewport, Math.max(MIN_WIDTH, Math.round(width)))
}

function loadSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_WIDTH
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return DEFAULT_WIDTH
    return clampWidth(parsed)
  } catch {
    return DEFAULT_WIDTH
  }
}

function saveSidebarWidth(width: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(width))
  } catch {
    /* quota or private mode */
  }
}

export function useSidebarWidth() {
  const width = ref(loadSidebarWidth())
  const isResizing = ref(false)

  let startX = 0
  let startWidth = 0

  function onResizeMove(event: MouseEvent) {
    width.value = clampWidth(startWidth + (event.clientX - startX))
  }

  function stopResize() {
    isResizing.value = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    window.removeEventListener('mousemove', onResizeMove)
    window.removeEventListener('mouseup', stopResize)
    saveSidebarWidth(width.value)
  }

  function startResize(event: MouseEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    isResizing.value = true
    startX = event.clientX
    startWidth = width.value
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('mousemove', onResizeMove)
    window.addEventListener('mouseup', stopResize)
  }

  function onWindowResize() {
    width.value = clampWidth(width.value)
  }

  onMounted(() => {
    window.addEventListener('resize', onWindowResize)
  })

  onUnmounted(() => {
    window.removeEventListener('resize', onWindowResize)
    stopResize()
  })

  return {
    width,
    isResizing,
    startResize
  }
}
