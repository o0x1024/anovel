<script setup lang="ts">
import { computed } from 'vue'
import type { AigcCategory, AigcSegment } from '../../../../shared/aigc-detect-types'
import { AIGC_CATEGORY_LABELS } from '../../../../shared/aigc-detect-types'
import type { AigcSentencePatch } from '../../../../shared/aigc-sentence-rewrite-types'
import { resolveAigcDisplayCategories } from '../../../../shared/aigc-display-allocation'

const props = defineProps<{
  segments: AigcSegment[]
  patches?: AigcSentencePatch[]
}>()

const CATEGORY_BG_CLASSES: Record<AigcCategory, string> = {
  human: 'bg-[#a3d977]/30',
  suspected_ai: 'bg-[#f5deb3]/55',
  ai: 'bg-[#f5a0a0]/55'
}

function segmentProbabilityLabel(segment: AigcSegment): string {
  const probabilities = segment.probabilities
  if (!probabilities) return AIGC_CATEGORY_LABELS[segment.category]
  const risk = typeof segment.riskScore === 'number' ? `句级风险 ${segment.riskScore.toFixed(1)} · ` : ''
  return `${risk}人工 ${probabilities.human.toFixed(1)}% · 疑似AI ${probabilities.suspected_ai.toFixed(1)}% · AI ${probabilities.ai.toFixed(1)}%`
}

const displaySegments = computed(() => {
  const categories = resolveAigcDisplayCategories(props.segments, props.patches)
  const patches = props.patches ?? []
  let start = 0
  return props.segments.map((segment, index) => {
    const end = start + segment.text.length
    const patch = patches.find(item =>
      (item.start === start && item.end === end) ||
      (item.scope === 'block' && item.start <= start && item.end >= end)
    )
    const item = {
      segment,
      displayCategory: categories[index],
      patch
    }
    start = end
    return item
  })
})

function tooltipLabel(displayCategory: AigcCategory, patch?: AigcSentencePatch): string {
  if (displayCategory === 'ai' && patch?.evidence) return `${patch.scope === 'block' ? '语义块逐句诊断' : '句内改写证据'}：${patch.evidence}`
  if (patch?.status === 'unchanged') return '窗口级风险：未定位到可安全改写的具体证据'
  return `句级判定：${AIGC_CATEGORY_LABELS[displayCategory]}`
}
</script>

<template>
  <div class="text-sm leading-relaxed whitespace-pre-wrap break-words">
    <span
      v-for="({ segment, displayCategory, patch }, index) in displaySegments"
      :key="index"
      class="aigc-sentence relative group cursor-default rounded-sm px-0.5 py-[0.22em]"
      :class="CATEGORY_BG_CLASSES[displayCategory]"
    >{{ segment.text }}<span
        v-if="segment.reason || patch?.evidence || patch?.status === 'unchanged'"
        class="aigc-tooltip absolute hidden group-hover:inline-block left-0 top-full z-50 mt-1 w-max max-w-sm px-2.5 py-1.5 text-[11px] leading-relaxed text-left whitespace-normal break-words bg-base-300 text-base-content rounded shadow-lg"
      >{{ tooltipLabel(displayCategory, patch) }} · {{ segmentProbabilityLabel(segment) }}：{{ segment.reason }}</span></span>
  </div>
</template>

<style scoped>
.aigc-sentence {
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}

.aigc-tooltip {
  overflow-wrap: anywhere;
}
</style>
