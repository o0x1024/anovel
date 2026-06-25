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
    workspace: incubator.workspace,
    workType: workType.value
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
          ? '右侧「AI 分析」运行「情绪定位」产生主题，运行「微创新变体」产生核心冲突，运行「黄金开局扩写」产生开局 → 候选池评分 → 采写入槽'
          : '右侧「AI 分析」运行「主题前提」产生主题，运行「变体探索」产生核心冲突，运行「开局扩写」产生开局 → 候选池评分 → 采写入槽'
      }
    }
    if (step.id === 'slots') {
      return {
        ...step,
        detail: isStory
          ? '按序填满主线槽位：情绪定位 → 核心冲突(对齐微创新变体) → 黄金开局(对齐黄金开局扩写) → 反差人设(对齐反差人设) → 节奏与清算(对齐节奏与清算)；右侧有各槽同名分析模块可生成并采纳'
          : '按序填满主线槽位：主题前提 → 核心冲突(对齐变体探索) → 世界规则(对齐世界规则) → 角色驱动(对齐角色驱动) → 开局设计(对齐开局扩写) → 终局设计(对齐终局设计)；右侧有各槽同名分析模块可生成并采纳'
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
  if (isStory) {
    const labels: Record<string, string> = {
      premise: '情绪定位 (对齐情绪定位)',
      core_conflict: '核心冲突 (对齐微创新变体)',
      role_engine: '反差人设 (对齐反差人设)',
      opening: '黄金开局 (对齐黄金开局扩写)',
      rhythm_ending: '节奏与清算 (对齐节奏与清算)'
    }
    return labels[key] || key
  }
  const labels: Record<string, string> = {
    premise: '主题前提 (对齐主题前提)',
    core_conflict: '核心冲突 (对齐变体探索)',
    world_rules: '世界规则 (对齐世界规则)',
    role_engine: '角色驱动 (对齐角色驱动)',
    opening: '开局设计 (对齐开局扩写)',
    ending: '终局设计 (对齐终局设计)'
  }
  return labels[key] || INCUBATOR_SLOT_LABELS[key as keyof typeof INCUBATOR_SLOT_LABELS] || key
}

const nextSlotHint = computed(() => {
  if (currentStepId.value !== 'slots') return ''
  const key = nextUnfilledSlotKey(incubator.workspace, workType.value)
  return key ? `下一步建议先填「${getSlotMappingLabel(key)}」` : '主线槽位已齐，可运行门禁'
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
