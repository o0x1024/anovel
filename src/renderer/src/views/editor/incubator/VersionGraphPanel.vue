<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import type {
  IncubatorStorylineVersion,
  IncubatorVersionCompareResult,
  IncubatorVersionDetail
} from '../../../../../shared/incubator-types'
import { incubatorStateKey } from './incubator-context'

const props = defineProps<{ workId: number }>()
const emit = defineEmits<{ changed: [] }>()

const incubator = inject(incubatorStateKey)!

const versions = computed(() => incubator.workspace?.versions ?? [])
const compareA = ref<number | null>(null)
const compareB = ref<number | null>(null)
const compareResult = ref<IncubatorVersionCompareResult | null>(null)
const comparing = ref(false)
const detailId = ref<number | null>(null)
const detail = ref<IncubatorVersionDetail | null>(null)
const loadingDetail = ref(false)
const actingId = ref<number | null>(null)

const versionById = computed(() => new Map(versions.value.map(v => [v.id, v])))

const branchBaseLabel = computed(() => {
  const id = incubator.workspace?.branchBaseVersionId
  if (!id) return null
  const v = versionById.value.get(id)
  return v ? `V${v.versionNo} ${v.label}` : `版本 #${id}`
})

watch(
  () => incubator.workspace?.versions,
  () => {
    if (compareA.value && !versionById.value.has(compareA.value)) compareA.value = null
    if (compareB.value && !versionById.value.has(compareB.value)) compareB.value = null
  }
)

function parentLabel(v: IncubatorStorylineVersion): string | null {
  if (!v.baseVersionId) return null
  const p = versionById.value.get(v.baseVersionId)
  return p ? `基于 V${p.versionNo}` : `基于 #${v.baseVersionId}`
}

async function loadDetail(versionId: number) {
  detailId.value = versionId
  loadingDetail.value = true
  try {
    detail.value = await window.anovel.invoke(
      'incubator:getVersionDetail',
      props.workId,
      versionId
    ) as IncubatorVersionDetail | null
  } finally {
    loadingDetail.value = false
  }
}

async function restore(versionId: number) {
  if (!confirm('将以此版本覆盖当前主线草案槽位，是否继续？')) return
  actingId.value = versionId
  try {
    const res = await window.anovel.invoke(
      'incubator:restoreVersion',
      props.workId,
      versionId
    ) as { success: boolean; error?: string; workspace?: unknown }
    if (!res.success) {
      alert(res.error || '恢复失败')
      return
    }
    await incubator.refresh()
    emit('changed')
  } finally {
    actingId.value = null
  }
}

async function branch(versionId: number) {
  actingId.value = versionId
  try {
    const res = await window.anovel.invoke(
      'incubator:branchFromVersion',
      props.workId,
      versionId
    ) as { success: boolean; error?: string }
    if (!res.success) {
      alert(res.error || '分支失败')
      return
    }
    await incubator.refresh()
    emit('changed')
  } finally {
    actingId.value = null
  }
}

async function runCompare() {
  if (compareA.value == null || compareB.value == null || compareA.value === compareB.value) {
    alert('请选择两个不同的版本进行对比')
    return
  }
  comparing.value = true
  try {
    compareResult.value = await window.anovel.invoke(
      'incubator:compareVersions',
      props.workId,
      compareA.value,
      compareB.value
    ) as IncubatorVersionCompareResult | null
  } finally {
    comparing.value = false
  }
}

function formatTime(t: string): string {
  return t.replace('T', ' ').slice(0, 16)
}
</script>

<template>
  <div class="card bg-base-200 border border-base-300 shadow-sm p-4">
    <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
      <h4 class="font-semibold text-sm">版本历史</h4>
      <span v-if="branchBaseLabel" class="badge badge-warning badge-sm">
        分支编辑中 · {{ branchBaseLabel }}
      </span>
    </div>

    <p v-if="versions.length === 0" class="text-xs text-base-content/40 py-4">
      尚无冻结版本。完成主线编排并通过门禁后，点击「冻结 V1」。
    </p>

    <div v-else class="space-y-2 max-h-48 overflow-y-auto scrollbar-thin mb-4">
      <div
        v-for="v in versions"
        :key="v.id"
        class="border rounded-lg p-2 bg-base-100 text-xs"
        :class="v.id === incubator.workspace?.latestFrozenVersion?.id ? 'border-primary' : 'border-base-300'"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <span class="font-semibold">V{{ v.versionNo }}</span>
            <span class="mx-1 text-base-content/40">·</span>
            <span>{{ v.label }}</span>
            <span v-if="v.isFrozen" class="badge badge-primary badge-xs ml-1">冻结</span>
            <p class="text-base-content/50 mt-0.5">{{ formatTime(v.createdAt) }}</p>
            <p v-if="parentLabel(v)" class="text-base-content/40">{{ parentLabel(v) }}</p>
          </div>
          <div class="flex flex-col gap-1 shrink-0">
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              :disabled="actingId === v.id"
              @click="loadDetail(v.id)"
            >
              预览
            </button>
            <button
              type="button"
              class="btn btn-outline btn-primary btn-xs"
              :disabled="actingId === v.id"
              @click="restore(v.id)"
            >
              恢复
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              :disabled="actingId === v.id"
              @click="branch(v.id)"
            >
              开分支
            </button>
          </div>
        </div>
        <div class="flex gap-3 mt-2">
          <label class="flex items-center gap-1 cursor-pointer">
            <input v-model="compareA" type="radio" :value="v.id" name="cmpA" class="radio radio-xs" />
            <span>A</span>
          </label>
          <label class="flex items-center gap-1 cursor-pointer">
            <input v-model="compareB" type="radio" :value="v.id" name="cmpB" class="radio radio-xs" />
            <span>B</span>
          </label>
        </div>
      </div>
    </div>

    <button
      v-if="versions.length >= 2"
      type="button"
      class="btn btn-outline btn-primary btn-xs mb-3"
      :disabled="comparing"
      @click="runCompare"
    >
      {{ comparing ? '对比中...' : '对比所选版本' }}
    </button>

    <div v-if="compareResult" class="border border-base-300 rounded-lg p-2 bg-base-100 text-xs mb-3">
      <p class="font-medium mb-2">
        V{{ compareResult.versionA.versionNo }} vs V{{ compareResult.versionB.versionNo }}
      </p>
      <div
        v-for="d in compareResult.slotDiffs.filter(x => x.changed)"
        :key="d.slotKey"
        class="mb-2 pb-2 border-b border-base-300/50 last:border-0"
      >
        <p class="text-primary font-medium">{{ d.label }}（已变更）</p>
        <p class="text-base-content/50 mt-1 line-clamp-2"><span class="opacity-60">A:</span> {{ d.textA || '—' }}</p>
        <p class="text-base-content/50 line-clamp-2"><span class="opacity-60">B:</span> {{ d.textB || '—' }}</p>
      </div>
      <p
        v-if="!compareResult.slotDiffs.some(x => x.changed)"
        class="text-base-content/40"
      >
        两版本槽位内容一致
      </p>
    </div>

    <div v-if="detailId" class="border border-base-300 rounded-lg p-2 bg-base-100">
      <p class="text-xs font-medium mb-2">
        快照预览
        <span v-if="detail">· {{ detail.filledSlotCount }} 槽位</span>
      </p>
      <div v-if="loadingDetail" class="text-xs text-base-content/40">加载中...</div>
      <div v-else-if="detail" class="space-y-2 max-h-48 overflow-y-auto">
        <div v-if="detail.synthesizedSummary" class="pb-2 border-b border-base-300/50">
          <p class="text-xs text-primary font-medium">统合摘要</p>
          <p class="text-xs text-base-content/60 whitespace-pre-wrap line-clamp-4">{{ detail.synthesizedSummary }}</p>
        </div>
        <div v-if="detail.qualitySnapshot" class="pb-2 border-b border-base-300/50">
          <p class="text-xs text-primary font-medium">质量评分卡</p>
          <p class="text-xs text-base-content/60 whitespace-pre-wrap line-clamp-4">{{ detail.qualitySnapshot }}</p>
        </div>
        <div v-for="s in detail.slotPreviews" :key="s.slotKey">
          <p class="text-xs text-primary">{{ s.label }}</p>
          <p class="text-xs text-base-content/60 whitespace-pre-wrap line-clamp-3">{{ s.content }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
