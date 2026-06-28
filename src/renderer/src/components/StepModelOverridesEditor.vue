<script setup lang="ts">
import { ref, computed, onMounted, watch, onUnmounted } from 'vue'
import { STEP_MODEL_GROUPS, type StepModelGroupDef } from '../../../shared/step-model-config'
import type { AssistantModelOption } from '../../../shared/assistant-types'
import { ASSISTANT_MODEL_LABELS } from '../services/assistantSession'
import { useModelConfigChangeSync } from '../composables/useModelConfigChangeSync'
import { toPlainForIpc } from '../../../shared/ipc-plain'

interface StepModelOverride {
  provider: string
  modelName: string
  thinkingEnabled?: boolean
}

const props = withDefaults(defineProps<{
  highlightSteps?: string[]
}>(), {
  highlightSteps: () => []
})

const overrides = ref<Record<string, StepModelOverride>>({})
const modelOptions = ref<AssistantModelOption[]>([])
const globalDefault = ref<{ provider: string | null; modelName: string | null }>({
  provider: null, modelName: null
})
const loading = ref(true)
const dirty = ref(false)
const collapsedGroups = ref<Set<string>>(new Set())

let saveTimer: ReturnType<typeof setTimeout> | null = null
let reloadTimer: ReturnType<typeof setTimeout> | null = null

function providerLabel(option: AssistantModelOption): string {
  return option.provider_label ?? ASSISTANT_MODEL_LABELS[option.model_type] ?? option.model_type
}

interface ProviderGroup {
  type: string
  label: string
  models: string[]
}

const providerGroups = computed((): ProviderGroup[] => {
  const order: string[] = []
  const map = new Map<string, { label: string; models: string[] }>()
  for (const opt of modelOptions.value) {
    if (!map.has(opt.model_type)) {
      order.push(opt.model_type)
      map.set(opt.model_type, { label: providerLabel(opt), models: [] })
    }
    map.get(opt.model_type)!.models.push(opt.model_name)
  }
  return order.map(type => ({
    type,
    label: map.get(type)!.label,
    models: map.get(type)!.models
  }))
})

function getModelsForProvider(providerType: string): string[] {
  return providerGroups.value.find(g => g.type === providerType)?.models ?? []
}

function getProviderLabel(providerType: string): string {
  return providerGroups.value.find(g => g.type === providerType)?.label ?? providerType
}

function globalDefaultLabel(): string {
  if (!globalDefault.value.provider) return '未配置'
  const label = getProviderLabel(globalDefault.value.provider)
  return globalDefault.value.modelName
    ? `${label} · ${globalDefault.value.modelName}`
    : label
}

function stepOverride(step: string): StepModelOverride | undefined {
  return overrides.value[step]
}

function stepDisplayLabel(step: string): string {
  const ov = stepOverride(step)
  if (!ov) return ''
  const label = getProviderLabel(ov.provider)
  return `${label} · ${ov.modelName}`
}

function setStepProvider(step: string, providerType: string) {
  const models = getModelsForProvider(providerType).filter(m => m.trim())
  if (!models.length) {
    console.warn('[StepModelOverrides] provider has no models:', providerType)
    return
  }
  const existing = overrides.value[step]
  overrides.value = {
    ...overrides.value,
    [step]: {
      provider: providerType,
      modelName: existing?.provider === providerType && existing?.modelName?.trim()
        ? existing.modelName
        : models[0],
      thinkingEnabled: existing?.thinkingEnabled
    }
  }
  scheduleSave()
}

function setStepModel(step: string, modelName: string) {
  const existing = overrides.value[step]
  if (!existing) return
  overrides.value = {
    ...overrides.value,
    [step]: { ...existing, modelName }
  }
  scheduleSave()
}

function setStepThinking(step: string, enabled: boolean) {
  const existing = overrides.value[step]
  if (!existing) return
  overrides.value = {
    ...overrides.value,
    [step]: { ...existing, thinkingEnabled: enabled }
  }
  scheduleSave()
}

function clearStep(step: string) {
  const copy = { ...overrides.value }
  delete copy[step]
  overrides.value = copy
  scheduleSave()
}

function batchSetGroup(group: StepModelGroupDef, providerType: string) {
  const models = getModelsForProvider(providerType).filter(m => m.trim())
  if (!models.length) {
    console.warn('[StepModelOverrides] provider has no models:', providerType)
    return
  }
  const modelName = models[0]
  const copy = { ...overrides.value }
  for (const s of group.steps) {
    copy[s.step] = { provider: providerType, modelName }
  }
  overrides.value = copy
  scheduleSave()
}

function clearGroup(group: StepModelGroupDef) {
  const copy = { ...overrides.value }
  for (const s of group.steps) {
    delete copy[s.step]
  }
  overrides.value = copy
  scheduleSave()
}

function toggleGroup(groupLabel: string) {
  const next = new Set(collapsedGroups.value)
  if (next.has(groupLabel)) {
    next.delete(groupLabel)
  } else {
    next.add(groupLabel)
  }
  collapsedGroups.value = next
}

function groupOverrideCount(group: StepModelGroupDef): number {
  return group.steps.filter(s => !!overrides.value[s.step]).length
}

const batchProviderForGroup = ref<Record<string, string>>({})

async function loadProviderData() {
  const [options, global] = await Promise.all([
    window.anovel.invoke('model:listAssistantOptions') as Promise<AssistantModelOption[]>,
    window.anovel.invoke('model:getGlobalDefault') as Promise<{ provider: string | null; modelName: string | null }>
  ])
  modelOptions.value = options
  globalDefault.value = global
}

async function loadOverrideData() {
  const saved = await window.anovel.invoke('model:getStepModelOverrides') as Record<string, StepModelOverride>
  overrides.value = saved ?? {}
}

async function loadData() {
  loading.value = true
  try {
    await Promise.all([loadProviderData(), loadOverrideData()])
    dirty.value = false
  } finally {
    loading.value = false
  }
}

function scheduleSave() {
  dirty.value = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void persistOverrides() }, 300)
}

function overridesPayload(): Record<string, StepModelOverride> {
  const plain = toPlainForIpc(overrides.value) as Record<string, StepModelOverride>
  const clean: Record<string, StepModelOverride> = {}
  for (const [step, val] of Object.entries(plain)) {
    const provider = val?.provider?.trim()
    const modelName = val?.modelName?.trim()
    if (!provider || !modelName) continue
    clean[step] = {
      provider,
      modelName,
      ...(typeof val.thinkingEnabled === 'boolean' ? { thinkingEnabled: val.thinkingEnabled } : {})
    }
  }
  return clean
}

async function persistOverrides() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    const payload = overridesPayload()
    const saved = await window.anovel.invoke('model:setStepModelOverrides', payload) as Record<string, StepModelOverride>
    overrides.value = saved ?? payload
    dirty.value = false
  } catch (e) {
    console.error('[StepModelOverrides] save failed:', e)
  }
}

function scheduleReload() {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => {
    void (async () => {
      await loadProviderData()
      if (!dirty.value) {
        await loadOverrideData()
      }
    })()
  }, 200)
}

onMounted(() => { void loadData() })
useModelConfigChangeSync(scheduleReload)
onUnmounted(() => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
    void persistOverrides()
  }
  if (reloadTimer) clearTimeout(reloadTimer)
})

// auto-expand group containing highlighted steps
watch(() => props.highlightSteps, (steps) => {
  if (!steps.length) return
  const next = new Set(collapsedGroups.value)
  for (const group of STEP_MODEL_GROUPS) {
    if (group.steps.some(s => steps.includes(s.step))) {
      next.delete(group.groupLabel)
    }
  }
  collapsedGroups.value = next
}, { immediate: true })
</script>

<template>
  <div v-if="loading" class="flex items-center gap-2 text-sm text-base-content/50 py-4">
    <span class="loading loading-spinner loading-xs text-primary"></span>
    加载步骤模型配置…
  </div>
  <div v-else-if="providerGroups.length === 0" class="text-sm text-base-content/50 py-4">
    请先在 AI 服务中配置并启用至少一个提供商
  </div>
  <div v-else class="space-y-3">
    <div class="flex items-center gap-2 text-xs text-base-content/50 mb-1">
      <font-awesome-icon icon="info-circle" class="w-3 h-3 shrink-0" />
      <span>未配置的步骤将使用全局默认：<strong class="text-base-content/70">{{ globalDefaultLabel() }}</strong></span>
    </div>

    <div
      v-for="group in STEP_MODEL_GROUPS"
      :key="group.groupLabel"
      class="border border-base-300/60 rounded-lg overflow-hidden"
    >
      <!-- group header -->
      <div
        class="flex items-center gap-2 px-3 py-2 bg-base-200/60 cursor-pointer select-none"
        @click="toggleGroup(group.groupLabel)"
      >
        <font-awesome-icon
          :icon="collapsedGroups.has(group.groupLabel) ? 'chevron-right' : 'chevron-down'"
          class="w-3 h-3 text-base-content/40 shrink-0"
        />
        <span class="text-sm font-semibold flex-1">{{ group.groupLabel }}</span>
        <span
          v-if="groupOverrideCount(group) > 0"
          class="badge badge-primary badge-xs"
        >
          {{ groupOverrideCount(group) }}/{{ group.steps.length }}
        </span>

        <!-- batch set controls -->
        <div class="flex items-center gap-1" @click.stop>
          <select
            :value="batchProviderForGroup[group.groupLabel] ?? ''"
            class="select select-bordered select-xs text-xs h-6 min-h-0"
            @change="(e: Event) => { batchProviderForGroup[group.groupLabel] = (e.target as HTMLSelectElement).value }"
          >
            <option value="" disabled>批量设置…</option>
            <option v-for="pg in providerGroups" :key="pg.type" :value="pg.type">
              {{ pg.label }}
            </option>
          </select>
          <button
            type="button"
            class="btn btn-ghost btn-xs h-6 min-h-0 px-1.5"
            :disabled="!batchProviderForGroup[group.groupLabel]"
            title="将该组所有步骤设为选中的提供商"
            @click.stop="batchProviderForGroup[group.groupLabel] && batchSetGroup(group, batchProviderForGroup[group.groupLabel])"
          >
            <font-awesome-icon icon="check" class="w-3 h-3" />
          </button>
          <button
            v-if="groupOverrideCount(group) > 0"
            type="button"
            class="btn btn-ghost btn-xs h-6 min-h-0 px-1.5 text-error/60"
            title="清除该组所有步骤配置"
            @click.stop="clearGroup(group)"
          >
            <font-awesome-icon icon="xmark" class="w-3 h-3" />
          </button>
        </div>
      </div>

      <!-- step rows -->
      <div v-if="!collapsedGroups.has(group.groupLabel)" class="divide-y divide-base-300/40">
        <div
          v-for="s in group.steps"
          :key="s.step"
          class="flex items-center gap-2 px-3 py-1.5 text-xs"
          :class="{
            'bg-primary/5': highlightSteps.includes(s.step),
            'bg-base-100': !highlightSteps.includes(s.step)
          }"
        >
          <!-- step label -->
          <span class="w-28 shrink-0 truncate font-medium" :title="s.step">{{ s.label }}</span>

          <!-- provider select -->
          <select
            :value="stepOverride(s.step)?.provider ?? ''"
            class="select select-bordered select-xs flex-1 min-w-0 text-xs h-7 min-h-0"
            @change="(e: Event) => {
              const val = (e.target as HTMLSelectElement).value
              if (val) setStepProvider(s.step, val)
              else clearStep(s.step)
            }"
          >
            <option value="">跟随全局</option>
            <option v-for="pg in providerGroups" :key="pg.type" :value="pg.type">
              {{ pg.label }}
            </option>
          </select>

          <!-- model select -->
          <select
            v-if="stepOverride(s.step)"
            :value="stepOverride(s.step)?.modelName ?? ''"
            class="select select-bordered select-xs flex-1 min-w-0 text-xs font-mono h-7 min-h-0"
            @change="(e: Event) => setStepModel(s.step, (e.target as HTMLSelectElement).value)"
          >
            <option
              v-for="m in getModelsForProvider(stepOverride(s.step)!.provider)"
              :key="m"
              :value="m"
            >
              {{ m }}
            </option>
          </select>
          <span v-else class="flex-1 text-base-content/30 truncate">—</span>

          <!-- thinking toggle -->
          <label
            v-if="stepOverride(s.step)"
            class="flex items-center gap-1 cursor-pointer shrink-0"
            title="思考模式"
          >
            <font-awesome-icon icon="brain" class="w-3 h-3 text-base-content/40" />
            <input
              type="checkbox"
              class="toggle toggle-primary toggle-xs"
              :checked="stepOverride(s.step)?.thinkingEnabled ?? false"
              @change="(e: Event) => setStepThinking(s.step, (e.target as HTMLInputElement).checked)"
            />
          </label>

          <!-- clear button -->
          <button
            v-if="stepOverride(s.step)"
            type="button"
            class="btn btn-ghost btn-xs h-6 min-h-0 w-6 px-0 text-error/50"
            title="清除此步骤配置"
            @click="clearStep(s.step)"
          >
            <font-awesome-icon icon="xmark" class="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
