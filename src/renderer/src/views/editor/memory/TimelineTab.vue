<script setup lang="ts">
import { ref, onMounted } from 'vue'
import ListBatchToolbar from '../../../components/ListBatchToolbar.vue'
import {
  useListSelection,
  confirmBatchDelete,
  confirmDeleteAll,
  runBatchDelete
} from '../../../composables/useListSelection'

import { useBodyGenerationModel } from '../../../composables/useBodyGenerationModel'

const props = defineProps<{ workId: number }>()
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)

interface TimelineEvent {
  id: number
  event_name: string
  event_description: string | null
  absolute_time: string | null
  relative_time: string | null
  chapter_id: number | null
  sort_order: number | null
}

interface ChapterOption {
  id: number
  title: string
}

const events = ref<TimelineEvent[]>([])
const chapters = ref<ChapterOption[]>([])
const generating = ref(false)
const generateError = ref<string | null>(null)
const showForm = ref(false)
const form = ref({
  event_name: '',
  event_description: '',
  absolute_time: '',
  relative_time: '',
  chapter_id: null as number | null
})

const selection = useListSelection(events)

onMounted(async () => {
  await Promise.all([loadEvents(), loadChapters()])
})

async function loadEvents() {
  events.value = await window.anovel.invoke('timeline:listByWork', props.workId) as TimelineEvent[]
  selection.clearSelection()
}

async function loadChapters() {
  chapters.value = await window.anovel.invoke('chapter:listByWork', props.workId) as ChapterOption[]
}

async function generateTimeline() {
  if (events.value.length > 0) {
    const confirmed = confirm(
      `当前已有 ${events.value.length} 条时间线事件。AI 生成将替换全部现有事件，是否继续？`
    )
    if (!confirmed) return
  }
  generating.value = true
  generateError.value = null
  try {
    const result = await window.anovel.invoke('timeline:generate', props.workId, bodyModelParams()) as {
      success: boolean
      error?: string
      events?: TimelineEvent[]
      totalGenerated?: number
    }
    if (result.success) {
      await loadEvents()
    } else {
      generateError.value = result.error ?? '生成失败，请重试'
    }
  } catch (err) {
    generateError.value = err instanceof Error ? err.message : '未知错误'
  } finally {
    generating.value = false
  }
}

async function createEvent() {
  if (!form.value.event_name.trim()) return
  await window.anovel.invoke('timeline:create', {
    work_id: props.workId,
    event_name: form.value.event_name.trim(),
    event_description: form.value.event_description || undefined,
    absolute_time: form.value.absolute_time || undefined,
    relative_time: form.value.relative_time || undefined,
    chapter_id: form.value.chapter_id,
    sort_order: events.value.length + 1
  })
  form.value = { event_name: '', event_description: '', absolute_time: '', relative_time: '', chapter_id: null }
  showForm.value = false
  await loadEvents()
}

async function deleteEvent(id: number) {
  await window.anovel.invoke('timeline:delete', id)
}

async function deleteSelectedEvents() {
  const selected = selection.getSelectedItems()
  if (!(await confirmBatchDelete(selected.length, '时间线事件'))) return
  await runBatchDelete(selected, item => deleteEvent(item.id))
  await loadEvents()
}

async function deleteAllEvents() {
  if (!(await confirmDeleteAll(events.value.length, '时间线事件'))) return
  await runBatchDelete(events.value, item => deleteEvent(item.id))
  await loadEvents()
}

function chapterTitle(id: number | null) {
  if (!id) return ''
  return chapters.value.find(c => c.id === id)?.title ?? ''
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between gap-3 flex-wrap">
      <p class="text-sm text-base-content/50">维护故事时间线，生成时自动注入时间约束。</p>
      <div class="flex gap-2 shrink-0">
        <button
          class="btn btn-primary btn-sm"
          :disabled="generating"
          @click="generateTimeline"
        >
          <span v-if="generating" class="loading loading-spinner loading-xs"></span>
          {{ generating ? '生成中...' : 'AI 生成时间线' }}
        </button>
        <button class="btn btn-primary btn-sm" @click="showForm = !showForm">
          {{ showForm ? '取消' : '添加事件' }}
        </button>
      </div>
    </div>

    <div v-if="generateError" class="alert alert-error text-sm mb-3">
      <span>{{ generateError }}</span>
      <button class="btn btn-ghost btn-xs ml-auto" @click="generateError = null">关闭</button>
    </div>

    <ListBatchToolbar
      v-if="events.length > 0"
      :total="events.length"
      :selectable-count="selection.selectableCount"
      :selected-count="selection.selectedCount"
      :all-selected="selection.allSelected"
      @toggle-all="selection.toggleAll()"
      @delete-selected="deleteSelectedEvents"
      @delete-all="deleteAllEvents"
    />

    <div v-if="showForm" class="card bg-base-100 border border-base-300 p-4 space-y-2">
      <input v-model="form.event_name" class="input input-bordered input-sm w-full" placeholder="事件名称" />
      <textarea v-model="form.event_description" rows="2" class="textarea textarea-bordered textarea-sm w-full" placeholder="事件描述" />
      <div class="flex gap-2 flex-wrap">
        <input v-model="form.absolute_time" class="input input-bordered input-sm flex-1" placeholder="绝对时间（如：第三天上午）" />
        <input v-model="form.relative_time" class="input input-bordered input-sm flex-1" placeholder="相对时间（如：主角离开后2小时）" />
      </div>
      <select v-model="form.chapter_id" class="select select-bordered select-sm w-full">
        <option :value="null">关联章节（可选）</option>
        <option v-for="ch in chapters" :key="ch.id" :value="ch.id">{{ ch.title }}</option>
      </select>
      <button class="btn btn-primary btn-sm" :disabled="!form.event_name.trim()" @click="createEvent">保存</button>
    </div>

    <div v-if="events.length === 0" class="text-center py-8 text-base-content/40 text-sm">暂无时间线事件</div>
    <ul v-else class="timeline timeline-vertical timeline-compact">
      <li v-for="(ev, index) in events" :key="ev.id">
        <div class="timeline-start text-xs text-base-content/40">{{ ev.absolute_time || ev.relative_time || '—' }}</div>
        <div class="timeline-middle">
          <font-awesome-icon icon="circle" class="w-2 h-2 text-primary" />
        </div>
        <div
          class="timeline-end card bg-base-100 border border-base-300 p-3 mb-3 w-full"
          :class="{ 'ring-1 ring-primary/40': selection.isSelected(ev, index) }"
        >
          <div class="flex justify-between items-start gap-2">
            <div class="flex items-start gap-2 min-w-0">
              <input
                type="checkbox"
                class="checkbox checkbox-xs mt-0.5 shrink-0"
                :checked="selection.isSelected(ev, index)"
                @change="selection.toggle(ev, index)"
              />
              <div>
                <h5 class="font-semibold text-sm">{{ ev.event_name }}</h5>
                <p v-if="ev.event_description" class="text-xs text-base-content/60 mt-1">{{ ev.event_description }}</p>
                <p v-if="ev.chapter_id" class="text-xs text-base-content/40 mt-1">{{ chapterTitle(ev.chapter_id) }}</p>
              </div>
            </div>
            <button class="btn btn-ghost btn-xs text-error shrink-0" @click="deleteEvent(ev.id).then(loadEvents)">删除</button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
