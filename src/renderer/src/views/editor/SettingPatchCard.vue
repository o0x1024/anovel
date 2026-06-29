<script setup lang="ts">
import { ref, computed } from 'vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import type { SettingPatchResult, SettingPatchItem } from '../../../../shared/assistant-types'

const props = defineProps<{
  patchResult: SettingPatchResult
  workId: number
}>()

const emit = defineEmits<{
  applied: [slotType: string]
}>()

const applyingSlot = ref<string | null>(null)
const appliedSlots = ref<Set<string>>(new Set())
const expanded = ref(true)

const patches = computed(() => props.patchResult.settingPatches ?? [])
const pendingCount = computed(() => patches.value.filter(p => !appliedSlots.value.has(p.slot)).length)

async function applyPatch(item: SettingPatchItem) {
  if (applyingSlot.value || appliedSlots.value.has(item.slot)) return
  applyingSlot.value = item.slot
  try {
    await window.anovel.invoke('setting:upsert', props.workId, item.slot, item.content.trim())
    appliedSlots.value.add(item.slot)
    emit('applied', item.slot)
  } finally {
    applyingSlot.value = null
  }
}

function applyAll() {
  for (const item of patches.value) {
    if (!appliedSlots.value.has(item.slot)) {
      void applyPatch(item)
    }
  }
}
</script>

<template>
  <div class="rounded-lg border border-primary/30 bg-primary/5 p-2 shrink-0 flex flex-col" :class="expanded ? 'max-h-[400px]' : ''">
    <div class="flex items-center justify-between gap-2 mb-1 shrink-0">
      <button
        type="button"
        class="flex items-center gap-1.5 text-xs font-medium text-primary hover:text-primary/80"
        @click="expanded = !expanded"
      >
        <font-awesome-icon :icon="expanded ? 'chevron-down' : 'chevron-right'" class="w-3 h-3" />
        设定修订建议
        <span v-if="pendingCount > 0" class="badge badge-primary badge-xs">{{ pendingCount }}</span>
      </button>
      <button
        v-if="expanded"
        type="button"
        class="btn btn-primary btn-xs"
        :disabled="applyingSlot !== null || patches.every(p => appliedSlots.has(p.slot))"
        @click="applyAll"
      >
        <span v-if="applyingSlot" class="loading loading-spinner loading-xs mr-1" />
        全部应用
      </button>
    </div>

    <div v-show="expanded" class="space-y-2 overflow-y-auto pr-1">
      <div
        v-for="item in patches"
        :key="item.slot"
        class="rounded-md border border-base-300 bg-base-100 overflow-hidden"
      >
        <div class="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-base-300 bg-base-200/30">
          <span class="text-xs font-medium">{{ item.label || item.slot }}</span>
          <button
            type="button"
            class="btn btn-xs"
            :class="appliedSlots.has(item.slot) ? 'btn-success btn-disabled' : 'btn-primary'"
            :disabled="applyingSlot === item.slot || appliedSlots.has(item.slot)"
            @click="applyPatch(item)"
          >
            <span v-if="applyingSlot === item.slot" class="loading loading-spinner loading-xs mr-1" />
            {{ appliedSlots.has(item.slot) ? '已应用' : '应用' }}
          </button>
        </div>
        <div class="max-h-24 overflow-y-auto p-2">
          <MarkdownContent :content="item.content" size="sm" />
        </div>
      </div>
    </div>
  </div>
</template>
