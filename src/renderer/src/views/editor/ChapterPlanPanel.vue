<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import {
  type WritingPlanStatus,
  type NovelLength,
  type PresetNovelLength,
  getPresetsForType,
  getTargetWordPresets,
  getWordsPerChapterPresets,
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
const targetChapters = ref(200)
const wordsPerChapter = ref(4000)
const expanded = ref(false)

const workType = computed(() => status.value?.plan.workType || 'novel')
const chapterUnit = computed(() => workType.value === 'story' ? '拍' : '章')
const perChapterLabel = computed(() => workType.value === 'story' ? '每拍字数' : '每章字数')
const plannedVerb = computed(() => workType.value === 'story' ? '已拆解' : '已规划')
const planTitle = computed(() => workType.value === 'story' ? '节拍规划' : '章节规划')
const planDescription = computed(() => {
  if (workType.value === 'story') {
    return '按短故事目标字数、目标拍数与每拍字数设定节奏基线，引导拆解进度'
  }
  return '按目标总字数、目标章数与每章字数设定全书节奏，可自由编辑修改'
})

const novelLengthOptions = computed(() => {
  const presets = getPresetsForType(workType.value)
  return (Object.keys(presets) as PresetNovelLength[]).map(key => ({
    key,
    label: presets[key].label,
    summary: novelLengthSummary(key, workType.value)
  }))
})

const targetWordPresets = computed(() => getTargetWordPresets(workType.value))
const wordsPerChapterPresets = computed(() => getWordsPerChapterPresets(workType.value))

const selectedVolumeStatus = computed(() =>
  status.value?.volumes.find(v => v.id === props.selectedVolumeId) ?? null
)

const summaryLine = computed(() => {
  const s = status.value
  if (!s) return ''
  return [
    `建议 ${s.suggestedTotalChapters} ${chapterUnit.value}`,
    `${plannedVerb.value} ${s.actualTotalChapters} ${chapterUnit.value}（${s.outlineProgressPercent}%）`,
    `正文 ${formatWordCount(s.writtenWords)} / ${formatWordCount(s.plan.targetTotalWords)}（${s.writtenProgressPercent}%）`
  ].join(' · ')
})

const collapsedSummary = computed(() => {
  if (summaryLine.value) return summaryLine.value
  if (novelLength.value === 'custom') return `${formatWordCount(targetTotalWords.value)} · ${targetChapters.value} ${chapterUnit.value} · ${perChapterLabel.value} ${wordsPerChapter.value} 字`
  return selectedNovelLengthSummary.value
})
const selectedNovelLengthSummary = computed(() => novelLength.value === 'custom' ? '' : novelLengthSummary(novelLength.value, workType.value))

onMounted(loadStatus)

watch(() => props.workId, loadStatus)

async function loadStatus() {
  status.value = await window.anovel.invoke('writingPlan:getStatus', props.workId) as WritingPlanStatus
  targetTotalWords.value = status.value.plan.targetTotalWords
  targetChapters.value = status.value.plan.targetChapters
  wordsPerChapter.value = status.value.plan.wordsPerChapter
  novelLength.value = status.value.plan.novelLength
  emit('status-change', status.value)
}

async function applyNovelLength() {
  if (saving.value) return
  if (novelLength.value === 'custom') {
    await savePlan()
    return
  }
  saving.value = true
  try {
    await window.anovel.invoke('writingPlan:applyNovelLength', props.workId, novelLength.value as PresetNovelLength)
    await loadStatus()
    emit('updated')
  } finally {
    saving.value = false
  }
}

async function savePlan() {
  if (saving.value) return
  targetTotalWords.value = Math.max(1, Math.round(Number(targetTotalWords.value) || 1))
  targetChapters.value = Math.max(1, Math.round(Number(targetChapters.value) || 1))
  wordsPerChapter.value = Math.max(1, Math.round(Number(wordsPerChapter.value) || 1))
  saving.value = true
  try {
    await window.anovel.invoke('writingPlan:update', props.workId, {
      targetTotalWords: targetTotalWords.value,
      targetChapters: targetChapters.value,
      wordsPerChapter: wordsPerChapter.value,
      novelLength: 'custom'
    })
    await loadStatus()
    emit('updated')
  } finally {
    saving.value = false
  }
}

function syncWordsPerChapter() {
  targetTotalWords.value = Math.max(1, Math.round(Number(targetTotalWords.value) || 1))
  targetChapters.value = Math.max(1, Math.round(Number(targetChapters.value) || 1))
  wordsPerChapter.value = Math.max(1, Math.round(targetTotalWords.value / targetChapters.value))
  savePlan()
}

function syncTargetTotalWords() {
  targetChapters.value = Math.max(1, Math.round(Number(targetChapters.value) || 1))
  wordsPerChapter.value = Math.max(1, Math.round(Number(wordsPerChapter.value) || 1))
  targetTotalWords.value = targetChapters.value * wordsPerChapter.value
  savePlan()
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
          <h4 class="font-semibold text-sm shrink-0">{{ planTitle }}</h4>
          <font-awesome-icon
            :icon="expanded ? 'chevron-up' : 'chevron-down'"
            class="w-3 h-3 shrink-0 text-base-content/40"
          />
        </div>
        <p v-if="!expanded" class="text-xs text-base-content/50 mt-1 truncate">{{ collapsedSummary }}</p>
        <p v-else class="text-xs text-base-content/50 mt-0.5">
          {{ planDescription }}
        </p>
      </div>
      <div v-if="selectedVolumeStatus && !expanded" class="flex items-center gap-2 shrink-0 text-xs">
        <span
          class="badge badge-sm"
          :class="selectedVolumeStatus.gap > 0 ? 'badge-warning' : 'badge-success'"
        >
          {{ volumePlanLabel(selectedVolumeStatus, workType) }}
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
          <option v-if="novelLength === 'custom'" value="custom">自定义</option>
          <option v-for="opt in novelLengthOptions" :key="opt.key" :value="opt.key">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <p v-if="novelLength === 'custom'" class="text-xs text-base-content/50 pb-2 max-w-md">
        自定义：{{ formatWordCount(targetTotalWords) }} · {{ targetChapters }} {{ chapterUnit }} · {{ perChapterLabel }} {{ wordsPerChapter }} 字
      </p>
      <p v-else-if="novelLengthOptions.length" class="text-xs text-base-content/50 pb-2 max-w-md">
        {{ selectedNovelLengthSummary }}
      </p>
    </div>

    <div class="flex flex-wrap gap-3 items-end">
      <label class="form-control">
        <span class="label-text text-xs text-base-content/50">目标总字数</span>
        <input
          v-model.number="targetTotalWords"
          type="number"
          min="1"
          step="1000"
          :list="`targetWordPresets-${workId}`"
          class="input input-bordered input-sm w-36"
          @change="syncWordsPerChapter"
          @keyup.enter="syncWordsPerChapter"
        />
        <datalist :id="`targetWordPresets-${workId}`">
          <option v-for="n in targetWordPresets" :key="n" :value="n">{{ formatWordCount(n) }}</option>
        </datalist>
      </label>
      <label class="form-control">
        <span class="label-text text-xs text-base-content/50">目标{{ chapterUnit }}数</span>
        <input
          v-model.number="targetChapters"
          type="number"
          min="1"
          step="1"
          class="input input-bordered input-sm w-28"
          @change="syncWordsPerChapter"
          @keyup.enter="syncWordsPerChapter"
        />
      </label>
      <label class="form-control">
        <span class="label-text text-xs text-base-content/50">{{ perChapterLabel }}</span>
        <input
          v-model.number="wordsPerChapter"
          type="number"
          min="1"
          step="100"
          :list="`wordsPerChapterPresets-${workId}`"
          class="input input-bordered input-sm w-28"
          @change="syncTargetTotalWords"
          @keyup.enter="syncTargetTotalWords"
        />
        <datalist :id="`wordsPerChapterPresets-${workId}`">
          <option v-for="n in wordsPerChapterPresets" :key="n" :value="n">{{ n }} 字</option>
        </datalist>
      </label>
      <div v-if="status" class="text-xs pb-2 text-base-content/60">
        ≈ <span class="font-medium text-base-content">{{ status.suggestedTotalChapters }}</span> {{ chapterUnit }}
        <span v-if="status.volumes.length">
          · 每{{ workType === 'story' ? '分卷' : '卷' }}约
          <span class="font-medium">{{ Math.ceil(status.suggestedTotalChapters / status.volumes.length) }}</span>
          {{ chapterUnit }}
        </span>
      </div>
    </div>

    <div
      v-if="workType === 'story' && $slots['story-batch']"
      class="mt-3 pt-3 border-t border-base-300/50"
    >
      <slot name="story-batch" />
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
        {{ volumePlanLabel(selectedVolumeStatus, workType) }}
      </span>
      <span v-if="selectedVolumeStatus.gap > 0" class="text-warning">
        建议再{{ workType === 'story' ? '拆解' : '规划' }} {{ selectedVolumeStatus.gap }} {{ chapterUnit }}
      </span>
      <span v-else class="text-success">当前{{ chapterUnit }}数已达建议量</span>
    </div>
    </div>
  </div>
</template>
