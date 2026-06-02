import { nextTick, ref, watch, type Ref } from 'vue'

const SCROLL_THRESHOLD = 32

export function useStickToBottomScroll(
  containerRef: Ref<HTMLElement | null>,
  watchSources: () => unknown[]
) {
  const stickToBottom = ref(true)

  function isNearBottom(el: HTMLElement) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD
  }

  function scrollToBottom(force = false) {
    const el = containerRef.value
    if (!el || (!force && !stickToBottom.value)) return
    el.scrollTop = el.scrollHeight
  }

  function onScroll() {
    const el = containerRef.value
    if (!el) return
    stickToBottom.value = isNearBottom(el)
  }

  function jumpToBottom() {
    stickToBottom.value = true
    scrollToBottom(true)
  }

  function resetStickToBottom() {
    stickToBottom.value = true
    void nextTick(() => scrollToBottom(true))
  }

  watch(watchSources, async () => {
    await nextTick()
    scrollToBottom()
  })

  return {
    stickToBottom,
    onScroll,
    jumpToBottom,
    resetStickToBottom
  }
}
