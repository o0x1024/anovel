<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import GeneralSettingsPanel from './GeneralSettingsPanel.vue'
import BackupSettingsPanel from './BackupSettingsPanel.vue'
import PromptTemplatesPanel from './PromptTemplatesPanel.vue'

interface ModelConfig {
  model_type: string
  model_name: string | null
  api_key: string | null
  api_base: string | null
  is_enabled: number
  priority: number
  max_context_tokens: number
  available_models_json?: string | null
}

interface Toast {
  id: number
  type: 'success' | 'error' | 'info'
  message: string
}

interface ProviderMeta {
  type: string
  label: string
  description: string
  defaultBase: string
  defaultModel: string
  icon: string
  color: string
}

const categories = [
  { id: 'ai', label: 'AI 服务', icon: 'robot' },
  { id: 'prompts', label: 'Prompt 模板', icon: 'file-lines' },
  { id: 'general', label: '常规设置', icon: 'desktop' },
  { id: 'backup', label: '数据备份', icon: 'database' }
] as const

type CategoryId = (typeof categories)[number]['id']

const ALL_PROVIDERS: ProviderMeta[] = [
  {
    type: 'deepseek',
    label: 'DeepSeek',
    description: '深度求索大语言模型，中文能力强',
    defaultBase: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    icon: 'brain',
    color: 'text-primary'
  },
  {
    type: 'gemini',
    label: 'Google Gemini',
    description: 'Google 多模态大模型，支持长上下文',
    defaultBase: 'https://generativelanguage.googleapis.com',
    defaultModel: 'gemini-1.5-pro',
    icon: 'gem',
    color: 'text-secondary'
  },
  {
    type: 'openai',
    label: 'OpenAI',
    description: 'OpenAI 及所有兼容接口（第三方中转等）',
    defaultBase: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    icon: 'robot',
    color: 'text-accent'
  }
]

const configs = ref<ModelConfig[]>(
  ALL_PROVIDERS.map((p, i) => ({
    model_type: p.type,
    model_name: p.defaultModel,
    api_key: '',
    api_base: p.defaultBase,
    is_enabled: 0,
    priority: i + 1,
    max_context_tokens: 256000
  }))
)

const activeCategory = ref<CategoryId>('ai')
const loading = ref(true)
const ready = ref(false)
const testing = ref<string | null>(null)
const refreshing = ref<string | null>(null)
const testResult = ref<Record<string, 'success' | 'fail' | null>>({})
const showKey = ref<Record<string, boolean>>({})
const availableModels = ref<Record<string, string[]>>({})
const toasts = ref<Toast[]>([])
let toastId = 0
let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
let globalDefaultSaveTimer: ReturnType<typeof setTimeout> | null = null

const selectedType = ref('deepseek')
const selectedConfig = computed(() => configs.value.find(c => c.model_type === selectedType.value)!)
const selectedProvider = computed(() => ALL_PROVIDERS.find(p => p.type === selectedType.value)!)

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
  const fallback = ALL_PROVIDERS.find(p => p.type === type)?.defaultModel
  return fallback ? [fallback] : []
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

const temperature = ref(0.92)
const maxTokens = ref(5250)
const frequencyPenalty = ref(0.35)
const presencePenalty = ref(0.3)
const topP = ref(0.9)

onMounted(async () => {
  await loadConfigs()
  await loadGlobalDefault()
  await loadGenerationParams()
  ready.value = true
})

let genParamsSaveTimer: ReturnType<typeof setTimeout> | null = null

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

function showToast(type: Toast['type'], message: string) {
  const id = ++toastId
  toasts.value.push({ id, type, message })
  setTimeout(() => { toasts.value = toasts.value.filter(t => t.id !== id) }, 3000)
}

function toastAlertClass(type: Toast['type']): string {
  if (type === 'success') return 'alert-success'
  if (type === 'error') return 'alert-error'
  return 'alert-info'
}

async function loadConfigs() {
  loading.value = true
  try {
    const rows = await window.anovel.invoke('model:list') as ModelConfig[]
    for (const row of rows) {
      const idx = configs.value.findIndex(c => c.model_type === row.model_type)
      const catalog = parseCatalogJson(row.available_models_json)
      if (catalog.length) {
        availableModels.value = { ...availableModels.value, [row.model_type]: catalog }
      }
      if (idx !== -1) {
        configs.value[idx] = {
          ...configs.value[idx],
          api_key: row.api_key ?? '',
          api_base: row.api_base ?? configs.value[idx].api_base,
          model_name: row.model_name ?? configs.value[idx].model_name,
          is_enabled: row.is_enabled,
          priority: row.priority,
          max_context_tokens: row.max_context_tokens ?? 256000
        }
      }
    }
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
      await window.anovel.invoke('model:upsert', config.model_type, config.api_key || '', config.api_base || '', config.model_name || '')
      await window.anovel.invoke('model:setEnabled', config.model_type, config.is_enabled === 1)
      await window.anovel.invoke('model:setMaxContextTokens', config.model_type, config.max_context_tokens)
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
  testing.value = config.model_type
  testResult.value[config.model_type] = null
  try {
    let ok = false
    if (config.model_type === 'gemini') {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${config.api_key}`)
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
      }
      ok = true
    } else {
      const response = await fetch(`${config.api_base}/models`, {
        headers: { 'Authorization': `Bearer ${config.api_key}` }
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      ok = true
    }
    if (ok) {
      testResult.value[config.model_type] = 'success'
      showToast('success', `${selectedProvider.value.label} 连接成功！`)
    }
  } catch (e: unknown) {
    testResult.value[config.model_type] = 'fail'
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
  return ALL_PROVIDERS.find(p => p.type === type)?.label ?? type
}
</script>

<template>
  <div class="settings-page p-8 animate-fade-in">
    <!-- Toast -->
    <div class="toast toast-bottom toast-end z-50">
      <transition-group name="toast">
        <div
          v-for="t in toasts"
          :key="t.id"
          :class="['alert shadow-lg text-sm min-w-64', toastAlertClass(t.type)]"
        >
          <font-awesome-icon
            :icon="t.type === 'success' ? 'check-circle' : t.type === 'error' ? 'exclamation-circle' : 'info-circle'"
            class="w-4 h-4 shrink-0"
          />
          <span>{{ t.message }}</span>
        </div>
      </transition-group>
    </div>

    <!-- 页面标题 -->
    <div class="flex items-center justify-between mb-6 pb-4 border-b border-base-300/60">
      <div>
        <h2 class="text-2xl font-extrabold tracking-tight">系统设置</h2>
        <p class="text-sm text-base-content/50 mt-1">配置界面外观与 AI 服务，所有数据仅保存在本地</p>
      </div>
    </div>

    <!-- 左右布局 -->
    <div class="settings-layout flex gap-3">
      <!-- 左侧分类导航 -->
      <aside class="settings-sidebar shrink-0 w-44">
        <ul class="menu menu-sm bg-base-200 rounded-box p-2 sticky top-6 border border-base-300/60 w-full">
          <li v-for="category in categories" :key="category.id">
            <button
              type="button"
              :class="{ 'menu-active': activeCategory === category.id }"
              @click="activeCategory = category.id"
            >
              <font-awesome-icon :icon="category.icon" class="w-4 h-4" />
              {{ category.label }}
            </button>
          </li>
        </ul>
      </aside>

      <!-- 右侧内容 -->
      <div class="settings-content flex-1 min-w-0">
        <!-- 常规设置 -->
        <GeneralSettingsPanel v-if="activeCategory === 'general'" />

        <BackupSettingsPanel v-else-if="activeCategory === 'backup'" />

        <!-- Prompt 模板 -->
        <PromptTemplatesPanel v-else-if="activeCategory === 'prompts'" />

        <!-- AI 服务 -->
        <div v-else-if="activeCategory === 'ai'">
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
                  <select
                    v-model="globalDefaultProvider"
                    class="select select-bordered w-full text-sm"
                  >
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
                  <select
                    v-model="globalDefaultModel"
                    class="select select-bordered w-full text-sm font-mono"
                    :disabled="!globalDefaultProvider"
                  >
                    <option v-if="!globalDefaultProvider" value="" disabled>请先选择提供商</option>
                    <option v-for="opt in globalModelOptions" :key="opt" :value="opt">
                      {{ opt }}
                    </option>
                  </select>
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
              <h4 class="text-sm font-bold text-base-content/60 uppercase tracking-wider mb-3">AI 提供商</h4>
              <ul v-if="loading" class="flex justify-center py-8">
                <span class="loading loading-spinner loading-sm text-primary"></span>
              </ul>
              <ul v-else class="menu menu-sm bg-base-200 rounded-box p-2 border border-base-300/60 w-full">
                <li v-for="provider in ALL_PROVIDERS" :key="provider.type">
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
            <div v-if="!loading && selectedConfig" class="flex-1 min-w-0 space-y-6">
              <!-- 头部 -->
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
                    <label class="flex items-center gap-2 cursor-pointer shrink-0">
                      <span class="text-sm text-base-content/60">启用</span>
                      <input
                        type="checkbox"
                        :checked="selectedConfig.is_enabled === 1"
                        class="toggle toggle-primary toggle-sm"
                        @change="(e: Event) => { selectedConfig.is_enabled = (e.target as HTMLInputElement).checked ? 1 : 0 }"
                      />
                    </label>
                  </div>
                </div>
              </div>

              <!-- 基本配置 + 状态 -->
              <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <div class="card bg-base-100 shadow-sm border border-base-300/60">
                  <div class="card-body p-5 space-y-4">
                    <h4 class="text-sm font-bold text-base-content/60 uppercase tracking-wider border-b border-base-300/60 pb-3">
                      基本配置
                    </h4>

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
                          @input="(e: Event) => { selectedConfig.api_key = (e.target as HTMLInputElement).value }"
                        />
                        <button
                          type="button"
                          class="btn btn-outline btn-neutral join-item"
                          @click="showKey[selectedType] = !showKey[selectedType]"
                        >
                          <font-awesome-icon :icon="showKey[selectedType] ? 'eye-slash' : 'eye'" class="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    <!-- API Base URL -->
                    <div class="form-control">
                      <label class="label py-1">
                        <span class="label-text font-medium text-sm">API Base URL</span>
                        <span v-if="selectedType === 'gemini'" class="label-text-alt text-xs text-base-content/40">自动管理</span>
                      </label>
                      <input
                        v-if="selectedType !== 'gemini'"
                        :value="selectedConfig.api_base"
                        class="input input-bordered w-full text-sm rounded-lg"
                        :placeholder="selectedProvider.defaultBase"
                        @input="(e: Event) => { selectedConfig.api_base = (e.target as HTMLInputElement).value }"
                      />
                      <input
                        v-else
                        value="https://generativelanguage.googleapis.com/v1beta"
                        class="input input-bordered w-full text-sm opacity-40 cursor-not-allowed rounded-lg"
                        readonly
                      />
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
                      <select
                        v-if="hasPersistedCatalog"
                        v-model="selectedConfig.model_name"
                        class="select select-bordered w-full text-sm font-mono"
                      >
                        <option
                          v-for="opt in currentModelOptions"
                          :key="opt"
                          :value="opt"
                        >
                          {{ opt }}
                        </option>
                      </select>
                      <input
                        v-else
                        v-model="selectedConfig.model_name"
                        class="input input-bordered w-full text-sm font-mono rounded-lg"
                        :placeholder="`手动输入模型 ID，或点击「刷新模型」获取列表`"
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

                    <!-- 操作按钮 -->
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
                        <input v-model.number="temperature" type="range" min="0" max="2" step="0.01" class="themed-range" />
                        <span class="param-value">{{ temperature.toFixed(1) }}</span>
                      </div>
                      <p class="param-desc">较低的值使输出更加确定性，较高的值使输出更加随机和创造性</p>
                    </div>

                    <div class="param-item">
                      <span class="param-label">最大生成令牌数 (Max Tokens) (Max Generation)</span>
                      <div class="param-slider-row">
                        <input v-model.number="maxTokens" type="range" min="512" max="32768" step="256" class="themed-range" />
                        <span class="param-value">{{ maxTokens.toLocaleString() }}</span>
                      </div>
                      <p class="param-desc">限制AI单次回复的最大长度，不影响上下文总容量</p>
                    </div>

                    <div class="param-item">
                      <span class="param-label">频率惩罚 (Frequency Penalty)</span>
                      <div class="param-slider-row">
                        <input v-model.number="frequencyPenalty" type="range" min="-2" max="2" step="0.05" class="themed-range" />
                        <span class="param-value">{{ frequencyPenalty.toFixed(2) }}</span>
                      </div>
                      <p class="param-desc">惩罚已出现 token 的重复使用，增大可提升词汇多样性</p>
                    </div>

                    <div class="param-item">
                      <span class="param-label">存在惩罚 (Presence Penalty)</span>
                      <div class="param-slider-row">
                        <input v-model.number="presencePenalty" type="range" min="-2" max="2" step="0.05" class="themed-range" />
                        <span class="param-value">{{ presencePenalty.toFixed(2) }}</span>
                      </div>
                      <p class="param-desc">惩罚任何已出现过的 token，鼓励引入新话题和表达</p>
                    </div>

                    <div class="param-item">
                      <span class="param-label">核采样 (Top P)</span>
                      <div class="param-slider-row">
                        <input v-model.number="topP" type="range" min="0" max="1" step="0.01" class="themed-range" />
                        <span class="param-value">{{ topP.toFixed(2) }}</span>
                      </div>
                      <p class="param-desc">只从累积概率前 Top P 的 token 中采样，配合温度使用</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>

        <!-- 底部信息 -->
        <div class="mt-8 pt-6 border-t border-base-300/60">
          <div class="flex items-center gap-2 text-base-content/30 text-xs">
            <font-awesome-icon icon="info-circle" class="w-3.5 h-3.5" />
            <span>
              <strong class="text-base-content/50">ANovel</strong> v2.5.0 · 所有创作数据均存储在本地，不会上传到任何服务器
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings-layout {
  min-height: calc(100vh - 220px);
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(1rem);
}

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

.param-value {
  flex-shrink: 0;
  min-width: 48px;
  text-align: right;
  font-size: 0.875rem;
  font-family: ui-monospace, 'JetBrains Mono', 'Fira Code', monospace;
  color: color-mix(in oklab, var(--color-base-content, #1f2937) 60%, transparent);
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
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.themed-range::-webkit-slider-thumb:hover {
  transform: scale(1.1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.themed-range::-moz-range-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--color-base-100, #fff);
  border: 3px solid var(--color-primary, #6366f1);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.themed-range::-moz-range-thumb:hover {
  transform: scale(1.1);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.themed-range::-moz-range-track {
  height: 8px;
  border-radius: 4px;
  background: var(--color-base-300, #e5e7eb);
}

@media (max-width: 1024px) {
  .settings-layout {
    @apply flex-col;
  }

  .settings-sidebar {
    @apply w-full;
  }

  .settings-sidebar .menu {
    @apply static flex flex-row overflow-x-auto;
  }

  .settings-sidebar .menu li {
    @apply shrink-0;
  }
}
</style>
