<script setup lang="ts">
defineProps<{
  icon: string
  title: string
  noMargin?: boolean
}>()
</script>

<template>
  <h3
    class="text-lg font-semibold flex items-center gap-2"
    :class="noMargin ? '' : 'mb-4'"
  >
    <font-awesome-icon :icon="icon" class="w-4 h-4 text-primary shrink-0" />
    <span>{{ title }}</span>
  </h3>
</template>
