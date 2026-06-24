<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import PanelTitle from '../../components/PanelTitle.vue'
import ListBatchToolbar from '../../components/ListBatchToolbar.vue'
import {
  useListSelection,
  confirmBatchDelete,
  confirmDeleteAll,
  runBatchDelete
} from '../../composables/useListSelection'
import { toLocalFileUrl } from '../../../../shared/local-file-url'

const props = defineProps<{ workId: number }>()
const router = useRouter()

interface GeneratedImage {
  id: number
  prompt: string
  local_path: string
  image_type: string | null
  create_time: string
}

const images = ref<GeneratedImage[]>([])
const chapters = ref<{ id: number; title: string }[]>([])
const prompt = ref('')
const imageType = ref('illustration')
const selectedChapter = ref<number | null>(null)
const generating = ref(false)
const volcengineConfigured = ref(false)

const selection = useListSelection(images)

const typeOptions = [
  { value: 'cover', label: '封面' },
  { value: 'character', label: '人设' },
  { value: 'scene', label: '场景' },
  { value: 'illustration', label: '章节插图' }
]

const configHint = computed(() =>
  volcengineConfigured.value
    ? '火山引擎密钥已配置（系统设置 → AI 服务）'
    : '未配置火山引擎密钥，生成结果为占位图'
)

onMounted(async () => {
  await reloadImages()
  chapters.value = await window.anovel.invoke('chapter:listByWork', props.workId) as { id: number; title: string }[]
  await refreshVolcengineStatus()
})

async function reloadImages() {
  images.value = await window.anovel.invoke('image:listByWork', props.workId) as GeneratedImage[]
  selection.clearSelection()
}

async function refreshVolcengineStatus() {
  const cfg = await window.anovel.invoke('image:getVolcengineConfig') as {
    access_key?: string
    secret_key?: string
    is_enabled?: number
  } | null
  volcengineConfigured.value = Boolean(
    cfg?.access_key?.trim() && cfg.secret_key && cfg.is_enabled !== 0
  )
}

function openVolcengineSettings() {
  void router.push({ path: '/setting', query: { category: 'ai' } })
}

async function loadFromChapter() {
  if (!selectedChapter.value) return
  prompt.value = await window.anovel.invoke('image:buildPromptFromChapter', selectedChapter.value) as string
}

async function generate() {
  if (!prompt.value.trim() || generating.value) return
  generating.value = true
  try {
    await window.anovel.invoke('image:generate', {
      workId: props.workId,
      chapterId: selectedChapter.value,
      prompt: prompt.value.trim(),
      imageType: imageType.value
    })
    images.value = await window.anovel.invoke('image:listByWork', props.workId) as GeneratedImage[]
  } finally {
    generating.value = false
  }
  await reloadImages()
}

async function deleteImage(id: number) {
  await window.anovel.invoke('image:delete', id)
}

async function deleteSelectedImages() {
  const items = selection.getSelectedItems()
  if (!(await confirmBatchDelete(items.length, '图片'))) return
  await runBatchDelete(items, item => deleteImage(item.id))
  await reloadImages()
}

async function deleteAllImages() {
  if (!(await confirmDeleteAll(images.value.length, '图片'))) return
  await runBatchDelete(images.value, item => deleteImage(item.id))
  await reloadImages()
}
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="palette" title="AI 配图" />
    <p class="text-sm text-base-content/50 mb-3">生成封面、人设、场景或章节插图（火山引擎 MVP，未配置时生成占位图）。</p>

    <div
      class="flex flex-wrap items-center gap-2 mb-4 p-3 rounded-lg border border-base-300/60 bg-base-200/50 text-sm"
    >
      <span
        class="badge badge-sm"
        :class="volcengineConfigured ? 'badge-success' : 'badge-ghost'"
      >
        {{ volcengineConfigured ? '已配置' : '未配置' }}
      </span>
      <span class="text-base-content/55 flex-1 min-w-[12rem]">{{ configHint }}</span>
      <button type="button" class="btn btn-ghost btn-xs" @click="openVolcengineSettings">
        前往系统设置
      </button>
    </div>

    <div class="card bg-base-200 border border-base-300 p-4 mb-4 space-y-2">
      <div class="flex flex-wrap gap-2">
        <select v-model="imageType" class="select select-bordered select-sm">
          <option v-for="t in typeOptions" :key="t.value" :value="t.value">{{ t.label }}</option>
        </select>
        <select v-model="selectedChapter" class="select select-bordered select-sm flex-1 min-w-[140px]">
          <option :value="null">不关联章节</option>
          <option v-for="ch in chapters" :key="ch.id" :value="ch.id">{{ ch.title }}</option>
        </select>
        <button class="btn btn-ghost btn-xs" :disabled="!selectedChapter" @click="loadFromChapter">从章节提取 Prompt</button>
      </div>
      <textarea v-model="prompt" rows="3" class="textarea textarea-bordered w-full textarea-sm" placeholder="描述要生成的画面..." />
      <button class="btn btn-primary btn-sm" :disabled="!prompt.trim() || generating" @click="generate">
        {{ generating ? '生成中...' : '生成图片' }}
      </button>
    </div>

    <div v-if="images.length === 0" class="text-center py-8 text-base-content/40 text-sm">暂无生成图片</div>
    <template v-else>
      <ListBatchToolbar
        :total="images.length"
        :selectable-count="selection.selectableCount"
        :selected-count="selection.selectedCount"
        :all-selected="selection.allSelected"
        @toggle-all="selection.toggleAll()"
        @delete-selected="deleteSelectedImages"
        @delete-all="deleteAllImages"
      />
      <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <div
        v-for="(img, index) in images"
        :key="img.id"
        class="card bg-base-100 border border-base-300 overflow-hidden"
        :class="{ 'ring-2 ring-primary/40': selection.isSelected(img, index) }"
      >
        <div class="relative">
          <input
            type="checkbox"
            class="checkbox checkbox-xs absolute top-2 left-2 z-10 bg-base-100/80"
            :checked="selection.isSelected(img, index)"
            @change="selection.toggle(img, index)"
          />
          <img :src="toLocalFileUrl(img.local_path)!" class="w-full aspect-square object-cover bg-base-300" alt="" />
        </div>
        <div class="p-2">
          <p class="text-xs truncate" :title="img.prompt">{{ img.prompt }}</p>
          <div class="flex justify-between mt-1">
            <span class="badge badge-ghost badge-xs">{{ img.image_type || '插图' }}</span>
            <button class="btn btn-ghost btn-xs text-error" @click="deleteImage(img.id).then(reloadImages)">删除</button>
          </div>
        </div>
      </div>
      </div>
    </template>
  </div>
</template>
