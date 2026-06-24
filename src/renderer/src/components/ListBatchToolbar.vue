<script setup lang="ts">
defineProps<{
  total: number
  selectableCount: number
  selectedCount: number
  allSelected: boolean
  itemLabel?: string
}>()

const emit = defineEmits<{
  toggleAll: []
  deleteSelected: []
  deleteAll: []
}>()
</script>

<template>
  <div
    v-if="total > 0"
    class="flex flex-wrap items-center gap-x-3 gap-y-2 mb-3 px-3 py-2 rounded-lg border border-base-300 bg-base-200 shadow-sm sticky top-0 z-10"
  >
    <label class="label cursor-pointer gap-2 py-0 min-h-0">
      <input
        type="checkbox"
        class="checkbox checkbox-sm"
        :checked="allSelected"
        @change="emit('toggleAll')"
      />
      <span class="label-text text-sm font-medium">全选</span>
    </label>
    <span class="text-xs text-base-content/55">
      已选 <span class="font-semibold text-base-content">{{ selectedCount }}</span> / {{ selectableCount }}
    </span>
    <div class="flex gap-2 ml-auto">
      <button
        type="button"
        class="btn btn-outline btn-error btn-xs"
        :disabled="selectedCount === 0"
        @click="emit('deleteSelected')"
      >
        删除选中
      </button>
      <button type="button" class="btn btn-error btn-xs" @click="emit('deleteAll')">
        全部删除
      </button>
    </div>
  </div>
</template>
