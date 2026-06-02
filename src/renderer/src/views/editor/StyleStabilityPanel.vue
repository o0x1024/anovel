<script setup lang="ts">
import { ref, onMounted } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'

const props = defineProps<{ workId: number }>()

interface StabilityItem {
  chapterId: number
  chapterTitle: string
  volumeName: string
  deviationScore: number | null
  checkTime: string | null
  status: 'stable' | 'warning' | 'unknown'
}

interface Report {
  styleName: string | null
  items: StabilityItem[]
  avgDeviation: number
  driftCount: number
}

const report = ref<Report | null>(null)
const loading = ref(true)

onMounted(load)

async function load() {
  loading.value = true
  try {
    report.value = await window.anovel.invoke('styleStability:get', props.workId) as Report
  } finally {
    loading.value = false
  }
}

function statusClass(status: StabilityItem['status']): string {
  if (status === 'stable') return 'bg-success/20 border-success/30'
  if (status === 'warning') return 'bg-warning/25 border-warning/40'
  return 'bg-base-300/30 border-base-300/50'
}

function statusLabel(status: StabilityItem['status']): string {
  if (status === 'stable') return '稳定'
  if (status === 'warning') return '漂移'
  return '未检测'
}
</script>

<template>
  <div>
    <PanelTitle title="文风稳定性" subtitle="基于文风指纹偏差记录的章节热力图" />

    <div v-if="loading" class="flex justify-center py-16">
      <span class="loading loading-spinner loading-md text-primary" />
    </div>

    <template v-else-if="report">
      <div v-if="!report.styleName" class="alert alert-warning text-sm mb-4">
        作品尚未绑定文风，或文风未提取指纹。请先在顶部绑定文风，并在文风管理中「提取指纹」。
      </div>

      <div v-else class="flex flex-wrap gap-4 mb-6 text-sm">
        <span>绑定文风：<strong>{{ report.styleName }}</strong></span>
        <span>平均偏差：<strong>{{ report.avgDeviation }}</strong></span>
        <span>漂移章节：<strong class="text-warning">{{ report.driftCount }}</strong></span>
      </div>

      <div v-if="report.items.length" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
        <div
          v-for="item in report.items"
          :key="item.chapterId"
          class="p-3 rounded-lg border text-xs transition-colors"
          :class="statusClass(item.status)"
          :title="item.checkTime ? `检测于 ${item.checkTime}` : '尚未检测'"
        >
          <div class="font-medium truncate">{{ item.chapterTitle }}</div>
          <div class="text-base-content/50 truncate mt-0.5">{{ item.volumeName }}</div>
          <div class="mt-2 flex justify-between items-center">
            <span>{{ statusLabel(item.status) }}</span>
            <span v-if="item.deviationScore != null" class="font-mono">{{ item.deviationScore.toFixed(2) }}</span>
          </div>
        </div>
      </div>
      <p v-else class="text-sm text-base-content/50 text-center py-8">暂无已写正文的章节</p>
    </template>
  </div>
</template>
