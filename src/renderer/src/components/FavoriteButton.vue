<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  workId: number
  sourceStep: string
  sourceLabel: string
  content: string
  sourceInput?: string
  size?: 'xs' | 'sm'
}>()

const saving = ref(false)
const saved = ref(false)

async function saveFavorite() {
  if (!props.content.trim() || saving.value) return
  saving.value = true
  try {
    await window.anovel.invoke('favorite:create', {
      work_id: props.workId,
      source_step: props.sourceStep,
      source_label: props.sourceLabel,
      content: props.content.trim(),
      source_input: props.sourceInput?.trim() || undefined
    })
    saved.value = true
    setTimeout(() => { saved.value = false }, 2000)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <button
    type="button"
    :class="['btn gap-1', size === 'xs' ? 'btn-xs btn-ghost' : 'btn-sm btn-outline btn-neutral', saved ? 'text-success' : '']"
    :disabled="!content.trim() || saving"
    @click="saveFavorite"
  >
    <font-awesome-icon :icon="saved ? 'check' : 'bookmark'" class="w-3 h-3" />
    {{ saved ? '已收藏' : saving ? '收藏中...' : '收藏' }}
  </button>
</template>
