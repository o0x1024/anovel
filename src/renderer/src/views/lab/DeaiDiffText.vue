<script setup lang="ts">
import type { TextDiffSegment } from '../../../../shared/text-diff'

defineProps<{
  segments: TextDiffSegment[]
  placeholder?: string
}>()
</script>

<template>
  <template v-if="segments.length">
    <span
      v-for="(seg, index) in segments"
      :key="index"
      :class="seg.changed ? 'bg-yellow-200/90 dark:bg-yellow-400/30 rounded-[2px] box-decoration-clone' : ''"
    >{{ seg.text }}</span>
  </template>
  <span v-else class="text-base-content/40">{{ placeholder }}</span>
</template>
