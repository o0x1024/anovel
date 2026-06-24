<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: string[]
    disabled?: boolean
    placeholder?: string
    emptyText?: string
    allowCustom?: boolean
  }>(),
  {
    disabled: false,
    placeholder: '搜索或选择模型…',
    emptyText: '无匹配模型',
    allowCustom: true
  }
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const open = ref(false)
const query = ref('')
const rootRef = ref<HTMLElement | null>(null)

const filteredOptions = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.options
  return props.options.filter(opt => opt.toLowerCase().includes(q))
})

const displayLabel = computed(() => props.modelValue || props.placeholder)

watch(
  () => props.options,
  () => {
    if (open.value) query.value = ''
  }
)

function openDropdown() {
  if (props.disabled) return
  open.value = true
  query.value = ''
}

function closeDropdown() {
  open.value = false
  query.value = ''
}

function selectOption(value: string) {
  emit('update:modelValue', value)
  closeDropdown()
}

function handleEnter() {
  const q = query.value.trim()
  if (props.allowCustom && q && !props.options.includes(q)) {
    selectOption(q)
    return
  }
  if (filteredOptions.value[0]) {
    selectOption(filteredOptions.value[0])
  }
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

onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true)
})
</script>

<template>
  <div ref="rootRef" class="relative w-full">
    <button
      type="button"
      class="select select-bordered w-full text-sm font-mono text-left flex items-center gap-2"
      :class="{ 'opacity-50 cursor-not-allowed': disabled }"
      :disabled="disabled"
      @click="open ? closeDropdown() : openDropdown()"
    >
      <span class="truncate flex-1" :class="modelValue ? '' : 'text-base-content/40'">
        {{ displayLabel }}
      </span>
      <font-awesome-icon
        :icon="open ? 'chevron-up' : 'chevron-down'"
        class="w-3 h-3 shrink-0 opacity-50"
      />
    </button>

    <div
      v-if="open"
      class="absolute z-30 mt-1 w-full rounded-lg border border-base-300 bg-base-100 shadow-lg overflow-hidden"
    >
      <div class="p-2 border-b border-base-300/60">
        <label class="input input-bordered input-sm flex items-center gap-2 w-full">
          <font-awesome-icon icon="magnifying-glass" class="w-3.5 h-3.5 opacity-40 shrink-0" />
          <input
            v-model="query"
            type="text"
            class="grow bg-transparent font-mono text-sm min-w-0"
            placeholder="输入关键词筛选…"
            autofocus
            @keydown.escape.prevent="closeDropdown"
            @keydown.enter.prevent="handleEnter"
          />
        </label>
        <p class="text-xs text-base-content/40 mt-1 px-0.5">
          共 {{ options.length }} 个，匹配 {{ filteredOptions.length }} 个
        </p>
      </div>
      <ul class="menu menu-sm max-h-52 overflow-y-auto p-1">
        <li v-if="allowCustom && query.trim() && !options.includes(query.trim())">
          <button
            type="button"
            class="font-mono text-xs text-primary font-bold"
            @click="selectOption(query.trim())"
          >
            <font-awesome-icon icon="plus" class="w-3 h-3 mr-1" />
            手动输入: {{ query.trim() }}
          </button>
        </li>
        <li v-for="opt in filteredOptions" :key="opt">
          <button
            type="button"
            class="font-mono text-xs"
            :class="{ 'active': opt === modelValue }"
            @click="selectOption(opt)"
          >
            {{ opt }}
          </button>
        </li>
        <li v-if="filteredOptions.length === 0">
          <span class="text-base-content/40 text-xs px-3 py-2">{{ emptyText }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>
