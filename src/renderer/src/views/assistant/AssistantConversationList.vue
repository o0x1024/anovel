<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { getLastAssistantConversationId } from '../../services/assistantSession'

interface AssistantConversation {
  id: number
  title: string
  update_time: string
}

const activeId = defineModel<number | null>({ required: true })

const conversations = ref<AssistantConversation[]>([])
const loading = ref(true)
const searchQuery = ref('')
const renamingId = ref<number | null>(null)
const renameDraft = ref('')
let initialRestoreDone = false

onMounted(async () => {
  await refresh()
})

async function refresh() {
  loading.value = true
  try {
    conversations.value = await window.anovel.invoke('assistant:convList') as AssistantConversation[]
    if (!initialRestoreDone) {
      initialRestoreDone = true
      restoreLastActiveConversation()
    }
  } finally {
    loading.value = false
  }
}

const filteredConversations = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return conversations.value
  return conversations.value.filter(c => c.title.toLowerCase().includes(q))
})

function selectConversation(id: number): void {
  activeId.value = id
}

async function createConversation() {
  const conv = await window.anovel.invoke('assistant:convCreate') as AssistantConversation
  await refresh()
  activeId.value = conv.id
}

async function deleteConversation(id: number, event: Event) {
  event.stopPropagation()
  if (!confirm('删除此对话？')) return
  await window.anovel.invoke('assistant:convDelete', id)
  if (activeId.value === id) activeId.value = null
  await refresh()
}

function startRename(conv: AssistantConversation, event: Event) {
  event.stopPropagation()
  renamingId.value = conv.id
  renameDraft.value = conv.title
}

async function commitRename() {
  if (renamingId.value === null) return
  await window.anovel.invoke('assistant:convUpdate', renamingId.value, renameDraft.value.trim() || '新对话')
  renamingId.value = null
  await refresh()
}

function cancelRename() {
  renamingId.value = null
}

function getConversationTitle(convId: number | null) {
  if (convId === null) return null
  return conversations.value.find(c => c.id === convId)?.title ?? null
}

function restoreLastActiveConversation() {
  if (activeId.value) return
  const lastId = getLastAssistantConversationId()
  if (!lastId) return
  if (conversations.value.some(c => c.id === lastId)) {
    activeId.value = lastId
  }
}

defineExpose({ refresh, getConversationTitle })
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="p-4 border-b border-base-300 shrink-0">
      <h2 class="font-bold text-sm">对话</h2>
      <input
        v-model="searchQuery"
        type="search"
        class="input input-bordered input-xs w-full mt-2"
        placeholder="搜索会话…"
      />
      <button type="button" class="btn btn-primary btn-sm btn-block mt-2" @click="createConversation">
        <font-awesome-icon icon="plus" class="w-3 h-3" />
        新对话
      </button>
    </div>

    <div v-if="loading" class="p-4 text-center">
      <span class="loading loading-spinner loading-sm" />
    </div>

    <ul v-else class="menu menu-sm flex-1 overflow-y-auto p-2 gap-0.5">
      <li v-if="filteredConversations.length === 0" class="text-xs text-center text-base-content/40 py-4">
        无匹配会话
      </li>
      <li v-for="conv in filteredConversations" :key="conv.id">
        <div
          :class="{ 'menu-active': activeId === conv.id }"
          class="flex items-center min-w-0 w-full cursor-pointer"
          @click="selectConversation(conv.id)"
        >
          <div class="flex-1 min-w-0 truncate text-left px-2 py-1.5">
            {{ conv.title }}
          </div>
          <div class="flex items-center shrink-0 ml-auto">
            <button
              type="button"
              class="btn btn-ghost btn-xs btn-square shrink-0 w-6 h-6 min-h-0 p-0"
              title="重命名"
              @click.stop="startRename(conv, $event)"
            >
              <font-awesome-icon icon="pencil-alt" class="w-3 h-3 opacity-40" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-xs btn-square shrink-0 w-6 h-6 min-h-0 p-0"
              title="删除"
              @click.stop="deleteConversation(conv.id, $event)"
            >
              <font-awesome-icon icon="trash" class="w-3 h-3 opacity-40" />
            </button>
          </div>
        </div>
      </li>
    </ul>

    <dialog :class="['modal', { 'modal-open': renamingId !== null }]">
      <div class="modal-box max-w-sm">
        <h3 class="font-bold text-lg mb-4">重命名会话</h3>
        <input v-model="renameDraft" class="input input-bordered input-sm w-full" @keyup.enter="commitRename" />
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" @click="cancelRename">取消</button>
          <button type="button" class="btn btn-primary btn-sm" @click="commitRename">保存</button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop" @click="cancelRename">
        <button type="button">close</button>
      </form>
    </dialog>
  </div>
</template>
