<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import {
  INCUBATOR_RECOMMENDED_WORKFLOW,
  resolveIncubatorWorkflowStep,
  nextUnfilledSlotKey,
  workflowStepIndex
} from '../../../../../shared/incubator-workflow'
import { INCUBATOR_SLOT_LABELS } from '../../../../../shared/incubator-slots'
import { incubatorStateKey, incubatorSeedTextKey } from './incubator-context'

const props = defineProps<{ workId: number }>()

const incubator = inject(incubatorStateKey)!
const seedText = inject(incubatorSeedTextKey)!

const workType = ref<string | null>(null)

async function fetchWorkType() {
  if (!props.workId) return
  try {
    const w = await window.anovel.invoke('work:get', props.workId) as { work_type?: string } | null
    workType.value = w?.work_type ?? null
  } catch (e) {
    console.error('Failed to fetch work type:', e)
  }
}

watch(() => props.workId, () => {
  void fetchWorkType()
}, { immediate: true })

const currentStepId = computed(() =>
  resolveIncubatorWorkflowStep({
    seedText: seedText.value,
    workspace: incubator.workspace
  })
)

const currentIndex = computed(() => workflowStepIndex(currentStepId.value))

const steps = computed(() => {
  const isStory = workType.value === 'story'
  return INCUBATOR_RECOMMENDED_WORKFLOW.map(step => {
    if (step.id === 'explore') {
      return {
        ...step,
        detail: isStory
          ? '右侧「AI 分析」运行「微创新变体」产生主冲突，运行「黄金开局扩写」产生前台钩子 → 候选池评分 → 采写入槽'
          : '右侧「AI 分析」运行「变体探索」产生主冲突，运行「方向扩写」产生前台钩子 → 候选池评分 → 采写入槽'
      }
    }
    if (step.id === 'slots') {
      return {
        ...step,
        detail: isStory
          ? '按序填满六槽：主冲突(对齐微创新变体) → 前台钩子(对齐黄金开局扩写) → 背景规则轴(对齐背景规则) → 反差人设轴(对齐反差人设) → 极速节奏曲线(对齐极速节奏) → 清算终局结构(对齐清算终局)；右侧有各槽同名分析模块可生成并采纳'
          : '按序填满六槽：主冲突(对齐变体探索) → 前台钩子(对齐方向扩写) → 世界规则轴(对齐世界规则) → 角色驱动轴(对齐角色驱动) → 节奏曲线轴(对齐节奏曲线) → 终局结构(对齐终局结构)；右侧有各槽同名分析模块可生成并采纳'
      }
    }
    return step
  })
})

const currentStepLabel = computed(
  () => steps.value[currentIndex.value]?.label ?? ''
)

const getSlotMappingLabel = (key: string) => {
  const isStory = workType.value === 'story'
  const labels: Record<string, string> = {
    core_conflict: isStory ? '主冲突轴 (对齐微创新变体)' : '主冲突轴 (对齐变体探索)',
    hook: isStory ? '前台钩子 (对齐黄金开局扩写)' : '前台钩子 (对齐方向扩写)',
    world_rules: isStory ? '世界规则轴 (对齐背景规则轴)' : '世界规则轴 (对齐世界规则轴)',
    role_engine: isStory ? '角色驱动轴 (对齐反差人设轴)' : '角色驱动轴 (对齐角色驱动轴)',
    rhythm_curve: isStory ? '节奏曲线轴 (对齐极速节奏曲线)' : '节奏曲线轴 (对齐节奏曲线轴)',
    ending_structure: isStory ? '终局结构 (对齐清算终局结构)' : '终局结构 (对齐终局结构)'
  }
  return labels[key] || INCUBATOR_SLOT_LABELS[key as keyof typeof INCUBATOR_SLOT_LABELS] || key
}

const nextSlotHint = computed(() => {
  if (currentStepId.value !== 'slots') return ''
  const key = nextUnfilledSlotKey(incubator.workspace)
  return key ? `下一步建议先填「${getSlotMappingLabel(key)}」` : '六槽已齐，可运行门禁'
})
</script>

<template>
  <details class="collapse collapse-arrow rounded-lg border border-info/30 bg-info/5">
    <summary class="collapse-title min-h-0 py-2.5 text-sm font-medium cursor-pointer">
      <span>推荐操作顺序</span>
      <span class="text-primary font-normal ml-1">· 当前 {{ currentStepLabel }}</span>
      <span v-if="nextSlotHint" class="text-xs text-primary font-normal ml-1">{{ nextSlotHint }}</span>
    </summary>
    <div class="collapse-content px-3 pb-3">
      <ol class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <li
          v-for="(step, i) in steps"
          :key="step.id"
          class="rounded-md border px-2.5 py-2 text-xs transition-colors"
          :class="
            i === currentIndex
              ? 'border-primary bg-primary/10 text-base-content'
              : i < currentIndex
                ? 'border-base-300/60 bg-base-100/50 text-base-content/55'
                : 'border-base-300/40 bg-base-100/30 text-base-content/70'
          "
        >
          <span
            class="font-medium"
            :class="i === currentIndex ? 'text-primary' : ''"
          >{{ step.label }}</span>
          <span class="text-base-content/60"> — {{ step.detail }}</span>
        </li>
      </ol>
    </div>
  </details>
</template>
