import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { LabTaskRow } from '../../../shared/lab-types'
import { normalizeBodyParagraphSpacing } from '../../../shared/normalize-body-text'

export interface LabWritingStyleOption {
  id: number
  name: string
  description: string | null
  is_builtin: number
}

interface LabDeltaPayload {
  taskId: number
  delta: string
  content: string
}

interface LabRunEndPayload {
  taskId: number
  success: boolean
  error?: string
}

export function useDeaiTask() {
  const originalText = ref('')
  const resultText = ref('')
  const styleId = ref<number | null>(null)
  const writingStyles = ref<LabWritingStyleOption[]>([])
  const status = ref<'idle' | 'running' | 'done' | 'error'>('idle')
  const errorMessage = ref('')
  const currentTaskId = ref<number | null>(null)
  const sourceFile = ref('')
  const historyList = ref<LabTaskRow[]>([])
  const loadingHistory = ref(false)

  const styleNameById = computed(() => {
    const map = new Map<number, string>()
    for (const style of writingStyles.value) {
      map.set(style.id, style.name)
    }
    return map
  })

  async function loadWritingStyles() {
    const rows = await window.anovel.invoke('style:list') as LabWritingStyleOption[]
    writingStyles.value = rows
    if (rows.length && !styleId.value) {
      styleId.value = rows[0].id
    }
  }

  async function refreshHistory() {
    loadingHistory.value = true
    try {
      historyList.value = await window.anovel.invoke('lab:taskList') as LabTaskRow[]
    } finally {
      loadingHistory.value = false
    }
  }

  async function run() {
    const text = originalText.value.trim()
    if (!text) throw new Error('请输入待处理文本')
    if (!styleId.value) throw new Error('请选择文风')
    const created = await window.anovel.invoke('lab:taskCreate', {
      originalText: text,
      styleId: styleId.value,
      sourceFile: sourceFile.value.trim() || undefined
    }) as LabTaskRow | undefined

    if (!created) throw new Error('创建任务失败')

    currentTaskId.value = created.id
    resultText.value = ''
    status.value = 'running'
    errorMessage.value = ''

    try {
      await window.anovel.invoke('lab:run', created.id)
    } catch (error) {
      status.value = 'error'
      errorMessage.value = error instanceof Error ? error.message : '处理失败'
      throw error
    } finally {
      await refreshHistory()
    }
  }

  async function cancel() {
    if (!currentTaskId.value) return
    await window.anovel.invoke('lab:cancelRun', currentTaskId.value)
  }

  async function loadFromHistory(taskId: number) {
    const task = await window.anovel.invoke('lab:taskGet', taskId) as LabTaskRow | undefined
    if (!task) return
    currentTaskId.value = task.id
    originalText.value = task.original_text ? normalizeBodyParagraphSpacing(task.original_text) : ''
    resultText.value = task.result_text ? normalizeBodyParagraphSpacing(task.result_text) : ''
    styleId.value = task.style_id
    sourceFile.value = task.source_file ?? ''
    errorMessage.value = task.error_message ?? ''
    status.value = task.status === 'pending' ? 'idle' : task.status
  }

  async function deleteHistory(taskId: number) {
    await window.anovel.invoke('lab:taskDelete', taskId)
    if (currentTaskId.value === taskId) {
      currentTaskId.value = null
      resultText.value = ''
      status.value = 'idle'
      errorMessage.value = ''
    }
    await refreshHistory()
  }

  function reset() {
    currentTaskId.value = null
    originalText.value = ''
    resultText.value = ''
    sourceFile.value = ''
    styleId.value = writingStyles.value[0]?.id ?? null
    status.value = 'idle'
    errorMessage.value = ''
  }

  function onDelta(payload: LabDeltaPayload) {
    if (payload.taskId !== currentTaskId.value) return
    resultText.value = payload.content
  }

  function onRunEnd(payload: LabRunEndPayload) {
    if (payload.taskId !== currentTaskId.value) return
    if (payload.success) {
      status.value = 'done'
      errorMessage.value = ''
      return
    }
    if (payload.error === '已取消') {
      status.value = 'done'
      errorMessage.value = ''
      return
    }
    status.value = 'error'
    errorMessage.value = payload.error ?? '处理失败'
  }

  const deltaHandler = (payload: unknown) => onDelta(payload as LabDeltaPayload)
  const endHandler = (payload: unknown) => onRunEnd(payload as LabRunEndPayload)

  onMounted(() => {
    window.anovel.on('lab:delta', deltaHandler)
    window.anovel.on('lab:run-end', endHandler)
    void loadWritingStyles()
    void refreshHistory()
  })

  onUnmounted(() => {
    window.anovel.off('lab:delta', deltaHandler)
    window.anovel.off('lab:run-end', endHandler)
  })

  return {
    originalText,
    resultText,
    styleId,
    writingStyles,
    styleNameById,
    sourceFile,
    status,
    errorMessage,
    currentTaskId,
    historyList,
    loadingHistory,
    refreshHistory,
    run,
    cancel,
    loadFromHistory,
    deleteHistory,
    reset
  }
}
