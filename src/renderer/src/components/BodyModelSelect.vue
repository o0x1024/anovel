<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { AssistantModelOption } from '../../../shared/assistant-types'
import { assistantModelLabel, ASSISTANT_MODEL_LABELS } from '../services/assistantSession'
import { isSameBodyModelOption } from '../composables/useBodyGenerationModel'
import { useModelConfigChangeSync } from '../composables/useModelConfigChangeSync'

const modelType = defineModel<string | null>('modelType', { default: null })
const modelName = defineModel<string | null>('modelName', { default: null })

const modelOptions = ref<AssistantModelOption[]>([])
const globalDefault = ref<{ provider: string | null; modelName: string | null }>({
  provider: null,
  modelName: null
})
const loading = ref(false)
const open = ref(false)
const query = ref('')
const rootRef = ref<HTMLElement | null>(null)

function providerLabel(option: AssistantModelOption): string {
  return option.provider_label ?? ASSISTANT_MODEL_LABELS[option.model_type] ?? option.model_type
}

function optionSearchText(option: AssistantModelOption): string {
  return `${providerLabel(option)} ${option.model_type} ${option.model_name}`.toLowerCase()
}

const groupedModelOptions = computed(() => {
  const order: string[] = []
  const groups = new Map<string, AssistantModelOption[]>()
  const labelByType = new Map<string, string>()
  for (const option of modelOptions.value) {
    if (!groups.has(option.model_type)) {
      order.push(option.model_type)
      groups.set(option.model_type, [])
      labelByType.set(option.model_type, providerLabel(option))
    }
    groups.get(option.model_type)!.push(option)
  }
  return order.map(type => ({
    modelType: type,
    providerLabel: labelByType.get(type)!,
    options: groups.get(type)!
  }))
})

const filteredFlatOptions = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return modelOptions.value
  return modelOptions.value.filter(opt => optionSearchText(opt).includes(q))
})

const showGrouped = computed(() => !query.value.trim())

const effectiveType = computed(() => modelType.value ?? globalDefault.value.provider)
const effectiveName = computed(() => modelName.value ?? globalDefault.value.modelName)

const currentLabel = computed(() => {
  const type = effectiveType.value
  if (!type) return '未配置模型'
  const active = modelOptions.value.find(opt =>
    opt.model_type === type && opt.model_name === (effectiveName.value ?? '')
  ) ?? modelOptions.value.find(opt => opt.model_type === type)
  return assistantModelLabel(type, effectiveName.value, {
    showProvider: true,
    providerLabel: active?.provider_label
  })
})

function isGlobalDefaultOption(option: AssistantModelOption): boolean {
  if (!globalDefault.value.provider) return false
  if (option.model_type !== globalDefault.value.provider) return false
  const globalName = globalDefault.value.modelName?.trim()
  if (globalName) return option.model_name === globalName
  const firstOfProvider = modelOptions.value.find(opt => opt.model_type === globalDefault.value.provider)
  return firstOfProvider?.model_name === option.model_name
}

function isOptionActive(option: AssistantModelOption): boolean {
  if (modelType.value) {
    return isSameBodyModelOption(modelType.value, modelName.value, option)
  }
  return isGlobalDefaultOption(option)
}

function selectOption(option: AssistantModelOption) {
  if (isGlobalDefaultOption(option) && !modelType.value) {
    closeDropdown()
    return
  }
  if (isGlobalDefaultOption(option)) {
    modelType.value = null
    modelName.value = null
  } else {
    modelType.value = option.model_type
    modelName.value = option.model_name
  }
  closeDropdown()
}

function openDropdown() {
  if (loading.value || modelOptions.value.length === 0) return
  open.value = true
  query.value = ''
}

function closeDropdown() {
  open.value = false
  query.value = ''
}

function onDocumentPointerDown(e: PointerEvent) {
  if (!open.value) return
  const root = rootRef.value
  if (root && !root.contains(e.target as Node)) {
    closeDropdown()
  }
}

watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('pointerdown', onDocumentPointerDown, true)
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerDown, true)
  }
})

let reloadTimer: ReturnType<typeof setTimeout> | null = null

async function loadOptions() {
  loading.value = true
  try {
    const [options, global] = await Promise.all([
      window.anovel.invoke('model:listAssistantOptions') as Promise<AssistantModelOption[]>,
      window.anovel.invoke('model:getGlobalDefault') as Promise<{ provider: string | null; modelName: string | null }>
    ])
    modelOptions.value = options
    globalDefault.value = global
    if (modelType.value && !options.some(opt =>
      isSameBodyModelOption(modelType.value, modelName.value, opt)
    )) {
      modelType.value = null
      modelName.value = null
    }
  } finally {
    loading.value = false
  }
}

function scheduleLoadOptions() {
  if (reloadTimer) clearTimeout(reloadTimer)
  reloadTimer = setTimeout(() => { void loadOptions() }, 150)
}

onMounted(() => { void loadOptions() })
useModelConfigChangeSync(scheduleLoadOptions)
onUnmounted(() => {
  if (reloadTimer) clearTimeout(reloadTimer)
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})

watch(modelOptions, () => {
  if (modelType.value && !modelOptions.value.some(opt =>
    isSameBodyModelOption(modelType.value, modelName.value, opt)
  )) {
    modelType.value = null
    modelName.value = null
  }
})
</script>

<template>
  <div ref="rootRef" class="relative inline-block max-w-[min(100vw-12rem,480px)]">
    <button
      type="button"
      class="select select-bordered select-xs w-auto max-w-full text-left inline-flex items-center gap-1.5 min-h-0 h-8 px-3"
      :class="{ 'opacity-50 cursor-not-allowed': loading || modelOptions.length === 0 }"
      :disabled="loading || modelOptions.length === 0"
      :title="currentLabel"
      @click="open ? closeDropdown() : openDropdown()"
    >
      <span class="text-xs whitespace-nowrap">{{ currentLabel }}</span>
      <font-awesome-icon
        :icon="open ? 'chevron-up' : 'chevron-down'"
        class="w-2.5 h-2.5 shrink-0 opacity-40"
      />
    </button>

    <div
      v-if="open"
      class="absolute right-0 z-30 mt-1 w-max min-w-full max-w-[min(100vw-2rem,480px)] rounded-lg border border-base-300 bg-base-100 shadow-lg overflow-hidden"
    >
      <div class="p-2 border-b border-base-300/60">
        <label class="input input-bordered input-xs flex items-center gap-2 w-full">
          <font-awesome-icon icon="magnifying-glass" class="w-3 h-3 opacity-40 shrink-0" />
          <input
            v-model="query"
            type="text"
            class="grow bg-transparent text-xs min-w-0"
            placeholder="搜索模型或提供商…"
            autofocus
            @keydown.escape.prevent="closeDropdown"
            @keydown.enter.prevent="filteredFlatOptions[0] && selectOption(filteredFlatOptions[0])"
          />
        </label>
        <p class="text-[11px] text-base-content/40 mt-1 px-0.5">
          共 {{ modelOptions.length }} 个，匹配 {{ filteredFlatOptions.length }} 个
        </p>
      </div>

      <ul class="menu menu-sm max-h-60 overflow-y-auto p-1">
        <template v-if="showGrouped">
          <template v-for="group in groupedModelOptions" :key="group.modelType">
            <li class="menu-title px-3 pt-2 pb-0.5 pointer-events-none">
              <span class="text-[11px] font-semibold tracking-wide text-base-content/45">
                {{ group.providerLabel }}
              </span>
            </li>
            <li v-for="option in group.options" :key="`${option.model_type}:${option.model_name}`">
              <button
                type="button"
                class="text-xs whitespace-nowrap gap-2"
                :class="{ active: isOptionActive(option) }"
                @click="selectOption(option)"
              >
                <span class="font-mono">{{ option.model_name }}</span>
                <span
                  v-if="isGlobalDefaultOption(option)"
                  class="badge badge-ghost badge-xs shrink-0"
                >
                  默认
                </span>
              </button>
            </li>
          </template>
        </template>
        <template v-else>
          <li v-for="option in filteredFlatOptions" :key="`${option.model_type}:${option.model_name}`">
            <button
              type="button"
              class="text-xs whitespace-nowrap gap-2"
              :class="{ active: isOptionActive(option) }"
              @click="selectOption(option)"
            >
              <span class="text-base-content/45 shrink-0">{{ providerLabel(option) }}</span>
              <span class="font-mono">{{ option.model_name }}</span>
              <span
                v-if="isGlobalDefaultOption(option)"
                class="badge badge-ghost badge-xs shrink-0"
              >
                默认
              </span>
            </button>
          </li>
        </template>
        <li v-if="filteredFlatOptions.length === 0">
          <span class="text-base-content/40 text-xs px-3 py-2">无匹配模型</span>
        </li>
      </ul>
    </div>
  </div>
</template>
