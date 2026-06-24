import { ref } from 'vue'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  type: ToastType
  message: string
}

const toasts = ref<ToastItem[]>([])
let toastId = 0

export function useToast() {
  function showToast(type: ToastType, message: string, durationMs = 3000) {
    const id = ++toastId
    toasts.value.push({ id, type, message })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, durationMs)
  }

  function toastAlertClass(type: ToastType): string {
    if (type === 'success') return 'alert-success'
    if (type === 'error') return 'alert-error'
    return 'alert-info'
  }

  return { toasts, showToast, toastAlertClass }
}
