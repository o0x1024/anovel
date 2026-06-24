<script setup lang="ts">
import { ref, computed, watch, inject } from 'vue'
import { toPlainForIpc } from '../../../../../shared/ipc-plain'
import type {
  IncubatorCandidate,
  IncubatorCandidateSourceStep
} from '../../../../../shared/incubator-types'
import { normalizeCandidateTitle } from '../../../../../shared/incubator-candidate'
import { INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE } from '../../../../../shared/incubator-gate'
import {
  INCUBATOR_SLOT_KEYS,
  INCUBATOR_SLOT_LABELS,
  type IncubatorSlotKey
} from '../../../../../shared/incubator-slots'
import type { AdoptSourceStep } from '../../../composables/incubator/useStorylineAdopt'
import type { ModelChatResult } from '../useModelChat'
import { reportRendererError } from '../../../utils/reportError'
import MarkdownContent from '../../../components/MarkdownContent.vue'
import FavoriteButton from '../../../components/FavoriteButton.vue'
import AiInterventionBar from '../AiInterventionBar.vue'
import AiSelfCheckPanel from '../AiSelfCheckPanel.vue'
import {
  INCUBATOR_ANALYSIS_PROMPTS,
  INCUBATOR_SLOT_FILL_ORDER,
  INCUBATOR_DIAGNOSE_APPLY_SYSTEM,
  buildAnalysisUserPrompt,
  buildDiagnoseApplyUserPrompt
} from '../../../../../shared/incubator-analysis-prompts'
import { STORY_INCUBATOR_ANALYSIS_PROMPTS } from '../../../../../shared/story-incubator-prompts'
import { INCUBATOR_POPULAR_PROMPTS } from '../../../../../shared/incubator-popular-prompts'
import { incubatorSeedTextKey, incubatorStateKey, storylineAdoptKey } from './incubator-context'

import { useBodyGenerationModel } from '../../../composables/useBodyGenerationModel'

const props = defineProps<{ workId: number }>()
const emit = defineEmits<{ workspaceRefresh: [] }>()
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)

const incubator = inject(incubatorStateKey)!
const seedText = inject(incubatorSeedTextKey)!
const adopt = inject(storylineAdoptKey)!

const ANALYSIS_UI_ORDER = [
  'premise',
  'variants',
  'expand',
  'world_rules',
  'role_engine',
  'rhythm_curve',
  'ending',
  'frontstory',
  'diagnose',
  'reverse',
  'anchors',
  'benchmark',
  'tone',
  'microinnovation'
] as const

interface AnalysisConfig {
  key: string
  label: string
  step: string
  system: string
  cardFormat?: 'variants' | 'expand'
  slotTarget?: IncubatorSlotKey
  sourceStep?: IncubatorCandidateSourceStep
}

const workType = ref<string | null>(null)
window.anovel.invoke('work:get', props.workId).then(w => {
  workType.value = (w as { work_type?: string })?.work_type ?? null
})

const analyses = computed<AnalysisConfig[]>(() => {
  if (workType.value === 'story') {
    return ANALYSIS_UI_ORDER.map(k => {
      const p = STORY_INCUBATOR_ANALYSIS_PROMPTS[k] || INCUBATOR_ANALYSIS_PROMPTS[k]
      if (!p) return null
      return {
        key: k,
        label: p.label,
        step: p.step,
        system: p.system,
        cardFormat: p.cardFormat,
        slotTarget: p.slotTarget,
        sourceStep: p.sourceStep as IncubatorCandidateSourceStep | undefined
      }
    }).filter((x): x is AnalysisConfig => x != null)
  }
  return ANALYSIS_UI_ORDER.map(k => {
    const p = INCUBATOR_POPULAR_PROMPTS[k]
    if (!p) return null
    return {
      key: k,
      label: p.label,
      step: p.step,
      system: p.system,
      cardFormat: p.cardFormat,
      slotTarget: p.slotTarget,
      sourceStep: p.sourceStep as IncubatorCandidateSourceStep | undefined
    }
  }).filter((x): x is AnalysisConfig => x != null)
})

type AnalysisKey = string

type CardItem = { title: string; summary: string; dimension?: string; highlights?: string; audience?: string }

const loadingByKey = ref<Partial<Record<AnalysisKey, boolean>>>({})
const resultsByKey = ref<Partial<Record<AnalysisKey, string>>>({})
const errorsByKey = ref<Partial<Record<AnalysisKey, string>>>({})
const activeTab = ref<AnalysisKey | null>(null)
const importingAnchors = ref(false)
const applyingDiagnoseFixes = ref(false)
const diagnoseApplyMessage = ref('')
const cardsByKey = ref<Partial<Record<AnalysisKey, CardItem[]>>>({})
const parseWarningsByKey = ref<Partial<Record<AnalysisKey, string>>>({})
const clearingAll = ref(false)

const visibleTabs = computed(() =>
  analyses.value.filter(item =>
    !!(resultsByKey.value[item.key] || errorsByKey.value[item.key] || loadingByKey.value[item.key])
  )
)

const hasAnySavedResults = computed(() =>
  analyses.value.some(item => !!resultsByKey.value[item.key]?.trim())
)

const isAnyLoading = computed(() =>
  analyses.value.some(item => !!loadingByKey.value[item.key])
)

const activeAnalysis = computed(() =>
  analyses.value.find(item => item.key === activeTab.value) ?? null
)

const activeCards = computed(() => cardsByKey.value[activeTab.value ?? ''] ?? [])

const filledSlotsMap = computed(() => {
  const map: Partial<Record<IncubatorSlotKey, string>> = {}
  for (const s of incubator.workspace?.activeDraftSlots ?? []) {
    const key = s.slotKey as IncubatorSlotKey
    if (INCUBATOR_SLOT_KEYS.includes(key) && s.content?.trim()) map[key] = s.content
  }
  return map
})

const getSlotMappingLabel = (key: string) => {
  const isStory = workType.value === 'story'
  const labels: Record<string, string> = {
    premise: isStory ? '主题前提 (对应主题前提)' : '主题前提 (对应主题前提)',
    core_conflict: isStory ? '核心冲突 (对应微创新变体)' : '核心冲突 (对应变体探索)',
    world_rules: isStory ? '世界规则 (对应背景规则)' : '世界规则 (对应世界规则)',
    role_engine: isStory ? '角色驱动 (对应反差人设)' : '角色驱动 (对应角色驱动)',
    opening: isStory ? '开局设计 (对应黄金开局扩写)' : '开局设计 (对应开局扩写)',
    ending: isStory ? '终局设计 (对应清算终局)' : '终局设计 (对应终局设计)'
  }
  return labels[key] || INCUBATOR_SLOT_LABELS[key as keyof typeof INCUBATOR_SLOT_LABELS] || key
}

const workflowHint = computed(() => {
  const nextSlot = INCUBATOR_SLOT_FILL_ORDER.find(k => !filledSlotsMap.value[k]?.trim())
  if (nextSlot) {
    return `下一步建议先填「${getSlotMappingLabel(nextSlot)}」；分析时会自动带入已确认槽位。完整流程见页顶「推荐操作顺序」。`
  }
  return '主线槽位已齐：请运行门禁并冻结；重跑分析仍会带入已确认槽位作为约束。'
})

const charactersList = ref<string[]>([])

async function loadCharacters() {
  try {
    const registryNames = await window.anovel.invoke('name:list', props.workId, 'character', 'adopted') as { name: string }[]
    const cards = await window.anovel.invoke('characterCards:list', props.workId) as { name: string }[]
    const namesSet = new Set<string>()
    cards.forEach(c => {
      const name = c.name?.trim()
      if (name) namesSet.add(name)
    })
    registryNames.forEach(r => {
      const name = r.name?.trim()
      if (name) namesSet.add(name)
    })
    charactersList.value = [...namesSet]
  } catch (e) {
    console.error('Failed to load characters:', e)
  }
}

watch(() => props.workId, () => {
  void loadCharacters()
}, { immediate: true })

async function loadSavedResults() {
  void loadCharacters()
  const settings = await window.anovel.invoke('setting:listByWork', props.workId) as { type: string; content: string }[]
  const loaded: Partial<Record<AnalysisKey, string>> = {}
  for (const item of analyses.value) {
    const row = settings.find(s => s.type === item.step)
    if (row?.content) loaded[item.key] = row.content
  }
  resultsByKey.value = loaded
  const firstKey = analyses.value.find(item => loaded[item.key])?.key
  if (firstKey) activeTab.value = firstKey
  for (const item of analyses.value) {
    if (item.cardFormat && loaded[item.key]) {
      await parseAndStoreCards(item, loaded[item.key]!, true)
    }
  }
  await incubator.refresh()
}

defineExpose({ loadSavedResults })

async function clearAllResults() {
  if (!hasAnySavedResults.value || clearingAll.value || isAnyLoading.value) return
  if (
    !confirm(
      '确定清除全部 AI 分析结果？\n\n将删除所有分析文本及同步到候选池的 AI 候选（手动添加的候选、创作种子与主线槽位不受影响）。'
    )
  ) {
    return
  }

  clearingAll.value = true
  try {
    await window.anovel.invoke('incubator:clearAnalysisResults', props.workId)

    resultsByKey.value = {}
    errorsByKey.value = {}
    cardsByKey.value = {}
    parseWarningsByKey.value = {}
    activeTab.value = null
    diagnoseApplyMessage.value = ''

    await incubator.refresh()
    emit('workspaceRefresh')
  } catch (e) {
    const message = String(e)
    await reportRendererError('incubator', `清除分析结果失败: ${message}`, { workId: props.workId })
    alert(`清除失败：${message}`)
  } finally {
    clearingAll.value = false
  }
}

async function parseAndStoreCards(
  config: AnalysisConfig,
  content: string,
  legacyFallback = false
): Promise<CardItem[]> {
  let items: CardItem[] = []
  if (config.cardFormat === 'variants') {
    items = await window.anovel.invoke('incubator:parseVariants', content, legacyFallback) as CardItem[]
  } else if (config.cardFormat === 'expand') {
    items = await window.anovel.invoke('incubator:parseExpansion', content, legacyFallback) as CardItem[]
  } else if (config.cardFormat === 'anchors') {
    items = await window.anovel.invoke('incubator:parseAnchors', content) as CardItem[]
  }
  cardsByKey.value = { ...cardsByKey.value, [config.key]: items }
  parseWarningsByKey.value = {
    ...parseWarningsByKey.value,
    [config.key]: content.trim() && items.length === 0
      ? `未能解析${config.label} JSON，请重新生成`
      : ''
  }
  return items
}

async function persistCards(config: AnalysisConfig, items: CardItem[]) {
  if (!items.length || !config.sourceStep) return
  if (config.key === 'anchors') return // 锚点有独立导入按钮，不自动持久化到候选池
  if (config.key === 'variants') {
    await window.anovel.invoke('incubator:persistVariants', props.workId, toPlainForIpc(items))
  } else if (config.key === 'expand') {
    await window.anovel.invoke('incubator:persistExpansion', props.workId, toPlainForIpc(items))
  } else {
    await window.anovel.invoke(
      'incubator:persistSlotAnalysis',
      props.workId,
      config.sourceStep,
      toPlainForIpc(items)
    )
  }
}

watch(
  () => analyses.value,
  (newAnalyses) => {
    for (const cfg of newAnalyses) {
      if (!cfg.cardFormat) continue
      watch(
        () => resultsByKey.value[cfg.key],
        (content) => {
          if (content) void parseAndStoreCards(cfg, content, false)
          else cardsByKey.value = { ...cardsByKey.value, [cfg.key]: [] }
        }
      )
    }
  },
  { immediate: true }
)

function isItemLoading(key: AnalysisKey) {
  return !!loadingByKey.value[key]
}

async function runAnalysis(item: AnalysisConfig) {
  if (!seedText.value.trim() || isItemLoading(item.key)) return

  activeTab.value = item.key
  loadingByKey.value = { ...loadingByKey.value, [item.key]: true }
  errorsByKey.value = { ...errorsByKey.value, [item.key]: '' }

  try {
    const userPrompt = buildAnalysisUserPrompt(
      seedText.value.trim(),
      filledSlotsMap.value,
      item.key,
      charactersList.value
    )
    const res = await window.anovel.invoke('model:chat', {
      prompt: userPrompt,
      systemPrompt: item.system,
      workId: props.workId,
      step: item.step,
      enrichWorkContext: false,
      ...bodyModelParams()
    }) as ModelChatResult

    if (res.success) {
      await window.anovel.invoke('setting:upsert', props.workId, item.step, res.content)
      if (item.cardFormat) {
        const cards = await parseAndStoreCards(item, res.content, false)
        await persistCards(item, cards)
      }
      resultsByKey.value = { ...resultsByKey.value, [item.key]: res.content }
      await incubator.refresh()
      emit('workspaceRefresh')
    } else {
      errorsByKey.value = { ...errorsByKey.value, [item.key]: res.error || '生成失败' }
    }
  } catch (e) {
    const message = String(e)
    errorsByKey.value = { ...errorsByKey.value, [item.key]: message }
    await reportRendererError('incubator', `${item.label}失败: ${message}`, {
      step: item.step,
      workId: props.workId
    })
  } finally {
    loadingByKey.value = { ...loadingByKey.value, [item.key]: false }
  }
}

async function applyDiagnoseFixesToSlots() {
  const report = resultsByKey.value.diagnose
  if (!report?.trim() || applyingDiagnoseFixes.value) return

  applyingDiagnoseFixes.value = true
  diagnoseApplyMessage.value = ''
  try {
    const userPrompt = buildDiagnoseApplyUserPrompt(
      seedText.value.trim(),
      filledSlotsMap.value,
      report,
      charactersList.value
    )
    const res = await window.anovel.invoke('model:chat', {
      prompt: userPrompt,
      systemPrompt: INCUBATOR_DIAGNOSE_APPLY_SYSTEM,
      workId: props.workId,
      step: 'incubator_diagnose_apply',
      enrichWorkContext: false,
      ...bodyModelParams()
    }) as ModelChatResult

    if (!res.success) {
      diagnoseApplyMessage.value = res.error || '解析修复动作失败'
      return
    }

    const patches = await window.anovel.invoke(
      'incubator:parseDiagnosePatches',
      res.content
    ) as { slotKey: IncubatorSlotKey; text: string }[]

    if (!patches.length) {
      diagnoseApplyMessage.value = '未能从诊断结果解析出可入槽的修复项，请检查报告是否含「修复动作」'
      return
    }

    const applyRes = await window.anovel.invoke(
      'incubator:applyDiagnosePatches',
      props.workId,
      patches
    ) as { applied: number; slotKeys: IncubatorSlotKey[]; workspace?: unknown }

    await incubator.refresh()
    emit('workspaceRefresh')
    const labels = (applyRes.slotKeys ?? []).map(k => INCUBATOR_SLOT_LABELS[k]).join('、')
    diagnoseApplyMessage.value = `已写入 ${applyRes.applied} 处修复（${labels}），请至左侧「主线编排」查看`
  } catch (e) {
    const message = String(e)
    diagnoseApplyMessage.value = message
    await reportRendererError('incubator', `诊断修复入槽失败: ${message}`, { workId: props.workId })
  } finally {
    applyingDiagnoseFixes.value = false
  }
}

async function importAnchorsToDb() {
  const content = resultsByKey.value.anchors
  if (!content || importingAnchors.value) return
  importingAnchors.value = true
  try {
    // 优先用 JSON 解析（新格式），回退到 Markdown 解析（旧格式兼容）
    let parsed: { type: string; title: string; content: string; scope?: string }[] = []
    const trimmed = content.trim()
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/) ?? trimmed.match(/(\[[\s\S]*\])/)
    if (fenced) {
      try {
        const arr = JSON.parse(fenced[1] ?? fenced[0])
        if (Array.isArray(arr) && arr.length > 0 && arr[0].title && arr[0].content) parsed = arr
      } catch { /* 回退 */ }
    }
    if (!parsed.length) {
      parsed = await window.anovel.invoke('anchor:parseSuggestions', content) as typeof parsed
    }
    if (parsed.length === 0) {
      alert('未能从结果中解析出锚点')
      return
    }
    await window.anovel.invoke('anchor:batchCreate', parsed.map(a => ({
      work_id: props.workId,
      type: a.type,
      title: a.title,
      content: a.content,
      scope: a.scope,
      created_step: 'incubator_anchors'
    })))
    alert(`已导入 ${parsed.length} 个锚点`)

    // 自动匹配：尝试将新导入的锚点绑定到已有章节/分卷
    try {
      const matchRes = await window.anovel.invoke('anchor:autoMatch', props.workId, bodyModelParams()) as { success: boolean; matched?: number; message?: string }
      if (matchRes.success && matchRes.matched) {
        alert(`已自动匹配 ${matchRes.matched} 个锚点到对应章节/分卷`)
      }
    } catch { /* 非关键 */ }
  } finally {
    importingAnchors.value = false
  }
}

async function updateActiveResult(content: string) {
  if (!activeAnalysis.value) return
  const analysis = activeAnalysis.value
  const key = analysis.key
  try {
    await window.anovel.invoke('setting:upsert', props.workId, analysis.step, content)
    if (analysis.cardFormat) {
      const cards = await parseAndStoreCards(analysis, content, false)
      await persistCards(analysis, cards)
    }
    resultsByKey.value = { ...resultsByKey.value, [key]: content }
    await incubator.refresh()
    emit('workspaceRefresh')
  } catch (e) {
    const message = String(e)
    errorsByKey.value = { ...errorsByKey.value, [key]: message }
    await reportRendererError('incubator', `${analysis.label}保存失败: ${message}`, {
      step: analysis.step,
      workId: props.workId
    })
  }
}

function showMarkdownForActive(): boolean {
  if (!activeAnalysis.value) return false
  return !activeAnalysis.value.cardFormat || activeCards.value.length === 0
}

function adoptSourceStep(config: AnalysisConfig): AdoptSourceStep {
  const s = config.sourceStep
  if (s === 'variants' || s === 'expand' || s === 'premise_gen' ||
      s === 'role_engine_gen' || s === 'world_rules_gen' || s === 'rhythm_curve_gen' || s === 'ending_gen') return s
  return 'expand'
}

function findCandidateForCard(
  config: AnalysisConfig,
  card: CardItem
): (IncubatorCandidate & { latestScore?: { finalTotal: number; rationale?: string | null } | null }) | null {
  const step = config.sourceStep
  if (!step) return null
  const title = normalizeCandidateTitle(card.title)
  return (
    incubator.workspace?.candidates.find(
      c => c.sourceStep === step && normalizeCandidateTitle(c.title) === title
    ) ?? null
  )
}

function cardFinalScore(config: AnalysisConfig, card: CardItem): number | null {
  const c = findCandidateForCard(config, card)
  if (!c?.latestScore) return null
  return c.latestScore.finalTotal
}

function cardRationale(config: AnalysisConfig, card: CardItem): string | null {
  const c = findCandidateForCard(config, card)
  if (!c?.latestScore) return null
  return c.latestScore.rationale ?? null
}

function canAdoptCard(config: AnalysisConfig, card: CardItem): boolean {
  const score = cardFinalScore(config, card)
  return score != null && score >= INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE
}

function openAdoptFromCard(config: AnalysisConfig, card: CardItem) {
  const step = adoptSourceStep(config)
  const candidate = findCandidateForCard(config, card)
  const slot = config.slotTarget ?? 'opening'
  if (candidate) {
    adopt.openFromCandidate(
      candidate.id,
      { title: card.title, summary: card.summary, sourceStep: step },
      slot,
      cardFinalScore(config, card)
    )
  } else {
    adopt.openFromLegacy(
      step,
      { sourceStep: step, ...card },
      slot
    )
  }
}
</script>

<template>
  <div>
    <p class="text-xs text-base-content/50 mb-3">{{ workflowHint }}</p>
    <div class="flex flex-wrap items-center gap-2 mb-4">
      <button
        v-for="item in analyses"
        :key="item.key"
        class="btn btn-outline btn-primary btn-sm"
        :disabled="!seedText.trim() || isItemLoading(item.key) || clearingAll"
        @click="runAnalysis(item)"
      >
        {{ isItemLoading(item.key) ? '分析中...' : item.label }}
      </button>
      <button
        v-if="hasAnySavedResults"
        type="button"
        class="btn btn-outline btn-error btn-sm ml-auto"
        :disabled="clearingAll || isAnyLoading"
        @click="clearAllResults"
      >
        {{ clearingAll ? '清除中...' : '清除全部分析' }}
      </button>
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
                  v-if="activeAnalysis.key === 'diagnose'"
                  type="button"
                  class="btn btn-outline btn-primary btn-xs"
                  :disabled="applyingDiagnoseFixes"
                  @click="applyDiagnoseFixesToSlots"
                >
                  {{ applyingDiagnoseFixes ? '应用中...' : '应用修复到主线' }}
                </button>
                <button
                  v-if="activeAnalysis.key === 'anchors'"
                  class="btn btn-outline btn-primary btn-xs"
                  :disabled="importingAnchors"
                  @click="importAnchorsToDb"
                >
                  {{ importingAnchors ? '导入中...' : '导入锚点' }}
                </button>
                <FavoriteButton
                  :work-id="workId"
                  :source-step="activeAnalysis.step"
                  :source-label="activeAnalysis.label"
                  :content="resultsByKey[activeAnalysis.key]!"
                  :source-input="seedText"
                  size="xs"
                />
              </div>
            </div>
            <div
              v-if="parseWarningsByKey[activeAnalysis.key]"
              class="alert alert-warning text-xs py-2 mb-3"
            >
              {{ parseWarningsByKey[activeAnalysis.key] }}
            </div>
            <p
              v-if="activeAnalysis.key === 'diagnose'"
              class="text-[11px] text-base-content/45 mb-2"
            >
              「修复动作」不会自动改槽：点「应用修复到主线」后由 AI 将修复与原内容合并，直接替换对应槽位。
            </p>
            <p
              v-if="diagnoseApplyMessage"
              class="text-xs mb-2"
              :class="diagnoseApplyMessage.startsWith('已写入') ? 'text-success' : 'text-warning'"
            >
              {{ diagnoseApplyMessage }}
            </p>
            <MarkdownContent
              v-if="showMarkdownForActive()"
              :content="resultsByKey[activeAnalysis.key]!"
            />
            <p
              v-if="activeCards.length && activeAnalysis?.cardFormat"
              class="text-[11px] text-base-content/45 mb-2"
            >
              入槽建议总分 ≥ {{ INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE }}（与候选池一致，可在评分矩阵加分）
            </p>
            <div v-if="activeCards.length" class="space-y-3 mt-2">
              <div
                v-for="(card, idx) in activeCards"
                :key="idx"
                class="border border-base-300 rounded-lg p-3 bg-base-100"
              >
                <div class="flex justify-between gap-2 mb-2">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <h5 class="font-semibold text-sm">{{ card.title }}</h5>
                      <span
                        v-if="cardFinalScore(activeAnalysis!, card) != null"
                        class="badge badge-sm"
                        :class="
                          canAdoptCard(activeAnalysis!, card) ? 'badge-primary' : 'badge-ghost'
                        "
                      >
                        {{ cardFinalScore(activeAnalysis!, card) }} 分
                      </span>
                      <span v-else class="badge badge-ghost badge-sm">评分中…</span>
                      <span
                        v-if="cardRationale(activeAnalysis!, card)"
                        class="text-[11px] text-base-content/40 italic truncate max-w-[200px]"
                        :title="cardRationale(activeAnalysis!, card)!"
                      >
                        {{ cardRationale(activeAnalysis!, card) }}
                      </span>
                    </div>
                    <p v-if="card.dimension" class="text-xs text-base-content/50 mt-0.5">{{ card.dimension }}</p>
                  </div>
                  <button
                    class="btn btn-primary btn-xs shrink-0"
                    :disabled="cardFinalScore(activeAnalysis!, card) != null && !canAdoptCard(activeAnalysis!, card)"
                    :title="
                      canAdoptCard(activeAnalysis!, card)
                        ? ''
                        : `总分 ${cardFinalScore(activeAnalysis!, card) ?? '—'}，低于 ${INCUBATOR_CANDIDATE_ADOPT_MIN_SCORE}，请至评分矩阵加分`
                    "
                    @click="openAdoptFromCard(activeAnalysis!, card)"
                  >
                    采纳到槽位
                  </button>
                </div>
                <p
                  v-if="cardFinalScore(activeAnalysis!, card) != null && !canAdoptCard(activeAnalysis!, card)"
                  class="text-[11px] text-warning mb-1"
                >
                  未达入槽线，可至「评分矩阵」加分后从候选池采纳
                </p>
                <p class="text-sm text-base-content/70 whitespace-pre-wrap">{{ card.summary }}</p>
              </div>
            </div>
            <AiInterventionBar
              v-if="resultsByKey[activeAnalysis.key]"
              :work-id="workId"
              :step="activeAnalysis.step"
              :content="resultsByKey[activeAnalysis.key]!"
              :regenerate-prompt="buildAnalysisUserPrompt(seedText, filledSlotsMap, activeAnalysis.key, charactersList)"
              :regenerate-system-prompt="activeAnalysis.system"
              :enrich-work-context="false"
              @update:content="updateActiveResult"
            />
            <AiSelfCheckPanel
              v-if="resultsByKey[activeAnalysis.key]"
              :work-id="workId"
              step="incubator"
              :content="resultsByKey[activeAnalysis.key]!"
              :enrich-work-context="false"
            />
          </template>
        </template>
      </div>
    </div>
    <p v-else class="text-xs text-base-content/40 py-4">点击上方按钮运行 AI 分析，结果会同步到候选池</p>
  </div>
</template>
