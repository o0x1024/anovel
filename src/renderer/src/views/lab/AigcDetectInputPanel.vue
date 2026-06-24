<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { AigcSeedOpts } from '../../composables/useAigcDetect'
import { usePerplexityModels, type PplModelInfo } from '../../composables/usePerplexityModels'
import type {
  PerplexityEngineMode,
  PerplexityApiConfig,
  AigcRewriteSelectionView,
  AigcRewriteCompareView,
  AigcDetectResult,
  AigcCategory
} from '../../../../shared/aigc-detect-types'
import { AIGC_CATEGORY_LABELS } from '../../../../shared/aigc-detect-types'
import { buildTextDiff } from '../../../../shared/text-diff'
import DeaiDiffText from './DeaiDiffText.vue'

const LAB_TEXT_MAX = 50_000

const props = defineProps<{
  inputText: string
  seedOpts: AigcSeedOpts
  status: 'idle' | 'running' | 'done' | 'error'
  rewriting?: boolean
  applyingWordTable?: boolean
  rewriteProgress?: { message: string; level?: 'info' | 'warn' } | null
  rewriteSelection?: AigcRewriteSelectionView | null
  rewriteCompare?: AigcRewriteCompareView | null
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
}>()

const {
  models, switchModel, deleteModel, downloadModel,
  downloading, downloadProgress: modelDownloadProgress,
  refresh: refreshModels
} = usePerplexityModels()
const showModelPanel = ref(false)
const engineExpanded = ref(false)

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
  if (m.active) return
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
  (props.result?.segments ?? []).map(seg => seg.text).join('') || props.inputText
)

const CATEGORY_COLORS: Record<AigcCategory, string> = {
  human: '#a3d977',
  suspected_ai: '#f5deb3',
  ai: '#f5a0a0'
}

const CATEGORY_BG_CLASSES: Record<AigcCategory, string> = {
  human: 'bg-[#a3d977]/30',
  suspected_ai: 'bg-[#f5deb3]/50',
  ai: 'bg-[#f5a0a0]/40'
}

const RADIUS = 54
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const donutSegments = computed(() => {
  if (!props.result) return []
  const { distribution } = props.result
  const segments: Array<{ category: AigcCategory; percent: number; color: string; offset: number }> = []
  let offset = 0
  const order: AigcCategory[] = ['human', 'suspected_ai', 'ai']
  for (const cat of order) {
    const percent = distribution[cat]
    if (percent > 0) {
      segments.push({ category: cat, percent, color: CATEGORY_COLORS[cat], offset })
    }
    offset += percent
  }
  return segments
})

function getStrokeDasharray(percent: number, circumference: number): string {
  const len = (percent / 100) * circumference
  return `${len} ${circumference - len}`
}

function toggleMode() {
  const newMode = isStrongMode.value ? 'fast' : 'strong'
  emit('update:seedOpts', { ...props.seedOpts, mode: newMode })
}

function onSeedTextInput(e: Event) {
  const text = (e.target as HTMLTextAreaElement).value
  emit('update:seedOpts', { ...props.seedOpts, seedText: text })
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
  if (isStrongMode.value && !props.seedOpts.seedText?.trim()) return false
  return true
})

const canApplyWordTable = computed(() => {
  if (!props.inputText.trim() || props.rewriting || props.applyingWordTable) return false
  return true
})

const effectiveDownloadProgress = computed(() => {
  return modelDownloadProgress.value || props.downloadProgress
})

const orderedRewriteEvaluations = computed(() => {
  return [...(props.rewriteSelection?.evaluations || [])].sort((a, b) => a.objectiveScore - b.objectiveScore)
})

const compareExpanded = ref(true)
const compareMode = ref<'diff' | 'rewritten'>('diff')
const rewriteDiff = computed(() => {
  if (!props.rewriteCompare) return { original: [], modified: [] }
  return buildTextDiff(props.rewriteCompare.originalText, props.rewriteCompare.rewrittenText)
})
const hasRewriteChanges = computed(() => {
  if (!props.rewriteCompare) return false
  return props.rewriteCompare.originalText !== props.rewriteCompare.rewrittenText
})

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`
}

onUnmounted(() => {
  if (copyHintTimer) clearTimeout(copyHintTimer)
})
</script>

<template>
  <div class="flex flex-col gap-2 flex-1 min-h-0">
    <!-- Controls bar -->
    <div class="flex items-center gap-2 flex-wrap shrink-0">
      <template v-if="status !== 'running'">
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
          :disabled="!inputText.trim() || rewriting || applyingWordTable"
          @click="emit('run')"
        >
          <font-awesome-icon icon="magnifying-glass" class="w-3.5 h-3.5" />
          {{ result ? '重新检测' : '开始检测' }}
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
          <span class="text-xs" :class="isStrongMode ? 'font-medium' : 'text-base-content/50'">强力人工化</span>
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

        <!-- 内置模型列表面板 -->
        <div v-if="engineMode === 'builtin' && showModelPanel" class="rounded-box border border-base-300 p-2 bg-base-200/50">
          <div
            v-for="m in models"
            :key="m.id"
            class="flex items-center gap-2 py-1.5 px-2 rounded-lg cursor-pointer hover:bg-base-300/50 transition-colors"
            :class="{ 'bg-primary/10 border border-primary/30': m.active }"
            @click="onSwitchModel(m)"
          >
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-1.5">
                <span class="text-xs font-medium truncate">{{ m.name }}</span>
                <span v-if="m.active" class="badge badge-primary badge-xs">当前</span>
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

    <!-- Main content: text input / highlighted result + chart sidebar -->
    <div class="flex-1 min-h-0 flex gap-3">
      <div class="flex-1 min-h-0 relative flex flex-col">
        <!-- Error -->
        <div
          v-if="status === 'error'"
          class="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4 text-error text-sm border border-error/20 rounded-lg bg-error/5"
        >
          {{ errorMessage }}
        </div>

        <!-- Result: highlighted segments -->
        <div
          v-else-if="result && status === 'done'"
          class="flex-1 min-h-0 overflow-auto border border-base-300 rounded-lg bg-base-100 p-3"
        >
          <div class="text-sm leading-relaxed whitespace-pre-wrap break-words">
            <span
              v-for="(seg, idx) in result.segments"
              :key="idx"
              class="rounded-sm px-0.5 relative group cursor-default"
              :class="CATEGORY_BG_CLASSES[seg.category]"
            >{{ seg.text }}<span
                v-if="seg.reason"
                class="absolute hidden group-hover:block left-0 top-full z-50 mt-1 px-2 py-1 text-[11px] bg-base-300 rounded shadow-lg whitespace-nowrap max-w-xs text-base-content"
              >{{ AIGC_CATEGORY_LABELS[seg.category] }}：{{ seg.reason }}</span></span>
          </div>
        </div>

        <!-- Edit: textarea -->
        <template v-else>
          <textarea
            :value="inputText"
            :maxlength="LAB_TEXT_MAX"
            class="textarea textarea-bordered w-full flex-1 min-h-[8rem] text-sm leading-relaxed resize-none font-mono"
            placeholder="请输入待检测的文本内容…"
            :disabled="status === 'running'"
            @input="onInput"
          />
          <span class="absolute bottom-2 right-3 text-[10px] text-base-content/40">
            {{ inputText.length }} / {{ LAB_TEXT_MAX.toLocaleString() }}
          </span>
        </template>

        <!-- Loading overlay -->
        <div
          v-if="status === 'running'"
          class="absolute inset-0 flex items-center justify-center bg-base-100/60 rounded-lg z-10"
        >
          <div class="flex flex-col items-center gap-2">
            <span class="loading loading-dots loading-lg text-primary" />
            <span class="text-xs text-base-content/50">正在分析…</span>
          </div>
        </div>
      </div>

      <!-- Chart sidebar -->
      <div
        v-if="result && status === 'done'"
        class="w-48 shrink-0 flex flex-col items-center gap-3 pt-2"
      >
        <div class="relative w-28 h-28">
          <svg viewBox="0 0 140 140" class="w-full h-full -rotate-90">
            <circle
              v-for="(seg, idx) in donutSegments"
              :key="idx"
              cx="70" cy="70" :r="RADIUS"
              fill="none"
              :stroke="seg.color"
              stroke-width="18"
              :stroke-dasharray="getStrokeDasharray(seg.percent, CIRCUMFERENCE)"
              :stroke-dashoffset="-((seg.offset / 100) * CIRCUMFERENCE)"
            />
            <circle cx="70" cy="70" r="43" class="fill-base-100" stroke="currentColor" stroke-width="1" opacity="0.2" />
          </svg>
          <div class="absolute inset-0 flex flex-col items-center justify-center">
            <span class="text-xl font-extrabold leading-none tracking-tight">
              {{ result.distribution.ai }}%
            </span>
            <span class="text-[10px] text-base-content/60 mt-0.5">AI特征</span>
          </div>
        </div>

        <div class="flex flex-col gap-1 text-xs text-base-content/60 w-full">
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <span class="w-2.5 h-2.5 rounded-sm" :style="{ backgroundColor: CATEGORY_COLORS.human }" />
              {{ AIGC_CATEGORY_LABELS.human }}
            </span>
            <span class="font-mono">{{ result.distribution.human }}%</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <span class="w-2.5 h-2.5 rounded-sm" :style="{ backgroundColor: CATEGORY_COLORS.suspected_ai }" />
              {{ AIGC_CATEGORY_LABELS.suspected_ai }}
            </span>
            <span class="font-mono">{{ result.distribution.suspected_ai }}%</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="flex items-center gap-1.5">
              <span class="w-2.5 h-2.5 rounded-sm" :style="{ backgroundColor: CATEGORY_COLORS.ai }" />
              {{ AIGC_CATEGORY_LABELS.ai }}
            </span>
            <span class="font-mono">{{ result.distribution.ai }}%</span>
          </div>
        </div>

        <div class="text-[11px] text-base-content/50 text-center border-t border-base-200 pt-2 mt-auto leading-relaxed">
          {{ result.summary }}
        </div>
        <div class="text-[10px] text-base-content/40 text-center leading-relaxed">
          本检测基于困惑度分析，与朱雀等分类器检测原理不同，结果可能有差异
        </div>
      </div>
    </div>

    <div
      v-if="rewriteSelection && !rewriting"
      class="rounded-box border border-base-300 bg-base-200/40 p-2 text-[11px] leading-relaxed"
    >
      <div class="flex items-center gap-2 flex-wrap">
        <span class="font-medium text-base-content/80">改写候选评估</span>
        <span class="badge badge-primary badge-xs">已选：{{ rewriteSelection.selectedKey }}</span>
        <span class="text-base-content/60">
          复检 {{ rewriteSelection.selectedDocScore.toFixed(1) }}
          <template v-if="typeof rewriteSelection.baselineDocScore === 'number'">
            / 基线 {{ rewriteSelection.baselineDocScore.toFixed(1) }}
          </template>
        </span>
      </div>

      <div class="mt-1 space-y-1">
        <div
          v-for="item in orderedRewriteEvaluations"
          :key="item.key"
          class="rounded border px-2 py-1"
          :class="item.key === rewriteSelection.selectedKey ? 'border-primary/40 bg-primary/5' : 'border-base-300/70 bg-base-100/40'"
        >
          <div class="flex items-center gap-2 flex-wrap">
            <span class="font-medium">{{ item.key }}</span>
            <span v-if="item.key === rewriteSelection.selectedKey" class="badge badge-primary badge-xs">当前采用</span>
            <span class="text-base-content/55">objective {{ item.objectiveScore.toFixed(1) }}</span>
            <span class="text-base-content/55">复检 {{ item.docScore.toFixed(1) }}</span>
            <span class="text-base-content/55">改写幅度 {{ formatPercent(item.changeRatio) }}</span>
            <span class="text-base-content/55">锚点保留 {{ formatPercent(item.numberAnchorRetention) }}</span>
          </div>
          <div v-if="item.issues.length > 0" class="text-warning mt-0.5">
            {{ item.issues.join('；') }}
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="rewriteCompare && !rewriting"
      class="rounded-box border border-base-300 bg-base-200/30 p-2"
    >
      <button
        type="button"
        class="w-full flex items-center gap-2 text-left"
        @click="compareExpanded = !compareExpanded"
      >
        <font-awesome-icon
          icon="chevron-right"
          class="w-2.5 h-2.5 text-base-content/50 transition-transform"
          :class="{ 'rotate-90': compareExpanded }"
        />
        <span class="text-xs font-medium text-base-content/80">修改前后对比</span>
        <span class="text-[11px] text-base-content/55 tabular-nums">
          {{ rewriteCompare.originalText.length.toLocaleString() }} → {{ rewriteCompare.rewrittenText.length.toLocaleString() }} 字
        </span>
        <span
          v-if="hasRewriteChanges"
          class="text-[10px] text-base-content/45 inline-flex items-center gap-1"
        >
          <span class="inline-block w-2.5 h-2.5 rounded-sm bg-yellow-200/90 dark:bg-yellow-400/30" />
          标黄为改动
        </span>
      </button>

      <div v-if="compareExpanded" class="mt-2">
        <div class="join join-horizontal mb-2">
          <button
            type="button"
            class="btn btn-xs join-item"
            :class="compareMode === 'diff' ? 'btn-primary' : 'btn-ghost'"
            @click="compareMode = 'diff'"
          >
            对比
          </button>
          <button
            type="button"
            class="btn btn-xs join-item"
            :class="compareMode === 'rewritten' ? 'btn-primary' : 'btn-ghost'"
            @click="compareMode = 'rewritten'"
          >
            仅看改写后
          </button>
        </div>

        <div
          v-if="compareMode === 'diff'"
          class="grid grid-cols-1 md:grid-cols-2 gap-2"
        >
          <article class="border border-base-300/80 rounded-md bg-base-200/20 flex flex-col min-h-0">
            <h3 class="text-[11px] font-medium text-base-content/55 px-2 py-1 border-b border-base-300/50">
              原文
            </h3>
            <div class="max-h-52 overflow-y-auto px-2 py-2">
              <pre class="text-xs whitespace-pre-wrap break-words leading-5">
                <DeaiDiffText
                  v-if="hasRewriteChanges"
                  :segments="rewriteDiff.original"
                />
                <template v-else>{{ rewriteCompare.originalText }}</template>
              </pre>
            </div>
          </article>

          <article class="border border-base-300/80 rounded-md bg-base-200/20 flex flex-col min-h-0">
            <h3 class="text-[11px] font-medium text-base-content/55 px-2 py-1 border-b border-base-300/50">
              改写后
            </h3>
            <div class="max-h-52 overflow-y-auto px-2 py-2">
              <pre class="text-xs whitespace-pre-wrap break-words leading-5">
                <DeaiDiffText
                  v-if="hasRewriteChanges"
                  :segments="rewriteDiff.modified"
                />
                <template v-else>{{ rewriteCompare.rewrittenText }}</template>
              </pre>
            </div>
          </article>
        </div>

        <article
          v-else
          class="border border-base-300/80 rounded-md bg-base-200/20 flex flex-col min-h-0"
        >
          <h3 class="text-[11px] font-medium text-base-content/55 px-2 py-1 border-b border-base-300/50">
            改写后
          </h3>
          <div class="max-h-56 overflow-y-auto px-2 py-2">
            <pre class="text-xs whitespace-pre-wrap break-words leading-5">{{ rewriteCompare.rewrittenText }}</pre>
          </div>
        </article>
      </div>
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

    <!-- 强力人工化模式：种子文本输入 -->
    <div v-if="isStrongMode && status !== 'running'" class="mt-1">
      <label class="text-xs font-medium text-base-content/70 mb-1 block">
        人工种子文本
        <span class="font-normal text-base-content/50">（粘贴你自己写的段落，将前置到改写结果中）</span>
      </label>
      <textarea
        :value="seedOpts.seedText || ''"
        rows="4"
        class="textarea textarea-bordered w-full text-sm leading-relaxed resize-none"
        placeholder="粘贴你自己手写的文本段落（来自你的作品章节、大纲或随手写的片段）…"
        @input="onSeedTextInput"
      />
      <p class="text-[10px] text-base-content/40 mt-0.5">
        实验表明：前置约50%的人工文本可显著提升人工特征检测率
      </p>
    </div>
  </div>
</template>
