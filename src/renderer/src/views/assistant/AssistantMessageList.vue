<script setup lang="ts">
import { ref, computed } from 'vue'
import { useStickToBottomScroll } from '../../composables/useStickToBottomScroll'
import MarkdownContent from '../../components/MarkdownContent.vue'
import StyleAnalysisCard from './cards/StyleAnalysisCard.vue'
import WorkSummaryCard from './cards/WorkSummaryCard.vue'
import PatchFixCard from './cards/PatchFixCard.vue'
import type { AssistantMessageView } from '../../composables/useAssistantChat'
import type { StyleAnalysisResult, WorkSummaryResult, AssistantWorkReference, PatchFixResult } from '../../../../shared/assistant-types'
import { renderMarkdown } from '../../utils/renderMarkdown'

const props = defineProps<{
  messages: AssistantMessageView[]
  sending: boolean
  streamingMessageId: number | null
  thinkingStreamingMessageId: number | null
  error: string
}>()

const emit = defineEmits<{
  editResend: [messageId: number, newText: string]
}>()

const editingId = ref<number | null>(null)
const editDraft = ref('')
const copiedKey = ref<string | null>(null)
const actionFeedback = ref<{ key: string; text: string } | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null
let feedbackTimer: ReturnType<typeof setTimeout> | null = null

function parseMetadata(metadataJson: string | null): {
  styleAnalysis?: StyleAnalysisResult
  workSummary?: WorkSummaryResult
  patchFix?: PatchFixResult
  thinking?: string
  documentIds?: number[]
  documents?: Array<{ id: number; title: string }>
  workReferences?: AssistantWorkReference[]
} | null {
  if (!metadataJson) return null
  try {
    return JSON.parse(metadataJson) as {
      styleAnalysis?: StyleAnalysisResult
      workSummary?: WorkSummaryResult
      patchFix?: PatchFixResult
      thinking?: string
      documentIds?: number[]
      documents?: Array<{ id: number; title: string }>
      workReferences?: AssistantWorkReference[]
    }
  } catch {
    return null
  }
}

function documentPillClasses(role: string): string {
  if (role === 'user') {
    return 'inline-flex items-center gap-1.5 rounded-md border border-primary-content/30 bg-primary-content/10 px-2 py-1 text-xs text-primary-content/95 max-w-full'
  }
  return 'inline-flex items-center gap-1.5 rounded-md border border-base-300 bg-base-100 px-2 py-1 text-xs text-base-content/80 max-w-full'
}

function workPillClasses(role: string): string {
  if (role === 'user') {
    return 'inline-flex items-center gap-1.5 rounded-md border border-primary-content/30 bg-primary-content/10 px-2 py-1 text-xs text-primary-content/95 max-w-full'
  }
  return 'inline-flex items-center gap-1.5 rounded-md border border-secondary/30 bg-secondary/5 px-2 py-1 text-xs text-base-content/80 max-w-full'
}

function previousStyleAnalysis(beforeMessageId: number): StyleAnalysisResult | null {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    const m = props.messages[i]
    if (m.id >= beforeMessageId) continue
    const meta = parseMetadata(m.metadata_json)
    if (meta?.styleAnalysis) return meta.styleAnalysis
  }
  return null
}

function shouldExpandThinking(messageId: number): boolean {
  return props.thinkingStreamingMessageId === messageId
}

function buildRenderedPlainText(markdown: string): string {
  const html = renderMarkdown(markdown)
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (doc.body.textContent ?? '').trim()
}

async function copyText(text: string, key: string): Promise<void> {
  const next = text.trim()
  if (!next) return
  try {
    await navigator.clipboard.writeText(next)
    copiedKey.value = key
    setActionFeedback(key, '已复制')
    if (copiedTimer) {
      clearTimeout(copiedTimer)
    }
    copiedTimer = setTimeout(() => {
      copiedKey.value = null
      copiedTimer = null
    }, 1200)
  } catch {
    setActionFeedback(key, '复制失败')
  }
}

function resendMessage(msg: AssistantMessageView): void {
  if (!canEdit.value) return
  emit('editResend', msg.id, msg.content)
  setActionFeedback(`user:${msg.id}:resend`, '已重发')
}

function setActionFeedback(key: string, text: string): void {
  actionFeedback.value = { key, text }
  if (feedbackTimer) {
    clearTimeout(feedbackTimer)
  }
  feedbackTimer = setTimeout(() => {
    actionFeedback.value = null
    feedbackTimer = null
  }, 1500)
}

function feedbackFor(key: string): string | null {
  return actionFeedback.value?.key === key ? actionFeedback.value.text : null
}

function startEdit(msg: AssistantMessageView) {
  editingId.value = msg.id
  editDraft.value = msg.content
  setActionFeedback(`user:${msg.id}:edit`, '编辑中')
}

function cancelEdit() {
  editingId.value = null
  editDraft.value = ''
}

function commitEdit(messageId: number) {
  const text = editDraft.value.trim()
  if (!text) return
  emit('editResend', messageId, text)
  cancelEdit()
}

const canEdit = computed(() => !props.sending)

const scrollRef = ref<HTMLElement | null>(null)

const lastMessageSnapshot = computed(() => {
  const last = props.messages.at(-1)
  if (!last) return ''
  return `${last.content}\0${last.metadata_json ?? ''}`
})

const { stickToBottom, onScroll, jumpToBottom, resetStickToBottom } = useStickToBottomScroll(
  scrollRef,
  () => [
    props.messages.length,
    lastMessageSnapshot.value,
    props.streamingMessageId,
    props.thinkingStreamingMessageId,
    props.sending
  ]
)

defineExpose({ resetStickToBottom })
</script>

<template>
  <div class="relative flex-1 min-h-0 flex flex-col">
  <div
    ref="scrollRef"
    class="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 scrollbar-thin"
    @scroll="onScroll"
  >
    <div v-if="messages.length === 0" class="text-center text-base-content/40 text-sm py-20">
      发送消息开始对话。支持上传文档、引用作品正文，或从文档库附加外部作品。
    </div>

    <div
      v-for="msg in messages"
      :key="msg.id"
      :class="msg.role === 'user' ? 'chat chat-end' : 'chat chat-start'"
    >
      <div class="chat-header text-xs opacity-50 flex items-center gap-2">
        <span>{{ msg.role === 'user' ? '你' : '助手' }}</span>
      </div>
      <div
        :class="[
          'chat-bubble max-w-[90%]',
          msg.role === 'user'
            ? 'chat-bubble-primary text-primary-content'
            : 'chat-bubble-base-200 text-base-content'
        ]"
      >
        <details
          v-if="msg.role === 'assistant' && parseMetadata(msg.metadata_json)?.thinking"
          :open="shouldExpandThinking(msg.id)"
          class="mb-2 rounded border border-base-300/60 bg-base-100/60"
        >
          <summary class="cursor-pointer px-2 py-1 text-[11px] opacity-70">Thinking</summary>
          <div class="px-2 pb-2 pt-1 text-xs whitespace-pre-wrap opacity-80">
            {{ parseMetadata(msg.metadata_json)?.thinking }}
          </div>
        </details>
        <div v-if="editingId === msg.id" class="space-y-2 min-w-[200px]">
          <textarea v-model="editDraft" class="textarea textarea-bordered textarea-xs w-full text-sm" rows="3" />
          <div class="flex gap-1 justify-end">
            <button type="button" class="btn btn-ghost btn-xs" @click="cancelEdit">取消</button>
            <button type="button" class="btn btn-primary btn-xs" @click="commitEdit(msg.id)">重发</button>
          </div>
        </div>
        <template v-else>
          <MarkdownContent
            v-if="msg.content"
            :content="msg.content"
            :inherit-color="msg.role === 'user'"
          />
          <span v-else-if="sending && streamingMessageId === msg.id" class="loading loading-dots loading-sm" />
        </template>
        <div
          v-if="parseMetadata(msg.metadata_json)?.documents?.length || parseMetadata(msg.metadata_json)?.workReferences?.length"
          class="mt-2 flex flex-wrap gap-2"
        >
          <div
            v-for="doc in parseMetadata(msg.metadata_json)?.documents"
            :key="`doc-${doc.id}`"
            :class="documentPillClasses(msg.role)"
          >
            <span
              class="inline-flex items-center justify-center w-4 h-4 rounded-sm shrink-0"
              :class="msg.role === 'user' ? 'bg-primary-content/15' : 'bg-primary/10'"
            >
              <font-awesome-icon
                icon="paperclip"
                class="w-2.5 h-2.5"
                :class="msg.role === 'user' ? 'text-primary-content/90' : 'text-primary'"
              />
            </span>
            <span class="truncate max-w-[220px]" :title="doc.title">
            {{ doc.title }}
            </span>
          </div>
          <div
            v-for="work in parseMetadata(msg.metadata_json)?.workReferences"
            :key="`work-${work.workId}-${work.chapterId ?? 'all'}`"
            :class="workPillClasses(msg.role)"
          >
            <span
              class="inline-flex items-center justify-center w-4 h-4 rounded-sm shrink-0"
              :class="msg.role === 'user' ? 'bg-primary-content/15' : 'bg-secondary/15'"
            >
              <font-awesome-icon
                icon="book-open"
                class="w-2.5 h-2.5"
                :class="msg.role === 'user' ? 'text-primary-content/90' : 'text-secondary'"
              />
            </span>
            <span class="truncate max-w-[220px]" :title="work.title">
              {{ work.title }}
            </span>
          </div>
        </div>
        <div
          v-else-if="parseMetadata(msg.metadata_json)?.documentIds?.length || parseMetadata(msg.metadata_json)?.workReferences?.length"
          class="mt-2 text-[11px] opacity-60"
        >
          已引用
          {{ (parseMetadata(msg.metadata_json)?.documentIds?.length ?? 0) + (parseMetadata(msg.metadata_json)?.workReferences?.length ?? 0) }}
          项内容
        </div>
        <template v-if="msg.message_type === 'tool_result' && parseMetadata(msg.metadata_json)">
          <StyleAnalysisCard
            v-if="parseMetadata(msg.metadata_json)?.styleAnalysis"
            :analysis="parseMetadata(msg.metadata_json)!.styleAnalysis!"
            :previous-analysis="previousStyleAnalysis(msg.id)"
          />
          <WorkSummaryCard
            v-if="parseMetadata(msg.metadata_json)?.workSummary"
            :summary="parseMetadata(msg.metadata_json)!.workSummary!"
          />
          <PatchFixCard
            v-if="parseMetadata(msg.metadata_json)?.patchFix"
            :fix-result="parseMetadata(msg.metadata_json)!.patchFix!"
          />
        </template>
      </div>
      <div
        :class="[
          'chat-footer mt-2 flex items-center gap-1 bg-transparent border-0',
          msg.role === 'user' ? 'justify-end' : 'justify-start'
        ]"
      >
        <template v-if="msg.role === 'user'">
          <button
            v-if="canEdit && editingId !== msg.id"
            type="button"
            class="btn btn-ghost btn-xs px-2 min-h-0 h-6 opacity-70 hover:opacity-100"
            title="编辑并重发"
            @click="startEdit(msg)"
          >
            <font-awesome-icon icon="pencil-alt" class="w-3 h-3" />
          </button>
          <button
            v-if="canEdit && editingId !== msg.id"
            type="button"
            class="btn btn-ghost btn-xs px-2 min-h-0 h-6 opacity-70 hover:opacity-100"
            title="重发"
            @click="resendMessage(msg)"
          >
            <font-awesome-icon icon="rotate" class="w-3 h-3" />
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-xs px-2 min-h-0 h-6 opacity-70 hover:opacity-100"
            :title="copiedKey === `user:${msg.id}:raw` ? '已复制' : '复制'"
            @click="copyText(msg.content, `user:${msg.id}:raw`)"
          >
            <font-awesome-icon icon="copy" class="w-3 h-3" />
          </button>
          <span
            v-if="feedbackFor(`user:${msg.id}:edit`) || feedbackFor(`user:${msg.id}:resend`) || feedbackFor(`user:${msg.id}:raw`)"
            class="text-[11px] opacity-60 ml-1"
          >
            {{ feedbackFor(`user:${msg.id}:edit`) || feedbackFor(`user:${msg.id}:resend`) || feedbackFor(`user:${msg.id}:raw`) }}
          </span>
        </template>
        <template v-else>
          <button
            type="button"
            class="btn btn-ghost btn-xs px-2 min-h-0 h-6 opacity-70 hover:opacity-100"
            :title="copiedKey === `assistant:${msg.id}:raw` ? '已复制原文' : '复制原文'"
            @click="copyText(msg.content, `assistant:${msg.id}:raw`)"
          >
            {{ copiedKey === `assistant:${msg.id}:raw` ? '已复制' : '复制 Markdown 原文' }}
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-xs px-2 min-h-0 h-6 opacity-70 hover:opacity-100"
            :title="copiedKey === `assistant:${msg.id}:rendered` ? '已复制渲染文本' : '复制渲染文本'"
            @click="copyText(buildRenderedPlainText(msg.content) || msg.content, `assistant:${msg.id}:rendered`)"
          >
            {{ copiedKey === `assistant:${msg.id}:rendered` ? '已复制' : '复制渲染后文本' }}
          </button>
          <span
            v-if="feedbackFor(`assistant:${msg.id}:raw`) || feedbackFor(`assistant:${msg.id}:rendered`)"
            class="text-[11px] opacity-60 ml-1"
          >
            {{ feedbackFor(`assistant:${msg.id}:raw`) || feedbackFor(`assistant:${msg.id}:rendered`) }}
          </span>
        </template>
      </div>
    </div>

    <p v-if="error" class="text-xs text-error text-center">{{ error }}</p>
  </div>

  <button
    v-if="!stickToBottom && messages.length > 0"
    type="button"
    class="absolute bottom-3 left-1/2 -translate-x-1/2 btn btn-primary btn-xs shadow-md gap-1 z-10"
    @click="jumpToBottom"
  >
    <font-awesome-icon icon="arrow-down" class="w-3 h-3" />
    回到底部
  </button>
  </div>
</template>
