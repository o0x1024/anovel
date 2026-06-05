import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useStyleChangeSync } from './useStyleChangeSync'
import type { LabTaskRow } from '../../../shared/lab-types'
import { normalizeBodyParagraphSpacing } from '../../../shared/normalize-body-text'
import {
  loadLabPageState,
  saveLabPageState,
  type LabResultViewMode
} from '../services/labPageState'

function parseAntiAiRulesFromTask(task: LabTaskRow): string[] {
  const raw = task.anti_ai_rules_json
  if (!raw?.trim()) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
  } catch {
    return []
  }
}

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

function plainStringList(values: string[]): string[] {
  return values.map(v => String(v))
}

export function useDeaiTask() {
  const originalText = ref('')
  const resultText = ref('')
  const styleId = ref<number | null>(null)
  const systemPrompt = ref('')
  const writingStyles = ref<LabWritingStyleOption[]>([])
  const status = ref<'idle' | 'running' | 'done' | 'error'>('idle')
  const errorMessage = ref('')
  const currentTaskId = ref<number | null>(null)
  const sourceFile = ref('')
  const selectedAntiAiRules = ref<string[]>([])
  const resultViewMode = ref<LabResultViewMode>('diff')
  const historyList = ref<LabTaskRow[]>([])
  const loadingHistory = ref(false)
  const suppressSystemPromptRefresh = ref(true)

  let persistTimer: ReturnType<typeof setTimeout> | null = null

  function persistPageStateNow() {
    saveLabPageState({
      styleId: styleId.value,
      systemPrompt: systemPrompt.value,
      antiAiRules: selectedAntiAiRules.value,
      originalText: originalText.value,
      sourceFile: sourceFile.value,
      viewMode: resultViewMode.value
    })
  }

  function schedulePersistPageState() {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistPageStateNow()
    }, 400)
  }

  const styleNameById = computed(() => {
    const map = new Map<number, string>()
    for (const style of writingStyles.value) {
      map.set(style.id, style.name)
    }
    return map
  })

  function restoreFromSavedState() {
    const saved = loadLabPageState()
    if (!saved) return
    if (saved.styleId) styleId.value = saved.styleId
    if (saved.systemPrompt) systemPrompt.value = saved.systemPrompt
    if (saved.antiAiRules) selectedAntiAiRules.value = saved.antiAiRules
    if (saved.originalText) originalText.value = normalizeBodyParagraphSpacing(saved.originalText)
    if (saved.sourceFile) sourceFile.value = saved.sourceFile
    if (saved.viewMode) resultViewMode.value = saved.viewMode
  }

  async function refreshSystemPromptFromStyle(forStyleId?: number | null) {
    const id = forStyleId ?? styleId.value
    if (!id) {
      systemPrompt.value = ''
      return
    }
    try {
      systemPrompt.value = await window.anovel.invoke(
        'lab:buildSystemPrompt',
        id,
        plainStringList(selectedAntiAiRules.value)
      ) as string
    } catch (error) {
      console.error('[lab] buildSystemPrompt failed:', error)
      throw error
    }
  }

  function ensureStyleIdValid() {
    const rows = writingStyles.value
    if (!rows.length) {
      styleId.value = null
      return
    }
    if (styleId.value && rows.some(s => s.id === styleId.value)) return
    styleId.value = rows[0].id
  }

  async function loadWritingStyles() {
    const rows = await window.anovel.invoke('style:list') as LabWritingStyleOption[]
    writingStyles.value = rows
    ensureStyleIdValid()
    if (!suppressSystemPromptRefresh.value && !systemPrompt.value.trim() && styleId.value) {
      await refreshSystemPromptFromStyle(styleId.value)
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
    const prompt = systemPrompt.value.trim()
    if (!prompt) throw new Error('请填写 System Prompt')
    if (!styleId.value) throw new Error('请选择文风')
    const antiAiRules = plainStringList(selectedAntiAiRules.value)
    const created = await window.anovel.invoke('lab:taskCreate', {
      originalText: text,
      styleId: styleId.value,
      systemPrompt: prompt,
      sourceFile: sourceFile.value.trim() || undefined,
      antiAiRules: antiAiRules.length ? antiAiRules : undefined
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
    selectedAntiAiRules.value = parseAntiAiRulesFromTask(task)
    const rules = plainStringList(selectedAntiAiRules.value)
    systemPrompt.value = task.system_prompt?.trim()
      || await window.anovel.invoke(
        'lab:buildSystemPrompt',
        task.style_id,
        rules
      ) as string
    errorMessage.value = task.error_message ?? ''
    status.value = task.status === 'pending' ? 'idle' : task.status
    ensureStyleIdValid()
    persistPageStateNow()
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
    selectedAntiAiRules.value = []
    styleId.value = writingStyles.value[0]?.id ?? null
    void refreshSystemPromptFromStyle()
    status.value = 'idle'
    errorMessage.value = ''
    persistPageStateNow()
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

  watch(styleId, (nextId) => {
    if (suppressSystemPromptRefresh.value) return
    void refreshSystemPromptFromStyle(nextId)
  })

  watch(selectedAntiAiRules, () => {
    if (suppressSystemPromptRefresh.value || !styleId.value) return
    void refreshSystemPromptFromStyle(styleId.value)
  }, { deep: true })

  watch(
    [styleId, systemPrompt, selectedAntiAiRules, originalText, sourceFile, resultViewMode],
    () => schedulePersistPageState(),
    { deep: true }
  )

  useStyleChangeSync(loadWritingStyles)

  onMounted(async () => {
    restoreFromSavedState()
    window.anovel.on('lab:delta', deltaHandler)
    window.anovel.on('lab:run-end', endHandler)
    try {
      await loadWritingStyles()
      if (!systemPrompt.value.trim() && styleId.value) {
        await refreshSystemPromptFromStyle(styleId.value)
      }
    } finally {
      suppressSystemPromptRefresh.value = false
    }
    void refreshHistory()
  })

  onUnmounted(() => {
    window.anovel.off('lab:delta', deltaHandler)
    window.anovel.off('lab:run-end', endHandler)
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    persistPageStateNow()
  })

  return {
    originalText,
    resultText,
    styleId,
    systemPrompt,
    writingStyles,
    styleNameById,
    sourceFile,
    selectedAntiAiRules,
    resultViewMode,
    status,
    errorMessage,
    currentTaskId,
    historyList,
    loadingHistory,
    refreshHistory,
    refreshSystemPromptFromStyle,
    run,
    cancel,
    loadFromHistory,
    deleteHistory,
    reset
  }
}
