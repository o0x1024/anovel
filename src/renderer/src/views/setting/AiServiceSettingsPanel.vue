<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import SearchableModelSelect from '../../components/SearchableModelSelect.vue'
import StepModelOverridesEditor from '../../components/StepModelOverridesEditor.vue'
import {
  BUILTIN_PROVIDERS,
  PROTOCOL_OPTIONS,
  isCustomProviderType,
  resolveProviderProtocol,
  providerDisplayLabel,
  defaultBaseForProtocol,
  defaultModelForProtocol,
  iconForProtocol,
  type ProviderProtocol
} from '../../../../shared/model-providers'
import {
  DEFAULT_DEEPSEEK_PROVIDER_OPTIONS,
  parseDeepSeekProviderOptions,
  type DeepSeekProviderOptions
} from '../../../../shared/deepseek-api-params'
import {
  DEFAULT_MIMO_PROVIDER_OPTIONS,
  isMimoProvider,
  MIMO_API_BASE,
  parseMimoProviderOptions,
  resolveMimoApiBase,
  openAICompatibleAuthHeaders,
  type MimoProviderOptions
} from '../../../../shared/mimo-api-params'
import VolcengineImageSettings from './VolcengineImageSettings.vue'
import {
  BAILIAN_API_BASE_CN,
  BAILIAN_REGION_LABELS,
  DEFAULT_BAILIAN_PROVIDER_OPTIONS,
  isBailianProvider,
  parseBailianProviderOptions,
  resolveBailianApiBase,
  type BailianProviderOptions
} from '../../../../shared/bailian-api-params'

interface ModelConfig {
  model_type: string
  model_name: string | null
  api_key: string | null
  api_base: string | null
  is_enabled: number
  priority: number
  max_context_tokens: number
  available_models_json?: string | null
  display_name?: string | null
  provider_protocol?: string | null
  provider_options_json?: string | null
}

interface ProviderView {
  type: string
  label: string
  description: string
  protocol: ProviderProtocol
  defaultBase: string
  defaultModel: string
  icon: string
  color: string
  isCustom: boolean
}

const emit = defineEmits<{
  toast: [type: 'success' | 'error' | 'info', message: string]
}>()

function showToast(type: 'success' | 'error' | 'info', message: string) {
  emit('toast', type, message)
}

function logProviderError(
  config: ModelConfig,
  error: unknown
) {
  void window.anovel.invoke('log:write', 'ERROR', 'settings', '提供商连接测试失败', {
    action: 'test_connection',
    modelType: config.model_type,
    apiBase: config.api_base,
    protocol: resolveProviderProtocol(config.model_type, config.provider_protocol),
    error: error instanceof Error ? error.message : String(error)
  })
}

function builtinDefaultConfig(p: typeof BUILTIN_PROVIDERS[number], priority: number): ModelConfig {
  return {
    model_type: p.type,
    model_name: p.defaultModel,
    api_key: '',
    api_base: p.defaultBase,
    is_enabled: 0,
    priority,
    max_context_tokens: 256000,
    display_name: null,
    provider_protocol: p.protocol
  }
}

const configs = ref<ModelConfig[]>(
  BUILTIN_PROVIDERS.map((p, i) => builtinDefaultConfig(p, i + 1))
)

const loading = ref(true)
const ready = ref(false)
const testing = ref<string | null>(null)
const refreshing = ref<string | null>(null)
const testResult = ref<Record<string, 'success' | 'fail' | null>>({})
const showKey = ref<Record<string, boolean>>({})
const availableModels = ref<Record<string, string[]>>({})
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
let globalDefaultSaveTimer: ReturnType<typeof setTimeout> | null = null
let genParamsSaveTimer: ReturnType<typeof setTimeout> | null = null

const selectedType = ref('deepseek')
const stepModelExpanded = ref(false)
const selectedConfig = computed(() => configs.value.find(c => c.model_type === selectedType.value))

const providerViews = computed((): ProviderView[] => {
  return configs.value.map(config => {
    const builtin = BUILTIN_PROVIDERS.find(p => p.type === config.model_type)
    if (builtin) {
      return { ...builtin, isCustom: false }
    }
    const protocol = resolveProviderProtocol(config.model_type, config.provider_protocol)
    const protocolLabel = PROTOCOL_OPTIONS.find(p => p.value === protocol)?.label ?? protocol
    return {
      type: config.model_type,
      label: config.display_name?.trim() || config.model_type,
      description: `自定义 · ${protocolLabel}`,
      protocol,
      defaultBase: config.api_base || defaultBaseForProtocol(protocol),
      defaultModel: config.model_name || defaultModelForProtocol(protocol),
      icon: iconForProtocol(protocol),
      color: 'text-warning',
      isCustom: true
    }
  })
})

const selectedProvider = computed(() =>
  providerViews.value.find(p => p.type === selectedType.value) ?? providerViews.value[0]
)

const globalDefaultProvider = ref<string>('')
const globalDefaultModel = ref<string>('')

function parseCatalogJson(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  } catch {
    return []
  }
}

function catalogForProvider(type: string, modelName?: string | null): string[] {
  const catalog = availableModels.value[type] ?? []
  if (catalog.length) {
    if (modelName && !catalog.includes(modelName)) return [modelName, ...catalog]
    return catalog
  }
  if (modelName) return [modelName]
  const view = providerViews.value.find(p => p.type === type)
  return view?.defaultModel ? [view.defaultModel] : []
}

const currentModelOptions = computed(() =>
  catalogForProvider(selectedType.value, selectedConfig.value?.model_name)
)

const globalModelOptions = computed(() => {
  if (!globalDefaultProvider.value) return []
  const config = configs.value.find(c => c.model_type === globalDefaultProvider.value)
  return catalogForProvider(globalDefaultProvider.value, config?.model_name)
})

const hasPersistedCatalog = computed(() =>
  (availableModels.value[selectedType.value]?.length ?? 0) > 0
)

const selectableGlobalProviders = computed(() =>
  configs.value.filter(c => c.is_enabled === 1 && c.api_key)
)

const selectedProtocol = computed(() => {
  const config = selectedConfig.value
  if (!config) return 'openai' as ProviderProtocol
  return resolveProviderProtocol(config.model_type, config.provider_protocol)
})

const isGeminiProtocol = computed(() => selectedProtocol.value === 'gemini')

const isDeepSeekProvider = computed(() => selectedType.value === 'deepseek')
const isMimoProviderSelected = computed(() => isMimoProvider(selectedType.value))
const isBailianProviderSelected = computed(() => isBailianProvider(selectedType.value))
const isMimoApiMode = computed(() => mimoOptions.value.accessMode === 'api')
const isMimoTokenPlanMode = computed(() => mimoOptions.value.accessMode === 'token_plan')

const deepseekOptions = ref<DeepSeekProviderOptions>({ ...DEFAULT_DEEPSEEK_PROVIDER_OPTIONS })
const mimoOptions = ref<MimoProviderOptions>({ ...DEFAULT_MIMO_PROVIDER_OPTIONS })
const bailianOptions = ref<BailianProviderOptions>({ ...DEFAULT_BAILIAN_PROVIDER_OPTIONS })

function loadDeepseekOptionsFromConfig(config: ModelConfig | undefined) {
  if (!config?.provider_options_json) {
    deepseekOptions.value = { ...DEFAULT_DEEPSEEK_PROVIDER_OPTIONS }
    return
  }
  deepseekOptions.value = parseDeepSeekProviderOptions(config.provider_options_json)
}

function loadMimoOptionsFromConfig(config: ModelConfig | undefined) {
  mimoOptions.value = parseMimoProviderOptions(config?.provider_options_json, config?.api_base)
}

function loadBailianOptionsFromConfig(config: ModelConfig | undefined) {
  bailianOptions.value = parseBailianProviderOptions(config?.provider_options_json, config?.api_base)
}

function applyMimoBaseFromOptions() {
  const config = selectedConfig.value
  if (!config || !isMimoProvider(config.model_type)) return
  config.api_base = resolveMimoApiBase(mimoOptions.value)
}

function applyBailianBaseFromOptions() {
  const config = selectedConfig.value
  if (!config || !isBailianProvider(config.model_type)) return
  config.api_base = resolveBailianApiBase(bailianOptions.value)
}

watch(selectedType, () => {
  loadDeepseekOptionsFromConfig(selectedConfig.value)
  loadMimoOptionsFromConfig(selectedConfig.value)
  loadBailianOptionsFromConfig(selectedConfig.value)
}, { immediate: true })

watch(deepseekOptions, () => {
  if (!ready.value || !isDeepSeekProvider.value) return
  const config = selectedConfig.value
  if (!config) return
  config.provider_options_json = JSON.stringify(deepseekOptions.value)
  scheduleAutoSave()
}, { deep: true })

watch(mimoOptions, () => {
  if (!ready.value || !isMimoProviderSelected.value) return
  const config = selectedConfig.value
  if (!config) return
  config.provider_options_json = JSON.stringify(mimoOptions.value)
  applyMimoBaseFromOptions()
  scheduleAutoSave()
}, { deep: true })

watch(bailianOptions, () => {
  if (!ready.value || !isBailianProviderSelected.value) return
  const config = selectedConfig.value
  if (!config) return
  config.provider_options_json = JSON.stringify(bailianOptions.value)
  applyBailianBaseFromOptions()
  scheduleAutoSave()
}, { deep: true })

const temperature = ref(0.92)
const maxTokens = ref(5250)
const frequencyPenalty = ref(0.35)
const presencePenalty = ref(0.3)
const topP = ref(0.9)

const GENERATION_PARAM_BOUNDS = {
  temperature: { min: 0, max: 2, step: 0.01 },
  maxTokens: { min: 1, max: 200000, step: 1 },
  frequencyPenalty: { min: -2, max: 2, step: 0.01 },
  presencePenalty: { min: -2, max: 2, step: 0.01 },
  topP: { min: 0, max: 1, step: 0.01 }
} as const

type GenerationParamKey = keyof typeof GENERATION_PARAM_BOUNDS

const generationParamRefs: Record<GenerationParamKey, typeof temperature> = {
  temperature,
  maxTokens,
  frequencyPenalty,
  presencePenalty,
  topP
}

function clampGenerationParam(key: GenerationParamKey): void {
  const bounds = GENERATION_PARAM_BOUNDS[key]
  const raw = generationParamRefs[key].value
  if (!Number.isFinite(raw)) {
    generationParamRefs[key].value = bounds.min
    return
  }
  const clamped = Math.min(bounds.max, Math.max(bounds.min, raw))
  const stepped = bounds.step >= 1
    ? Math.round(clamped)
    : Math.round(clamped / bounds.step) * bounds.step
  generationParamRefs[key].value = Number(stepped.toFixed(key === 'maxTokens' ? 0 : 2))
}

// 添加自定义提供商
const showAddModal = ref(false)
const newProviderName = ref('')
const newProviderProtocol = ref<ProviderProtocol>('openai')

onMounted(async () => {
  await loadConfigs()
  await loadGlobalDefault()
  await loadGenerationParams()
  ready.value = true
})

watch(configs, () => scheduleAutoSave(), { deep: true })
watch([globalDefaultProvider, globalDefaultModel], () => scheduleGlobalDefaultSave())
watch([temperature, maxTokens, frequencyPenalty, presencePenalty, topP], () => scheduleGenParamsSave())

function scheduleAutoSave() {
  if (!ready.value) return
  if (autoSaveTimer) clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(() => { void persistAllConfigs() }, 500)
}

function scheduleGlobalDefaultSave() {
  if (!ready.value) return
  if (globalDefaultSaveTimer) clearTimeout(globalDefaultSaveTimer)
  globalDefaultSaveTimer = setTimeout(() => { void persistGlobalDefault() }, 500)
}

function scheduleGenParamsSave() {
  if (!ready.value) return
  if (genParamsSaveTimer) clearTimeout(genParamsSaveTimer)
  genParamsSaveTimer = setTimeout(() => { void persistGenerationParams() }, 500)
}

async function loadGenerationParams() {
  try {
    const params = await window.anovel.invoke('model:getGenerationParams') as {
      temperature: number; maxTokens: number
      frequencyPenalty: number; presencePenalty: number; topP: number
    }
    temperature.value = params.temperature
    maxTokens.value = params.maxTokens
    frequencyPenalty.value = params.frequencyPenalty
    presencePenalty.value = params.presencePenalty
    topP.value = params.topP
  } catch { /* use defaults */ }
}

async function persistGenerationParams() {
  try {
    await window.anovel.invoke('model:setGenerationParams', {
      temperature: temperature.value,
      maxTokens: maxTokens.value,
      frequencyPenalty: frequencyPenalty.value,
      presencePenalty: presencePenalty.value,
      topP: topP.value
    })
    showToast('success', '高级配置已保存')
  } catch (e) {
    showToast('error', `保存高级配置失败：${e}`)
  }
}

async function loadConfigs() {
  loading.value = true
  try {
    const rows = await window.anovel.invoke('model:list') as ModelConfig[]
    const merged = BUILTIN_PROVIDERS.map((p, i) => builtinDefaultConfig(p, i + 1))

    for (const row of rows) {
      const catalog = parseCatalogJson(row.available_models_json)
      if (catalog.length) {
        availableModels.value = { ...availableModels.value, [row.model_type]: catalog }
      }

      if (isCustomProviderType(row.model_type)) {
        merged.push({
          model_type: row.model_type,
          model_name: row.model_name ?? defaultModelForProtocol(resolveProviderProtocol(row.model_type, row.provider_protocol)),
          api_key: row.api_key ?? '',
          api_base: row.api_base ?? defaultBaseForProtocol(resolveProviderProtocol(row.model_type, row.provider_protocol)),
          is_enabled: row.is_enabled,
          priority: row.priority,
          max_context_tokens: row.max_context_tokens ?? 256000,
          display_name: row.display_name,
          provider_protocol: row.provider_protocol
        })
        continue
      }

      const idx = merged.findIndex(c => c.model_type === row.model_type)
      if (idx !== -1) {
        merged[idx] = {
          ...merged[idx],
          api_key: row.api_key ?? '',
          api_base: row.api_base ?? merged[idx].api_base,
          model_name: row.model_name ?? merged[idx].model_name,
          is_enabled: row.is_enabled,
          priority: row.priority,
          max_context_tokens: row.max_context_tokens ?? 256000,
          display_name: row.display_name,
          provider_protocol: row.provider_protocol ?? merged[idx].provider_protocol,
          provider_options_json: row.provider_options_json
        }
      }
    }

    configs.value = merged.sort((a, b) => a.priority - b.priority)
    loadDeepseekOptionsFromConfig(selectedConfig.value)
    loadMimoOptionsFromConfig(selectedConfig.value)
    loadBailianOptionsFromConfig(selectedConfig.value)
  } catch (e) {
    showToast('error', '加载配置失败，显示默认值')
    console.error(e)
  } finally {
    loading.value = false
  }
}

async function loadGlobalDefault() {
  try {
    const data = await window.anovel.invoke('model:getGlobalDefault') as {
      provider: string | null
      modelName: string | null
    }
    globalDefaultProvider.value = data.provider ?? ''
    globalDefaultModel.value = data.modelName ?? ''
    ensureGlobalModelValid()
  } catch (e) {
    console.error(e)
  }
}

function ensureGlobalModelValid() {
  if (!globalDefaultProvider.value) {
    globalDefaultModel.value = ''
    return
  }
  const options = globalModelOptions.value
  if (options.length && !options.includes(globalDefaultModel.value)) {
    globalDefaultModel.value = options[0]
  }
}

watch(globalDefaultProvider, () => {
  ensureGlobalModelValid()
})

async function persistGlobalDefault() {
  try {
    await window.anovel.invoke(
      'model:setGlobalDefault',
      globalDefaultProvider.value || null,
      globalDefaultModel.value || null
    )
    showToast('success', '全局默认模型已保存')
  } catch (e: unknown) {
    console.error('[GlobalDefault Save Error]', e)
    showToast('error', `保存失败：${e instanceof Error ? e.message : '未知错误'}`)
  }
}

async function persistAllConfigs() {
  try {
    for (const config of configs.value) {
      await window.anovel.invoke(
        'model:upsert',
        config.model_type,
        config.api_key || '',
        config.api_base || '',
        config.model_name || '',
        config.display_name ?? null,
        config.provider_protocol ?? null
      )
      await window.anovel.invoke('model:setEnabled', config.model_type, config.is_enabled === 1)
      await window.anovel.invoke('model:setMaxContextTokens', config.model_type, config.max_context_tokens)
      if (config.model_type === 'deepseek') {
        await window.anovel.invoke(
          'model:setProviderOptions',
          config.model_type,
          config.provider_options_json ?? JSON.stringify(DEFAULT_DEEPSEEK_PROVIDER_OPTIONS)
        )
      }
      if (config.model_type === 'mimo') {
        await window.anovel.invoke(
          'model:setProviderOptions',
          config.model_type,
          config.provider_options_json ?? JSON.stringify(DEFAULT_MIMO_PROVIDER_OPTIONS)
        )
      }
      if (config.model_type === 'bailian') {
        await window.anovel.invoke(
          'model:setProviderOptions',
          config.model_type,
          config.provider_options_json ?? JSON.stringify(DEFAULT_BAILIAN_PROVIDER_OPTIONS)
        )
      }
    }
    showToast('success', '配置已保存')
  } catch (e: unknown) {
    console.error('[AutoSave Error]', e)
    showToast('error', `保存失败：${e instanceof Error ? e.message : '未知错误'}`)
  }
}

async function testConnection() {
  const config = selectedConfig.value
  if (!config?.api_key) { showToast('error', '请先填写 API Key'); return }
  const protocol = resolveProviderProtocol(config.model_type, config.provider_protocol)
  testing.value = config.model_type
  testResult.value[config.model_type] = null
  try {
    if (protocol === 'gemini') {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.api_key}`)
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
      }
    } else if (protocol === 'anthropic') {
      const base = (config.api_base || 'https://api.anthropic.com/v1').replace(/\/$/, '')
      const response = await fetch(`${base}/models`, {
        headers: {
          'x-api-key': config.api_key,
          'anthropic-version': '2023-06-01'
        }
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
      }
    } else {
      const base = (config.api_base || 'https://api.openai.com/v1').replace(/\/$/, '')
      const response = await fetch(`${base}/models`, {
        headers: openAICompatibleAuthHeaders(config.model_type, config.api_key)
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } }
        const detail = data?.error?.message ?? data?.error?.code
        throw new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`)
      }
    }
    testResult.value[config.model_type] = 'success'
    showToast('success', `${selectedProvider.value?.label ?? config.model_type} 连接成功！`)
    void window.anovel.invoke('log:write', 'INFO', 'settings', '提供商连接测试成功', {
      action: 'test_connection',
      modelType: config.model_type,
      apiBase: config.api_base,
      protocol
    })
  } catch (e: unknown) {
    testResult.value[config.model_type] = 'fail'
    logProviderError(config, e)
    showToast('error', `连接失败：${e instanceof Error ? e.message : '网络错误'}`)
  } finally {
    testing.value = null
  }
}

async function refreshModels() {
  const config = selectedConfig.value
  if (!config?.api_key) { showToast('error', '请先填写 API Key'); return }
  refreshing.value = config.model_type
  try {
    const models = await window.anovel.invoke('model:refreshCatalog', config.model_type) as string[]
    availableModels.value = { ...availableModels.value, [config.model_type]: models }
    if (config.model_name && !models.includes(config.model_name)) {
      config.model_name = models[0]
    }
    if (globalDefaultProvider.value === config.model_type) {
      ensureGlobalModelValid()
    }
    showToast('success', `获取到 ${models.length} 个模型并已保存`)
  } catch (e: unknown) {
    showToast('error', `获取失败：${e instanceof Error ? e.message : '网络错误'}`)
  } finally {
    refreshing.value = null
  }
}

function getStatusBadge(type: string) {
  const c = configs.value.find(cfg => cfg.model_type === type)
  if (!c?.api_key) return { label: '未配置', className: 'badge-ghost' }
  if (c.is_enabled) return { label: '已启用', className: 'badge-success' }
  return { label: '已禁用', className: 'badge-warning' }
}

function providerLabel(type: string) {
  const config = configs.value.find(c => c.model_type === type)
  return providerDisplayLabel(type, config?.display_name)
}

async function addCustomProvider() {
  const name = newProviderName.value.trim()
  if (!name) {
    showToast('error', '请输入提供商名称')
    return
  }
  try {
    const modelType = await window.anovel.invoke(
      'model:createCustom',
      name,
      newProviderProtocol.value
    ) as string
    await loadConfigs()
    selectedType.value = modelType
    showAddModal.value = false
    newProviderName.value = ''
    newProviderProtocol.value = 'openai'
    showToast('success', `已添加自定义提供商「${name}」`)
  } catch (e: unknown) {
    showToast('error', `添加失败：${e instanceof Error ? e.message : '未知错误'}`)
  }
}

async function deleteCustomProvider() {
  const config = selectedConfig.value
  if (!config || !isCustomProviderType(config.model_type)) return
  const label = config.display_name || config.model_type
  if (!confirm(`确定删除自定义提供商「${label}」？此操作不可撤销。`)) return

  try {
    if (globalDefaultProvider.value === config.model_type) {
      globalDefaultProvider.value = ''
      globalDefaultModel.value = ''
    }
    await window.anovel.invoke('model:delete', config.model_type)
    configs.value = configs.value.filter(c => c.model_type !== config.model_type)
    delete availableModels.value[config.model_type]
    selectedType.value = configs.value[0]?.model_type ?? 'deepseek'
    showToast('success', `已删除「${label}」`)
  } catch (e: unknown) {
    showToast('error', `删除失败：${e instanceof Error ? e.message : '未知错误'}`)
  }
}

function onProtocolChange(protocol: ProviderProtocol) {
  const config = selectedConfig.value
  if (!config || !isCustomProviderType(config.model_type)) return
  config.provider_protocol = protocol
  if (!config.api_base || PROTOCOL_OPTIONS.some(p => p.defaultBase === config.api_base)) {
    config.api_base = defaultBaseForProtocol(protocol)
  }
  if (!config.model_name || PROTOCOL_OPTIONS.some(p => p.defaultModel === config.model_name)) {
    config.model_name = defaultModelForProtocol(protocol)
  }
}
</script>

<template>
  <div>
    <div class="mb-6">
      <h3 class="text-xl font-bold">AI 服务</h3>
      <p class="text-sm text-base-content/50 mt-1">管理 AI 提供商连接、模型与生成参数</p>
    </div>

    <!-- 全局默认 -->
    <div class="card bg-base-100 shadow-sm border border-base-300/60 mb-6">
      <div class="card-body p-5">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-9 h-9 rounded-lg bg-secondary/10 flex items-center justify-center text-secondary">
            <font-awesome-icon icon="server" class="text-base" />
          </div>
          <div>
            <h4 class="font-semibold">全局默认</h4>
            <p class="text-xs text-base-content/50">除 AI 助手手动指定模型外，所有 LLM 调用均使用此配置</p>
          </div>
        </div>

        <div v-if="loading" class="flex items-center gap-2 text-sm text-base-content/50">
          <span class="loading loading-spinner loading-xs text-primary"></span>
          加载中...
        </div>
        <div v-else-if="selectableGlobalProviders.length === 0" class="text-sm text-base-content/50">
          请先配置并启用至少一个 AI 提供商
        </div>
        <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="form-control">
            <label class="label py-1">
              <span class="label-text font-medium text-sm">默认全局提供商</span>
            </label>
            <select v-model="globalDefaultProvider" class="select select-bordered w-full text-sm">
              <option value="">未设置（按启用顺序自动选择）</option>
              <option
                v-for="config in selectableGlobalProviders"
                :key="config.model_type"
                :value="config.model_type"
              >
                {{ providerLabel(config.model_type) }}
              </option>
            </select>
          </div>

          <div class="form-control">
            <label class="label py-1">
              <span class="label-text font-medium text-sm">默认全局模型</span>
            </label>
            <SearchableModelSelect
              v-if="globalDefaultProvider"
              v-model="globalDefaultModel"
              :options="globalModelOptions"
              placeholder="搜索或选择默认全局模型…"
            />
            <div
              v-else
              class="select select-bordered w-full text-sm text-base-content/40 flex items-center px-3 h-12"
            >
              请先选择提供商
            </div>
            <p class="text-xs text-base-content/40 mt-2">
              可在下方各提供商配置中点击「刷新模型」获取最新模型列表
            </p>
          </div>
        </div>
      </div>
    </div>

    <!-- 提供商配置 -->
    <div class="flex flex-col lg:flex-row gap-3">
      <!-- 提供商列表 -->
      <div class="w-full lg:w-52 shrink-0">
        <div class="flex items-center justify-between mb-3">
          <h4 class="text-sm font-bold text-base-content/60 uppercase tracking-wider">AI 提供商</h4>
          <button
            type="button"
            class="btn btn-ghost btn-xs gap-1"
            title="添加自定义提供商"
            @click="showAddModal = true"
          >
            <font-awesome-icon icon="plus" class="w-3 h-3" />
            添加
          </button>
        </div>
        <ul v-if="loading" class="flex justify-center py-8">
          <span class="loading loading-spinner loading-sm text-primary"></span>
        </ul>
        <ul v-else class="menu menu-sm bg-base-200 rounded-box p-2 border border-base-300/60 w-full">
          <li v-for="provider in providerViews" :key="provider.type">
            <button
              type="button"
              :class="{ 'menu-active': selectedType === provider.type }"
              @click="selectedType = provider.type"
            >
              <font-awesome-icon :icon="provider.icon" class="w-4 h-4 shrink-0" />
              <span class="truncate flex-1">{{ provider.label }}</span>
              <span
                class="badge badge-xs shrink-0"
                :class="getStatusBadge(provider.type).className"
              >
                {{ getStatusBadge(provider.type).label }}
              </span>
            </button>
          </li>
        </ul>
      </div>

      <!-- 配置详情 -->
      <div v-if="!loading && selectedConfig && selectedProvider" class="flex-1 min-w-0 space-y-6">
        <div class="card bg-base-100 shadow-sm border border-base-300/60">
          <div class="card-body p-5">
            <div class="flex items-start justify-between gap-4">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <font-awesome-icon :icon="selectedProvider.icon" :class="['text-lg', selectedProvider.color]" />
                </div>
                <div>
                  <h4 class="text-lg font-bold">{{ selectedProvider.label }}</h4>
                  <p class="text-xs text-base-content/50 mt-0.5">{{ selectedProvider.description }}</p>
                </div>
              </div>
              <div class="flex items-center gap-3 shrink-0">
                <button
                  v-if="selectedProvider.isCustom"
                  type="button"
                  class="btn btn-ghost btn-sm btn-square text-error"
                  title="删除此自定义提供商"
                  @click="deleteCustomProvider"
                >
                  <font-awesome-icon icon="trash" class="w-4 h-4" />
                </button>
                <label class="flex items-center gap-2 cursor-pointer">
                  <span class="text-sm text-base-content/60">启用</span>
                  <input
                    type="checkbox"
                    :checked="selectedConfig.is_enabled === 1"
                    class="toggle toggle-primary toggle-sm"
                    @change="(e: Event) => { selectedConfig!.is_enabled = (e.target as HTMLInputElement).checked ? 1 : 0 }"
                  />
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div class="card bg-base-100 shadow-sm border border-base-300/60">
            <div class="card-body p-5 space-y-4">
              <h4 class="text-sm font-bold text-base-content/60 uppercase tracking-wider border-b border-base-300/60 pb-3">
                基本配置
              </h4>

              <!-- 自定义：显示名称 -->
              <div v-if="selectedProvider.isCustom" class="form-control">
                <label class="label py-1">
                  <span class="label-text font-medium text-sm">显示名称</span>
                </label>
                <input
                  v-model="selectedConfig.display_name"
                  class="input input-bordered w-full text-sm rounded-lg"
                  placeholder="例如：我的 OpenRouter"
                />
              </div>

              <!-- 自定义：协议类型 -->
              <div v-if="selectedProvider.isCustom" class="form-control">
                <label class="label py-1">
                  <span class="label-text font-medium text-sm">API 协议</span>
                </label>
                <select
                  :value="selectedProtocol"
                  class="select select-bordered w-full text-sm"
                  @change="(e: Event) => onProtocolChange((e.target as HTMLSelectElement).value as ProviderProtocol)"
                >
                  <option v-for="opt in PROTOCOL_OPTIONS" :key="opt.value" :value="opt.value">
                    {{ opt.label }}
                  </option>
                </select>
                <p class="text-xs text-base-content/40 mt-1">
                  选择 API 协议类型，决定如何与服务商通信
                </p>
              </div>

              <!-- MiMo 接入模式 -->
              <template v-if="isMimoProviderSelected">
                <div class="form-control">
                  <label class="label py-1">
                    <span class="label-text font-medium text-sm">接入模式</span>
                  </label>
                  <select
                    v-model="mimoOptions.accessMode"
                    class="select select-bordered w-full text-sm"
                  >
                    <option value="api">普通 API（按量计费）</option>
                    <option value="token_plan">Token Plan 订阅</option>
                  </select>
                  <p class="text-xs text-base-content/40 mt-1">
                    普通 API 使用 <span class="font-mono">{{ MIMO_API_BASE }}</span>；
                    Token Plan 按集群自动切换 Base URL。
                  </p>
                </div>

                <div v-if="isMimoTokenPlanMode" class="form-control">
                  <label class="label py-1">
                    <span class="label-text font-medium text-sm">Token Plan 集群</span>
                  </label>
                  <select
                    v-model="mimoOptions.tokenPlanCluster"
                    class="select select-bordered w-full text-sm"
                  >
                    <option value="cn">中国</option>
                    <option value="sgp">新加坡</option>
                    <option value="ams">欧洲</option>
                  </select>
                </div>
              </template>

              <!-- Bailian 地域 -->
              <template v-if="isBailianProviderSelected">
                <div class="form-control">
                  <label class="label py-1">
                    <span class="label-text font-medium text-sm">API 地域</span>
                  </label>
                  <select
                    v-model="bailianOptions.region"
                    class="select select-bordered w-full text-sm"
                  >
                    <option
                      v-for="(label, key) in BAILIAN_REGION_LABELS"
                      :key="key"
                      :value="key"
                    >
                      {{ label }}
                    </option>
                  </select>
                  <p class="text-xs text-base-content/40 mt-1">
                    默认北京：<span class="font-mono">{{ BAILIAN_API_BASE_CN }}</span>。
                    各地域 API Key 不通用，须与控制台所选地域一致。
                  </p>
                </div>
              </template>

              <!-- API Key -->
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text font-medium text-sm">API Key</span>
                  <span v-if="testResult[selectedType] === 'success'" class="label-text-alt text-success text-xs flex items-center gap-1">
                    <font-awesome-icon icon="check-circle" class="w-3 h-3" /> 验证通过
                  </span>
                  <span v-else-if="testResult[selectedType] === 'fail'" class="label-text-alt text-error text-xs flex items-center gap-1">
                    <font-awesome-icon icon="exclamation-circle" class="w-3 h-3" /> 验证失败
                  </span>
                </label>
                <div class="join w-full">
                  <input
                    :value="selectedConfig.api_key"
                    :type="showKey[selectedType] ? 'text' : 'password'"
                    :placeholder="`输入 ${selectedProvider.label} 的 API Key`"
                    class="input input-bordered join-item flex-1 text-sm font-mono rounded-l-lg"
                    @input="(e: Event) => { selectedConfig!.api_key = (e.target as HTMLInputElement).value }"
                  />
                  <button
                    type="button"
                    class="btn btn-outline btn-neutral join-item"
                    @click="showKey[selectedType] = !showKey[selectedType]"
                  >
                    <font-awesome-icon :icon="showKey[selectedType] ? 'eye-slash' : 'eye'" class="w-4 h-4" />
                  </button>
                </div>
                <p v-if="isMimoApiMode" class="text-xs text-base-content/40 mt-2 leading-relaxed">
                  普通 API 使用 <span class="font-mono">sk-</span> 前缀 Key，鉴权头为 <span class="font-mono">api-key</span>。
                </p>
                <p v-else-if="isMimoTokenPlanMode" class="text-xs text-base-content/40 mt-2 leading-relaxed">
                  Token Plan 使用 <span class="font-mono">tp-</span> 前缀 Key，与按量 Key 不可混用。详见
                  <a
                    href="https://platform.xiaomimimo.com/docs/zh-CN/price/tokenplan/quick-access"
                    class="link link-primary"
                    target="_blank"
                    rel="noopener noreferrer"
                  >MiMo 快速接入</a>。
                </p>
                <p v-else-if="isBailianProviderSelected" class="text-xs text-base-content/40 mt-2 leading-relaxed">
                  使用百炼控制台创建的 API Key（<span class="font-mono">sk-</span> 前缀），鉴权方式为
                  <span class="font-mono">Authorization: Bearer</span>。在
                  <a
                    href="https://bailian.console.aliyun.com/cn-beijing?tab=api#/api"
                    class="link link-primary"
                    target="_blank"
                    rel="noopener noreferrer"
                  >百炼控制台</a>
                  获取 Key 并确认所属地域。
                </p>
              </div>

              <!-- API Base URL -->
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text font-medium text-sm">API Base URL</span>
                  <span v-if="isGeminiProtocol" class="label-text-alt text-xs text-base-content/40">自动管理</span>
                </label>
                <input
                  v-if="!isGeminiProtocol"
                  :value="selectedConfig.api_base"
                  class="input input-bordered w-full text-sm rounded-lg"
                  :placeholder="selectedProvider.defaultBase"
                  @input="(e: Event) => { selectedConfig!.api_base = (e.target as HTMLInputElement).value }"
                />
                <input
                  v-else
                  value="https://generativelanguage.googleapis.com/v1beta"
                  class="input input-bordered w-full text-sm opacity-40 cursor-not-allowed rounded-lg"
                  readonly
                />
                <p v-if="isMimoProviderSelected" class="text-xs text-base-content/40 mt-2 leading-relaxed">
                  根据接入模式自动填充，可手动修改；切换模式或集群时会重新同步。
                </p>
                <p v-else-if="isBailianProviderSelected" class="text-xs text-base-content/40 mt-2 leading-relaxed">
                  切换地域时自动同步 Base URL；业务空间专属地址（法兰克福/新加坡）可手动填写。
                </p>
              </div>

              <!-- 默认模型 -->
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text font-medium text-sm">默认模型</span>
                  <span v-if="hasPersistedCatalog" class="label-text-alt text-success text-xs flex items-center gap-1">
                    <font-awesome-icon icon="check-circle" class="w-3 h-3" />
                    已保存 {{ availableModels[selectedType]?.length ?? 0 }} 个模型
                  </span>
                  <span v-else class="label-text-alt text-base-content/40 text-xs">
                    请先刷新模型列表
                  </span>
                </label>
                <SearchableModelSelect
                  v-if="hasPersistedCatalog"
                  :model-value="selectedConfig.model_name ?? ''"
                  :options="currentModelOptions"
                  placeholder="搜索或选择默认模型…"
                  @update:model-value="(v) => { selectedConfig!.model_name = v }"
                />
                <input
                  v-else
                  v-model="selectedConfig.model_name"
                  class="input input-bordered w-full text-sm font-mono rounded-lg"
                  placeholder="手动输入模型 ID，或点击「刷新模型」获取列表"
                />
              </div>

              <!-- 最大上下文 Token -->
              <div class="form-control">
                <label class="label py-1">
                  <span class="label-text font-medium text-sm">最大上下文 Token</span>
                  <span class="label-text-alt text-base-content/60 font-mono text-sm">
                    {{ selectedConfig.max_context_tokens.toLocaleString() }}
                  </span>
                </label>
                <input
                  v-model.number="selectedConfig.max_context_tokens"
                  type="number"
                  min="4096"
                  max="2000000"
                  step="1024"
                  class="input input-bordered w-full text-sm font-mono rounded-lg"
                  placeholder="256000"
                />
                <p class="text-xs text-base-content/40 mt-2">
                  当前模型可接受的最大上下文长度；正文生成时的 Token 预算与超限预警均基于此值（默认 256,000）
                </p>
              </div>

              <!-- DeepSeek 思考模式 -->
              <template v-if="isDeepSeekProvider">
                <div class="border-t border-base-300/60 pt-4 space-y-4">
                  <h5 class="text-xs font-bold text-base-content/60 uppercase tracking-wider">
                    DeepSeek 思考模式
                  </h5>

                  <label class="flex items-center justify-between gap-3 cursor-pointer">
                    <div>
                      <span class="text-sm font-medium">启用思考模式</span>
                      <p class="text-xs text-base-content/40 mt-0.5">
                        模型在输出最终回答前先进行推理，提升答案准确性
                      </p>
                    </div>
                    <input
                      v-model="deepseekOptions.thinkingEnabled"
                      type="checkbox"
                      class="toggle toggle-primary toggle-sm"
                    />
                  </label>

                  <div v-if="deepseekOptions.thinkingEnabled" class="form-control">
                    <label class="label py-1">
                      <span class="label-text font-medium text-sm">思考强度</span>
                    </label>
                    <select
                      v-model="deepseekOptions.reasoningEffort"
                      class="select select-bordered w-full text-sm"
                    >
                      <option value="high">High — 标准推理深度（默认）</option>
                      <option value="max">Max — 最大推理深度，适合复杂任务</option>
                    </select>
                    <p class="text-xs text-base-content/40 mt-1">
                      思考模式开启时，温度、Top P、频率/存在惩罚参数不生效
                    </p>
                  </div>
                </div>
              </template>

              <div class="flex flex-wrap items-center gap-2 pt-2">
                <button
                  type="button"
                  class="btn btn-outline btn-neutral btn-sm gap-2"
                  :disabled="testing === selectedType"
                  @click="testConnection"
                >
                  <font-awesome-icon :icon="testing === selectedType ? 'spinner' : 'wifi'" :spin="testing === selectedType" class="w-3.5 h-3.5" />
                  {{ testing === selectedType ? '测试中...' : '测试连接' }}
                </button>
                <button
                  type="button"
                  class="btn btn-primary btn-sm gap-2"
                  :disabled="refreshing === selectedType"
                  @click="refreshModels"
                >
                  <font-awesome-icon :icon="refreshing === selectedType ? 'spinner' : 'rotate'" :spin="refreshing === selectedType" class="w-3.5 h-3.5" />
                  {{ refreshing === selectedType ? '刷新中...' : '刷新模型' }}
                </button>
              </div>
            </div>
          </div>

          <!-- 高级配置 -->
          <div class="card bg-base-100 shadow-sm border border-base-300/60">
            <div class="card-body p-5 space-y-6">
              <h4 class="text-sm font-bold text-base-content/60 uppercase tracking-wider border-b border-base-300/60 pb-3">
                高级配置
              </h4>

              <div class="param-item">
                <span class="param-label">温度</span>
                <div class="param-slider-row">
                  <input
                    v-model.number="temperature"
                    type="range"
                    :min="GENERATION_PARAM_BOUNDS.temperature.min"
                    :max="GENERATION_PARAM_BOUNDS.temperature.max"
                    :step="GENERATION_PARAM_BOUNDS.temperature.step"
                    class="themed-range"
                  />
                  <input
                    v-model.number="temperature"
                    type="number"
                    class="input input-bordered input-sm param-number-input"
                    :min="GENERATION_PARAM_BOUNDS.temperature.min"
                    :max="GENERATION_PARAM_BOUNDS.temperature.max"
                    :step="GENERATION_PARAM_BOUNDS.temperature.step"
                    @blur="clampGenerationParam('temperature')"
                  />
                </div>
                <p class="param-desc">
                  仅用于智能助手、文风生成、AI 实验室等非作品创作场景。作品编辑器内的 AI 请在「创作温度」中按场景配置区间。
                  （如 Kimi K2 需设为 1）
                </p>
              </div>

              <div class="param-item">
                <span class="param-label">最大生成令牌数 (Max Tokens)</span>
                <div class="param-slider-row">
                  <input
                    v-model.number="maxTokens"
                    type="range"
                    min="512"
                    max="32768"
                    step="256"
                    class="themed-range"
                  />
                  <input
                    v-model.number="maxTokens"
                    type="number"
                    class="input input-bordered input-sm param-number-input param-number-input-wide"
                    :min="GENERATION_PARAM_BOUNDS.maxTokens.min"
                    :max="GENERATION_PARAM_BOUNDS.maxTokens.max"
                    :step="GENERATION_PARAM_BOUNDS.maxTokens.step"
                    @blur="clampGenerationParam('maxTokens')"
                  />
                </div>
                <p class="param-desc">限制 AI 单次回复的最大长度；滑块上限 32768，可手动输入更大值（最高 200000）</p>
              </div>

              <div class="param-item">
                <span class="param-label">频率惩罚 (Frequency Penalty)</span>
                <div class="param-slider-row">
                  <input
                    v-model.number="frequencyPenalty"
                    type="range"
                    :min="GENERATION_PARAM_BOUNDS.frequencyPenalty.min"
                    :max="GENERATION_PARAM_BOUNDS.frequencyPenalty.max"
                    step="0.05"
                    class="themed-range"
                  />
                  <input
                    v-model.number="frequencyPenalty"
                    type="number"
                    class="input input-bordered input-sm param-number-input"
                    :min="GENERATION_PARAM_BOUNDS.frequencyPenalty.min"
                    :max="GENERATION_PARAM_BOUNDS.frequencyPenalty.max"
                    :step="GENERATION_PARAM_BOUNDS.frequencyPenalty.step"
                    @blur="clampGenerationParam('frequencyPenalty')"
                  />
                </div>
                <p class="param-desc">惩罚已出现 token 的重复使用，增大可提升词汇多样性</p>
              </div>

              <div class="param-item">
                <span class="param-label">存在惩罚 (Presence Penalty)</span>
                <div class="param-slider-row">
                  <input
                    v-model.number="presencePenalty"
                    type="range"
                    :min="GENERATION_PARAM_BOUNDS.presencePenalty.min"
                    :max="GENERATION_PARAM_BOUNDS.presencePenalty.max"
                    step="0.05"
                    class="themed-range"
                  />
                  <input
                    v-model.number="presencePenalty"
                    type="number"
                    class="input input-bordered input-sm param-number-input"
                    :min="GENERATION_PARAM_BOUNDS.presencePenalty.min"
                    :max="GENERATION_PARAM_BOUNDS.presencePenalty.max"
                    :step="GENERATION_PARAM_BOUNDS.presencePenalty.step"
                    @blur="clampGenerationParam('presencePenalty')"
                  />
                </div>
                <p class="param-desc">惩罚任何已出现过的 token，鼓励引入新话题和表达</p>
              </div>

              <div class="param-item">
                <span class="param-label">核采样 (Top P)</span>
                <div class="param-slider-row">
                  <input
                    v-model.number="topP"
                    type="range"
                    :min="GENERATION_PARAM_BOUNDS.topP.min"
                    :max="GENERATION_PARAM_BOUNDS.topP.max"
                    :step="GENERATION_PARAM_BOUNDS.topP.step"
                    class="themed-range"
                  />
                  <input
                    v-model.number="topP"
                    type="number"
                    class="input input-bordered input-sm param-number-input"
                    :min="GENERATION_PARAM_BOUNDS.topP.min"
                    :max="GENERATION_PARAM_BOUNDS.topP.max"
                    :step="GENERATION_PARAM_BOUNDS.topP.step"
                    @blur="clampGenerationParam('topP')"
                  />
                </div>
                <p class="param-desc">只从累积概率前 Top P 的 token 中采样，配合温度使用</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <VolcengineImageSettings class="mt-6" @toast="(type, message) => showToast(type, message)" />

    <!-- 步骤模型分配 -->
    <div class="card bg-base-100 shadow-sm border border-base-300/60 mt-6">
      <div
        class="card-body p-5 cursor-pointer select-none"
        :class="{ 'pb-2': stepModelExpanded }"
        @click="stepModelExpanded = !stepModelExpanded"
      >
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center text-accent shrink-0">
            <font-awesome-icon icon="sliders" class="text-base" />
          </div>
          <div class="flex-1 min-w-0">
            <h4 class="font-semibold">步骤模型分配</h4>
            <p class="text-xs text-base-content/50">为不同创作步骤指定独立的 AI 模型，未配置的步骤自动使用全局默认</p>
          </div>
          <font-awesome-icon
            :icon="stepModelExpanded ? 'chevron-up' : 'chevron-down'"
            class="w-4 h-4 text-base-content/40 shrink-0"
          />
        </div>
      </div>
      <div v-if="stepModelExpanded" class="px-5 pb-5">
        <StepModelOverridesEditor />
      </div>
    </div>

    <!-- 添加自定义提供商弹窗 -->
    <dialog :class="['modal', { 'modal-open': showAddModal }]">
      <div class="modal-box">
        <h3 class="font-bold text-lg mb-4">添加自定义提供商</h3>
        <div class="space-y-4">
          <div class="form-control">
            <label class="label py-1">
              <span class="label-text font-medium">显示名称</span>
            </label>
            <input
              v-model="newProviderName"
              class="input input-bordered w-full"
              placeholder="例如：OpenRouter、硅基流动"
              @keyup.enter="addCustomProvider"
            />
          </div>
          <div class="form-control">
            <label class="label py-1">
              <span class="label-text font-medium">API 协议</span>
            </label>
            <select v-model="newProviderProtocol" class="select select-bordered w-full">
              <option v-for="opt in PROTOCOL_OPTIONS" :key="opt.value" :value="opt.value">
                {{ opt.label }}
              </option>
            </select>
            <p class="text-xs text-base-content/40 mt-2">
              OpenAI 兼容适用于 DeepSeek、OpenRouter 等；Gemini 和 Anthropic 需选择对应协议
            </p>
          </div>
        </div>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost" @click="showAddModal = false">取消</button>
          <button type="button" class="btn btn-primary" @click="addCustomProvider">添加</button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button type="button" @click="showAddModal = false">close</button>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.param-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.param-label {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-base-content, #1f2937);
}

.param-slider-row {
  display: flex;
  align-items: center;
  gap: 16px;
}

.param-slider-row .themed-range {
  flex: 1;
  min-width: 0;
}

.param-number-input {
  flex-shrink: 0;
  width: 4.75rem;
  padding-left: 0.5rem;
  padding-right: 0.5rem;
  text-align: right;
  font-family: ui-monospace, 'JetBrains Mono', 'Fira Code', monospace;
}

.param-number-input-wide {
  width: 6.25rem;
}

.param-desc {
  font-size: 0.75rem;
  line-height: 1.5;
  color: color-mix(in oklab, var(--color-base-content, #6b7280) 40%, transparent);
}

.themed-range {
  -webkit-appearance: none;
  appearance: none;
  height: 8px;
  border-radius: 4px;
  background: var(--color-base-300, #e5e7eb);
  outline: none;
  cursor: pointer;
}

.themed-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-base-100, #fff);
  border: 3px solid var(--color-primary, #6366f1);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  cursor: pointer;
}

.themed-range::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-base-100, #fff);
  border: 3px solid var(--color-primary, #6366f1);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  cursor: pointer;
}

.themed-range::-moz-range-track {
  height: 8px;
  border-radius: 4px;
  background: var(--color-base-300, #e5e7eb);
}
</style>
