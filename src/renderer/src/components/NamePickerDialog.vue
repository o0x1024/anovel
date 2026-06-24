<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import {
  NAME_CATEGORY_LABELS,
  type NameCategory,
  type NameEntryRow
} from '../../../shared/name-registry-types'

const props = defineProps<{
  workId: number
  open: boolean
  category?: NameCategory
  title?: string
}>()

const emit = defineEmits<{
  close: []
  select: [entry: NameEntryRow]
}>()

const entries = ref<NameEntryRow[]>([])
const loading = ref(false)
const statusFilter = ref<'usable' | 'all'>('usable')

watch(
  () => [props.open, props.workId, props.category] as const,
  ([isOpen]) => {
    if (isOpen) void load()
  }
)

async function load() {
  loading.value = true
  try {
    const list = await window.anovel.invoke('name:list', props.workId) as NameEntryRow[]
    entries.value = props.category
      ? list.filter(e => e.category === props.category)
      : list
  } finally {
    loading.value = false
  }
}

const visibleEntries = computed(() => {
  if (statusFilter.value === 'all') return entries.value
  return entries.value.filter(e => e.status === 'adopted' || e.status === 'candidate')
})

function pick(entry: NameEntryRow) {
  emit('select', entry)
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <dialog v-if="open" :class="['modal', { 'modal-open': open }]">
      <div class="modal-box max-w-lg">
        <h3 class="font-bold text-lg mb-1">
          {{ title ?? '从名称库选取' }}
        </h3>
        <p v-if="category" class="text-xs text-base-content/50 mb-3">
          分类：{{ NAME_CATEGORY_LABELS[category] }}
        </p>

        <div class="flex items-center gap-2 mb-3">
          <select v-model="statusFilter" class="select select-bordered select-xs">
            <option value="usable">候选 + 已采纳</option>
            <option value="all">含已废弃</option>
          </select>
          <span class="text-xs text-base-content/40 ml-auto">{{ visibleEntries.length }} 条</span>
        </div>

        <div v-if="loading" class="text-sm text-base-content/50 py-6 text-center">加载中…</div>
        <div v-else class="max-h-72 overflow-y-auto space-y-2">
          <button
            v-for="entry in visibleEntries"
            :key="entry.id"
            type="button"
            class="w-full text-left border border-base-300/60 rounded-lg p-3 hover:bg-base-200/60 transition-colors"
            @click="pick(entry)"
          >
            <div class="flex items-center gap-2">
              <span class="font-semibold text-sm">{{ entry.name }}</span>
              <span class="badge badge-xs badge-outline">{{ NAME_CATEGORY_LABELS[entry.category] }}</span>
              <span v-if="entry.status === 'adopted'" class="badge badge-xs badge-success">已采纳</span>
            </div>
            <p v-if="entry.meaning" class="text-xs text-base-content/55 mt-1">{{ entry.meaning }}</p>
          </button>
          <p v-if="!visibleEntries.length" class="text-sm text-base-content/50 text-center py-6">
            名称库中暂无可用名称，请先在「名称库」面板生成
          </p>
        </div>

        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" @click="emit('close')">取消</button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop" @click="emit('close')">
        <button type="button">close</button>
      </form>
    </dialog>
  </Teleport>
</template>
