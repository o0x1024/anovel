<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, provide, watch } from 'vue'
import { useStyleChangeSync } from '../../composables/useStyleChangeSync'
import { useBodyGenerationModel } from '../../composables/useBodyGenerationModel'
import { useRoute, useRouter } from 'vue-router'
import IncubatorPanel from './IncubatorPanel.vue'
import SettingsPanel from './SettingsPanel.vue'
import VolumesPanel from './VolumesPanel.vue'
import ChaptersPanel from './ChaptersPanel.vue'
import GeneratePanel from './GeneratePanel.vue'
import AnchorsPanel from './AnchorsPanel.vue'
import IdeasPanel from './IdeasPanel.vue'
import FavoritesPanel from './FavoritesPanel.vue'
import GoalRoutinePanel from './GoalRoutinePanel.vue'
import WorkTemperaturePanel from './WorkTemperaturePanel.vue'
import NarrativeMemoryPanel from './NarrativeMemoryPanel.vue'
import TasteProfilePanel from './TasteProfilePanel.vue'
import ImageGeneratePanel from './ImageGeneratePanel.vue'
import WritingStatsPanel from './WritingStatsPanel.vue'
import WriterBlockPanel from './WriterBlockPanel.vue'
import MaterialsPanel from './MaterialsPanel.vue'
import StyleStabilityPanel from './StyleStabilityPanel.vue'
import ConditionRulesPanel from './ConditionRulesPanel.vue'
import NameRegistryPanel from './NameRegistryPanel.vue'
import BodyModelSelect from '../../components/BodyModelSelect.vue'
import {
  editorNavKey,
  type WorkflowStepKey,
  type WorkStepProgress
} from './editor-nav'
import {
  defaultStyleEvolutionCurve,
  parseStyleEvolutionCurve,
  type StyleEvolutionCurve
} from '../../../../shared/style-evolution'

const route = useRoute()
const router = useRouter()
const workId = computed(() => Number(route.params.id))

/** 由路由名区分小说 / 短故事，驱动步骤配置与返回路由 */
const isStory = computed(() => route.name === 'story-editor')
const backRoute = computed(() => (isStory.value ? '/stories' : '/'))

interface WorkInfo {
  id: number
  title: string
  description: string | null
}

interface StyleOption {
  id: number
  name: string
}

interface StepDef {
  key: StepKey
  label: string
  icon: string
}

type StepKey =
  | 'incubator' | 'settings' | 'volumes' | 'chapters' | 'generate' | 'anchors' | 'ideas'
  | 'names' | 'temperature' | 'memory' | 'stats' | 'block' | 'materials' | 'stability'
  | 'taste' | 'images' | 'favorites' | 'goal'

const work = ref<WorkInfo | null>(null)
const stepProgress = ref<WorkStepProgress | null>(null)
const allStyles = ref<StyleOption[]>([])
const boundStyleId = ref<number | null>(null)
const savingStyle = ref(false)
const showEvolutionModal = ref(false)
const evolutionForm = ref<StyleEvolutionCurve>(defaultStyleEvolutionCurve())
const evolutionSaving = ref(false)
const quickIdeaTrigger = ref(0)

const { bodyModelType, bodyModelName, bodyThinkingEnabled } = useBodyGenerationModel(() => workId.value)
const globalDefaultProvider = ref<string | null>(null)

const effectiveModelType = computed(() => bodyModelType.value || globalDefaultProvider.value)
const isDeepSeek = computed(() => effectiveModelType.value === 'deepseek')
const thinkingOn = computed({
  get: () => bodyThinkingEnabled.value !== false,
  set: (val: boolean) => { bodyThinkingEnabled.value = val }
})

const showExportModal = ref(false)
const exportFormat = ref<'markdown' | 'txt' | 'html'>('markdown')
const exportIncludeReport = ref(true)
const exportScope = ref<'work' | 'volume' | 'chapter'>('work')
const exportVolumeId = ref<number | null>(null)
const exportChapterId = ref<number | null>(null)
const exportVolumes = ref<{ id: number; name: string }[]>([])
const exportChapters = ref<{ id: number; title: string; volume_id: number }[]>([])
const exporting = ref(false)

// 创作步骤：小说含「分卷大纲」，短故事用扁平「节拍大纲」
const workflowSteps = computed<StepDef[]>(() => {
  if (isStory.value) {
    return [
      { key: 'incubator', label: '大岗孵化', icon: 'lightbulb' },
      { key: 'settings', label: '核心设定', icon: 'sliders' },
      { key: 'chapters', label: '节拍大纲', icon: 'list-ol' },
      { key: 'generate', label: '正文生成', icon: 'pen-nib' },
      { key: 'anchors', label: '锚点管理', icon: 'anchor' },
      { key: 'ideas', label: '灵感收集', icon: 'brain' }
    ]
  }
  return [
    { key: 'incubator', label: '大岗孵化', icon: 'lightbulb' },
    { key: 'settings', label: '核心设定', icon: 'sliders' },
    { key: 'volumes', label: '分卷大纲', icon: 'book' },
    { key: 'chapters', label: '章节情节', icon: 'list-ol' },
    { key: 'generate', label: '正文生成', icon: 'pen-nib' },
    { key: 'anchors', label: '锚点管理', icon: 'anchor' },
    { key: 'ideas', label: '灵感收集', icon: 'brain' }
  ]
})

const utilitySteps = computed<StepDef[]>(() => {
  const base: StepDef[] = [
    { key: 'names', label: '名称库', icon: 'tag' },
    { key: 'temperature', label: '创作温度', icon: 'thermometer-half' },
    { key: 'memory', label: '叙事记忆体', icon: 'project-diagram' },
    { key: 'stats', label: '写作统计', icon: 'chart-bar' },
    { key: 'block', label: '写作障碍', icon: 'bolt' },
    { key: 'materials', label: '素材库', icon: 'box' },
    { key: 'stability', label: '文风稳定性', icon: 'fire' },
    { key: 'taste', label: '品味档案', icon: 'gem' },
    { key: 'images', label: 'AI 配图', icon: 'palette' },
    { key: 'favorites', label: '收藏夹', icon: 'bookmark' }
  ]
  // 目标循环仅短故事暴露
  if (isStory.value) {
    base.push({ key: 'goal', label: '目标循环', icon: 'rotate' })
  }
  return base
})

const steps = computed<StepDef[]>(() => [...workflowSteps.value, ...utilitySteps.value])

const currentStep = ref<StepKey>('incubator')

// 短故事不暴露分卷面板，但映射保留无害（短故事永远不会导航到 volumes）
const panelComponents = {
  incubator: IncubatorPanel,
  settings: SettingsPanel,
  volumes: VolumesPanel,
  chapters: ChaptersPanel,
  generate: GeneratePanel,
  anchors: AnchorsPanel,
  ideas: IdeasPanel,
  names: NameRegistryPanel,
  temperature: WorkTemperaturePanel,
  memory: NarrativeMemoryPanel,
  stats: WritingStatsPanel,
  block: WriterBlockPanel,
  materials: MaterialsPanel,
  stability: StyleStabilityPanel,
  taste: TasteProfilePanel,
  images: ImageGeneratePanel,
  favorites: FavoritesPanel,
  goal: GoalRoutinePanel
} as const

const activePanel = computed(() => panelComponents[currentStep.value as keyof typeof panelComponents])

const boundStyleName = computed(() =>
  allStyles.value.find(s => s.id === boundStyleId.value)?.name ?? '未绑定文风'
)

async function refreshProgress() {
  stepProgress.value = await window.anovel.invoke('work:getStepProgress', workId.value) as WorkStepProgress
}

async function refreshWork() {
  work.value = await window.anovel.invoke('work:get', workId.value) as WorkInfo
}

function goToStep(key: WorkflowStepKey) {
  currentStep.value = key
}

function goToPanel(key: StepKey) {
  currentStep.value = key
}

provide(editorNavKey, {
  goToStep,
  goToPanel,
  refreshProgress,
  refreshWork,
  stepProgress,
  quickIdeaTrigger
})

function triggerQuickIdea() {
  currentStep.value = 'ideas'
  quickIdeaTrigger.value += 1
}

function triggerWriterBlock() {
  currentStep.value = 'block'
}

async function reloadStyleOptions() {
  allStyles.value = await window.anovel.invoke('style:list') as StyleOption[]
  const currentId = await window.anovel.invoke('style:getWorkStyleId', workId.value) as number | null
  if (currentId && !allStyles.value.some(s => s.id === currentId)) {
    boundStyleId.value = null
    await window.anovel.invoke('style:setWorkStyle', workId.value, null)
  } else {
    boundStyleId.value = currentId
  }
}

useStyleChangeSync(reloadStyleOptions)

function onOpenExport() {
  void openExportModal()
}

onMounted(async () => {
  window.anovel.on('app:quickIdea', triggerQuickIdea)
  window.anovel.on('app:openExport', onOpenExport)
  window.anovel.on('app:writerBlock', triggerWriterBlock)
  try {
    await refreshWork()
    await reloadStyleOptions()
    await refreshProgress()
    const globalDefault = await window.anovel.invoke('model:getGlobalDefault') as { provider: string | null }
    globalDefaultProvider.value = globalDefault.provider
  } catch (e) {
    console.error('加载失败:', e)
    router.push(backRoute.value)
  }
})

onUnmounted(() => {
  window.anovel.off('app:quickIdea', triggerQuickIdea)
  window.anovel.off('app:openExport', onOpenExport)
  window.anovel.off('app:writerBlock', triggerWriterBlock)
})

watch(currentStep, () => {
  void refreshProgress()
})

async function onStyleChange() {
  savingStyle.value = true
  try {
    await window.anovel.invoke('style:setWorkStyle', workId.value, boundStyleId.value)
    if (boundStyleId.value) {
      const binding = await window.anovel.invoke('style:getWorkStyleBinding', workId.value) as {
        evolution_curve_json: string | null
      } | null
      if (binding && !binding.evolution_curve_json) {
        await window.anovel.invoke(
          'style:setWorkEvolutionCurve',
          workId.value,
          JSON.stringify(defaultStyleEvolutionCurve())
        )
      }
    }
  } finally {
    savingStyle.value = false
  }
}

async function openEvolutionModal() {
  if (!boundStyleId.value) return
  const binding = await window.anovel.invoke('style:getWorkStyleBinding', workId.value) as {
    evolution_curve_json: string | null
  } | null
  evolutionForm.value =
    parseStyleEvolutionCurve(binding?.evolution_curve_json) ?? defaultStyleEvolutionCurve()
  showEvolutionModal.value = true
}

async function saveEvolutionCurve() {
  if (!boundStyleId.value || evolutionSaving.value) return
  evolutionSaving.value = true
  try {
    await window.anovel.invoke(
      'style:setWorkEvolutionCurve',
      workId.value,
      JSON.stringify(evolutionForm.value)
    )
    showEvolutionModal.value = false
  } finally {
    evolutionSaving.value = false
  }
}

function stepStatusBadge(key: string) {
  if (!workflowSteps.value.some(s => s.key === key)) return null
  return stepProgress.value?.steps[key as WorkflowStepKey] ?? null
}

async function openExportModal() {
  exportVolumes.value = await window.anovel.invoke('volume:list', workId.value) as { id: number; name: string }[]
  exportChapters.value = await window.anovel.invoke('chapter:listByWork', workId.value) as { id: number; title: string; volume_id: number }[]
  if (exportVolumes.value.length && !exportVolumeId.value) {
    exportVolumeId.value = exportVolumes.value[0].id
  }
  if (exportChapters.value.length && !exportChapterId.value) {
    exportChapterId.value = exportChapters.value[0].id
  }
  showExportModal.value = true
}

async function doExport() {
  if (!work.value || exporting.value) return
  exporting.value = true
  try {
    const scope = exportScope.value === 'volume' && exportVolumeId.value
      ? { volumeId: exportVolumeId.value }
      : exportScope.value === 'chapter' && exportChapterId.value
        ? { chapterId: exportChapterId.value }
        : undefined
    const title = exportScope.value === 'chapter'
      ? exportChapters.value.find(c => c.id === exportChapterId.value)?.title || work.value.title
      : exportScope.value === 'volume'
        ? exportVolumes.value.find(v => v.id === exportVolumeId.value)?.name || work.value.title
        : work.value.title

    const result = await window.anovel.invoke(
      'export:contentWithReport',
      workId.value,
      title,
      exportFormat.value,
      scope,
      exportScope.value === 'work' && exportIncludeReport.value
    ) as {
      content: string
      filename: string
      mime: string
    }
    const blob = new Blob([result.content], { type: result.mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = result.filename
    a.click()
    URL.revokeObjectURL(url)
    showExportModal.value = false
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="h-full min-h-0">
    <div class="flex h-full bg-base-100 font-sans animate-fade-in">
    <aside class="w-60 bg-base-200/60 border-r border-base-300 shrink-0 py-5 flex flex-col overflow-hidden select-none">
      <div class="px-5 mb-4">
        <button
          type="button"
          class="btn btn-ghost btn-xs gap-1 -ml-1 mb-3"
          @click="router.push(backRoute)"
        >
          <font-awesome-icon icon="arrow-left" class="w-3 h-3" />
          <span>返回列表</span>
        </button>
        <h3 class="text-base font-extrabold text-base-content truncate tracking-tight" :title="work?.title">
          {{ work?.title || '加载中...' }}
        </h3>
        <p class="text-xs font-bold text-base-content/30 uppercase tracking-wider mt-0.5">创作工作台</p>
        <div v-if="stepProgress" class="mt-3">
          <div class="flex items-center justify-between text-xs text-base-content/50 mb-1">
            <span>创作进度</span>
            <span>{{ stepProgress.completionPercent }}%</span>
          </div>
          <progress
            class="progress progress-primary progress-xs w-full"
            :value="stepProgress.completionPercent"
            max="100"
          />
        </div>
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto scrollbar-thin pb-3">
        <div class="px-3 mb-3 text-xs font-bold text-base-content/40 uppercase tracking-wider">
          创作步骤
        </div>
        <ul class="menu menu-sm rounded-box w-full px-1">
          <li v-for="step in workflowSteps" :key="step.key">
            <button
              type="button"
              :class="{ 'menu-active': currentStep === step.key }"
              @click="currentStep = step.key"
            >
              <font-awesome-icon :icon="step.icon" class="w-4 h-4 opacity-80" />
              <span class="flex-1 text-left">{{ step.label }}</span>
              <span
                v-if="stepStatusBadge(step.key) === 'done'"
                class="badge badge-success badge-xs"
                title="已完成"
              >✓</span>
              <span
                v-else-if="stepStatusBadge(step.key) === 'review'"
                class="badge badge-info badge-xs"
                title="待自检"
              >!</span>
              <span
                v-else-if="stepStatusBadge(step.key) === 'ready'"
                class="badge badge-warning badge-xs"
                title="可进行"
              >·</span>
            </button>
          </li>
        </ul>

        <div class="mt-4 pt-4 border-t border-base-300/70">
          <div class="px-3 mb-3 text-xs font-bold text-base-content/40 uppercase tracking-wider shrink-0">
            工具
          </div>
          <ul class="menu menu-sm rounded-box w-full px-1">
            <li v-for="step in utilitySteps" :key="step.key">
              <button
                type="button"
                :class="{ 'menu-active': currentStep === step.key }"
                @click="currentStep = step.key"
              >
                <font-awesome-icon :icon="step.icon" class="w-4 h-4 opacity-80" />
                {{ step.label }}
              </button>
            </li>
          </ul>
        </div>

        <ConditionRulesPanel :work-id="workId" class="mt-3" />
      </div>

      <div class="mt-auto px-4 pt-4 border-t border-base-300/60 space-y-2 shrink-0">
        <button
          type="button"
          class="btn btn-outline btn-primary btn-sm btn-block gap-2"
          @click="openExportModal"
        >
          <font-awesome-icon icon="download" class="w-3.5 h-3.5" />
          导出作品
        </button>
        <p class="text-xs text-base-content/30 text-center leading-relaxed">
          ⌘⇧I 灵感 · ⌘⇧E 导出 · ⌘⇧B 写作障碍
        </p>
      </div>
    </aside>

    <div class="flex-1 flex flex-col min-w-0">
      <header class="h-14 border-b border-base-300 flex items-center px-4 sm:px-5 gap-3 shrink-0 bg-base-100/50 backdrop-blur-md z-10 flex-wrap">
        <span class="text-sm font-semibold text-base-content/50">我的作品</span>
        <span class="text-xs text-base-content/30">/</span>
        <span class="text-sm font-semibold text-base-content/80 truncate max-w-[160px]">{{ work?.title }}</span>
        <span class="text-xs text-base-content/30">/</span>
        <span class="text-sm font-bold text-primary flex items-center gap-1.5">
          <font-awesome-icon :icon="steps.find(s => s.key === currentStep)?.icon || 'circle'" class="w-3.5 h-3.5 opacity-80" />
          {{ steps.find(s => s.key === currentStep)?.label }}
        </span>

        <div class="ml-auto flex items-center gap-2">
          <select
            v-model="boundStyleId"
            class="select select-bordered select-xs max-w-[140px]"
            :disabled="savingStyle"
            @change="onStyleChange"
          >
            <option :value="null">未绑定</option>
            <option v-for="s in allStyles" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
          <button
            v-if="boundStyleId"
            type="button"
            class="btn btn-ghost btn-xs"
            title="配置全书进度下的文风渐变"
            @click="openEvolutionModal"
          >
            进化
          </button>
          <BodyModelSelect
            v-model:model-type="bodyModelType"
            v-model:model-name="bodyModelName"
          />
          <button
            v-if="isDeepSeek"
            type="button"
            class="btn btn-xs"
            :class="thinkingOn ? 'btn-primary' : 'btn-ghost'"
            :title="thinkingOn ? '深度思考已开启' : '深度思考已关闭'"
            @click="thinkingOn = !thinkingOn"
          >
            <font-awesome-icon icon="brain" class="w-3 h-3" />
            <span class="ml-1">深度思考</span>
          </button>
        </div>
      </header>

      <div class="flex-1 overflow-auto px-3 py-3 sm:px-4 sm:py-4 scrollbar-thin">
        <div class="w-full min-w-0 animate-fade-in">
          <KeepAlive :key="workId" :max="Object.keys(panelComponents).length">
            <component :is="activePanel" :work-id="workId" />
          </KeepAlive>
        </div>
      </div>
    </div>
  </div>

  <dialog :class="['modal', { 'modal-open': showEvolutionModal }]">
    <div class="modal-box max-w-lg">
      <h3 class="font-bold text-lg mb-1">文风进化曲线</h3>
      <p class="text-xs text-base-content/50 mb-4">
        按全书进度（章节序号/总章数）自动调整节奏与情绪约束，作用于所有 AI 生成步骤。
      </p>
      <label class="flex items-center gap-2 cursor-pointer mb-4">
        <input v-model="evolutionForm.enabled" type="checkbox" class="checkbox checkbox-sm checkbox-primary" />
        <span class="text-sm">启用文风进化</span>
      </label>
      <div class="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
        <div
          v-for="(phase, idx) in evolutionForm.phases"
          :key="idx"
          class="border border-base-300 rounded-lg p-3 space-y-2"
        >
          <div class="flex items-center gap-2">
            <span class="badge badge-sm badge-outline">{{ phase.label || `阶段${idx + 1}` }}</span>
            <span class="text-xs text-base-content/40">进度 ≤ {{ phase.until_progress }}%</span>
          </div>
          <div>
            <label class="text-xs text-base-content/50">阶段名称</label>
            <input v-model="phase.label" class="input input-bordered input-xs w-full mt-0.5" />
          </div>
          <div>
            <label class="text-xs text-base-content/50">进度上限 (%)</label>
            <input
              v-model.number="phase.until_progress"
              type="number"
              min="1"
              max="100"
              class="input input-bordered input-xs w-full mt-0.5"
            />
          </div>
          <div>
            <label class="text-xs text-base-content/50">情绪/叙事说明</label>
            <textarea v-model="phase.tone_note" rows="2" class="textarea textarea-bordered textarea-xs w-full mt-0.5" />
          </div>
          <div>
            <label class="text-xs text-base-content/50">节奏说明（可选）</label>
            <input v-model="phase.pacing_note" class="input input-bordered input-xs w-full mt-0.5" />
          </div>
        </div>
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" @click="showEvolutionModal = false">取消</button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="evolutionSaving"
          @click="saveEvolutionCurve"
        >
          {{ evolutionSaving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop">
      <button type="button" @click="showEvolutionModal = false">close</button>
    </form>
  </dialog>

  <dialog :class="['modal', { 'modal-open': showExportModal }]">
    <div class="modal-box max-w-md">
      <h3 class="font-bold text-lg mb-4">导出作品</h3>
      <div class="space-y-3">
        <div>
          <label class="text-xs text-base-content/50">导出范围</label>
          <select v-model="exportScope" class="select select-bordered select-sm w-full mt-1">
            <option value="work">全书</option>
            <option value="volume">单卷</option>
            <option value="chapter">单章</option>
          </select>
        </div>
        <div v-if="exportScope === 'volume'">
          <label class="text-xs text-base-content/50">选择分卷</label>
          <select v-model="exportVolumeId" class="select select-bordered select-sm w-full mt-1">
            <option v-for="v in exportVolumes" :key="v.id" :value="v.id">{{ v.name }}</option>
          </select>
        </div>
        <div v-if="exportScope === 'chapter'">
          <label class="text-xs text-base-content/50">选择章节</label>
          <select v-model="exportChapterId" class="select select-bordered select-sm w-full mt-1">
            <option v-for="c in exportChapters" :key="c.id" :value="c.id">{{ c.title }}</option>
          </select>
        </div>
        <div>
          <label class="text-xs text-base-content/50">格式</label>
          <select v-model="exportFormat" class="select select-bordered select-sm w-full mt-1">
            <option value="markdown">Markdown (.md)</option>
            <option value="txt">纯文本 (.txt)</option>
            <option value="html">HTML (.html)</option>
          </select>
        </div>
        <label v-if="exportScope === 'work'" class="flex items-center gap-2 cursor-pointer">
          <input v-model="exportIncludeReport" type="checkbox" class="checkbox checkbox-sm checkbox-primary" />
          <span class="text-sm">附带整体质量报告</span>
        </label>
      </div>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" @click="showExportModal = false">取消</button>
        <button type="button" class="btn btn-primary btn-sm" :disabled="exporting" @click="doExport">
          {{ exporting ? '导出中...' : '确认导出' }}
        </button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop" @click="showExportModal = false">
      <button type="button">close</button>
    </form>
  </dialog>
  </div>
</template>
