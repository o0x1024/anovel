<script setup lang="ts">
import { ref, computed, onMounted, watch, inject } from 'vue'
import type { ModelChatResult } from './useModelChat'
import PanelTitle from '../../components/PanelTitle.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import FavoriteButton from '../../components/FavoriteButton.vue'
import AiInterventionBar from './AiInterventionBar.vue'
import AiSelfCheckPanel from './AiSelfCheckPanel.vue'
import StepNavFooter from './StepNavFooter.vue'
import { editorNavKey } from './editor-nav'

const props = defineProps<{ workId: number }>()
const nav = inject(editorNavKey)

const analyses = [
  {
    key: 'diagnose',
    label: '诊断方向',
    step: 'incubator_diagnose',
    system: '分析以下故事方向：核心吸引力是什么？市场同类作品有哪些？差异化在哪里？潜在问题？'
  },
  {
    key: 'variants',
    label: '变体探索',
    step: 'incubator_variants',
    system: [
      '基于故事方向，生成 6 个不同维度的变体（如性别互换、时代背景、视角切换、冲突类型改变等）。',
      '只输出一个 JSON 对象，禁止 Markdown 正文、标题、解释或代码块外的任何文字。',
      'variants 数组每项为一变体；不要把「变体维度」「变体探索」等标签当作 title。',
      '每变体 summary 约 80-120 字；dimension 写变体维度名称。',
      '示例：{"variants":[{"title":"古代志怪版","dimension":"时代背景改变","summary":"…"}]}'
    ].join('\n')
  },
  {
    key: 'reverse',
    label: '倒推大纲',
    step: 'incubator_reverse',
    system: '将以下故事方向用倒推法展开：先锚定高潮/结局，然后反向推导关键转折→铺垫→开局，生成倒推大纲树'
  },
  {
    key: 'anchors',
    label: '提炼锚点',
    step: 'incubator_anchors',
    system: '分析以下故事方向，提炼出5-8个核心锚点（场景/角色/情节/情感），每个锚点一句话描述，不可更改的核心要素。请用列表输出，格式：- [类型] 标题：描述'
  },
  {
    key: 'expand',
    label: '方向扩写',
    step: 'incubator_expand',
    system: [
      '基于故事方向，生成 3 个不同方向的扩写版本。',
      '只输出一个 JSON 对象，禁止 Markdown 正文、标题、解释或代码块外的任何文字。',
      'versions 数组每项为一版本；不要把「核心亮点」「受众定位」等标签当作 title。',
      '每版 summary 约 150-250 字；highlights 写核心亮点；audience 写受众定位。',
      '示例：{"versions":[{"title":"版本名","summary":"扩写摘要","highlights":"亮点","audience":"受众"}]}'
    ].join('\n')
  },
  {
    key: 'benchmark',
    label: '对标分析',
    step: 'incubator_benchmark',
    system: '分析以下故事方向：列出3-5部对标作品（书名/类型/相似点/差异点），分析市场定位与差异化策略，给出可借鉴与应避开的要素。'
  },
  {
    key: 'tone',
    label: '情感基调',
    step: 'incubator_tone',
    system: '分析以下故事方向的情感基调：用5-8个标签描述整体情感氛围（如「压抑」「热血」「治愈」），说明基调如何随情节变化，并给出写作时应注意的情感节奏建议。'
  },
  {
    key: 'frontstory',
    label: '前台故事',
    step: 'incubator_frontstory',
    system: '分析以下故事方向的「前台故事」——读者打开正文30秒内能感知的核心冲突与追读动力。输出：## 前台钩子 / ## 读者期待 / ## 后台设定 / ## 开篇第一页建议 / ## 评分与改进'
  },
  {
    key: 'microinnovation',
    label: '微创新',
    step: 'incubator_microinnovation',
    system: '对以下故事方向做微创新分析（约90%成熟套路+10%差异化）。输出：## 可保留套路 / ## 创新点 / ## 金手指(能力+限制) / ## 创新比例 / ## 风险提示'
  }
] as const

type AnalysisKey = (typeof analyses)[number]['key']

const ideaInput = ref('')
const ideaSaveState = ref<'idle' | 'saving' | 'saved'>('idle')
const loadingByKey = ref<Partial<Record<AnalysisKey, boolean>>>({})
const resultsByKey = ref<Partial<Record<AnalysisKey, string>>>({})
const errorsByKey = ref<Partial<Record<AnalysisKey, string>>>({})
const activeTab = ref<AnalysisKey | null>(null)
const importingAnchors = ref(false)
const expansionVersions = ref<{ title: string; summary: string; highlights?: string; audience?: string }[]>([])
const variantItems = ref<{ title: string; dimension?: string; summary: string }[]>([])
const parseWarningsByKey = ref<Partial<Record<AnalysisKey, string>>>({})
const adoptingExpansion = ref(false)
const adoptingVariant = ref(false)

const visibleTabs = computed(() =>
  analyses.filter(item =>
    !!(resultsByKey.value[item.key] || errorsByKey.value[item.key] || loadingByKey.value[item.key])
  )
)

const activeAnalysis = computed(() =>
  analyses.find(item => item.key === activeTab.value) ?? null
)

let ideaSaveTimer: ReturnType<typeof setTimeout> | null = null

onMounted(loadIncubatorData)

async function loadIncubatorData() {
  const settings = await window.anovel.invoke('setting:listByWork', props.workId) as { type: string; content: string }[]
  const idea = settings.find(s => s.type === 'idea')
  if (idea) ideaInput.value = idea.content

  const loaded: Partial<Record<AnalysisKey, string>> = {}
  for (const item of analyses) {
    const row = settings.find(s => s.type === item.step)
    if (row?.content) loaded[item.key] = row.content
  }
  resultsByKey.value = loaded
  const firstKey = analyses.find(item => loaded[item.key])?.key
  if (firstKey) activeTab.value = firstKey
  if (loaded.expand) await refreshExpansionVersions(loaded.expand, true)
  if (loaded.variants) await refreshVariantItems(loaded.variants, true)
}

async function refreshVariantItems(content: string, legacyFallback = false) {
  variantItems.value = await window.anovel.invoke(
    'incubator:parseVariants',
    content,
    legacyFallback
  ) as typeof variantItems.value
  parseWarningsByKey.value = {
    ...parseWarningsByKey.value,
    variants: content.trim() && variantItems.value.length === 0
      ? (legacyFallback
        ? '未能解析变体（旧版 Markdown 格式可能已失效，请重新运行「变体探索」）'
        : '未能解析变体 JSON，请重新生成（需为 {"variants":[...]} 格式）')
      : ''
  }
}

async function refreshExpansionVersions(content: string, legacyFallback = false) {
  expansionVersions.value = await window.anovel.invoke(
    'incubator:parseExpansion',
    content,
    legacyFallback
  ) as typeof expansionVersions.value
  parseWarningsByKey.value = {
    ...parseWarningsByKey.value,
    expand: content.trim() && expansionVersions.value.length === 0
      ? '未能解析扩写 JSON，请重新运行「方向扩写」（需为 {"versions":[...]} 格式）'
      : ''
  }
}

watch(() => resultsByKey.value.expand, (content) => {
  if (content) void refreshExpansionVersions(content, false)
  else {
    expansionVersions.value = []
    parseWarningsByKey.value = { ...parseWarningsByKey.value, expand: '' }
  }
})

watch(() => resultsByKey.value.variants, (content) => {
  if (content) void refreshVariantItems(content, false)
  else {
    variantItems.value = []
    parseWarningsByKey.value = { ...parseWarningsByKey.value, variants: '' }
  }
})

watch(ideaInput, (value) => {
  if (ideaSaveTimer) clearTimeout(ideaSaveTimer)
  if (!value.trim()) return
  ideaSaveTimer = setTimeout(() => void persistIdea(value.trim()), 800)
})

async function persistIdea(content: string) {
  ideaSaveState.value = 'saving'
  await window.anovel.invoke('setting:upsert', props.workId, 'idea', content)
  ideaSaveState.value = 'saved'
  await nav?.refreshProgress()
  setTimeout(() => {
    if (ideaSaveState.value === 'saved') ideaSaveState.value = 'idle'
  }, 2000)
}

function isItemLoading(key: AnalysisKey) {
  return !!loadingByKey.value[key]
}

async function runAnalysis(item: (typeof analyses)[number]) {
  if (!ideaInput.value.trim() || isItemLoading(item.key)) return

  activeTab.value = item.key
  loadingByKey.value = { ...loadingByKey.value, [item.key]: true }
  errorsByKey.value = { ...errorsByKey.value, [item.key]: '' }

  try {
    const res = await window.anovel.invoke('model:chat', {
      prompt: ideaInput.value.trim(),
      systemPrompt: item.system,
      workId: props.workId,
      step: item.step,
      enrichWorkContext: false
    }) as ModelChatResult

    if (res.success) {
      resultsByKey.value = { ...resultsByKey.value, [item.key]: res.content }
      await window.anovel.invoke('setting:upsert', props.workId, item.step, res.content)
      if (item.key === 'expand') await refreshExpansionVersions(res.content, false)
      if (item.key === 'variants') await refreshVariantItems(res.content, false)
      await nav?.refreshProgress()
    } else {
      errorsByKey.value = { ...errorsByKey.value, [item.key]: res.error || '生成失败' }
    }
  } catch (e) {
    errorsByKey.value = { ...errorsByKey.value, [item.key]: String(e) }
  } finally {
    loadingByKey.value = { ...loadingByKey.value, [item.key]: false }
  }
}

async function importAnchorsToDb() {
  const content = resultsByKey.value.anchors
  if (!content || importingAnchors.value) return

  importingAnchors.value = true
  try {
    const parsed = await window.anovel.invoke('anchor:parseSuggestions', content) as {
      type: string
      title: string
      content: string
    }[]
    if (parsed.length === 0) {
      alert('未能从结果中解析出锚点，请检查 AI 输出格式或使用列表格式：- [场景] 标题：描述')
      return
    }
    await window.anovel.invoke('anchor:batchCreate', parsed.map(a => ({
      work_id: props.workId,
      type: a.type,
      title: a.title,
      content: a.content,
      created_step: 'incubator_anchors'
    })))
    alert(`已导入 ${parsed.length} 个锚点到锚点管理（默认启用）`)
  } finally {
    importingAnchors.value = false
  }
}

async function adoptVariant(variant: { title: string; dimension?: string; summary: string }) {
  adoptingVariant.value = true
  try {
    const text = [
      `【${variant.title}】`,
      variant.dimension ? `变体维度：${variant.dimension}` : '',
      variant.summary
    ].filter(Boolean).join('\n\n')
    ideaInput.value = text
    await persistIdea(text)
  } finally {
    adoptingVariant.value = false
  }
}

async function adoptExpansion(version: { title: string; summary: string; highlights?: string; audience?: string }) {
  adoptingExpansion.value = true
  try {
    const text = [
      `【${version.title}】`,
      version.summary,
      version.highlights ? `核心亮点：${version.highlights}` : '',
      version.audience ? `受众定位：${version.audience}` : ''
    ].filter(Boolean).join('\n\n')
    ideaInput.value = text
    await persistIdea(text)
  } finally {
    adoptingExpansion.value = false
  }
}

function updateActiveResult(content: string) {
  if (!activeAnalysis.value) return
  const key = activeAnalysis.value.key
  resultsByKey.value = { ...resultsByKey.value, [key]: content }
  void window.anovel.invoke('setting:upsert', props.workId, activeAnalysis.value.step, content)
  if (key === 'expand') void refreshExpansionVersions(content, false)
  if (key === 'variants') void refreshVariantItems(content, false)
}

function showMarkdownForActive(): boolean {
  if (!activeAnalysis.value) return false
  const key = activeAnalysis.value.key
  if (key === 'variants' && variantItems.value.length > 0) return false
  if (key === 'expand' && expansionVersions.value.length > 0) return false
  return true
}
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="lightbulb" title="大岗孵化器" />
    <p class="text-sm text-base-content/50 mb-6">输入初步想法，AI 帮你诊断、扩写、探索变体、倒推大纲、提炼锚点。想法会自动保存。</p>

    <div class="card bg-base-200 border border-base-300 shadow-sm p-4 mb-4">
      <textarea
        v-model="ideaInput"
        rows="6"
        class="textarea textarea-bordered w-full mb-2 resize-none"
        placeholder="描述你的故事方向、核心冲突、主角设定..."
      />
      <p class="text-xs text-base-content/40 mb-3 min-h-[1rem]">
        <span v-if="ideaSaveState === 'saving'">正在保存想法...</span>
        <span v-else-if="ideaSaveState === 'saved'" class="text-success">想法已保存</span>
        <span v-else-if="ideaInput.trim()">编辑后将自动保存</span>
      </p>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="item in analyses"
          :key="item.key"
          class="btn btn-outline btn-primary btn-sm"
          :disabled="!ideaInput.trim() || isItemLoading(item.key)"
          @click="runAnalysis(item)"
        >
          {{ isItemLoading(item.key) ? '分析中...' : item.label }}
        </button>
      </div>
    </div>

    <div v-if="visibleTabs.length">
      <div role="tablist" class="tabs tabs-box tabs-sm w-fit mb-4" aria-label="分析结果">
        <a
          v-for="item in visibleTabs"
          :key="item.key"
          role="tab"
          href="#"
          class="tab gap-1"
          :class="{ 'tab-active': activeTab === item.key }"
          :aria-selected="activeTab === item.key"
          @click.prevent="activeTab = item.key"
        >
          {{ item.label }}
          <span v-if="isItemLoading(item.key)" class="loading loading-spinner loading-xs"></span>
        </a>
      </div>

      <div class="card bg-base-200 border border-base-300 shadow-sm p-4">
        <template v-if="activeAnalysis">
          <div v-if="errorsByKey[activeAnalysis.key]" class="alert alert-error text-sm mb-4">
            {{ errorsByKey[activeAnalysis.key] }}
          </div>

          <div
            v-else-if="isItemLoading(activeAnalysis.key) && !resultsByKey[activeAnalysis.key]"
            class="flex items-center justify-center gap-2 py-12 text-base-content/50 text-sm"
          >
            <span class="loading loading-spinner loading-sm text-primary"></span>
            分析中...
          </div>

          <template v-else-if="resultsByKey[activeAnalysis.key]">
            <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h4 class="font-semibold text-sm">{{ activeAnalysis.label }}</h4>
              <div class="flex items-center gap-2">
                <button
                  v-if="activeAnalysis.key === 'anchors'"
                  class="btn btn-outline btn-primary btn-xs gap-1"
                  :disabled="importingAnchors"
                  @click="importAnchorsToDb"
                >
                  <font-awesome-icon :icon="importingAnchors ? 'spinner' : 'anchor'" :spin="importingAnchors" class="w-3 h-3" />
                  {{ importingAnchors ? '导入中...' : '导入到锚点管理' }}
                </button>
                <FavoriteButton
                  :work-id="workId"
                  :source-step="activeAnalysis.step"
                  :source-label="activeAnalysis.label"
                  :content="resultsByKey[activeAnalysis.key]!"
                  :source-input="ideaInput"
                  size="xs"
                />
              </div>
            </div>
            <div
              v-if="activeAnalysis.key && parseWarningsByKey[activeAnalysis.key]"
              class="alert alert-warning text-xs py-2 mb-3"
            >
              {{ parseWarningsByKey[activeAnalysis.key] }}
            </div>
            <MarkdownContent
              v-if="showMarkdownForActive()"
              :content="resultsByKey[activeAnalysis.key]!"
            />

            <div v-if="activeAnalysis.key === 'variants' && variantItems.length" class="space-y-3 mt-2">
              <p class="text-xs text-base-content/50">
                已解析 {{ variantItems.length }} 个变体 · 选择一个采纳为故事方向
              </p>
              <div
                v-for="(item, idx) in variantItems"
                :key="idx"
                class="border border-base-300 rounded-lg p-3 bg-base-100"
              >
                <div class="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <h5 class="font-semibold text-sm">{{ item.title }}</h5>
                    <p v-if="item.dimension && item.dimension !== item.title" class="text-xs text-base-content/50 mt-0.5">
                      维度：{{ item.dimension }}
                    </p>
                  </div>
                  <button
                    class="btn btn-primary btn-xs shrink-0"
                    :disabled="adoptingVariant"
                    @click="adoptVariant(item)"
                  >
                    {{ adoptingVariant ? '采纳中...' : '采纳为故事方向' }}
                  </button>
                </div>
                <p class="text-sm text-base-content/70 whitespace-pre-wrap">{{ item.summary }}</p>
              </div>
              <details class="text-xs mt-2">
                <summary class="cursor-pointer text-base-content/50">查看原始 JSON</summary>
                <pre class="whitespace-pre-wrap break-words text-[11px] opacity-70 mt-2">{{ resultsByKey.variants }}</pre>
              </details>
            </div>

            <div v-if="activeAnalysis.key === 'expand' && expansionVersions.length" class="space-y-3 mt-2">
              <p class="text-xs text-base-content/50">
                已解析 {{ expansionVersions.length }} 个扩写版本 · 选择一个采纳为故事方向
              </p>
              <div
                v-for="(ver, idx) in expansionVersions"
                :key="idx"
                class="border border-base-300 rounded-lg p-3 bg-base-100"
              >
                <div class="flex items-start justify-between gap-2 mb-2">
                  <h5 class="font-semibold text-sm">{{ ver.title }}</h5>
                  <button
                    class="btn btn-primary btn-xs shrink-0"
                    :disabled="adoptingExpansion"
                    @click="adoptExpansion(ver)"
                  >
                    {{ adoptingExpansion ? '采纳中...' : '采纳为故事方向' }}
                  </button>
                </div>
                <p class="text-sm text-base-content/70 whitespace-pre-wrap">{{ ver.summary }}</p>
                <p v-if="ver.highlights" class="text-xs text-base-content/50 mt-2">亮点：{{ ver.highlights }}</p>
                <p v-if="ver.audience" class="text-xs text-base-content/50 mt-1">受众：{{ ver.audience }}</p>
              </div>
              <details class="text-xs mt-2">
                <summary class="cursor-pointer text-base-content/50">查看原始 JSON</summary>
                <pre class="whitespace-pre-wrap break-words text-[11px] opacity-70 mt-2">{{ resultsByKey.expand }}</pre>
              </details>
            </div>
            <AiInterventionBar
              v-if="activeAnalysis && resultsByKey[activeAnalysis.key]"
              :work-id="workId"
              :step="activeAnalysis.step"
              :content="resultsByKey[activeAnalysis.key]!"
              :regenerate-prompt="ideaInput"
              :regenerate-system-prompt="activeAnalysis.system"
              @update:content="updateActiveResult"
            />
            <AiSelfCheckPanel
              v-if="activeAnalysis && resultsByKey[activeAnalysis.key]"
              :work-id="workId"
              step="incubator"
              :content="resultsByKey[activeAnalysis.key]!"
            />
            <div
              v-if="isItemLoading(activeAnalysis.key)"
              class="flex items-center gap-2 mt-4 pt-4 border-t border-base-300 text-sm text-base-content/50"
            >
              <span class="loading loading-spinner loading-xs text-primary"></span>
              正在重新分析...
            </div>
          </template>
        </template>
      </div>
    </div>

    <StepNavFooter step="incubator" />
  </div>
</template>
