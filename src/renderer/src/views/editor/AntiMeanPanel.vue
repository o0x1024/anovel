<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  workId: number
  content: string
}>()

const emit = defineEmits<{
  applyContent: [value: string]
}>()

const surpriseLoading = ref(false)
const disruptorLoading = ref(false)
const genreLoading = ref(false)
const surpriseResult = ref<{ score: number; passed: boolean; analysis: string; alternatives?: string[] } | null>(null)
const disruptorResult = ref<{ proposal: string; rationale: string } | null>(null)
const genreResult = ref<{ frequencyPercent: number; pattern: string; alternative: string } | null>(null)

async function runSurpriseScore() {
  if (!props.content.trim() || surpriseLoading.value) return
  surpriseLoading.value = true
  try {
    const res = await window.anovel.invoke('antimean:surpriseScore', props.workId, props.content) as {
      success: boolean
      score?: number
      passed?: boolean
      analysis?: string
      alternatives?: string[]
      error?: string
    }
    if (res.success) {
      surpriseResult.value = {
        score: res.score!,
        passed: res.passed!,
        analysis: res.analysis || '',
        alternatives: res.alternatives
      }
      void window.anovel.invoke('taste:recordChoice', props.workId, 'surprise_check', `score:${res.score}`)
    } else {
      alert(res.error || '评估失败')
    }
  } finally {
    surpriseLoading.value = false
  }
}

async function runDisruptor() {
  if (!props.content.trim() || disruptorLoading.value) return
  disruptorLoading.value = true
  try {
    const res = await window.anovel.invoke('antimean:disruptor', props.workId, props.content) as {
      success: boolean
      proposal?: string
      rationale?: string
      error?: string
    }
    if (res.success) {
      disruptorResult.value = { proposal: res.proposal!, rationale: res.rationale || '' }
    } else {
      alert(res.error || '生成失败')
    }
  } finally {
    disruptorLoading.value = false
  }
}

async function runGenreDeviation() {
  if (!props.content.trim() || genreLoading.value) return
  genreLoading.value = true
  try {
    const res = await window.anovel.invoke('antimean:genreDeviation', props.workId, props.content) as {
      success: boolean
      frequencyPercent?: number
      pattern?: string
      alternative?: string
      error?: string
    }
    if (res.success) {
      genreResult.value = {
        frequencyPercent: res.frequencyPercent!,
        pattern: res.pattern || '',
        alternative: res.alternative || ''
      }
    } else {
      alert(res.error || '分析失败')
    }
  } finally {
    genreLoading.value = false
  }
}
</script>

<template>
  <div v-if="content.trim()" class="mt-3 pt-3 border-t border-base-300">
    <p class="text-xs font-medium text-base-content/50 mb-2">反均值化引擎</p>
    <div class="flex flex-wrap gap-1 mb-2">
      <button class="btn btn-outline btn-xs" :disabled="surpriseLoading" @click="runSurpriseScore">
        {{ surpriseLoading ? '评估中...' : '惊喜度评分' }}
      </button>
      <button class="btn btn-outline btn-xs" :disabled="disruptorLoading" @click="runDisruptor">
        {{ disruptorLoading ? '生成中...' : '破坏者模式' }}
      </button>
      <button class="btn btn-outline btn-xs" :disabled="genreLoading" @click="runGenreDeviation">
        {{ genreLoading ? '分析中...' : '类型惯例偏离' }}
      </button>
    </div>

    <div v-if="surpriseResult" class="text-xs mb-2 p-2 bg-base-100 rounded border border-base-300">
      <span class="font-semibold">惊喜度 {{ surpriseResult.score }}/10</span>
      <span :class="surpriseResult.passed ? 'text-success' : 'text-warning'" class="ml-2">
        {{ surpriseResult.passed ? '通过' : '偏低' }}
      </span>
      <p v-if="surpriseResult.analysis" class="mt-1 text-base-content/60">{{ surpriseResult.analysis }}</p>
      <div v-if="surpriseResult.alternatives?.length" class="mt-2 space-y-1">
        <p class="text-base-content/50">替代走向：</p>
        <button
          v-for="(alt, i) in surpriseResult.alternatives"
          :key="i"
          class="btn btn-ghost btn-xs block h-auto text-left whitespace-normal"
          @click="emit('applyContent', alt); void window.anovel.invoke('taste:recordChoice', workId, 'surprise_alt', alt.slice(0, 80))"
        >
          {{ alt }}
        </button>
      </div>
    </div>

    <div v-if="disruptorResult" class="text-xs mb-2 p-2 bg-base-100 rounded border border-base-300">
      <p class="font-semibold mb-1">颠覆方案</p>
      <p class="text-base-content/70">{{ disruptorResult.proposal }}</p>
      <p v-if="disruptorResult.rationale" class="text-base-content/50 mt-1">{{ disruptorResult.rationale }}</p>
    </div>

    <div v-if="genreResult" class="text-xs p-2 bg-base-100 rounded border border-base-300">
      <p>同类惯例频率约 <strong>{{ genreResult.frequencyPercent }}%</strong></p>
      <p v-if="genreResult.pattern" class="text-base-content/60 mt-1">{{ genreResult.pattern }}</p>
      <p v-if="genreResult.alternative" class="text-primary mt-1">差异化：{{ genreResult.alternative }}</p>
    </div>
  </div>
</template>
