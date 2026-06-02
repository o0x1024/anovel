<script setup lang="ts">
import { computed } from 'vue'
import type { StyleAnalysisResult } from '../../../../../shared/assistant-types'
import { compareStyleAnalyses, hasStyleAnalysisChanges } from '../../../../../shared/style-analysis-compare'

const props = defineProps<{
  previous: StyleAnalysisResult
  current: StyleAnalysisResult
}>()

const diffItems = computed(() => compareStyleAnalyses(props.previous, props.current))
const hasChanges = computed(() => hasStyleAnalysisChanges(diffItems.value))
const changedItems = computed(() => diffItems.value.filter(i => i.changed))
</script>

<template>
  <div class="mt-3 pt-3 border-t border-base-300/60">
    <p class="text-xs font-semibold text-base-content/50 mb-2">与上次文风分析对比</p>
    <p v-if="!hasChanges" class="text-xs text-base-content/40">与上次分析结果一致</p>
    <ul v-else class="space-y-2 text-xs">
      <li
        v-for="item in changedItems"
        :key="item.field"
        class="bg-base-300/40 rounded-lg p-2"
      >
        <p class="font-medium text-base-content/60 mb-1">{{ item.label }}</p>
        <p class="text-error/80 line-through opacity-70">{{ item.before || '（空）' }}</p>
        <p class="text-success mt-0.5">{{ item.after || '（空）' }}</p>
      </li>
    </ul>
  </div>
</template>
