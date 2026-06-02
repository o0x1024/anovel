<script setup lang="ts">
import { ref, onMounted } from 'vue'
import SettingVersionHistory from '../../components/SettingVersionHistory.vue'

const props = defineProps<{ workId: number }>()

const emit = defineEmits<{ 'content-changed': [] }>()

interface CharacterCard {
  name: string
  role: 'protagonist' | 'supporting' | 'antagonist'
  memoryTag?: string
  coreConflict?: string
  reactions?: { instinct?: string; rational?: string; hidden?: string }
  speechStyle?: string
  growthTriggers?: string[]
  relationBinding?: string
}

const ROLE_OPTIONS = [
  { value: 'protagonist', label: '主角' },
  { value: 'supporting', label: '配角' },
  { value: 'antagonist', label: '反派' }
] as const

const cards = ref<CharacterCard[]>([])
const editingIndex = ref<number | null>(null)
const draft = ref<CharacterCard | null>(null)
const saving = ref(false)
const aiLoading = ref(false)
const lastError = ref('')
const logHint = ref('')
const expanded = ref(false)
const versionHistoryRef = ref<{ load: () => Promise<void> } | null>(null)

onMounted(load)

async function refreshVersionHistory() {
  await versionHistoryRef.value?.load?.()
}

async function onVersionRestored() {
  await load()
}

async function load() {
  cards.value = await window.anovel.invoke('characterCards:list', props.workId) as CharacterCard[]
}

defineExpose({
  load: async () => {
    await load()
    await refreshVersionHistory()
  },
  expandPanel: () => {
    expanded.value = true
  }
})

async function notifyContentChanged() {
  emit('content-changed')
}

function emptyCard(): CharacterCard {
  return {
    name: '',
    role: 'supporting',
    memoryTag: '',
    coreConflict: '',
    reactions: { instinct: '', rational: '', hidden: '' },
    speechStyle: '',
    growthTriggers: [''],
    relationBinding: ''
  }
}

function startAdd() {
  draft.value = emptyCard()
  editingIndex.value = -1
}

function startHeaderAction() {
  if (cards.value.length > 0) {
    expanded.value = true
  } else {
    startAdd()
  }
}

function startEdit(idx: number) {
  draft.value = JSON.parse(JSON.stringify(cards.value[idx]))
  editingIndex.value = idx
}

function cancelEdit() {
  draft.value = null
  editingIndex.value = null
}

async function saveDraft() {
  if (!draft.value?.name.trim() || saving.value) return
  saving.value = true
  try {
    const card = {
      ...draft.value,
      name: draft.value.name.trim(),
      growthTriggers: draft.value.growthTriggers?.filter(t => t.trim()) || []
    }
    const next = [...cards.value]
    if (editingIndex.value === -1) next.push(card)
    else if (editingIndex.value != null) next[editingIndex.value] = card
    await window.anovel.invoke('characterCards:save', props.workId, next)
    cards.value = next
    cancelEdit()
    await refreshVersionHistory()
    await notifyContentChanged()
  } finally {
    saving.value = false
  }
}

async function removeCard(idx: number) {
  if (!confirm(`删除人设卡片「${cards.value[idx].name}」？`)) return
  const next = cards.value.filter((_, i) => i !== idx)
  await window.anovel.invoke('characterCards:save', props.workId, next)
  cards.value = next
  await refreshVersionHistory()
  await notifyContentChanged()
}

async function aiGenerate() {
  if (aiLoading.value) return
  aiLoading.value = true
  lastError.value = ''
  logHint.value = ''
  try {
    const res = await window.anovel.invoke('characterCards:aiGenerate', props.workId) as {
      success: boolean
      cards?: CharacterCard[]
      error?: string
      logHint?: string
      parseError?: boolean
    }
    if (res.success && res.cards?.length) {
      await window.anovel.invoke('characterCards:save', props.workId, res.cards)
      await load()
      expanded.value = true
      await refreshVersionHistory()
      await notifyContentChanged()
    } else {
      lastError.value = res.error || '生成失败'
      logHint.value = res.logHint || ''
    }
  } catch (e) {
    lastError.value = String(e)
  } finally {
    aiLoading.value = false
  }
}

async function openTodayLog() {
  await window.anovel.invoke('log:openToday')
}

function roleLabel(role: string): string {
  return ROLE_OPTIONS.find(r => r.value === role)?.label ?? role
}

function cardsSummary(): string {
  if (cards.value.length === 0) return ''
  const first = cards.value[0]
  const lead = first.memoryTag || first.coreConflict || first.name
  const plain = lead.length > 48 ? `${lead.slice(0, 48)}…` : lead
  return `${plain} · 共 ${cards.value.length} 张`
}
</script>

<template>
  <div id="character-cards-panel" class="card bg-base-200 border border-base-300 shadow-sm p-4">
    <div class="flex items-start justify-between mb-2">
      <div>
        <h4 class="font-semibold flex items-center gap-2">
          <font-awesome-icon icon="gem" class="w-3.5 h-3.5 text-primary shrink-0" />
          结构化人设卡片
        </h4>
        <p class="text-xs text-base-content/40 mt-0.5">
          矛盾点 · 记忆标签 · 行为反应 · 关系绑定（正文生成时按章节自动注入）
        </p>
      </div>
      <div class="flex gap-2 shrink-0">
        <button
          type="button"
          class="btn btn-primary btn-xs gap-1"
          :disabled="aiLoading"
          @click="aiGenerate"
        >
          <font-awesome-icon
            :icon="aiLoading ? 'spinner' : 'robot'"
            :spin="aiLoading"
            class="w-3 h-3"
          />
          {{ aiLoading ? '生成中...' : 'AI 生成卡片' }}
        </button>
        <button type="button" class="btn btn-outline btn-primary btn-xs gap-1" @click="startHeaderAction">
          <font-awesome-icon :icon="cards.length ? 'edit' : 'plus'" class="w-3 h-3" />
          {{ cards.length ? '编辑' : '添加' }}
        </button>
      </div>
    </div>

    <div v-if="lastError" class="alert alert-error text-xs py-2 mb-3">
      <div>{{ lastError }}</div>
      <div v-if="logHint" class="mt-2 text-base-content/70 break-all">
        日志文件：{{ logHint }}
      </div>
      <button type="button" class="btn btn-outline btn-error btn-xs mt-2" @click="openTodayLog">
        打开今日日志
      </button>
    </div>

    <SettingVersionHistory
      ref="versionHistoryRef"
      :work-id="workId"
      type="character_cards"
      @restored="onVersionRestored"
    />

    <div v-if="cards.length > 0" class="mt-1">
      <button
        type="button"
        class="w-full flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-base-100/80 transition-colors"
        @click="expanded = !expanded"
      >
        <span class="text-xs text-base-content/60 truncate">{{ cardsSummary() }}</span>
        <font-awesome-icon
          :icon="expanded ? 'chevron-up' : 'chevron-down'"
          class="w-3 h-3 shrink-0 text-base-content/40"
        />
      </button>
      <div v-show="expanded" class="mt-2 pt-2 border-t border-base-300/50 space-y-2">
        <div
          v-for="(card, idx) in cards"
          :key="idx"
          class="border border-base-300/60 rounded-lg p-3 bg-base-100 text-sm"
        >
          <div class="flex justify-between items-start gap-2">
            <div>
              <span class="font-semibold">{{ card.name }}</span>
              <span class="badge badge-outline badge-xs ml-2">{{ roleLabel(card.role) }}</span>
              <p v-if="card.memoryTag" class="text-xs text-base-content/60 mt-1">记忆：{{ card.memoryTag }}</p>
              <p v-if="card.coreConflict" class="text-xs text-base-content/60">矛盾：{{ card.coreConflict }}</p>
            </div>
            <div class="flex gap-1 shrink-0">
              <button type="button" class="btn btn-ghost btn-xs" @click="startEdit(idx)">编辑</button>
              <button type="button" class="btn btn-ghost btn-xs text-error" @click="removeCard(idx)">删除</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    <p v-else class="text-sm text-base-content/40 italic">尚未设定</p>

    <dialog :class="['modal', { 'modal-open': draft !== null }]">
      <div v-if="draft" class="modal-box w-[92vw] max-w-2xl">
        <div class="flex items-center justify-between gap-4 mb-4">
          <h3 class="font-bold text-lg">
            {{ editingIndex === -1 ? '添加' : '编辑' }} · 人设卡片
          </h3>
          <button type="button" class="btn btn-ghost btn-sm btn-circle" @click="cancelEdit">
            <font-awesome-icon icon="times" class="w-4 h-4" />
          </button>
        </div>

        <div class="space-y-3">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input v-model="draft.name" placeholder="角色名 *" class="input input-bordered input-sm" />
            <select v-model="draft.role" class="select select-bordered select-sm">
              <option v-for="r in ROLE_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
          </div>
          <input v-model="draft.memoryTag" placeholder="记忆标签（刀疤/口头禅/配饰）" class="input input-bordered input-sm w-full" />
          <input v-model="draft.coreConflict" placeholder="核心矛盾（价值观/行为/认知）" class="input input-bordered input-sm w-full" />
          <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
            <input v-model="draft.reactions!.instinct" placeholder="本能反应" class="input input-bordered input-xs" />
            <input v-model="draft.reactions!.rational" placeholder="理性反应" class="input input-bordered input-xs" />
            <input v-model="draft.reactions!.hidden" placeholder="隐藏反应" class="input input-bordered input-xs" />
          </div>
          <input v-model="draft.speechStyle" placeholder="语言风格" class="input input-bordered input-sm w-full" />
          <input v-model="draft.relationBinding" placeholder="关系绑定（利益/信息差/情感负债）" class="input input-bordered input-sm w-full" />
          <input
            :value="draft.growthTriggers?.join('；')"
            placeholder="成长触发点（分号分隔）"
            class="input input-bordered input-sm w-full"
            @input="(e: Event) => { draft!.growthTriggers = (e.target as HTMLInputElement).value.split(/[；;]/).map(s => s.trim()) }"
          />
        </div>

        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" @click="cancelEdit">取消</button>
          <button type="button" class="btn btn-primary btn-sm" :disabled="!draft.name.trim() || saving" @click="saveDraft">
            保存
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop bg-black/40" @click="cancelEdit">
        <button type="button">close</button>
      </form>
    </dialog>
  </div>
</template>
