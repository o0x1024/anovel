<script setup lang="ts">
import type { LabTaskRow } from '../../../../shared/lab-types'

const props = defineProps<{
  open: boolean
  loading: boolean
  items: LabTaskRow[]
  styleNameById: Map<number, string>
}>()

const emit = defineEmits<{
  close: []
  select: [taskId: number]
  delete: [taskId: number]
}>()

function statusLabel(value: string): string {
  if (value === 'running') return '处理中'
  if (value === 'done') return '完成'
  if (value === 'error') return '失败'
  return '待处理'
}

function formatDate(dateStr: string): string {
  return new Date(`${dateStr}Z`).toLocaleString('zh-CN')
}

function writingStyleLabel(styleId: number | null): string {
  if (styleId == null) return '无文风'
  return props.styleNameById.get(styleId) ?? `文风#${styleId}`
}
</script>

<template>
  <div v-if="props.open" class="fixed inset-0 z-50">
    <button type="button" class="absolute inset-0 bg-black/30" @click="emit('close')" />
    <aside class="absolute right-0 top-0 h-full w-[420px] max-w-[90vw] bg-base-100 border-l border-base-300 shadow-xl flex flex-col">
      <header class="h-14 px-4 border-b border-base-300 flex items-center justify-between">
        <h2 class="font-semibold">历史记录</h2>
        <button type="button" class="btn btn-ghost btn-sm" @click="emit('close')">关闭</button>
      </header>

      <div v-if="props.loading" class="flex-1 grid place-items-center">
        <span class="loading loading-spinner loading-md" />
      </div>

      <div v-else-if="props.items.length === 0" class="flex-1 grid place-items-center text-sm text-base-content/45">
        暂无历史记录
      </div>

      <ul v-else class="flex-1 overflow-auto p-3 space-y-2">
        <li v-for="item in props.items" :key="item.id" class="border border-base-300 rounded-lg p-3 bg-base-200/20">
          <div class="text-xs text-base-content/45">{{ formatDate(item.create_time) }}</div>
          <p class="text-sm mt-1 line-clamp-2">{{ item.original_text }}</p>
          <div class="mt-2 flex items-center gap-2 flex-wrap">
            <span class="badge badge-primary badge-sm badge-outline">{{ writingStyleLabel(item.style_id) }}</span>
            <span class="badge badge-outline badge-sm">{{ statusLabel(item.status) }}</span>
          </div>
          <div class="mt-3 flex justify-end gap-2">
            <button type="button" class="btn btn-ghost btn-xs" @click="emit('select', item.id)">
              加载
            </button>
            <button type="button" class="btn btn-ghost btn-xs text-error" @click="emit('delete', item.id)">
              删除
            </button>
          </div>
        </li>
      </ul>
    </aside>
  </div>
</template>
