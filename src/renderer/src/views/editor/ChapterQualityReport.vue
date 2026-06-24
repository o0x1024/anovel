<script setup lang="ts">
import { computed, ref } from 'vue'
import type { QualityAiScoreBreakdown } from '../../../../shared/quality-ai-score'
import {
  metricProgressClass,
  stripQualityAiScoreJson,
  totalScoreBadgeClass,
  totalScoreProgressClass,
  anchorVerdictBadgeClass,
  anchorVerdictLabel
} from '../../../../shared/quality-ai-score'

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

interface QualityAiMetrics {
  scoreTotal: number
  hardFail: boolean
  cappedByGate: boolean
  breakdown?: QualityAiScoreBreakdown | null
}

const props = defineProps<{
  result: QualityResult | null
  aiReport?: string
  aiMetrics?: QualityAiMetrics | null
  blockHints?: Record<string, { label: string; hint: string }>
}>()

const showRawReport = ref(false)

const displayReport = computed(() =>
  props.aiReport ? stripQualityAiScoreJson(props.aiReport) : ''
)

const hasAiResult = computed(() => !!(props.aiReport?.trim() || props.aiMetrics))
const hasGateResult = computed(() => !!props.result)
const visible = computed(() => hasGateResult.value || hasAiResult.value)

const scoreBreakdown = computed(() => props.aiMetrics?.breakdown ?? null)
const anchorAlignment = computed(() => scoreBreakdown.value?.anchorAlignment ?? [])
</script>

<template>
  <div v-if="visible" class="mt-3 pt-3 border-t border-base-300">
    <template v-if="result">
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
    </template>

    <p v-else-if="hasAiResult" class="text-xs font-medium text-base-content/50 mb-2">AI 章节质量诊断</p>

    <div
      v-if="aiMetrics"
      class="rounded border border-base-300 bg-base-100 p-3 text-xs space-y-3"
      :class="result ? 'mt-2' : ''"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium text-base-content/70">AI 量化评分（门禁对齐）</span>
        <span
          class="badge badge-sm"
          :class="totalScoreBadgeClass(aiMetrics.scoreTotal, aiMetrics.hardFail)"
        >
          {{ aiMetrics.scoreTotal }}/100
        </span>
        <span
          class="badge badge-sm"
          :class="aiMetrics.hardFail ? 'badge-error' : 'badge-ghost'"
        >
          {{ aiMetrics.hardFail ? '硬性失败' : '通过门禁' }}
        </span>
      </div>

      <div>
        <div class="mb-1 flex items-center justify-between text-base-content/60">
          <span>总分</span>
          <span>{{ aiMetrics.scoreTotal }}/100</span>
        </div>
        <progress
          class="progress w-full h-2"
          :class="totalScoreProgressClass(aiMetrics.scoreTotal, aiMetrics.hardFail)"
          :value="aiMetrics.scoreTotal"
          max="100"
        />
      </div>

      <p v-if="aiMetrics.cappedByGate" class="text-warning">
        分数已按规则门禁封顶（存在致命/警告项时不会显示过高分）。
      </p>

      <div v-if="scoreBreakdown" class="space-y-2">
        <p class="font-medium text-base-content/70">分项评分</p>
        <div class="grid gap-2 sm:grid-cols-2">
          <div
            v-for="item in scoreBreakdown.items"
            :key="item.key"
            class="rounded border border-base-300/70 bg-base-200/40 px-2 py-1.5"
          >
            <div class="mb-1 flex items-center justify-between gap-2">
              <span class="truncate">{{ item.label }}</span>
              <span class="shrink-0 tabular-nums text-base-content/70">
                {{ item.score }}/{{ item.max }}
              </span>
            </div>
            <progress
              class="progress w-full h-1.5"
              :class="metricProgressClass(item.ratio)"
              :value="item.score"
              :max="item.max"
            />
          </div>
        </div>

        <div v-if="scoreBreakdown.failedRules.length" class="rounded border border-error/30 bg-error/5 p-2">
          <p class="mb-1 font-medium text-error">硬失败规则</p>
          <ul class="list-disc space-y-0.5 pl-4 text-error/90">
            <li v-for="(rule, idx) in scoreBreakdown.failedRules" :key="idx">{{ rule }}</li>
          </ul>
        </div>

        <div v-if="scoreBreakdown.topIssues.length" class="rounded border border-warning/30 bg-warning/5 p-2">
          <p class="mb-1 font-medium text-warning">主要问题</p>
          <div
            v-for="(issue, idx) in scoreBreakdown.topIssues"
            :key="idx"
            class="mt-1 border-t border-warning/20 pt-1 first:mt-0 first:border-0 first:pt-0"
          >
            <p v-if="issue.id" class="font-medium">{{ issue.id }}</p>
            <p v-if="issue.evidence" class="text-base-content/70">「{{ issue.evidence }}」</p>
            <p v-if="issue.fixHint" class="text-base-content/60">→ {{ issue.fixHint }}</p>
          </div>
        </div>

        <div v-if="anchorAlignment.length" class="rounded border border-base-300 p-2">
          <p class="mb-1.5 font-medium text-base-content/70">锚点对齐</p>
          <ul class="space-y-1.5">
            <li
              v-for="(item, idx) in anchorAlignment"
              :key="idx"
              class="flex items-start gap-2"
            >
              <span
                class="badge badge-xs shrink-0 mt-0.5"
                :class="anchorVerdictBadgeClass(item.verdict)"
              >
                {{ anchorVerdictLabel(item.verdict) }}
              </span>
              <span class="text-base-content/70">
                <strong class="text-base-content/90">{{ item.title }}</strong>
                <span v-if="item.reason"> — {{ item.reason }}</span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <div v-if="displayReport" class="mt-2">
      <button
        type="button"
        class="btn btn-ghost btn-xs px-1 text-base-content/60"
        @click="showRawReport = !showRawReport"
      >
        {{ showRawReport ? '收起' : '展开' }}完整诊断报告
      </button>
      <div
        v-if="showRawReport"
        class="mt-1 max-h-64 overflow-auto rounded border border-base-300 bg-base-100 p-3 text-xs leading-relaxed whitespace-pre-wrap"
      >
        {{ displayReport }}
      </div>
    </div>

    <div v-if="result?.writerBlockHint && blockHints?.[result.writerBlockHint]" class="mt-2 alert alert-warning py-2 text-xs">
      <strong>卡文提示 · {{ blockHints[result.writerBlockHint].label }}</strong>
      <p class="mt-1">{{ blockHints[result.writerBlockHint].hint }}</p>
    </div>
  </div>
</template>
