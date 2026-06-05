<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'
import {
  TEMPERATURE_RANGE_BOUNDS,
  clampTemperatureValue,
  normalizeTemperatureRange
} from '../../../../shared/work-step-temperature'

const props = defineProps<{
  min: number
  max: number
}>()

const emit = defineEmits<{
  'update:min': [value: number]
  'update:max': [value: number]
}>()

const trackRef = ref<HTMLElement | null>(null)
const dragging = ref<'min' | 'max' | null>(null)

const span = TEMPERATURE_RANGE_BOUNDS.max - TEMPERATURE_RANGE_BOUNDS.min

const minPercent = computed(() => ((props.min - TEMPERATURE_RANGE_BOUNDS.min) / span) * 100)
const maxPercent = computed(() => ((props.max - TEMPERATURE_RANGE_BOUNDS.min) / span) * 100)

const fillStyle = computed(() => ({
  left: `${minPercent.value}%`,
  width: `${Math.max(maxPercent.value - minPercent.value, 0)}%`
}))

function valueFromClientX(clientX: number): number {
  const el = trackRef.value
  if (!el) return TEMPERATURE_RANGE_BOUNDS.min
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0) return TEMPERATURE_RANGE_BOUNDS.min
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  const raw = TEMPERATURE_RANGE_BOUNDS.min + ratio * span
  return clampTemperatureValue(raw)
}

function emitMin(raw: number) {
  const next = normalizeTemperatureRange({ min: raw, max: props.max })
  emit('update:min', next.min)
  if (next.max !== props.max) emit('update:max', next.max)
}

function emitMax(raw: number) {
  const next = normalizeTemperatureRange({ min: props.min, max: raw })
  emit('update:max', next.max)
  if (next.min !== props.min) emit('update:min', next.min)
}

function onWindowPointerMove(e: PointerEvent) {
  if (!dragging.value) return
  const v = valueFromClientX(e.clientX)
  if (dragging.value === 'min') emitMin(Math.min(v, props.max))
  else emitMax(Math.max(v, props.min))
}

function stopDrag() {
  dragging.value = null
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('pointerup', stopDrag)
  window.removeEventListener('pointercancel', stopDrag)
}

function startDrag(which: 'min' | 'max', e: PointerEvent) {
  e.preventDefault()
  dragging.value = which
  window.addEventListener('pointermove', onWindowPointerMove)
  window.addEventListener('pointerup', stopDrag)
  window.addEventListener('pointercancel', stopDrag)
  onWindowPointerMove(e)
}

function onTrackPointerDown(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('.temp-thumb')) return
  const v = valueFromClientX(e.clientX)
  const distMin = Math.abs(v - props.min)
  const distMax = Math.abs(v - props.max)
  if (distMin <= distMax) emitMin(v)
  else emitMax(v)
}

function onTrackKeyDown(e: KeyboardEvent) {
  const step = TEMPERATURE_RANGE_BOUNDS.step
  if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
    e.preventDefault()
    emitMin(props.min - step)
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
    e.preventDefault()
    emitMax(props.max + step)
  }
}

onBeforeUnmount(() => stopDrag())
</script>

<template>
  <div
    ref="trackRef"
    class="temp-track"
    role="group"
    aria-label="温度区间"
    tabindex="0"
    @pointerdown="onTrackPointerDown"
    @keydown="onTrackKeyDown"
  >
    <div class="temp-track__rail" aria-hidden="true" />
    <div class="temp-track__fill" :style="fillStyle" aria-hidden="true" />
    <button
      type="button"
      class="temp-thumb temp-thumb--min"
      :style="{ left: `${minPercent}%` }"
      aria-label="最低温度"
      @pointerdown.stop="startDrag('min', $event)"
    />
    <button
      type="button"
      class="temp-thumb temp-thumb--max"
      :style="{ left: `${maxPercent}%` }"
      aria-label="最高温度"
      @pointerdown.stop="startDrag('max', $event)"
    />
  </div>
</template>

<style scoped>
.temp-track {
  position: relative;
  height: 1.75rem;
  width: 100%;
  cursor: pointer;
  touch-action: none;
  outline: none;
}

.temp-track:focus-visible {
  outline: 2px solid color-mix(in oklch, var(--color-primary) 50%, transparent);
  outline-offset: 4px;
  border-radius: 0.25rem;
}

.temp-track__rail {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  height: 0.375rem;
  border-radius: 9999px;
  background: color-mix(in oklch, var(--color-base-content) 12%, var(--color-base-300));
}

.temp-track__fill {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  height: 0.5rem;
  border-radius: 9999px;
  background: color-mix(in oklch, var(--color-base-content) 88%, transparent);
  pointer-events: none;
}

.temp-thumb {
  position: absolute;
  top: 50%;
  width: 1.125rem;
  height: 1.125rem;
  margin: 0;
  padding: 0;
  border: 2px solid var(--color-base-100);
  border-radius: 9999px;
  transform: translate(-50%, -50%);
  cursor: grab;
  box-shadow: 0 1px 3px color-mix(in oklch, var(--color-base-content) 18%, transparent);
  transition: box-shadow 0.15s ease;
}

.temp-thumb:active {
  cursor: grabbing;
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--color-primary) 25%, transparent);
}

.temp-thumb--min {
  background: color-mix(in oklch, var(--color-primary) 75%, white);
  z-index: 2;
}

.temp-thumb--max {
  background: color-mix(in oklch, var(--color-secondary) 70%, white);
  z-index: 3;
}
</style>
