<script setup lang="ts">
import { computed, inject } from 'vue'
import {
  INCUBATOR_RECOMMENDED_WORKFLOW,
  resolveIncubatorWorkflowStep,
  nextUnfilledSlotKey,
  workflowStepIndex
} from '../../../../../shared/incubator-workflow'
import { INCUBATOR_SLOT_LABELS } from '../../../../../shared/incubator-slots'
import { incubatorStateKey, incubatorSeedTextKey } from './incubator-context'

const incubator = inject(incubatorStateKey)!
const seedText = inject(incubatorSeedTextKey)!

const currentStepId = computed(() =>
  resolveIncubatorWorkflowStep({
    seedText: seedText.value,
    workspace: incubator.workspace
  })
)

const currentIndex = computed(() => workflowStepIndex(currentStepId.value))

const currentStepLabel = computed(
  () => INCUBATOR_RECOMMENDED_WORKFLOW[currentIndex.value]?.label ?? ''
)

const nextSlotHint = computed(() => {
  if (currentStepId.value !== 'slots') return ''
  const key = nextUnfilledSlotKey(incubator.workspace)
  return key ? `下一步建议先填「${INCUBATOR_SLOT_LABELS[key]}」` : '六槽已齐，可运行门禁'
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
          v-for="(step, i) in INCUBATOR_RECOMMENDED_WORKFLOW"
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
