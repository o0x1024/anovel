<script setup lang="ts">
import { ref, computed, watch, onMounted, toRef } from 'vue'
import { useAssistantChat, type AssistantMessageView } from '../../composables/useAssistantChat'
import AssistantMessageList from '../assistant/AssistantMessageList.vue'
import AssistantMessageInput from '../assistant/AssistantMessageInput.vue'
import SettingPatchCard from './SettingPatchCard.vue'
import type { AssistantConversationRow, AssistantModelOption, AssistantWorkReference, SettingPatchResult } from '../../../../shared/assistant-types'
import { CORE_SETTING_DEPENDENCIES, CORE_SETTING_LABELS } from '../../../../shared/settings-types'
import {
  extractGoldenFingerFromAiContent,
  parseGoldenFingerFromMarkdown,
  renderGoldenFingerMarkdown,
  goldenFingerStructuredPromptSection,
  goldenFingerValidationIssues,
  mergeGoldenFinger,
  normalizeGoldenFinger,
  type GoldenFingerStructured
} from '../../../../shared/golden-finger-types'
import MarkdownContent from '../../components/MarkdownContent.vue'

interface SettingSlot {
  type: string
  label: string
}

const props = defineProps<{
  workId: number
  settingType: string
  settingLabel: string
  position?: 'bottom' | 'right'
  availableSlots?: SettingSlot[]
  initialConversationId?: number | null
}>()

const emit = defineEmits<{
  applySuggestion: [text: string]
  slotApplied: [slotType: string]
  conversationChange: [conversationId: number | null]
}>()

const isRight = computed(() => props.position === 'right')
const expanded = ref(!isRight.value)
const showConversationList = ref(true)
const conversations = ref<AssistantConversationRow[]>([])
const activeConversationId = ref<number | null>(null)
const loadingConversations = ref(false)
const modelOptions = ref<AssistantModelOption[]>([])
const messageListRef = ref<InstanceType<typeof AssistantMessageList> | null>(null)

const DEFAULT_PANEL_HEIGHT = 320
const MIN_PANEL_HEIGHT = 160
const MAX_PANEL_HEIGHT = 600
const panelHeight = ref(DEFAULT_PANEL_HEIGHT)
const isDragging = ref(false)
let dragStartY = 0
let dragStartHeight = DEFAULT_PANEL_HEIGHT

function startDrag(event: MouseEvent) {
  event.preventDefault()
  isDragging.value = true
  dragStartY = event.clientY
  dragStartHeight = panelHeight.value
  window.addEventListener('mousemove', onDrag)
  window.addEventListener('mouseup', stopDrag)
}

function onDrag(event: MouseEvent) {
  if (!isDragging.value) return
  const deltaY = dragStartY - event.clientY
  const nextHeight = Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, dragStartHeight + deltaY))
  panelHeight.value = nextHeight
}

function stopDrag() {
  isDragging.value = false
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', stopDrag)
}

const conversationIdRef = toRef(activeConversationId)
const {
  messages,
  send,
  cancel,
  sending,
  streamingMessageId,
  thinkingStreamingMessageId,
  error,
  loadMessages,
  editAndResend
} = useAssistantChat(conversationIdRef)

const attachedDocIds = ref<number[]>([])
const attachedDocs = ref<{ id: number; title: string }[]>([])
const attachedWorks = ref<AssistantWorkReference[]>([])
const conversationModelType = ref<string | null>(null)
const conversationModelName = ref<string | null>(null)

const contextRows = ref<{ type: string; label: string; content: string }[]>([])
const showDependencyContext = ref(false)

const dependencyRows = computed(() =>
  contextRows.value.filter(r => r.type !== props.settingType)
)
const targetContextRow = computed(() =>
  contextRows.value.find(r => r.type === props.settingType) ?? null
)

const applyPreviewOpen = ref(false)
const applyPreviewCurrent = ref('')
const applyPreviewProposed = ref('')
const applyPreviewStructured = ref<GoldenFingerStructured | null>(null)
const applyPreviewIssues = ref<string[]>([])
const applyPreviewSlot = ref<string | null>(null)

const applySuccessMessage = ref('')
const applyErrorMessage = ref('')
let applySuccessTimer: ReturnType<typeof setTimeout> | null = null
let applyErrorTimer: ReturnType<typeof setTimeout> | null = null

function showApplySuccess(message: string) {
  applySuccessMessage.value = message
  applyErrorMessage.value = ''
  if (applySuccessTimer) clearTimeout(applySuccessTimer)
  applySuccessTimer = setTimeout(() => {
    applySuccessMessage.value = ''
  }, 2500)
}

function showApplyError(message: string) {
  applyErrorMessage.value = message
  applySuccessMessage.value = ''
  if (applyErrorTimer) clearTimeout(applyErrorTimer)
  applyErrorTimer = setTimeout(() => {
    applyErrorMessage.value = ''
  }, 5000)
}

const activeTitle = computed(() => {
  const conv = conversations.value.find(c => c.id === activeConversationId.value)
  return conv?.title ?? '新对话'
})

const lastAssistantMessage = computed<AssistantMessageView | null>(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    if (messages.value[i].role === 'assistant') return messages.value[i]
  }
  return null
})

const lastExtractedGoldenFinger = computed<{ markdown: string; structured: GoldenFingerStructured } | null>(() => {
  if (props.settingType !== 'golden_finger') return null
  const text = lastAssistantMessage.value?.content
  if (!text?.trim()) return null
  const extracted = extractGoldenFingerFromAiContent(text.trim())
  if (!extracted) return null
  const hasContent = Object.values(extracted.structured).some(v => {
    if (typeof v === 'string') return v.trim().length > 0
    if (Array.isArray(v)) return v.some(item => Object.values(item).some(x => typeof x === 'string' && x.trim().length > 0))
    if (v && typeof v === 'object') return Object.values(v).some(x => typeof x === 'string' && x.trim().length > 0)
    return false
  })
  return hasContent ? extracted : null
})

function extractSettingPatch(content: string): SettingPatchResult | null {
  const match = /```json\s*([\s\S]*?)\s*```/.exec(content)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[1]) as unknown
    if (parsed && typeof parsed === 'object' && 'settingPatches' in parsed) {
      return parsed as SettingPatchResult
    }
  } catch {
    // ignore malformed json
  }
  return null
}

const lastSettingPatch = computed(() => {
  if (!lastAssistantMessage.value) return null
  return extractSettingPatch(lastAssistantMessage.value.content)
})

onMounted(async () => {
  modelOptions.value = await window.anovel.invoke('model:listAssistantOptions') as AssistantModelOption[]
})

watch([() => props.workId, () => props.settingType], async () => {
  activeConversationId.value = null
  await loadConversations()
  await loadDependencyContext()
}, { immediate: true })

async function loadDependencyContext() {
  if (!props.workId || props.settingType === 'overview') {
    contextRows.value = []
    return
  }
  try {
    const rows = await window.anovel.invoke('setting:listByWork', props.workId) as { type: string; content: string }[]
    const targetType = props.settingType
    const deps = new Set((CORE_SETTING_DEPENDENCIES as Record<string, string[]>)[targetType] ?? [])
    contextRows.value = rows
      .filter(r => (r.type === targetType || deps.has(r.type)) && r.content?.trim())
      .map(r => {
        const label = (CORE_SETTING_LABELS as Record<string, string>)[r.type] ?? r.type
        return { type: r.type, label, content: r.content.trim() }
      })
  } catch {
    contextRows.value = []
  }
}

watch(activeConversationId, async (id) => {
  emit('conversationChange', id)
  if (id) {
    const conv = conversations.value.find(c => c.id === id)
    conversationModelType.value = conv?.model_type ?? null
    conversationModelName.value = conv?.model_name ?? null
  } else {
    conversationModelType.value = null
    conversationModelName.value = null
  }
})

async function loadConversations() {
  loadingConversations.value = true
  try {
    conversations.value = await window.anovel.invoke(
      'assistant:convListByWorkSetting',
      props.workId,
      props.settingType
    ) as AssistantConversationRow[]
    if (props.initialConversationId && conversations.value.some(c => c.id === props.initialConversationId)) {
      activeConversationId.value = props.initialConversationId
    }
  } finally {
    loadingConversations.value = false
  }
}

async function createConversation() {
  const conv = await window.anovel.invoke('assistant:convCreate', {
    workId: props.workId,
    settingType: props.settingType,
    title: `${props.settingLabel}讨论`
  }) as AssistantConversationRow
  await loadConversations()
  activeConversationId.value = conv.id
  expanded.value = true
}

async function deleteConversation(id: number, event: Event) {
  event.stopPropagation()
  if (!confirm('删除此讨论？')) return
  await window.anovel.invoke('assistant:convDelete', id)
  if (activeConversationId.value === id) activeConversationId.value = null
  await loadConversations()
}

function selectConversation(id: number) {
  activeConversationId.value = id
  expanded.value = true
}

async function onSendMessage(text: string, documentIds: number[], workRefs: AssistantWorkReference[], kbNoteIds: number[] = []) {
  if (!activeConversationId.value) {
    await createConversation()
  }
  const docs = attachedDocs.value.filter(doc => documentIds.includes(doc.id))
  await send(text, documentIds, docs, workRefs, kbNoteIds)
}

function onDocAttached(doc: { id: number; title: string }) {
  if (!attachedDocs.value.some(d => d.id === doc.id)) {
    attachedDocs.value = [...attachedDocs.value, doc]
  }
}

function onDocsCleared() {
  attachedDocs.value = []
}

function onDocRemoved(id: number) {
  attachedDocs.value = attachedDocs.value.filter(d => d.id !== id)
}

function workRefKey(ref: AssistantWorkReference): string {
  return `${ref.workId}:${ref.chapterId ?? 'all'}`
}

function onWorkAttached(ref: AssistantWorkReference) {
  const plain: AssistantWorkReference = {
    workId: ref.workId,
    chapterId: ref.chapterId ?? null,
    title: ref.title
  }
  if (attachedWorks.value.some(w => workRefKey(w) === workRefKey(plain))) return
  attachedWorks.value = [...attachedWorks.value, plain]
}

function onWorkRemoved(key: string) {
  attachedWorks.value = attachedWorks.value.filter(w => workRefKey(w) !== key)
}

function onWorksCleared() {
  attachedWorks.value = []
}

async function onUpdateConversationModel() {
  if (!activeConversationId.value) return
  await window.anovel.invoke(
    'assistant:convUpdateModel',
    activeConversationId.value,
    conversationModelType.value,
    conversationModelName.value
  )
  await loadConversations()
}

function applyLastSuggestion() {
  const text = lastAssistantMessage.value?.content
  if (!text?.trim()) return
  emit('applySuggestion', text.trim())
}

function buildGoldenFingerPreview(text: string): { markdown: string; structured: GoldenFingerStructured } | null {
  const trimmed = text.trim()
  const extracted = extractGoldenFingerFromAiContent(trimmed)
  if (extracted) return extracted
  const parsed = parseGoldenFingerFromMarkdown(trimmed)
  if (!parsed) return null
  return { markdown: renderGoldenFingerMarkdown(parsed), structured: parsed }
}

async function loadCurrentGoldenFinger(): Promise<GoldenFingerStructured> {
  try {
    const raw = await window.anovel.invoke('setting:getStructured', props.workId, 'golden_finger') as Partial<GoldenFingerStructured> | null
    if (raw) return normalizeGoldenFinger(raw)
    const rows = await window.anovel.invoke('setting:listByWork', props.workId) as { type: string; content: string }[]
    const markdown = rows.find(r => r.type === 'golden_finger')?.content?.trim() ?? ''
    return markdown ? parseGoldenFingerFromMarkdown(markdown) : normalizeGoldenFinger({})
  } catch {
    return normalizeGoldenFinger({})
  }
}

async function openApplyPreview(slotType: string) {
  const text = lastAssistantMessage.value?.content
  if (!text?.trim()) {
    showApplyError('没有可应用的内容')
    return
  }
  if (slotType === 'golden_finger') {
    const preview = buildGoldenFingerPreview(text)
    if (!preview) {
      showApplyError('无法从 AI 回复中解析出金手指结构化数据，请让 AI 重新输出 JSON 格式')
      return
    }
    if (!preview.structured.nameAndForm.trim() && !preview.structured.abilities.some(a => a.name.trim())) {
      showApplyError('解析到的金手指数据全为空，可能 AI 使用了非标准字段名，请让 AI 使用英文字段名重新输出')
      return
    }
    try {
      const current = await loadCurrentGoldenFinger()
      const merged = mergeGoldenFinger(current, preview.structured)
      applyPreviewCurrent.value = renderGoldenFingerMarkdown(current)
      applyPreviewProposed.value = renderGoldenFingerMarkdown(merged)
      applyPreviewStructured.value = merged
      applyPreviewIssues.value = goldenFingerValidationIssues(merged)
      applyPreviewSlot.value = slotType
      applyPreviewOpen.value = true
    } catch (err) {
      showApplyError(`加载当前设定失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }
  await doApplyToSlot(slotType, text.trim())
}

async function confirmApplyPreview() {
  if (!applyPreviewSlot.value || !applyPreviewStructured.value) {
    showApplyError('预览数据缺失，请重新点击应用')
    return
  }
  await doApplyToSlot(
    applyPreviewSlot.value,
    applyPreviewProposed.value,
    applyPreviewStructured.value
  )
  applyPreviewOpen.value = false
}

async function doApplyToSlot(slotType: string, content: string, structured?: GoldenFingerStructured) {
  if (applyingSlot.value) return
  if (!content.trim() && !structured) {
    showApplyError('内容为空，无法应用')
    return
  }
  applyingSlot.value = slotType
  try {
    if (slotType === 'golden_finger' && structured) {
      await window.anovel.invoke(
        'setting:upsertStructured',
        props.workId,
        'golden_finger',
        content,
        structured
      )
    } else {
      await window.anovel.invoke('setting:upsert', props.workId, slotType, content)
    }
    showSlotPicker.value = false
    const label = (CORE_SETTING_LABELS as Record<string, string>)[slotType] ?? slotType
    showApplySuccess(`已应用到「${label}」设定`)
    emit('slotApplied', slotType)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    showApplyError(`应用失败：${msg}`)
  } finally {
    applyingSlot.value = null
  }
}

async function applyToSlot(slotType: string) {
  const text = lastAssistantMessage.value?.content
  if (!text?.trim()) return
  await openApplyPreview(slotType)
}

function sendQuickPrompt(prompt: string) {
  if (!prompt.trim()) return
  void onSendMessage(prompt, [], [])
}

const isOverview = computed(() => props.settingType === 'overview')
const showSlotPicker = ref(false)
const applyingSlot = ref<string | null>(null)
const slotPickerRef = ref<HTMLElement | null>(null)
const slotPickerPos = ref({ left: 0, top: 0 })

function updateSlotPickerPosition() {
  const el = slotPickerRef.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  slotPickerPos.value = {
    left: rect.left,
    top: rect.bottom + 4
  }
}

function openSlotPicker() {
  updateSlotPickerPosition()
  showSlotPicker.value = true
  window.addEventListener('click', closeSlotPickerOnOutside, { capture: true, once: true })
}

function closeSlotPickerOnOutside(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (slotPickerRef.value?.contains(target)) return
  showSlotPicker.value = false
}

const MISSING_FIELD_PROMPTS: Record<string, { label: string; prompt: string }> = {
  '缺少「名称与形态」': { label: '补名称形态', prompt: '请为当前金手指补全「名称与形态」：它叫什么、外在表现形式是什么、读者如何一眼记住。' },
  '缺少有效的「核心能力」': { label: '补核心能力', prompt: '请为当前金手指补全具体的核心能力：能力名、效果、作用范围，最多 1-3 个。' },
  '缺少「获取方式与觉醒条件」': { label: '补获取方式', prompt: '请补全主角如何获得这个金手指、第一次激活需要什么条件。' },
  '缺少「使用限制」（冷却/消耗/次数至少填一项）': { label: '补使用限制', prompt: '请为当前金手指设计具体的使用限制：冷却时间、消耗代价、次数上限或失效场景，至少一项。' },
  '缺少「反噬/代价机制」': { label: '补反噬机制', prompt: '请为当前金手指设计真实可信的反噬或代价机制，避免太无敌。' },
  '缺少「信息差优势」': { label: '补信息差', prompt: '请补全当前金手指带来的信息差优势：主角知道什么别人不知道？读者是否先知？' },
  '缺少「番茄一句话卖点」': { label: '补一句话卖点', prompt: '请为当前金手指提炼一个番茄风格的一句话卖点，让读者 3 秒看懂核心爽点。' },
  '缺少「前三章首次爽点场景」': { label: '补首次爽点', prompt: '请补全前三章首次爽点场景：触发事件、金手指如何发挥作用、读者爽感来源。' },
  '缺少「可视化限制指标-当前等级」': { label: '补可视化指标', prompt: '请补全金手指的可视化限制指标：当前等级/阶段、每次消耗、冷却、次数上限、进度条形态、越级后果。' }
}

const dynamicGoldenFingerPrompts = computed<{ label: string; prompt: string }[]>(() => {
  if (props.settingType !== 'golden_finger') return []
  const targetRow = targetContextRow.value
  const parsed = parseGoldenFingerFromMarkdown(targetRow?.content ?? '')
  const issues = goldenFingerValidationIssues(parsed)
  return issues.slice(0, 3).map(issue => MISSING_FIELD_PROMPTS[issue] ?? {
    label: '补齐缺项',
    prompt: `当前金手指存在以下缺失：${issue}，请补全并说明理由。`
  })
})

const quickPrompts = computed<{ label: string; prompt: string }[]>(() => {
  const base: { label: string; prompt: string }[] = []
  if (isOverview.value) {
    base.push(
      { label: '全局诊断', prompt: '请从整体角度诊断这套核心设定的主要问题，并指出哪些设定之间存在冲突或不一致。' },
      { label: '联动优化', prompt: '请分析主角、金手指、世界观压力、冲突引擎、爽点机制之间的联动是否足够紧密，给出优化建议。' },
      { label: '追读动力', prompt: '基于当前核心设定，分析读者追读动力来源是否足够强，如何增强。' },
      { label: '补齐短板', prompt: '请指出当前核心设定中哪一部分最薄弱，并给出具体补齐方案。' }
    )
  } else if (props.settingType === 'golden_finger') {
    base.push(
      { label: '诊断问题', prompt: '请诊断当前金手指设定的主要问题，并给出修改建议。' },
      { label: '整理为结构化', prompt: `结合历史消息和结论把建议和方案整合到一起并整理为金手指结构化数据。只输出一个 JSON 代码块（标记为 json），不要输出任何其他说明、分析或 Markdown 正文，字段要求如下：\n${goldenFingerStructuredPromptSection()}` },
      { label: '优化表达', prompt: '请帮我优化这段金手指设定的表达，使其更具体、更有张力。' },
      { label: '增加限制', prompt: '请为当前金手指设计更严格的限制条件或反噬机制，避免太无敌。' },
      { label: '检查自洽', prompt: '请检查当前金手指与主角、世界观、冲突等已有设定是否存在冲突或不自洽之处。' }
    )
  } else {
    base.push(
      { label: '诊断问题', prompt: '请诊断当前设定中的主要问题，并给出修改建议。' },
      { label: '优化表达', prompt: '请帮我优化这段设定的表达，使其更具体、更有张力。' },
      { label: '增加限制', prompt: '请为当前设定设计更严格的限制条件或反噬机制，避免太无敌。' },
      { label: '检查自洽', prompt: '请检查当前设定与已有依赖设定是否存在冲突或不自洽之处。' }
    )
  }
  const dynamic = dynamicGoldenFingerPrompts.value
  if (dynamic.length) {
    return [...dynamic, ...base]
  }
  return base
})
</script>

<template>
  <div class="border-t border-base-300 bg-base-100" :class="isRight ? 'h-full flex flex-col' : ''">
    <button
      v-if="!isRight"
      type="button"
      class="w-full flex items-center justify-between gap-2 px-6 py-2 text-sm hover:bg-base-200/50 transition-colors"
      @click="expanded = !expanded"
    >
      <div class="flex items-center gap-2">
        <font-awesome-icon icon="robot" class="w-3.5 h-3.5 text-primary" />
        <span class="font-medium">AI 设定顾问</span>
        <span class="text-xs text-base-content/50">{{ settingLabel }}</span>
        <span v-if="activeConversationId" class="text-xs text-base-content/40 truncate max-w-[200px]">
          · {{ activeTitle }}
        </span>
      </div>
      <font-awesome-icon
        :icon="expanded ? 'chevron-down' : 'chevron-up'"
        class="w-3 h-3 text-base-content/40"
      />
    </button>

    <div
      v-show="expanded || isRight"
      class="border-t border-base-300 flex flex-col relative"
      :class="isRight ? 'h-full' : ''"
      :style="isRight ? undefined : { height: `${panelHeight}px` }"
    >
      <div
        v-if="!isRight"
        class="absolute -top-2 left-0 right-0 h-4 flex items-center justify-center cursor-ns-resize z-10"
        title="拖动调整高度"
        @mousedown="startDrag"
      >
        <div
          class="w-12 h-1 rounded-full transition-colors"
          :class="isDragging ? 'bg-primary' : 'bg-base-300 hover:bg-primary/50'"
        />
      </div>

      <div class="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-base-300 shrink-0">
        <div class="flex items-center gap-2 min-w-0">
          <font-awesome-icon icon="robot" class="w-3 h-3 text-primary shrink-0" />
          <span class="text-xs font-medium">AI 设定顾问</span>
          <span class="text-xs text-base-content/50 truncate">{{ settingLabel }}</span>
          <span v-if="activeConversationId && !showConversationList" class="text-xs text-base-content/40 truncate max-w-[120px]">
            · {{ activeTitle }}
          </span>
        </div>
        <button
          type="button"
          class="btn btn-ghost btn-xs btn-square w-6 h-6 min-h-0 p-0"
          :title="showConversationList ? '隐藏对话列表' : '显示对话列表'"
          @click="showConversationList = !showConversationList"
        >
          <font-awesome-icon :icon="showConversationList ? 'chevron-left' : 'chevron-right'" class="w-3 h-3" />
        </button>
      </div>

      <div class="flex flex-1 min-h-0">
        <aside
          v-if="showConversationList"
          class="w-52 border-r border-base-300 shrink-0 flex flex-col min-h-0 bg-base-200/30"
        >
          <div class="p-2 border-b border-base-300 shrink-0">
            <button
              type="button"
              class="btn btn-primary btn-xs btn-block gap-1"
              :disabled="loadingConversations"
              @click="createConversation"
            >
              <font-awesome-icon icon="plus" class="w-3 h-3" />
              新讨论
            </button>
          </div>

          <div v-if="loadingConversations" class="p-3 text-center">
            <span class="loading loading-spinner loading-xs" />
          </div>
          <div v-else class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden py-1.5 px-1.5 space-y-0.5">
            <p v-if="conversations.length === 0" class="text-xs text-center text-base-content/40 py-3">
              暂无讨论
            </p>
            <div
              v-for="conv in conversations"
              :key="conv.id"
              :class="{ 'bg-primary/10 text-primary': activeConversationId === conv.id }"
              class="flex items-center min-w-0 w-full cursor-pointer rounded group px-2 py-1.5 hover:bg-base-200 transition-colors"
              @click="selectConversation(conv.id)"
            >
              <span class="flex-1 min-w-0 truncate text-left text-xs">{{ conv.title }}</span>
              <button
                type="button"
                class="btn btn-ghost btn-xs btn-square shrink-0 w-5 h-5 min-h-0 p-0 opacity-0 group-hover:opacity-100"
                title="删除"
                @click.stop="deleteConversation(conv.id, $event)"
              >
                <font-awesome-icon icon="trash" class="w-2.5 h-2.5" />
              </button>
            </div>
          </div>
        </aside>

        <button
          v-else
          type="button"
          class="w-8 shrink-0 border-r border-base-300 bg-base-200/30 hover:bg-base-200 flex flex-col items-center justify-start pt-3 text-base-content/50 hover:text-primary transition-colors"
          title="展开对话列表"
          @click="showConversationList = true"
        >
          <font-awesome-icon icon="comments" class="w-3.5 h-3.5 mb-2" />
          <span class="text-[10px]" style="writing-mode: vertical-rl;">对话</span>
        </button>

        <div class="flex-1 min-h-0 flex flex-col">
          <div v-if="!activeConversationId" class="flex-1 flex flex-col items-center justify-center text-sm text-base-content/40 p-6">
            <font-awesome-icon icon="comments" class="w-8 h-8 mb-3 opacity-30" />
            <p>选择一个讨论开始，或新建一个讨论</p>
            <p class="text-xs mt-1">AI 会自动带入当前设定内容与依赖设定</p>
          </div>

          <template v-else>
            <div
              v-if="!isOverview && dependencyRows.length"
              class="shrink-0 px-3 py-1.5 border-b border-base-300 bg-base-200/20"
            >
              <button
                type="button"
                class="flex items-center gap-1.5 text-xs text-base-content/60 hover:text-primary"
                @click="showDependencyContext = !showDependencyContext"
              >
                <font-awesome-icon :icon="showDependencyContext ? 'chevron-down' : 'chevron-right'" class="w-3 h-3" />
                已带入 {{ dependencyRows.length }} 项依赖设定
                <span class="text-[10px] text-base-content/40">（点击展开）</span>
              </button>
              <div v-show="showDependencyContext" class="mt-1.5 space-y-1.5 max-h-40 overflow-y-auto pr-1">
                <div
                  v-for="row in dependencyRows"
                  :key="row.type"
                  class="rounded bg-base-100 border border-base-300/60 p-1.5 text-xs"
                >
                  <p class="font-medium text-base-content/70 mb-0.5">{{ row.label }}</p>
                  <p class="text-base-content/50 line-clamp-3">{{ row.content }}</p>
                </div>
              </div>
            </div>

            <div
              v-if="applySuccessMessage"
              class="shrink-0 px-3 py-1.5 border-b border-base-300 bg-success/10 text-success text-xs flex items-center gap-1.5"
            >
              <font-awesome-icon icon="check-circle" class="w-3 h-3" />
              {{ applySuccessMessage }}
            </div>

            <div
              v-if="applyErrorMessage"
              class="shrink-0 px-3 py-1.5 border-b border-base-300 bg-error/10 text-error text-xs flex items-center gap-1.5"
            >
              <font-awesome-icon icon="exclamation-circle" class="w-3 h-3" />
              {{ applyErrorMessage }}
            </div>

            <div
              v-if="lastExtractedGoldenFinger"
              class="shrink-0 px-3 py-2 border-b border-base-300 bg-primary/5"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 text-xs text-primary">
                  <font-awesome-icon icon="braces" class="w-3 h-3" />
                  <span class="font-medium">检测到可应用的结构化金手指数据</span>
                </div>
                <button
                  type="button"
                  class="btn btn-primary btn-xs text-xs"
                  :disabled="applyingSlot !== null"
                  @click="openApplyPreview('golden_finger')"
                >
                  <span v-if="applyingSlot === 'golden_finger'" class="loading loading-spinner loading-xs mr-1" />
                  应用
                </button>
              </div>
              <p class="text-[10px] text-base-content/50 mt-1">
                已识别字段：{{ Object.entries(lastExtractedGoldenFinger.structured)
                  .filter(([k, v]) => {
                    if (typeof v === 'string') return v.trim().length > 0
                    if (Array.isArray(v)) return v.length > 0
                    return false
                  })
                  .map(([k]) => ({ nameAndForm: '名称形态', abilities: '核心能力', acquisition: '获取方式', limit: '限制条件', backlash: '反噬机制', upgrades: '升级路径', infoAdvantage: '信息差', sideEffects: '副作用', forbiddenScenes: '禁用场景', tagline: '一句话卖点', firstPayoffScene: '首次爽点', visualMetric: '可视化指标' }[k] ?? k))
                  .join('、') }}
              </p>
            </div>

            <div class="shrink-0 px-3 py-1.5 border-b border-base-300 flex items-center gap-2 flex-wrap">
              <span class="text-xs text-base-content/50">快捷提问：</span>
              <button
                v-for="item in quickPrompts"
                :key="item.label"
                type="button"
                class="btn btn-ghost btn-xs text-xs"
                :class="dynamicGoldenFingerPrompts.some(d => d.label === item.label) ? 'text-primary' : ''"
                :disabled="sending || !item.prompt.trim()"
                @click="sendQuickPrompt(item.prompt)"
              >
                {{ item.label }}
              </button>
              <button
                v-if="lastAssistantMessage && !isOverview && settingType !== 'golden_finger'"
                type="button"
                class="btn btn-primary btn-xs text-xs ml-auto"
                @click="applyLastSuggestion"
              >
                采纳最后回复
              </button>
              <button
                v-if="lastAssistantMessage && !isOverview && settingType === 'golden_finger'"
                type="button"
                class="btn btn-primary btn-xs text-xs ml-auto"
                :disabled="applyingSlot !== null"
                @click="openApplyPreview('golden_finger')"
              >
                <span v-if="applyingSlot === 'golden_finger'" class="loading loading-spinner loading-xs mr-1" />
                应用修订
              </button>
              <div v-if="lastAssistantMessage && isOverview && availableSlots?.length" ref="slotPickerRef" class="relative ml-auto">
                <button
                  type="button"
                  class="btn btn-primary btn-xs text-xs"
                  :disabled="applyingSlot !== null"
                  @click="showSlotPicker ? (showSlotPicker = false) : openSlotPicker()"
                >
                  <span v-if="applyingSlot" class="loading loading-spinner loading-xs mr-1" />
                  应用到槽位
                </button>
              </div>
            </div>

            <AssistantMessageList
              ref="messageListRef"
              class="flex-1 min-h-0"
              :messages="messages"
              :sending="sending"
              :streaming-message-id="streamingMessageId"
              :thinking-streaming-message-id="thinkingStreamingMessageId"
              :error="error"
              @edit-resend="editAndResend"
            />

            <SettingPatchCard
              v-if="lastSettingPatch"
              :patch-result="lastSettingPatch"
              :work-id="workId"
              class="shrink-0 border-t border-base-300"
              @applied="$emit('slotApplied', $event)"
            />

            <AssistantMessageInput
              :sending="sending"
              :attached-docs="attachedDocs"
              :attached-works="attachedWorks"
              :model-options="modelOptions"
              v-model:model-type="conversationModelType"
              v-model:model-name="conversationModelName"
              v-model:attached-doc-ids="attachedDocIds"
              @send="onSendMessage"
              @cancel="cancel"
              @docs-cleared="onDocsCleared"
              @works-cleared="onWorksCleared"
              @doc-attached="onDocAttached"
              @doc-removed="onDocRemoved"
              @work-attached="onWorkAttached"
              @work-removed="onWorkRemoved"
              @update:model-type="onUpdateConversationModel"
              @update:model-name="onUpdateConversationModel"
            />
          </template>
        </div>
      </div>
    </div>
  </div>

  <teleport to="body">
    <div
      v-if="showSlotPicker"
      class="fixed z-[200] bg-base-100 border border-base-300 rounded-lg shadow-xl p-2 min-w-[160px]"
      :style="{ left: `${slotPickerPos.left}px`, top: `${slotPickerPos.top}px` }"
      @click.stop
    >
      <p class="text-xs text-base-content/50 px-2 py-1">选择目标设定槽位</p>
      <button
        v-for="slot in availableSlots"
        :key="slot.type"
        type="button"
        class="btn btn-ghost btn-xs w-full justify-start text-xs"
        :disabled="applyingSlot === slot.type"
        @click="applyToSlot(slot.type)"
      >
        {{ slot.label }}
      </button>
    </div>
  </teleport>

  <teleport to="body">
    <div
      v-if="applyPreviewOpen"
      class="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
      @click.self="applyPreviewOpen = false"
    >
      <div class="modal-box max-w-5xl w-full max-h-[90vh] flex flex-col p-0">
        <div class="flex items-center justify-between gap-4 px-5 py-3 border-b border-base-300 shrink-0">
          <h3 class="font-bold text-base">应用修订 · {{ settingLabel }}</h3>
          <button type="button" class="btn btn-ghost btn-xs btn-square" @click="applyPreviewOpen = false">
            <font-awesome-icon icon="times" class="w-3 h-3" />
          </button>
        </div>

        <div class="px-5 py-3 border-b border-base-300 shrink-0">
          <div v-if="applyPreviewIssues.length" class="alert alert-warning text-xs py-2">
            <p class="font-medium mb-1">应用后仍存在以下必填项缺失，建议先让 AI 补齐：</p>
            <ul class="list-disc list-inside space-y-0.5">
              <li v-for="(issue, i) in applyPreviewIssues" :key="i">{{ issue }}</li>
            </ul>
          </div>
          <div v-else class="alert alert-success text-xs py-2">
            所有必填项已识别，可直接应用。
          </div>
        </div>

        <div class="flex-1 min-h-0 grid grid-cols-2 divide-x divide-base-300 overflow-hidden">
          <div class="flex flex-col min-h-0">
            <p class="text-xs font-medium text-base-content/50 px-4 py-2 border-b border-base-300 bg-base-200/30">当前设定</p>
            <div class="flex-1 min-h-0 overflow-auto p-4">
              <MarkdownContent v-if="applyPreviewCurrent.trim()" :content="applyPreviewCurrent" size="sm" />
              <p v-else class="text-sm text-base-content/40 italic">当前无内容</p>
            </div>
          </div>
          <div class="flex flex-col min-h-0">
            <p class="text-xs font-medium text-primary px-4 py-2 border-b border-base-300 bg-primary/5">应用后</p>
            <div class="flex-1 min-h-0 overflow-auto p-4">
              <MarkdownContent :content="applyPreviewProposed" size="sm" />
            </div>
          </div>
        </div>

        <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-base-300 shrink-0">
          <button type="button" class="btn btn-ghost btn-sm" @click="applyPreviewOpen = false">取消</button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="applyingSlot !== null"
            @click="confirmApplyPreview"
          >
            <span v-if="applyingSlot === applyPreviewSlot" class="loading loading-spinner loading-xs mr-1" />
            确认应用
          </button>
        </div>
      </div>
    </div>
  </teleport>
</template>
