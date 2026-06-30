<script setup lang="ts">
import { ref, computed } from 'vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import type { SettingPatchResult, SettingPatchItem } from '../../../../shared/assistant-types'
import {
  extractGoldenFingerFromAiContent,
  parseGoldenFingerFromMarkdown,
  renderGoldenFingerMarkdown,
  mergeGoldenFinger,
  normalizeGoldenFinger,
  type GoldenFingerStructured
} from '../../../../shared/golden-finger-types'

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

const DEFAULT_CARD_HEIGHT = 400
const MIN_CARD_HEIGHT = 160
const MAX_CARD_HEIGHT = 800
const cardHeight = ref(DEFAULT_CARD_HEIGHT)
const isDragging = ref(false)
let dragStartY = 0
let dragStartHeight = DEFAULT_CARD_HEIGHT

const patches = computed(() => props.patchResult.settingPatches ?? [])
const pendingCount = computed(() => patches.value.filter(p => !appliedSlots.value.has(p.slot)).length)

function startDrag(event: MouseEvent) {
  event.preventDefault()
  isDragging.value = true
  dragStartY = event.clientY
  dragStartHeight = cardHeight.value
  window.addEventListener('mousemove', onDrag)
  window.addEventListener('mouseup', stopDrag)
}

function onDrag(event: MouseEvent) {
  if (!isDragging.value) return
  const deltaY = dragStartY - event.clientY
  cardHeight.value = Math.min(MAX_CARD_HEIGHT, Math.max(MIN_CARD_HEIGHT, dragStartHeight + deltaY))
}

function stopDrag() {
  isDragging.value = false
  window.removeEventListener('mousemove', onDrag)
  window.removeEventListener('mouseup', stopDrag)
}

async function loadCurrentGoldenFinger(): Promise<GoldenFingerStructured> {
  try {
    const raw = await window.anovel.invoke('setting:getStructured', props.workId, 'golden_finger') as Partial<GoldenFingerStructured> | null
    if (raw) return normalizeGoldenFinger(raw)
    const rows = await window.anovel.invoke('setting:listByWork', props.workId) as { type: string; content: string }[]
    const markdown = rows.find(r => r.type === 'golden_finger')?.content?.trim() ?? ''
    return markdown ? parseGoldenFingerFromMarkdown(markdown) : normalizeGoldenFinger({})
  } catch {
    return normalizeGoldenFinger({})
  }
}

async function applyPatch(item: SettingPatchItem) {
  if (applyingSlot.value || appliedSlots.value.has(item.slot)) return
  applyingSlot.value = item.slot
  try {
    if (item.slot === 'golden_finger') {
      const current = await loadCurrentGoldenFinger()
      let merged: GoldenFingerStructured

      if (item.structuredContent && typeof item.structuredContent === 'object') {
        const patchStructured = normalizeGoldenFinger(item.structuredContent as Partial<GoldenFingerStructured>)
        merged = mergeGoldenFinger(current, patchStructured)
      } else {
        const trimmed = item.content.trim()
        const extracted = extractGoldenFingerFromAiContent(trimmed)
        const patchStructured = extracted?.structured ?? parseGoldenFingerFromMarkdown(trimmed)
        merged = mergeGoldenFinger(current, patchStructured)
      }

      const markdown = renderGoldenFingerMarkdown(merged)
      await window.anovel.invoke(
        'setting:upsertStructured',
        props.workId,
        'golden_finger',
        markdown,
        merged
      )
    } else {
      await window.anovel.invoke('setting:upsert', props.workId, item.slot, item.content.trim())
    }
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
  <div
    class="rounded-lg border border-primary/30 bg-primary/5 p-2 shrink-0 flex flex-col relative"
    :style="expanded ? { height: `${cardHeight}px`, maxHeight: `${MAX_CARD_HEIGHT}px` } : undefined"
  >
    <div
      v-if="expanded"
      class="absolute -top-1.5 left-0 right-0 h-3 flex items-center justify-center cursor-ns-resize z-10"
      title="拖动调整高度"
      @mousedown="startDrag"
    >
      <div
        class="w-10 h-1 rounded-full transition-colors"
        :class="isDragging ? 'bg-primary' : 'bg-primary/30 hover:bg-primary/60'"
      />
    </div>
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

    <div v-show="expanded" class="space-y-2 overflow-y-auto pr-1 flex-1 min-h-0 flex flex-col">
      <div
        v-for="item in patches"
        :key="item.slot"
        class="rounded-md border border-base-300 bg-base-100 overflow-hidden flex flex-col min-h-0"
      >
        <div class="flex items-center justify-between gap-2 px-2 py-1.5 border-b border-base-300 bg-base-200/30 shrink-0">
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
        <div class="flex-1 min-h-0 overflow-y-auto p-2">
          <MarkdownContent :content="item.content" size="sm" />
        </div>
      </div>
    </div>
  </div>
</template>
