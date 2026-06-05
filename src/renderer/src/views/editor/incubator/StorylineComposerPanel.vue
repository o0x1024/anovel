<script setup lang="ts">
import { computed, inject, ref, onBeforeUnmount } from 'vue'
import {
  INCUBATOR_SLOT_KEYS,
  INCUBATOR_SLOT_LABELS,
  isIncubatorSlotKey,
  type IncubatorSlotKey
} from '../../../../../shared/incubator-slots'
import MarkdownContent from '../../../components/MarkdownContent.vue'
import { incubatorStateKey } from './incubator-context'

const emit = defineEmits<{ saved: [] }>()
const incubator = inject(incubatorStateKey)!

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

const slots = computed(() =>
  INCUBATOR_SLOT_KEYS.map(key => {
    const active = (ws.value?.activeDraftSlots ?? []).find(s => s.slotKey === key)
    const draft = slotDrafts.value[key]
    const content = draft !== undefined ? draft : (active?.content ?? '')
    return {
      key,
      label: INCUBATOR_SLOT_LABELS[key],
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
  const v = (ws.value?.versions ?? []).find(ver => ver.id === baseId)
  return v ? `基于 V${v.versionNo} 分支编辑，冻结后将记录 lineage` : '分支编辑中'
})

function slotLabelOf(slotKey: string): string {
  return isIncubatorSlotKey(slotKey) ? INCUBATOR_SLOT_LABELS[slotKey] : slotKey
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
  return (ws.value?.activeDraftSlots ?? []).find(s => s.slotKey === key)?.content ?? ''
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

async function runGate() {
  await incubator.runGate()
  emit('saved')
}

async function freeze() {
  if (!canFreezeStoryline.value) return
  await flushPendingSlots()
  freezeResult.value = null
  freezeStage.value = '① 运行门禁校验…'
  try {
    freezeStage.value = '② 统合六槽主线（LLM 生成中，约 10-30s）…'
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
</script>

<template>
  <div class="card bg-base-200 border border-base-300 shadow-sm p-4">
    <div class="flex items-center justify-between gap-2 mb-3 flex-wrap">
      <h4 class="font-semibold text-sm">主线编排（{{ filledCount }}/6）</h4>
      <div class="flex flex-wrap gap-1">
        <button
          v-if="ws?.lastAdopt"
          type="button"
          class="btn btn-ghost btn-xs"
          :disabled="incubator.undoing"
          @click="undo"
        >
          {{ incubator.undoing ? '撤销中...' : '撤销采纳' }}
        </button>
        <button
          type="button"
          class="btn btn-outline btn-primary btn-xs"
          :disabled="incubator.gateRunning"
          @click="runGate"
        >
          {{ incubator.gateRunning ? '检查中...' : '运行门禁' }}
        </button>
        <button
          type="button"
          class="btn btn-primary btn-xs"
          :disabled="incubator.freezing || !canFreezeStoryline"
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
        <span v-if="incubator.freezing" class="loading loading-spinner loading-xs text-primary"></span>
        <span v-else class="text-success">✓</span>
        <span>{{ freezeStage }}</span>
      </div>
      <p v-if="!incubator.freezing && freezeStage" class="text-[11px] text-base-content/50 mt-1">
        统合摘要与质量评分卡已写入「版本图 → 预览」和下游核心设定 idea
      </p>
    </div>

    <div v-if="freezeResult?.summary" class="mb-3 rounded-lg border border-base-300 p-2 bg-base-100 text-xs">
      <p class="font-medium text-primary mb-1">统合摘要</p>
      <MarkdownContent :content="freezeResult.summary" />
      <template v-if="freezeResult.quality">
        <p class="font-medium text-primary mt-2 mb-1">质量评分卡</p>
        <MarkdownContent :content="freezeResult.quality" />
      </template>
    </div>

    <div v-if="gateReport" class="mb-3 rounded-lg border border-base-300 p-2 bg-base-100 text-xs">
      <p :class="gateReport.passed ? 'text-success' : 'text-warning'">
        门禁：{{ gateReport.passed ? '通过' : '未通过' }}
        · 槽位 {{ gateReport.filledSlotCount }}/6
      </p>
      <ul v-if="gateReport.issues.length" class="mt-1 text-base-content/60 list-disc pl-4">
        <li v-for="(issue, i) in gateReport.issues" :key="i">{{ issue }}</li>
      </ul>
      <ul v-if="gateReport.suggestions.length" class="mt-1 text-primary/80 list-disc pl-4">
        <li v-for="(suggestion, i) in gateReport.suggestions" :key="`s-${i}`">{{ suggestion }}</li>
      </ul>
      <div v-if="gateReport.coherence?.length" class="mt-2 space-y-1">
        <p class="text-[11px] text-base-content/50">一致性定位</p>
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
  </div>
</template>
