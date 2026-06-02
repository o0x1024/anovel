<script setup lang="ts">
import type { WorkSummaryResult } from '../../../../shared/assistant-types'

defineProps<{
  summary: WorkSummaryResult
}>()
</script>

<template>
  <div class="card bg-base-200 border border-secondary/20 mt-2">
    <div class="card-body p-4 gap-3">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h4 class="font-bold text-sm">{{ summary.title }}</h4>
          <p class="text-xs text-base-content/60 mt-1 italic">{{ summary.logline }}</p>
        </div>
        <span
          class="badge badge-sm"
          :class="{
            'badge-success': summary.confidence === 'high',
            'badge-warning': summary.confidence === 'medium',
            'badge-ghost': summary.confidence === 'low'
          }"
        >
          {{ summary.confidence }}
        </span>
      </div>

      <div v-if="summary.characters?.length">
        <p class="text-xs font-semibold text-base-content/50 mb-1">主要人物</p>
        <ul class="space-y-1 text-xs">
          <li v-for="(c, i) in summary.characters" :key="i">
            <strong>{{ c.name }}</strong>
            <span class="text-base-content/40"> · {{ c.role }}</span>
            — {{ c.traits }}
          </li>
        </ul>
      </div>

      <div v-if="summary.plotOutline?.length">
        <p class="text-xs font-semibold text-base-content/50 mb-1">情节脉络</p>
        <ol class="list-decimal list-inside text-xs space-y-0.5">
          <li v-for="(step, i) in summary.plotOutline" :key="i">{{ step }}</li>
        </ol>
      </div>

      <div v-if="summary.themes?.length" class="flex flex-wrap gap-1">
        <span v-for="(t, i) in summary.themes" :key="i" class="badge badge-outline badge-xs">{{ t }}</span>
      </div>

      <p v-if="summary.pacingNotes" class="text-xs text-base-content/60">
        <span class="text-base-content/40">节奏：</span>{{ summary.pacingNotes }}
      </p>

      <p v-if="summary.warnings?.length" class="text-xs text-warning">
        {{ summary.warnings.join('；') }}
      </p>
    </div>
  </div>
</template>
