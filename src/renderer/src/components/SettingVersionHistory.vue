<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'

const props = defineProps<{
  workId: number
  type: string
}>()

const emit = defineEmits<{
  restored: []
}>()

interface SettingVersion {
  id: number
  version_number: number
  content: string
  create_time: string
}

const updateTime = ref<string | null>(null)
const versions = ref<SettingVersion[]>([])
const showVersions = ref(false)
const restoringId = ref<number | null>(null)

onMounted(load)
watch(() => [props.workId, props.type], load)

async function load() {
  const meta = await window.anovel.invoke('setting:getMeta', props.workId, props.type) as {
    updateTime: string | null
    hasContent: boolean
  }
  updateTime.value = meta.updateTime
  versions.value = await window.anovel.invoke('setting:versionList', props.workId, props.type) as SettingVersion[]
}

defineExpose({ load })

function formatTime(time: string | null): string {
  if (!time) return '尚未修改'
  return time.replace('T', ' ').slice(0, 16)
}

function versionSummary(content: string): string {
  if (props.type === 'character_cards') {
    try {
      const parsed = JSON.parse(content) as { cards?: unknown[] }
      const count = Array.isArray(parsed.cards) ? parsed.cards.length : 0
      return `${count} 张卡片`
    } catch {
      return '人设卡片'
    }
  }
  const charCount = content.replace(/\s/g, '').length
  const firstLine = content.split('\n').find(line => line.trim())?.trim() ?? ''
  const plain = firstLine.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()
  if (plain) {
    return plain.length > 24 ? `${plain.slice(0, 24)}… · ${charCount} 字` : `${plain} · ${charCount} 字`
  }
  return `${charCount} 字`
}

async function restoreVersion(version: SettingVersion) {
  if (restoringId.value != null) return
  if (!confirm(`恢复版本 v${version.version_number}？当前内容会先保存到版本历史。`)) return
  restoringId.value = version.id
  try {
    const ok = await window.anovel.invoke(
      'setting:restoreVersion',
      props.workId,
      props.type,
      version.id
    ) as boolean
    if (ok) {
      await load()
      emit('restored')
    }
  } finally {
    restoringId.value = null
  }
}
</script>

<template>
  <div class="mt-2 pt-2 border-t border-base-300/40">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <span class="text-xs text-base-content/50">最近修改 {{ formatTime(updateTime) }}</span>
      <button
        type="button"
        class="btn btn-ghost btn-xs gap-1 normal-case font-normal"
        :disabled="versions.length === 0"
        @click="showVersions = !showVersions"
      >
        版本历史
        <span v-if="versions.length" class="text-base-content/40">({{ versions.length }})</span>
        <font-awesome-icon :icon="showVersions ? 'chevron-up' : 'chevron-down'" class="w-3 h-3 opacity-50" />
      </button>
    </div>

    <div v-if="showVersions && versions.length" class="mt-2 space-y-1 max-h-40 overflow-auto">
      <div
        v-for="ver in versions"
        :key="ver.id"
        class="flex items-center justify-between gap-2 text-xs bg-base-100 rounded px-2 py-1.5"
      >
        <div class="min-w-0">
          <span class="font-medium">v{{ ver.version_number }}</span>
          <span class="text-base-content/40 mx-1">·</span>
          <span class="text-base-content/50">{{ formatTime(ver.create_time) }}</span>
          <p class="text-base-content/60 truncate mt-0.5">{{ versionSummary(ver.content) }}</p>
        </div>
        <button
          type="button"
          class="btn btn-outline btn-primary btn-xs shrink-0"
          :disabled="restoringId === ver.id"
          @click="restoreVersion(ver)"
        >
          {{ restoringId === ver.id ? '恢复中...' : '恢复' }}
        </button>
      </div>
    </div>
    <p v-else-if="showVersions" class="text-xs text-base-content/40 mt-2 italic">暂无历史版本</p>
  </div>
</template>
