<script setup lang="ts">
import PanelTitle from '../../components/PanelTitle.vue'
import StepNavFooter from './StepNavFooter.vue'
import IncubatorWorkspace from './incubator/IncubatorWorkspace.vue'

defineProps<{ workId: number }>()
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="lightbulb" title="大岗孵化器" />
    <p class="text-sm text-base-content/50 mb-4">
      从创作种子出发，经候选池评分、槽位编排与门禁校验，产出可进入核心设定的主线故事线 V1。
    </p>

    <IncubatorWorkspace :work-id="workId" />

    <StepNavFooter step="incubator" class="mt-6" />
  </div>
</template>
