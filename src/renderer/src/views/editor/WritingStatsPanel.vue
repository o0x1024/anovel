<script setup lang="ts">
import { ref, onMounted } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'

const props = defineProps<{ workId: number }>()

interface WritingStats {
  totalWords: number
  chapterCount: number
  chaptersWithContent: number
  totalOutlineWords: number
  avgWordsPerChapter: number
  tokenUsage: { total_prompt: number; total_completion: number }
  modelCalls: { model_type: string; count: number }[]
  emotionCurve: { title: string; intensity: number; wordCount: number }[]
  recentActivity: { date: string; words: number }[]
}

const stats = ref<WritingStats | null>(null)
const loading = ref(true)

onMounted(load)

async function load() {
  loading.value = true
  try {
    stats.value = await window.anovel.invoke('stats:get', props.workId) as WritingStats
  } finally {
    loading.value = false
  }
}

function maxWords(): number {
  return Math.max(...(stats.value?.recentActivity.map(d => d.words) ?? [1]), 1)
}
</script>

<template>
  <div>
    <PanelTitle title="写作统计" subtitle="字数、Token 消耗与创作节奏概览" />

    <div v-if="loading" class="flex justify-center py-16">
      <span class="loading loading-spinner loading-md text-primary" />
    </div>

    <template v-else-if="stats">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div class="stat bg-base-200/50 border border-base-300/60 rounded-xl">
          <div class="stat-title text-xs">总字数</div>
          <div class="stat-value text-lg">{{ stats.totalWords.toLocaleString() }}</div>
          <div class="stat-desc text-xs">{{ stats.chaptersWithContent }}/{{ stats.chapterCount }} 章有正文</div>
        </div>
        <div class="stat bg-base-200/50 border border-base-300/60 rounded-xl">
          <div class="stat-title text-xs">章均字数</div>
          <div class="stat-value text-lg">{{ stats.avgWordsPerChapter.toLocaleString() }}</div>
        </div>
        <div class="stat bg-base-200/50 border border-base-300/60 rounded-xl">
          <div class="stat-title text-xs">大纲字数</div>
          <div class="stat-value text-lg">{{ stats.totalOutlineWords.toLocaleString() }}</div>
        </div>
        <div class="stat bg-base-200/50 border border-base-300/60 rounded-xl">
          <div class="stat-title text-xs">Token 消耗</div>
          <div class="stat-value text-lg">{{ (stats.tokenUsage.total_prompt + stats.tokenUsage.total_completion).toLocaleString() }}</div>
          <div class="stat-desc text-xs">输入 {{ stats.tokenUsage.total_prompt }} / 输出 {{ stats.tokenUsage.total_completion }}</div>
        </div>
      </div>

      <div v-if="stats.modelCalls.length" class="card bg-base-100 border border-base-300/60 mb-6">
        <div class="card-body p-5">
          <h4 class="font-semibold text-sm mb-3">模型调用分布</h4>
          <div class="flex flex-wrap gap-2">
            <span v-for="m in stats.modelCalls" :key="m.model_type" class="badge badge-outline gap-1">
              {{ m.model_type }} <span class="opacity-60">{{ m.count }} 次</span>
            </span>
          </div>
        </div>
      </div>

      <div v-if="stats.recentActivity.length" class="card bg-base-100 border border-base-300/60 mb-6">
        <div class="card-body p-5">
          <h4 class="font-semibold text-sm mb-4">近 14 日写作量</h4>
          <div class="flex items-end gap-1 h-24">
            <div
              v-for="day in stats.recentActivity"
              :key="day.date"
              class="flex-1 flex flex-col items-center gap-1"
              :title="`${day.date}: ${day.words} 字`"
            >
              <div
                class="w-full bg-primary/70 rounded-t-sm min-h-[4px] transition-all"
                :style="{ height: `${Math.max(4, (day.words / maxWords()) * 100)}%` }"
              />
              <span class="text-[10px] text-base-content/40 rotate-0 truncate w-full text-center">{{ day.date.slice(5) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="stats.emotionCurve.length" class="card bg-base-100 border border-base-300/60">
        <div class="card-body p-5">
          <h4 class="font-semibold text-sm mb-3">情绪强度曲线</h4>
          <div class="overflow-x-auto">
            <table class="table table-xs">
              <thead><tr><th>章节</th><th>情绪</th><th>字数</th></tr></thead>
              <tbody>
                <tr v-for="item in stats.emotionCurve" :key="item.title">
                  <td class="max-w-[200px] truncate">{{ item.title }}</td>
                  <td>
                    <progress class="progress progress-warning w-20" :value="item.intensity" max="10" />
                    {{ item.intensity }}
                  </td>
                  <td>{{ item.wordCount }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
