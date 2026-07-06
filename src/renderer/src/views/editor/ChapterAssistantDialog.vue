<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import { useAssistantChat } from '../../composables/useAssistantChat'
import { useStickToBottomScroll } from '../../composables/useStickToBottomScroll'
import { CORE_SETTING_LABELS, STORY_SETTING_LABELS } from '../../../../shared/settings-types'
import type { AssistantWorkReference } from '../../../../shared/assistant-types'

const props = defineProps<{
  open: boolean
  workId: number
  chapterId: number | null
  chapterTitle: string
  chapterContent: string
  workType: string | null
}>()

const emit = defineEmits<{ 'update:open': [value: boolean] }>()

interface CoreSettingRow { type: string; content: string }
interface ChapterRow { id: number; title: string; content: string | null; word_count: number }

const conversationId = ref<number | null>(null)
const {
  messages, sending, streamingMessageId, thinkingStreamingMessageId, error, send, cancel, clearMessages
} = useAssistantChat(conversationId)

const inputText = ref('')
const scrollRef = ref<HTMLElement | null>(null)
const showContextPanel = ref(true)
const minimized = ref(false)

// ---- drag state ----
const panelRef = ref<HTMLElement | null>(null)
const panelX = ref(window.innerWidth - 520)
const panelY = ref(80)
const dragging = ref(false)
let dragOffsetX = 0
let dragOffsetY = 0

const PANEL_H = 560
const MINI_W = 260
const HEADER_H = 44
const MIN_W = 320
const MAX_W = 900

// ---- resize state ----
const panelW = ref(500)
const resizing = ref(false)
const resizeEdge = ref<'left' | 'right'>('right')
let resizeStartX = 0
let resizeStartW = 0
let resizeStartPanelX = 0

function onDragStart(e: PointerEvent) {
  if (minimized.value) {
    dragging.value = true
    dragOffsetX = e.clientX - panelX.value
    dragOffsetY = e.clientY - panelY.value
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    return
  }
  const target = e.target as HTMLElement
  if (target.closest('button') || target.closest('textarea') || target.closest('input')) return
  dragging.value = true
  dragOffsetX = e.clientX - panelX.value
  dragOffsetY = e.clientY - panelY.value
  target.setPointerCapture(e.pointerId)
}

function onDragMove(e: PointerEvent) {
  if (!dragging.value) return
  const w = minimized.value ? MINI_W : panelW.value
  const h = minimized.value ? HEADER_H : PANEL_H
  let x = e.clientX - dragOffsetX
  let y = e.clientY - dragOffsetY
  x = Math.max(0, Math.min(x, window.innerWidth - w))
  y = Math.max(0, Math.min(y, window.innerHeight - h))
  panelX.value = x
  panelY.value = y
}

function onDragEnd(e: PointerEvent) {
  if (!dragging.value) return
  dragging.value = false
  ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
}

function onResizeStart(e: PointerEvent, edge: 'left' | 'right') {
  if (minimized.value) return
  e.preventDefault()
  e.stopPropagation()
  resizing.value = true
  resizeEdge.value = edge
  resizeStartX = e.clientX
  resizeStartW = panelW.value
  resizeStartPanelX = panelX.value
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onResizeMove(e: PointerEvent) {
  if (!resizing.value) return
  const delta = e.clientX - resizeStartX
  if (resizeEdge.value === 'right') {
    const w = Math.max(MIN_W, Math.min(resizeStartW + delta, window.innerWidth - panelX.value - 8))
    panelW.value = Math.min(w, MAX_W)
  } else {
    const newW = Math.max(MIN_W, Math.min(resizeStartW - delta, MAX_W))
    const newX = resizeStartPanelX + (resizeStartW - newW)
    if (newX >= 0) {
      panelW.value = newW
      panelX.value = newX
    } else {
      panelW.value = resizeStartW + resizeStartPanelX
      panelX.value = 0
    }
  }
}

function onResizeEnd(e: PointerEvent) {
  if (!resizing.value) return
  resizing.value = false
  ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
}

function clampPosition() {
  const w = minimized.value ? MINI_W : panelW.value
  const h = minimized.value ? HEADER_H : PANEL_H
  panelX.value = Math.max(0, Math.min(panelX.value, window.innerWidth - w))
  panelY.value = Math.max(0, Math.min(panelY.value, window.innerHeight - h))
}

function parseThinking(metadataJson: string | null): string {
  if (!metadataJson) return ''
  try {
    const meta = JSON.parse(metadataJson) as Record<string, unknown>
    return typeof meta.thinking === 'string' ? meta.thinking : ''
  } catch {
    return ''
  }
}

const coreSettings = ref<CoreSettingRow[]>([])
const allChapters = ref<ChapterRow[]>([])
const selectedSettingTypes = ref<Set<string>>(new Set())
const selectedChapterIds = ref<Set<number>>(new Set())

const isStory = computed(() => props.workType === 'story')

function settingLabel(type: string): string {
  const labels = isStory.value ? STORY_SETTING_LABELS : CORE_SETTING_LABELS
  return (labels as Record<string, string>)[type] ?? type
}

const availableSettings = computed(() =>
  coreSettings.value.filter(s => s.content?.trim())
)

const previousChapters = computed(() => {
  if (!props.chapterId) return []
  const idx = allChapters.value.findIndex(c => c.id === props.chapterId)
  if (idx === -1) return []
  return allChapters.value.slice(0, idx).filter(c => c.content?.trim())
})

const currentChapterRef = computed<AssistantWorkReference | null>(() => {
  if (!props.chapterId) return null
  return {
    workId: props.workId,
    chapterId: props.chapterId,
    title: `当前章节：${props.chapterTitle}`
  }
})

const additionalWorkRefs = computed<AssistantWorkReference[]>(() => {
  const refs: AssistantWorkReference[] = []
  for (const ch of allChapters.value) {
    if (selectedChapterIds.value.has(ch.id) && ch.id !== props.chapterId) {
      refs.push({
        workId: props.workId,
        chapterId: ch.id,
        title: `前文：${ch.title}`
      })
    }
  }
  return refs
})

const lastMessageSnapshot = computed(() => {
  const last = messages.value.at(-1)
  if (!last) return ''
  return `${last.content}\0${last.metadata_json ?? ''}`
})

const { stickToBottom, onScroll, jumpToBottom, resetStickToBottom } = useStickToBottomScroll(
  scrollRef,
  () => [messages.value.length, lastMessageSnapshot.value, streamingMessageId.value, thinkingStreamingMessageId.value, sending.value]
)

const hasContext = computed(() =>
  availableSettings.value.length > 0 || previousChapters.value.length > 0
)

const unreadCount = computed(() => {
  if (!minimized.value) return 0
  const last = messages.value.at(-1)
  if (!last || last.role !== 'assistant') return 0
  return 1
})

async function ensureConversation() {
  if (conversationId.value) return
  const conv = await window.anovel.invoke('assistant:convCreate', {
    workId: props.workId,
    settingType: 'chapter_discuss',
    title: `章节讨论：${props.chapterTitle}`
  }) as { id: number } | null
  if (conv) {
    conversationId.value = conv.id
    await nextTick()
    resetStickToBottom()
  }
}

async function loadData() {
  const [settings, chapters] = await Promise.all([
    window.anovel.invoke('setting:listByWork', props.workId) as Promise<CoreSettingRow[]>,
    window.anovel.invoke('chapter:listByWork', props.workId) as Promise<ChapterRow[]>
  ])
  coreSettings.value = settings ?? []
  allChapters.value = chapters ?? []
}

function toggleSetting(type: string) {
  const next = new Set(selectedSettingTypes.value)
  if (next.has(type)) next.delete(type)
  else next.add(type)
  selectedSettingTypes.value = next
}

function toggleChapter(id: number) {
  const next = new Set(selectedChapterIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedChapterIds.value = next
}

function buildSettingsPrefix(): string {
  if (selectedSettingTypes.value.size === 0) return ''
  const parts: string[] = []
  for (const s of coreSettings.value) {
    if (selectedSettingTypes.value.has(s.type) && s.content?.trim()) {
      parts.push(`【${settingLabel(s.type)}】\n${s.content.trim()}`)
    }
  }
  return parts.length ? `以下是本次讨论引入的核心设定：\n\n${parts.join('\n\n')}\n\n---\n\n` : ''
}

async function handleSend() {
  const text = inputText.value.trim()
  if (!text || sending.value) return
  await ensureConversation()
  if (!conversationId.value) return

  const fullText = buildSettingsPrefix() + text
  const workRefs: AssistantWorkReference[] = []
  if (currentChapterRef.value) workRefs.push(currentChapterRef.value)
  workRefs.push(...additionalWorkRefs.value)

  inputText.value = ''
  await send(fullText, [], [], workRefs, [])
  await nextTick()
  jumpToBottom()
}

function handleCancel() {
  void cancel()
}

async function handleClearHistory() {
  if (!conversationId.value || sending.value) return
  if (!confirm('确定清除当前对话的全部历史消息？')) return
  await clearMessages()
}

function closePanel() {
  emit('update:open', false)
}

function toggleMinimize() {
  minimized.value = !minimized.value
  if (!minimized.value) {
    clampPosition()
    nextTick(() => jumpToBottom())
  }
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void handleSend()
  }
}

function onWindowResize() {
  clampPosition()
}

watch(() => props.open, async (open) => {
  if (open) {
    panelW.value = 500
    panelX.value = window.innerWidth - panelW.value - 24
    panelY.value = 80
    await loadData()
    await ensureConversation()
  }
})

watch(() => props.chapterId, () => {
  if (props.open) {
    conversationId.value = null
    selectedSettingTypes.value.clear()
    selectedChapterIds.value.clear()
    void ensureConversation()
  }
})

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  if (props.open) {
    panelW.value = 500
    panelX.value = window.innerWidth - panelW.value - 24
    panelY.value = 80
    void loadData()
    void ensureConversation()
  }
})

onUnmounted(() => {
  window.removeEventListener('resize', onWindowResize)
  conversationId.value = null
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panelRef"
      class="fixed z-[80] flex flex-col bg-base-100 border border-base-300 rounded-xl shadow-2xl overflow-hidden"
      :style="{
        left: panelX + 'px',
        top: panelY + 'px',
        width: (minimized ? MINI_W : panelW) + 'px',
        height: minimized ? 'auto' : PANEL_H + 'px',
        maxHeight: minimized ? 'none' : 'calc(100vh - 24px)',
      }"
    >
      <!-- Left resize handle -->
      <div
        v-if="!minimized"
        class="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-primary/20 transition-colors z-10"
        @pointerdown="(e) => onResizeStart(e, 'left')"
        @pointermove="onResizeMove"
        @pointerup="onResizeEnd"
        @pointercancel="onResizeEnd"
      />
      <!-- Right resize handle -->
      <div
        v-if="!minimized"
        class="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-primary/20 transition-colors z-10"
        @pointerdown="(e) => onResizeStart(e, 'right')"
        @pointermove="onResizeMove"
        @pointerup="onResizeEnd"
        @pointercancel="onResizeEnd"
      />
      <!-- Header (drag handle) -->
      <div
        class="flex items-center justify-between px-3 h-11 border-b border-base-300 shrink-0 cursor-move select-none"
        :class="minimized ? 'rounded-xl' : ''"
        @pointerdown="onDragStart"
        @pointermove="onDragMove"
        @pointerup="onDragEnd"
        @pointercancel="onDragEnd"
      >
        <div class="flex items-center gap-2 min-w-0">
          <font-awesome-icon icon="comments" class="w-3.5 h-3.5 text-primary shrink-0" />
          <span class="font-bold text-xs truncate">
            {{ minimized ? '讨论助手' : '章节讨论 · ' + chapterTitle }}
          </span>
          <span
            v-if="unreadCount"
            class="badge badge-primary badge-xs"
          >新回复</span>
        </div>
        <div class="flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square h-7 w-7 min-h-0"
            :title="minimized ? '展开' : '最小化'"
            @click.stop="toggleMinimize"
          >
            <font-awesome-icon :icon="minimized ? 'window-restore' : 'window-minimize'" class="w-3 h-3" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square h-7 w-7 min-h-0"
            title="关闭"
            @click.stop="closePanel"
          >
            <font-awesome-icon icon="times" class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <!-- Body (hidden when minimized) -->
      <template v-if="!minimized">
        <div class="flex-1 flex min-h-0">
          <!-- Context Panel -->
          <aside
            v-if="showContextPanel && hasContext"
            class="w-44 border-r border-base-300 shrink-0 overflow-y-auto p-2 space-y-2 bg-base-200/30"
          >
            <div class="rounded-lg border border-primary/30 bg-primary/5 p-1.5">
              <p class="text-[11px] font-medium text-primary flex items-center gap-1">
                <font-awesome-icon icon="file-lines" class="w-2.5 h-2.5" />
                当前章节
              </p>
              <p class="text-[11px] text-base-content/60 mt-0.5 truncate">{{ chapterTitle }}</p>
              <p class="text-[10px] text-base-content/40">
                {{ chapterContent ? chapterContent.length + ' 字' : '暂无正文' }}
              </p>
            </div>

            <div v-if="availableSettings.length">
              <p class="text-[11px] font-semibold text-base-content/50 mb-1">引入设定</p>
              <div class="space-y-0.5">
                <button
                  v-for="s in availableSettings"
                  :key="s.type"
                  type="button"
                  class="w-full text-left rounded px-1.5 py-1 text-[11px] transition-colors"
                  :class="selectedSettingTypes.has(s.type)
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-base-100/80 text-base-content/70'"
                  @click="toggleSetting(s.type)"
                >
                  <font-awesome-icon
                    :icon="selectedSettingTypes.has(s.type) ? 'check-square' : 'square'"
                    class="w-2.5 h-2.5 mr-1"
                  />
                  {{ settingLabel(s.type) }}
                </button>
              </div>
            </div>

            <div v-if="previousChapters.length">
              <p class="text-[11px] font-semibold text-base-content/50 mb-1">引入前文</p>
              <div class="space-y-0.5 max-h-32 overflow-y-auto">
                <button
                  v-for="ch in previousChapters"
                  :key="ch.id"
                  type="button"
                  class="w-full text-left rounded px-1.5 py-1 text-[11px] transition-colors"
                  :class="selectedChapterIds.has(ch.id)
                    ? 'bg-primary/10 text-primary'
                    : 'hover:bg-base-100/80 text-base-content/70'"
                  @click="toggleChapter(ch.id)"
                >
                  <font-awesome-icon
                    :icon="selectedChapterIds.has(ch.id) ? 'check-square' : 'square'"
                    class="w-2.5 h-2.5 mr-1 shrink-0"
                  />
                  <span class="truncate">{{ ch.title }}</span>
                </button>
              </div>
            </div>
          </aside>

          <!-- Chat Area -->
          <section class="flex-1 flex flex-col min-w-0 min-h-0">
            <!-- Toolbar -->
            <div class="flex items-center gap-1 px-2 py-1 border-b border-base-300/60 shrink-0">
              <button
                v-if="messages.length > 0"
                type="button"
                class="btn btn-ghost btn-xs h-6 min-h-0 text-[11px] gap-1"
                :disabled="sending"
                @click="handleClearHistory"
              >
                <font-awesome-icon icon="eraser" class="w-2.5 h-2.5" />
                清除
              </button>
              <button
                v-if="hasContext"
                type="button"
                class="btn btn-ghost btn-xs h-6 min-h-0 text-[11px] gap-1"
                @click="showContextPanel = !showContextPanel"
              >
                <font-awesome-icon icon="sliders" class="w-2.5 h-2.5" />
                {{ showContextPanel ? '隐藏上下文' : '显示上下文' }}
              </button>
            </div>

            <!-- Messages -->
            <div
              ref="scrollRef"
              class="flex-1 min-h-0 overflow-y-auto p-3 space-y-2"
              @scroll="onScroll"
            >
              <div v-if="messages.length === 0" class="text-center text-base-content/40 text-xs py-12">
                <font-awesome-icon icon="comments" class="text-3xl opacity-20 mb-2" />
                <p>与 AI 编辑讨论当前章节的问题。</p>
                <p class="text-[11px] mt-1">当前章节正文将自动作为上下文。</p>
              </div>

              <div
                v-for="msg in messages"
                :key="msg.id"
                :class="msg.role === 'user' ? 'chat chat-end' : 'chat chat-start'"
              >
                <div class="chat-header text-[10px] opacity-50">
                  {{ msg.role === 'user' ? '你' : '编辑' }}
                </div>
                <div
                  :class="[
                    'chat-bubble max-w-[90%] text-xs',
                    msg.role === 'user'
                      ? 'chat-bubble-primary text-primary-content'
                      : 'chat-bubble-base-200 text-base-content'
                  ]"
                >
                  <details
                    v-if="msg.role === 'assistant' && parseThinking(msg.metadata_json)"
                    :open="thinkingStreamingMessageId === msg.id"
                    class="mb-2 rounded border border-base-300/60 bg-base-100/60"
                  >
                    <summary class="cursor-pointer px-2 py-1 text-[11px] opacity-70 flex items-center gap-1">
                      <font-awesome-icon
                        v-if="thinkingStreamingMessageId === msg.id"
                        icon="spinner"
                        spin
                        class="w-2.5 h-2.5"
                      />
                      {{ thinkingStreamingMessageId === msg.id ? '思考中…' : 'Thinking' }}
                    </summary>
                    <div class="px-2 pb-2 pt-1 text-[11px] whitespace-pre-wrap opacity-80 max-h-60 overflow-y-auto">
                      {{ parseThinking(msg.metadata_json) }}
                    </div>
                  </details>
                  <MarkdownContent
                    v-if="msg.content"
                    :content="msg.content"
                    :inherit-color="msg.role === 'user'"
                  />
                  <span v-else-if="sending && streamingMessageId === msg.id && thinkingStreamingMessageId !== msg.id" class="loading loading-dots loading-sm" />
                </div>
              </div>

              <p v-if="error" class="text-[11px] text-error text-center">{{ error }}</p>
            </div>

            <!-- Scroll to bottom -->
            <button
              v-if="!stickToBottom && messages.length > 0"
              type="button"
              class="absolute bottom-16 left-1/2 -translate-x-1/2 btn btn-primary btn-xs shadow-md gap-1 z-10"
              @click="jumpToBottom"
            >
              <font-awesome-icon icon="arrow-down" class="w-3 h-3" />
              底部
            </button>

            <!-- Input -->
            <div class="border-t border-base-300 p-2 shrink-0">
              <div class="flex items-end gap-1.5">
                <textarea
                  v-model="inputText"
                  class="textarea textarea-bordered flex-1 text-xs resize-none leading-relaxed"
                  rows="2"
                  placeholder="输入问题…（Enter 发送）"
                  :disabled="sending"
                  @keydown="handleKeydown"
                />
                <button
                  v-if="!sending"
                  type="button"
                  class="btn btn-primary btn-sm gap-1"
                  :disabled="!inputText.trim()"
                  @click="handleSend"
                >
                  <font-awesome-icon icon="paper-plane" class="w-3 h-3" />
                </button>
                <button
                  v-else
                  type="button"
                  class="btn btn-error btn-sm gap-1"
                  @click="handleCancel"
                >
                  <font-awesome-icon icon="stop" class="w-3 h-3" />
                </button>
              </div>
            </div>
          </section>
        </div>
      </template>
    </div>
  </Teleport>
</template>
