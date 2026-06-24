import { onActivated, onMounted, onUnmounted } from 'vue'

/**
 * 监听模型配置变更并在页面激活时刷新（适配 App.vue KeepAlive）。
 */
export function useModelConfigChangeSync(reload: () => void | Promise<void>): void {
  const run = () => {
    void reload()
  }

  onMounted(() => {
    window.anovel.on('model:config-changed', run)
  })

  onUnmounted(() => {
    window.anovel.off('model:config-changed', run)
  })

  onActivated(run)
}
