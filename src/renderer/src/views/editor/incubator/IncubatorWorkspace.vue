<script setup lang="ts">
import { ref, reactive, computed, onMounted, watch, provide, inject, toRef } from 'vue'
import SeedPanel from './SeedPanel.vue'
import StorylineComposerPanel from './StorylineComposerPanel.vue'
import CandidatePoolPanel from './CandidatePoolPanel.vue'
import ScoreMatrixPanel from './ScoreMatrixPanel.vue'
import IncubatorAnalysisPanel from './IncubatorAnalysisPanel.vue'
import IncubatorAdoptModal from './IncubatorAdoptModal.vue'
import VersionGraphPanel from './VersionGraphPanel.vue'
import SectionsPreviewDialog, { type PreviewSection } from '../../../components/SectionsPreviewDialog.vue'
import {
  getSlotKeysForWorkType,
  getIncubatorSlotLabel,
  type IncubatorSlotKey
} from '../../../../../shared/incubator-slots'
import { useIncubatorState } from '../../../composables/incubator/useIncubatorState'
import { useStorylineAdopt } from '../../../composables/incubator/useStorylineAdopt'
import { useBodyGenerationModel } from '../../../composables/useBodyGenerationModel'
import {
  incubatorStateKey,
  storylineAdoptKey,
  incubatorSeedTextKey
} from './incubator-context'
import { editorNavKey } from '../editor-nav'

const props = defineProps<{ workId: number }>()
const nav = inject(editorNavKey)
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)

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

interface TitleIntroOption {
  title: string
  description: string
  click_driver?: string
  reason?: string
}

const previewOpen = ref(false)
const previewSections = ref<PreviewSection[]>([])
const previewLoading = ref(false)
const titleIntroLoading = ref(false)
const titleIntroOptions = ref<TitleIntroOption[]>([])
const titleIntroError = ref('')

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

async function collectIncubatorSections(): Promise<PreviewSection[]> {
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

  return sections
}

async function openFullPreview() {
  previewLoading.value = true
  try {
    previewSections.value = await collectIncubatorSections()
    previewOpen.value = true
  } finally {
    previewLoading.value = false
  }
}

function normalizeTitleIntroOption(raw: unknown): TitleIntroOption | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const title = typeof obj.title === 'string' ? obj.title.trim() : ''
  const description = typeof obj.description === 'string' ? obj.description.trim() : ''
  if (!title || !description) return null
  return {
    title,
    description,
    click_driver: typeof obj.click_driver === 'string' ? obj.click_driver.trim() : '',
    reason: typeof obj.reason === 'string' ? obj.reason.trim() : ''
  }
}

function parseTitleIntro(raw: string): TitleIntroOption[] {
  let text = raw.trim()
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (match) text = match[1].trim()
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first !== -1 && last > first) text = text.slice(first, last + 1)
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const source = Array.isArray(parsed.options)
      ? parsed.options
      : Array.isArray(parsed.items)
        ? parsed.items
        : [parsed]
    return source.map(normalizeTitleIntroOption).filter((x): x is TitleIntroOption => x != null)
  } catch {
    return []
  }
}

async function generateTitleIntro() {
  if (titleIntroLoading.value || !hasPreviewContent.value) return
  titleIntroLoading.value = true
  titleIntroOptions.value = []
  titleIntroError.value = ''
  try {
    const sections = await collectIncubatorSections()
    const content = sections.map(s => `【${s.label}】\n${s.content}`).join('\n\n')
    const noun = workType.value === 'story' ? '短故事' : '小说'
    const res = await window.anovel.invoke('model:chat', {
      workId: props.workId,
      step: 'incubator_title_intro',
      prompt: `请基于以下孵化内容，为这部${noun}生成 6 组可供用户选择的书名和作品简介。\n\n${content}`,
      systemPrompt: [
        `你是顶级网文商业编辑和增长型文案策划，目标是让读者看到${noun}书名和简介后产生“必须点进去看看”的冲动。`,
        '从第一性原理出发：人会被生存焦虑、身份跃迁、地位逆转、复仇清算、禁忌窥探、秘密揭露、稀缺机会、强烈不公、情感背叛、权力失控、命运反转、爽点承诺所驱动。',
        '你要把输入中的真实设定转译成这些点击驱动力，而不是堆砌华丽词。',
        '只输出 JSON 对象，禁止 Markdown、解释、思考过程和代码块。',
        '格式：{"options":[{"title":"书名","description":"简介","click_driver":"触发的人性欲望/弱点","reason":"为什么这个方案更想让人点开"}]}',
        '必须生成 6 个差异明显的方案：至少覆盖逆袭爽点、秘密悬念、危机压迫、情感牵引、身份反转、利益/权力博弈等不同角度。',
        '书名要求：有钩子、有画面、有冲突或反差；避免空泛套话；尽量 2-12 个汉字；不要副标题；不要像论文标题。',
        '简介要求：80-180 字；第一句就抛出不公、危机、秘密、反转或强欲望；突出主角、核心矛盾、金手指/卖点、情绪钩子；不要剧透结局。',
        '禁止使用“这是一个关于”“在这个世界中”“且看主角如何”等平淡开头。',
        '必须忠于输入内容，不得凭空添加未出现的核心设定。'
      ].join('\n'),
      workContextOptions: {
        includeIdea: true,
        includeCoreSettings: true,
        includeVolumes: true
      },
      ...bodyModelParams()
    }) as { success: boolean; content?: string; error?: string }
    if (!res.success || !res.content) {
      titleIntroError.value = res.error || '生成失败'
      return
    }
    const parsed = parseTitleIntro(res.content)
    if (parsed.length === 0) {
      titleIntroError.value = 'AI 返回格式无法解析，请重试'
      return
    }
    titleIntroOptions.value = parsed
  } finally {
    titleIntroLoading.value = false
  }
}

async function applyTitleIntro(option: TitleIntroOption) {
  await window.anovel.invoke('work:update', props.workId, {
    title: option.title,
    description: option.description
  })
  await nav?.refreshWork?.()
  titleIntroOptions.value = []
  alert('已应用书名和简介')
}
</script>

<template>
  <div class="flex flex-wrap justify-end gap-2 mb-3">
    <button
      type="button"
      class="btn btn-outline btn-secondary btn-sm gap-1.5"
      :disabled="!hasPreviewContent || titleIntroLoading"
      @click="generateTitleIntro"
    >
      <font-awesome-icon
        :icon="titleIntroLoading ? 'spinner' : 'wand-magic-sparkles'"
        :spin="titleIntroLoading"
        class="w-3.5 h-3.5"
      />
      {{ titleIntroLoading ? '生成中...' : '生成书名简介' }}
    </button>
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
  <div v-if="titleIntroError" class="alert alert-error text-sm mb-3 py-2">
    {{ titleIntroError }}
  </div>
  <div v-if="titleIntroOptions.length" class="card bg-base-200 border border-primary/30 shadow-sm p-4 mb-4">
    <div class="flex items-start justify-between gap-3 mb-3">
      <div>
        <h4 class="font-semibold text-sm">AI 生成书名与简介</h4>
        <p class="text-xs text-base-content/50 mt-0.5">从不同点击欲角度生成，选择一组应用到当前作品</p>
      </div>
      <button type="button" class="btn btn-ghost btn-sm shrink-0" @click="titleIntroOptions = []">关闭</button>
    </div>
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <div
        v-for="(option, idx) in titleIntroOptions"
        :key="`${option.title}-${idx}`"
        class="rounded-xl border border-base-300 bg-base-100 p-3 space-y-2"
      >
        <div class="flex items-start justify-between gap-2">
          <div>
            <span class="text-[11px] text-base-content/40">方案 {{ idx + 1 }}</span>
            <div class="font-bold text-base leading-snug">{{ option.title }}</div>
          </div>
          <button type="button" class="btn btn-primary btn-xs shrink-0" @click="applyTitleIntro(option)">应用</button>
        </div>
        <p class="text-sm text-base-content/80 leading-relaxed whitespace-pre-wrap">{{ option.description }}</p>
        <div v-if="option.click_driver || option.reason" class="text-xs text-base-content/50 space-y-1 pt-2 border-t border-base-300/60">
          <div v-if="option.click_driver">点击驱动：{{ option.click_driver }}</div>
          <div v-if="option.reason">理由：{{ option.reason }}</div>
        </div>
      </div>
    </div>
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
