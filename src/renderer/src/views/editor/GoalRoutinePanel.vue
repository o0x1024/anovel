<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'

const props = defineProps<{ workId: number }>()

interface GoalConfig {
  goalDescription: string
  requireAllBeatsContent: boolean
  targetTotalWords: number | null
  qualityMin: number
  checkConsistencyGate: boolean
  aiPercentMax: number
  checkAntiAiRules: boolean
  maxTurns: number
}

const config = ref<GoalConfig>({
  goalDescription: '',
  requireAllBeatsContent: true,
  targetTotalWords: null,
  qualityMin: 70,
  checkConsistencyGate: true,
  aiPercentMax: 20,
  checkAntiAiRules: true,
  maxTurns: 30
})

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
    antiAi: c.antiAiViolations === 0
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
  await window.anovel.invoke('goal:start', props.workId, {
    goalDescription: config.value.goalDescription,
    requireAllBeatsContent: config.value.requireAllBeatsContent,
    targetTotalWords: config.value.targetTotalWords,
    qualityMin: config.value.qualityMin,
    checkConsistencyGate: config.value.checkConsistencyGate,
    aiPercentMax: config.value.aiPercentMax,
    checkAntiAiRules: config.value.checkAntiAiRules,
    maxTurns: config.value.maxTurns
  })
  await refreshState()
}

async function cancel() {
  await window.anovel.invoke('goal:cancel', props.workId)
  lastMessage.value = '正在取消…'
}

function onProgress(payload: unknown) {
  const ev = payload as GoalProgressEvent
  if (ev.workId !== props.workId) return
  lastMessage.value = ev.message
  lastStatus.value = ev.status
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

watch(() => props.workId, () => void refreshState())
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
      <p class="text-xs text-base-content/40">AI 会据此拆解节拍并贯穿生成，每轮检查是否达成下方各维度目标。</p>
    </div>

    <!-- 目标维度配置 -->
    <div class="card bg-base-200 border border-base-300 shadow-sm p-5 space-y-4">
      <h4 class="font-semibold text-sm">目标维度（全部达成即停）</h4>

      <!-- 完成度 -->
      <div class="space-y-2">
        <p class="text-xs font-bold text-base-content/60">完成度</p>
        <div class="flex flex-wrap items-center gap-4 text-xs">
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input v-model="config.requireAllBeatsContent" type="checkbox" :disabled="running"
              class="checkbox checkbox-xs checkbox-primary" />
            <span>所有节拍须有正文</span>
          </label>
          <label class="flex items-center gap-1.5">
            <span>总字数目标</span>
            <input v-model.number="config.targetTotalWords" type="number" min="0" step="1000"
              :disabled="running" placeholder="留空用作品设定"
              class="input input-bordered input-xs w-32 rounded-lg" />
          </label>
        </div>
      </div>

      <!-- 质量 -->
      <div class="space-y-2">
        <p class="text-xs font-bold text-base-content/60">质量</p>
        <label class="flex items-center gap-1.5 text-xs">
          <span>质量分下限</span>
          <input v-model.number="config.qualityMin" type="number" min="0" max="100"
            :disabled="running" class="input input-bordered input-xs w-20 rounded-lg" />
          <span class="text-base-content/40">/ 100</span>
        </label>
        <label class="flex items-center gap-1.5 cursor-pointer text-xs">
          <input v-model="config.checkConsistencyGate" type="checkbox" :disabled="running"
            class="checkbox checkbox-xs checkbox-primary" />
          <span>一致性门禁通过（无阻塞项）</span>
        </label>
      </div>

      <!-- 去AI（可选） -->
      <div class="space-y-2">
        <p class="text-xs font-bold text-base-content/60">去AI味 <span class="text-base-content/30 font-normal">（可选维度）</span></p>
        <div class="flex flex-wrap items-center gap-4 text-xs">
          <label class="flex items-center gap-1.5">
            <span>AI 特征上限</span>
            <input v-model.number="config.aiPercentMax" type="number" min="0" max="100"
              :disabled="running" class="input input-bordered input-xs w-20 rounded-lg" />
            <span class="text-base-content/40">%</span>
          </label>
          <label class="flex items-center gap-1.5 cursor-pointer">
            <input v-model="config.checkAntiAiRules" type="checkbox" :disabled="running"
              class="checkbox checkbox-xs checkbox-primary" />
            <span>anti-AI 规则零违规</span>
          </label>
        </div>
      </div>

      <!-- 轮次上限 -->
      <label class="flex items-center gap-1.5 text-xs">
        <span>轮次上限</span>
        <input v-model.number="config.maxTurns" type="number" min="1" max="100"
          :disabled="running" class="input input-bordered input-xs w-20 rounded-lg" />
      </label>

      <div class="flex gap-2 pt-2">
        <button v-if="!running" class="btn btn-primary btn-sm gap-2" @click="start">
          <font-awesome-icon icon="play" class="w-3.5 h-3.5" />
          启动目标循环
        </button>
        <button v-else class="btn btn-error btn-sm gap-2" @click="cancel">
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
          <span class="font-mono">{{ state.turn_count }} / {{ state.max_turns }} · {{ state.current_phase ?? '-' }}</span>
        </div>
        <progress class="progress progress-primary w-full" :value="state.turn_count" :max="state.max_turns"></progress>

        <!-- 各维度状态 -->
        <div v-if="lastCheck && dimStatus" class="grid grid-cols-2 gap-2 text-xs">
          <div class="flex items-center justify-between rounded-lg bg-base-100 px-3 py-2 border border-base-300/60">
            <span class="text-base-content/60">节拍</span>
            <span :class="dimStatus.beats ? 'text-success' : 'text-error'">
              {{ dimStatus.beats ? '✓' : '✗' }} {{ lastCheck.contentBeats }}/{{ lastCheck.totalBeats }}
            </span>
          </div>
          <div class="flex items-center justify-between rounded-lg bg-base-100 px-3 py-2 border border-base-300/60">
            <span class="text-base-content/60">字数</span>
            <span :class="dimStatus.words ? 'text-success' : 'text-error'">
              {{ dimStatus.words ? '✓' : '✗' }} {{ lastCheck.totalWords }}/{{ lastCheck.targetWords || config.targetTotalWords || '-' }}
            </span>
          </div>
          <div class="flex items-center justify-between rounded-lg bg-base-100 px-3 py-2 border border-base-300/60">
            <span class="text-base-content/60">质量</span>
            <span :class="dimStatus.quality ? 'text-success' : 'text-error'">
              {{ dimStatus.quality ? '✓' : '✗' }} {{ lastCheck.qualityScore >= 0 ? lastCheck.qualityScore : '-' }}
            </span>
          </div>
          <div class="flex items-center justify-between rounded-lg bg-base-100 px-3 py-2 border border-base-300/60">
            <span class="text-base-content/60">门禁</span>
            <span :class="dimStatus.gate ? 'text-success' : 'text-error'">
              {{ dimStatus.gate ? '✓' : '✗' }} {{ lastCheck.gateBlockers }} 阻塞
            </span>
          </div>
          <div class="flex items-center justify-between rounded-lg bg-base-100 px-3 py-2 border border-base-300/60">
            <span class="text-base-content/60">AI 特征</span>
            <span :class="dimStatus.ai ? 'text-success' : 'text-error'">
              {{ dimStatus.ai ? '✓' : '✗' }} {{ lastCheck.aiPercent }}%
            </span>
          </div>
          <div class="flex items-center justify-between rounded-lg bg-base-100 px-3 py-2 border border-base-300/60">
            <span class="text-base-content/60">规则</span>
            <span :class="dimStatus.antiAi ? 'text-success' : 'text-error'">
              {{ dimStatus.antiAi ? '✓' : '✗' }} {{ lastCheck.antiAiViolations }} 违规
            </span>
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
      <div v-if="turns.length === 0" class="text-xs text-base-content/40 py-4 text-center">无记录</div>
      <div v-else class="space-y-1.5 max-h-72 overflow-y-auto">
        <div v-for="t in turns" :key="t.id"
          class="flex items-start gap-2 text-xs py-1.5 border-b border-base-300/40 last:border-0">
          <span class="badge badge-xs badge-ghost shrink-0">#{{ t.turn_no }}</span>
          <span class="badge badge-xs badge-outline shrink-0">{{ t.action ?? t.phase }}</span>
          <span class="text-base-content/70 flex-1">{{ t.summary ?? '-' }}</span>
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
