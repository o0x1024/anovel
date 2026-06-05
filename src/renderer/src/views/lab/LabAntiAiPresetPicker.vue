<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

interface Preset {
  label: string
  rule: string
}

const props = defineProps<{
  modelValue: string[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const surfacePresets = ref<Preset[]>([])
const deepPresets = ref<Preset[]>([])
const selectedSet = computed(() => new Set(props.modelValue))

function togglePreset(preset: Preset) {
  if (props.disabled) return
  const next = new Set(props.modelValue)
  if (next.has(preset.rule)) next.delete(preset.rule)
  else next.add(preset.rule)
  emit('update:modelValue', [...next])
}

function setGroup(presets: Preset[], select: boolean) {
  if (props.disabled) return
  const next = new Set(props.modelValue)
  for (const preset of presets) {
    if (select) next.add(preset.rule)
    else next.delete(preset.rule)
  }
  emit('update:modelValue', [...next])
}

onMounted(async () => {
  try {
    const data = await window.anovel.invoke('lab:getAntiAiPresets') as {
      surface: Preset[]
      deep: Preset[]
    }
    surfacePresets.value = data.surface ?? []
    deepPresets.value = data.deep ?? []
  } catch {
    /* presets unavailable */
  }
})
</script>

<template>
  <details class="group text-xs">
    <summary
      class="cursor-pointer list-none flex items-center gap-1.5 text-base-content/60 hover:text-base-content/80 select-none"
      :class="props.disabled ? 'pointer-events-none opacity-50' : ''"
    >
      <span class="transition group-open:rotate-90">▸</span>
      <span>去AI规则（可选）</span>
      <span
        v-if="props.modelValue.length"
        class="badge badge-primary badge-xs"
      >
        已选 {{ props.modelValue.length }}
      </span>
      <span v-else class="text-[10px] text-base-content/40">默认不注入</span>
    </summary>

    <div class="mt-2 pl-3 space-y-2 border-l border-base-300/60">
      <div v-if="surfacePresets.length">
        <div class="flex items-center gap-2 mb-1">
          <span class="font-medium text-base-content/70">表层去AI味</span>
          <button
            type="button"
            class="btn btn-ghost btn-xs px-1 min-h-0 h-auto"
            :disabled="props.disabled"
            @click="setGroup(surfacePresets, true)"
          >
            全选
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-xs px-1 min-h-0 h-auto"
            :disabled="props.disabled"
            @click="setGroup(surfacePresets, false)"
          >
            清空
          </button>
        </div>
        <label
          v-for="preset in surfacePresets"
          :key="preset.label"
          class="flex items-start gap-2 py-0.5 cursor-pointer"
          :class="props.disabled ? 'opacity-50 cursor-not-allowed' : ''"
        >
          <input
            type="checkbox"
            class="checkbox checkbox-xs mt-0.5 shrink-0"
            :checked="selectedSet.has(preset.rule)"
            :disabled="props.disabled"
            @change="togglePreset(preset)"
          >
          <span class="leading-snug" :title="preset.rule">{{ preset.label }}</span>
        </label>
      </div>

      <div v-if="deepPresets.length">
        <div class="flex items-center gap-2 mb-1">
          <span class="font-medium text-base-content/70">深层反检测</span>
          <button
            type="button"
            class="btn btn-ghost btn-xs px-1 min-h-0 h-auto"
            :disabled="props.disabled"
            @click="setGroup(deepPresets, true)"
          >
            全选
          </button>
          <button
            type="button"
            class="btn btn-ghost btn-xs px-1 min-h-0 h-auto"
            :disabled="props.disabled"
            @click="setGroup(deepPresets, false)"
          >
            清空
          </button>
        </div>
        <label
          v-for="preset in deepPresets"
          :key="preset.label"
          class="flex items-start gap-2 py-0.5 cursor-pointer"
          :class="props.disabled ? 'opacity-50 cursor-not-allowed' : ''"
        >
          <input
            type="checkbox"
            class="checkbox checkbox-xs mt-0.5 shrink-0"
            :checked="selectedSet.has(preset.rule)"
            :disabled="props.disabled"
            @change="togglePreset(preset)"
          >
          <span class="leading-snug" :title="preset.rule">{{ preset.label }}</span>
        </label>
      </div>
    </div>
  </details>
</template>
