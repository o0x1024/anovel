<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE } from '../../../../../shared/incubator-gate'
import type { IncubatorCandidate } from '../../../../../shared/incubator-types'
import { incubatorStateKey, storylineAdoptKey } from './incubator-context'

const incubator = inject(incubatorStateKey)!
const adopt = inject(storylineAdoptKey)!

const sourceLabels: Record<string, string> = {
  variants: '变体',
  expand: '扩写',
  manual: '手动',
  microinnovation: '微创新',
  premise_gen: '主题前提',
  role_engine_gen: '角色驱动',
  world_rules_gen: '世界规则',
  rhythm_curve_gen: '节奏曲线',
  ending_gen: '终局设计'
}

const selecting = ref(false)
const selected = ref<Set<number>>(new Set())
const deleting = ref(false)

const sortedCandidates = computed(() => {
  const list = [...(incubator.workspace?.candidates ?? [])]
  return list.sort((a, b) => {
    const sa = a.latestScore?.finalTotal ?? 0
    const sb = b.latestScore?.finalTotal ?? 0
    return sb - sa
  })
})

const allSelected = computed(() =>
  sortedCandidates.value.length > 0 &&
  sortedCandidates.value.every(c => selected.value.has(c.id))
)

function toggleSelectMode() {
  selecting.value = !selecting.value
  if (!selecting.value) selected.value = new Set()
}

function toggleSelect(id: number) {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function toggleSelectAll() {
  if (allSelected.value) {
    selected.value = new Set()
  } else {
    selected.value = new Set(sortedCandidates.value.map(c => c.id))
  }
}

async function deleteOne(c: IncubatorCandidate) {
  if (!confirm(`确定删除「${c.title}」？`)) return
  deleting.value = true
  try {
    await incubator.deleteCandidate(c.id)
  } finally {
    deleting.value = false
  }
}

async function deleteSelected() {
  const ids = [...selected.value]
  if (!ids.length) return
  if (!confirm(`确定删除选中的 ${ids.length} 条候选？`)) return
  deleting.value = true
  try {
    await incubator.deleteCandidates(ids)
    selected.value = new Set()
    selecting.value = false
  } finally {
    deleting.value = false
  }
}

function adoptScore(c: IncubatorCandidate & { latestScore?: { finalTotal: number } | null }) {
  return c.latestScore?.finalTotal ?? 0
}

function canAdoptToSlot(c: IncubatorCandidate & { latestScore?: { finalTotal: number } | null }) {
  return adoptScore(c) >= INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE
}

const sourceStepToSlot: Record<string, import('../../../../../shared/incubator-slots').IncubatorSlotKey> = {
  variants: 'core_conflict',
  expand: 'opening',
  premise_gen: 'premise',
  role_engine_gen: 'role_engine',
  world_rules_gen: 'world_rules',
  ending_gen: 'ending'
}

function openAdopt(c: IncubatorCandidate) {
  const step = c.sourceStep === 'expand' || c.sourceStep === 'variants'
    || c.sourceStep === 'premise_gen' || c.sourceStep === 'role_engine_gen'
    || c.sourceStep === 'world_rules_gen' || c.sourceStep === 'rhythm_curve_gen'
    || c.sourceStep === 'ending_gen'
    ? c.sourceStep : 'expand'
  adopt.openFromCandidate(
    c.id,
    { title: c.title, summary: c.summary, sourceStep: step },
    sourceStepToSlot[c.sourceStep] ?? 'opening',
    adoptScore(c)
  )
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex items-center justify-between gap-2 flex-wrap">
      <p class="text-xs text-base-content/50">
        共 {{ sortedCandidates.length }} 条候选 · 入槽建议 ≥ {{ INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE }} 分
      </p>
      <div class="flex items-center gap-1">
        <template v-if="selecting">
          <button
            type="button"
            class="btn btn-ghost btn-xs"
            @click="toggleSelectAll"
          >
            {{ allSelected ? '取消全选' : '全选' }}
          </button>
          <button
            type="button"
            class="btn btn-error btn-xs"
            :disabled="deleting || !selected.size"
            @click="deleteSelected"
          >
            {{ deleting ? '删除中...' : `删除 (${selected.size})` }}
          </button>
          <button type="button" class="btn btn-ghost btn-xs" @click="toggleSelectMode">取消</button>
        </template>
        <template v-else>
          <button
            v-if="sortedCandidates.length"
            type="button"
            class="btn btn-ghost btn-xs"
            @click="toggleSelectMode"
          >
            批量管理
          </button>
          <button
            type="button"
            class="btn btn-outline btn-primary btn-xs"
            :disabled="incubator.loading || !sortedCandidates.length"
            @click="incubator.rescoreAll()"
          >
            重新评分
          </button>
        </template>
      </div>
    </div>

    <div v-if="sortedCandidates.length === 0" class="text-center py-8 text-base-content/40 text-sm">
      运行「变体探索」或「方向扩写」后，候选会出现在这里
    </div>

    <div
      v-for="c in sortedCandidates"
      :key="c.id"
      class="border border-base-300 rounded-lg p-3 bg-base-100"
      :class="{ 'ring-2 ring-primary/30': selecting && selected.has(c.id) }"
    >
      <div class="flex items-start justify-between gap-2 mb-1">
        <div class="flex items-start gap-2 min-w-0">
          <input
            v-if="selecting"
            type="checkbox"
            class="checkbox checkbox-xs checkbox-primary mt-1 shrink-0"
            :checked="selected.has(c.id)"
            @change="toggleSelect(c.id)"
          />
          <div class="min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h5 class="font-semibold text-sm truncate">{{ c.title }}</h5>
              <span class="badge badge-outline badge-xs">{{ sourceLabels[c.sourceStep] || c.sourceStep }}</span>
              <span
                v-if="c.latestScore"
                class="badge badge-sm"
                :class="c.latestScore.finalTotal >= INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE ? 'badge-primary' : 'badge-ghost'"
              >
                {{ c.latestScore.finalTotal }} 分
              </span>
              <span
                v-if="c.latestScore?.rationale"
                class="text-[11px] text-base-content/40 italic truncate max-w-[180px]"
                :title="c.latestScore.rationale"
              >
                {{ c.latestScore.rationale }}
              </span>
            </div>
            <p v-if="c.dimension" class="text-xs text-base-content/50 mt-0.5">{{ c.dimension }}</p>
          </div>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button
            v-if="!selecting"
            type="button"
            class="btn btn-ghost btn-xs text-error"
            :disabled="deleting"
            @click="deleteOne(c)"
            title="删除"
          >
            ✕
          </button>
          <button
            type="button"
            class="btn btn-primary btn-xs"
            :disabled="selecting || !canAdoptToSlot(c)"
            :title="canAdoptToSlot(c) ? '' : `总分 ${adoptScore(c)} 低于入槽阈值 ${INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE}，请在评分矩阵加分并应用`"
            @click="openAdopt(c)"
          >
            采纳到槽位
          </button>
        </div>
      </div>
      <p class="text-xs text-base-content/70 whitespace-pre-wrap line-clamp-4">{{ c.summary }}</p>
      <p v-if="!canAdoptToSlot(c)" class="text-[11px] text-warning mt-1">
        总分 {{ adoptScore(c) }} 低于 {{ INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE }}：请到「评分矩阵」填写加分并点「应用」，或采纳时选「仅加入候选池」
      </p>
    </div>
  </div>
</template>
