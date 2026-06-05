import { onUnmounted, ref, type Ref } from 'vue'

const STORAGE_KEY = 'anovel:ai-activity-panel-position'
const VIEWPORT_MARGIN = 16
const DRAG_THRESHOLD = 4

export interface PanelPosition {
  left: number
  top: number
}

function clampPosition(left: number, top: number, width: number, height: number): PanelPosition {
  const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)
  const maxTop = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN)
  return {
    left: Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, left)),
    top: Math.min(maxTop, Math.max(VIEWPORT_MARGIN, top))
  }
}

function defaultPosition(width: number, height: number): PanelPosition {
  return clampPosition(
    window.innerWidth - width - VIEWPORT_MARGIN,
    window.innerHeight - height - VIEWPORT_MARGIN,
    width,
    height
  )
}

function loadPosition(): PanelPosition | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { left?: number; top?: number }
    if (typeof parsed.left !== 'number' || typeof parsed.top !== 'number') return null
    return { left: parsed.left, top: parsed.top }
  } catch {
    return null
  }
}

function savePosition(pos: PanelPosition) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(pos))
}

export function useAiPanelPosition(
  panelWidth: Ref<number>,
  panelHeight: Ref<number>
) {
  const position = ref<PanelPosition>(defaultPosition(panelWidth.value, panelHeight.value))
  const isDragging = ref(false)
  const didDrag = ref(false)

  let dragStartX = 0
  let dragStartY = 0
  let dragOriginLeft = 0
  let dragOriginTop = 0
  let dragWidth = 0
  let dragHeight = 0

  function ensurePosition(width: number, height: number) {
    const saved = loadPosition()
    position.value = saved
      ? clampPosition(saved.left, saved.top, width, height)
      : defaultPosition(width, height)
  }

  function clampToViewport(width?: number, height?: number) {
    position.value = clampPosition(
      position.value.left,
      position.value.top,
      width ?? panelWidth.value,
      height ?? panelHeight.value
    )
  }

  function onDragMove(e: MouseEvent) {
    const dx = e.clientX - dragStartX
    const dy = e.clientY - dragStartY
    if (!didDrag.value && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
    didDrag.value = true
    isDragging.value = true
    position.value = clampPosition(dragOriginLeft + dx, dragOriginTop + dy, dragWidth, dragHeight)
  }

  function onDragEnd() {
    window.removeEventListener('mousemove', onDragMove)
    window.removeEventListener('mouseup', onDragEnd)
    if (isDragging.value || didDrag.value) {
      savePosition(position.value)
    }
    isDragging.value = false
  }

  function startDrag(e: MouseEvent, width: number, height: number) {
    if (e.button !== 0) return
    e.preventDefault()
    didDrag.value = false
    isDragging.value = false
    dragStartX = e.clientX
    dragStartY = e.clientY
    dragOriginLeft = position.value.left
    dragOriginTop = position.value.top
    dragWidth = width
    dragHeight = height
    window.addEventListener('mousemove', onDragMove)
    window.addEventListener('mouseup', onDragEnd)
  }

  /** 折叠为 pill 时，将锚点对齐到面板右下角 */
  function alignToPanelBottomRight(panelW: number, panelH: number, pillW: number, pillH: number) {
    position.value = clampPosition(
      position.value.left + panelW - pillW,
      position.value.top + panelH - pillH,
      pillW,
      pillH
    )
    savePosition(position.value)
  }

  function onWindowResize() {
    clampToViewport()
  }

  window.addEventListener('resize', onWindowResize)
  onUnmounted(() => {
    window.removeEventListener('resize', onWindowResize)
    onDragEnd()
  })

  return {
    position,
    isDragging,
    didDrag,
    ensurePosition,
    clampToViewport,
    startDrag,
    alignToPanelBottomRight
  }
}
