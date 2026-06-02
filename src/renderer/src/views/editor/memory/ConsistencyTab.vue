<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = defineProps<{ workId: number }>()

interface Report {
  foreshadowing: {
    total: number
    resolved: number
    pending: number
    recoveryRate: number
    deepPending: number
  }
  characters: { trackedCount: number; snapshotCount: number }
  timeline: { eventCount: number }
  chapters: { withContent: number; withOutline: number; avgEmotionIntensity: number }
  alignment: { recentChecks: number; misalignedCount: number }
  settingsQuality?: {
    hasCheck: boolean
    isStale: boolean
    issueCount: number
    checkedAt: string | null
  }
  settingsQualityIssues?: string[]
  warnings: string[]
  rhythmHints: string[]
}

const report = ref<Report | null>(null)
const loading = ref(false)
const crossIssues = ref<{ severity: string; chapterTitle?: string; message: string }[]>([])
const scanning = ref(false)

onMounted(refresh)

async function runCrossScan() {
  scanning.value = true
  try {
    crossIssues.value = await window.anovel.invoke('narrative:crossChapterScan', props.workId) as typeof crossIssues.value
  } finally {
    scanning.value = false
  }
}

async function refresh() {
  loading.value = true
  try {
    report.value = await window.anovel.invoke('narrative:consistencyReport', props.workId) as Report
  } finally {
    loading.value = false
  }
}

defineExpose({ refresh })
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <p class="text-sm text-base-content/50">作品一致性摘要：伏笔回收、角色追踪、时间线、情绪节奏。</p>
      <button class="btn btn-outline btn-sm" :disabled="loading" @click="refresh">
        {{ loading ? '刷新中...' : '刷新报告' }}
      </button>
    </div>

    <div v-if="report" class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="stat bg-base-100 border border-base-300 rounded-lg p-3">
        <div class="stat-title text-xs">伏笔回收率</div>
        <div class="stat-value text-lg">{{ report.foreshadowing.recoveryRate }}%</div>
        <div class="stat-desc text-xs">待回收 {{ report.foreshadowing.pending }}</div>
      </div>
      <div class="stat bg-base-100 border border-base-300 rounded-lg p-3">
        <div class="stat-title text-xs">追踪角色</div>
        <div class="stat-value text-lg">{{ report.characters.trackedCount }}</div>
        <div class="stat-desc text-xs">{{ report.characters.snapshotCount }} 条快照</div>
      </div>
      <div class="stat bg-base-100 border border-base-300 rounded-lg p-3">
        <div class="stat-title text-xs">时间线事件</div>
        <div class="stat-value text-lg">{{ report.timeline.eventCount }}</div>
      </div>
      <div class="stat bg-base-100 border border-base-300 rounded-lg p-3">
        <div class="stat-title text-xs">设定自检</div>
        <div class="stat-value text-lg">
          {{ report.settingsQuality?.hasCheck && !report.settingsQuality?.isStale ? '有效' : '待更新' }}
        </div>
        <div class="stat-desc text-xs">
          {{ report.settingsQuality?.issueCount ?? 0 }} 条未决问题
        </div>
      </div>
    </div>

    <div v-if="report?.settingsQualityIssues?.length" class="space-y-1">
      <p class="text-xs font-medium text-base-content/50">设定质量未决问题（已同步至 AI 生成上下文）</p>
      <div
        v-for="(issue, i) in report.settingsQualityIssues.slice(0, 8)"
        :key="i"
        class="alert alert-info py-2 text-xs"
      >
        {{ issue }}
      </div>
    </div>

    <div v-if="report?.warnings.length" class="space-y-1">
      <p class="text-xs font-medium text-warning">⚠ 警告</p>
      <div v-for="(w, i) in report.warnings" :key="i" class="alert alert-warning py-2 text-xs">{{ w }}</div>
    </div>

    <div v-if="report?.rhythmHints.length" class="space-y-1">
      <p class="text-xs font-medium text-base-content/50">创作节奏提示（压→缓→压→爆发）</p>
      <div v-for="(h, i) in report.rhythmHints" :key="i" class="alert alert-info py-2 text-xs">{{ h }}</div>
    </div>

    <div v-if="report && !report.warnings.length && !report.rhythmHints.length" class="alert alert-success text-sm py-2">
      当前一致性状态良好
    </div>

    <div class="border-t border-base-300 pt-4 space-y-2">
      <div class="flex items-center justify-between">
        <p class="text-xs font-medium text-base-content/50">跨章逻辑扫描（规则引擎）</p>
        <button class="btn btn-outline btn-xs" :disabled="scanning" @click="runCrossScan">
          {{ scanning ? '扫描中...' : '开始扫描' }}
        </button>
      </div>
      <div v-for="(issue, i) in crossIssues" :key="i" class="text-xs py-1" :class="issue.severity === 'warning' ? 'text-warning' : 'text-base-content/60'">
        {{ issue.chapterTitle ? `「${issue.chapterTitle}」` : '' }}{{ issue.message }}
      </div>
    </div>
  </div>
</template>
