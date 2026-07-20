<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import type { AigcCategory, AigcDetectResult } from '../../../../shared/aigc-detect-types'
import { AIGC_CATEGORY_LABELS } from '../../../../shared/aigc-detect-types'

const props = defineProps<{
  open: boolean
  result: AigcDetectResult
}>()

const emit = defineEmits<{ close: [] }>()

const COLORS: Record<AigcCategory, string> = {
  human: '#a3d977',
  suspected_ai: '#f5deb3',
  ai: '#f5a0a0'
}
const CATEGORY_ORDER: AigcCategory[] = ['human', 'suspected_ai', 'ai']
const RADIUS = 54
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const donutSegments = computed(() => {
  let offset = 0
  return CATEGORY_ORDER.flatMap(category => {
    const percent = props.result.distribution[category]
    const item = percent > 0 ? [{ category, percent, offset, color: COLORS[category] }] : []
    offset += percent
    return item
  })
})

const diagnosticItems = computed(() => {
  const value = props.result.diagnostics
  if (!value) return []
  const items: Array<[string, number, string]> = [
    ...(typeof value.supervisedAiProbability === 'number' ? [[
      '中文监督 AI', value.supervisedAiProbability, '中文人类/AI监督分类模型输出的AI证据'
    ] as [string, number, string]] : []),
    ...(typeof value.detectorDisagreementShare === 'number' ? [[
      '检测器分歧', value.detectorDisagreementShare, '中文监督模型与困惑度结构模型明显冲突的文本覆盖率'
    ] as [string, number, string]] : []),
    ['词语可预测性', value.tokenPredictability, '本地语言模型对词组可预测程度的代理分'],
    ['功能序列规律', value.sequenceRegularity, '叙述、动作、解释等功能是否按固定顺序出现'],
    ['信息密度均匀', value.informationUniformity, '各句承担的信息量是否过度平均'],
    ['因果即时闭合', value.causalClosure, '动作后是否持续立刻补原因和意义'],
    ['叙述长期稳定', value.voiceStability, '叙述距离、语气和句法是否长期缺少波动'],
    ['模板表达密度', value.templateDensity, '已知小说模板表达的局部命中密度'],
    ['窗口风险 P75', value.windowRiskP75, '重叠检测窗口风险的 75 分位'],
    ['最高窗口风险', value.peakWindowRisk, '风险最高的局部窗口'],
    ['高风险窗占比', value.highRiskWindowShare, '风险达到 40 的窗口比例'],
    ['整篇结构风险', value.documentRisk, '多维结构证据融合后的文档级代理分']
  ]
  return items
})

function dashArray(percent: number): string {
  const length = percent / 100 * CIRCUMFERENCE
  return `${length} ${CIRCUMFERENCE - length}`
}

function onKeydown(event: KeyboardEvent) {
  if (props.open && event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-[100] flex justify-end">
      <button
        type="button"
        class="absolute inset-0 bg-black/30 cursor-default"
        aria-label="关闭检测详情"
        @click="emit('close')"
      />
      <aside class="relative h-full w-[min(28rem,92vw)] bg-base-100 shadow-2xl border-l border-base-300 flex flex-col">
        <header class="h-12 px-4 border-b border-base-300 flex items-center gap-2 shrink-0">
          <font-awesome-icon icon="chart-bar" class="w-4 h-4 text-primary" />
          <h2 class="text-sm font-bold">检测详情</h2>
          <button type="button" class="btn btn-ghost btn-sm btn-circle ml-auto" aria-label="关闭" @click="emit('close')">
            <font-awesome-icon icon="times" class="w-4 h-4" />
          </button>
        </header>

        <div class="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
          <section class="flex items-center gap-5">
            <div class="relative w-36 h-36 shrink-0">
              <svg viewBox="0 0 140 140" class="w-full h-full -rotate-90">
                <circle
                  v-for="segment in donutSegments"
                  :key="segment.category"
                  cx="70" cy="70" :r="RADIUS"
                  fill="none"
                  :stroke="segment.color"
                  stroke-width="20"
                  :stroke-dasharray="dashArray(segment.percent)"
                  :stroke-dashoffset="-((segment.offset / 100) * CIRCUMFERENCE)"
                />
                <circle cx="70" cy="70" r="42" class="fill-base-100" />
              </svg>
              <div class="absolute inset-0 flex flex-col items-center justify-center">
                <strong class="text-2xl tabular-nums">{{ result.distribution.ai }}%</strong>
                <span class="text-[10px] text-base-content/50">AI 特征</span>
              </div>
            </div>

            <div class="flex-1 space-y-2">
              <div
                v-for="category in CATEGORY_ORDER"
                :key="category"
                class="flex items-center gap-2 text-xs"
              >
                <span class="w-3 h-3 rounded-sm" :style="{ backgroundColor: COLORS[category] }" />
                <span>{{ AIGC_CATEGORY_LABELS[category] }}</span>
                <strong class="ml-auto tabular-nums">{{ result.distribution[category] }}%</strong>
              </div>
            </div>
          </section>

          <section class="rounded-lg border border-base-300 bg-base-200/30 p-3">
            <h3 class="text-xs font-semibold">检测说明</h3>
            <p class="mt-1 text-xs leading-5 text-base-content/65">{{ result.summary }}</p>
            <div v-if="result.diagnostics?.reasons.length" class="mt-2 flex gap-1 flex-wrap">
              <span v-for="reason in result.diagnostics.reasons" :key="reason" class="badge badge-warning badge-sm">
                {{ reason }}
              </span>
            </div>
          </section>

          <section v-if="diagnosticItems.length">
            <h3 class="text-xs font-semibold mb-2">代理指标分数</h3>
            <div class="space-y-3">
              <div v-for="([label, value, description]) in diagnosticItems" :key="label">
                <div class="flex items-center gap-2 text-[11px]">
                  <span class="w-24 text-base-content/70">{{ label }}</span>
                  <progress class="progress progress-error h-2 flex-1" :value="value" max="100" />
                  <strong class="w-9 text-right tabular-nums">{{ value.toFixed(1) }}</strong>
                </div>
                <p class="pl-24 ml-2 mt-0.5 text-[9px] text-base-content/40">{{ description }}</p>
              </div>
            </div>
          </section>

          <p class="rounded-lg bg-info/8 border border-info/20 p-3 text-[10px] leading-4 text-base-content/55">
            结果融合中文监督分类、词语概率和可解释结构特征；当两类检测器明显冲突时会落入“疑似AI”，不会强行给出确定结论。这不是朱雀内部模型分数，边界结果仍应结合原文证据人工判断。
          </p>
        </div>
      </aside>
    </div>
  </Teleport>
</template>
