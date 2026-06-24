<script setup lang="ts">
import { useToast } from '../composables/useToast'

const { toasts, toastAlertClass } = useToast()
</script>

<template>
  <div class="toast toast-bottom toast-end z-[100] pointer-events-none">
    <transition-group name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        :class="['alert shadow-lg text-sm min-w-64 pointer-events-auto', toastAlertClass(t.type)]"
      >
        <font-awesome-icon
          :icon="t.type === 'success' ? 'check-circle' : t.type === 'error' ? 'exclamation-circle' : 'info-circle'"
          class="w-4 h-4 shrink-0"
        />
        <span>{{ t.message }}</span>
      </div>
    </transition-group>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(12px);
}
</style>
