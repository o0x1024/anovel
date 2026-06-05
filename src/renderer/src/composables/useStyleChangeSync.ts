import { onActivated, onMounted, onUnmounted } from 'vue'

/**
 * 监听文风变更并在页面激活时刷新（适配 App.vue KeepAlive）。
 */
export function useStyleChangeSync(reload: () => void | Promise<void>): void {
  const run = () => {
    void reload()
  }

  onMounted(() => {
    window.anovel.on('style:changed', run)
  })

  onUnmounted(() => {
    window.anovel.off('style:changed', run)
  })

  onActivated(run)
}
