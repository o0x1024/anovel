<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { toPlainForIpc } from '../../../../shared/ipc-plain'
import SettingVersionHistory from '../../components/SettingVersionHistory.vue'
import NamePickerDialog from '../../components/NamePickerDialog.vue'
import NameSimilarityHint from '../../components/NameSimilarityHint.vue'
import ListBatchToolbar from '../../components/ListBatchToolbar.vue'
import {
  useListSelection,
  confirmBatchDelete,
  confirmDeleteAll
} from '../../composables/useListSelection'
import { useBodyGenerationModel } from '../../composables/useBodyGenerationModel'
import type { NameEntryRow } from '../../../../shared/name-registry-types'

const props = defineProps<{ workId: number; protagonistOnly?: boolean }>()
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)

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
const lastWarning = ref('')
const logHint = ref('')
const versionHistoryRef = ref<{ load: () => Promise<void> } | null>(null)
const showNamePicker = ref(false)
const genHintsDialogOpen = ref(false)
const genHints = ref('')
const genHintsInputRef = ref<HTMLTextAreaElement | null>(null)
const namePickerForHintsOpen = ref(false)

const selection = useListSelection(cards, {
  getKey: (_item, index) => index
})

onMounted(load)

async function refreshVersionHistory() {
  await versionHistoryRef.value?.load?.()
}

async function onVersionRestored() {
  await load()
}

async function load() {
  cards.value = await window.anovel.invoke('characterCards:list', props.workId) as CharacterCard[]
  selection.clearSelection()
}

defineExpose({
  load: async () => {
    await load()
    await refreshVersionHistory()
  },
  expandPanel: () => {
    document.getElementById('character-cards-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
})

async function notifyContentChanged() {
  emit('content-changed')
}

function emptyCard(): CharacterCard {
  return {
    name: '',
    role: props.protagonistOnly ? 'protagonist' : 'supporting',
    memoryTag: '',
    coreConflict: '',
    reactions: { instinct: '', rational: '', hidden: '' },
    speechStyle: '',
    growthTriggers: [''],
    relationBinding: ''
  }
}

function toEditableCard(input?: CharacterCard): CharacterCard {
  const base = emptyCard()
  const next = input ? { ...base, ...input } : base
  return {
    ...next,
    reactions: {
      instinct: next.reactions?.instinct ?? '',
      rational: next.reactions?.rational ?? '',
      hidden: next.reactions?.hidden ?? ''
    },
    growthTriggers: next.growthTriggers?.length ? [...next.growthTriggers] : ['']
  }
}

const draftMissingRequired = computed(() => {
  if (!draft.value) return [] as string[]
  const missing: string[] = []
  if (!draft.value.memoryTag?.trim()) missing.push('记忆标签')
  if (!draft.value.coreConflict?.trim()) missing.push('核心矛盾')
  if (!draft.value.relationBinding?.trim()) missing.push('关系绑定')
  return missing
})

const draftNameDuplicate = computed(() => {
  if (!draft.value) return false
  const name = draft.value.name.trim().toLowerCase()
  if (!name) return false
  return cards.value.some((c, idx) => {
    if (idx === editingIndex.value) return false
    return c.name.trim().toLowerCase() === name
  })
})

const canSaveDraft = computed(() =>
  !!draft.value?.name.trim()
  && draftMissingRequired.value.length === 0
  && !draftNameDuplicate.value
  && !saving.value
)

const cardsCompletionHints = computed(() => {
  if (cards.value.length === 0) return [] as string[]
  const missingMemoryTag = cards.value.filter(c => !c.memoryTag?.trim()).length
  const missingCoreConflict = cards.value.filter(c => !c.coreConflict?.trim()).length
  const missingRelationBinding = cards.value.filter(c => !c.relationBinding?.trim()).length
  const protagonistCount = cards.value.filter(c => c.role === 'protagonist').length
  const hints: string[] = []
  if (missingMemoryTag > 0) hints.push(`${missingMemoryTag} 张缺少记忆标签`)
  if (missingCoreConflict > 0) hints.push(`${missingCoreConflict} 张缺少核心矛盾`)
  if (missingRelationBinding > 0) hints.push(`${missingRelationBinding} 张缺少关系绑定`)
  if (!props.protagonistOnly && protagonistCount === 0) hints.push('缺少主角（protagonist）卡片')
  return hints
})

function startAdd() {
  draft.value = toEditableCard()
  editingIndex.value = -1
}

function startEdit(idx: number) {
  draft.value = toEditableCard(JSON.parse(JSON.stringify(cards.value[idx])) as CharacterCard)
  editingIndex.value = idx
}

function cancelEdit() {
  draft.value = null
  editingIndex.value = null
}

async function saveDraft() {
  if (!canSaveDraft.value) return
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
    const ok = await persistCards(next)
    if (ok) cancelEdit()
  } finally {
    saving.value = false
  }
}

async function persistCards(next: CharacterCard[]) {
  const res = await window.anovel.invoke('characterCards:save', props.workId, toPlainForIpc(next)) as {
    success: boolean
    cards?: CharacterCard[]
    error?: string
    warnings?: string[]
  }
  if (!res.success) {
    lastError.value = res.error || '保存失败'
    lastWarning.value = (res.warnings ?? []).join('；')
    if (res.cards) cards.value = res.cards
    return false
  }
  cards.value = res.cards ?? next
  lastWarning.value = (res.warnings ?? []).join('；')
  lastError.value = ''
  if (editingIndex.value != null && editingIndex.value >= cards.value.length) {
    cancelEdit()
  }
  await refreshVersionHistory()
  await notifyContentChanged()
  return true
}

async function removeCard(idx: number) {
  const name = cards.value[idx]?.name
  if (!name || !confirm(`删除人设卡片「${name}」？`)) return
  const next = cards.value.filter((_, i) => i !== idx)
  await persistCards(next)
}

async function deleteSelectedCards() {
  const indices = selection
    .getSelectedItems()
    .map(item => cards.value.indexOf(item))
    .filter(i => i >= 0)
    .sort((a, b) => b - a)
  if (!(await confirmBatchDelete(indices.length, '人设卡片'))) return
  const next = [...cards.value]
  for (const idx of indices) next.splice(idx, 1)
  const ok = await persistCards(next)
  if (ok) selection.clearSelection()
}

async function deleteAllCardsBatch() {
  if (!cards.value.length) return
  if (!(await confirmDeleteAll(cards.value.length, '人设卡片'))) return
  cancelEdit()
  const ok = await persistCards([])
  if (ok) selection.clearSelection()
}

function onAiGenerateClick() {
  if (aiLoading.value) return
  void openGenHintsDialog()
}

async function openGenHintsDialog() {
  genHints.value = (await window.anovel.invoke(
    'setting:getGenHints',
    props.workId,
    'character_cards'
  )) as string
  genHintsDialogOpen.value = true
  await nextTick()
  genHintsInputRef.value?.focus()
}

function closeGenHintsDialog() {
  genHintsDialogOpen.value = false
}

function insertNameHintForGen(entry: NameEntryRow) {
  const snippet = entry.meaning?.trim() ? `${entry.name}（${entry.meaning.trim()}）` : entry.name
  const prefix = genHints.value.trim()
  genHints.value = prefix ? `${prefix}；${snippet}` : `角色名：${snippet}`
  void nextTick(() => genHintsInputRef.value?.focus())
}

async function confirmAiGenerate() {
  const hints = genHints.value.trim()
  await window.anovel.invoke('setting:setGenHints', props.workId, 'character_cards', hints)
  closeGenHintsDialog()
  await aiGenerate(hints)
}

async function aiGenerate(userHints?: string) {
  if (aiLoading.value) return
  aiLoading.value = true
  lastError.value = ''
  lastWarning.value = ''
  logHint.value = ''
  try {
    const res = await window.anovel.invoke(
      'characterCards:aiGenerate',
      props.workId,
      userHints?.trim() || undefined,
      bodyModelParams()
    ) as {
      success: boolean
      cards?: CharacterCard[]
      error?: string
      logHint?: string
      parseError?: boolean
      warnings?: string[]
    }
    if (res.success && res.cards?.length) {
      const ok = await persistCards(res.cards)
      if (!ok) return
      lastWarning.value = [lastWarning.value, ...(res.warnings ?? [])].filter(Boolean).join('；')
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

async function onNamePicked(entry: NameEntryRow) {
  if (!draft.value) return
  draft.value.name = entry.name
  if (entry.meaning?.trim() && !draft.value.memoryTag?.trim()) {
    draft.value.memoryTag = entry.meaning.trim()
  }
  if (entry.status !== 'adopted') {
    await window.anovel.invoke('name:adopt', props.workId, entry.id, 'character_card')
  }
}
</script>

<template>
  <div id="character-cards-panel" class="card bg-base-200 border border-base-300 shadow-sm p-4">
    <div class="flex items-start justify-between mb-2">
      <div>
        <h4 class="font-semibold flex items-center gap-2">
          <font-awesome-icon icon="gem" class="w-3.5 h-3.5 text-primary shrink-0" />
          {{ protagonistOnly ? '主角人设卡片' : '结构化人设卡片' }}
        </h4>
        <p class="text-xs text-base-content/40 mt-0.5">
          <template v-if="protagonistOnly">
            主角的记忆标签 · 核心矛盾 · 行为反应（正文生成时自动注入，配角在「功能性配角」中定义即可）
          </template>
          <template v-else>
            矛盾点 · 记忆标签 · 行为反应 · 关系绑定（正文生成时按章节自动注入）
          </template>
        </p>
      </div>
      <div class="flex gap-2 shrink-0">
        <button
          type="button"
          class="btn btn-primary btn-xs gap-1"
          :disabled="aiLoading"
          @click="onAiGenerateClick"
        >
          <font-awesome-icon
            :icon="aiLoading ? 'spinner' : 'robot'"
            :spin="aiLoading"
            class="w-3 h-3"
          />
          {{ aiLoading ? '生成中...' : 'AI 生成卡片' }}
        </button>
        <button type="button" class="btn btn-outline btn-primary btn-xs gap-1" @click="startAdd">
          <font-awesome-icon icon="plus" class="w-3 h-3" />
          添加
        </button>
        <button
          v-if="cards.length"
          type="button"
          class="btn btn-ghost btn-xs text-error"
          @click="deleteAllCardsBatch"
        >
          清空全部
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
    <div v-if="!lastError && lastWarning" class="alert alert-warning text-xs py-2 mb-3">
      {{ lastWarning }}
    </div>
    <div v-if="cardsCompletionHints.length > 0" class="alert alert-warning text-xs py-2 mb-3">
      待补齐：{{ cardsCompletionHints.join('；') }}
    </div>

    <SettingVersionHistory
      ref="versionHistoryRef"
      :work-id="workId"
      type="character_cards"
      @restored="onVersionRestored"
    />

    <div v-if="cards.length > 0" class="mt-2 space-y-2">
      <ListBatchToolbar
        :total="cards.length"
        :selectable-count="selection.selectableCount"
        :selected-count="selection.selectedCount"
        :all-selected="selection.allSelected"
        @toggle-all="selection.toggleAll()"
        @delete-selected="deleteSelectedCards"
        @delete-all="deleteAllCardsBatch"
      />
      <p class="text-xs text-base-content/50">{{ cardsSummary() }}</p>
      <div
        v-for="(card, idx) in cards"
        :key="`${card.name}-${idx}`"
        class="border border-base-300/60 rounded-lg p-3 bg-base-100 text-sm"
        :class="{ 'ring-1 ring-primary/40': selection.isSelected(card, idx) }"
      >
        <div class="flex justify-between items-start gap-2">
          <div class="flex items-start gap-2 min-w-0">
            <input
              type="checkbox"
              class="checkbox checkbox-xs mt-0.5 shrink-0"
              :checked="selection.isSelected(card, idx)"
              @change="selection.toggle(card, idx)"
            />
            <div class="min-w-0">
            <span class="font-semibold">{{ card.name }}</span>
            <span class="badge badge-outline badge-xs ml-2">{{ roleLabel(card.role) }}</span>
            <p v-if="card.memoryTag" class="text-xs text-base-content/60 mt-1">记忆：{{ card.memoryTag }}</p>
            <p v-if="card.coreConflict" class="text-xs text-base-content/60">矛盾：{{ card.coreConflict }}</p>
            </div>
          </div>
          <div class="flex gap-1 shrink-0">
            <button type="button" class="btn btn-ghost btn-xs" @click.stop="startEdit(idx)">编辑</button>
            <button type="button" class="btn btn-ghost btn-xs text-error" @click.stop="removeCard(idx)">删除</button>
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
          <div
            v-if="draftNameDuplicate || draftMissingRequired.length > 0"
            class="alert alert-warning text-xs py-2"
          >
            <div v-if="draftNameDuplicate">角色名重复，请修改为唯一名称。</div>
            <div v-if="draftMissingRequired.length > 0">
              必填未完成：{{ draftMissingRequired.join('、') }}
            </div>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="space-y-2">
              <div class="flex gap-2">
                <input v-model="draft.name" placeholder="角色名 *" class="input input-bordered input-sm flex-1" />
                <button type="button" class="btn btn-outline btn-primary btn-xs shrink-0" @click="showNamePicker = true">
                  名称库
                </button>
              </div>
              <NameSimilarityHint :work-id="workId" :name="draft.name" />
            </div>
            <select v-if="!protagonistOnly" v-model="draft.role" class="select select-bordered select-sm">
              <option v-for="r in ROLE_OPTIONS" :key="r.value" :value="r.value">{{ r.label }}</option>
            </select>
            <div v-else class="flex items-center text-xs text-base-content/50 px-1">
              <font-awesome-icon icon="crown" class="w-3 h-3 mr-1.5 text-primary" />
              主角卡片
            </div>
          </div>
          <input v-model="draft.memoryTag" placeholder="记忆标签 *（刀疤/口头禅/配饰）" class="input input-bordered input-sm w-full" />
          <input v-model="draft.coreConflict" placeholder="核心矛盾 *（价值观/行为/认知）" class="input input-bordered input-sm w-full" />
          <div class="grid grid-cols-1 md:grid-cols-3 gap-2">
            <input v-model="draft.reactions!.instinct" placeholder="本能反应" class="input input-bordered input-xs" />
            <input v-model="draft.reactions!.rational" placeholder="理性反应" class="input input-bordered input-xs" />
            <input v-model="draft.reactions!.hidden" placeholder="隐藏反应" class="input input-bordered input-xs" />
          </div>
          <input v-model="draft.speechStyle" placeholder="语言风格" class="input input-bordered input-sm w-full" />
          <input v-model="draft.relationBinding" placeholder="关系绑定 *（利益/信息差/情感负债）" class="input input-bordered input-sm w-full" />
          <input
            :value="draft.growthTriggers?.join('；')"
            placeholder="成长触发点（分号分隔）"
            class="input input-bordered input-sm w-full"
            @input="(e: Event) => { draft!.growthTriggers = (e.target as HTMLInputElement).value.split(/[；;]/).map(s => s.trim()) }"
          />
        </div>

        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" @click="cancelEdit">取消</button>
          <button type="button" class="btn btn-primary btn-sm" :disabled="!canSaveDraft" @click="saveDraft">
            保存
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop bg-black/40" @click="cancelEdit">
        <button type="button">close</button>
      </form>
    </dialog>

    <NamePickerDialog
      :work-id="workId"
      :open="showNamePicker"
      category="character"
      title="选取角色名"
      @close="showNamePicker = false"
      @select="onNamePicked"
    />

    <dialog :class="['modal', { 'modal-open': genHintsDialogOpen }]">
      <div class="modal-box max-w-lg">
        <h3 class="font-bold text-lg mb-1">结构化人设卡片 · AI 生成</h3>
        <p class="text-sm text-base-content/50 mb-4">
          可填写本次生成的补充要求（如角色姓名、关系、记忆标签侧重）。留空则依据故事方向与核心设定生成。
        </p>
        <div class="flex justify-end mb-2">
          <button type="button" class="btn btn-outline btn-primary btn-xs" @click="namePickerForHintsOpen = true">
            从名称库插入
          </button>
        </div>
        <textarea
          ref="genHintsInputRef"
          v-model="genHints"
          rows="4"
          class="textarea textarea-bordered w-full text-sm leading-relaxed"
          placeholder="例如：必须包含秦昊（主角）和苏棠（配角）；秦昊记忆标签强调前世执念…"
          @keydown.ctrl.enter.prevent="confirmAiGenerate"
          @keydown.meta.enter.prevent="confirmAiGenerate"
        />
        <p class="text-xs text-base-content/40 mt-2">
          补充说明会注入 prompt，并记住以便下次生成；不会直接写入卡片列表。⌘/Ctrl + Enter 开始生成。
        </p>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost" @click="closeGenHintsDialog">取消</button>
          <button
            type="button"
            class="btn btn-primary gap-1"
            :disabled="aiLoading"
            @click="confirmAiGenerate"
          >
            <font-awesome-icon v-if="aiLoading" icon="spinner" spin class="w-3.5 h-3.5" />
            {{ aiLoading ? '生成中...' : '开始生成' }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop bg-black/40" @click="closeGenHintsDialog">
        <button type="button">close</button>
      </form>
    </dialog>

    <NamePickerDialog
      :work-id="workId"
      :open="namePickerForHintsOpen"
      category="character"
      title="插入角色名到补充说明"
      @close="namePickerForHintsOpen = false"
      @select="insertNameHintForGen"
    />
  </div>
</template>
