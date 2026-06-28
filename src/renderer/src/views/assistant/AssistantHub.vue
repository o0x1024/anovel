<script setup lang="ts">
import { ref, toRef, computed, watch, onMounted, nextTick } from 'vue'
import AssistantConversationList from './AssistantConversationList.vue'
import AssistantMessageList from './AssistantMessageList.vue'
import AssistantMessageInput from './AssistantMessageInput.vue'
import AssistantRoleManager from './AssistantRoleManager.vue'
import AssistantRolePicker from './AssistantRolePicker.vue'
import { useAssistantChat } from '../../composables/useAssistantChat'
import {
  getLastAssistantRoleId,
  setLastAssistantConversationId,
  setLastAssistantRoleId
} from '../../services/assistantSession'
import type { AssistantRoleRow, AssistantModelOption, AssistantWorkReference } from '../../../../shared/assistant-types'

const activeConversationId = ref<number | null>(null)
const attachedDocIds = ref<number[]>([])
const attachedDocs = ref<{ id: number; title: string }[]>([])
const attachedWorks = ref<AssistantWorkReference[]>([])
const convListRef = ref<InstanceType<typeof AssistantConversationList> | null>(null)
const messageListRef = ref<InstanceType<typeof AssistantMessageList> | null>(null)
const roles = ref<AssistantRoleRow[]>([])
const modelOptions = ref<AssistantModelOption[]>([])
const conversationModelType = ref<string | null>(null)
const conversationModelName = ref<string | null>(null)
const globalRoleId = ref<number | null>(null)
const showRoleManager = ref(false)
let syncingModelFromConversation = false
let syncingGlobalRole = false

const conversationIdRef = toRef(activeConversationId)
const {
  messages,
  send,
  cancel,
  sending,
  streamingMessageId,
  thinkingStreamingMessageId,
  error,
  editAndResend,
  clearMessages
} = useAssistantChat(conversationIdRef)

const clearingHistory = ref(false)

const canClearHistory = computed(
  () => !!activeConversationId.value && messages.value.length > 0 && !sending.value
)

const activeConversationTitle = computed(() =>
  convListRef.value?.getConversationTitle(activeConversationId.value) ?? null
)

watch(activeConversationId, async (id) => {
  setLastAssistantConversationId(id)
  syncModelFromConversation(id)
  await nextTick()
  messageListRef.value?.resetStickToBottom()
})

watch(globalRoleId, (roleId) => {
  if (syncingGlobalRole) return
  void persistGlobalRole(roleId)
})

watch([conversationModelType, conversationModelName], () => {
  if (syncingModelFromConversation) return
  void persistConversationModel()
})

onMounted(async () => {
  await loadRoles()
  await initGlobalRole()
  modelOptions.value = await window.anovel.invoke('model:listAssistantOptions') as AssistantModelOption[]
})

async function loadRoles() {
  roles.value = await window.anovel.invoke('assistant:roleList') as AssistantRoleRow[]
}

async function initGlobalRole() {
  syncingGlobalRole = true
  try {
    const backendRoleId = await window.anovel.invoke('assistant:getGlobalRole') as number | null
    const saved = getLastAssistantRoleId()
    if (backendRoleId && roles.value.some(r => r.id === backendRoleId)) {
      globalRoleId.value = backendRoleId
    } else if (saved && roles.value.some(r => r.id === saved)) {
      globalRoleId.value = saved
    } else {
      globalRoleId.value = null
    }
    setLastAssistantRoleId(globalRoleId.value)
    await window.anovel.invoke('assistant:setGlobalRole', globalRoleId.value)
  } finally {
    syncingGlobalRole = false
  }
}

function ensureGlobalRoleValid() {
  syncingGlobalRole = true
  try {
    if (globalRoleId.value && !roles.value.some(r => r.id === globalRoleId.value)) {
      globalRoleId.value = null
      setLastAssistantRoleId(null)
    }
  } finally {
    syncingGlobalRole = false
  }
}

async function persistGlobalRole(roleId: number | null) {
  setLastAssistantRoleId(roleId)
  await window.anovel.invoke('assistant:setGlobalRole', roleId)
}

async function syncModelFromConversation(convId: number | null) {
  syncingModelFromConversation = true
  try {
    if (!convId) {
      conversationModelType.value = null
      conversationModelName.value = null
      return
    }
    const conv = await window.anovel.invoke('assistant:convGet', convId) as {
      model_type?: string | null
      model_name?: string | null
    } | undefined
    conversationModelType.value = conv?.model_type ?? null
    conversationModelName.value = conv?.model_name ?? null
  } finally {
    syncingModelFromConversation = false
  }
}

async function persistConversationModel() {
  if (!activeConversationId.value) return
  await window.anovel.invoke(
    'assistant:convUpdateModel',
    activeConversationId.value,
    conversationModelType.value,
    conversationModelName.value
  )
}

function onDocAttached(doc: { id: number; title: string }) {
  if (!attachedDocs.value.some(d => d.id === doc.id)) {
    attachedDocs.value = [...attachedDocs.value, doc]
  }
}

function onDocsCleared() {
  attachedDocs.value = []
}

function onWorksCleared() {
  attachedWorks.value = []
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

function onSendMessage(text: string, ids: number[], workRefs: AssistantWorkReference[], kbNoteIds: number[] = []) {
  const docs = attachedDocs.value.filter(doc => ids.includes(doc.id))
  void send(text, ids, docs, workRefs, kbNoteIds)
}

function openRoleManager() {
  showRoleManager.value = true
}

async function onRolesChanged() {
  await loadRoles()
  ensureGlobalRoleValid()
  await window.anovel.invoke('assistant:setGlobalRole', globalRoleId.value)
  await convListRef.value?.refresh()
}

async function onClearHistory() {
  if (!activeConversationId.value || !canClearHistory.value) return
  if (!confirm('确定清除当前对话的全部历史消息？清除后不会再参与后续 AI 上下文。')) return
  clearingHistory.value = true
  try {
    await clearMessages()
    await convListRef.value?.refresh()
  } finally {
    clearingHistory.value = false
  }
}
</script>

<template>
  <div class="flex flex-col h-full min-h-[calc(100vh-0px)] animate-fade-in">
    <header class="h-12 border-b border-base-300 flex items-center px-4 shrink-0 gap-3 flex-wrap">
      <h1 class="text-sm font-bold shrink-0 min-w-0 truncate max-w-[240px]">
        {{ activeConversationTitle || 'AI 助手' }}
      </h1>

      <div class="ml-auto flex items-center gap-2 shrink-0">
        <button
          v-if="activeConversationId"
          type="button"
          class="btn btn-ghost btn-sm h-8 min-h-8 gap-1.5 text-base-content/70"
          :disabled="!canClearHistory || clearingHistory"
          title="清除当前对话的全部历史消息"
          @click="onClearHistory"
        >
          <span
            v-if="clearingHistory"
            class="loading loading-spinner loading-xs"
          />
          <font-awesome-icon v-else icon="eraser" class="w-3.5 h-3.5" />
          <span class="text-xs hidden sm:inline">清除历史</span>
        </button>
        <AssistantRolePicker
          v-model="globalRoleId"
          :roles="roles"
          :disabled="sending"
          @manage-roles="openRoleManager"
        />
      </div>
    </header>

    <div class="flex flex-1 min-h-0">
      <aside class="w-72 border-r border-base-300 shrink-0 flex flex-col min-h-0 bg-base-200/30">
        <AssistantConversationList
          ref="convListRef"
          v-model="activeConversationId"
        />
      </aside>

      <section class="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        <div class="flex-1 flex flex-col min-h-0">
          <AssistantMessageList
            v-if="activeConversationId"
            ref="messageListRef"
            :messages="messages"
            :sending="sending"
            :streaming-message-id="streamingMessageId"
            :thinking-streaming-message-id="thinkingStreamingMessageId"
            :error="error"
            @edit-resend="(msgId, text) => editAndResend(msgId, text)"
          />
          <div
            v-else
            class="flex-1 flex flex-col items-center justify-center text-base-content/40 gap-2"
          >
            <font-awesome-icon icon="robot" class="text-4xl opacity-20" />
            <p class="text-sm">选择左侧对话，或新建一个开始</p>
          </div>

          <AssistantMessageInput
            v-if="activeConversationId"
            v-model:attached-doc-ids="attachedDocIds"
            v-model:model-type="conversationModelType"
            v-model:model-name="conversationModelName"
            :attached-docs="attachedDocs"
            :attached-works="attachedWorks"
            :sending="sending"
            :model-options="modelOptions"
            @send="onSendMessage"
            @cancel="cancel()"
            @docs-cleared="onDocsCleared"
            @works-cleared="onWorksCleared"
            @doc-attached="onDocAttached"
            @doc-removed="onDocRemoved"
            @work-attached="onWorkAttached"
            @work-removed="onWorkRemoved"
          />
        </div>
      </section>
    </div>

    <dialog :class="['modal', { 'modal-open': showRoleManager }]">
      <div class="modal-box max-w-5xl w-[92vw] h-[80vh] p-0 flex flex-col overflow-hidden">
        <div class="flex items-center justify-between px-4 py-3 border-b border-base-300 shrink-0">
          <h3 class="font-bold text-base">管理角色</h3>
          <button type="button" class="btn btn-ghost btn-sm btn-square" @click="showRoleManager = false">
            <font-awesome-icon icon="times" class="w-4 h-4" />
          </button>
        </div>
        <AssistantRoleManager
          class="flex-1 min-h-0"
          @changed="onRolesChanged"
        />
      </div>
      <form method="dialog" class="modal-backdrop" @click="showRoleManager = false">
        <button type="button">close</button>
      </form>
    </dialog>
  </div>
</template>
