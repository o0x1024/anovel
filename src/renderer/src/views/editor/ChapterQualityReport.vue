<script setup lang="ts">
interface QualityItem {
  key: string
  label: string
  severity: 'fatal' | 'warning' | 'info'
  passed: boolean
  detail: string
}

interface QualityResult {
  items: QualityItem[]
  fatalCount: number
  warningCount: number
  passed: boolean
  summary: string
  writerBlockHint?: string
}

defineProps<{
  result: QualityResult | null
  aiReport?: string
  blockHints?: Record<string, { label: string; hint: string }>
}>()
</script>

<template>
  <div v-if="result" class="mt-3 pt-3 border-t border-base-300">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs font-medium text-base-content/50">章节质量诊断</span>
      <span class="badge badge-sm" :class="result.passed ? 'badge-success' : 'badge-error'">
        {{ result.summary }}
      </span>
    </div>
    <div class="space-y-1">
      <div
        v-for="item in result.items"
        :key="item.key"
        class="text-xs flex gap-2"
        :class="item.passed ? 'text-base-content/60' : item.severity === 'fatal' ? 'text-error' : 'text-warning'"
      >
        <span>{{ item.passed ? '✓' : '✗' }}</span>
        <span><strong>{{ item.label }}</strong>：{{ item.detail }}</span>
      </div>
    </div>
    <div v-if="aiReport" class="mt-2 p-3 bg-base-100 rounded border border-base-300 text-xs whitespace-pre-wrap max-h-64 overflow-auto leading-relaxed">
      {{ aiReport }}
    </div>
    <div v-if="result.writerBlockHint && blockHints?.[result.writerBlockHint]" class="mt-2 alert alert-warning py-2 text-xs">
      <strong>卡文提示 · {{ blockHints[result.writerBlockHint].label }}</strong>
      <p class="mt-1">{{ blockHints[result.writerBlockHint].hint }}</p>
    </div>
  </div>
</template>
