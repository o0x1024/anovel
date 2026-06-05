<script setup lang="ts">
defineProps<{
  report: {
    items: {
      anchorId: number
      title: string
      content: string
      type: string
      aligned: 0 | 1 | 2 | null
      detail: string
      skipped?: boolean
      skipReason?: string
    }[]
    summary: {
      total: number
      applicable?: number
      aligned: number
      partial: number
      missing: number
      skipped?: number
    }
  } | null
}>()

function badgeClass(aligned: 0 | 1 | 2 | null, skipped?: boolean) {
  if (skipped) return 'badge-ghost'
  if (aligned === 2) return 'badge-success'
  if (aligned === 1) return 'badge-warning'
  return 'badge-error'
}

function badgeLabel(aligned: 0 | 1 | 2 | null, skipped?: boolean) {
  if (skipped) return '跳过'
  if (aligned === 2) return '已对齐'
  if (aligned === 1) return '部分对齐'
  return '未对齐'
}
</script>

<template>
  <div v-if="report && report.summary.total > 0" class="mt-3 border border-base-300 rounded-lg p-3 bg-base-100">
    <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
      <h5 class="text-xs font-semibold">锚点对齐报告</h5>
      <div class="flex gap-1 text-xs flex-wrap">
        <span v-if="report.summary.applicable != null" class="badge badge-neutral badge-xs">
          检测 {{ report.summary.applicable }}
        </span>
        <span class="badge badge-success badge-xs">✓ {{ report.summary.aligned }}</span>
        <span class="badge badge-warning badge-xs">~ {{ report.summary.partial }}</span>
        <span class="badge badge-error badge-xs">✗ {{ report.summary.missing }}</span>
        <span v-if="report.summary.skipped" class="badge badge-ghost badge-xs">
          跳过 {{ report.summary.skipped }}
        </span>
      </div>
    </div>
    <p v-if="report.summary.skipped" class="text-xs text-base-content/40 mb-2">
      仅检测与本章相关的锚点；结构类全书锚点及大纲无关项已跳过
    </p>
    <ul class="space-y-2 max-h-40 overflow-auto">
      <li
        v-for="item in report.items"
        :key="item.anchorId"
        class="text-xs flex items-start gap-2"
        :class="item.skipped ? 'opacity-50' : ''"
      >
        <span class="badge badge-xs shrink-0" :class="badgeClass(item.aligned, item.skipped)">
          {{ badgeLabel(item.aligned, item.skipped) }}
        </span>
        <span class="text-base-content/70">
          <strong class="text-base-content/90">{{ item.title }}</strong>
          <span v-if="item.skipped"> — {{ item.skipReason || item.detail }}</span>
          <span v-else> — {{ item.detail }}</span>
        </span>
      </li>
    </ul>
  </div>
  <p v-else-if="report && report.summary.total === 0" class="text-xs text-base-content/40 mt-2">
    暂无活跃锚点，跳过对齐检测
  </p>
</template>
