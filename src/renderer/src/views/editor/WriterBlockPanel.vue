<script setup lang="ts">
import { ref, onMounted } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'

const props = defineProps<{ workId: number }>()

const tab = ref<'inspiration' | 'directions' | 'whatif' | 'checklist' | 'blocktype'>('inspiration')
const loading = ref(false)
const inspiration = ref('')
const directions = ref<string[]>([])
const experiments = ref<string[]>([])
const checklist = ref('')
const chapters = ref<{ id: number; title: string }[]>([])
const selectedChapterId = ref<number | null>(null)
const error = ref('')
const blockTypes = ref<Record<string, { label: string; hint: string }>>({})
const selectedBlockType = ref('plot_stuck')

onMounted(async () => {
  const list = await window.anovel.invoke('chapter:listByWork', props.workId) as { id: number; title: string }[]
  chapters.value = list
  if (list.length) selectedChapterId.value = list[0].id
  blockTypes.value = await window.anovel.invoke('writerBlock:types') as typeof blockTypes.value
})

async function runRandomInspiration() {
  loading.value = true
  error.value = ''
  try {
    const res = await window.anovel.invoke('writerBlock:randomInspiration', props.workId) as { success: boolean; content?: string; error?: string }
    if (res.success) inspiration.value = res.content ?? ''
    else error.value = res.error ?? '生成失败'
  } finally {
    loading.value = false
  }
}

async function runPlotDirections() {
  loading.value = true
  error.value = ''
  directions.value = []
  try {
    const res = await window.anovel.invoke('writerBlock:plotDirections', props.workId) as { success: boolean; directions?: string[]; error?: string }
    if (res.success) directions.value = res.directions ?? []
    else error.value = res.error ?? '生成失败'
  } finally {
    loading.value = false
  }
}

async function runWhatIf() {
  loading.value = true
  error.value = ''
  experiments.value = []
  try {
    const res = await window.anovel.invoke('writerBlock:characterWhatIf', props.workId) as { success: boolean; experiments?: string[]; error?: string }
    if (res.success) experiments.value = res.experiments ?? []
    else error.value = res.error ?? '生成失败'
  } finally {
    loading.value = false
  }
}

async function runChecklist() {
  if (!selectedChapterId.value) return
  loading.value = true
  error.value = ''
  checklist.value = ''
  try {
    const res = await window.anovel.invoke('writerBlock:revisionChecklist', props.workId, selectedChapterId.value) as { success: boolean; content?: string; error?: string }
    if (res.success) checklist.value = res.content ?? ''
    else error.value = res.error ?? '生成失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div>
    <PanelTitle title="写作障碍应对" subtitle="随机灵感、情节走向、角色思维实验、改文自检与卡文类型指南" />

    <div role="tablist" class="tabs tabs-box tabs-sm w-fit mb-4">
      <a role="tab" href="#" class="tab" :class="{ 'tab-active': tab === 'blocktype' }" @click.prevent="tab = 'blocktype'">卡文类型</a>
      <a role="tab" href="#" class="tab" :class="{ 'tab-active': tab === 'inspiration' }" @click.prevent="tab = 'inspiration'">随机灵感</a>
      <a role="tab" href="#" class="tab" :class="{ 'tab-active': tab === 'directions' }" @click.prevent="tab = 'directions'">5 种走向</a>
      <a role="tab" href="#" class="tab" :class="{ 'tab-active': tab === 'whatif' }" @click.prevent="tab = 'whatif'">如果…会怎样</a>
      <a role="tab" href="#" class="tab" :class="{ 'tab-active': tab === 'checklist' }" @click.prevent="tab = 'checklist'">改文自检</a>
    </div>

    <p v-if="error" class="text-error text-sm mb-3">{{ error }}</p>

    <div v-if="tab === 'blocktype'" class="space-y-3">
      <select v-model="selectedBlockType" class="select select-bordered select-sm w-full max-w-xs">
        <option v-for="(meta, key) in blockTypes" :key="key" :value="key">{{ meta.label }}</option>
      </select>
      <div v-if="blockTypes[selectedBlockType]" class="alert alert-info text-sm">
        <p class="font-medium mb-1">{{ blockTypes[selectedBlockType].label }}</p>
        <p>{{ blockTypes[selectedBlockType].hint }}</p>
      </div>
      <p class="text-xs text-base-content/50">建议将应对方案写回「章节情节」大纲或「灵感收集」，而非直接插入已写正文。</p>
    </div>

    <div v-else-if="tab === 'inspiration'" class="space-y-3">
      <button type="button" class="btn btn-primary btn-sm" :disabled="loading" @click="runRandomInspiration">
        {{ loading ? '生成中...' : '给我一条灵感' }}
      </button>
      <div v-if="inspiration" class="alert alert-info text-sm">{{ inspiration }}</div>
    </div>

    <div v-else-if="tab === 'directions'" class="space-y-3">
      <button type="button" class="btn btn-primary btn-sm" :disabled="loading" @click="runPlotDirections">
        {{ loading ? '分析中...' : '生成 5 种情节走向' }}
      </button>
      <ol v-if="directions.length" class="list-decimal list-inside space-y-2 text-sm">
        <li v-for="(d, i) in directions" :key="i" class="leading-relaxed">{{ d }}</li>
      </ol>
    </div>

    <div v-else-if="tab === 'whatif'" class="space-y-3">
      <button type="button" class="btn btn-primary btn-sm" :disabled="loading" @click="runWhatIf">
        {{ loading ? '思考中...' : '角色思维实验' }}
      </button>
      <ul v-if="experiments.length" class="space-y-2">
        <li v-for="(e, i) in experiments" :key="i" class="p-3 bg-base-200/50 rounded-lg text-sm border border-base-300/40">{{ e }}</li>
      </ul>
    </div>

    <div v-else class="space-y-3">
      <div class="flex flex-wrap gap-2 items-end">
        <label class="form-control">
          <span class="label-text text-xs">选择章节</span>
          <select v-model="selectedChapterId" class="select select-bordered select-sm">
            <option v-for="c in chapters" :key="c.id" :value="c.id">{{ c.title }}</option>
          </select>
        </label>
        <button type="button" class="btn btn-primary btn-sm" :disabled="loading || !selectedChapterId" @click="runChecklist">
          {{ loading ? '自检中...' : '运行改文自检' }}
        </button>
      </div>
      <pre v-if="checklist" class="whitespace-pre-wrap text-sm bg-base-200/40 p-4 rounded-xl border border-base-300/40 max-h-96 overflow-y-auto">{{ checklist }}</pre>
    </div>
  </div>
</template>
