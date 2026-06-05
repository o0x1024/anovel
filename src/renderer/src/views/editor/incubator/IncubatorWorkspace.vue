<script setup lang="ts">
import { ref, reactive, onMounted, watch, provide, inject, toRef } from 'vue'
import SeedPanel from './SeedPanel.vue'
import StorylineComposerPanel from './StorylineComposerPanel.vue'
import CandidatePoolPanel from './CandidatePoolPanel.vue'
import ScoreMatrixPanel from './ScoreMatrixPanel.vue'
import IncubatorAnalysisPanel from './IncubatorAnalysisPanel.vue'
import IncubatorAdoptModal from './IncubatorAdoptModal.vue'
import VersionGraphPanel from './VersionGraphPanel.vue'
import IncubatorWorkflowGuide from './IncubatorWorkflowGuide.vue'
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
  const ws = await incubator.refresh()
  const settings = await window.anovel.invoke('setting:listByWork', props.workId) as { type: string; content: string }[]
  const idea = settings.find(s => s.type === 'idea')?.content?.trim() ?? ''
  const seedContent = ws.seed?.content?.trim() || idea || ws.ideaCompat || ''

  seedPanelRef.value?.setSeedFromLoad(seedContent)
  seedText.value = seedContent

  if (!ws.seed?.content?.trim() && idea) {
    await incubator.setSeed(idea)
  }

  if (loadedHasVariantsOrExpand(settings)) {
    const variants = settings.find(s => s.type === 'incubator_variants')?.content
    const expand = settings.find(s => s.type === 'incubator_expand')?.content
    if (variants?.trim()) {
      await window.anovel.invoke('incubator:syncParsedCandidates', props.workId, 'variants', variants, true)
    }
    if (expand?.trim()) {
      await window.anovel.invoke('incubator:syncParsedCandidates', props.workId, 'expand', expand, true)
    }
    await incubator.refresh()
  }

  await analysisRef.value?.loadSavedResults()
}

onMounted(() => void loadWorkData())

watch(() => props.workId, () => void loadWorkData())

function loadedHasVariantsOrExpand(settings: { type: string; content: string }[]) {
  return settings.some(s => s.type === 'incubator_variants' || s.type === 'incubator_expand')
}

async function onSaved() {
  await incubator.refresh()
  await nav?.refreshProgress()
}
</script>

<template>
  <IncubatorWorkflowGuide class="mb-4" />
  <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
    <div class="space-y-4 min-w-0">
      <SeedPanel ref="seedPanelRef" :work-id="workId" @saved="onSaved" />
      <StorylineComposerPanel @saved="onSaved" />
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

  <IncubatorAdoptModal />
</template>
