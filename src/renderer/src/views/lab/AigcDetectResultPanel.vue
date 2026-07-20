<script setup lang="ts">
import { computed } from 'vue'
import type { AigcDetectResult, AigcCategory } from '../../../../shared/aigc-detect-types'
import { AIGC_CATEGORY_LABELS } from '../../../../shared/aigc-detect-types'
import type { AigcSentencePatch } from '../../../../shared/aigc-sentence-rewrite-types'
import AigcHighlightedText from './AigcHighlightedText.vue'
import { summarizeAigcDisplayDistribution } from '../../../../shared/aigc-display-allocation'

const props = defineProps<{
  result: AigcDetectResult | null
  status: 'idle' | 'running' | 'done' | 'error'
  errorMessage: string
  previewText?: string
  rewritePatches?: AigcSentencePatch[]
}>()

const CATEGORY_COLORS: Record<AigcCategory, string> = {
  human: '#a3d977',
  suspected_ai: '#f5deb3',
  ai: '#f5a0a0'
}

const displayDistribution = computed(() => props.result
  ? summarizeAigcDisplayDistribution(props.result.segments, props.rewritePatches)
  : { human: 0, suspected_ai: 0, ai: 0 }
)

const displaySummary = computed(() => {
  if (!props.result || !props.rewritePatches?.length) return props.result?.summary ?? ''
  const value = displayDistribution.value
  return `逐句证据复核覆盖率：人工 ${value.human}%，疑似AI ${value.suspected_ai}%，AI特征 ${value.ai}%`
})

const donutSegments = computed(() => {
  if (!props.result) return []
  const distribution = displayDistribution.value
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

const diagnosticItems = computed(() => {
  const diagnostics = props.result?.diagnostics
  if (!diagnostics) return []
  return [
    ['词语可预测性', diagnostics.tokenPredictability],
    ['段落序列规律', diagnostics.sequenceRegularity],
    ['信息密度均匀', diagnostics.informationUniformity],
    ['因果即时闭合', diagnostics.causalClosure],
    ['叙述长期稳定', diagnostics.voiceStability],
    ['模板表达密度', diagnostics.templateDensity],
    ['滑窗风险峰值', diagnostics.peakWindowRisk],
    ['高风险窗占比', diagnostics.highRiskWindowShare]
  ] as Array<[string, number]>
})
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
        <div
          v-if="result.authorship?.mode === 'ai_assisted'"
          class="mb-2 rounded border border-info/25 bg-info/5 px-2.5 py-2 text-[11px] text-info"
        >来源记录：AI辅助改写。下方比例仅表示当前本地特征覆盖，不代表人工作者身份。</div>
        <AigcHighlightedText :segments="result.segments" :patches="rewritePatches" />

        <div v-if="diagnosticItems.length" class="w-full border-t border-base-200 pt-2 space-y-1">
          <div v-for="([label, value]) in diagnosticItems" :key="label" class="flex items-center gap-1 text-[10px]">
            <span class="w-20 text-base-content/55">{{ label }}</span>
            <progress class="progress progress-error h-1.5 flex-1" :value="value" max="100" />
            <span class="w-7 text-right font-mono text-base-content/55">{{ Math.round(value) }}</span>
          </div>
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
              {{ displayDistribution.ai }}%
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
            <span class="font-mono">{{ displayDistribution.human }}%</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <span class="w-2.5 h-2.5 rounded-sm" :style="{ backgroundColor: CATEGORY_COLORS.suspected_ai }" />
              {{ AIGC_CATEGORY_LABELS.suspected_ai }}
            </span>
            <span class="font-mono">{{ displayDistribution.suspected_ai }}%</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <span class="w-2.5 h-2.5 rounded-sm" :style="{ backgroundColor: CATEGORY_COLORS.ai }" />
              {{ AIGC_CATEGORY_LABELS.ai }}
            </span>
            <span class="font-mono">{{ displayDistribution.ai }}%</span>
          </div>
        </div>

        <!-- Summary -->
        <div class="text-[11px] text-base-content/60 text-center border-t border-base-200 pt-2 px-1 mt-auto">
          {{ displaySummary }}
        </div>

        <!-- Detector difference notice -->
        <div class="text-[10px] text-base-content/40 text-center px-1 mt-1 leading-relaxed">
          百分比表示当前检测版本的特征覆盖，不是作者身份概率；红色为已定位AI特征，黄色为疑似或窗口风险
        </div>
      </div>
    </div>
  </div>
</template>
