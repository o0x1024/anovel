<script setup lang="ts">
import { ref, onMounted } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'

const props = defineProps<{ workId: number }>()

interface Favorite {
  id: number
  work_id: number
  source_step: string
  source_label: string
  title: string | null
  content: string
  source_input: string | null
  create_time: string
}

const favorites = ref<Favorite[]>([])
const expandedId = ref<number | null>(null)
const filterStep = ref('all')

const sourceSteps = [
  { value: 'all', label: '全部' },
  { value: 'incubator_diagnose', label: '诊断方向' },
  { value: 'incubator_variants', label: '变体探索' },
  { value: 'incubator_reverse', label: '倒推大纲' },
  { value: 'incubator_anchors', label: '提炼锚点' },
  { value: 'settings_character', label: '人设建议' },
  { value: 'settings_worldview', label: '世界观建议' },
  { value: 'settings_conflict', label: '核心冲突建议' },
  { value: 'volumes_outline', label: '分卷大纲' },
  { value: 'chapter_outline', label: '章节大纲' },
  { value: 'body_generation', label: '正文生成' }
]

const filteredFavorites = ref<Favorite[]>([])

onMounted(loadFavorites)

async function loadFavorites() {
  favorites.value = await window.anovel.invoke('favorite:listByWork', props.workId) as Favorite[]
  applyFilter()
}

function applyFilter() {
  filteredFavorites.value =
    filterStep.value === 'all'
      ? favorites.value
      : favorites.value.filter(f => f.source_step === filterStep.value)
}

function onFilterChange() {
  applyFilter()
  expandedId.value = null
}

function toggleExpand(id: number) {
  expandedId.value = expandedId.value === id ? null : id
}

async function deleteFavorite(id: number) {
  await window.anovel.invoke('favorite:delete', id)
  if (expandedId.value === id) expandedId.value = null
  await loadFavorites()
}

function formatTime(time: string) {
  return time.replace('T', ' ').slice(0, 16)
}
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="bookmark" title="收藏夹" />
    <p class="text-sm text-base-content/50 mb-6">
      收藏 AI 诊断说明与生成建议，方便随时回顾、对比和复用。
    </p>

    <div v-if="favorites.length > 0" class="flex flex-wrap gap-2 mb-4">
      <select v-model="filterStep" class="select select-bordered select-sm" @change="onFilterChange">
        <option v-for="opt in sourceSteps" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
      <span class="text-xs text-base-content/40 self-center">{{ filteredFavorites.length }} 条收藏</span>
    </div>

    <div v-if="filteredFavorites.length === 0" class="text-center py-12 text-base-content/40">
      <font-awesome-icon icon="bookmark" class="text-4xl mb-3 opacity-30" />
      <p>{{ favorites.length === 0 ? '还没有收藏内容' : '该分类下暂无收藏' }}</p>
      <p v-if="favorites.length === 0" class="text-xs mt-2">
        在大岗孵化、核心设定等步骤中，点击 AI 结果旁的「收藏」即可保存
      </p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="item in filteredFavorites"
        :key="item.id"
        class="card bg-base-200 border border-base-300 shadow-sm overflow-hidden"
      >
        <div class="p-4">
          <div class="flex items-start justify-between gap-3 mb-2">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2 mb-1">
                <span class="badge badge-primary badge-sm">{{ item.source_label }}</span>
                <span class="text-xs text-base-content/40">{{ formatTime(item.create_time) }}</span>
              </div>
              <h4 class="font-semibold text-sm truncate" :title="item.title || item.source_label">
                {{ item.title || item.source_label }}
              </h4>
            </div>
            <div class="flex gap-1 shrink-0">
              <button class="btn btn-ghost btn-xs gap-1" @click="toggleExpand(item.id)">
                <font-awesome-icon :icon="expandedId === item.id ? 'chevron-down' : 'chevron-right'" class="w-3 h-3" />
                {{ expandedId === item.id ? '收起' : '展开' }}
              </button>
              <button class="btn btn-ghost btn-xs text-error gap-1" @click="deleteFavorite(item.id)">
                <font-awesome-icon icon="trash" class="w-3 h-3" />
                删除
              </button>
            </div>
          </div>

          <div v-if="expandedId !== item.id" class="text-sm text-base-content/60 line-clamp-3">
            {{ item.content.replace(/^#+\s+/gm, '').slice(0, 200) }}
          </div>
        </div>

        <div v-if="expandedId === item.id" class="border-t border-base-300 px-4 py-3 bg-base-100/50">
          <div v-if="item.source_input" class="mb-4">
            <p class="text-xs font-bold text-base-content/40 uppercase tracking-wider mb-1">原始输入</p>
            <p class="text-sm text-base-content/60 whitespace-pre-wrap">{{ item.source_input }}</p>
          </div>
          <MarkdownContent :content="item.content" />
        </div>
      </div>
    </div>
  </div>
</template>
