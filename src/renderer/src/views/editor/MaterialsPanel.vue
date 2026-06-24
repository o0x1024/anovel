<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'
import ListBatchToolbar from '../../components/ListBatchToolbar.vue'
import {
  useListSelection,
  confirmBatchDelete,
  confirmDeleteAll,
  runBatchDelete
} from '../../composables/useListSelection'

const props = defineProps<{ workId: number }>()

interface Material {
  id: number
  work_id: number | null
  category: string
  title: string | null
  content: string
}

const CATEGORY_LABELS: Record<string, string> = {
  character: '人设',
  scene: '场景',
  dialogue: '对话',
  plot: '桥段'
}

const materials = ref<Material[]>([])
const filter = ref<string>('all')
const showAdd = ref(false)
const newItem = ref({ category: 'character', title: '', content: '' })
const scopeWorkOnly = ref(false)

const filtered = computed(() => {
  const list = scopeWorkOnly.value
    ? materials.value.filter(m => m.work_id === props.workId)
    : materials.value
  if (filter.value === 'all') return list
  return list.filter(m => m.category === filter.value)
})

const selection = useListSelection(filtered, {
  canSelect: (item) => item.work_id != null
})

onMounted(load)

async function load() {
  materials.value = await window.anovel.invoke('material:listByWork', props.workId) as Material[]
  selection.clearSelection()
}

async function addMaterial() {
  if (!newItem.value.content.trim()) return
  await window.anovel.invoke('material:create', {
    work_id: props.workId,
    category: newItem.value.category,
    title: newItem.value.title.trim() || undefined,
    content: newItem.value.content.trim()
  })
  newItem.value = { category: 'character', title: '', content: '' }
  showAdd.value = false
  await load()
}

async function removeMaterial(id: number, skipConfirm = false) {
  if (!skipConfirm && !confirm('确定删除此素材？')) return
  await window.anovel.invoke('material:delete', id)
}

async function deleteSelectedMaterials() {
  const items = selection.getSelectedItems()
  if (!(await confirmBatchDelete(items.length, '素材'))) return
  await runBatchDelete(items, item => removeMaterial(item.id))
  await load()
}

async function deleteAllMaterials() {
  const items = filtered.value.filter(m => m.work_id != null)
  if (!(await confirmDeleteAll(items.length, '可删除素材'))) return
  await runBatchDelete(items, item => removeMaterial(item.id))
  await load()
}

function copyContent(content: string) {
  void navigator.clipboard.writeText(content)
}
</script>

<template>
  <div>
    <PanelTitle title="素材库" subtitle="人设、场景、对话与桥段预设模板" />

    <div class="flex flex-wrap gap-2 mb-4 items-center">
      <select v-model="filter" class="select select-bordered select-xs">
        <option value="all">全部分类</option>
        <option v-for="(label, key) in CATEGORY_LABELS" :key="key" :value="key">{{ label }}</option>
      </select>
      <label class="label cursor-pointer gap-2 py-0">
        <input v-model="scopeWorkOnly" type="checkbox" class="checkbox checkbox-xs" />
        <span class="label-text text-xs">仅本作品</span>
      </label>
      <button type="button" class="btn btn-primary btn-xs ml-auto" @click="showAdd = true">添加素材</button>
    </div>

    <ListBatchToolbar
      :total="filtered.length"
      :selectable-count="selection.selectableCount"
      :selected-count="selection.selectedCount"
      :all-selected="selection.allSelected"
      @toggle-all="selection.toggleAll()"
      @delete-selected="deleteSelectedMaterials"
      @delete-all="deleteAllMaterials"
    />

    <div class="grid gap-3">
      <div
        v-for="(item, index) in filtered"
        :key="item.id"
        class="card bg-base-100 border border-base-300/60"
        :class="{ 'ring-1 ring-primary/40': selection.isSelected(item, index) }"
      >
        <div class="card-body p-4">
          <div class="flex items-start justify-between gap-2 mb-2">
            <div class="flex items-start gap-2 min-w-0">
              <input
                v-if="item.work_id"
                type="checkbox"
                class="checkbox checkbox-xs mt-0.5 shrink-0"
                :checked="selection.isSelected(item, index)"
                @change="selection.toggle(item, index)"
              />
              <div class="min-w-0">
                <span class="badge badge-outline badge-xs mr-2">{{ CATEGORY_LABELS[item.category] ?? item.category }}</span>
                <span class="font-semibold text-sm">{{ item.title || '未命名' }}</span>
                <span v-if="!item.work_id" class="badge badge-ghost badge-xs ml-2">内置</span>
              </div>
            </div>
            <div class="flex gap-1 shrink-0">
              <button type="button" class="btn btn-ghost btn-xs" @click="copyContent(item.content)">复制</button>
              <button
                v-if="item.work_id"
                type="button"
                class="btn btn-ghost btn-xs text-error"
                @click="removeMaterial(item.id).then(() => load())"
              >
                删除
              </button>
            </div>
          </div>
          <pre class="text-xs whitespace-pre-wrap text-base-content/70 leading-relaxed">{{ item.content }}</pre>
        </div>
      </div>
      <p v-if="!filtered.length" class="text-sm text-base-content/50 text-center py-8">暂无素材</p>
    </div>

    <dialog :class="['modal', { 'modal-open': showAdd }]">
      <div class="modal-box max-w-lg">
        <h3 class="font-bold mb-4">添加素材</h3>
        <div class="space-y-3">
          <select v-model="newItem.category" class="select select-bordered select-sm w-full">
            <option v-for="(label, key) in CATEGORY_LABELS" :key="key" :value="key">{{ label }}</option>
          </select>
          <input v-model="newItem.title" placeholder="标题（可选）" class="input input-bordered input-sm w-full" />
          <textarea v-model="newItem.content" rows="8" placeholder="素材内容..." class="textarea textarea-bordered w-full text-sm" />
        </div>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" @click="showAdd = false">取消</button>
          <button type="button" class="btn btn-primary btn-sm" @click="addMaterial">保存</button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop" @click="showAdd = false"><button type="button">close</button></form>
    </dialog>
  </div>
</template>
