<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE } from '../../../../../shared/incubator-gate'
import { incubatorStateKey } from './incubator-context'

const incubator = inject(incubatorStateKey)!
const adjustingId = ref<number | null>(null)
const adjustById = ref<Record<number, number>>({})

function getAdjust(id: number): number {
  return adjustById.value[id] ?? 0
}

function setAdjust(id: number, v: number) {
  adjustById.value = { ...adjustById.value, [id]: v }
}

const rows = computed(() => {
  const list = [...(incubator.workspace?.candidates ?? [])]
  return list
    .filter(c => c.latestScore)
    .sort((a, b) => (b.latestScore?.finalTotal ?? 0) - (a.latestScore?.finalTotal ?? 0))
})

async function applyAdjust(candidateId: number) {
  adjustingId.value = candidateId
  try {
    await incubator.setUserScoreAdjustment(candidateId, getAdjust(candidateId))
    const next = { ...adjustById.value }
    delete next[candidateId]
    adjustById.value = next
  } finally {
    adjustingId.value = null
  }
}
</script>

<template>
  <div class="overflow-x-auto">
    <p v-if="!rows.length" class="text-sm text-base-content/40 py-6 text-center">
      暂无评分数据，请先在候选池点击「重新评分」
    </p>
    <table v-else class="table table-xs table-zebra">
      <thead>
        <tr>
          <th>候选</th>
          <th>吸引</th>
          <th>连载</th>
          <th>差异</th>
          <th>闭环</th>
          <th>执行</th>
          <th>总分</th>
          <th />
        </tr>
      </thead>
      <tbody>
        <tr v-for="c in rows" :key="c.id">
          <td class="max-w-[8rem] truncate font-medium">{{ c.title }}</td>
          <td>{{ c.latestScore!.attractionScore }}</td>
          <td>{{ c.latestScore!.serializabilityScore }}</td>
          <td>{{ c.latestScore!.differentiationScore }}</td>
          <td>{{ c.latestScore!.conflictClosureScore }}</td>
          <td>{{ c.latestScore!.executabilityScore }}</td>
          <td class="font-semibold">{{ c.latestScore!.finalTotal }}</td>
          <td>
            <div class="flex items-center gap-1">
              <input
                :value="getAdjust(c.id) || ''"
                type="number"
                min="-30"
                max="30"
                step="1"
                placeholder="+分"
                class="input input-bordered input-xs w-16"
                @input="setAdjust(c.id, Number(($event.target as HTMLInputElement).value) || 0)"
              />
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                :disabled="adjustingId === c.id"
                @click="applyAdjust(c.id)"
              >
                {{ adjustingId === c.id ? '…' : '应用' }}
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
    <p class="text-[11px] text-base-content/40 mt-2">
      填写加减分（如 +3）后点「应用」；采纳入槽需总分 ≥ {{ INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE }}。
    </p>
  </div>
</template>
