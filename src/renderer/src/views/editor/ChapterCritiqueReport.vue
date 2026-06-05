<script setup lang="ts">
import { computed } from 'vue'

interface CritiqueDimension {
  key: string
  label: string
  score: number
  passed: boolean
  issues: string[]
}

interface CritiqueResult {
  dimensions: CritiqueDimension[]
  overallScore: number
  needsReview: boolean
  summary: string
}

const props = defineProps<{
  result: CritiqueResult | null
  applying?: boolean
}>()

defineEmits<{ applyFixes: [] }>()

const failedDimensions = computed(() =>
  props.result?.dimensions.filter(d => !d.passed) ?? []
)
</script>

<template>
  <div v-if="result" class="mt-3 pt-3 border-t border-base-300">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs font-medium text-base-content/50">六维批判自评</span>
      <span
        class="badge badge-sm"
        :class="result.needsReview ? 'badge-warning' : 'badge-success'"
      >
        {{ result.overallScore }} 分 · {{ result.needsReview ? '需审阅' : '静默通过' }}
      </span>
    </div>
    <p class="text-xs text-base-content/60 mb-2">{{ result.summary }}</p>
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-1">
      <div
        v-for="dim in result.dimensions"
        :key="dim.key"
        class="text-xs px-2 py-1 rounded border"
        :class="dim.passed ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5'"
      >
        <span class="font-medium">{{ dim.label }}</span>
        <span class="ml-1 opacity-70">{{ dim.score }}</span>
      </div>
    </div>
    <ul v-if="failedDimensions.length" class="mt-2 space-y-1 text-xs text-warning">
      <li v-for="dim in failedDimensions" :key="dim.key">
        {{ dim.label }}：{{ dim.issues.join('；') || '评分未达标' }}
      </li>
    </ul>
    <button
      v-if="result.needsReview"
      type="button"
      class="btn btn-warning btn-xs gap-1 mt-2"
      :disabled="applying"
      @click="$emit('applyFixes')"
    >
      <font-awesome-icon :icon="applying ? 'spinner' : 'wrench'" :spin="applying" class="w-3 h-3" />
      {{ applying ? '修改中...' : '按批判修复' }}
    </button>
  </div>
</template>
