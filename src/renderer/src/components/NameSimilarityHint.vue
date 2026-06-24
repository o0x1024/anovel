<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import type { NameSimilarityMatch } from '../../../shared/name-registry-types'

const props = defineProps<{
  workId: number
  name: string
  excludeId?: number
}>()

const warnings = ref<NameSimilarityMatch[]>([])
let timer: ReturnType<typeof setTimeout> | null = null
let disposed = false

watch(
  () => [props.workId, props.name, props.excludeId] as const,
  () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void check(), 300)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  disposed = true
  if (timer) clearTimeout(timer)
})

async function check() {
  const trimmed = props.name.trim()
  if (!trimmed || trimmed.length < 2) {
    warnings.value = []
    return
  }
  const result = await window.anovel.invoke(
    'name:similarityCheck',
    props.workId,
    trimmed,
    props.excludeId
  ) as NameSimilarityMatch[]
  if (!disposed) {
    warnings.value = result
  }
}
</script>

<template>
  <div v-if="warnings.length" class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-content/90">
    <p class="font-medium text-warning mb-1">易混淆提醒</p>
    <ul class="space-y-0.5 list-disc list-inside text-base-content/70">
      <li v-for="(w, i) in warnings" :key="`${w.name}-${i}`">{{ w.message }}</li>
    </ul>
  </div>
</template>
