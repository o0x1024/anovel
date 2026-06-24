<script setup lang="ts">
import { computed, inject, ref, onBeforeUnmount, unref, watch } from 'vue'
import {
  INCUBATOR_SLOT_KEYS,
  isIncubatorSlotKey,
  getIncubatorSlotLabel,
  type IncubatorSlotKey
} from '../../../../../shared/incubator-slots'
import {
  INCUBATOR_TWEAK_SYSTEM,
  buildTweakUserPrompt
} from '../../../../../shared/incubator-analysis-prompts'
import type {
  IncubatorDraftSlot,
  IncubatorGateReport,
  IncubatorStorylineVersion
} from '../../../../../shared/incubator-types'
import MarkdownContent from '../../../components/MarkdownContent.vue'
import { reportRendererError } from '../../../utils/reportError'
import { useBodyGenerationModel } from '../../../composables/useBodyGenerationModel'
import type { ModelChatResult } from '../useModelChat'
import { incubatorSeedTextKey, incubatorStateKey } from './incubator-context'

const props = defineProps<{ workId: number }>()
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)
const emit = defineEmits<{ saved: [] }>()
const incubator = inject(incubatorStateKey)!
const seedText = inject(incubatorSeedTextKey)!

const workType = ref<string | null>(null)
const charactersList = ref<string[]>([])

async function loadCharacters() {
  if (!props.workId) return
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
    console.error('Failed to load characters in StorylineComposerPanel:', e)
  }
}

watch(() => props.workId, async (id) => {
  if (!id) return
  try {
    const w = await window.anovel.invoke('work:get', id) as { work_type?: string } | null
    workType.value = w?.work_type ?? null
    void loadCharacters()
  } catch {}
}, { immediate: true })

/** provide(reactive(incubator)) 已 unwrap ref，勿再 .value */
const ws = computed(() => incubator.workspace ?? null)
const gateReport = computed(() => incubator.lastGateReport ?? null)

const slotDrafts = ref<Partial<Record<IncubatorSlotKey, string>>>({})
const savingSlot = ref<IncubatorSlotKey | null>(null)
const freezeStage = ref('')
const freezeResult = ref<{ summary?: string; quality?: string } | null>(null)
const slotSaveState = ref<Partial<Record<IncubatorSlotKey, 'saving' | 'saved'>>>({})
const slotSaveTimers: Partial<Record<IncubatorSlotKey, ReturnType<typeof setTimeout>>> = {}
const focusSlot = ref<IncubatorSlotKey | null>(null)
const applyingGateFixes = ref(false)
const gateFixMessage = ref('')
const tweakModalOpen = ref(false)
const tweakInstructions = ref('')
const applyingTweak = ref(false)
const tweakMessage = ref('')
const gateInstructionModalOpen = ref(false)
const gateInstruction = ref('')
const isFreezeResultExpanded = ref(false)
const isUndoing = computed(() => Boolean(unref(incubator.undoing as unknown)))
const isGateRunning = computed(() => Boolean(unref(incubator.gateRunning as unknown)))
const isFreezing = computed(() => Boolean(unref(incubator.freezing as unknown)))
const gateWarningCount = computed(() =>
  (gateReport.value?.coherence ?? []).filter(
    (i: IncubatorGateReport['coherence'][number]) => i.severity === 'warning'
  ).length
)
const gateBlockingCount = computed(() =>
  (gateReport.value?.coherence ?? []).filter(
    (i: IncubatorGateReport['coherence'][number]) => i.severity === 'blocking'
  ).length
)
const canRunGateAutoFix = computed(() => {
  if (!gateReport.value) return false
  return gateBlockingCount.value > 0 || gateWarningCount.value > 0
})
const gateFixButtonLabel = computed(() => {
  if (applyingGateFixes.value) return '修复中（LLM 重写）...'
  const count = gateBlockingCount.value + gateWarningCount.value
  return `一键修复（${count}）`
})

const slots = computed(() =>
  INCUBATOR_SLOT_KEYS.map(key => {
    const active = (ws.value?.activeDraftSlots ?? []).find((s: IncubatorDraftSlot) => s.slotKey === key)
    const draft = slotDrafts.value[key]
    const content = draft !== undefined ? draft : (active?.content ?? '')
    return {
      key,
      label: getIncubatorSlotLabel(key, workType.value),
      content,
      filled: !!content.trim()
    }
  })
)

const filledCount = computed(() => slots.value.filter(s => s.filled).length)

const latestFrozen = computed(() => ws.value?.latestFrozenVersion ?? null)

const hasPendingSlotDrafts = computed(() => Object.keys(slotDrafts.value).length > 0)

const draftDirtySinceFreeze = computed(
  () => (ws.value?.draftDirtySinceFreeze ?? false) || hasPendingSlotDrafts.value
)

/** 无冻结版，或草案相对最新冻结有改动时可点冻结 */
const canFreezeStoryline = computed(
  () => !latestFrozen.value || draftDirtySinceFreeze.value
)

const freezeButtonLabel = computed(() => {
  if (incubator.freezing) return '统合冻结中...'
  if (!latestFrozen.value) return '冻结版本'
  if (canFreezeStoryline.value) {
    const n = ws.value?.nextFreezeVersionNo ?? latestFrozen.value.versionNo + 1
    return `冻结为 V${n}`
  }
  const v = latestFrozen.value
  return `${v.label || 'V' + v.versionNo} · 已冻结`
})

const branchHint = computed(() => {
  const baseId = ws.value?.branchBaseVersionId
  if (!baseId) return null
  const v = (ws.value?.versions ?? []).find((ver: IncubatorStorylineVersion) => ver.id === baseId)
  return v ? `基于 V${v.versionNo} 分支编辑，冻结后将记录 lineage` : '分支编辑中'
})

function slotLabelOf(slotKey: string): string {
  return isIncubatorSlotKey(slotKey) ? getIncubatorSlotLabel(slotKey, workType.value) : slotKey
}

function jumpToSlot(slotKey: string): void {
  if (!isIncubatorSlotKey(slotKey)) return
  focusSlot.value = slotKey
  const el = document.getElementById(`incubator-slot-${slotKey}`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  const input = el?.querySelector('textarea') as HTMLTextAreaElement | null
  input?.focus()
  setTimeout(() => {
    if (focusSlot.value === slotKey) focusSlot.value = null
  }, 1800)
}

function persistedSlotContent(key: IncubatorSlotKey): string {
  return (ws.value?.activeDraftSlots ?? []).find((s: IncubatorDraftSlot) => s.slotKey === key)?.content ?? ''
}

function onSlotInput(key: IncubatorSlotKey, value: string) {
  slotDrafts.value = { ...slotDrafts.value, [key]: value }
  scheduleSlotSave(key, value)
}

function scheduleSlotSave(key: IncubatorSlotKey, value: string) {
  const timer = slotSaveTimers[key]
  if (timer) clearTimeout(timer)
  slotSaveTimers[key] = setTimeout(() => void saveSlot(key, value), 800)
}

async function saveSlot(key: IncubatorSlotKey, contentOverride?: string) {
  const content = (contentOverride ?? slotDrafts.value[key] ?? '').trim()
  const timer = slotSaveTimers[key]
  if (timer) {
    clearTimeout(timer)
    delete slotSaveTimers[key]
  }

  if (content === persistedSlotContent(key).trim()) {
    const next = { ...slotDrafts.value }
    delete next[key]
    slotDrafts.value = next
    return
  }

  savingSlot.value = key
  slotSaveState.value = { ...slotSaveState.value, [key]: 'saving' }
  try {
    await incubator.updateSlotContent(key, content)
    const next = { ...slotDrafts.value }
    delete next[key]
    slotDrafts.value = next
    slotSaveState.value = { ...slotSaveState.value, [key]: 'saved' }
    emit('saved')
    setTimeout(() => {
      const st = { ...slotSaveState.value }
      delete st[key]
      slotSaveState.value = st
    }, 2000)
  } finally {
    savingSlot.value = null
  }
}

async function flushPendingSlots() {
  const keys = Object.keys(slotDrafts.value) as IncubatorSlotKey[]
  for (const key of keys) {
    await saveSlot(key)
  }
}

onBeforeUnmount(() => {
  for (const key of Object.keys(slotSaveTimers) as IncubatorSlotKey[]) {
    const timer = slotSaveTimers[key]
    if (timer) clearTimeout(timer)
  }
  void flushPendingSlots()
})

function openGateInstructionModal() {
  gateInstruction.value = ''
  gateInstructionModalOpen.value = true
}

function closeGateInstructionModal() {
  if (isGateRunning.value) return
  gateInstructionModalOpen.value = false
}

async function triggerGateCheck(useInstruction: boolean) {
  gateInstructionModalOpen.value = false
  gateFixMessage.value = ''
  await flushPendingSlots()
  await incubator.runGate(useInstruction ? gateInstruction.value.trim() : undefined)
  emit('saved')
}

function openTweakModal() {
  tweakMessage.value = ''
  tweakModalOpen.value = true
}

function closeTweakModal() {
  if (applyingTweak.value) return
  tweakModalOpen.value = false
}

async function applyTweak() {
  const instructions = tweakInstructions.value.trim()
  if (!instructions || applyingTweak.value) return
  if (filledCount.value === 0) {
    tweakMessage.value = '请先填写至少一个槽位内容'
    return
  }

  await flushPendingSlots()
  applyingTweak.value = true
  tweakMessage.value = '微调处理中…'
  try {
    const userPrompt = buildTweakUserPrompt(
      seedText.value.trim(),
      slotContentsMap(),
      instructions,
      charactersList.value
    )
    const res = await window.anovel.invoke('model:chat', {
      prompt: userPrompt,
      systemPrompt: INCUBATOR_TWEAK_SYSTEM,
      workId: props.workId,
      step: 'incubator_tweak',
      enrichWorkContext: false,
      ...bodyModelParams()
    }) as ModelChatResult

    if (!res.success) {
      tweakMessage.value = res.error || '微调请求失败'
      return
    }

    const patches = await window.anovel.invoke(
      'incubator:parseDiagnosePatches',
      res.content
    ) as { slotKey: IncubatorSlotKey; text: string }[]

    if (!patches.length) {
      tweakMessage.value = '未能从 AI 回复解析出可入槽的修改项，请调整指令后重试'
      return
    }

    const applyRes = await window.anovel.invoke(
      'incubator:applyDiagnosePatches',
      props.workId,
      patches
    ) as { applied: number; slotKeys: IncubatorSlotKey[] }

    for (const key of applyRes.slotKeys ?? []) {
      const next = { ...slotDrafts.value }
      delete next[key]
      slotDrafts.value = next
    }

    await incubator.refresh()
    emit('saved')

    const labels = (applyRes.slotKeys ?? []).map(k => getIncubatorSlotLabel(k, workType.value)).join('、')
    tweakMessage.value = `已更新 ${applyRes.applied} 处（${labels}）`
    tweakInstructions.value = ''
    tweakModalOpen.value = false
    gateFixMessage.value = ''
  } catch (e) {
    const message = String(e)
    tweakMessage.value = message
    await reportRendererError('incubator', `主线微调失败: ${message}`, { workId: props.workId })
  } finally {
    applyingTweak.value = false
  }
}

function slotContentsMap(): Partial<Record<IncubatorSlotKey, string>> {
  const map: Partial<Record<IncubatorSlotKey, string>> = {}
  for (const slot of slots.value) {
    if (slot.content.trim()) map[slot.key] = slot.content
  }
  return map
}

async function applyGateAutoFix() {
  const report = gateReport.value
  if (!report || applyingGateFixes.value) return
  if (report.passed && gateWarningCount.value === 0) return

  const hasIssues = (report.coherence ?? []).some(
    (i: IncubatorGateReport['coherence'][number]) => i.severity === 'blocking' || i.severity === 'warning'
  )
  if (!hasIssues) {
    gateFixMessage.value = '门禁报告中无需修复的项目'
    return
  }

  await flushPendingSlots()
  applyingGateFixes.value = true
  gateFixMessage.value = 'LLM 全局修复中，正在重写受影响槽位（约 15-40s）…'
  try {
    const plainReport = JSON.parse(JSON.stringify(report))
    const fixRes = await window.anovel.invoke(
      'incubator:runGateFix',
      props.workId,
      plainReport,
      bodyModelParams()
    ) as {
      applied: number
      slotKeys: IncubatorSlotKey[]
      logicRebuild?: string
      error?: string
      workspace?: typeof incubator.workspace
    }

    if (fixRes.error) {
      gateFixMessage.value = fixRes.error
      return
    }

    for (const key of fixRes.slotKeys ?? []) {
      const next = { ...slotDrafts.value }
      delete next[key]
      slotDrafts.value = next
    }

    if (fixRes.workspace) {
      incubator.workspace = fixRes.workspace
    } else {
      await incubator.refresh()
    }
    incubator.lastGateReport = null
    emit('saved')

    const labels = (fixRes.slotKeys ?? []).map(k => getIncubatorSlotLabel(k, workType.value)).join('、')
    const rebuildHint = fixRes.logicRebuild ? `\n逻辑重建：${fixRes.logicRebuild}` : ''
    gateFixMessage.value = `已重写 ${fixRes.applied} 个槽位（${labels}），建议重新运行门禁验证${rebuildHint}`
  } catch (e) {
    const message = String(e)
    gateFixMessage.value = message
    await reportRendererError('incubator', `门禁自动修复失败: ${message}`, { workId: props.workId })
  } finally {
    applyingGateFixes.value = false
  }
}

async function freeze() {
  if (!canFreezeStoryline.value) return
  await flushPendingSlots()
  freezeResult.value = null
  freezeStage.value = '校验门禁并统合主线槽位（LLM 生成中，约 10-30s）…'
  try {
    const ok = await incubator.freezeVersion()
    if (ok) {
      const ver = incubator.workspace?.latestFrozenVersion
      if (ver) {
        try {
          const detail = await window.anovel.invoke(
            'incubator:getVersionDetail',
            incubator.workspace!.latestFrozenVersion!.workId ?? 0,
            ver.id
          ) as { synthesizedSummary?: string; qualitySnapshot?: string } | null
          freezeResult.value = {
            summary: detail?.synthesizedSummary ?? undefined,
            quality: detail?.qualitySnapshot ?? undefined
          }
          isFreezeResultExpanded.value = false
        } catch { /* non-critical */ }
      }
      freezeStage.value = '✓ 冻结完成'
      emit('saved')
    } else {
      freezeStage.value = ''
    }
  } catch {
    freezeStage.value = ''
  }
}

async function undo() {
  const ok = await incubator.undoLastAdopt()
  if (ok) emit('saved')
}

function getSlotContentsForPreview(): Record<IncubatorSlotKey, string> {
  return Object.fromEntries(slots.value.map(s => [s.key, s.content])) as Record<IncubatorSlotKey, string>
}

defineExpose({ getSlotContentsForPreview })
</script>

<template>
  <div class="card bg-base-200 border border-base-300 shadow-sm p-4">
    <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
      <h4 class="font-semibold text-sm">主线编排（{{ filledCount }}/{{ INCUBATOR_SLOT_KEYS.length }}）</h4>
      <div class="flex flex-wrap gap-1">
        <button
          v-if="ws?.lastAdopt"
          type="button"
          class="btn btn-ghost btn-xs"
          :disabled="isUndoing"
          @click="undo"
        >
          {{ isUndoing ? '撤销中...' : '撤销采纳' }}
        </button>
        <button
          type="button"
          class="btn btn-outline btn-primary btn-xs"
          :disabled="isGateRunning"
          @click="openGateInstructionModal"
        >
          {{ isGateRunning ? '评审中...' : '运行 AI 门禁' }}
        </button>
        <button
          type="button"
          class="btn btn-outline btn-xs"
          :disabled="applyingTweak || filledCount === 0"
          title="按你的想法微调主线槽位，如修改角色名字、统一称谓等"
          @click="openTweakModal"
        >
          {{ applyingTweak ? '微调中...' : '微调' }}
        </button>
        <button
          type="button"
          class="btn btn-primary btn-xs"
          :disabled="isFreezing || !canFreezeStoryline"
          :title="canFreezeStoryline ? '' : '修改任意槽位后可再次冻结生成新版本'"
          @click="freeze"
        >
          {{ freezeButtonLabel }}
        </button>
      </div>
    </div>

    <p v-if="latestFrozen && !draftDirtySinceFreeze" class="text-xs text-base-content/45 mb-2">
      当前下游使用 {{ latestFrozen.label || 'V' + latestFrozen.versionNo }}。修改任意槽位后可「冻结为 V{{ ws?.nextFreezeVersionNo }}」并更新核心设定。
    </p>
    <p v-if="branchHint" class="text-xs text-warning mb-2">{{ branchHint }}</p>
    <p v-if="incubator.actionError" class="text-xs text-error mb-2">{{ incubator.actionError }}</p>

    <div v-if="freezeStage" class="mb-3 rounded-lg border border-info/30 bg-info/5 p-2 text-xs">
      <div class="flex items-center gap-2">
        <span v-if="isFreezing" class="loading loading-spinner loading-xs text-primary"></span>
        <span v-else class="text-success">✓</span>
        <span>{{ freezeStage }}</span>
      </div>
      <p v-if="!isFreezing && freezeStage" class="text-[11px] text-base-content/50 mt-1">
        统合摘要与质量评分卡已写入「版本图 → 预览」和下游核心设定 idea
      </p>
    </div>

    <div v-if="freezeResult?.summary" class="mb-3 rounded-lg border border-base-300 p-2 bg-base-100 text-xs">
      <div
        class="flex items-center justify-between cursor-pointer select-none"
        @click="isFreezeResultExpanded = !isFreezeResultExpanded"
      >
        <span class="font-medium text-primary">统合摘要与评分卡</span>
        <span class="text-[11px] text-base-content/50">
          {{ isFreezeResultExpanded ? '点击折叠 ▴' : '点击展开 ▾' }}
        </span>
      </div>
      <div v-show="isFreezeResultExpanded" class="mt-2 pt-2 border-t border-base-300/60">
        <p class="font-semibold text-base-content/80 mb-1">统合摘要</p>
        <MarkdownContent :content="freezeResult.summary" />
        <template v-if="freezeResult.quality">
          <p class="font-semibold text-base-content/80 mt-2 mb-1">质量评分卡</p>
          <MarkdownContent :content="freezeResult.quality" />
        </template>
      </div>
    </div>

    <p
      v-if="gateFixMessage && !gateReport"
      class="text-[11px] mb-2 whitespace-pre-wrap"
      :class="gateFixMessage.startsWith('已重写') ? 'text-success' : 'text-warning'"
    >
      {{ gateFixMessage }}
    </p>

    <div v-if="gateReport" class="mb-3 rounded-lg border border-base-300 p-2 bg-base-100 text-xs">
      <div class="flex items-center justify-between gap-2 flex-wrap mb-1">
        <p :class="gateReport.passed ? 'text-success' : 'text-warning'">
          AI 门禁：{{ gateReport.passed ? '通过' : '未通过' }}
          · 槽位 {{ gateReport.filledSlotCount }}/{{ INCUBATOR_SLOT_KEYS.length }}
        </p>
        <button
          v-if="canRunGateAutoFix"
          type="button"
          class="btn btn-outline btn-primary btn-xs"
          :disabled="applyingGateFixes || isGateRunning"
          @click="applyGateAutoFix"
        >
          {{ gateFixButtonLabel }}
        </button>
      </div>

      <div v-if="gateReport.globalAnalysis" class="my-2 p-2 bg-base-200/50 rounded text-xs text-base-content/80 whitespace-pre-wrap border-l-2 border-primary">
        <div class="font-semibold text-primary mb-1 flex items-center gap-1">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="w-3.5 h-3.5">
            <path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clip-rule="evenodd" />
          </svg>
          大纲整体逻辑分析：
        </div>
        <div>{{ gateReport.globalAnalysis }}</div>
      </div>

      <p
        v-if="gateFixMessage"
        class="text-[11px] mb-1 whitespace-pre-wrap"
        :class="gateFixMessage.startsWith('已重写') ? 'text-success' : 'text-warning'"
      >
        {{ gateFixMessage }}
      </p>
      <p v-if="canRunGateAutoFix && !applyingGateFixes" class="text-[11px] text-base-content/45 mb-1">
        门禁发现 {{ gateBlockingCount }} 个阻断 + {{ gateWarningCount }} 个警告，点击「一键修复」由 AI 重写受影响槽位（整槽覆盖，确保跨槽一致）。
      </p>
      <ul v-if="gateReport.issues?.length" class="mt-1 text-base-content/60 list-disc pl-4">
        <li v-for="(issue, i) in gateReport.issues" :key="i">{{ issue }}</li>
      </ul>
      <ul v-if="gateReport.suggestions?.length" class="mt-1 text-primary/80 list-disc pl-4">
        <li v-for="(suggestion, i) in gateReport.suggestions" :key="`s-${i}`">{{ suggestion }}</li>
      </ul>
      <div v-if="gateReport.coherence?.length" class="mt-2 space-y-1">
        <p class="text-[11px] text-base-content/50">AI 一致性定位</p>
        <div
          v-for="(item, i) in gateReport.coherence"
          :key="`c-${i}`"
          class="rounded border px-2 py-1 bg-base-200/40"
          :class="item.severity === 'blocking' ? 'border-error/40' : 'border-warning/40'"
        >
          <div class="flex items-center justify-between gap-2">
            <p class="text-[11px] font-medium">
              <span
                class="badge badge-xs mr-1"
                :class="item.severity === 'blocking' ? 'badge-error' : 'badge-warning'"
              >
                {{ item.severity === 'blocking' ? '阻断' : '警告' }}
              </span>
              {{ slotLabelOf(item.slotKey) }}：{{ item.issue }}
            </p>
            <button class="btn btn-ghost btn-xs" type="button" @click="jumpToSlot(item.slotKey)">定位</button>
          </div>
          <p
            class="text-[11px]"
            :class="item.severity === 'blocking' ? 'text-error/80' : 'text-warning/80'"
          >
            {{ item.suggestion }}
          </p>
        </div>
      </div>
    </div>

    <p class="text-xs text-base-content/40 mb-2">槽位内容编辑后自动保存（约 0.8 秒）</p>

    <div class="space-y-3 max-h-[420px] overflow-y-auto scrollbar-thin pr-1">
      <div
        v-for="slot in slots"
        :key="slot.key"
        :id="`incubator-slot-${slot.key}`"
        class="border border-base-300 rounded-lg p-2 bg-base-100"
        :class="{ 'ring-1 ring-primary/50': focusSlot === slot.key }"
      >
        <div class="flex items-center justify-between gap-2 mb-1">
          <span class="text-xs font-medium" :class="slot.filled ? 'text-primary' : 'text-base-content/50'">
            {{ slot.label }}
          </span>
          <span class="text-[11px] text-base-content/40">
            <span v-if="slotSaveState[slot.key] === 'saving' || savingSlot === slot.key">保存中...</span>
            <span v-else-if="slotSaveState[slot.key] === 'saved'" class="text-success">已保存</span>
            <span v-else-if="slotDrafts[slot.key] !== undefined">待保存...</span>
          </span>
        </div>
        <textarea
          :value="slot.content"
          rows="3"
          class="textarea textarea-bordered textarea-xs w-full resize-y min-h-[4rem] text-xs"
          :placeholder="`填写${slot.label}…`"
          @input="onSlotInput(slot.key, ($event.target as HTMLTextAreaElement).value)"
          @blur="saveSlot(slot.key, ($event.target as HTMLTextAreaElement).value)"
        />
      </div>
    </div>

    <dialog class="modal" :class="{ 'modal-open': tweakModalOpen }">
      <div class="modal-box max-w-lg">
        <h3 class="font-bold text-sm mb-2">主线微调</h3>
        <p class="text-xs text-base-content/55 mb-3">
          描述你想调整的内容，AI 会在现有主线槽位基础上合并修改（如主角/配角改名、统一称谓、删减冗余设定等）。
        </p>
        <textarea
          v-model="tweakInstructions"
          rows="5"
          class="textarea textarea-bordered textarea-sm w-full resize-y min-h-[6rem] text-xs"
          placeholder="例：主角叫林小雨，学弟男主叫陈屿；学姐配角统一叫苏婷，宿管阿姨叫王姨。把文中「女主」「男主」改为具体名字。"
          :disabled="applyingTweak"
        />
        <p
          v-if="tweakMessage"
          class="text-xs mt-2"
          :class="tweakMessage.startsWith('已更新') ? 'text-success' : 'text-warning'"
        >
          {{ tweakMessage }}
        </p>
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="applyingTweak"
            @click="closeTweakModal"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="applyingTweak || !tweakInstructions.trim()"
            @click="applyTweak"
          >
            {{ applyingTweak ? '处理中...' : '应用微调' }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop" @click="closeTweakModal">
        <button type="button">close</button>
      </form>
    </dialog>

    <dialog class="modal" :class="{ 'modal-open': gateInstructionModalOpen }">
      <div class="modal-box max-w-lg">
        <h3 class="font-bold text-sm mb-2">AI 门禁审查指令（可选）</h3>
        <p class="text-xs text-base-content/55 mb-3">
          你可以指定 AI 重点排查的逻辑漏洞、你已发现的设定冲突或指定需要严格校验的内容。留空则直接进行标准审查。
        </p>
        <textarea
          v-model="gateInstruction"
          rows="5"
          class="textarea textarea-bordered textarea-sm w-full resize-y min-h-[6rem] text-xs"
          placeholder="例：重点校验女主疯批医生的人设在第一槽和第三槽的逻辑连贯性；检查克隆文明的能量设定是否在前三章钩子中构成阻断漏洞。"
          :disabled="isGateRunning"
        />
        <div class="modal-action">
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="isGateRunning"
            @click="closeGateInstructionModal"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn-outline btn-sm"
            :disabled="isGateRunning"
            @click="triggerGateCheck(false)"
          >
            直接审查
          </button>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            :disabled="isGateRunning"
            @click="triggerGateCheck(true)"
          >
            {{ isGateRunning ? '审查中...' : '确认并开始审查' }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop" @click="closeGateInstructionModal">
        <button type="button">close</button>
      </form>
    </dialog>
  </div>
</template>
