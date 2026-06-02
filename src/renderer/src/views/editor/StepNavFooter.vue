<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import {
  editorNavKey,
  getNextStep,
  NEXT_STEP_LABELS,
  type WorkflowStepKey,
  type SettingsQualityStatus
} from './editor-nav'

const props = defineProps<{
  step: WorkflowStepKey
  hint?: string
  workId?: number
}>()

const nav = inject(editorNavKey)
const navigating = ref(false)

const nextStep = computed(() => getNextStep(props.step))
const nextLabel = computed(() =>
  nextStep.value ? NEXT_STEP_LABELS[props.step] : ''
)
const progressHint = computed(() =>
  props.hint ?? nav?.stepProgress.value?.hints[props.step] ?? ''
)

async function handleNext() {
  if (!nextStep.value || !nav || navigating.value) return

  if (props.step === 'settings' && props.workId != null) {
    const status = await window.anovel.invoke('settingsQuality:getStatus', props.workId) as SettingsQualityStatus
    if (!status.canProceed && status.needsReview) {
      let msg: string
      if (status.isStale) {
        msg = '设定内容已变更，质量自检报告已过期。仍要进入分卷大纲？'
      } else if (!status.hasOverallCheck) {
        msg = '尚未完成设定质量自检。仍要进入分卷大纲？'
      } else if (status.blockingCount > 0) {
        msg = `自检仍有 ${status.blockingCount} 个不合格项${status.overallScore != null ? `（总分 ${status.overallScore}）` : ''}。仍要进入分卷大纲？`
      } else if (status.overallScore != null && status.overallScore < 75) {
        msg = `自检总分 ${status.overallScore} 未达通过线（75）。仍要进入分卷大纲？`
      } else if (status.unresolvedIssues.length > 0) {
        const preview = status.unresolvedIssues.slice(0, 3).join('\n')
        msg = `自检仍有 ${status.unresolvedIssues.length} 条未决问题，例如：\n${preview}\n\n仍要进入分卷大纲？`
      } else {
        msg = '设定质量自检未达标。仍要进入分卷大纲？'
      }
      if (!confirm(msg)) return
    }
  }

  navigating.value = true
  try {
    nav.goToStep(nextStep.value)
  } finally {
    navigating.value = false
  }
}
</script>

<template>
  <div
    v-if="nextStep || progressHint"
    class="mt-8 pt-5 border-t border-base-300 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
  >
    <p v-if="progressHint" class="text-sm text-base-content/50">{{ progressHint }}</p>
    <button
      v-if="nextStep && nav"
      type="button"
      class="btn btn-primary btn-sm gap-1 sm:ml-auto shrink-0"
      :disabled="navigating"
      @click="handleNext"
    >
      {{ navigating ? '跳转中...' : nextLabel }}
      <font-awesome-icon icon="arrow-right" class="w-3 h-3" />
    </button>
  </div>
</template>
