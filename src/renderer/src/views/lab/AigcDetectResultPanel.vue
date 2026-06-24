<script setup lang="ts">
import { computed } from 'vue'
import type { AigcDetectResult, AigcCategory } from '../../../../shared/aigc-detect-types'
import { AIGC_CATEGORY_LABELS } from '../../../../shared/aigc-detect-types'

const props = defineProps<{
  result: AigcDetectResult | null
  status: 'idle' | 'running' | 'done' | 'error'
  errorMessage: string
  previewText?: string
}>()

const CATEGORY_COLORS: Record<AigcCategory, string> = {
  human: '#a3d977',
  suspected_ai: '#f5deb3',
  ai: '#f5a0a0'
}

const CATEGORY_BG_CLASSES: Record<AigcCategory, string> = {
  human: 'bg-[#a3d977]/30',
  suspected_ai: 'bg-[#f5deb3]/50',
  ai: 'bg-[#f5a0a0]/40'
}

const donutSegments = computed(() => {
  if (!props.result) return []
  const { distribution } = props.result
  const segments: Array<{ category: AigcCategory; percent: number; color: string; offset: number }> = []
  let offset = 0
  const order: AigcCategory[] = ['human', 'suspected_ai', 'ai']
  for (const cat of order) {
    const percent = distribution[cat]
    if (percent > 0) {
      segments.push({ category: cat, percent, color: CATEGORY_COLORS[cat], offset })
    }
    offset += percent
  }
  return segments
})

function getStrokeDasharray(percent: number, circumference: number): string {
  const len = (percent / 100) * circumference
  return `${len} ${circumference - len}`
}

const RADIUS = 54
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
</script>

<template>
  <div class="flex-1 min-h-0 overflow-auto">
    <!-- Error state -->
    <div v-if="status === 'error'" class="p-4 text-error text-sm">
      {{ errorMessage }}
    </div>

    <!-- Empty state -->
    <div
      v-else-if="!result && status !== 'running' && !previewText?.trim()"
      class="flex items-center justify-center h-full text-base-content/30 text-sm"
    >
      输入文本后点击"开始检测"
    </div>

    <!-- Preview state (no detect result yet) -->
    <div v-else-if="!result && status !== 'running'" class="flex flex-col gap-2 p-3 h-full min-h-0">
      <p class="text-xs text-base-content/50">
        已更新文本，点击“开始检测”查看标注结果。
      </p>
      <div class="flex-1 min-h-0 overflow-auto text-sm leading-relaxed whitespace-pre-wrap break-words">
        {{ previewText }}
      </div>
    </div>

    <!-- Loading state -->
    <div v-else-if="status === 'running'" class="flex items-center justify-center h-full">
      <span class="loading loading-dots loading-lg text-primary" />
    </div>

    <!-- Result: left-right layout -->
    <div v-else-if="result" class="flex gap-4 p-3 h-full min-h-0">
      <!-- Left: color-coded text segments -->
      <div class="flex-1 min-w-0 overflow-auto">
        <div class="text-sm leading-relaxed whitespace-pre-wrap break-words">
          <span
            v-for="(seg, idx) in result.segments"
            :key="idx"
            class="rounded-sm px-0.5 relative group cursor-default"
            :class="CATEGORY_BG_CLASSES[seg.category]"
          >{{ seg.text }}<span
              v-if="seg.reason"
              class="absolute hidden group-hover:block left-0 top-full z-50 mt-1 px-2 py-1 text-[11px] bg-base-300 rounded shadow-lg whitespace-nowrap max-w-xs text-base-content"
            >{{ AIGC_CATEGORY_LABELS[seg.category] }}：{{ seg.reason }}</span></span>
        </div>
      </div>

      <!-- Right: chart + stats -->
      <div class="w-52 shrink-0 flex flex-col items-center gap-3 pt-2">
        <!-- Hint -->

        <!-- Donut chart -->
        <div class="relative w-32 h-32">
          <svg viewBox="0 0 140 140" class="w-full h-full -rotate-90">
            <circle
              v-for="(seg, idx) in donutSegments"
              :key="idx"
              cx="70" cy="70" :r="RADIUS"
              fill="none"
              :stroke="seg.color"
              stroke-width="18"
              :stroke-dasharray="getStrokeDasharray(seg.percent, CIRCUMFERENCE)"
              :stroke-dashoffset="-((seg.offset / 100) * CIRCUMFERENCE)"
            />
            <circle cx="70" cy="70" r="43" fill="#111827" stroke="white" stroke-width="1.5" />
          </svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center">
            <span class="text-2xl font-extrabold text-white leading-none tracking-tight drop-shadow-sm">
              {{ result.distribution.ai }}%
            </span>
            <span class="text-[11px] text-white/85 mt-1">AI特征</span>
          </div>
        </div>

        <!-- Percentage labels -->
        <div class="flex flex-col gap-1 text-xs text-base-content/60 w-full px-2">
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <span class="w-2.5 h-2.5 rounded-sm" :style="{ backgroundColor: CATEGORY_COLORS.human }" />
              {{ AIGC_CATEGORY_LABELS.human }}
            </span>
            <span class="font-mono">{{ result.distribution.human }}%</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <span class="w-2.5 h-2.5 rounded-sm" :style="{ backgroundColor: CATEGORY_COLORS.suspected_ai }" />
              {{ AIGC_CATEGORY_LABELS.suspected_ai }}
            </span>
            <span class="font-mono">{{ result.distribution.suspected_ai }}%</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <span class="w-2.5 h-2.5 rounded-sm" :style="{ backgroundColor: CATEGORY_COLORS.ai }" />
              {{ AIGC_CATEGORY_LABELS.ai }}
            </span>
            <span class="font-mono">{{ result.distribution.ai }}%</span>
          </div>
        </div>

        <!-- Summary -->
        <div class="text-[11px] text-base-content/60 text-center border-t border-base-200 pt-2 px-1 mt-auto">
          {{ result.summary }}
        </div>

        <!-- Detector difference notice -->
        <div class="text-[10px] text-base-content/40 text-center px-1 mt-1 leading-relaxed">
          本检测基于困惑度分析，与朱雀等分类器检测原理不同，结果可能有差异
        </div>
      </div>
    </div>
  </div>
</template>
