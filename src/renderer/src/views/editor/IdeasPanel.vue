<script setup lang="ts">
import { ref, onMounted, computed, inject, watch } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'
import ListBatchToolbar from '../../components/ListBatchToolbar.vue'
import {
  useListSelection,
  confirmBatchDelete,
  confirmDeleteAll,
  runBatchDelete
} from '../../composables/useListSelection'
import { editorNavKey } from './editor-nav'

const props = defineProps<{ workId: number }>()
const nav = inject(editorNavKey)

interface Idea {
  id: number
  work_id: number | null
  type: string
  content: string
  tags: string | null
  is_merged: number
}

interface ChapterOption {
  id: number
  title: string
  volume_name: string
}

const ideas = ref<Idea[]>([])
const chapters = ref<ChapterOption[]>([])
const ideaTypes = ['scene', 'character', 'dialogue', 'plot_twist', 'image'] as const
const ideaTypeLabels: Record<string, string> = {
  scene: '场景',
  character: '角色',
  dialogue: '对话',
  plot_twist: '情节转折',
  image: '画面'
}

const settingMergeOptions = [
  { value: 'setting:character', label: '合龙到 · 人设' },
  { value: 'setting:worldview', label: '合龙到 · 世界观' },
  { value: 'setting:conflict', label: '合龙到 · 核心冲突' }
]

const newIdea = ref({ type: 'scene', content: '', tags: '' })
const showIdeaForm = ref(false)
const mergingIdeaId = ref<number | null>(null)
const mergeTarget = ref('')
const merging = ref(false)

const activeIdeas = computed(() => ideas.value.filter(i => !i.is_merged))
const selection = useListSelection(activeIdeas)

const chapterMergeOptions = computed(() =>
  chapters.value.flatMap(ch => [
    { value: `chapter:${ch.id}:outline`, label: `合龙到章节大纲 · ${ch.volume_name} / ${ch.title}` },
    { value: `chapter:${ch.id}:content`, label: `合龙到章节正文 · ${ch.volume_name} / ${ch.title}` }
  ])
)

onMounted(async () => {
  await Promise.all([loadIdeas(), loadChapters()])
})

watch(() => nav?.quickIdeaTrigger.value, () => {
  showIdeaForm.value = true
})

async function loadIdeas() {
  ideas.value = await window.anovel.invoke('idea:listByWork', props.workId) as never[]
  selection.clearSelection()
}

async function loadChapters() {
  const rows = await window.anovel.invoke('chapter:listByWork', props.workId) as ChapterOption[]
  chapters.value = rows
}

async function createIdea() {
  if (!newIdea.value.content.trim()) return
  await window.anovel.invoke('idea:create', {
    ...newIdea.value,
    work_id: props.workId,
    tags: newIdea.value.tags || undefined
  })
  newIdea.value = { type: 'scene', content: '', tags: '' }
  showIdeaForm.value = false
  await loadIdeas()
}

async function deleteIdea(id: number) {
  await window.anovel.invoke('idea:delete', id)
}

async function deleteSelectedIdeas() {
  const items = selection.getSelectedItems()
  if (!(await confirmBatchDelete(items.length, '灵感'))) return
  await runBatchDelete(items, item => deleteIdea(item.id))
  await loadIdeas()
}

async function deleteAllIdeas() {
  const items = activeIdeas.value
  if (!(await confirmDeleteAll(items.length, '灵感'))) return
  await runBatchDelete(items, item => deleteIdea(item.id))
  await loadIdeas()
}

function startMerge(ideaId: number) {
  mergingIdeaId.value = ideaId
  mergeTarget.value = settingMergeOptions[0]?.value ?? chapterMergeOptions.value[0]?.value ?? ''
}

function cancelMerge() {
  mergingIdeaId.value = null
  mergeTarget.value = ''
}

async function confirmMerge() {
  if (!mergingIdeaId.value || !mergeTarget.value || merging.value) return
  merging.value = true
  try {
    await window.anovel.invoke('idea:mergeToTarget', mergingIdeaId.value, mergeTarget.value)
    cancelMerge()
    await loadIdeas()
    await nav?.refreshProgress()
  } catch (e) {
    alert(String(e))
  } finally {
    merging.value = false
  }
}
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="brain" title="灵感收集板" />
    <p class="text-sm text-base-content/50 mb-6">记录灵感碎片，可合龙到核心设定或章节大纲/正文。</p>

    <button class="btn btn-primary btn-sm mb-4 gap-1" @click="showIdeaForm = !showIdeaForm">
      <font-awesome-icon :icon="showIdeaForm ? 'times' : 'plus'" class="w-3 h-3" />
      {{ showIdeaForm ? '取消' : '记录灵感' }}
    </button>

    <div v-if="showIdeaForm" class="card bg-base-200 border border-base-300 shadow-sm p-4 mb-4">
      <select v-model="newIdea.type" class="select select-bordered w-full mb-3">
        <option v-for="t in ideaTypes" :key="t" :value="t">{{ ideaTypeLabels[t] }}</option>
      </select>
      <textarea
        v-model="newIdea.content"
        rows="4"
        placeholder="写下你的灵感..."
        class="textarea textarea-bordered w-full mb-3 resize-none"
      />
      <input v-model="newIdea.tags" placeholder="标签（逗号分隔，可选）" class="input input-bordered w-full mb-3" />
      <button class="btn btn-primary btn-sm" :disabled="!newIdea.content.trim()" @click="createIdea">
        保存灵感
      </button>
    </div>

    <div v-if="activeIdeas.length === 0" class="text-center py-12 text-base-content/40">
      <font-awesome-icon icon="brain" class="text-4xl mb-3 opacity-30" />
      <p>还没有灵感碎片</p>
    </div>
    <template v-else>
      <ListBatchToolbar
        :total="activeIdeas.length"
        :selectable-count="selection.selectableCount"
        :selected-count="selection.selectedCount"
        :all-selected="selection.allSelected"
        @toggle-all="selection.toggleAll()"
        @delete-selected="deleteSelectedIdeas"
        @delete-all="deleteAllIdeas"
      />
      <div class="space-y-3">
      <div
        v-for="(idea, index) in activeIdeas"
        :key="idea.id"
        class="card bg-base-200 border border-base-300 shadow-sm p-4"
        :class="{ 'ring-1 ring-primary/40': selection.isSelected(idea, index) }"
      >
        <div class="flex items-start justify-between mb-1 gap-2">
          <div class="flex items-start gap-2 min-w-0">
            <input
              type="checkbox"
              class="checkbox checkbox-xs mt-0.5 shrink-0"
              :checked="selection.isSelected(idea, index)"
              @change="selection.toggle(idea, index)"
            />
            <span class="badge badge-primary badge-sm">{{ ideaTypeLabels[idea.type] || idea.type }}</span>
          </div>
          <div class="flex gap-1">
            <button class="btn btn-outline btn-primary btn-xs" @click="startMerge(idea.id)">
              合龙
            </button>
            <button class="btn btn-ghost btn-xs text-error gap-1" @click="deleteIdea(idea.id).then(loadIdeas)">
              <font-awesome-icon icon="trash" class="w-3 h-3" />
              删除
            </button>
          </div>
        </div>
        <p class="text-sm text-base-content/70 mt-2 whitespace-pre-wrap">{{ idea.content }}</p>
        <p v-if="idea.tags" class="text-xs text-base-content/40 mt-1">{{ idea.tags }}</p>

        <div v-if="mergingIdeaId === idea.id" class="mt-3 pt-3 border-t border-base-300 space-y-2">
          <select v-model="mergeTarget" class="select select-bordered select-sm w-full">
            <optgroup label="核心设定">
              <option v-for="opt in settingMergeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </optgroup>
            <optgroup v-if="chapterMergeOptions.length" label="章节">
              <option v-for="opt in chapterMergeOptions" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </optgroup>
          </select>
          <p v-if="!chapterMergeOptions.length" class="text-xs text-base-content/40">
            暂无章节，合龙目标仅支持核心设定
          </p>
          <div class="flex gap-2">
            <button class="btn btn-primary btn-xs" :disabled="!mergeTarget || merging" @click="confirmMerge">
              {{ merging ? '合龙中...' : '确认合龙' }}
            </button>
            <button class="btn btn-ghost btn-xs" @click="cancelMerge">取消</button>
          </div>
        </div>
      </div>
      </div>
    </template>
  </div>
</template>
