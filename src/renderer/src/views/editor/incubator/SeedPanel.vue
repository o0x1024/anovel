<script setup lang="ts">
import { inject, ref, watch, onBeforeUnmount, type Ref } from 'vue'
import { incubatorSeedTextKey, incubatorStateKey } from './incubator-context'

const emit = defineEmits<{ saved: [] }>()

const incubator = inject(incubatorStateKey)!
const seedText = inject(incubatorSeedTextKey) as Ref<string>

const saveState = ref<'idle' | 'saving' | 'saved'>('idle')
let timer: ReturnType<typeof setTimeout> | null = null
let skipNextWatch = false

function schedulePersist() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void persist(seedText.value), 800)
}

watch(
  () => seedText.value,
  () => {
    if (skipNextWatch) return
    schedulePersist()
  }
)

async function persist(content: string) {
  const trimmed = content.trim()
  saveState.value = 'saving'
  try {
    await incubator.setSeed(trimmed)
    saveState.value = 'saved'
    emit('saved')
    setTimeout(() => {
      if (saveState.value === 'saved') saveState.value = 'idle'
    }, 2000)
  } catch {
    saveState.value = 'idle'
  }
}

/** 父组件载入作品数据时调用，避免触发重复保存 */
function setSeedFromLoad(value: string) {
  skipNextWatch = true
  seedText.value = value
  queueMicrotask(() => {
    skipNextWatch = false
  })
}

defineExpose({ setSeedFromLoad })

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  if (seedText.value.trim()) void persist(seedText.value)
})
</script>

<template>
  <div class="card bg-base-200 border border-base-300 shadow-sm p-4">
    <div class="flex items-center justify-between gap-2 mb-2 flex-wrap">
      <label class="text-xs font-medium text-base-content/60">创作种子（稳定保留）</label>
      <span v-if="incubator.workspace" class="badge badge-outline badge-sm">
        {{ incubator.workspace.state }}
      </span>
    </div>
    <textarea
      v-model="seedText"
      rows="4"
      class="textarea textarea-bordered w-full mb-2 resize-none text-sm"
      placeholder="一句话想法：主角是谁、面对什么、最想写什么…"
      @blur="persist(seedText)"
    />
    <p class="text-xs text-base-content/40 min-h-[1rem]">
      <span v-if="saveState === 'saving'">正在保存...</span>
      <span v-else-if="saveState === 'saved'" class="text-success">已保存</span>
      <span v-else-if="seedText.trim()">编辑后自动保存</span>
    </p>
  </div>
</template>
