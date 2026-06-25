<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch, provide, inject, toRef } from 'vue'
import SeedPanel from './SeedPanel.vue'
import StorylineComposerPanel from './StorylineComposerPanel.vue'
import CandidatePoolPanel from './CandidatePoolPanel.vue'
import ScoreMatrixPanel from './ScoreMatrixPanel.vue'
import IncubatorAnalysisPanel from './IncubatorAnalysisPanel.vue'
import IncubatorAdoptModal from './IncubatorAdoptModal.vue'
import VersionGraphPanel from './VersionGraphPanel.vue'
import IncubatorWorkflowGuide from './IncubatorWorkflowGuide.vue'
import SectionsPreviewDialog, { type PreviewSection } from '../../../components/SectionsPreviewDialog.vue'
import {
  getSlotKeysForWorkType,
  getIncubatorSlotLabel,
  type IncubatorSlotKey
} from '../../../../../shared/incubator-slots'
import { useIncubatorState } from '../../../composables/incubator/useIncubatorState'
import { useStorylineAdopt } from '../../../composables/incubator/useStorylineAdopt'
import {
  incubatorStateKey,
  storylineAdoptKey,
  incubatorSeedTextKey
} from './incubator-context'
import { editorNavKey } from '../editor-nav'

const props = defineProps<{ workId: number }>()
const nav = inject(editorNavKey)

const seedText = ref('')
const rightTab = ref<'candidates' | 'scores' | 'analysis'>('candidates')
const analysisRef = ref<InstanceType<typeof IncubatorAnalysisPanel> | null>(null)
const seedPanelRef = ref<InstanceType<typeof SeedPanel> | null>(null)
const storylineRef = ref<InstanceType<typeof StorylineComposerPanel> | null>(null)
const workType = ref<string | null>(null)

const activeSlotKeys = computed(() => getSlotKeysForWorkType(workType.value))

const incubator = useIncubatorState(toRef(props, 'workId'))
const adopt = useStorylineAdopt(props.workId, async () => {
  await incubator.refresh()
  await nav?.refreshProgress()
})

/** reactive 供模板自动 unwrap ref；IPC 在 confirm 内用 unref + toPlainForIpc，不传 adopt 代理 */
provide(incubatorStateKey, reactive(incubator))
provide(storylineAdoptKey, reactive(adopt))
provide(incubatorSeedTextKey, seedText)

async function loadWorkData() {
  const workId = props.workId
  if (!Number.isFinite(workId) || workId <= 0) return
  const ws = await incubator.refresh()
  const workInfo = await window.anovel.invoke('work:get', workId) as { work_type?: string } | null
  workType.value = workInfo?.work_type ?? null
  const settings = await window.anovel.invoke('setting:listByWork', props.workId) as { type: string; content: string }[]
  const idea = settings.find(s => s.type === 'idea')?.content?.trim() ?? ''
  const seedContent = ws.seed?.content?.trim() || idea || ws.ideaCompat || ''

  seedPanelRef.value?.setSeedFromLoad(seedContent)
  seedText.value = seedContent

  if (!ws.seed?.content?.trim() && idea) {
    await incubator.setSeed(idea)
  }

  await analysisRef.value?.loadSavedResults()
}

onMounted(() => void loadWorkData())

watch(() => props.workId, () => void loadWorkData())

async function onSaved() {
  await incubator.refresh()
  await nav?.refreshProgress()
}

const previewOpen = ref(false)
const previewSections = ref<PreviewSection[]>([])
const previewLoading = ref(false)

const hasPreviewContent = computed(() => {
  const ws = incubator.workspace.value
  const seed = seedText.value.trim() || ws?.seed?.content?.trim() || ''
  if (seed) return true
  const slotKeys = getSlotKeysForWorkType(workType.value)
  const slotContents = storylineRef.value?.getSlotContentsForPreview?.()
  if (slotContents && slotKeys.some(key => slotContents[key]?.trim())) return true
  const slots = ws?.activeDraftSlots ?? []
  return slotKeys.some(key =>
    slots.some(s => s.slotKey === key && s.content.trim())
  )
})

async function openFullPreview() {
  previewLoading.value = true
  try {
    await incubator.refresh()
    const ws = incubator.workspace.value
    const sections: PreviewSection[] = []

    const seed = seedText.value.trim() || ws?.seed?.content?.trim() || ''
    if (seed) sections.push({ label: '创作种子', content: seed })

    const slotKeys = getSlotKeysForWorkType(workType.value)
    const slotContents = storylineRef.value?.getSlotContentsForPreview?.() ?? {}
    const persistedSlots = ws?.activeDraftSlots ?? []
    for (const key of slotKeys) {
      const content =
        slotContents[key]?.trim() ||
        persistedSlots.find(s => s.slotKey === key)?.content?.trim() ||
        ''
      if (content) sections.push({ label: getIncubatorSlotLabel(key, workType.value), content })
    }

    const frozen = ws?.latestFrozenVersion
    if (frozen) {
      try {
        const detail = await window.anovel.invoke(
          'incubator:getVersionDetail',
          props.workId,
          frozen.id
        ) as {
          synthesizedSummary?: string | null
          qualitySnapshot?: string | null
        } | null
        const summary = detail?.synthesizedSummary?.trim()
        const quality = detail?.qualitySnapshot?.trim()
        if (summary) sections.push({ label: '统合摘要', content: summary })
        if (quality) sections.push({ label: '质量评分卡', content: quality })
      } catch { /* non-critical */ }
    }

    previewSections.value = sections
    previewOpen.value = true
  } finally {
    previewLoading.value = false
  }
}
</script>

<template>
  <IncubatorWorkflowGuide class="mb-4" :work-id="workId" />
  <div class="flex justify-end mb-3">
    <button
      type="button"
      class="btn btn-outline btn-primary btn-sm gap-1.5"
      :disabled="!hasPreviewContent || previewLoading"
      @click="openFullPreview"
    >
      <font-awesome-icon
        :icon="previewLoading ? 'spinner' : 'eye'"
        :spin="previewLoading"
        class="w-3.5 h-3.5"
      />
      {{ previewLoading ? '加载中...' : '预览全部大岗' }}
    </button>
  </div>
  <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
    <div class="space-y-4 min-w-0">
      <SeedPanel ref="seedPanelRef" :work-id="workId" @saved="onSaved" />
      <StorylineComposerPanel ref="storylineRef" :work-id="workId" @saved="onSaved" />
      <VersionGraphPanel :work-id="workId" @changed="onSaved" />
    </div>

    <div class="min-w-0">
      <div role="tablist" class="tabs tabs-box tabs-sm w-full mb-3">
        <a
          role="tab"
          href="#"
          class="tab"
          :class="{ 'tab-active': rightTab === 'candidates' }"
          @click.prevent="rightTab = 'candidates'"
        >候选池</a>
        <a
          role="tab"
          href="#"
          class="tab"
          :class="{ 'tab-active': rightTab === 'scores' }"
          @click.prevent="rightTab = 'scores'"
        >评分矩阵</a>
        <a
          role="tab"
          href="#"
          class="tab"
          :class="{ 'tab-active': rightTab === 'analysis' }"
          @click.prevent="rightTab = 'analysis'"
        >AI 分析</a>
      </div>

      <div class="card bg-base-200 border border-base-300 shadow-sm p-4 min-h-[320px]">
        <CandidatePoolPanel v-show="rightTab === 'candidates'" />
        <ScoreMatrixPanel v-show="rightTab === 'scores'" />
        <IncubatorAnalysisPanel
          v-show="rightTab === 'analysis'"
          ref="analysisRef"
          :work-id="workId"
          @workspace-refresh="onSaved"
        />
      </div>
    </div>
  </div>

  <IncubatorAdoptModal :work-id="workId" />

  <SectionsPreviewDialog
    :open="previewOpen"
    title="大岗预览"
    :sections="previewSections"
    empty-hint="尚无创作种子或槽位内容"
    @close="previewOpen = false"
  />
</template>
