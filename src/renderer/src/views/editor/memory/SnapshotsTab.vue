<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import ListBatchToolbar from '../../../components/ListBatchToolbar.vue'
import {
  useListSelection,
  confirmBatchDelete,
  confirmDeleteAll,
  runBatchDelete
} from '../../../composables/useListSelection'

const props = defineProps<{ workId: number }>()

interface Snapshot {
  id: number
  character_name: string
  chapter_id: number
  location: string | null
  mental_state: string | null
  known_info: string | null
  relationship_changes: string | null
  ability_changes: string | null
  numeric_stats: string | null
}

interface ChapterOption {
  id: number
  title: string
}

const snapshots = ref<Snapshot[]>([])
const characters = ref<string[]>([])
const chapters = ref<ChapterOption[]>([])
const showForm = ref(false)
const form = ref({
  character_name: '',
  chapter_id: null as number | null,
  location: '',
  mental_state: '',
  known_info: '',
  relationship_changes: '',
  ability_changes: '',
  numeric_stats: ''
})

const selection = useListSelection(snapshots)

onMounted(async () => {
  await Promise.all([loadSnapshots(), loadChapters()])
})

async function loadSnapshots() {
  snapshots.value = await window.anovel.invoke('snapshot:listByWork', props.workId) as Snapshot[]
  characters.value = await window.anovel.invoke('snapshot:listCharacters', props.workId) as string[]
  selection.clearSelection()
}

async function loadChapters() {
  chapters.value = await window.anovel.invoke('chapter:listByWork', props.workId) as ChapterOption[]
  if (chapters.value.length && !form.value.chapter_id) {
    form.value.chapter_id = chapters.value[0].id
  }
}

async function createSnapshot() {
  if (!form.value.character_name.trim() || !form.value.chapter_id) return
  let numericStatsJson: string | undefined
  const raw = form.value.numeric_stats.trim()
  if (raw) {
    const entries = raw.split(/[\n;；]+/).map(line => {
      const m = line.trim().match(/^([^:：]+)[：:]\s*(.+)$/)
      if (!m) return null
      const unitMatch = m[2].trim().match(/^(.+?)\s*[（(]([^)）]+)[)）]$/)
      return unitMatch
        ? { name: m[1].trim(), value: unitMatch[1].trim(), unit: unitMatch[2].trim() }
        : { name: m[1].trim(), value: m[2].trim(), unit: '' }
    }).filter((x): x is { name: string; value: string; unit: string } => x !== null)
    if (entries.length > 0) numericStatsJson = JSON.stringify(entries)
  }
  await window.anovel.invoke('snapshot:create', {
    work_id: props.workId,
    character_name: form.value.character_name.trim(),
    chapter_id: form.value.chapter_id,
    location: form.value.location || undefined,
    mental_state: form.value.mental_state || undefined,
    known_info: form.value.known_info || undefined,
    relationship_changes: form.value.relationship_changes || undefined,
    ability_changes: form.value.ability_changes || undefined,
    numeric_stats: numericStatsJson
  })
  form.value = {
    character_name: '',
    chapter_id: chapters.value[0]?.id ?? null,
    location: '',
    mental_state: '',
    known_info: '',
    relationship_changes: '',
    ability_changes: '',
    numeric_stats: ''
  }
  showForm.value = false
  await loadSnapshots()
}

async function deleteSnapshot(id: number) {
  await window.anovel.invoke('snapshot:delete', id)
}

async function deleteSelectedSnapshots() {
  const selected = selection.getSelectedItems()
  if (!(await confirmBatchDelete(selected.length, '角色快照'))) return
  await runBatchDelete(selected, item => deleteSnapshot(item.id))
  await loadSnapshots()
}

async function deleteAllSnapshots() {
  if (!(await confirmDeleteAll(snapshots.value.length, '角色快照'))) return
  await runBatchDelete(snapshots.value, item => deleteSnapshot(item.id))
  await loadSnapshots()
}

function chapterTitle(id: number) {
  return chapters.value.find(c => c.id === id)?.title ?? `#${id}`
}

function formatNumericStats(raw: string | null): string {
  if (!raw) return ''
  try {
    const stats = JSON.parse(raw) as { name: string; value: string; unit?: string }[]
    if (!Array.isArray(stats) || stats.length === 0) return ''
    return stats.map(s => `${s.name}:${s.value}${s.unit || ''}`).join('、')
  } catch {
    return ''
  }
}

const groupedEntries = computed(() => {
  const map = new Map<string, typeof snapshots.value>()
  for (const s of snapshots.value) {
    const list = map.get(s.character_name) ?? []
    list.push(s)
    map.set(s.character_name, list)
  }
  return Array.from(map.entries())
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <p class="text-sm text-base-content/50">记录角色在各章的状态，正文生成时自动注入最新快照。</p>
      <button class="btn btn-primary btn-sm shrink-0" @click="showForm = !showForm">{{ showForm ? '取消' : '添加快照' }}</button>
    </div>

    <ListBatchToolbar
      v-if="snapshots.length > 0"
      :total="snapshots.length"
      :selectable-count="selection.selectableCount"
      :selected-count="selection.selectedCount"
      :all-selected="selection.allSelected"
      @toggle-all="selection.toggleAll()"
      @delete-selected="deleteSelectedSnapshots"
      @delete-all="deleteAllSnapshots"
    />

    <div v-if="showForm" class="card bg-base-100 border border-base-300 p-4 space-y-2">
      <div class="flex gap-2 flex-wrap">
        <input v-model="form.character_name" list="char-names" class="input input-bordered input-sm flex-1" placeholder="角色名" />
        <datalist id="char-names">
          <option v-for="name in characters" :key="name" :value="name" />
        </datalist>
        <select v-model="form.chapter_id" class="select select-bordered select-sm">
          <option v-for="ch in chapters" :key="ch.id" :value="ch.id">{{ ch.title }}</option>
        </select>
      </div>
      <input v-model="form.location" class="input input-bordered input-sm w-full" placeholder="所在位置" />
      <input v-model="form.mental_state" class="input input-bordered input-sm w-full" placeholder="心理状态" />
      <textarea v-model="form.known_info" rows="2" class="textarea textarea-bordered textarea-sm w-full" placeholder="已知信息" />
      <input v-model="form.relationship_changes" class="input input-bordered input-sm w-full" placeholder="关系变化" />
      <input v-model="form.ability_changes" class="input input-bordered input-sm w-full" placeholder="能力/资源变化" />
      <textarea v-model="form.numeric_stats" rows="2" class="textarea textarea-bordered textarea-sm w-full" placeholder="数值状态（每行一条，格式：属性名:数值(单位)，如 体力:50、信用度:87点）" />
      <button class="btn btn-primary btn-sm" :disabled="!form.character_name.trim()" @click="createSnapshot">保存</button>
    </div>

    <div v-if="snapshots.length === 0" class="text-center py-8 text-base-content/40 text-sm">暂无角色快照</div>
    <div v-else class="space-y-4">
      <div v-for="[name, list] in groupedEntries" :key="name">
        <h4 class="font-semibold text-sm mb-2">{{ name }}</h4>
        <div class="space-y-2">
          <div
            v-for="snap in list.slice().reverse().slice(0, 3)"
            :key="snap.id"
            class="card bg-base-100 border border-base-300 p-3 text-sm"
            :class="{ 'ring-1 ring-primary/40': selection.isSelected(snap, 0) }"
          >
            <div class="flex justify-between mb-1 gap-2">
              <div class="flex items-center gap-2">
                <input
                  type="checkbox"
                  class="checkbox checkbox-xs shrink-0"
                  :checked="selection.isSelected(snap, 0)"
                  @change="selection.toggle(snap, 0)"
                />
                <span class="text-xs text-base-content/50">{{ chapterTitle(snap.chapter_id) }}</span>
              </div>
              <button class="btn btn-ghost btn-xs text-error" @click="deleteSnapshot(snap.id).then(loadSnapshots)">删除</button>
            </div>
            <p v-if="snap.location" class="text-base-content/70">📍 {{ snap.location }}</p>
            <p v-if="snap.mental_state" class="text-base-content/70">心理：{{ snap.mental_state }}</p>
            <p v-if="snap.known_info" class="text-base-content/60 text-xs mt-1">{{ snap.known_info }}</p>
            <p v-if="formatNumericStats(snap.numeric_stats)" class="text-base-content/70 text-xs mt-1">📊 {{ formatNumericStats(snap.numeric_stats) }}</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
