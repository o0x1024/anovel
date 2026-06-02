<script setup lang="ts">
import WorkBodyPicker from '../../components/WorkBodyPicker.vue'
import type { AssistantWorkReference } from '../../../../shared/assistant-types'

const props = defineProps<{
  attachedKeys: string[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  pick: [ref: AssistantWorkReference]
}>()
</script>

<template>
  <WorkBodyPicker
    :attached-keys="attachedKeys"
    :disabled="disabled"
    title="引用作品正文"
    dialog-title="引用作品正文"
    dialog-hint="选择 ANovel 作品中的章节或全书正文作为对话上下文"
    button-class="btn btn-ghost btn-xs btn-square text-base-content/50 hover:text-base-content"
    @select="emit('pick', $event)"
  />
</template>
