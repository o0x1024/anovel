<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import type {
  CausalChapterDecisionRecord,
  CausalNarrativeState
} from '../../../../shared/causal-novel-types'
import { goalRoutinePhaseLabel } from '../../../../shared/goal-routine-phases'

const props = defineProps<{ workId: number }>()

interface WorkInfo {
  id: number
  title: string
  description: string | null
  target_chapters: number | null
}

interface CausalSnapshot {
  state: CausalNarrativeState | null
  decisions: CausalChapterDecisionRecord[]
  planAttempts: CausalPlanAttemptSummary[]
  chapters: Array<{ id: number; title: string; status: string; hasContent: boolean; wordCount: number }>
}

interface CausalPlanAttemptSummary {
  id: number
  stateRevision: number
  stage: string
  status: 'accepted' | 'rejected'
  errorCode: string | null
  errorMessage: string | null
  responseHash: string | null
  createTime: string
}

interface StateRevisionSummary {
  revision: number
  sourceChapterId: number | null
  transitionType: string
  bodyHash: string | null
  createTime: string
}

interface GoalTurn {
  id: number
  turn_no: number
  phase: string | null
  action: string | null
  summary: string | null
  create_time: string
}

interface RunLogEntry {
  key: string
  time: string
  turn: number
  phase: string
  status: string
  message: string
  persisted: boolean
}

interface GoalProgressEvent {
  workId: number
  turn: number
  maxTurns: number
  phase: string
  status: string
  message: string
}

const work = ref<WorkInfo | null>(null)
const snapshot = ref<CausalSnapshot>({ state: null, decisions: [], planAttempts: [], chapters: [] })
const stateRevisions = ref<StateRevisionSummary[]>([])
const worldSeed = ref('')
const goal = ref('')
const loading = ref(true)
const saving = ref(false)
const running = ref(false)
const message = ref('')
const historyLogs = ref<RunLogEntry[]>([])
const liveLogs = ref<RunLogEntry[]>([])
const currentProgress = ref<{ turn: number; maxTurns: number; phase: string; status: string } | null>(null)
const runStartedAt = ref<number | null>(null)
const nowTick = ref(Date.now())
const logContainer = ref<HTMLElement | null>(null)
let clockTimer: number | null = null

const state = computed(() => snapshot.value.state)
const activePressures = computed(() => state.value?.activePressures.filter(item => item.status === 'active') ?? [])
const openPromises = computed(() => state.value?.promises.filter(item => item.status !== 'resolved') ?? [])
const currentArc = computed(() => state.value?.macroArcs?.find(item => item.status === 'active') ?? null)
const pressureSources = computed(() => {
  const actors = new Map((state.value?.actors ?? []).map(actor => [actor.name, actor]))
  const grouped = new Map<string, {
    source: string
    targets: string[]
    pressureCount: number
    maxUrgency: number
    actor: CausalNarrativeState['actors'][number] | null
  }>()
  for (const pressure of activePressures.value) {
    const existing = grouped.get(pressure.source)
    if (existing) {
      if (!existing.targets.includes(pressure.target)) existing.targets.push(pressure.target)
      existing.pressureCount++
      existing.maxUrgency = Math.max(existing.maxUrgency, pressure.urgency)
      continue
    }
    grouped.set(pressure.source, {
      source: pressure.source,
      targets: [pressure.target],
      pressureCount: 1,
      maxUrgency: pressure.urgency,
      actor: actors.get(pressure.source) ?? null
    })
  }
  return [...grouped.values()].sort((a, b) => b.maxUrgency - a.maxUrgency)
})
const latestDecision = computed(() => snapshot.value.decisions.at(-1) ?? null)
const canonicalChapters = computed(() => {
  const ids = new Set(snapshot.value.decisions.map(item => item.chapterId))
  return snapshot.value.chapters.filter(chapter => ids.has(chapter.id))
})
const progress = computed(() => {
  const target = Math.max(1, work.value?.target_chapters ?? 1)
  return Math.min(100, Math.round(canonicalChapters.value.length / target * 100))
})
const runLogs = computed(() => [...historyLogs.value, ...liveLogs.value].slice(-200))
const elapsedLabel = computed(() => {
  if (!runStartedAt.value) return '-'
  const total = Math.max(0, Math.floor((nowTick.value - runStartedAt.value) / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}分${String(seconds).padStart(2, '0')}秒` : `${seconds}秒`
})
function activityPhaseLabel(phase: string | undefined, detail: string): string {
  if (/^章后结果|核心事件提取|人物变化提取|世界压力提取|情绪结果提取|因果结果/.test(detail)) {
    return '章后结果提取'
  }
  if (/原子提交|已提交/.test(detail)) return '状态事务提交'
  if (/叙事记忆/.test(detail)) return '叙事记忆候选'
  if (/质量验收|质量门禁/.test(detail)) return '正文质量验收'
  if (/滚动决策/.test(detail)) return '正文生成'
  return goalRoutinePhaseLabel(phase, 'causal_novel') || phase || '运行'
}

const currentPhaseLabel = computed(() => activityPhaseLabel(currentProgress.value?.phase, message.value))

function parseDbTime(value: string): Date {
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
}

function formatLogTime(value: string): string {
  const date = parseDbTime(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function arcStatusLabel(status: CausalNarrativeState['macroArcs'][number]['status']): string {
  if (status === 'active') return '当前阶段'
  if (status === 'completed') return '已完成'
  return '待进入'
}

function arcStatusClass(status: CausalNarrativeState['macroArcs'][number]['status']): string {
  if (status === 'active') return 'badge-primary'
  if (status === 'completed') return 'badge-success'
  return 'badge-ghost'
}

function actionLabel(action: string | null): string {
  const labels: Record<string, string> = {
    causal_state_init: '状态初始化',
    causal_decision: '候选决策',
    causal_commit: '状态提交',
    causal_final_check: '整书终审',
    error: '异常'
  }
  return action ? labels[action] ?? action : ''
}

function revisionLabel(type: string): string {
  return ({
    initial: '初始状态',
    legacy_snapshot: '旧状态接管',
    chapter_commit: '章节提交',
    macro_architecture_upgrade: '阶段架构升级',
    completion_rejected: '完结提案退回',
    completion_confirmed: '完结确认'
  } as Record<string, string>)[type] ?? type
}

function attemptStageLabel(stage: string): string {
  return ({
    candidate_generation: '候选生成',
    candidate_validation: '候选校验',
    decision_generation: '执行合同生成',
    local_validation: '本地绑定校验',
    audit: '独立复核',
    audit_validation: '复核格式校验',
    accepted: '规划通过'
  } as Record<string, string>)[stage] ?? stage
}

async function scrollLogsToBottom(): Promise<void> {
  await nextTick()
  if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight
}

function appendLiveLog(event: GoalProgressEvent): void {
  const previous = liveLogs.value.at(-1)
  if (previous && previous.message === event.message && previous.phase === event.phase && previous.status === event.status) return
  liveLogs.value.push({
    key: `live-${Date.now()}-${liveLogs.value.length}`,
    time: new Date().toISOString(),
    turn: event.turn,
    phase: event.phase,
    status: event.status,
    message: event.message,
    persisted: false
  })
  if (liveLogs.value.length > 120) liveLogs.value = liveLogs.value.slice(-120)
  void scrollLogsToBottom()
}

async function loadRunHistory(): Promise<void> {
  const result = await window.anovel.invoke('goal:getState', props.workId) as {
    state?: {
      status: string
      turn_count: number
      max_turns: number
      current_phase: string | null
      update_time: string
    } | null
    turns?: GoalTurn[]
  }
  const turns = [...(result.turns ?? [])].reverse()
  historyLogs.value = turns.map(turn => ({
    key: `turn-${turn.id}`,
    time: turn.create_time,
    turn: turn.turn_no,
    phase: turn.phase ?? '',
    status: turn.action === 'error' ? 'error' : 'persisted',
    message: [actionLabel(turn.action), turn.summary].filter(Boolean).join('：'),
    persisted: true
  }))
  if (result.state && !currentProgress.value) {
    currentProgress.value = {
      turn: result.state.turn_count ?? 0,
      maxTurns: result.state.max_turns ?? 0,
      phase: result.state.current_phase ?? '',
      status: result.state.status ?? ''
    }
  }
  if (result.state?.status === 'running' && runStartedAt.value == null) {
    const persistedTime = parseDbTime(result.state.update_time).getTime()
    runStartedAt.value = Number.isNaN(persistedTime) ? Date.now() : persistedTime
  }
  await scrollLogsToBottom()
}

async function load(): Promise<void> {
  const [workInfo, causal, isRunning, revisions] = await Promise.all([
    window.anovel.invoke('work:get', props.workId) as Promise<WorkInfo>,
    window.anovel.invoke('causal:getState', props.workId) as Promise<CausalSnapshot>,
    window.anovel.invoke('goal:isRunning', props.workId) as Promise<boolean>,
    window.anovel.invoke('causal:listStateRevisions', props.workId, 30) as Promise<StateRevisionSummary[]>
  ])
  work.value = workInfo
  worldSeed.value = workInfo.description ?? ''
  snapshot.value = { ...causal, planAttempts: causal.planAttempts ?? [] }
  stateRevisions.value = revisions
  running.value = isRunning
  if (running.value && runStartedAt.value == null) runStartedAt.value = Date.now()
  loading.value = false
}

async function saveWorldSeed(): Promise<void> {
  if (state.value) return
  const seed = worldSeed.value.trim()
  if (!seed) {
    message.value = '请先填写世界起点。'
    return
  }
  saving.value = true
  try {
    await window.anovel.invoke('work:update', props.workId, { description: seed })
    if (work.value) work.value.description = seed
    message.value = '世界起点已保存。初始化后它会成为权威状态的来源。'
  } finally {
    saving.value = false
  }
}

async function start(): Promise<void> {
  if (running.value) return
  if (!state.value && !worldSeed.value.trim() && !goal.value.trim()) {
    message.value = '请先填写世界起点或本轮创作目标。'
    return
  }
  if (!state.value && worldSeed.value.trim() !== work.value?.description?.trim()) {
    await saveWorldSeed()
  }
  running.value = true
  runStartedAt.value = Date.now()
  message.value = state.value ? '正在从当前权威状态继续滚动…' : '正在建立权威因果状态…'
  appendLiveLog({
    workId: props.workId, turn: currentProgress.value?.turn ?? 0,
    maxTurns: 60, phase: state.value ? 'generate_beats' : 'materialize_settings',
    status: 'running', message: message.value
  })
  try {
    await window.anovel.invoke('goal:start', props.workId, {
      goalDescription: goal.value.trim(),
      maxTurns: 60,
      requireAllBeatsContent: true
    })
  } catch (error) {
    running.value = false
    message.value = error instanceof Error ? error.message : '启动失败'
  }
}

async function resume(): Promise<void> {
  if (running.value) return
  running.value = true
  runStartedAt.value = Date.now()
  message.value = '正在从已保存的章节决策继续…'
  appendLiveLog({
    workId: props.workId, turn: currentProgress.value?.turn ?? 0,
    maxTurns: 60, phase: 'generate_beats', status: 'running', message: message.value
  })
  try {
    await window.anovel.invoke('goal:resume', props.workId, {
      goalDescription: goal.value.trim(),
      maxTurns: 60,
      requireAllBeatsContent: true
    })
  } catch (error) {
    running.value = false
    message.value = error instanceof Error ? error.message : '继续失败'
  }
}

async function cancel(): Promise<void> {
  await window.anovel.invoke('goal:cancel', props.workId)
}

function onProgress(payload: unknown): void {
  const event = payload as GoalProgressEvent
  if (event.workId !== props.workId) return
  message.value = event.message ?? ''
  currentProgress.value = {
    turn: event.turn ?? 0,
    maxTurns: event.maxTurns ?? 0,
    phase: event.phase ?? '',
    status: event.status ?? ''
  }
  if (event.status === 'running' && runStartedAt.value == null) runStartedAt.value = Date.now()
  appendLiveLog(event)
  running.value = event.status === 'running'
  if (!running.value) {
    void Promise.all([load(), loadRunHistory()])
  }
  else window.setTimeout(() => void Promise.all([load(), loadRunHistory()]), 300)
}

onMounted(async () => {
  window.anovel.on('goal:progress', onProgress)
  clockTimer = window.setInterval(() => { nowTick.value = Date.now() }, 1000)
  await Promise.all([load(), loadRunHistory()])
})

onUnmounted(() => {
  window.anovel.off('goal:progress', onProgress)
  if (clockTimer != null) window.clearInterval(clockTimer)
})
</script>

<template>
  <div class="w-full min-w-0 space-y-5">
    <div class="flex items-start gap-3">
      <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
        <font-awesome-icon icon="project-diagram" class="text-lg" />
      </div>
      <div class="min-w-0">
        <h3 class="text-lg font-bold">滚动因果写作</h3>
        <p class="text-xs text-base-content/50 leading-relaxed mt-1">
          每次只从当前权威状态选择下一章。系统不生成全书大纲或分卷规划，人物关系只作为已发生事实记录。
        </p>
      </div>
      <span v-if="state" class="badge badge-sm ml-auto" :class="state.completed ? 'badge-success' : state.completionStatus === 'proposed' ? 'badge-warning' : 'badge-primary'">
        状态 r{{ state.revision }}{{ state.completionStatus === 'proposed' ? ' · 待终审' : '' }}
      </span>
    </div>

    <div v-if="loading" class="card bg-base-200 border border-base-300 p-8 text-center text-sm text-base-content/50">
      正在读取因果状态…
    </div>

    <template v-else>
      <div class="card bg-base-200 border border-base-300 shadow-sm p-5 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h4 class="font-semibold text-sm">世界起点</h4>
            <p class="text-xs text-base-content/40 mt-1">初始化前可以修改；初始化后通过正文事实推进，不能直接重写历史。</p>
          </div>
          <button
            v-if="!state"
            type="button"
            class="btn btn-outline btn-xs"
            :disabled="saving || running"
            @click="saveWorldSeed"
          >{{ saving ? '保存中…' : '保存起点' }}</button>
        </div>
        <textarea
          v-model="worldSeed"
          rows="5"
          :disabled="Boolean(state) || running"
          class="textarea textarea-bordered w-full text-sm leading-relaxed"
          placeholder="描述世界规则、当前秩序、最不稳定的矛盾，以及故事开始时正在发生的事情。不要填写章节大纲。"
        />
      </div>

      <div class="card bg-base-200 border border-base-300 shadow-sm p-5 space-y-4">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h4 class="font-semibold text-sm">运行控制</h4>
            <p class="text-xs text-base-content/40 mt-1">每章经历候选事件 → 章节决策 → 正文门禁 → 事实提取 → 状态提交。</p>
          </div>
          <div class="flex gap-2">
            <button v-if="!running" type="button" class="btn btn-primary btn-sm" @click="state ? resume() : start()">
              {{ state ? '继续滚动' : '初始化并开始' }}
            </button>
            <button v-else type="button" class="btn btn-warning btn-sm" @click="cancel">停止</button>
          </div>
        </div>
        <textarea
          v-model="goal"
          rows="2"
          :disabled="running"
          class="textarea textarea-bordered w-full text-sm"
          placeholder="可选：补充题材、文风或本轮关注点。不能指定未来章节情节。"
        />
        <div v-if="message" class="rounded-lg bg-base-100 border border-base-300 px-3 py-2 text-xs leading-relaxed">
          {{ message }}
        </div>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <div class="rounded-lg bg-base-100 border border-base-300 px-3 py-2">
            <p class="text-base-content/40">当前阶段</p>
            <p class="font-semibold mt-1">{{ currentPhaseLabel || (running ? '准备中' : '未运行') }}</p>
          </div>
          <div class="rounded-lg bg-base-100 border border-base-300 px-3 py-2">
            <p class="text-base-content/40">当前轮次</p>
            <p class="font-semibold mt-1">{{ currentProgress ? `${currentProgress.turn}/${currentProgress.maxTurns}` : '-' }}</p>
          </div>
          <div class="rounded-lg bg-base-100 border border-base-300 px-3 py-2">
            <p class="text-base-content/40">本次持续</p>
            <p class="font-semibold mt-1">{{ running ? elapsedLabel : '-' }}</p>
          </div>
          <div class="rounded-lg bg-base-100 border border-base-300 px-3 py-2">
            <p class="text-base-content/40">运行状态</p>
            <p class="font-semibold mt-1" :class="running ? 'text-primary' : 'text-base-content/70'">
              {{ running ? '模型处理中' : state?.completed ? '已经收束' : state?.completionStatus === 'proposed' ? '等待终审' : '已停止' }}
            </p>
          </div>
        </div>
        <div class="space-y-1">
          <div class="flex justify-between text-xs text-base-content/50">
            <span>权威章节 {{ canonicalChapters.length }} / {{ work?.target_chapters ?? 0 }} 章</span>
            <span>{{ progress }}%</span>
          </div>
          <progress class="progress progress-primary progress-xs w-full" :value="progress" max="100" />
        </div>

        <div class="rounded-xl border border-base-300 bg-neutral text-neutral-content overflow-hidden">
          <div class="flex items-center justify-between px-3 py-2 border-b border-base-100/10 text-xs">
            <span class="font-semibold">运行日志</span>
            <span class="text-base-100/50">真实阶段事件，不估算模型内部百分比</span>
          </div>
          <div ref="logContainer" class="max-h-64 min-h-28 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-5">
            <div v-if="runLogs.length === 0" class="text-base-100/40 py-3">尚无运行记录。</div>
            <div v-for="entry in runLogs" :key="entry.key" class="grid grid-cols-[64px_52px_120px_1fr] gap-2">
              <span class="text-base-100/35">{{ formatLogTime(entry.time) }}</span>
              <span class="text-base-100/45">#{{ entry.turn }}</span>
              <span :class="entry.status === 'error' ? 'text-error' : entry.persisted ? 'text-info' : 'text-primary'">
                {{ activityPhaseLabel(entry.phase, entry.message) }}
              </span>
              <span :class="entry.status === 'error' ? 'text-error' : 'text-base-100/80'">{{ entry.message }}</span>
            </div>
          </div>
        </div>

        <div v-if="snapshot.planAttempts.length" class="rounded-xl border border-base-300 bg-base-100 overflow-hidden">
          <div class="flex items-center justify-between px-3 py-2 border-b border-base-300 text-xs">
            <span class="font-semibold">规划审计</span>
            <span class="text-base-content/40">被拒方案保留指纹，不推进权威状态</span>
          </div>
          <div class="divide-y divide-base-300/70">
            <div
              v-for="attempt in snapshot.planAttempts.slice(0, 5)"
              :key="attempt.id"
              class="grid grid-cols-[72px_82px_1fr_auto] gap-2 px-3 py-2 text-[11px] items-start"
            >
              <span class="font-semibold">r{{ attempt.stateRevision }} · {{ attemptStageLabel(attempt.stage) }}</span>
              <span class="badge badge-xs" :class="attempt.status === 'accepted' ? 'badge-success' : 'badge-error'">
                {{ attempt.status === 'accepted' ? '已通过' : attempt.errorCode || '已拒绝' }}
              </span>
              <span class="text-base-content/60 break-words">{{ attempt.errorMessage || '候选、决策与证据已经通过全部门禁' }}</span>
              <span class="text-base-content/35" :title="attempt.responseHash || ''">{{ formatLogTime(attempt.createTime) }}</span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="state" class="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <section class="card bg-base-200 border border-base-300 p-5 space-y-3">
          <h4 class="font-semibold text-sm">核心戏剧问题</h4>
          <p class="text-sm leading-relaxed">{{ state.centralQuestion }}</p>
          <div>
            <p class="text-xs font-bold text-base-content/50 mb-2">终止条件</p>
            <ul class="space-y-1 text-xs text-base-content/70">
              <li v-for="item in state.terminalConditions" :key="item">• {{ item }}</li>
            </ul>
          </div>
        </section>

        <section class="card bg-base-200 border border-base-300 p-5 space-y-3">
          <div class="flex items-center justify-between gap-2">
            <div>
              <h4 class="font-semibold text-sm">世界硬规则</h4>
              <p class="text-xs text-base-content/40 mt-1">后续章节不得违背；只能通过正文事实推进世界状态。</p>
            </div>
            <span class="badge badge-ghost badge-sm">{{ state.immutableRules.length }}</span>
          </div>
          <ol class="space-y-2">
            <li v-for="(rule, index) in state.immutableRules" :key="`${index}-${rule}`" class="flex gap-2 rounded-lg bg-base-100 border border-base-300 p-3 text-xs leading-relaxed">
              <span class="badge badge-outline badge-xs shrink-0">R{{ index + 1 }}</span>
              <span>{{ rule }}</span>
            </li>
          </ol>
        </section>

        <section class="card bg-base-200 border border-base-300 p-5 space-y-4 xl:col-span-2">
          <div class="flex items-center justify-between gap-2">
            <div>
              <h4 class="font-semibold text-sm">权威人物</h4>
              <p class="text-xs text-base-content/40 mt-1">显示人物当前目标、恐惧、约束、认知与资源；内容会随已提交章节更新。</p>
            </div>
            <span class="badge badge-ghost badge-sm">{{ state.actors.length }}</span>
          </div>
          <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <article v-for="actor in state.actors" :key="actor.name" class="rounded-xl bg-base-100 border border-base-300 p-4 space-y-3">
              <div class="flex items-center gap-2">
                <strong class="text-sm">{{ actor.name }}</strong>
                <span v-if="pressureSources.some(item => item.source === actor.name)" class="badge badge-error badge-outline badge-xs ml-auto">当前施压方</span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div><p class="text-base-content/40">当前目标</p><p class="mt-1 leading-relaxed">{{ actor.currentGoal || '未记录' }}</p></div>
                <div><p class="text-base-content/40">恐惧</p><p class="mt-1 leading-relaxed">{{ actor.fear || '未记录' }}</p></div>
                <div class="sm:col-span-2"><p class="text-base-content/40">当前约束</p><p class="mt-1 leading-relaxed">{{ actor.constraint || '未记录' }}</p></div>
              </div>
              <details class="rounded-lg border border-base-300 bg-base-200/50 px-3 py-2 text-xs">
                <summary class="cursor-pointer font-semibold">认知 {{ actor.knowledge.length }} 条 · 资源 {{ actor.resources.length }} 项</summary>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                  <div><p class="font-bold text-base-content/50 mb-1">已知信息</p><p v-for="item in actor.knowledge" :key="item" class="leading-relaxed">• {{ item }}</p><p v-if="!actor.knowledge.length" class="text-base-content/40">暂无</p></div>
                  <div><p class="font-bold text-base-content/50 mb-1">可用资源</p><p v-for="item in actor.resources" :key="item" class="leading-relaxed">• {{ item }}</p><p v-if="!actor.resources.length" class="text-base-content/40">暂无</p></div>
                </div>
              </details>
            </article>
          </div>
        </section>

        <section class="card bg-base-200 border border-base-300 p-5 space-y-4 xl:col-span-2">
          <div class="flex items-center justify-between gap-2">
            <div>
              <h4 class="font-semibold text-sm">全部阶段锚点</h4>
              <p class="text-xs text-base-content/40 mt-1">阶段锚点约束长线方向，不是逐章大纲。</p>
            </div>
            <span v-if="currentArc" class="badge badge-primary badge-sm">当前：{{ currentArc.title }}</span>
          </div>
          <p v-if="!state.macroArchitectureReady" class="rounded-lg bg-warning/10 border border-warning/30 px-3 py-2 text-xs">
            这是旧状态的兼容主线；当前章节事务完成后，系统会生成正式的阶段锚点修订。
          </p>
          <div v-if="state.macroArcs.length" class="space-y-3">
            <article v-for="(arc, index) in state.macroArcs" :key="arc.id" class="rounded-xl border p-4" :class="arc.status === 'active' ? 'border-primary/40 bg-primary/5' : 'border-base-300 bg-base-100'">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-xs text-base-content/40">{{ index + 1 }}</span>
                <strong class="text-sm">{{ arc.title }}</strong>
                <span class="badge badge-xs ml-auto" :class="arcStatusClass(arc.status)">{{ arcStatusLabel(arc.status) }}</span>
              </div>
              <p class="text-sm leading-relaxed mt-2">{{ arc.objective }}</p>
              <details class="mt-3 text-xs">
                <summary class="cursor-pointer text-base-content/55 font-semibold">查看进入/退出条件、必须兑现与禁止漂移</summary>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3 rounded-lg bg-base-200/60 p-3">
                  <div><p class="font-bold text-base-content/50 mb-1">进入条件</p><p v-for="item in arc.entryConditions" :key="item" class="leading-relaxed">• {{ item }}</p></div>
                  <div><p class="font-bold text-base-content/50 mb-1">退出条件</p><p v-for="item in arc.exitConditions" :key="item" class="leading-relaxed">• {{ item }}</p></div>
                  <div><p class="font-bold text-base-content/50 mb-1">必须兑现</p><p v-for="item in arc.mandatoryPayoffs" :key="item" class="leading-relaxed">• {{ item }}</p></div>
                  <div><p class="font-bold text-base-content/50 mb-1">禁止漂移</p><p v-for="item in arc.forbiddenDrift" :key="item" class="leading-relaxed">• {{ item }}</p></div>
                </div>
              </details>
            </article>
          </div>
          <p v-else class="text-xs text-base-content/40">尚未建立阶段锚点。</p>
        </section>

        <section class="card bg-base-200 border border-base-300 p-5 space-y-3">
          <div class="flex items-center justify-between">
            <div>
              <h4 class="font-semibold text-sm">敌对与施压来源</h4>
              <p class="text-[11px] text-base-content/40 mt-1">按当前压力整理，不等同于系统判定的反派。</p>
            </div>
            <span class="badge badge-ghost badge-sm">{{ pressureSources.length }}</span>
          </div>
          <div v-for="item in pressureSources" :key="item.source" class="rounded-lg bg-base-100 border border-base-300 p-3">
            <div class="flex items-center gap-2 text-xs">
              <strong>{{ item.source }}</strong>
              <span v-if="item.actor" class="badge badge-outline badge-xs">权威人物</span>
              <span class="badge badge-xs ml-auto" :class="item.maxUrgency >= 8 ? 'badge-error' : 'badge-warning'">最高 {{ item.maxUrgency }}/10</span>
            </div>
            <p class="text-xs text-base-content/60 mt-1">施压对象：{{ item.targets.join('、') }}</p>
            <p class="text-[11px] text-base-content/40 mt-1">关联 {{ item.pressureCount }} 个当前压力</p>
            <p v-if="item.actor" class="text-[11px] text-base-content/40 mt-1">当前目标：{{ item.actor.currentGoal }}</p>
          </div>
          <p v-if="!pressureSources.length" class="text-xs text-base-content/40">当前没有活跃的施压来源。</p>
        </section>

        <section class="card bg-base-200 border border-base-300 p-5 space-y-3">
          <div class="flex items-center justify-between">
            <h4 class="font-semibold text-sm">当前压力</h4>
            <span class="badge badge-ghost badge-sm">{{ activePressures.length }}</span>
          </div>
          <div v-for="pressure in activePressures" :key="pressure.id" class="rounded-lg bg-base-100 border border-base-300 p-3">
            <div class="flex items-center gap-2 text-xs font-semibold">
              <span>{{ pressure.source }} → {{ pressure.target }}</span>
              <span class="badge badge-xs ml-auto" :class="pressure.urgency >= 8 ? 'badge-error' : 'badge-warning'">
                {{ pressure.urgency }}/10
              </span>
            </div>
            <p class="text-xs text-base-content/60 mt-1">{{ pressure.condition }}</p>
            <p class="text-[11px] text-base-content/40 mt-1">升级：{{ pressure.escalation }}</p>
          </div>
        </section>

        <section class="card bg-base-200 border border-base-300 p-5 space-y-3">
          <div class="flex items-center justify-between">
            <h4 class="font-semibold text-sm">读者承诺</h4>
            <span class="badge badge-ghost badge-sm">{{ openPromises.length }}</span>
          </div>
          <div v-for="promise in openPromises" :key="promise.id" class="flex gap-2 text-xs leading-relaxed">
            <span class="badge badge-xs" :class="promise.status === 'advanced' ? 'badge-info' : 'badge-ghost'">{{ promise.id }}</span>
            <span>{{ promise.question }}</span>
          </div>
        </section>

        <section class="card bg-base-200 border border-base-300 p-5 space-y-3">
          <h4 class="font-semibold text-sm">最近章节决策</h4>
          <div v-if="latestDecision" class="space-y-2 text-xs">
            <div class="flex items-center gap-2">
              <span class="font-bold">{{ latestDecision.plan.decision.title }}</span>
              <span class="badge badge-xs ml-auto" :class="latestDecision.status === 'committed' ? 'badge-success' : 'badge-warning'">
                {{ latestDecision.status === 'committed' ? '已提交' : '待提交' }}
              </span>
            </div>
            <p><span class="text-base-content/40">行动：</span>{{ latestDecision.plan.decision.chosenAction }}</p>
            <p><span class="text-base-content/40">阻力：</span>{{ latestDecision.plan.decision.opposition }}</p>
            <p><span class="text-base-content/40">代价：</span>{{ latestDecision.plan.decision.cost }}</p>
            <p><span class="text-base-content/40">新问题：</span>{{ latestDecision.plan.decision.newQuestion }}</p>
          </div>
          <p v-else class="text-xs text-base-content/40">尚未生成章节决策。</p>
        </section>
      </div>

      <section v-if="canonicalChapters.length" class="card bg-base-200 border border-base-300 p-5 space-y-3">
        <div class="flex items-center justify-between">
          <div>
            <h4 class="font-semibold text-sm">已生成章节</h4>
            <p class="text-xs text-base-content/40 mt-1">正文只能由因果事务链生成和提交，不能绕过状态门禁手动续写。</p>
          </div>
          <span class="badge badge-ghost badge-sm">{{ canonicalChapters.length }} 章</span>
        </div>
        <div class="divide-y divide-base-300/70 rounded-lg border border-base-300 bg-base-100">
          <div
            v-for="(chapter, index) in canonicalChapters"
            :key="chapter.id"
            class="flex items-center gap-3 px-3 py-2.5 text-xs"
          >
            <span class="text-base-content/40 w-8">{{ index + 1 }}</span>
            <span class="font-semibold flex-1 truncate">{{ chapter.title }}</span>
            <span class="text-base-content/40">{{ chapter.wordCount }} 字</span>
            <span class="badge badge-xs" :class="chapter.status === 'completed' ? 'badge-success' : 'badge-warning'">
              {{ chapter.status === 'completed' ? '已提交' : chapter.hasContent ? '待验收' : '待生成' }}
            </span>
          </div>
        </div>
      </section>

      <section v-if="stateRevisions.length" class="card bg-base-200 border border-base-300 p-5 space-y-3">
        <div class="flex items-center justify-between gap-2">
          <div><h4 class="font-semibold text-sm">权威状态修订</h4><p class="text-xs text-base-content/40 mt-1">每次章节提交、阶段升级和完结判定都保留独立快照。</p></div>
          <span class="badge badge-ghost badge-sm">最近 {{ stateRevisions.length }} 条</span>
        </div>
        <div class="divide-y divide-base-300/70 rounded-lg border border-base-300 bg-base-100">
          <div v-for="item in stateRevisions.slice(0, 8)" :key="item.revision" class="grid grid-cols-[56px_1fr_auto] gap-3 px-3 py-2.5 text-xs items-center">
            <strong>r{{ item.revision }}</strong>
            <span>{{ revisionLabel(item.transitionType) }}<span v-if="item.sourceChapterId" class="text-base-content/40"> · 章节 #{{ item.sourceChapterId }}</span></span>
            <span class="text-base-content/40">{{ formatLogTime(item.createTime) }}</span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>
