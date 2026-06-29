<script setup lang="ts">
import { ref, computed, watch, onMounted, toRef } from 'vue'
import { useAssistantChat, type AssistantMessageView } from '../../composables/useAssistantChat'
import AssistantMessageList from '../assistant/AssistantMessageList.vue'
import AssistantMessageInput from '../assistant/AssistantMessageInput.vue'
import SettingPatchCard from './SettingPatchCard.vue'
import type { AssistantConversationRow, AssistantModelOption, AssistantWorkReference, SettingPatchResult } from '../../../../shared/assistant-types'

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
}, { immediate: true })

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

async function applyToSlot(slotType: string) {
  const text = lastAssistantMessage.value?.content
  if (!text?.trim() || applyingSlot.value) return
  applyingSlot.value = slotType
  try {
    await window.anovel.invoke('setting:upsert', props.workId, slotType, text.trim())
    showSlotPicker.value = false
    emit('slotApplied', slotType)
  } finally {
    applyingSlot.value = null
  }
}

function sendQuickPrompt(prompt: string) {
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

const quickPrompts = computed<{ label: string; prompt: string }[]>(() => {
  if (isOverview.value) {
    return [
      { label: '全局诊断', prompt: '请从整体角度诊断这套核心设定的主要问题，并指出哪些设定之间存在冲突或不一致。' },
      { label: '联动优化', prompt: '请分析主角、金手指、世界观压力、冲突引擎、爽点机制之间的联动是否足够紧密，给出优化建议。' },
      { label: '追读动力', prompt: '基于当前核心设定，分析读者追读动力来源是否足够强，如何增强。' },
      { label: '补齐短板', prompt: '请指出当前核心设定中哪一部分最薄弱，并给出具体补齐方案。' }
    ]
  }
  return [
    { label: '诊断问题', prompt: '请诊断当前设定中的主要问题，并给出修改建议。' },
    { label: '优化表达', prompt: '请帮我优化这段设定的表达，使其更具体、更有张力。' },
    { label: '增加限制', prompt: '请为当前设定设计更严格的限制条件或反噬机制，避免太无敌。' },
    { label: '检查自洽', prompt: '请检查当前设定与已有依赖设定是否存在冲突或不自洽之处。' }
  ]
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
          <ul v-else class="menu menu-xs flex-1 overflow-y-auto p-1.5 gap-0.5">
            <li v-if="conversations.length === 0" class="text-xs text-center text-base-content/40 py-3">
              暂无讨论
            </li>
            <li v-for="conv in conversations" :key="conv.id">
              <div
                :class="{ 'menu-active': activeConversationId === conv.id }"
                class="flex items-center min-w-0 w-full cursor-pointer group"
                @click="selectConversation(conv.id)"
              >
                <div class="flex-1 min-w-0 truncate text-left px-2 py-1">
                  {{ conv.title }}
                </div>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs btn-square shrink-0 w-5 h-5 min-h-0 p-0 opacity-0 group-hover:opacity-100"
                  title="删除"
                  @click.stop="deleteConversation(conv.id, $event)"
                >
                  <font-awesome-icon icon="trash" class="w-2.5 h-2.5" />
                </button>
              </div>
            </li>
          </ul>
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
            <div class="shrink-0 px-3 py-1.5 border-b border-base-300 flex items-center gap-2 flex-wrap">
              <span class="text-xs text-base-content/50">快捷提问：</span>
              <button
                v-for="item in quickPrompts"
                :key="item.label"
                type="button"
                class="btn btn-ghost btn-xs text-xs"
                :disabled="sending"
                @click="sendQuickPrompt(item.prompt)"
              >
                {{ item.label }}
              </button>
              <button
                v-if="lastAssistantMessage && !isOverview"
                type="button"
                class="btn btn-primary btn-xs text-xs ml-auto"
                @click="applyLastSuggestion"
              >
                采纳最后回复
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
</template>
