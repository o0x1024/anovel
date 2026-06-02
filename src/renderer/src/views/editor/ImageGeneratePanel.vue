<script setup lang="ts">
import { ref, onMounted } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'
import { toLocalFileUrl } from '../../../../shared/local-file-url'

const props = defineProps<{ workId: number }>()

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
const showConfig = ref(false)
const accessKey = ref('')
const secretKey = ref('')
const region = ref('cn-beijing')

const typeOptions = [
  { value: 'cover', label: '封面' },
  { value: 'character', label: '人设' },
  { value: 'scene', label: '场景' },
  { value: 'illustration', label: '章节插图' }
]

onMounted(async () => {
  images.value = await window.anovel.invoke('image:listByWork', props.workId) as GeneratedImage[]
  chapters.value = await window.anovel.invoke('chapter:listByWork', props.workId) as { id: number; title: string }[]
  const cfg = await window.anovel.invoke('image:getVolcengineConfig') as { access_key?: string; region?: string } | null
  if (cfg) {
    accessKey.value = cfg.access_key || ''
    region.value = cfg.region || 'cn-beijing'
  }
})

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
}

async function saveConfig() {
  if (!accessKey.value.trim() || !secretKey.value.trim()) return
  await window.anovel.invoke('image:setVolcengineConfig', accessKey.value, secretKey.value, region.value, true)
  showConfig.value = false
  secretKey.value = ''
}

async function deleteImage(id: number) {
  await window.anovel.invoke('image:delete', id)
  images.value = await window.anovel.invoke('image:listByWork', props.workId) as GeneratedImage[]
}
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="palette" title="AI 配图" />
    <p class="text-sm text-base-content/50 mb-4">生成封面、人设、场景或章节插图（火山引擎 MVP，未配置时生成占位图）。</p>

    <button class="btn btn-ghost btn-xs mb-3" @click="showConfig = !showConfig">
      {{ showConfig ? '收起' : '火山引擎配置' }}
    </button>
    <div v-if="showConfig" class="card bg-base-200 border border-base-300 p-4 mb-4 space-y-2">
      <input v-model="accessKey" class="input input-bordered input-sm w-full" placeholder="Access Key" />
      <input v-model="secretKey" type="password" class="input input-bordered input-sm w-full" placeholder="Secret Key" />
      <input v-model="region" class="input input-bordered input-sm w-full" placeholder="Region" />
      <button class="btn btn-primary btn-sm" @click="saveConfig">保存配置</button>
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
    <div v-else class="grid grid-cols-2 sm:grid-cols-3 gap-3">
      <div v-for="img in images" :key="img.id" class="card bg-base-100 border border-base-300 overflow-hidden">
        <img :src="toLocalFileUrl(img.local_path)!" class="w-full aspect-square object-cover bg-base-300" alt="" />
        <div class="p-2">
          <p class="text-xs truncate" :title="img.prompt">{{ img.prompt }}</p>
          <div class="flex justify-between mt-1">
            <span class="badge badge-ghost badge-xs">{{ img.image_type || '插图' }}</span>
            <button class="btn btn-ghost btn-xs text-error" @click="deleteImage(img.id)">删除</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
