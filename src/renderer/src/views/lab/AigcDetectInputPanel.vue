<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AigcSeedOpts } from '../../composables/useAigcDetect'
import { usePerplexityModels, type PplModelInfo } from '../../composables/usePerplexityModels'
import { useSupervisedAigcModel } from '../../composables/useSupervisedAigcModel'
import type {
  PerplexityEngineMode,
  PerplexityApiConfig,
  AigcDetectResult,
  AigcCategory
} from '../../../../shared/aigc-detect-types'
import { AIGC_CATEGORY_LABELS } from '../../../../shared/aigc-detect-types'
import type {
  AigcSentencePatch,
  AigcSentencePatchDecision,
  AigcRewriteGoalResult
} from '../../../../shared/aigc-sentence-rewrite-types'
import AigcSentenceRewritePanel from './AigcSentenceRewritePanel.vue'
import AigcHighlightedText from './AigcHighlightedText.vue'
import AigcDetectDetailDrawer from './AigcDetectDetailDrawer.vue'
import { summarizeAigcDisplayDistribution } from '../../../../shared/aigc-display-allocation'

const LAB_TEXT_MAX = 50_000
const ZHUQUE_MIN_TEXT_LENGTH = 350

const props = defineProps<{
  inputText: string
  seedOpts: AigcSeedOpts
  status: 'idle' | 'running' | 'done' | 'error'
  rewriting?: boolean
  applyingWordTable?: boolean
  rewriteProgress?: { message: string; level?: 'info' | 'warn' } | null
  rewritePatches?: AigcSentencePatch[]
  rewriteGoal?: AigcRewriteGoalResult | null
  needsManualRecheck?: boolean
  rewriteDecisions?: Record<string, AigcSentencePatchDecision>
  rewritePreviewText?: string
  result?: AigcDetectResult | null
  errorMessage?: string
  downloadProgress?: { phase: string; percent: number; message: string } | null
}>()

const emit = defineEmits<{
  'update:inputText': [value: string]
  'update:seedOpts': [value: AigcSeedOpts]
  run: []
  rewrite: []
  wordtableApply: []
  cancel: []
  clearResult: []
  acceptPatch: [id: string]
  rejectPatch: [id: string]
  acceptAllPatches: []
  applyAcceptedPatches: []
}>()

const {
  models, switchModel, deleteModel, downloadModel,
  loading: modelSwitching,
  downloading, downloadProgress: modelDownloadProgress,
  refresh: refreshModels
} = usePerplexityModels()
const {
  model: supervisedModel,
  downloading: supervisedDownloading,
  downloadProgress: supervisedDownloadProgress,
  download: downloadSupervisedModel,
  remove: removeSupervisedModel
} = useSupervisedAigcModel()
const showModelPanel = ref(false)
const engineExpanded = ref(false)
const showDetectDetails = ref(false)

// API 配置
const engineMode = ref<PerplexityEngineMode>('builtin')
const apiBase = ref('http://localhost:1234/v1')
const apiModelName = ref('')
const apiTesting = ref(false)
const apiTestResult = ref<{ success: boolean; message: string } | null>(null)

const apiPresets = [
  { name: 'LM Studio', base: 'http://localhost:1234/v1', needsKey: false },
  { name: 'Ollama', base: 'http://localhost:11434/v1', needsKey: false },
]

const displayApiModel = computed(() => apiModelName.value)

function applyPreset(preset: { name: string; base: string; needsKey: boolean; model?: string }) {
  apiBase.value = preset.base
  if (preset.model) apiModelName.value = preset.model
  apiTestResult.value = null
  saveApiConfig()
}

async function loadApiConfig() {
  try {
    const config = await window.anovel.invoke('perplexity:get-api-config') as PerplexityApiConfig
    engineMode.value = config.mode
    apiBase.value = config.apiBase
    apiModelName.value = config.modelName
  } catch { /* ignore */ }
}

async function saveApiConfig() {
  await window.anovel.invoke('perplexity:set-api-config', {
    mode: engineMode.value,
    apiBase: apiBase.value,
    modelName: apiModelName.value
  })
}

async function switchEngineMode(mode: PerplexityEngineMode) {
  engineMode.value = mode
  await saveApiConfig()
}

async function onApiBaseBlur() { await saveApiConfig() }
async function onModelNameBlur() { await saveApiConfig() }
async function testConnection() {
  apiTesting.value = true
  apiTestResult.value = null
  try {
    const result = await window.anovel.invoke(
      'perplexity:test-api',
      apiBase.value,
      apiModelName.value
    ) as { success: boolean; message: string }
    apiTestResult.value = result
  } catch (err) {
    apiTestResult.value = { success: false, message: String(err) }
  } finally {
    apiTesting.value = false
  }
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)}GB`
  return `${Math.round(bytes / 1e6)}MB`
}

async function onSwitchModel(m: PplModelInfo) {
  if (m.active || modelSwitching.value) return
  await switchModel(m.id)
}

async function onDeleteModel(m: PplModelInfo) {
  if (!m.ready || m.active) return
  await deleteModel(m.id)
}

async function onDownloadModel(m: PplModelInfo) {
  if (m.ready || downloading.value) return
  await downloadModel(m.id)
}

onMounted(() => {
  refreshModels()
  loadApiConfig()
})
const isStrongMode = computed(() => props.seedOpts.mode === 'strong')

const displayContent = computed(() =>
  props.rewritePreviewText || (props.result?.segments ?? []).map(seg => seg.text).join('') || props.inputText
)
const effectiveInputLength = computed(() => props.inputText.replace(/\s/g, '').length)
const meetsZhuqueMinimum = computed(() => effectiveInputLength.value >= ZHUQUE_MIN_TEXT_LENGTH)

const CATEGORY_COLORS: Record<AigcCategory, string> = {
  human: '#a3d977',
  suspected_ai: '#f5deb3',
  ai: '#f5a0a0'
}

const displayDistribution = computed(() => props.result
  ? summarizeAigcDisplayDistribution(props.result.segments, props.rewritePatches)
  : { human: 0, suspected_ai: 0, ai: 0 }
)

const displaySummary = computed(() => {
  if (!props.result) return ''
  if (!props.rewritePatches?.length) return props.result.summary
  const value = displayDistribution.value
  return `逐句证据复核覆盖率：人工 ${value.human}%，疑似AI ${value.suspected_ai}%，AI特征 ${value.ai}%`
})

function toggleMode() {
  const newMode = isStrongMode.value ? 'fast' : 'strong'
  emit('update:seedOpts', { ...props.seedOpts, mode: newMode })
}

const copyHint = ref('')
let copyHintTimer: ReturnType<typeof setTimeout> | null = null

function setCopyHint(text: string) {
  copyHint.value = text
  if (copyHintTimer) clearTimeout(copyHintTimer)
  copyHintTimer = setTimeout(() => {
    copyHint.value = ''
    copyHintTimer = null
  }, 1800)
}

async function copyText(text: string) {
  if (!text.trim()) return
  try {
    await navigator.clipboard.writeText(text)
    setCopyHint('已复制')
  } catch {
    setCopyHint('复制失败')
  }
}

function onInput(e: Event) {
  emit('update:inputText', (e.target as HTMLTextAreaElement).value)
}

const canRewrite = computed(() => {
  if (!props.inputText.trim() || props.rewriting || props.applyingWordTable || !props.result) return false
  return true
})

const canApplyWordTable = computed(() => {
  if (!props.inputText.trim() || props.rewriting || props.applyingWordTable) return false
  return true
})

onUnmounted(() => {
  if (copyHintTimer) clearTimeout(copyHintTimer)
})
</script>

<template>
  <div class="flex flex-col gap-2 flex-1 min-h-0">
    <!-- Controls bar -->
    <div class="flex items-center gap-2 flex-wrap shrink-0">
      <template v-if="status !== 'running' && !rewriting">
        <button
          v-if="result && status === 'done'"
          type="button"
          class="btn btn-ghost btn-sm"
          @click="emit('clearResult')"
        >
          <font-awesome-icon icon="pen-to-square" class="w-3.5 h-3.5" />
          编辑
        </button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="!meetsZhuqueMinimum || rewriting || applyingWordTable"
          @click="emit('run')"
        >
          <font-awesome-icon icon="magnifying-glass" class="w-3.5 h-3.5" />
          {{ result || needsManualRecheck ? '重新检测' : '开始检测' }}
        </button>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="!canRewrite"
          @click="emit('rewrite')"
        >
          <span v-if="rewriting" class="loading loading-spinner loading-xs" />
          <font-awesome-icon v-else icon="wand-magic-sparkles" class="w-3.5 h-3.5" />
          一键改写
        </button>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="!canApplyWordTable"
          @click="emit('wordtableApply')"
        >
          <span v-if="applyingWordTable" class="loading loading-spinner loading-xs" />
          <font-awesome-icon v-else icon="tag" class="w-3.5 h-3.5" />
          词表替换
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-sm"
          :class="{ 'text-success': copyHint === '已复制', 'text-error': copyHint === '复制失败' }"
          :disabled="!displayContent.trim()"
          @click="copyText(displayContent)"
        >
          <font-awesome-icon icon="copy" class="w-3.5 h-3.5" />
          {{ copyHint || '复制' }}
        </button>

        <div class="divider divider-horizontal mx-0" />

        <label class="flex items-center gap-1.5 cursor-pointer select-none">
          <span class="text-xs" :class="isStrongMode ? 'text-base-content/50' : 'font-medium'">快速</span>
          <input
            type="checkbox"
            class="toggle toggle-xs toggle-primary"
            :checked="isStrongMode"
            @change="toggleMode"
          />
          <span class="text-xs" :class="isStrongMode ? 'font-medium' : 'text-base-content/50'">案例增强</span>
        </label>
      </template>

      <button
        v-else
        type="button"
        class="btn btn-warning btn-sm"
        @click="emit('cancel')"
      >
        <font-awesome-icon icon="stop" class="w-3.5 h-3.5" />
        取消
      </button>
      <span v-if="needsManualRecheck && status !== 'running' && !rewriting" class="text-xs text-info">
        改写已应用，当前文本尚未检测，请点击“重新检测”
      </span>
      <span v-if="rewriting && rewriteProgress" class="text-xs" :class="rewriteProgress.level === 'warn' ? 'text-warning' : 'text-info'">
        <span v-if="rewriteProgress.level !== 'warn'" class="loading loading-spinner loading-xs mr-1" />
        <font-awesome-icon v-else icon="exclamation-circle" class="w-3 h-3 mr-1" />
        {{ rewriteProgress.message }}
      </span>
    </div>

    <!-- 检测引擎选择（默认折叠） -->
    <div class="shrink-0">
      <button
        type="button"
        class="flex items-center gap-2 w-full text-left py-1 group"
        @click="engineExpanded = !engineExpanded"
      >
        <font-awesome-icon
          icon="chevron-right"
          class="w-2.5 h-2.5 text-base-content/40 transition-transform"
          :class="{ 'rotate-90': engineExpanded }"
        />
        <span class="text-xs text-base-content/50">检测引擎:</span>
        <template v-if="engineMode === 'builtin'">
          <span class="text-xs font-medium">{{ models.find(m => m.active)?.name || '内置模型' }}</span>
          <span
            v-if="models.find(m => m.active)?.ready"
            class="badge badge-success badge-xs"
          >就绪</span>
          <span
            v-else-if="models.find(m => m.active)"
            class="badge badge-warning badge-xs"
          >未下载</span>
        </template>
        <template v-else>
          <span class="text-xs font-medium">本地部署</span>
          <span v-if="displayApiModel" class="text-xs text-base-content/60">· {{ displayApiModel }}</span>
          <span
            v-if="apiTestResult?.success"
            class="badge badge-success badge-xs"
          >已连接</span>
        </template>
        <span
          class="badge badge-xs"
          :class="supervisedModel?.ready ? 'badge-success' : 'badge-warning'"
        >{{ supervisedModel?.ready ? '中文监督已就绪' : '中文监督未下载' }}</span>
      </button>

      <div v-if="engineExpanded" class="pl-4 mt-1 space-y-2">
        <div class="flex items-center gap-2">
          <div class="join">
            <button
              type="button"
              class="btn btn-xs join-item"
              :class="engineMode === 'builtin' ? 'btn-primary' : 'btn-ghost'"
              @click="switchEngineMode('builtin')"
            >内置模型</button>
            <button
              type="button"
              class="btn btn-xs join-item"
              :class="engineMode === 'api' ? 'btn-primary' : 'btn-ghost'"
              @click="switchEngineMode('api')"
            >本地部署</button>
          </div>
          <button
            v-if="engineMode === 'builtin'"
            type="button"
            class="btn btn-ghost btn-xs gap-1"
            @click="showModelPanel = !showModelPanel"
          >
            <span class="text-xs font-medium">{{ models.find(m => m.active)?.name || '未选择' }}</span>
            <font-awesome-icon
              icon="chevron-down"
              class="w-2.5 h-2.5 transition-transform"
              :class="{ 'rotate-180': showModelPanel }"
            />
          </button>
          <span
            v-if="engineMode === 'builtin' && models.find(m => m.active)?.ready"
            class="badge badge-success badge-xs"
          >已下载</span>
          <span
            v-else-if="engineMode === 'builtin' && models.find(m => m.active)"
            class="badge badge-warning badge-xs"
          >未下载</span>
        </div>

        <div class="rounded-box border border-primary/25 bg-primary/5 p-2">
          <div class="flex items-center gap-2">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-xs font-medium">{{ supervisedModel?.name || '中文监督检测模型' }}</span>
                <span class="badge badge-primary badge-xs">融合必需</span>
              </div>
              <p class="text-[10px] text-base-content/50">
                {{ supervisedModel?.description || '中文人工/AI监督分类证据' }}
                <template v-if="supervisedModel"> · {{ formatSize(supervisedModel.sizeBytes) }}</template>
              </p>
            </div>
            <span v-if="supervisedModel?.ready" class="badge badge-success badge-xs">已下载</span>
            <button
              v-if="supervisedModel?.ready"
              type="button"
              class="btn btn-ghost btn-xs btn-circle text-error/60"
              title="删除中文监督模型"
              @click="removeSupervisedModel"
            >
              <font-awesome-icon icon="trash" class="w-2.5 h-2.5" />
            </button>
            <button
              v-else
              type="button"
              class="btn btn-outline btn-xs gap-1"
              :disabled="supervisedDownloading"
              @click="downloadSupervisedModel"
            >
              <span v-if="supervisedDownloading" class="loading loading-spinner loading-xs" />
              <font-awesome-icon v-else icon="download" class="w-2.5 h-2.5" />
              {{ supervisedDownloading ? '下载中' : '下载' }}
            </button>
          </div>
          <div v-if="supervisedDownloadProgress?.phase === 'downloading'" class="mt-2">
            <progress
              class="progress progress-primary w-full"
              :value="supervisedDownloadProgress.percent"
              max="100"
            />
            <p class="text-[10px] text-base-content/50 mt-0.5">{{ supervisedDownloadProgress.message }}</p>
          </div>
        </div>

        <!-- 内置模型列表面板 -->
        <div v-if="engineMode === 'builtin' && showModelPanel" class="rounded-box border border-base-300 p-2 bg-base-200/50">
          <div
            v-for="m in models"
            :key="m.id"
            class="flex items-center gap-2 py-1.5 px-2 rounded-lg cursor-pointer hover:bg-base-300/50 transition-colors"
            :class="{
              'bg-primary/10 border border-primary/30': m.active,
              'pointer-events-none opacity-60': modelSwitching
            }"
            @click="onSwitchModel(m)"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-xs font-medium truncate">{{ m.name }}</span>
                <span v-if="m.active" class="badge badge-primary badge-xs">当前</span>
                <span v-else-if="modelSwitching" class="loading loading-spinner loading-xs" />
              </div>
              <p class="text-[10px] text-base-content/50 truncate">{{ m.description }} · {{ formatSize(m.sizeBytes) }}</p>
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <template v-if="m.ready">
                <span class="badge badge-success badge-xs gap-0.5">
                  <font-awesome-icon icon="check" class="w-2 h-2" />
                  已下载
                </span>
                <button
                  v-if="!m.active"
                  type="button"
                  class="btn btn-ghost btn-xs btn-circle text-error/60 hover:text-error"
                  title="删除此模型"
                  @click.stop="onDeleteModel(m)"
                >
                  <font-awesome-icon icon="trash" class="w-2.5 h-2.5" />
                </button>
              </template>
              <template v-else>
                <button
                  type="button"
                  class="btn btn-outline btn-xs gap-1"
                  :disabled="!!downloading"
                  :class="{ 'loading': downloading === m.id }"
                  @click.stop="onDownloadModel(m)"
                >
                  <span v-if="downloading === m.id" class="loading loading-spinner loading-xs" />
                  <font-awesome-icon v-else icon="download" class="w-2.5 h-2.5" />
                  {{ downloading === m.id ? '下载中' : '下载' }}
                </button>
              </template>
            </div>
          </div>

          <!-- 模型下载进度（手动触发） -->
          <div v-if="modelDownloadProgress && modelDownloadProgress.phase === 'downloading'" class="mt-2 px-2">
            <div class="flex items-center gap-2 text-xs text-base-content/60">
              <span class="loading loading-spinner loading-xs" />
              <span>{{ modelDownloadProgress.message }}</span>
            </div>
            <progress
              class="progress progress-primary w-full mt-1"
              :value="modelDownloadProgress.percent"
              max="100"
            />
          </div>

          <p class="text-[10px] text-base-content/40 mt-2 px-2">
            点击"下载"按钮预先下载模型，或选择模型后首次检测时自动下载。
          </p>
        </div>

        <!-- 本地部署 API 配置面板 -->
        <div v-if="engineMode === 'api'" class="rounded-box border border-base-300 p-3 bg-base-200/50 space-y-2">
          <p class="text-[10px] text-base-content/50">
            连接本机 LM Studio、Ollama 或 llama.cpp server（需支持 logprobs / echo 模式）。
          </p>

          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-[10px] text-base-content/50">快捷预设:</span>
            <button
              v-for="preset in apiPresets"
              :key="preset.name"
              type="button"
              class="btn btn-ghost btn-xs"
              @click="applyPreset(preset)"
            >{{ preset.name }}</button>
          </div>

          <div class="form-control">
            <label class="label py-0.5">
              <span class="label-text text-xs">API 地址</span>
              <span class="label-text-alt text-[10px] text-base-content/40">自动补全 /v1 路径</span>
            </label>
            <input
              v-model="apiBase"
              type="text"
              class="input input-bordered input-sm text-xs font-mono"
              placeholder="http://localhost:1234/v1"
              @blur="onApiBaseBlur"
            />
          </div>

          <div class="form-control">
            <label class="label py-0.5">
              <span class="label-text text-xs">模型名称</span>
              <span class="label-text-alt text-[10px] text-base-content/40">留空使用服务当前加载的模型</span>
            </label>
            <input
              v-model="apiModelName"
              type="text"
              class="input input-bordered input-sm text-xs font-mono"
              placeholder="留空自动使用当前加载的模型"
              @blur="onModelNameBlur"
            />
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              class="btn btn-outline btn-xs"
              :disabled="apiTesting"
              @click="testConnection"
            >
              <span v-if="apiTesting" class="loading loading-spinner loading-xs" />
              <font-awesome-icon v-else icon="plug" class="w-2.5 h-2.5" />
              测试连接
            </button>
            <span
              v-if="apiTestResult"
              class="text-[11px]"
              :class="apiTestResult.success ? 'text-success' : 'text-error'"
            >
              {{ apiTestResult.message }}
            </span>
          </div>
          <p class="text-[10px] text-base-content/40">
            仅支持本机部署、且提供 logprobs（echo 模式）的 OpenAI 兼容服务，如 LM Studio、Ollama、llama.cpp server。
          </p>
        </div>
      </div>
    </div>

    <!-- Main content: original on the left, detection and sentence patches on the right -->
    <div class="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-2 gap-3">
      <section class="relative min-h-0 flex flex-col border border-base-300 rounded-lg bg-base-100 overflow-hidden">
        <header class="px-3 py-2 border-b border-base-300 flex items-center justify-between shrink-0">
          <span class="text-xs font-semibold">原文</span>
          <span class="text-[10px] text-base-content/40">有效 {{ effectiveInputLength }} 字 · 至少 {{ ZHUQUE_MIN_TEXT_LENGTH }} 字</span>
        </header>
        <textarea
          :value="inputText"
          :maxlength="LAB_TEXT_MAX"
          class="textarea w-full flex-1 min-h-[12rem] border-0 rounded-none text-sm leading-relaxed resize-none font-mono focus:outline-none"
          placeholder="请输入待检测的文本内容…"
          :disabled="status === 'running' || rewriting"
          @input="onInput"
        />
        <div
          v-if="status === 'running'"
          class="absolute inset-0 flex items-center justify-center bg-base-100/65 z-10"
        >
          <div class="flex flex-col items-center gap-2">
            <span class="loading loading-dots loading-lg text-primary" />
            <span class="text-xs text-base-content/50">正在分析检测窗口…</span>
          </div>
        </div>
      </section>

      <section class="min-h-0 flex flex-col gap-2">
        <div
          v-if="status === 'error'"
          class="shrink-0 p-3 text-error text-xs border border-error/20 rounded-lg bg-error/5"
        >{{ errorMessage }}</div>

        <article
          v-if="result && status === 'done'"
          class="border border-base-300 rounded-lg bg-base-100 min-h-0 flex flex-col"
          :class="(rewritePatches?.length || rewriting) ? 'max-h-[42%]' : 'flex-1'"
        >
          <header class="px-3 py-2 border-b border-base-300 shrink-0">
            <div class="flex items-center gap-2 flex-wrap text-[10px]">
              <span class="text-xs font-semibold mr-auto">检测结果</span>
              <span class="badge badge-xs" :style="{ backgroundColor: CATEGORY_COLORS.human }">人工 {{ displayDistribution.human }}%</span>
              <span class="badge badge-xs" :style="{ backgroundColor: CATEGORY_COLORS.suspected_ai }">疑似 {{ displayDistribution.suspected_ai }}%</span>
              <span class="badge badge-xs" :style="{ backgroundColor: CATEGORY_COLORS.ai }">AI {{ displayDistribution.ai }}%</span>
              <button type="button" class="btn btn-ghost btn-xs" @click="showDetectDetails = true">
                <font-awesome-icon icon="chart-bar" class="w-3 h-3" />
                详情
              </button>
            </div>
            <p class="mt-1 text-[10px] text-base-content/50">{{ displaySummary }}</p>
          </header>
          <div class="flex-1 min-h-0 overflow-auto p-3">
            <AigcHighlightedText :segments="result.segments" :patches="rewritePatches" />
          </div>
          <footer class="px-3 py-1.5 border-t border-base-300 text-[9px] text-base-content/40 shrink-0">
            检测阶段颜色表示句级概率类别；逐句分析后，红色只保留已定位到句内证据的目标，窗口级风险显示黄色
          </footer>
        </article>

        <AigcSentenceRewritePanel
          v-if="rewritePatches?.length || rewriting"
          class="flex-1 min-h-0"
          :patches="rewritePatches || []"
          :goal="rewriteGoal"
          :decisions="rewriteDecisions || {}"
          :preview-text="rewritePreviewText || ''"
          :rewriting="rewriting"
          @accept="emit('acceptPatch', $event)"
          @reject="emit('rejectPatch', $event)"
          @accept-all="emit('acceptAllPatches')"
          @apply-accepted="emit('applyAcceptedPatches')"
        />

        <div
          v-else-if="!result"
          class="flex-1 min-h-0 border border-dashed border-base-300 rounded-lg flex items-center justify-center text-xs text-base-content/35"
        >检测结果和逐句改写反馈将在这里显示</div>
      </section>
    </div>

    <!-- 检测时的模型下载进度条 -->
    <div v-if="downloadProgress && !modelDownloadProgress" class="mt-1">
      <div class="flex items-center gap-2 text-xs text-base-content/60">
        <span class="loading loading-spinner loading-xs" />
        <span>{{ downloadProgress.message }}</span>
      </div>
      <progress
        class="progress progress-primary w-full mt-1"
        :value="downloadProgress.percent"
        max="100"
      />
    </div>

    <!-- 案例增强模式说明 -->
    <div v-if="isStrongMode && status !== 'running'" class="mt-1">
      <div class="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-base-content/65">
        改写前会判断目标片段的场景和 AI 痕迹，只加载案例库中同时匹配的“改写前 → 人类改写后”案例；没有匹配案例时将停止并说明缺少的类型。
      </div>
    </div>

    <AigcDetectDetailDrawer
      v-if="result"
      :open="showDetectDetails"
      :result="result"
      @close="showDetectDetails = false"
    />
  </div>
</template>
