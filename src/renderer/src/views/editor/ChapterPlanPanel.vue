<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import {
  type WritingPlanStatus,
  type NovelLength,
  TARGET_WORD_PRESETS,
  WORDS_PER_CHAPTER_PRESETS,
  NOVEL_LENGTH_PRESETS,
  formatWordCount,
  volumePlanLabel,
  novelLengthSummary
} from './chapter-plan-ui'

const props = defineProps<{ workId: number; selectedVolumeId?: number | null }>()
const emit = defineEmits<{ updated: []; 'status-change': [WritingPlanStatus] }>()

const status = ref<WritingPlanStatus | null>(null)
const saving = ref(false)
const novelLength = ref<NovelLength>('medium')
const targetTotalWords = ref(800_000)
const wordsPerChapter = ref(4000)
const expanded = ref(false)

const novelLengthOptions = computed(() =>
  (Object.keys(NOVEL_LENGTH_PRESETS) as NovelLength[]).map(key => ({
    key,
    label: NOVEL_LENGTH_PRESETS[key].label,
    summary: novelLengthSummary(key)
  }))
)

const selectedVolumeStatus = computed(() =>
  status.value?.volumes.find(v => v.id === props.selectedVolumeId) ?? null
)

const summaryLine = computed(() => {
  const s = status.value
  if (!s) return ''
  return [
    `建议 ${s.suggestedTotalChapters} 章`,
    `已规划 ${s.actualTotalChapters} 章（${s.outlineProgressPercent}%）`,
    `正文 ${formatWordCount(s.writtenWords)} / ${formatWordCount(s.plan.targetTotalWords)}（${s.writtenProgressPercent}%）`
  ].join(' · ')
})

const collapsedSummary = computed(() => {
  if (summaryLine.value) return summaryLine.value
  return novelLengthSummary(novelLength.value)
})

onMounted(loadStatus)

watch(() => props.workId, loadStatus)

async function loadStatus() {
  status.value = await window.anovel.invoke('writingPlan:getStatus', props.workId) as WritingPlanStatus
  targetTotalWords.value = status.value.plan.targetTotalWords
  wordsPerChapter.value = status.value.plan.wordsPerChapter
  novelLength.value = status.value.plan.novelLength
  emit('status-change', status.value)
}

async function applyNovelLength() {
  if (saving.value) return
  saving.value = true
  try {
    await window.anovel.invoke('writingPlan:applyNovelLength', props.workId, novelLength.value)
    await loadStatus()
    emit('updated')
  } finally {
    saving.value = false
  }
}

async function savePlan() {
  if (saving.value) return
  saving.value = true
  try {
    await window.anovel.invoke('writingPlan:update', props.workId, {
      targetTotalWords: targetTotalWords.value,
      wordsPerChapter: wordsPerChapter.value
    })
    await loadStatus()
    emit('updated')
  } finally {
    saving.value = false
  }
}

defineExpose({ reload: loadStatus })
</script>

<template>
  <div class="card bg-base-200 border border-base-300 shadow-sm mb-6 overflow-hidden">
    <button
      type="button"
      class="w-full flex items-start justify-between gap-3 p-4 text-left hover:bg-base-100/80 transition-colors"
      @click="expanded = !expanded"
    >
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 flex-wrap">
          <h4 class="font-semibold text-sm shrink-0">章节规划</h4>
          <font-awesome-icon
            :icon="expanded ? 'chevron-up' : 'chevron-down'"
            class="w-3 h-3 shrink-0 text-base-content/40"
          />
        </div>
        <p v-if="!expanded" class="text-xs text-base-content/50 mt-1 truncate">{{ collapsedSummary }}</p>
        <p v-else class="text-xs text-base-content/50 mt-0.5">
          按篇幅类型设定目标总字数；默认每章约 4000 字，反推全书与各卷章数
        </p>
      </div>
      <div v-if="selectedVolumeStatus && !expanded" class="flex items-center gap-2 shrink-0 text-xs">
        <span
          class="badge badge-sm"
          :class="selectedVolumeStatus.gap > 0 ? 'badge-warning' : 'badge-success'"
        >
          {{ volumePlanLabel(selectedVolumeStatus) }}
        </span>
      </div>
    </button>

    <div v-show="expanded" class="px-4 pb-4 pt-0 border-t border-base-300/50">
      <p v-if="summaryLine" class="text-xs text-base-content/60 mb-3 pt-3">{{ summaryLine }}</p>

      <div class="flex flex-wrap gap-3 items-end mb-3">
      <label class="form-control">
        <span class="label-text text-xs text-base-content/50">篇幅类型</span>
        <select
          v-model="novelLength"
          class="select select-bordered select-sm w-32"
          @change="applyNovelLength"
        >
          <option v-for="opt in novelLengthOptions" :key="opt.key" :value="opt.key">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <p v-if="novelLengthOptions.length" class="text-xs text-base-content/50 pb-2 max-w-md">
        {{ novelLengthSummary(novelLength) }}
      </p>
    </div>

    <div class="flex flex-wrap gap-3 items-end">
      <label class="form-control">
        <span class="label-text text-xs text-base-content/50">目标总字数</span>
        <select
          v-model.number="targetTotalWords"
          class="select select-bordered select-sm w-36"
          @change="savePlan"
        >
          <option v-for="n in TARGET_WORD_PRESETS" :key="n" :value="n">{{ formatWordCount(n) }}</option>
        </select>
      </label>
      <label class="form-control">
        <span class="label-text text-xs text-base-content/50">每章字数</span>
        <select
          v-model.number="wordsPerChapter"
          class="select select-bordered select-sm w-28"
          @change="savePlan"
        >
          <option v-for="n in WORDS_PER_CHAPTER_PRESETS" :key="n" :value="n">{{ n }} 字</option>
        </select>
      </label>
      <div v-if="status" class="text-xs pb-2 text-base-content/60">
        ≈ <span class="font-medium text-base-content">{{ status.suggestedTotalChapters }}</span> 章
        <span v-if="status.volumes.length">
          · 每卷约
          <span class="font-medium">{{ Math.ceil(status.suggestedTotalChapters / status.volumes.length) }}</span>
          章
        </span>
      </div>
    </div>

    <div
      v-if="selectedVolumeStatus"
      class="mt-3 pt-3 border-t border-base-300/50 flex flex-wrap items-center gap-2 text-xs"
    >
      <span class="text-base-content/50">当前分卷</span>
      <span class="font-medium">{{ selectedVolumeStatus.name }}</span>
      <span
        class="badge badge-sm"
        :class="selectedVolumeStatus.gap > 0 ? 'badge-warning' : 'badge-success'"
      >
        {{ volumePlanLabel(selectedVolumeStatus) }}
      </span>
      <span v-if="selectedVolumeStatus.gap > 0" class="text-warning">
        建议再规划 {{ selectedVolumeStatus.gap }} 章
      </span>
      <span v-else class="text-success">本章数已达建议量</span>
    </div>
    </div>
  </div>
</template>
