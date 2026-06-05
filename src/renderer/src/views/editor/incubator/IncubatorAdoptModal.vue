<script setup lang="ts">
import { computed, inject, unref, type Ref } from 'vue'
import {
  INCUBATOR_SLOT_KEYS,
  INCUBATOR_SLOT_LABELS
} from '../../../../../shared/incubator-slots'
import { INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE } from '../../../../../shared/incubator-gate'
import { storylineAdoptKey } from './incubator-context'

const adopt = inject(storylineAdoptKey)!

/** 未 reactive 时 Ref 对象在 :class 里恒为 truthy，会误显示弹窗 */
function refBool(r: Ref<boolean> | boolean): boolean {
  return typeof r === 'boolean' ? r : r.value
}

const modalOpen = computed(() => refBool(adopt.modalOpen as Ref<boolean>))
const adopting = computed(() => refBool(adopt.adopting as Ref<boolean>))

const candidateScore = computed(() => {
  const s = adopt.candidateFinalScore as Ref<number | null> | number | null
  return typeof s === 'number' ? s : s?.value ?? null
})

const scoreBelowThreshold = computed(
  () => candidateScore.value != null && candidateScore.value < INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE
)
</script>

<template>
  <dialog class="modal" :class="{ 'modal-open': modalOpen }">
    <div class="modal-box max-w-md">
      <h3 class="font-bold text-sm mb-3">采纳到主线槽位</h3>
      <p v-if="adopt.payload" class="text-xs text-base-content/60 mb-3 line-clamp-3">
        {{ adopt.payload.title }} — {{ adopt.payload.summary }}
      </p>
      <label class="text-xs text-base-content/50">目标槽位</label>
      <select v-model="adopt.slotKey" class="select select-bordered select-sm w-full mb-3">
        <option v-for="key in INCUBATOR_SLOT_KEYS" :key="key" :value="key">
          {{ INCUBATOR_SLOT_LABELS[key] }}
        </option>
      </select>
      <p
        v-if="candidateScore != null"
        class="text-xs mb-2"
        :class="scoreBelowThreshold ? 'text-warning' : 'text-base-content/60'"
      >
        候选总分 {{ candidateScore }} · 入槽需 ≥ {{ INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE }}
        <span v-if="scoreBelowThreshold">（请先在评分矩阵填写加分并应用）</span>
      </p>
      <label class="text-xs text-base-content/50">采纳方式</label>
      <select v-model="adopt.mode" class="select select-bordered select-sm w-full mb-3">
        <option v-for="opt in adopt.adoptModeOptions" :key="opt.value" :value="opt.value">
          {{ opt.label }}
        </option>
      </select>
      <p v-if="adopt.adoptError" class="text-xs text-error mb-2">{{ adopt.adoptError }}</p>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" @click="adopt.close()">取消</button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="adopting"
          @click="adopt.confirm()"
        >
          {{ adopting ? '采纳中...' : '确认采纳' }}
        </button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop" @click="adopt.close()">
      <button type="button">close</button>
    </form>
  </dialog>
</template>
