<script setup lang="ts">
import { ref, onMounted } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'

const props = defineProps<{ workId: number }>()

interface TasteProfile {
  id: number
  profile_name: string
  reject_patterns: string | null
  pacing_preferences: string | null
  plot_preferences: string | null
  character_preferences: string | null
  is_default: number
}

interface RejectPattern {
  reason: string
  label: string
  count: number
}

const profiles = ref<TasteProfile[]>([])
const boundProfileId = ref<number | null>(null)
const showCreate = ref(false)
const newName = ref('')
const importJson = ref('')
const exporting = ref(false)
const confirmDeleteProfile = ref(false)

onMounted(load)

async function load() {
  profiles.value = await window.anovel.invoke('taste:list') as TasteProfile[]
  const bound = await window.anovel.invoke('taste:getByWork', props.workId) as TasteProfile | null
  boundProfileId.value = bound?.id ?? null
  if (profiles.value.length === 0) {
    const id = await window.anovel.invoke('taste:create', { profile_name: '默认品味', is_default: true }) as number
    await window.anovel.invoke('taste:bindToWork', props.workId, id)
    await load()
  }
}

function parseRejects(raw: string | null): RejectPattern[] {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

async function bindProfile() {
  if (boundProfileId.value) {
    await window.anovel.invoke('taste:bindToWork', props.workId, boundProfileId.value)
  }
}

async function createProfile() {
  if (!newName.value.trim()) return
  const id = await window.anovel.invoke('taste:create', { profile_name: newName.value.trim() }) as number
  newName.value = ''
  showCreate.value = false
  boundProfileId.value = id
  await bindProfile()
  await load()
}

async function exportProfile() {
  if (!boundProfileId.value) return
  exporting.value = true
  try {
    const json = await window.anovel.invoke('taste:export', boundProfileId.value) as string
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'taste-profile.json'
    a.click()
    URL.revokeObjectURL(url)
  } finally {
    exporting.value = false
  }
}

async function deleteProfile() {
  if (!boundProfileId.value) return
  await window.anovel.invoke('taste:delete', boundProfileId.value)
  boundProfileId.value = null
  confirmDeleteProfile.value = false
  await load()
}

async function removeRejectPattern(reason: string) {
  const profile = boundProfile()
  if (!profile) return
  const patterns = parseRejects(profile.reject_patterns).filter(p => p.reason !== reason)
  await window.anovel.invoke('taste:update', profile.id, {
    reject_patterns: JSON.stringify(patterns)
  })
  await load()
}

async function importProfile() {
  if (!importJson.value.trim()) return
  const id = await window.anovel.invoke('taste:import', importJson.value, props.workId) as number
  boundProfileId.value = id
  importJson.value = ''
  await load()
}

const boundProfile = () => profiles.value.find(p => p.id === boundProfileId.value)
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="gem" title="创作者品味档案" />
    <p class="text-sm text-base-content/50 mb-4">
      系统记录你的否决原因与选择偏好，自动注入 AI 生成。否决重试时会自动学习。
    </p>

    <div class="card bg-base-200 border border-base-300 p-4 mb-4 space-y-3">
      <div>
        <label class="text-xs text-base-content/50">绑定到本作品</label>
        <select v-model="boundProfileId" class="select select-bordered select-sm w-full mt-1" @change="bindProfile">
          <option v-for="p in profiles" :key="p.id" :value="p.id">
            {{ p.profile_name }}{{ p.is_default ? '（默认）' : '' }}
          </option>
        </select>
      </div>
      <div class="flex flex-wrap gap-2">
        <button class="btn btn-outline btn-primary btn-xs" @click="showCreate = !showCreate">新建档案</button>
        <button class="btn btn-outline btn-xs" :disabled="exporting" @click="exportProfile">导出 JSON</button>
        <button
          v-if="boundProfileId"
          class="btn btn-outline btn-error btn-xs"
          @click="confirmDeleteProfile = true"
        >删除档案</button>
      </div>
      <div v-if="confirmDeleteProfile" class="alert alert-warning text-sm py-2 px-3 mt-1">
        <span>确认删除「{{ boundProfile()?.profile_name }}」？此操作不可撤销。</span>
        <div class="flex gap-1 ml-auto">
          <button class="btn btn-error btn-xs" @click="deleteProfile">确认删除</button>
          <button class="btn btn-ghost btn-xs" @click="confirmDeleteProfile = false">取消</button>
        </div>
      </div>
      <div v-if="showCreate" class="flex gap-2">
        <input v-model="newName" class="input input-bordered input-sm flex-1" placeholder="档案名称" />
        <button class="btn btn-primary btn-xs" @click="createProfile">创建</button>
      </div>
    </div>

    <div v-if="boundProfile()" class="card bg-base-200 border border-base-300 p-4 mb-4">
      <h4 class="font-semibold text-sm mb-2">高频否决模式</h4>
      <div v-if="parseRejects(boundProfile()!.reject_patterns).length === 0" class="text-sm text-base-content/40">
        暂无记录，使用「否决重试」后会自动积累
      </div>
      <ul v-else class="space-y-1">
        <li
          v-for="r in parseRejects(boundProfile()!.reject_patterns)"
          :key="r.reason"
          class="flex items-center justify-between text-sm group"
        >
          <span class="truncate mr-2">{{ r.label || r.reason }}</span>
          <span class="flex items-center gap-1 shrink-0">
            <span class="badge badge-ghost badge-sm">{{ r.count }} 次</span>
            <button
              class="btn btn-ghost btn-xs opacity-0 group-hover:opacity-100 transition-opacity text-error px-1"
              title="删除此条记录"
              @click="removeRejectPattern(r.reason)"
            >✕</button>
          </span>
        </li>
      </ul>
    </div>

    <div class="card bg-base-200 border border-base-300 p-4">
      <h4 class="font-semibold text-sm mb-2">导入品味档案</h4>
      <textarea v-model="importJson" rows="4" class="textarea textarea-bordered textarea-sm w-full mb-2" placeholder="粘贴导出的 JSON..." />
      <button class="btn btn-primary btn-sm" :disabled="!importJson.trim()" @click="importProfile">导入并绑定</button>
    </div>
  </div>
</template>
