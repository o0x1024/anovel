<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'

const props = defineProps<{ workId: number }>()

const CONFIG_STORAGE_KEY = 'goalRoutineConfig'

interface GoalConfig {
  goalDescription: string
  requireAllBeatsContent: boolean
  targetTotalWords: number | null
  qualityMin: number
  checkConsistencyGate: boolean
  aiPercentMax: number
  checkAntiAiRules: boolean
  maxTurns: number
  goalMatchMin: number
}

const DEFAULT_CONFIG: GoalConfig = {
  goalDescription: '',
  requireAllBeatsContent: true,
  targetTotalWords: null,
  qualityMin: 85,
  checkConsistencyGate: true,
  aiPercentMax: 10,
  checkAntiAiRules: true,
  maxTurns: 60,
  goalMatchMin: 85
}

function loadConfig(): GoalConfig {
  try {
    const raw = localStorage.getItem(`${CONFIG_STORAGE_KEY}:${props.workId}`)
    if (raw) return { ...DEFAULT_CONFIG, ...JSON.parse(raw) as Partial<GoalConfig> }
  } catch { /* ignore */ }
  return { ...DEFAULT_CONFIG }
}

function saveConfig(): void {
  try {
    localStorage.setItem(`${CONFIG_STORAGE_KEY}:${props.workId}`, JSON.stringify(config.value))
  } catch { /* ignore */ }
}

const config = ref<GoalConfig>(loadConfig())

interface GoalState {
  work_id: number
  status: string
  turn_count: number
  max_turns: number
  current_phase: string | null
  last_ai_percent: number | null
  last_quality_score: number | null
  goal_met: number
  update_time: string
}

interface GoalCheckResult {
  met: boolean
  beatCompletion: number
  totalBeats: number
  contentBeats: number
  totalWords: number
  targetWords: number
  qualityScore: number
  qualityHardFail: boolean
  gateBlockers: number
  aiPercent: number
  antiAiViolations: number
  goalMatchScore: number
  goalMatchReason: string
  reasons: string[]
}

interface GoalTurn {
  id: number
  turn_no: number
  phase: string | null
  action: string | null
  target_chapter_id: number | null
  ai_percent_after: number | null
  score: number | null
  summary: string | null
  create_time: string
}

interface GoalProgressEvent {
  workId: number
  turn: number
  maxTurns: number
  phase: string
  status: string
  check?: GoalCheckResult
  message: string
}

const state = ref<GoalState | null>(null)
const turns = ref<GoalTurn[]>([])
const running = ref(false)
const lastMessage = ref('')
const lastStatus = ref('')
const lastCheck = ref<GoalCheckResult | null>(null)

const statusLabel = computed(() => {
  const s = state.value?.status
  const map: Record<string, string> = {
    idle: '空闲', running: '运行中', paused: '已暂停', goal_met: '已达成',
    timeout: '轮次上限', error: '出错', cancelled: '已取消'
  }
  return map[s ?? 'idle'] ?? s
})
const statusBadge = computed(() => {
  const s = state.value?.status
  const map: Record<string, string> = {
    running: 'badge-primary', goal_met: 'badge-success',
    timeout: 'badge-warning', error: 'badge-error', cancelled: 'badge-ghost',
    paused: 'badge-warning', idle: 'badge-ghost'
  }
  return map[s ?? 'idle'] ?? 'badge-ghost'
})

const phaseMap: Record<string, string> = {
  incubate_outline: '孵化大纲',
  incubator_gate: '孵化门禁',
  freeze_storyline: '冻结版本',
  materialize_settings: '核心设定',
  generate_character_cards: '主角人设卡',
  generate_title_hook: '书名导语',
  overall_self_check: '整体自检',
  generate_beats: '节拍大纲',
  draft_body: '正文生成',
  goal_check: '目标验收',
  repair_plan: '修复计划',
  repair_execute: '执行修复'
}

const phaseLabel = computed(() => {
  const phase = state.value?.current_phase
  return phase ? (phaseMap[phase] ?? phase) : '-'
})

const liveTurn = ref<GoalProgressEvent | null>(null)
const canResume = computed(() => {
  const s = state.value?.status
  return s === 'paused' || s === 'cancelled' || (s === 'running' && !running.value)
})

const canContinueRepair = computed(() => {
  const s = state.value
  if (!s) return false
  if (running.value) return false
  const finished = s.status === 'goal_met' || s.status === 'timeout' || s.status === 'cancelled' || s.status === 'error'
  if (!finished) return false
  if (s.goal_met) return false
  if ((s.turn_count ?? 0) >= (s.max_turns ?? 0)) return false
  return true
})
const visibleTurns = computed(() => {
  const ev = liveTurn.value
  if (!ev || ev.status !== 'running') return turns.value
  const latest = turns.value[0]
  if (latest?.turn_no === ev.turn && latest?.summary === ev.message) return turns.value
  return [{
    id: -1,
    turn_no: ev.turn,
    phase: ev.phase,
    action: 'running',
    target_chapter_id: null,
    ai_percent_after: null,
    score: null,
    summary: ev.message,
    create_time: ''
  }, ...turns.value]
})

/** 各维度达标状态（✓/✗） */
const dimStatus = computed(() => {
  const c = lastCheck.value
  if (!c) return null
  const cfg = config.value
  return {
    beats: c.totalBeats > 0 && c.contentBeats === c.totalBeats,
    words: cfg.targetTotalWords === null || cfg.targetTotalWords <= 0 || c.totalWords >= (c.targetWords || cfg.targetTotalWords),
    quality: c.qualityScore >= 0 && !c.qualityHardFail && c.qualityScore >= cfg.qualityMin,
    gate: c.gateBlockers === 0,
    ai: c.aiPercent <= cfg.aiPercentMax,
    antiAi: c.antiAiViolations === 0,
    goal: !cfg.goalDescription.trim() || cfg.goalMatchMin <= 0 || c.goalMatchScore >= cfg.goalMatchMin
  }
})

async function refreshState() {
  const res = await window.anovel.invoke('goal:getState', props.workId) as {
    state: GoalState | null
    turns: GoalTurn[]
  }
  state.value = res.state
  turns.value = res.turns
  running.value = await window.anovel.invoke('goal:isRunning', props.workId) as boolean
}

async function start() {
  if (running.value) return
  running.value = true
  lastStatus.value = 'running'
  lastMessage.value = '目标循环启动…'
  liveTurn.value = null
  await window.anovel.invoke('goal:start', props.workId, {
    goalDescription: config.value.goalDescription,
    requireAllBeatsContent: config.value.requireAllBeatsContent,
    targetTotalWords: config.value.targetTotalWords,
    qualityMin: config.value.qualityMin,
    checkConsistencyGate: config.value.checkConsistencyGate,
    aiPercentMax: config.value.aiPercentMax,
    checkAntiAiRules: config.value.checkAntiAiRules,
    maxTurns: config.value.maxTurns,
    goalMatchMin: config.value.goalMatchMin
  })
  await refreshState()
}

async function cancel() {
  await window.anovel.invoke('goal:cancel', props.workId)
  lastMessage.value = '正在取消…'
}

async function resume() {
  if (running.value) return
  running.value = true
  lastStatus.value = 'running'
  lastMessage.value = '断点续跑启动…'
  liveTurn.value = null
  await window.anovel.invoke('goal:resume', props.workId)
  await refreshState()
}

async function continueRepair() {
  if (running.value) return
  running.value = true
  lastStatus.value = 'running'
  lastMessage.value = '继续修复启动…'
  liveTurn.value = null
  await window.anovel.invoke('goal:resume', props.workId, 'goal_check')
  await refreshState()
}

function onProgress(payload: unknown) {
  const ev = payload as GoalProgressEvent
  if (ev.workId !== props.workId) return
  lastMessage.value = ev.message
  lastStatus.value = ev.status
  liveTurn.value = ev.status === 'running' ? ev : null
  if (ev.check) lastCheck.value = ev.check
  void refreshState()
}

onMounted(() => {
  window.anovel.on('goal:progress', onProgress)
  void refreshState()
})

onUnmounted(() => {
  window.anovel.off('goal:progress', onProgress)
})

watch(() => props.workId, () => {
  config.value = loadConfig()
  void refreshState()
})

watch(config, saveConfig, { deep: true })
</script>

<template>
  <div class="w-full max-w-3xl mx-auto space-y-5">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
        <font-awesome-icon icon="rotate" class="text-lg" />
      </div>
      <div>
        <h3 class="text-lg font-bold">目标循环</h3>
        <p class="text-xs text-base-content/50">给定创作目标，AI 自主生成一篇完整短故事直到达成或轮次上限</p>
      </div>
      <span class="badge badge-sm ml-auto" :class="statusBadge">{{ statusLabel }}</span>
    </div>

    <!-- 创作目标（自由文字） -->
    <div class="card bg-base-200 border border-base-300 shadow-sm p-5 space-y-3">
      <h4 class="font-semibold text-sm">创作目标</h4>
      <textarea
        v-model="config.goalDescription"
        :disabled="running"
        rows="3"
        placeholder="描述你想要的故事：题材、风格、主角、情节走向、结局要求……例如「都市言情，女主复仇，5个节拍，反转结局」"
        class="textarea textarea-bordered w-full text-sm rounded-lg resize-none leading-relaxed"
      ></textarea>
      <p class="text-xs text-base-content/40">会自动回填：大纲孵化槽位 → AI 门禁/冻结 → 核心设定 → 主角人设卡 → 书名导语 → 整体自检 → 节拍大纲 → 正文编辑器；进度区会显示当前子步骤。</p>
    </div>

    <!-- 目标维度配置 -->
    <div class="card bg-base-200 border border-base-300 shadow-sm p-5 space-y-4">
      <div>
        <h4 class="font-semibold text-sm">目标维度（全部达成即停）</h4>
        <p class="text-xs text-base-content/40 mt-1">按完成度、质量、去 AI 与运行上限分组配置，0 表示关闭对应阈值。</p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="rounded-xl bg-base-100 border border-base-300/70 p-4 space-y-3">
          <p class="text-xs font-bold text-base-content/70">完成度</p>
          <label class="flex items-center justify-between gap-3 text-xs cursor-pointer">
            <span>所有节拍须有正文</span>
            <input v-model="config.requireAllBeatsContent" type="checkbox" :disabled="running"
              class="checkbox checkbox-xs checkbox-primary" />
          </label>
          <label class="flex items-center justify-between gap-3 text-xs">
            <span>总字数目标</span>
            <input v-model.number="config.targetTotalWords" type="number" min="0" step="1000"
              :disabled="running" placeholder="作品设定"
              class="input input-bordered input-xs w-28 rounded-lg text-right" />
          </label>
        </div>

        <div class="rounded-xl bg-base-100 border border-base-300/70 p-4 space-y-3">
          <p class="text-xs font-bold text-base-content/70">质量验收</p>
          <label class="flex items-center justify-between gap-3 text-xs">
            <span>质量分下限</span>
            <div class="flex items-center gap-1.5">
              <input v-model.number="config.qualityMin" type="number" min="0" max="100"
                :disabled="running" class="input input-bordered input-xs w-20 rounded-lg text-right" />
              <span class="text-base-content/40">/100</span>
            </div>
          </label>
          <label class="flex items-center justify-between gap-3 text-xs">
            <span>目标匹配度</span>
            <div class="flex items-center gap-1.5">
              <input v-model.number="config.goalMatchMin" type="number" min="0" max="100"
                :disabled="running" class="input input-bordered input-xs w-20 rounded-lg text-right" />
              <span class="text-base-content/40">/100</span>
            </div>
          </label>
          <label class="flex items-center justify-between gap-3 text-xs cursor-pointer">
            <span>一致性门禁</span>
            <input v-model="config.checkConsistencyGate" type="checkbox" :disabled="running"
              class="checkbox checkbox-xs checkbox-primary" />
          </label>
        </div>

        <div class="rounded-xl bg-base-100 border border-base-300/70 p-4 space-y-3">
          <p class="text-xs font-bold text-base-content/70">去 AI 味</p>
          <label class="flex items-center justify-between gap-3 text-xs">
            <span>AI 特征上限</span>
            <div class="flex items-center gap-1.5">
              <input v-model.number="config.aiPercentMax" type="number" min="0" max="100"
                :disabled="running" class="input input-bordered input-xs w-20 rounded-lg text-right" />
              <span class="text-base-content/40">%</span>
            </div>
          </label>
          <label class="flex items-center justify-between gap-3 text-xs cursor-pointer">
            <span>anti-AI 规则零违规</span>
            <input v-model="config.checkAntiAiRules" type="checkbox" :disabled="running"
              class="checkbox checkbox-xs checkbox-primary" />
          </label>
        </div>

        <div class="rounded-xl bg-base-100 border border-base-300/70 p-4 space-y-3">
          <p class="text-xs font-bold text-base-content/70">运行控制</p>
          <label class="flex items-center justify-between gap-3 text-xs">
            <span>轮次上限</span>
            <input v-model.number="config.maxTurns" type="number" min="1" max="100"
              :disabled="running" class="input input-bordered input-xs w-20 rounded-lg text-right" />
          </label>
          <p class="text-[11px] text-base-content/40 leading-relaxed">轮次包含孵化、门禁、冻结、设定、卡片、书名导语、自检、节拍、正文、验收和修复阶段。</p>
        </div>
      </div>

      <div class="flex gap-2 pt-2 border-t border-base-300/60">
        <button v-if="!running" class="btn btn-primary btn-sm gap-2" @click="start">
          <font-awesome-icon icon="play" class="w-3.5 h-3.5" />
          启动目标循环
        </button>
        <button v-if="!running && canResume" class="btn btn-warning btn-sm gap-2" @click="resume">
          <font-awesome-icon icon="forward" class="w-3.5 h-3.5" />
          断点续跑
        </button>
        <button v-if="!running && canContinueRepair" class="btn btn-accent btn-sm gap-2" @click="continueRepair">
          <font-awesome-icon icon="wrench" class="w-3.5 h-3.5" />
          继续修复
        </button>
        <button v-if="running" class="btn btn-error btn-sm gap-2" @click="cancel">
          <font-awesome-icon icon="stop" class="w-3.5 h-3.5" />
          取消
        </button>
      </div>
    </div>

    <!-- 实时进度（多维度状态） -->
    <div class="card bg-base-200 border border-base-300 shadow-sm p-5">
      <h4 class="font-semibold text-sm mb-3">进度</h4>
      <div v-if="state" class="space-y-3 text-sm">
        <div class="flex justify-between">
          <span class="text-base-content/60">轮次 / 阶段</span>
          <span class="font-mono">{{ state.turn_count }} / {{ state.max_turns }} · {{ phaseLabel }}</span>
        </div>
        <progress class="progress progress-primary w-full" :value="state.turn_count" :max="state.max_turns"></progress>

        <!-- 各维度状态 -->
        <div v-if="lastCheck && dimStatus" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
          <div class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">节拍完成</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.contentBeats }}/{{ lastCheck.totalBeats }}</span>
              <span class="badge badge-xs" :class="dimStatus.beats ? 'badge-success' : 'badge-error'">{{ dimStatus.beats ? '达标' : '未达' }}</span>
            </div>
          </div>
          <div class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">总字数</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.totalWords }}/{{ lastCheck.targetWords || config.targetTotalWords || '-' }}</span>
              <span class="badge badge-xs" :class="dimStatus.words ? 'badge-success' : 'badge-error'">{{ dimStatus.words ? '达标' : '未达' }}</span>
            </div>
          </div>
          <div class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">质量分</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : '-' }}</span>
              <span class="badge badge-xs" :class="dimStatus.quality ? 'badge-success' : 'badge-error'">{{ dimStatus.quality ? '达标' : '未达' }}</span>
            </div>
          </div>
          <div class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">目标匹配</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.goalMatchScore }}</span>
              <span class="badge badge-xs" :class="dimStatus.goal ? 'badge-success' : 'badge-error'">{{ dimStatus.goal ? '达标' : '未达' }}</span>
            </div>
          </div>
          <div class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">一致性门禁</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.gateBlockers }} 阻塞</span>
              <span class="badge badge-xs" :class="dimStatus.gate ? 'badge-success' : 'badge-error'">{{ dimStatus.gate ? '达标' : '未达' }}</span>
            </div>
          </div>
          <div class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">AI 特征</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.aiPercent }}%</span>
              <span class="badge badge-xs" :class="dimStatus.ai ? 'badge-success' : 'badge-error'">{{ dimStatus.ai ? '达标' : '未达' }}</span>
            </div>
          </div>
          <div class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">anti-AI 规则</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.antiAiViolations }} 违规</span>
              <span class="badge badge-xs" :class="dimStatus.antiAi ? 'badge-success' : 'badge-error'">{{ dimStatus.antiAi ? '达标' : '未达' }}</span>
            </div>
          </div>
        </div>
        <div v-if="lastCheck && !lastCheck.met" class="text-xs text-warning">
          未达标：{{ lastCheck.reasons.join('；') }}
        </div>
        <p v-if="lastMessage" class="text-xs text-base-content/50 pt-1">{{ lastMessage }}</p>
      </div>
      <p v-else class="text-xs text-base-content/40">尚未运行</p>
    </div>

    <!-- 轮次历史 -->
    <div class="card bg-base-200 border border-base-300 shadow-sm p-5">
      <h4 class="font-semibold text-sm mb-3">轮次历史</h4>
      <div v-if="visibleTurns.length === 0" class="text-xs text-base-content/40 py-4 text-center">无记录</div>
      <div v-else class="space-y-1.5 max-h-72 overflow-y-auto">
        <div v-for="t in visibleTurns" :key="t.id"
          class="flex items-start gap-2 text-xs py-1.5 border-b border-base-300/40 last:border-0">
          <span class="badge badge-xs badge-ghost shrink-0">#{{ t.turn_no }}</span>
          <span class="badge badge-xs shrink-0" :class="t.id === -1 ? 'badge-primary' : 'badge-outline'">
            {{ t.id === -1 ? '运行中' : (t.action ?? t.phase) }}
          </span>
          <span class="text-base-content/70 flex-1">
            <span v-if="t.id === -1" class="text-base-content/40">{{ phaseMap[t.phase ?? ''] ?? t.phase }} · </span>{{ t.summary ?? '-' }}
          </span>
          <span v-if="t.score != null" class="font-mono text-base-content/50 shrink-0">{{ t.score }}</span>
        </div>
      </div>
    </div>

    <!-- 安全提示 -->
    <div class="alert alert-info text-xs py-2">
      <font-awesome-icon icon="info-circle" class="w-4 h-4 shrink-0" />
      <span>每次写正文自动存版本快照；进入「节拍大纲」步骤可逐节拍查看版本历史并回滚。</span>
    </div>
  </div>
</template>
