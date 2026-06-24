<script setup lang="ts">
import { ref, onMounted } from 'vue'
import ListBatchToolbar from '../../../components/ListBatchToolbar.vue'
import {
  useListSelection,
  confirmBatchDelete,
  confirmDeleteAll,
  runBatchDelete
} from '../../../composables/useListSelection'

const props = defineProps<{ workId: number }>()

interface Foreshadowing {
  id: number
  description: string
  plant_chapter_id: number | null
  plant_location: string | null
  payoff_chapter_id: number | null
  status: string
  depth: string | null
}

interface ChapterOption {
  id: number
  title: string
}

const items = ref<Foreshadowing[]>([])
const chapters = ref<ChapterOption[]>([])
const showForm = ref(false)
const newItem = ref({ description: '', plant_chapter_id: null as number | null, plant_location: '', depth: 'normal' })
const resolvingId = ref<number | null>(null)
const resolveChapterId = ref<number | null>(null)

const selection = useListSelection(items)

const depthLabels: Record<string, string> = { shallow: '浅', normal: '普通', deep: '深' }
const statusLabels: Record<string, string> = {
  pending: '待回收',
  partial: '部分回收',
  resolved: '已回收',
  abandoned: '已放弃'
}

onMounted(async () => {
  await Promise.all([loadItems(), loadChapters()])
})

async function loadItems() {
  items.value = await window.anovel.invoke('foreshadowing:listByWork', props.workId) as Foreshadowing[]
  selection.clearSelection()
}

async function loadChapters() {
  chapters.value = await window.anovel.invoke('chapter:listByWork', props.workId) as ChapterOption[]
}

async function createItem() {
  if (!newItem.value.description.trim()) return
  await window.anovel.invoke('foreshadowing:create', {
    work_id: props.workId,
    description: newItem.value.description.trim(),
    plant_chapter_id: newItem.value.plant_chapter_id,
    plant_location: newItem.value.plant_location || undefined,
    depth: newItem.value.depth
  })
  newItem.value = { description: '', plant_chapter_id: null, plant_location: '', depth: 'normal' }
  showForm.value = false
  await loadItems()
}

async function deleteItem(id: number, skipConfirm = false) {
  if (!skipConfirm && !confirm('删除此伏笔？')) return
  await window.anovel.invoke('foreshadowing:delete', id)
}

async function deleteSelectedItems() {
  const selected = selection.getSelectedItems()
  if (!(await confirmBatchDelete(selected.length, '伏笔'))) return
  await runBatchDelete(selected, item => deleteItem(item.id, true))
  await loadItems()
}

async function deleteAllItems() {
  if (!(await confirmDeleteAll(items.value.length, '伏笔'))) return
  await runBatchDelete(items.value, item => deleteItem(item.id, true))
  await loadItems()
}

async function markAbandoned(id: number) {
  await window.anovel.invoke('foreshadowing:updateStatus', id, 'abandoned')
  await loadItems()
}

function startResolve(id: number) {
  resolvingId.value = id
  resolveChapterId.value = chapters.value[0]?.id ?? null
}

async function confirmResolve() {
  if (!resolvingId.value || !resolveChapterId.value) return
  await window.anovel.invoke('foreshadowing:resolve', resolvingId.value, resolveChapterId.value)
  resolvingId.value = null
  await loadItems()
}

function chapterTitle(id: number | null) {
  if (!id) return '—'
  return chapters.value.find(c => c.id === id)?.title ?? `#${id}`
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <p class="text-sm text-base-content/50">追踪伏笔埋设与回收，生成正文时自动注入待回收列表。</p>
      <button class="btn btn-primary btn-sm shrink-0" @click="showForm = !showForm">
        {{ showForm ? '取消' : '添加伏笔' }}
      </button>
    </div>

    <ListBatchToolbar
      v-if="items.length > 0"
      :total="items.length"
      :selectable-count="selection.selectableCount"
      :selected-count="selection.selectedCount"
      :all-selected="selection.allSelected"
      @toggle-all="selection.toggleAll()"
      @delete-selected="deleteSelectedItems"
      @delete-all="deleteAllItems"
    />

    <div v-if="showForm" class="card bg-base-100 border border-base-300 p-4 space-y-2">
      <textarea v-model="newItem.description" rows="2" class="textarea textarea-bordered w-full textarea-sm" placeholder="伏笔描述..." />
      <div class="flex flex-wrap gap-2">
        <select v-model="newItem.depth" class="select select-bordered select-sm">
          <option value="shallow">浅伏笔</option>
          <option value="normal">普通</option>
          <option value="deep">深伏笔</option>
        </select>
        <select v-model="newItem.plant_chapter_id" class="select select-bordered select-sm flex-1 min-w-[140px]">
          <option :value="null">埋设章节（可选）</option>
          <option v-for="ch in chapters" :key="ch.id" :value="ch.id">{{ ch.title }}</option>
        </select>
        <input v-model="newItem.plant_location" class="input input-bordered input-sm flex-1" placeholder="埋设位置（可选）" />
      </div>
      <button class="btn btn-primary btn-sm" :disabled="!newItem.description.trim()" @click="createItem">保存</button>
    </div>

    <div v-if="items.length === 0" class="text-center py-8 text-base-content/40 text-sm">暂无伏笔记录</div>
    <div v-else class="space-y-2">
      <div
        v-for="(item, index) in items"
        :key="item.id"
        class="card bg-base-100 border border-base-300 p-3"
        :class="{ 'ring-2 ring-primary/50': selection.isSelected(item, index) }"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-start gap-2 flex-1 min-w-0">
            <input
              type="checkbox"
              class="checkbox checkbox-sm mt-0.5 shrink-0"
              :checked="selection.isSelected(item, index)"
              @change="selection.toggle(item, index)"
            />
            <div class="flex-1">
            <div class="flex flex-wrap gap-1 mb-1">
              <span class="badge badge-sm" :class="item.status === 'resolved' ? 'badge-success' : 'badge-warning'">
                {{ statusLabels[item.status] || item.status }}
              </span>
              <span class="badge badge-ghost badge-sm">{{ depthLabels[item.depth || 'normal'] || '普通' }}</span>
            </div>
            <p class="text-sm">{{ item.description }}</p>
            <p class="text-xs text-base-content/40 mt-1">
              埋设：{{ chapterTitle(item.plant_chapter_id) }}
              <span v-if="item.payoff_chapter_id"> · 回收：{{ chapterTitle(item.payoff_chapter_id) }}</span>
            </p>
            </div>
          </div>
          <div class="flex gap-1 shrink-0">
            <button
              v-if="item.status !== 'resolved'"
              class="btn btn-outline btn-primary btn-xs"
              @click="startResolve(item.id)"
            >
              标记回收
            </button>
            <button
              v-if="item.status !== 'resolved' && item.status !== 'abandoned'"
              class="btn btn-ghost btn-xs"
              @click="markAbandoned(item.id)"
            >
              放弃
            </button>
            <button class="btn btn-ghost btn-xs text-error" @click="deleteItem(item.id).then(loadItems)">删除</button>
          </div>
        </div>
        <div v-if="resolvingId === item.id" class="mt-2 pt-2 border-t border-base-300 flex gap-2 items-center">
          <select v-model="resolveChapterId" class="select select-bordered select-xs flex-1">
            <option v-for="ch in chapters" :key="ch.id" :value="ch.id">{{ ch.title }}</option>
          </select>
          <button class="btn btn-primary btn-xs" @click="confirmResolve">确认</button>
          <button class="btn btn-ghost btn-xs" @click="resolvingId = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>
