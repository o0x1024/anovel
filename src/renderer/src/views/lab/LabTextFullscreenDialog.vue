<script setup lang="ts">
defineProps<{
  open: boolean
  title: string
  modelValue: string
  maxLength?: number
  disabled?: boolean
  monospace?: boolean
  placeholder?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  close: []
}>()
</script>

<template>
  <dialog :class="['modal', { 'modal-open': open }]">
    <div class="modal-box w-[94vw] max-w-5xl h-[90vh] p-0 flex flex-col">
      <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-base-300 shrink-0">
        <h3 class="font-bold text-sm truncate">{{ title }}</h3>
        <div class="flex items-center gap-2 shrink-0">
          <span v-if="maxLength" class="text-[11px] text-base-content/45 tabular-nums">
            {{ modelValue.length.toLocaleString() }}/{{ maxLength.toLocaleString() }}
          </span>
          <button type="button" class="btn btn-ghost btn-xs btn-square" title="关闭" @click="emit('close')">
            <font-awesome-icon icon="times" class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <textarea
        :value="modelValue"
        class="flex-1 min-h-0 w-full resize-none border-0 rounded-none bg-base-100 p-4 leading-relaxed focus:outline-none focus:ring-0 overflow-y-auto scrollbar-thin"
        :class="monospace ? 'font-mono text-xs leading-5' : 'text-sm'"
        :maxlength="maxLength"
        :disabled="disabled"
        :placeholder="placeholder"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      />
    </div>
    <form method="dialog" class="modal-backdrop bg-black/40" @click="emit('close')">
      <button type="button">close</button>
    </form>
  </dialog>
</template>
