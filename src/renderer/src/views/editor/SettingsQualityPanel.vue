<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useBodyGenerationModel } from '../../composables/useBodyGenerationModel'
import MarkdownContent from '../../components/MarkdownContent.vue'
import FavoriteButton from '../../components/FavoriteButton.vue'
import {
  type SettingsQualityStatus,
  type QualitySeverity,
  QUALITY_SEVERITY_LEGEND,
  qualitySeverityLabel,
  qualitySeverityTitle,
  formatQualityBlockingCount,
  formatQualityAdvisoryCount
} from './editor-nav'

const props = defineProps<{ workId: number }>()
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)

const emit = defineEmits<{
  refreshed: []
  'open-anchors': []
}>()

type TabKey = 'overall' | 'characterFunction'
type ReviseType =
  | 'protagonist'
  | 'golden_finger'
  | 'pleasure_engine'
  | 'world_pressure'
  | 'conflict_engine'
  | 'supporting_cast'
  | 'character'
  | 'worldview'
  | 'conflict'

const qualityTabs: { key: TabKey; label: string }[] = [
  { key: 'overall', label: '整体自检' },
  { key: 'characterFunction', label: '角色功能矩阵' }
]
type ReviseActionKey = ReviseType | 'cards' | 'anchors' | 'cross'

interface QualityReportEntry {
  report: string
  checkedAt: string
}

interface QualityState {
  overall?: QualityReportEntry
  characterFunction?: QualityReportEntry
  checkedFingerprint?: string
}

interface ParsedSection {
  title: string
  content: string
  reviseType?: ReviseType
  action?: 'revise-cards' | 'revise-anchors' | 'revise-cross'
  severity?: QualitySeverity
}

interface ConflictCardCoverageItem {
  name: string
  role: 'protagonist' | 'supporting' | 'antagonist'
  coreConflict: string
  covered: boolean
  matchedTerms: string[]
  reason: string
}

interface ConflictCardCoverageReport {
  hasConflict: boolean
  hasCards: boolean
  totalCards: number
  coveredCount: number
  missingCount: number
  fullyCovered: boolean
  missingItems: ConflictCardCoverageItem[]
  items: ConflictCardCoverageItem[]
}

const tab = ref<TabKey>('overall')
const state = ref<QualityState>({})
const status = ref<SettingsQualityStatus | null>(null)
const overallSections = ref<ParsedSection[]>([])
const conflictCoverage = ref<ConflictCardCoverageReport | null>(null)
const conflictSuggestLoading = ref(false)
const conflictSuggestContent = ref('')
const conflictApplyLoading = ref(false)
const expanded = ref(false)
const reportExpanded = ref(false)
const overallLoading = ref(false)
const characterLoading = ref(false)
const reviseAllLoading = ref(false)
const reviseAdvisoryAllLoading = ref(false)
const acceptLoading = ref(false)
const reviseLoading = ref<ReviseActionKey | null>(null)
const reviseSection = ref<string | null>(null)
const successMsg = ref('')
const error = ref('')

const activeReport = computed(() =>
  tab.value === 'overall' ? state.value.overall : state.value.characterFunction
)

const canReviseBlocking = computed(() =>
  tab.value === 'overall' && !!status.value?.canReviseBlocking
)

const canReviseAdvisory = computed(() =>
  tab.value === 'overall' && !!status.value?.canReviseAdvisory
)

const canAcceptPass = computed(() =>
  tab.value === 'overall'
  && !!status.value?.hasOverallCheck
  && !status.value?.isStale
  && !status.value?.canProceed
)

const qualityMetrics = computed(() => {
  const s = status.value
  if (!s?.hasOverallCheck || s.isStale) return null
  const parts: string[] = []
  if (s.overallScore != null) parts.push(`总分 ${s.overallScore}`)
  if (s.blockingCount > 0) parts.push(formatQualityBlockingCount(s.blockingCount))
  if (s.advisoryCount > 0) parts.push(formatQualityAdvisoryCount(s.advisoryCount))
  if (s.reviseRound > 0) parts.push(`已修订 ${s.reviseRound}/${s.maxReviseRounds} 轮`)
  return parts.length ? parts.join(' · ') : null
})

const convergenceHint = computed(() => {
  const s = status.value
  if (!s || s.canProceed) return ''
  if (s.convergenceStalled) {
    return '自动修订后不合格项未明显减少，建议人工审阅或使用「接受当前设定并标记通过」。'
  }
  if (s.reviseRound >= s.maxReviseRounds && s.blockingCount > 0) {
    return `已达最大自动修订轮次（${s.maxReviseRounds}），可人工处理剩余问题后接受通过。`
  }
  return ''
})

const staleBanner = computed(() => {
  if (!status.value?.isStale) return ''
  return '设定内容已变更，报告基于自检时的版本。仍可继续按建议修订；修订不合格项完成后将自动重新自检。'
})

const panelSummary = computed(() => {
  const report = activeReport.value
  if (report?.report && tab.value === 'overall' && qualityMetrics.value) {
    return `${qualityMetrics.value} · ${formatTime(report.checkedAt)}`
  }
  if (report?.report) {
    const summary = reportSummary(report.report)
    return `${summary} · ${formatTime(report.checkedAt)}`
  }
  if (status.value?.needsReview) return '待运行自检'
  return tab.value === 'overall' ? '尚未运行整体自检' : '尚未运行角色功能检查'
})

onMounted(loadState)

const workType = ref<string | null>(null)

async function loadState() {
  const work = await window.anovel.invoke('work:get', props.workId)
  workType.value = work?.work_type ?? null

  state.value = await window.anovel.invoke('settingsQuality:getState', props.workId) as QualityState
  status.value = await window.anovel.invoke('settingsQuality:getStatus', props.workId) as SettingsQualityStatus
  conflictCoverage.value = await window.anovel.invoke(
    'settingsQuality:getConflictCardCoverage',
    props.workId
  ) as ConflictCardCoverageReport
  if (!conflictCoverage.value?.hasConflict || conflictCoverage.value.fullyCovered) {
    conflictSuggestContent.value = ''
  }
  if (state.value.overall?.report) {
    overallSections.value = await window.anovel.invoke(
      'settingsQuality:parseSections',
      props.workId,
      state.value.overall.report
    ) as ParsedSection[]
  } else {
    overallSections.value = []
  }
}

function roleLabel(role: ConflictCardCoverageItem['role']): string {
  if (role === 'protagonist') return '主角'
  if (role === 'antagonist') return '反派'
  return '配角'
}

async function suggestConflictCoverageFix() {
  if (conflictSuggestLoading.value) return
  conflictSuggestLoading.value = true
  error.value = ''
  successMsg.value = ''
  try {
    const res = await window.anovel.invoke(
      'settingsQuality:suggestConflictCoverageFix',
      props.workId,
      bodyModelParams()
    ) as { success: boolean; content?: string; error?: string }
    if (res.success && res.content?.trim()) {
      conflictSuggestContent.value = res.content.trim()
      successMsg.value = '已生成冲突补齐建议，可按下方内容修订核心冲突'
    } else {
      error.value = res.error || '生成补齐建议失败'
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    conflictSuggestLoading.value = false
  }
}

async function applyConflictCoverageFix() {
  if (conflictApplyLoading.value) return
  if (!conflictSuggestContent.value.trim()) {
    error.value = '暂无可应用的补齐建议，请先生成建议'
    return
  }
  conflictApplyLoading.value = true
  error.value = ''
  successMsg.value = ''
  try {
    const res = await window.anovel.invoke(
      'settingsQuality:applyConflictCoverageFix',
      props.workId,
      conflictSuggestContent.value
    ) as { success: boolean; error?: string }
    if (res.success) {
      successMsg.value = '已将补齐建议应用到核心冲突，请按需运行整体自检'
      emit('refreshed')
      await loadState()
    } else {
      error.value = res.error || '应用补齐建议失败'
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    conflictApplyLoading.value = false
  }
}

function formatTime(iso?: string): string {
  if (!iso) return '尚未检查'
  return iso.replace('T', ' ').slice(0, 16)
}

function reportSummary(report: string): string {
  const line = report.split('\n').find(l => l.trim())?.trim() ?? ''
  return line.replace(/^#+\s*/, '') || '检查报告'
}

async function runOverallCheck() {
  if (overallLoading.value) return
  overallLoading.value = true
  error.value = ''
  successMsg.value = ''
  try {
    const res = await window.anovel.invoke('settingsQuality:runOverallCheck', props.workId, bodyModelParams()) as {
      success: boolean
      error?: string
    }
    if (res.success) {
      await loadState()
      expanded.value = true
      reportExpanded.value = true
      successMsg.value = '整体自检已完成'
      emit('refreshed')
    } else {
      error.value = res.error || '自检失败'
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    overallLoading.value = false
  }
}

async function runCharacterFunctionCheck() {
  if (characterLoading.value) return
  characterLoading.value = true
  error.value = ''
  successMsg.value = ''
  try {
    const res = await window.anovel.invoke('settingsQuality:runCharacterFunctionCheck', props.workId, bodyModelParams()) as {
      success: boolean
      error?: string
    }
    if (res.success) {
      await loadState()
      tab.value = 'characterFunction'
      expanded.value = true
      reportExpanded.value = true
      successMsg.value = '角色功能检查已完成'
      emit('refreshed')
    } else {
      error.value = res.error || '检查失败'
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    characterLoading.value = false
  }
}

async function reviseAndApply(
  type: ReviseType,
  sectionTitle?: string,
  mode: 'fix' | 'optimize' = 'fix'
) {
  const report = tab.value === 'overall'
    ? state.value.overall?.report
    : state.value.characterFunction?.report
  if (!report?.trim() || reviseLoading.value || reviseAllLoading.value || reviseAdvisoryAllLoading.value) return

  reviseLoading.value = type
  reviseSection.value = sectionTitle ?? null
  error.value = ''
  successMsg.value = ''
  try {
    const res = await window.anovel.invoke(
      'settingsQuality:reviseSetting',
      props.workId,
      type,
      report,
      sectionTitle,
      mode,
      bodyModelParams()
    ) as { success: boolean; content?: string; error?: string }

    if (res.success && res.content?.trim()) {
      await window.anovel.invoke('setting:upsert', props.workId, type, res.content.trim())
      const labelMap: Record<string, string> = {
        character: '人设',
        worldview: '世界观',
        conflict: '核心冲突',
        protagonist: workType.value === 'story' ? '主角与反差设定' : '主角设计',
        golden_finger: workType.value === 'story' ? '核心钩子与信息差' : '金手指系统',
        pleasure_engine: workType.value === 'story' ? '情绪节奏与爽点' : '爽点机制',
        world_pressure: '世界观压力规则',
        conflict_engine: '冲突升级引擎',
        supporting_cast: workType.value === 'story' ? '功能性配角' : '配角功能组'
      }
      const label = labelMap[type] || type
      successMsg.value = mode === 'optimize' ? `已应用${label}优化` : `已应用${label}修订`
      emit('refreshed')
      await loadState()
    } else {
      error.value = res.error || '修订失败'
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    reviseLoading.value = null
    reviseSection.value = null
  }
}

async function reviseCharacterCards(sectionTitle?: string) {
  const report = state.value.overall?.report
  if (!report?.trim() || reviseLoading.value || reviseAllLoading.value) return

  reviseLoading.value = 'cards'
  reviseSection.value = sectionTitle ?? null
  error.value = ''
  successMsg.value = ''
  try {
    const res = await window.anovel.invoke(
      'settingsQuality:reviseCharacterCards',
      props.workId,
      report,
      sectionTitle,
      bodyModelParams()
    ) as { success: boolean; error?: string }

    if (res.success) {
      successMsg.value = '已应用人设卡片修订'
      emit('refreshed')
      await loadState()
    } else {
      error.value = res.error || '卡片修订失败'
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    reviseLoading.value = null
    reviseSection.value = null
  }
}

async function reviseAnchors(sectionTitle?: string) {
  const report = state.value.overall?.report
  if (!report?.trim() || reviseLoading.value || reviseAllLoading.value) return

  reviseLoading.value = 'anchors'
  reviseSection.value = sectionTitle ?? null
  error.value = ''
  successMsg.value = ''
  try {
    const res = await window.anovel.invoke(
      'settingsQuality:reviseAnchors',
      props.workId,
      report,
      sectionTitle,
      bodyModelParams()
    ) as { success: boolean; count?: number; error?: string }

    if (res.success) {
      successMsg.value = res.count ? `已应用 ${res.count} 个锚点修订` : '已应用锚点修订'
      emit('refreshed')
      await loadState()
    } else {
      error.value = res.error || '锚点修订失败'
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    reviseLoading.value = null
    reviseSection.value = null
  }
}

async function reviseCross(sectionTitle?: string) {
  const report = state.value.overall?.report
  if (!report?.trim() || reviseLoading.value || reviseAllLoading.value) return

  reviseLoading.value = 'cross'
  reviseSection.value = sectionTitle ?? null
  error.value = ''
  successMsg.value = ''
  try {
    const res = await window.anovel.invoke(
      'settingsQuality:reviseCross',
      props.workId,
      report,
      sectionTitle,
      bodyModelParams()
    ) as { success: boolean; revised?: string[]; error?: string }

    if (res.success && res.revised?.length) {
      const labels: Record<string, string> = {
        character: '人设',
        worldview: '世界观',
        conflict: '核心冲突',
        protagonist: workType.value === 'story' ? '主角与反差设定' : '主角设计',
        golden_finger: workType.value === 'story' ? '核心钩子与信息差' : '金手指系统',
        pleasure_engine: workType.value === 'story' ? '情绪节奏与爽点' : '爽点机制',
        world_pressure: '世界观压力规则',
        conflict_engine: '冲突升级引擎',
        supporting_cast: workType.value === 'story' ? '功能性配角' : '配角功能组'
      }
      const names = res.revised.map(k => labels[k] ?? k).join('、')
      successMsg.value = `已应用跨设定修订：${names}`
      emit('refreshed')
      await loadState()
    } else {
      error.value = res.error || '跨设定修订失败'
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    reviseLoading.value = null
    reviseSection.value = null
  }
}

async function reviseAdvisoryAll() {
  if (reviseAdvisoryAllLoading.value || !status.value?.canReviseAdvisory) return
  const n = status.value.advisoryOptimizeCount
  if (!confirm(`将按自检报告依次优化 ${n} 个及格项，完成后自动重新自检。是否继续？`)) return

  reviseAdvisoryAllLoading.value = true
  error.value = ''
  successMsg.value = ''
  try {
    const res = await window.anovel.invoke('settingsQuality:reviseAdvisoryAll', props.workId, bodyModelParams()) as {
      success: boolean
      revised?: string[]
      errors?: string[]
      recheckSuccess?: boolean
      advisoryCount?: number
      error?: string
    }

    if (res.revised?.length) {
      const labels: Record<string, string> = {
        character: '人设',
        worldview: '世界观',
        conflict: '核心冲突',
        character_cards: '人设卡片',
        anchors: '锚点',
        cross_settings: '跨设定',
        protagonist: workType.value === 'story' ? '主角与反差设定' : '主角设计',
        golden_finger: workType.value === 'story' ? '核心钩子与信息差' : '金手指系统',
        pleasure_engine: workType.value === 'story' ? '情绪节奏与爽点' : '爽点机制',
        world_pressure: '世界观压力规则',
        conflict_engine: '冲突升级引擎',
        supporting_cast: workType.value === 'story' ? '功能性配角' : '配角功能组'
      }
      const names = res.revised.map(k => labels[k] ?? k).join('、')
      expanded.value = true
      reportExpanded.value = true
      emit('refreshed')
      await loadState()

      let msg = res.recheckSuccess
        ? `已优化 ${names}，并已完成重新自检`
        : `已优化 ${names}，请手动重新运行整体自检`
      if (res.advisoryCount != null && res.advisoryCount > 0) {
        msg += `；仍有 ${res.advisoryCount} 个及格·待优化项`
      } else if (res.recheckSuccess) {
        msg += '；各维度已达优秀'
      }
      successMsg.value = msg
    }

    if (res.errors?.length) {
      error.value = res.errors.join('；')
    } else if (!res.success && !res.revised?.length) {
      error.value = res.error || '优化及格项失败'
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    reviseAdvisoryAllLoading.value = false
  }
}

async function reviseBlocking() {
  if (reviseAllLoading.value || reviseAdvisoryAllLoading.value || !status.value?.canReviseBlocking) return
  const n = status.value.blockingCount
  if (!confirm(`将按自检报告依次修订 ${n} 个不合格项，完成后自动重新自检。是否继续？`)) return

  reviseAllLoading.value = true
  error.value = ''
  successMsg.value = ''
  try {
    const res = await window.anovel.invoke('settingsQuality:reviseAll', props.workId, bodyModelParams()) as {
      success: boolean
      revised?: string[]
      errors?: string[]
      recheckSuccess?: boolean
      convergenceStalled?: boolean
      blockingCount?: number
      error?: string
    }

    if (res.revised?.length) {
      const labels: Record<string, string> = {
        character: '人设',
        worldview: '世界观',
        conflict: '核心冲突',
        character_cards: '人设卡片',
        anchors: '锚点',
        cross_settings: '跨设定',
        protagonist: workType.value === 'story' ? '主角与反差设定' : '主角设计',
        golden_finger: workType.value === 'story' ? '核心钩子与信息差' : '金手指系统',
        pleasure_engine: workType.value === 'story' ? '情绪节奏与爽点' : '爽点机制',
        world_pressure: '世界观压力规则',
        conflict_engine: '冲突升级引擎',
        supporting_cast: workType.value === 'story' ? '功能性配角' : '配角功能组'
      }
      const names = res.revised.map(k => labels[k] ?? k).join('、')
      expanded.value = true
      reportExpanded.value = true
      emit('refreshed')
      await loadState()

      let msg = res.recheckSuccess
        ? `已修订 ${names}，并已完成重新自检`
        : `已修订 ${names}，请手动重新运行整体自检`
      if (res.convergenceStalled && !status.value?.canProceed) {
        msg += '；不合格项未明显减少，可人工审阅后使用「接受当前设定并标记通过」'
      } else if (res.convergenceStalled && status.value?.canProceed) {
        msg += '；自动修订未继续收敛，但当前自检已达标，可直接进入下一步'
      } else if (res.blockingCount != null && res.blockingCount > 0) {
        msg += `；仍有 ${res.blockingCount} 个不合格项`
      }
      successMsg.value = msg
    }

    if (res.errors?.length) {
      error.value = res.errors.join('；')
    } else if (!res.success && !res.revised?.length) {
      error.value = res.error || '修订不合格项失败'
    } else if (res.error && res.revised?.length && !status.value?.canProceed) {
      error.value = res.error
    } else if (status.value?.canProceed) {
      error.value = ''
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    reviseAllLoading.value = false
  }
}

async function acceptPass() {
  if (acceptLoading.value || !canAcceptPass.value) return
  if (!confirm('将接受当前设定并标记通过，允许进入下一步。是否继续？')) return

  acceptLoading.value = true
  error.value = ''
  successMsg.value = ''
  try {
    const res = await window.anovel.invoke('settingsQuality:acceptPass', props.workId) as {
      success: boolean
      error?: string
    }
    if (res.success) {
      successMsg.value = '已接受当前设定并标记通过'
      emit('refreshed')
      await loadState()
    } else {
      error.value = res.error || '操作失败'
    }
  } catch (e) {
    error.value = String(e)
  } finally {
    acceptLoading.value = false
  }
}

function sectionCanOptimize(section: ParsedSection): boolean {
  if (!section.severity || section.severity === 'none') return false
  return !!(
    section.reviseType
    || section.action === 'revise-cards'
    || section.action === 'revise-anchors'
    || section.action === 'revise-cross'
  )
}

function sectionReviseMode(section: ParsedSection): 'fix' | 'optimize' {
  return section.severity === 'advisory' ? 'optimize' : 'fix'
}

function isAnchorSection(section: ParsedSection): boolean {
  return section.title.includes('锚点')
}

function severityBadgeClass(severity?: QualitySeverity): string {
  if (severity === 'blocking') return 'badge-error'
  if (severity === 'advisory') return 'badge-warning'
  if (severity === 'none') return 'badge-success'
  return 'badge-ghost'
}

function handleSectionAction(section: ParsedSection) {
  if (!sectionCanOptimize(section)) return
  const mode = sectionReviseMode(section)
  if (section.reviseType) {
    void reviseAndApply(section.reviseType, section.title, mode)
  } else if (section.action === 'revise-cards') {
    void reviseCharacterCards(section.title)
  } else if (section.action === 'revise-anchors') {
    void reviseAnchors(section.title)
  } else if (section.action === 'revise-cross') {
    void reviseCross(section.title)
  }
}

function sectionActionLabel(section: ParsedSection): string {
  const verb = section.severity === 'advisory' ? '优化' : '修订'
  if (section.reviseType) {
    const labels: Record<ReviseType, string> = {
      character: `按建议${verb}人设`,
      worldview: `按建议${verb}世界观`,
      conflict: `按建议${verb}冲突`,
      protagonist: `按建议${verb}${workType.value === 'story' ? '主角与反差设定' : '主角设计'}`,
      golden_finger: `按建议${verb}${workType.value === 'story' ? '核心钩子与信息差' : '金手指系统'}`,
      pleasure_engine: `按建议${verb}${workType.value === 'story' ? '情绪节奏与爽点' : '爽点机制'}`,
      world_pressure: `按建议${verb}世界观压力规则`,
      conflict_engine: `按建议${verb}冲突升级引擎`,
      supporting_cast: `按建议${verb}${workType.value === 'story' ? '功能性配角' : '配角功能组'}`
    }
    return labels[section.reviseType]
  }
  if (section.action === 'revise-cards') return `按建议${verb}卡片`
  if (section.action === 'revise-anchors') return `按建议${verb}锚点`
  if (section.action === 'revise-cross') return `按建议${verb}跨设定`
  return ''
}

function sectionActionButtonClass(section: ParsedSection): string {
  if (section.severity === 'advisory') return 'btn btn-outline btn-warning btn-xs'
  return 'btn btn-outline btn-primary btn-xs'
}

function isSectionLoading(section: ParsedSection): boolean {
  if (reviseSection.value !== section.title) return false
  if (section.action === 'revise-cards') return reviseLoading.value === 'cards'
  if (section.action === 'revise-anchors') return reviseLoading.value === 'anchors'
  if (section.action === 'revise-cross') return reviseLoading.value === 'cross'
  return reviseLoading.value === section.reviseType
}

const isBusy = computed(() =>
  !!reviseLoading.value || reviseAllLoading.value || reviseAdvisoryAllLoading.value || acceptLoading.value
    || overallLoading.value || characterLoading.value || conflictSuggestLoading.value || conflictApplyLoading.value
)

defineExpose({
  load: loadState,
  expandPanel: () => {
    expanded.value = true
  }
})
</script>

<template>
  <div class="card bg-base-200 border border-base-300 shadow-sm p-4 mt-4">
    <div class="flex items-start justify-between mb-2 flex-wrap gap-2">
      <div>
        <h4 class="font-semibold flex items-center gap-2">
          <font-awesome-icon icon="clipboard-check" class="w-3.5 h-3.5 text-primary shrink-0" />
          设定质量中心
          <span v-if="status?.canProceed" class="badge badge-success badge-xs">
            {{ status.manuallyAccepted ? '已接受' : '已通过' }}
          </span>
          <span v-else-if="status?.isStale" class="badge badge-warning badge-xs">已过期</span>
          <span v-else-if="status?.blockingCount" class="badge badge-error badge-xs">
            不合格 {{ status.blockingCount }}
          </span>
          <span v-else-if="status?.needsReview" class="badge badge-info badge-xs">待自检</span>
        </h4>
        <p class="text-xs text-base-content/40 mt-0.5">
          整体自检 · 角色功能 · 锚点对齐 · 卡片一致性（与生成/门禁/一致性报告联动）
        </p>
        <p class="text-[11px] text-base-content/35 mt-0.5">{{ QUALITY_SEVERITY_LEGEND }}</p>
      </div>
      <div class="flex gap-2 shrink-0 flex-wrap justify-end">
        <button
          v-if="tab === 'overall' && canReviseBlocking"
          type="button"
          class="btn btn-primary btn-xs gap-1"
          :disabled="isBusy"
          @click="reviseBlocking"
        >
          <font-awesome-icon
            :icon="reviseAllLoading ? 'spinner' : 'pen-nib'"
            :spin="reviseAllLoading"
            class="w-3 h-3"
          />
          {{ reviseAllLoading ? '修订中...' : `修订不合格项 (${status?.blockingCount ?? 0})` }}
        </button>
        <button
          v-if="tab === 'overall' && canReviseAdvisory"
          type="button"
          class="btn btn-outline btn-warning btn-xs gap-1"
          :disabled="isBusy"
          @click="reviseAdvisoryAll"
        >
          <font-awesome-icon
            :icon="reviseAdvisoryAllLoading ? 'spinner' : 'wand-magic-sparkles'"
            :spin="reviseAdvisoryAllLoading"
            class="w-3 h-3"
          />
          {{ reviseAdvisoryAllLoading ? '优化中...' : `优化及格项 (${status?.advisoryOptimizeCount ?? 0})` }}
        </button>
        <button
          v-if="tab === 'overall' && canAcceptPass"
          type="button"
          class="btn btn-outline btn-success btn-xs"
          :disabled="isBusy"
          @click="acceptPass"
        >
          {{ acceptLoading ? '处理中...' : '接受当前设定并标记通过' }}
        </button>
        <button
          type="button"
          class="btn btn-outline btn-primary btn-xs"
          :disabled="isBusy"
          @click="tab === 'overall' ? runOverallCheck() : runCharacterFunctionCheck()"
        >
          {{
            tab === 'overall'
              ? (overallLoading ? '自检中...' : '运行整体自检')
              : (characterLoading ? '检查中...' : '运行角色功能检查')
          }}
        </button>
      </div>
    </div>

    <div v-if="successMsg" class="alert alert-success text-xs py-2 mb-2">{{ successMsg }}</div>
    <div v-if="error" class="alert alert-error text-xs py-2 mb-2">{{ error }}</div>

    <button
      type="button"
      class="w-full flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-base-100/80 transition-colors"
      @click="expanded = !expanded"
    >
      <span class="text-xs text-base-content/60 truncate">{{ panelSummary }}</span>
      <font-awesome-icon
        :icon="expanded ? 'chevron-up' : 'chevron-down'"
        class="w-3 h-3 shrink-0 text-base-content/40"
      />
    </button>

    <div v-show="expanded" class="mt-2 pt-2 border-t border-base-300/50">
    <div role="tablist" class="tabs tabs-box tabs-sm w-fit mb-4 bg-base-300/45" aria-label="质量检查类型">
      <a
        v-for="item in qualityTabs"
        :key="item.key"
        role="tab"
        href="#"
        class="tab"
        :class="{ 'tab-active': tab === item.key }"
        :aria-selected="tab === item.key"
        @click.prevent="tab = item.key"
      >
        {{ item.label }}
      </a>
    </div>

    <div v-if="staleBanner" class="alert alert-warning text-xs py-2 mb-2">{{ staleBanner }}</div>
    <div v-if="convergenceHint" class="alert alert-info text-xs py-2 mb-2">{{ convergenceHint }}</div>
    <div
      v-if="tab === 'overall' && conflictCoverage && conflictCoverage.hasCards && workType !== 'story'"
      class="rounded-lg border border-base-300/60 bg-base-100/70 p-3 mb-2"
    >
      <div class="flex items-center justify-between gap-2 mb-1 flex-wrap">
        <p class="text-xs font-medium text-base-content/70">核心冲突 × 人设卡映射</p>
        <div class="flex items-center gap-2">
          <span
            class="badge badge-xs"
            :class="conflictCoverage.fullyCovered ? 'badge-success' : 'badge-warning'"
          >
            {{ conflictCoverage.coveredCount }}/{{ conflictCoverage.totalCards }}
          </span>
          <button
            v-if="conflictCoverage.hasConflict && conflictCoverage.missingCount > 0"
            type="button"
            class="btn btn-outline btn-primary btn-xs"
            :disabled="isBusy"
            @click="suggestConflictCoverageFix"
          >
            {{ conflictSuggestLoading ? '生成中...' : '生成补齐建议' }}
          </button>
        </div>
      </div>
      <p v-if="!conflictCoverage.hasConflict" class="text-xs text-warning">
        尚未填写核心冲突，暂无法评估映射情况。
      </p>
      <template v-else>
        <p v-if="conflictCoverage.fullyCovered" class="text-xs text-success">
          所有角色卡的核心矛盾都已在核心冲突中体现。
        </p>
        <div v-else class="space-y-1.5">
          <p class="text-xs text-warning">
            {{ conflictCoverage.missingCount }} 个角色矛盾尚未映射到核心冲突：
          </p>
          <div
            v-for="item in conflictCoverage.missingItems.slice(0, 6)"
            :key="`${item.name}-${item.role}`"
            class="text-xs bg-base-200/70 rounded px-2 py-1.5"
          >
            <span class="font-medium">{{ item.name }}</span>
            <span class="text-base-content/50">（{{ roleLabel(item.role) }}）</span>
            <p class="text-base-content/70 mt-0.5">{{ item.reason }}</p>
            <p v-if="item.coreConflict" class="text-base-content/55 mt-0.5 line-clamp-2">
              卡片矛盾：{{ item.coreConflict }}
            </p>
          </div>
        </div>
      </template>
      <div
        v-if="conflictSuggestContent && conflictCoverage.hasConflict && conflictCoverage.missingCount > 0"
        class="mt-2 pt-2 border-t border-base-300/50"
      >
        <div class="flex items-center justify-between gap-2 mb-1 flex-wrap">
          <p class="text-xs font-medium text-base-content/60">AI 补齐建议</p>
          <button
            type="button"
            class="btn btn-primary btn-xs"
            :disabled="isBusy"
            @click="applyConflictCoverageFix"
          >
            {{ conflictApplyLoading ? '应用中...' : '一键应用到核心冲突' }}
          </button>
        </div>
        <div class="rounded-md border border-base-300/60 p-2 bg-base-100">
          <MarkdownContent :content="conflictSuggestContent" size="sm" />
        </div>
      </div>
    </div>

    <div class="flex items-center justify-between text-xs text-base-content/50 mb-2 flex-wrap gap-2">
      <span>
        最近检查 {{ formatTime(activeReport?.checkedAt) }}
        <template v-if="status && tab === 'overall' && !status.isStale && status.hasOverallCheck">
          <span v-if="status.overallScore != null" class="ml-1">· 总分 {{ status.overallScore }}</span>
          <span v-if="status.blockingCount" class="text-error ml-1">· 不合格 {{ status.blockingCount }}</span>
          <span v-else-if="status.advisoryCount" class="text-warning ml-1">· 及格·待优化 {{ status.advisoryCount }}</span>
        </template>
        <span v-else-if="status?.unresolvedIssues.length && tab === 'overall'" class="text-warning ml-1">
          · {{ status.unresolvedIssues.length }} 条未决问题
        </span>
      </span>
      <div class="flex items-center gap-2 shrink-0">
        <button
          v-if="tab === 'characterFunction' && activeReport?.report"
          type="button"
          class="btn btn-primary btn-xs gap-1"
          :disabled="isBusy"
          @click="reviseAndApply('character')"
        >
          <font-awesome-icon
            :icon="reviseLoading === 'character' ? 'spinner' : 'pen-nib'"
            :spin="reviseLoading === 'character'"
            class="w-3 h-3"
          />
          {{ reviseLoading === 'character' ? '修订中...' : '按建议修订人设' }}
        </button>
        <FavoriteButton
          v-if="activeReport?.report"
          :work-id="workId"
          :source-step="tab === 'overall' ? 'settings_overall_check' : 'settings_character_check'"
          :source-label="tab === 'overall' ? '设定整体自检' : '角色功能检查'"
          :content="activeReport.report"
          size="xs"
        />
      </div>
    </div>

    <div
      v-if="tab === 'overall' && overallSections.length && activeReport?.report"
      class="mb-3 pt-2 border-t border-base-300/50 space-y-2"
    >
      <p class="text-xs font-medium text-base-content/50">分块操作（不及格可修订，及格可优化）</p>
      <div
        v-for="section in overallSections"
        :key="section.title"
        class="flex items-start justify-between gap-2 text-xs bg-base-200/60 rounded-lg px-3 py-2"
      >
        <div class="min-w-0">
          <span class="font-medium">{{ section.title }}</span>
          <span
            v-if="section.severity && qualitySeverityLabel(section.severity)"
            class="badge badge-xs ml-1.5 align-middle"
            :class="severityBadgeClass(section.severity)"
            :title="qualitySeverityTitle(section.severity)"
          >
            {{ qualitySeverityLabel(section.severity) }}
          </span>
          <p v-if="section.content" class="text-base-content/60 mt-0.5 line-clamp-2">{{ section.content }}</p>
        </div>
        <div class="flex gap-1 shrink-0 flex-wrap justify-end">
          <button
            v-if="sectionCanOptimize(section)"
            type="button"
            :class="sectionActionButtonClass(section)"
            :disabled="isBusy"
            @click="handleSectionAction(section)"
          >
            {{ isSectionLoading(section) ? '处理中...' : sectionActionLabel(section) }}
          </button>
          <button
            v-if="isAnchorSection(section)"
            type="button"
            class="btn btn-ghost btn-xs"
            :disabled="isBusy"
            @click="emit('open-anchors')"
          >
            查看锚点
          </button>
        </div>
      </div>
    </div>

    <div v-if="activeReport?.report">
      <button
        type="button"
        class="w-full flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-base-100/80 transition-colors"
        @click="reportExpanded = !reportExpanded"
      >
        <span class="text-xs text-base-content/60 truncate">{{ reportSummary(activeReport.report) }}</span>
        <font-awesome-icon
          :icon="reportExpanded ? 'chevron-up' : 'chevron-down'"
          class="w-3 h-3 shrink-0 text-base-content/40"
        />
      </button>
      <div v-show="reportExpanded" class="mt-2 rounded-lg border border-base-300/60 p-3 bg-base-100">
        <MarkdownContent :content="activeReport.report" size="sm" />
      </div>
    </div>
    <p v-else class="text-sm text-base-content/40 italic">
      {{ tab === 'overall' ? '尚未运行整体自检' : '尚未运行角色功能检查' }}
    </p>
    </div>
  </div>
</template>
