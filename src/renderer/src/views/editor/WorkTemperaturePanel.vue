<script setup lang="ts">
import { ref, reactive, onMounted, watch } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'
import DualTemperatureSlider from './DualTemperatureSlider.vue'
import {
  DEFAULT_WORK_STEP_TEMPERATURE,
  TEMPERATURE_RANGE_BOUNDS,
  WORK_TEMPERATURE_GROUP_HINTS,
  WORK_TEMPERATURE_GROUP_LABELS,
  WORK_TEMPERATURE_GROUP_ORDER,
  clampTemperatureValue,
  normalizeTemperatureRange,
  type WorkStepTemperatureConfig,
  type WorkTemperatureGroupKey
} from '../../../../shared/work-step-temperature'

const props = defineProps<{ workId: number }>()

const ready = ref(false)
const saving = ref(false)
const saveHint = ref('')
const config = reactive<WorkStepTemperatureConfig>(
  JSON.parse(JSON.stringify(DEFAULT_WORK_STEP_TEMPERATURE)) as WorkStepTemperatureConfig
)

let saveTimer: ReturnType<typeof setTimeout> | null = null

function syncRange(key: WorkTemperatureGroupKey, field: 'min' | 'max', raw: number) {
  const next = normalizeTemperatureRange({
    ...config[key],
    [field]: clampTemperatureValue(raw)
  })
  config[key].min = next.min
  config[key].max = next.max
}

function onSliderMin(key: WorkTemperatureGroupKey, value: number) {
  config[key].min = value
  const next = normalizeTemperatureRange(config[key])
  config[key].min = next.min
  config[key].max = next.max
}

function onSliderMax(key: WorkTemperatureGroupKey, value: number) {
  config[key].max = value
  const next = normalizeTemperatureRange(config[key])
  config[key].min = next.min
  config[key].max = next.max
}

function scheduleSave() {
  if (!ready.value) return
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => void persist(), 600)
}

async function load() {
  ready.value = false
  try {
    const data = await window.anovel.invoke(
      'work:getStepTemperature',
      props.workId
    ) as WorkStepTemperatureConfig
    for (const key of WORK_TEMPERATURE_GROUP_ORDER) {
      const range = normalizeTemperatureRange(data[key])
      config[key].min = range.min
      config[key].max = range.max
    }
  } finally {
    ready.value = true
  }
}

async function persist() {
  saving.value = true
  saveHint.value = ''
  try {
    const payload: WorkStepTemperatureConfig = {} as WorkStepTemperatureConfig
    for (const key of WORK_TEMPERATURE_GROUP_ORDER) {
      payload[key] = normalizeTemperatureRange(config[key])
    }
    await window.anovel.invoke('work:setStepTemperature', props.workId, payload)
    saveHint.value = '已保存'
    setTimeout(() => {
      if (saveHint.value === '已保存') saveHint.value = ''
    }, 2000)
  } catch (e) {
    saveHint.value = `保存失败：${e}`
  } finally {
    saving.value = false
  }
}

async function resetDefaults() {
  if (!confirm('恢复为默认温度区间？')) return
  const data = await window.anovel.invoke('work:resetStepTemperature', props.workId) as WorkStepTemperatureConfig
  for (const key of WORK_TEMPERATURE_GROUP_ORDER) {
    config[key].min = data[key].min
    config[key].max = data[key].max
  }
  saveHint.value = '已恢复默认'
}

onMounted(() => void load())

watch(config, () => scheduleSave(), { deep: true })

watch(() => props.workId, () => void load())
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <PanelTitle icon="thermometer-half" title="创作温度" />
    <p class="text-sm text-base-content/50 mb-4 -mt-2">
      本作品内的 AI 在对应场景的温度区间内随机取值；与「系统设置 → AI 服务」高级配置中的温度无关。
    </p>

    <div class="flex-1 overflow-y-auto scrollbar-thin px-1 pb-6 space-y-4">
      <div class="alert alert-info text-sm py-2">
        <span>每次请求会在该场景的 <strong>最低 ~ 最高</strong> 之间随机采样一个温度发给模型。Max Tokens、惩罚项等仍使用系统高级配置。</span>
      </div>

      <div
        v-for="key in WORK_TEMPERATURE_GROUP_ORDER"
        :key="key"
        class="card bg-base-200/40 border border-base-300/60"
      >
        <div class="card-body p-4 gap-3">
          <div>
            <h4 class="font-bold text-sm">{{ WORK_TEMPERATURE_GROUP_LABELS[key] }}</h4>
            <p class="text-xs text-base-content/50 mt-0.5">
              {{ WORK_TEMPERATURE_GROUP_HINTS[key] }}
            </p>
          </div>

          <div class="temp-range-layout">
            <input
              type="number"
              class="input input-bordered input-xs temp-range-layout__input font-mono"
              :min="TEMPERATURE_RANGE_BOUNDS.min"
              :max="config[key].max"
              :step="TEMPERATURE_RANGE_BOUNDS.step"
              :value="config[key].min"
              aria-label="最低温度"
              @change="syncRange(key, 'min', Number(($event.target as HTMLInputElement).value))"
            />

            <div class="temp-range-layout__track">
              <DualTemperatureSlider
                :min="config[key].min"
                :max="config[key].max"
                @update:min="onSliderMin(key, $event)"
                @update:max="onSliderMax(key, $event)"
              />
            </div>

            <input
              type="number"
              class="input input-bordered input-xs temp-range-layout__input font-mono"
              :min="config[key].min"
              :max="TEMPERATURE_RANGE_BOUNDS.max"
              :step="TEMPERATURE_RANGE_BOUNDS.step"
              :value="config[key].max"
              aria-label="最高温度"
              @change="syncRange(key, 'max', Number(($event.target as HTMLInputElement).value))"
            />

            <div class="temp-range-layout__scale">
              <span>{{ TEMPERATURE_RANGE_BOUNDS.min }}</span>
              <span>{{ TEMPERATURE_RANGE_BOUNDS.max }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="shrink-0 flex items-center justify-between gap-3 pt-3 border-t border-base-300/60">
      <button type="button" class="btn btn-ghost btn-sm" @click="resetDefaults">
        恢复默认
      </button>
      <span class="text-xs text-base-content/50">
        <span v-if="saving">保存中…</span>
        <span v-else-if="saveHint" class="text-success">{{ saveHint }}</span>
        <span v-else>修改后自动保存</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.temp-range-layout {
  display: grid;
  grid-template-columns: 3.25rem 1fr 3.25rem;
  grid-template-rows: auto auto;
  column-gap: 0.75rem;
  row-gap: 0.25rem;
  align-items: center;
}

.temp-range-layout__input {
  grid-row: 1;
  width: 3.25rem;
  height: 2rem;
  min-height: 2rem;
  padding-left: 0.25rem;
  padding-right: 0.25rem;
  text-align: center;
}

.temp-range-layout__input:first-of-type {
  grid-column: 1;
}

.temp-range-layout__input:last-of-type {
  grid-column: 3;
}

.temp-range-layout__track {
  grid-column: 2;
  grid-row: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  height: 2rem;
}

.temp-range-layout__scale {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  justify-content: space-between;
  padding: 0 0.125rem;
  font-size: 0.625rem;
  line-height: 1;
  color: color-mix(in oklch, var(--color-base-content) 40%, transparent);
}
</style>
