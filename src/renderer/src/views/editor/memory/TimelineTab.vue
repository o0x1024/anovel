<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = defineProps<{ workId: number }>()

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
const showForm = ref(false)
const form = ref({
  event_name: '',
  event_description: '',
  absolute_time: '',
  relative_time: '',
  chapter_id: null as number | null
})

onMounted(async () => {
  await Promise.all([loadEvents(), loadChapters()])
})

async function loadEvents() {
  events.value = await window.anovel.invoke('timeline:listByWork', props.workId) as TimelineEvent[]
}

async function loadChapters() {
  chapters.value = await window.anovel.invoke('chapter:listByWork', props.workId) as ChapterOption[]
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
  await loadEvents()
}

function chapterTitle(id: number | null) {
  if (!id) return ''
  return chapters.value.find(c => c.id === id)?.title ?? ''
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <p class="text-sm text-base-content/50">维护故事时间线，生成时自动注入时间约束。</p>
      <button class="btn btn-primary btn-sm" @click="showForm = !showForm">{{ showForm ? '取消' : '添加事件' }}</button>
    </div>

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
      <li v-for="ev in events" :key="ev.id">
        <div class="timeline-start text-xs text-base-content/40">{{ ev.absolute_time || ev.relative_time || '—' }}</div>
        <div class="timeline-middle">
          <font-awesome-icon icon="circle" class="w-2 h-2 text-primary" />
        </div>
        <div class="timeline-end card bg-base-100 border border-base-300 p-3 mb-3 w-full">
          <div class="flex justify-between items-start">
            <div>
              <h5 class="font-semibold text-sm">{{ ev.event_name }}</h5>
              <p v-if="ev.event_description" class="text-xs text-base-content/60 mt-1">{{ ev.event_description }}</p>
              <p v-if="ev.chapter_id" class="text-xs text-base-content/40 mt-1">{{ chapterTitle(ev.chapter_id) }}</p>
            </div>
            <button class="btn btn-ghost btn-xs text-error" @click="deleteEvent(ev.id)">删除</button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
