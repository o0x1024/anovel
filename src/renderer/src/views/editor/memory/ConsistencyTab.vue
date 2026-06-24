<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { toPlainForIpc } from '../../../../../shared/ipc-plain'

import { useBodyGenerationModel } from '../../../composables/useBodyGenerationModel'

const props = defineProps<{ workId: number }>()
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)

interface Report {
  foreshadowing: {
    total: number
    resolved: number
    pending: number
    recoveryRate: number
    deepPending: number
  }
  characters: { trackedCount: number; snapshotCount: number }
  timeline: { eventCount: number }
  chapters: { withContent: number; withOutline: number; avgEmotionIntensity: number }
  alignment: { recentChecks: number; misalignedCount: number }
  settingsQuality?: {
    hasCheck: boolean
    isStale: boolean
    issueCount: number
    checkedAt: string | null
  }
  settingsQualityIssues?: string[]
  warnings: string[]
  rhythmHints: string[]
}

interface AuditIssue {
  dimension: string
  severity: 'blocking' | 'warning' | 'info'
  evidence: string
  suggestion: string
}

interface AuditResult {
  verdict: 'pass' | 'warning' | 'blocking'
  driftScore: number
  summary: string
  strengths: string[]
  issues: AuditIssue[]
}

interface MonitorResult {
  foreshadowingRecoveryRate: number
  deepForeshadowingPending: number
  charactersLongAbsent: { name: string; chaptersAgo: number }[]
  newCharacterRate: number
  emotionFlatStreak: number
}

const report = ref<Report | null>(null)
const loading = ref(false)
const crossIssues = ref<{ severity: string; chapterTitle?: string; message: string }[]>([])
const scanning = ref(false)
const auditing = ref(false)
const auditResult = ref<AuditResult | null>(null)
const monitor = ref<MonitorResult | null>(null)
const auditError = ref('')
const auditStats = ref<{ scanned: number; deep: number } | null>(null)
const fixing = ref(false)
const fixMsg = ref('')

onMounted(refresh)

async function runCrossScan() {
  scanning.value = true
  try {
    crossIssues.value = await window.anovel.invoke('narrative:crossChapterScan', props.workId) as typeof crossIssues.value
  } finally {
    scanning.value = false
  }
}

async function runAutoFix() {
  if (!auditResult.value?.issues.length || fixing.value) return
  fixing.value = true
  fixMsg.value = ''
  try {
    const res = await window.anovel.invoke('milestone:autoFix', props.workId, toPlainForIpc(auditResult.value.issues), bodyModelParams()) as {
      success: boolean
      chapterPatchesApplied?: number
      patchedChapterIds?: number[]
      foreshadowingApplied?: number
      advice?: string | null
      error?: string
    }
    if (res.success) {
      const parts: string[] = []
      if (res.chapterPatchesApplied) parts.push(`已修复 ${res.chapterPatchesApplied} 处章节正文`)
      if (res.foreshadowingApplied) parts.push(`标记 ${res.foreshadowingApplied} 条伏笔`)
      if (res.advice) parts.push(`建议：${res.advice}`)
      fixMsg.value = parts.join(' · ')
      if (res.chapterPatchesApplied) {
        await refresh()
      }
    } else {
      fixMsg.value = res.error || '修复失败'
    }
  } catch (e) {
    fixMsg.value = String(e)
  } finally {
    fixing.value = false
  }
}

async function runAudit() {
  auditing.value = true
  auditError.value = ''
  auditResult.value = null
  monitor.value = null
  try {
    const res = await window.anovel.invoke('milestone:audit', props.workId, bodyModelParams()) as {
      success: boolean
      audit?: AuditResult
      monitor?: MonitorResult
      scannedChapters?: number
      deepDivedChapters?: number
      error?: string
    }
    if (res.success) {
      auditResult.value = res.audit ?? null
      monitor.value = res.monitor ?? null
      auditStats.value = res.scannedChapters ? { scanned: res.scannedChapters, deep: res.deepDivedChapters ?? 0 } : null
    } else {
      auditError.value = res.error || '审计失败'
    }
  } catch (e) {
    auditError.value = String(e)
  } finally {
    auditing.value = false
  }
}

async function refresh() {
  loading.value = true
  try {
    report.value = await window.anovel.invoke('narrative:consistencyReport', props.workId) as Report
  } finally {
    loading.value = false
  }
}

defineExpose({ refresh })
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <p class="text-sm text-base-content/50">作品一致性摘要：伏笔回收、角色追踪、时间线、情绪节奏。</p>
      <button class="btn btn-outline btn-sm" :disabled="loading" @click="refresh">
        {{ loading ? '刷新中...' : '刷新报告' }}
      </button>
    </div>

    <div v-if="report" class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="stat bg-base-100 border border-base-300 rounded-lg p-3">
        <div class="stat-title text-xs">伏笔回收率</div>
        <div class="stat-value text-lg">{{ report.foreshadowing.recoveryRate }}%</div>
        <div class="stat-desc text-xs">待回收 {{ report.foreshadowing.pending }}</div>
      </div>
      <div class="stat bg-base-100 border border-base-300 rounded-lg p-3">
        <div class="stat-title text-xs">追踪角色</div>
        <div class="stat-value text-lg">{{ report.characters.trackedCount }}</div>
        <div class="stat-desc text-xs">{{ report.characters.snapshotCount }} 条快照</div>
      </div>
      <div class="stat bg-base-100 border border-base-300 rounded-lg p-3">
        <div class="stat-title text-xs">时间线事件</div>
        <div class="stat-value text-lg">{{ report.timeline.eventCount }}</div>
      </div>
      <div class="stat bg-base-100 border border-base-300 rounded-lg p-3">
        <div class="stat-title text-xs">设定自检</div>
        <div class="stat-value text-lg">
          {{ report.settingsQuality?.hasCheck && !report.settingsQuality?.isStale ? '有效' : '待更新' }}
        </div>
        <div class="stat-desc text-xs">
          {{ report.settingsQuality?.issueCount ?? 0 }} 条未决问题
        </div>
      </div>
    </div>

    <div v-if="report?.settingsQualityIssues?.length" class="space-y-1">
      <p class="text-xs font-medium text-base-content/50">设定质量未决问题（已同步至 AI 生成上下文）</p>
      <div
        v-for="(issue, i) in report.settingsQualityIssues.slice(0, 8)"
        :key="i"
        class="alert alert-info py-2 text-xs"
      >
        {{ issue }}
      </div>
    </div>

    <div v-if="report?.warnings.length" class="space-y-1">
      <p class="text-xs font-medium text-warning">⚠ 警告</p>
      <div v-for="(w, i) in report.warnings" :key="i" class="alert alert-warning py-2 text-xs">{{ w }}</div>
    </div>

    <div v-if="report?.rhythmHints.length" class="space-y-1">
      <p class="text-xs font-medium text-base-content/50">创作节奏提示（压→缓→压→爆发）</p>
      <div v-for="(h, i) in report.rhythmHints" :key="i" class="alert alert-info py-2 text-xs">{{ h }}</div>
    </div>

    <div v-if="report && !report.warnings.length && !report.rhythmHints.length" class="alert alert-success text-sm py-2">
      当前一致性状态良好
    </div>

    <div class="border-t border-base-300 pt-4 space-y-2">
      <div class="flex items-center justify-between">
        <p class="text-xs font-medium text-base-content/50">跨章逻辑扫描（规则引擎）</p>
        <button class="btn btn-outline btn-xs" :disabled="scanning" @click="runCrossScan">
          {{ scanning ? '扫描中...' : '开始扫描' }}
        </button>
      </div>
      <div v-for="(issue, i) in crossIssues" :key="i" class="text-xs py-1" :class="issue.severity === 'warning' ? 'text-warning' : 'text-base-content/60'">
        {{ issue.chapterTitle ? `「${issue.chapterTitle}」` : '' }}{{ issue.message }}
      </div>
    </div>

    <!-- 深度审计 -->
    <div class="border-t border-base-300 pt-4 space-y-3">
      <div class="flex items-center justify-between">
        <div>
          <p class="text-xs font-medium text-base-content/70">AI 深度审计</p>
          <p class="text-[11px] text-base-content/40">
            两阶段：① AI 扫描全量大纲标记可疑章节 → ② 深度审查标记章节
            <span v-if="auditStats" class="text-primary">（已扫描 {{ auditStats.scanned }} 章，深度审查 {{ auditStats.deep }} 章）</span>
          </p>
        </div>
        <div class="flex gap-2">
          <button
            v-if="auditResult?.issues.length"
            class="btn btn-outline btn-warning btn-sm"
            :disabled="fixing"
            @click="runAutoFix"
          >
            <span v-if="fixing" class="loading loading-spinner loading-xs mr-1"></span>
            {{ fixing ? '修复中...' : '自动修复' }}
          </button>
          <button
            class="btn btn-primary btn-sm"
            :disabled="auditing"
            @click="runAudit"
          >
            <span v-if="auditing" class="loading loading-spinner loading-xs mr-1"></span>
            {{ auditing ? '审计中...' : '开始审计' }}
          </button>
        </div>
      </div>

      <div v-if="auditError" class="alert alert-error py-2 text-xs">{{ auditError }}</div>
      <div v-if="fixMsg" class="alert py-2 text-xs" :class="fixMsg.includes('失败') ? 'alert-error' : 'alert-success'">{{ fixMsg }}</div>

      <div v-if="auditResult" class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="badge badge-lg"
            :class="auditResult.verdict === 'blocking' ? 'badge-error' : auditResult.verdict === 'warning' ? 'badge-warning' : 'badge-success'"
          >
            {{ auditResult.verdict === 'blocking' ? '⚠ 严重偏离' : auditResult.verdict === 'warning' ? '⚡ 有偏移趋势' : '✓ 基本对齐' }}
          </span>
          <span class="text-xs text-base-content/50">偏离指数：{{ auditResult.driftScore }}/100</span>
        </div>

        <p class="text-sm text-base-content/80">{{ auditResult.summary }}</p>

        <div v-if="auditResult.strengths.length" class="text-xs space-y-0.5">
          <p class="text-success font-medium">✓ 做得好的地方</p>
          <p v-for="(s, i) in auditResult.strengths" :key="i" class="text-success/80">· {{ s }}</p>
        </div>

        <div v-if="auditResult.issues.length" class="space-y-2">
          <p class="text-xs font-medium text-warning">需要关注</p>
          <div
            v-for="(issue, i) in auditResult.issues"
            :key="i"
            class="rounded border p-2 text-xs"
            :class="issue.severity === 'blocking' ? 'border-error/40 bg-error/5' : 'border-warning/40 bg-warning/5'"
          >
            <div class="flex items-center gap-2 mb-1">
              <span class="badge badge-xs" :class="issue.severity === 'blocking' ? 'badge-error' : 'badge-warning'">
                {{ issue.dimension }}
              </span>
            </div>
            <p class="text-base-content/80">{{ issue.evidence }}</p>
            <p class="text-base-content/60 mt-0.5">→ {{ issue.suggestion }}</p>
          </div>
        </div>
      </div>

      <!-- 被动监控 -->
      <div v-if="monitor" class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div class="rounded border border-base-300 p-2 text-center" :class="monitor.foreshadowingRecoveryRate < 40 ? 'border-error/50' : ''">
          <p class="text-base-content/40">伏笔回收率</p>
          <p class="font-semibold" :class="monitor.foreshadowingRecoveryRate < 40 ? 'text-error' : 'text-success'">{{ monitor.foreshadowingRecoveryRate }}%</p>
        </div>
        <div class="rounded border border-base-300 p-2 text-center" :class="monitor.deepForeshadowingPending > 3 ? 'border-warning/50' : ''">
          <p class="text-base-content/40">深伏笔待回收</p>
          <p class="font-semibold" :class="monitor.deepForeshadowingPending > 3 ? 'text-warning' : ''">{{ monitor.deepForeshadowingPending }}</p>
        </div>
        <div class="rounded border border-base-300 p-2 text-center" :class="monitor.newCharacterRate > 2 ? 'border-warning/50' : ''">
          <p class="text-base-content/40">角色增速/章</p>
          <p class="font-semibold" :class="monitor.newCharacterRate > 2 ? 'text-warning' : ''">{{ monitor.newCharacterRate }}</p>
        </div>
        <div class="rounded border border-base-300 p-2 text-center" :class="monitor.emotionFlatStreak >= 5 ? 'border-warning/50' : ''">
          <p class="text-base-content/40">连续低压</p>
          <p class="font-semibold" :class="monitor.emotionFlatStreak >= 5 ? 'text-warning' : ''">{{ monitor.emotionFlatStreak }} 章</p>
        </div>
      </div>

      <div v-if="monitor?.charactersLongAbsent.length" class="text-xs text-warning">
        ⚠ {{ monitor.charactersLongAbsent.map(c => `${c.name}(${c.chaptersAgo}章前)`).join('、') }} 长期未出场
      </div>
    </div>
  </div>
</template>
