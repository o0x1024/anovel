<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'
import NameSimilarityHint from '../../components/NameSimilarityHint.vue'
import ListBatchToolbar from '../../components/ListBatchToolbar.vue'
import {
  useListSelection,
  confirmBatchDelete,
  confirmDeleteAll,
  runBatchDelete
} from '../../composables/useListSelection'
import {
  NAME_CATEGORIES,
  NAME_CATEGORY_LABELS,
  NAME_STATUS_LABELS,
  type NameCategory,
  type NameEntryRow,
  type NameEntryStatus,
  type UsedNamesSummary
} from '../../../../shared/name-registry-types'
import { useBodyGenerationModel } from '../../composables/useBodyGenerationModel'

const props = defineProps<{ workId: number }>()
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)

const entries = ref<NameEntryRow[]>([])
const usedNames = ref<UsedNamesSummary | null>(null)
const activeCategory = ref<NameCategory>('character')
const statusFilter = ref<'all' | NameEntryStatus>('all')
const generating = ref(false)
const errorMessage = ref('')
const successMessage = ref('')
const showManualAdd = ref(false)
const manualName = ref('')
const manualMeaning = ref('')

const genForm = ref({
  style: '',
  count: 8,
  gender: '',
  extra: ''
})

const filtered = computed(() => {
  let list = entries.value.filter(e => e.category === activeCategory.value)
  if (statusFilter.value !== 'all') {
    list = list.filter(e => e.status === statusFilter.value)
  }
  return list
})

const adoptedCount = computed(() =>
  entries.value.filter(e => e.status === 'adopted').length
)

const selection = useListSelection(filtered)

onMounted(load)

async function load() {
  errorMessage.value = ''
  const [list, used] = await Promise.all([
    window.anovel.invoke('name:list', props.workId) as Promise<NameEntryRow[]>,
    window.anovel.invoke('name:usedNames', props.workId) as Promise<UsedNamesSummary>
  ])
  entries.value = list
  usedNames.value = used
  selection.clearSelection()
}

async function generate() {
  generating.value = true
  errorMessage.value = ''
  try {
    const res = await window.anovel.invoke('name:generate', {
      workId: props.workId,
      category: activeCategory.value,
      constraints: {
        style: genForm.value.style.trim() || undefined,
        count: genForm.value.count,
        gender: genForm.value.gender.trim() || undefined,
        extra: genForm.value.extra.trim() || undefined
      },
      ...bodyModelParams()
    }) as { success: boolean; error?: string; conflicts?: string[] }

    if (!res.success) {
      errorMessage.value = res.error || '生成失败'
      return
    }
    if (res.conflicts?.length) {
      errorMessage.value = `已过滤与已有名称冲突的候选：${res.conflicts.join('、')}`
    }
    await load()
  } catch (e) {
    errorMessage.value = e instanceof Error ? e.message : '生成失败'
  } finally {
    generating.value = false
  }
}

async function adopt(entry: NameEntryRow) {
  const res = await window.anovel.invoke('name:adopt', props.workId, entry.id) as { success: boolean; error?: string }
  if (!res.success) {
    errorMessage.value = res.error || '采纳失败'
    return
  }
  await load()
}

async function reject(entry: NameEntryRow) {
  await window.anovel.invoke('name:reject', props.workId, entry.id)
  await load()
}

async function adoptToCharacterCard(entry: NameEntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  const res = await window.anovel.invoke(
    'name:adoptToCharacterCard',
    props.workId,
    entry.id,
    'supporting'
  ) as { success: boolean; error?: string }
  if (!res.success) {
    errorMessage.value = res.error || '写入人设卡片失败'
    return
  }
  successMessage.value = `「${entry.name}」已写入核心设定 → 结构化人设卡片（配角），请前往核心设定页查看`
  await load()
}

async function removeEntry(entry: NameEntryRow, skipConfirm = false) {
  if (!skipConfirm && !confirm(`删除名称「${entry.name}」？`)) return
  await window.anovel.invoke('name:delete', entry.id)
}

async function deleteSelectedEntries() {
  const items = selection.getSelectedItems()
  if (!(await confirmBatchDelete(items.length, '名称'))) return
  await runBatchDelete(items, item => removeEntry(item, true))
  await load()
}

async function deleteAllFiltered() {
  if (!(await confirmDeleteAll(filtered.value.length, `${NAME_CATEGORY_LABELS[activeCategory.value]}名称`))) return
  await runBatchDelete(filtered.value, item => removeEntry(item, true))
  await load()
}

async function addManual() {
  const name = manualName.value.trim()
  if (!name) return
  const res = await window.anovel.invoke('name:create', {
    work_id: props.workId,
    category: activeCategory.value,
    name,
    meaning: manualMeaning.value.trim() || undefined,
    status: 'candidate',
    source: 'manual'
  }) as { success: boolean; error?: string }
  if (!res.success) {
    errorMessage.value = res.error || '添加失败'
    return
  }
  manualName.value = ''
  manualMeaning.value = ''
  showManualAdd.value = false
  await load()
}

function copyName(name: string) {
  void navigator.clipboard.writeText(name)
}

function statusBadgeClass(status: NameEntryStatus): string {
  if (status === 'adopted') return 'badge-success'
  if (status === 'rejected') return 'badge-ghost'
  return 'badge-outline'
}
</script>

<template>
  <div>
    <PanelTitle
      title="名称库"
      :subtitle="`管理角色、技能、地点等名称 · 已采纳 ${adoptedCount} 个`"
    />

    <div role="tablist" class="tabs tabs-box tabs-sm w-fit mb-4">
      <a
        v-for="cat in NAME_CATEGORIES"
        :key="cat"
        role="tab"
        href="#"
        class="tab"
        :class="{ 'tab-active': activeCategory === cat }"
        @click.prevent="activeCategory = cat"
      >
        {{ NAME_CATEGORY_LABELS[cat] }}
      </a>
    </div>

    <div class="card bg-base-200/40 border border-base-300/50 mb-4">
      <div class="card-body p-4 gap-3">
        <h3 class="text-xs font-semibold text-base-content/70">AI 生成</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
          <input
            v-model="genForm.style"
            class="input input-bordered input-xs"
            placeholder="风格（如：古风、赛博朋克、日式轻小说）"
          />
          <input
            v-if="activeCategory === 'character'"
            v-model="genForm.gender"
            class="input input-bordered input-xs"
            placeholder="性别倾向（可选）"
          />
          <label class="flex items-center gap-2 text-xs">
            <span class="text-base-content/50 shrink-0">数量</span>
            <input v-model.number="genForm.count" type="number" min="3" max="15" class="input input-bordered input-xs w-20" />
          </label>
        </div>
        <textarea
          v-model="genForm.extra"
          rows="2"
          class="textarea textarea-bordered textarea-xs w-full"
          placeholder="额外要求（如：姓氏偏冷门、技能名带「诀」字）"
        />
        <div class="flex flex-wrap gap-2">
          <button
            type="button"
            class="btn btn-primary btn-xs"
            :disabled="generating"
            @click="generate"
          >
            {{ generating ? '生成中…' : `生成${NAME_CATEGORY_LABELS[activeCategory]}名` }}
          </button>
          <button type="button" class="btn btn-ghost btn-xs" @click="showManualAdd = true">手动添加</button>
        </div>
      </div>
    </div>

    <p v-if="successMessage" class="text-xs text-success mb-3">{{ successMessage }}</p>
    <p v-if="errorMessage" class="text-xs text-warning mb-3">{{ errorMessage }}</p>

    <div v-if="usedNames?.all.length" class="text-[11px] text-base-content/45 mb-3 leading-relaxed">
      已用名称（去重参考）：{{ usedNames.all.slice(0, 24).join('、') }}
      <span v-if="usedNames.all.length > 24">…等 {{ usedNames.all.length }} 个</span>
    </div>

    <div class="flex flex-wrap gap-2 mb-3 items-center">
      <select v-model="statusFilter" class="select select-bordered select-xs">
        <option value="all">全部状态</option>
        <option v-for="(label, key) in NAME_STATUS_LABELS" :key="key" :value="key">{{ label }}</option>
      </select>
      <span class="text-xs text-base-content/40">{{ filtered.length }} 条</span>
    </div>

    <ListBatchToolbar
      :total="filtered.length"
      :selectable-count="selection.selectableCount"
      :selected-count="selection.selectedCount"
      :all-selected="selection.allSelected"
      @toggle-all="selection.toggleAll()"
      @delete-selected="deleteSelectedEntries"
      @delete-all="deleteAllFiltered"
    />

    <div class="grid gap-2">
      <div
        v-for="(entry, index) in filtered"
        :key="entry.id"
        class="card bg-base-100 border border-base-300/60"
        :class="{ 'ring-1 ring-primary/40': selection.isSelected(entry, index) }"
      >
        <div class="card-body p-3 gap-2">
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-start gap-2 min-w-0">
              <input
                type="checkbox"
                class="checkbox checkbox-xs mt-0.5 shrink-0"
                :checked="selection.isSelected(entry, index)"
                @change="selection.toggle(entry, index)"
              />
              <div class="min-w-0">
                <span class="font-semibold text-sm mr-2">{{ entry.name }}</span>
                <span class="badge badge-xs" :class="statusBadgeClass(entry.status)">
                  {{ NAME_STATUS_LABELS[entry.status] }}
                </span>
                <span v-if="entry.source === 'ai'" class="badge badge-ghost badge-xs ml-1">AI</span>
              </div>
            </div>
            <div class="flex gap-1 shrink-0 flex-wrap justify-end">
              <button type="button" class="btn btn-ghost btn-xs" @click="copyName(entry.name)">复制</button>
              <button
                v-if="entry.status !== 'adopted'"
                type="button"
                class="btn btn-ghost btn-xs text-success"
                @click="adopt(entry)"
              >
                采纳
              </button>
              <button
                v-if="activeCategory === 'character' && entry.status !== 'rejected'"
                type="button"
                class="btn btn-ghost btn-xs text-primary"
                title="写入核心设定页的「结构化人设卡片」，不会写入上方 Markdown 人设正文"
                @click="adoptToCharacterCard(entry)"
              >
                写入人设卡片
              </button>
              <button
                v-if="entry.status === 'candidate'"
                type="button"
                class="btn btn-ghost btn-xs"
                @click="reject(entry)"
              >
                废弃
              </button>
              <button type="button" class="btn btn-ghost btn-xs text-error" @click="removeEntry(entry).then(load)">删除</button>
            </div>
          </div>
          <p v-if="entry.meaning" class="text-xs text-base-content/60">{{ entry.meaning }}</p>
          <p v-if="entry.linked_entity" class="text-[11px] text-base-content/40">
            已关联：{{ entry.linked_entity }}
          </p>
        </div>
      </div>
      <p v-if="!filtered.length" class="text-sm text-base-content/50 text-center py-8">
        暂无{{ NAME_CATEGORY_LABELS[activeCategory] }}名称，点击上方生成或手动添加
      </p>
    </div>

    <dialog :class="['modal', { 'modal-open': showManualAdd }]">
      <div class="modal-box max-w-md">
        <h3 class="font-bold mb-4">手动添加{{ NAME_CATEGORY_LABELS[activeCategory] }}名</h3>
        <div class="space-y-3">
          <input v-model="manualName" class="input input-bordered input-sm w-full" placeholder="名称 *" />
          <NameSimilarityHint :work-id="workId" :name="manualName" />
          <input v-model="manualMeaning" class="input input-bordered input-sm w-full" placeholder="寓意说明（可选）" />
        </div>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" @click="showManualAdd = false">取消</button>
          <button type="button" class="btn btn-primary btn-sm" @click="addManual">保存</button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop" @click="showManualAdd = false"><button type="button">close</button></form>
    </dialog>
  </div>
</template>
