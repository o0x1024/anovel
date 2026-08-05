<script setup lang="ts">
import { ref, computed, inject, onMounted, onActivated, onUnmounted, watch } from 'vue'
import { useBodyGenerationModel } from '../../composables/useBodyGenerationModel'
import {
  STORY_GOAL_ROUTINE_PHASE_ORDER,
  NOVEL_GOAL_ROUTINE_PHASE_ORDER,
  getGoalRoutinePhaseLabels,
  goalRoutinePhaseLabel,
  isGoalRoutinePhase,
  type GoalRoutinePhase
} from '../../../../shared/goal-routine-phases'
import { formatDbUtcAsLocal } from '../../../../shared/local-datetime'
import {
  isTotalWordCountInTargetRange,
  BODY_WORD_COUNT_TOLERANCE,
  BODY_WORD_COUNT_TOLERANCE_MAX
} from '../../../../shared/body-word-target'
import { requireGoalTurnLimit } from '../../../../shared/goal-turn-limit'
import {
  QUALITY_AI_METRIC_DEFS,
  type QualityAiMetricKey
} from '../../../../shared/quality-ai-score'
import { WORDS_PER_CHAPTER_PRESETS } from '../../../../shared/writing-plan-presets'
import { editorNavKey } from './editor-nav'

const props = defineProps<{ workId: number; workType?: 'novel' | 'story' }>()
const nav = inject(editorNavKey)
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)

const availablePhases = computed<GoalRoutinePhase[]>(() => {
  if (props.workType === 'novel') {
    return config.value.incubatorEnabled
      ? [...STORY_GOAL_ROUTINE_PHASE_ORDER.slice(0, 3), ...NOVEL_GOAL_ROUTINE_PHASE_ORDER]
      : NOVEL_GOAL_ROUTINE_PHASE_ORDER
  }
  return STORY_GOAL_ROUTINE_PHASE_ORDER
})

const CONFIG_STORAGE_KEY = 'goalRoutineConfig'

interface GoalConfig {
  goalDescription: string
  requireAllBeatsContent: boolean
  targetTotalWords: number | null
  wordsPerChapter: number | null
  wordCountTolerance: number
  qualityMin: number
  qualityMetricMins: Record<QualityAiMetricKey, number>
  diagnoseBodyAfterGeneration: boolean
  checkEmotionContract: boolean
  checkEmotionGate: boolean
  humanReviewTitleHook: boolean
  checkConsistencyGate: boolean
  checkAntiAiRules: boolean
  maxTurns: number
  autonomousMaxEpochs: number
  goalMatchMin: number
  overallStoryMin: number
  previewHookMin: number
  proseReadMin: number
  previewRatio: number
  incubatorEnabled: boolean
  goldenFingerRequired: boolean
}

const DEFAULT_CONFIG: GoalConfig = {
  goalDescription: '',
  requireAllBeatsContent: true,
  targetTotalWords: null,
  wordsPerChapter: null,
  wordCountTolerance: BODY_WORD_COUNT_TOLERANCE,
  qualityMin: 85,
  qualityMetricMins: Object.fromEntries(
    QUALITY_AI_METRIC_DEFS.map(metric => [metric.key, 85])
  ) as Record<QualityAiMetricKey, number>,
  diagnoseBodyAfterGeneration: true,
  checkEmotionContract: true,
  checkEmotionGate: true,
  humanReviewTitleHook: false,
  checkConsistencyGate: true,
  checkAntiAiRules: true,
  maxTurns: props.workType === 'story' ? 30 : 60,
  autonomousMaxEpochs: 20,
  goalMatchMin: 85,
  overallStoryMin: 80,
  previewHookMin: 75,
  proseReadMin: 78,
  previewRatio: 0.3,
  incubatorEnabled: false,
  goldenFingerRequired: false
}

function loadConfig(): GoalConfig {
  try {
    const raw = localStorage.getItem(`${CONFIG_STORAGE_KEY}:${props.workId}`)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<GoalConfig>
      const merged = {
        ...DEFAULT_CONFIG,
        ...saved,
        qualityMetricMins: {
          ...DEFAULT_CONFIG.qualityMetricMins,
          ...saved.qualityMetricMins
        }
      }
      return merged
    }
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
  id: number
  work_id: number
  status: string
  turn_count: number
  max_turns: number
  current_phase: string | null
  last_quality_score: number | null
  goal_met: number
  update_time: string
  state_json: string | null
}

interface GoalCheckResult {
  met: boolean
  beatCompletion: number
  totalBeats: number
  contentBeats: number
  totalWords: number
  targetWords: number
  qualityScore: number
  emotionScore: number
  qualityHardFail: boolean
  gateBlockers: number
  antiAiViolations: number
  goalMatchScore: number
  goalMatchReason: string
  overallStoryScore: number
  overallStoryReason: string
  previewHookScore: number
  previewHookReason: string
  proseReadScore: number
  proseReadReason: string
  weakestLayer: 'storyline' | 'beat' | 'scene' | 'paragraph'
  weakChapterTitles: string[]
  storyIssues: string[]
  previewReport: string | null
  advisories: string[]
  reasons: string[]
}

interface GoalTurn {
  id: number
  turn_no: number
  phase: string | null
  action: string | null
  target_chapter_id: number | null
  score: number | null
  summary: string | null
  create_time: string
}

interface WorkflowStep {
  id: number
  step_key: string
  scope_key: string
  attempt_no: number
  status: 'running' | 'completed' | 'failed' | 'waiting' | 'cancelled'
  error_class: string | null
  error_code: string | null
  error_message: string | null
  generation_step: string | null
  model_type: string | null
  model_name: string | null
  model_duration_ms: number | null
  model_finish_reason: string | null
  started_at: string
}

const WORKFLOW_STEP_LABELS: Record<string, string> = {
  causal_state_init: '权威因果状态初始化',
  chapter_decision: '章级因果决策',
  body_generation: '正文生成',
  body_acceptance: '章节硬合同验收',
  chapter_commit: '记忆与因果原子提交'
}

function workflowStepLabel(step: WorkflowStep): string {
  return WORKFLOW_STEP_LABELS[step.step_key] ?? step.step_key
}

function workflowStepAction(step: WorkflowStep): string {
  if (step.error_code === 'MODEL_CAPABILITY_UNSUPPORTED') {
    return '处理：为该步骤选择可用模型，或使用提示词 JSON 协议后显式恢复。'
  }
  if (step.error_code === 'MODEL_CONTRACT_UNAVAILABLE') {
    return '处理：补全模型、密钥和 API 地址后重新启动运行。'
  }
  if (step.error_code === 'MODEL_REQUEST_PROTOCOL_INVALID') {
    return '处理：修正步骤的结构化输出协议；继续运行不会自行恢复。'
  }
  if (step.error_code === 'PREREQUISITE_MISSING') {
    return '处理：缺少上游权威状态；自治循环会回溯并重建对应作品修订。'
  }
  if (step.error_code === 'QUALITY_NON_CONVERGENT') {
    return '处理：自治循环会保留最佳稿，并按单章、章节簇、卷级依赖闭包逐级修复。'
  }
  if (step.error_code === 'EMOTION_NON_CONVERGENT') {
    return '处理：质量结论仍被保留；自治循环只修复情绪证据及其因果依赖。'
  }
  if (step.error_code === 'EXECUTION_CONTRACT_NON_CONVERGENT') {
    return '处理：质量与情绪结论仍被保留；自治循环会重建缺失的章节合同证据。'
  }
  if (step.error_class === 'transient_transport') {
    return '处理：网络恢复后可从当前子步骤继续。'
  }
  if (
    step.error_class === 'unknown'
    && step.error_message?.includes('未通过章节联合门禁')
  ) {
    return '升级前历史记录：已迁移为“自动修订未收敛”，不会再次按系统异常重试。'
  }
  return ''
}

function workflowStepErrorLabel(step: WorkflowStep): string {
  if (
    step.error_class === 'unknown'
    && step.error_message?.includes('未通过章节联合门禁')
  ) {
    return '历史质量不收敛 / 已迁移'
  }
  return `${step.error_class} / ${step.error_code}`
}

interface StoryHarnessIssue {
  id: number
  code: string
  severity: string
  scope: string
  message: string
  expected_result: string | null
  attempts: number
  status: 'open' | 'resolved' | 'stalled'
}

interface ChapterAcceptanceSummary {
  episodeId: number
  status: 'running' | 'awaiting_resume' | 'blocked' | 'accepted' | 'superseded'
  chapterId: number
  chapterTitle: string
  assessmentsUsed: number
  maxAssessments: number
  repairsUsed: number
  maxRepairs: number
  bestScore: number | null
  bestContentHash: string | null
  currentContentHash: string
  contentChanged: boolean
  terminalCode: string | null
  terminalReason: string | null
  authorNote: string | null
  gates: Array<{
    gateType: 'quality' | 'emotion' | 'execution_contract'
    status: 'pending' | 'deferred' | 'passed_model' | 'passed_author' | 'failed' | 'stale'
    score: number | null
    failureCode: string | null
    failureReason: string | null
    blockers: string[]
  }>
  blockedGate: 'quality' | 'emotion' | 'execution_contract' | null
  canResumeDownstream: boolean
  blockingFailures: string[]
  advisoryFailures: string[]
  evidence: Array<{ id: string; evidence: string; fixHint: string }>
}

function chapterGateLabel(gateType: ChapterAcceptanceSummary['gates'][number]['gateType']): string {
  return {
    quality: '质量',
    emotion: '情绪',
    execution_contract: '章节合同'
  }[gateType]
}

function chapterGateStatusLabel(status: ChapterAcceptanceSummary['gates'][number]['status']): string {
  return {
    pending: '待执行',
    deferred: '不阻塞',
    passed_model: '模型通过',
    passed_author: '历史人工确认',
    failed: '未通过',
    stale: '正文变化后失效'
  }[status]
}

interface TitleHookCandidate {
  title: string
  hook: string
  type?: string
  summary?: string
}

interface ReleaseSnapshot {
  id: number
  label: string
  create_time: string
}

interface ReaderCalibration {
  sampleSize: number
  impressions: number
  openRate: number
  previewCompletionRate: number
  completionRate: number
  engagementRate: number
  suggestedPreviewHookMin: number | null
  suggestedOverallStoryMin: number | null
  confidence: 'insufficient' | 'directional' | 'stable'
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
const workflowSteps = ref<WorkflowStep[]>([])
const chapterAcceptance = ref<ChapterAcceptanceSummary | null>(null)
const harnessIssues = ref<StoryHarnessIssue[]>([])
const titleHookCandidates = ref<TitleHookCandidate[]>([])
const titleHookPreferredIndex = ref(0)
const selectingTitleHook = ref(false)
const releaseSnapshots = ref<ReleaseSnapshot[]>([])
const readerCalibration = ref<ReaderCalibration | null>(null)
const savingReaderFeedback = ref(false)
const readerFeedbackForm = ref({
  releaseSnapshotId: 0,
  source: '番茄小说',
  impressions: 0,
  openedReads: 0,
  previewCompletions: 0,
  completions: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  follows: 0,
  avgReadSeconds: null as number | null,
  notes: ''
})
const running = ref(false)
const lastMessage = ref('')
const lastStatus = ref('')
const lastCheck = ref<GoalCheckResult | null>(null)
const terminalReason = ref<string | null>(null)

const statusLabel = computed(() => {
  const s = state.value?.status
  const map: Record<string, string> = {
    idle: '空闲', running: '运行中', waiting: '自动恢复中', paused: '已暂停',
    goal_met: '已达成', timeout: '轮次上限', error: '出错',
    cancelled: '已取消', superseded: '已被新运行替代'
  }
  return map[s ?? 'idle'] ?? s
})
const statusBadge = computed(() => {
  const s = state.value?.status
  const map: Record<string, string> = {
    running: 'badge-primary', waiting: 'badge-info', goal_met: 'badge-success',
    timeout: 'badge-warning', error: 'badge-error', cancelled: 'badge-ghost',
    paused: 'badge-warning', idle: 'badge-ghost'
  }
  return map[s ?? 'idle'] ?? 'badge-ghost'
})

const phaseMap = computed(() => getGoalRoutinePhaseLabels(props.workType))

const phaseLabel = computed(() => goalRoutinePhaseLabel(state.value?.current_phase, props.workType))

const liveTurn = ref<GoalProgressEvent | null>(null)
const acceptanceNeedsEditor = computed(() =>
  props.workType === 'novel'
  && chapterAcceptance.value?.status === 'blocked'
)
const unchangedAcceptanceBlock = computed(() =>
  acceptanceNeedsEditor.value && chapterAcceptance.value?.contentChanged === false
)
const hasResumeCheckpoint = computed(() => {
  const s = state.value?.status
  return s === 'paused' || s === 'cancelled' || s === 'timeout' || s === 'error'
    || (s === 'running' && !running.value)
})
const canResume = computed(() => {
  const s = state.value?.status
  if (!s || s === 'goal_met') return false
  if (running.value && s === 'running') return false
  return s === 'paused' || s === 'cancelled' || s === 'timeout' || s === 'error'
    || (s === 'running' && !running.value)
})

const resumeLabel = computed(() =>
  chapterAcceptance.value?.canResumeDownstream
    ? '继续情绪与合同验收'
    : state.value?.status === 'timeout' ? '继续运行' : '断点续跑'
)

const startLabel = computed(() => {
  return unchangedAcceptanceBlock.value
    ? '用新验收合同重新检查'
    : acceptanceNeedsEditor.value && chapterAcceptance.value?.contentChanged
      ? '重新验收已修改正文'
      : terminalReason.value === 'needs_manual_editor'
    ? '重新验收当前正文'
    : canResume.value
      ? '放弃断点并启动新一轮'
      : state.value?.status === 'timeout' && !state.value?.goal_met
        ? '继续运行'
        : '启动目标循环'
})

const resumeFromPhase = ref<GoalRoutinePhase>(availablePhases.value[0] ?? 'materialize_settings')
const phasePickerTouched = ref(false)

const showResumePhasePicker = computed(() => {
  if (running.value) return false
  const s = state.value
  if (!s) return false
  if (s.goal_met) return true
  if (s.status === 'paused' || s.status === 'cancelled' || s.status === 'timeout') return true
  return (s.turn_count ?? 0) > 0 && Boolean(s.current_phase)
})

function normalizePhase(phase: string | null | undefined): GoalRoutinePhase {
  if (phase && isGoalRoutinePhase(phase) && availablePhases.value.includes(phase)) {
    return phase
  }
  return availablePhases.value[0] ?? 'materialize_settings'
}

function syncResumePhaseFromState(): void {
  if (phasePickerTouched.value) return
  resumeFromPhase.value = normalizePhase(state.value?.current_phase)
}
const visibleTurns = computed(() => {
  // 一轮可产生“开始 / 完成 / error”等多个审计事件；历史卡按轮次展示最新结果，
  // 既保留失败轮次，也避免同一编号刷屏。
  const history = turns.value.filter((turn, index, all) =>
    all.findIndex(candidate => candidate.turn_no === turn.turn_no) === index
  )
  const ev = liveTurn.value
  if (!ev || ev.status !== 'running') return history
  return [{
    id: -1,
    turn_no: ev.turn,
    phase: ev.phase,
    action: 'running',
    target_chapter_id: null,
    score: null,
    summary: ev.message,
    create_time: new Date().toISOString()
  }, ...history.filter(turn => turn.turn_no !== ev.turn)]
})

/** 各维度达标状态（✓/✗） */
const dimStatus = computed(() => {
  const c = lastCheck.value
  if (!c) return null
  const cfg = config.value
  return {
    beats: c.totalBeats > 0 && c.contentBeats === c.totalBeats,
    words: isTotalWordCountInTargetRange(c.totalWords, c.targetWords),
    quality: c.qualityScore >= 0 && !c.qualityHardFail && c.qualityScore >= cfg.qualityMin,
    emotion: c.emotionScore >= 80,
    gate: c.gateBlockers === 0,
    antiAi: !c.reasons.some(reason => reason.includes('anti-AI 规则达到阻塞阈值')),
    goal: !cfg.goalDescription.trim() || cfg.goalMatchMin <= 0 || c.goalMatchScore >= cfg.goalMatchMin,
    overall: props.workType !== 'story' || cfg.overallStoryMin <= 0 || c.overallStoryScore >= cfg.overallStoryMin,
    preview: props.workType !== 'story' || cfg.previewHookMin <= 0 || c.previewHookScore >= cfg.previewHookMin,
    prose: props.workType !== 'story' || cfg.proseReadMin <= 0 || c.proseReadScore >= cfg.proseReadMin
  }
})

function subjectiveBadgeClass(passed: boolean, blocked = false): string {
  if (passed) return 'badge-success'
  return props.workType === 'story' && !blocked ? 'badge-warning' : 'badge-error'
}

function subjectiveBadgeLabel(passed: boolean, blocked = false): string {
  if (passed) return '达标'
  return props.workType === 'story' && !blocked ? '建议优化' : '未达'
}

const previewRatioPct = computed({
  get: () => Math.round(config.value.previewRatio * 100),
  set: (v: number) => { config.value.previewRatio = Math.max(0.01, Math.min(0.95, v / 100)) }
})

const wordCountTolerancePct = computed({
  get: () => Math.round(Math.min(
    BODY_WORD_COUNT_TOLERANCE_MAX,
    config.value.wordCountTolerance || BODY_WORD_COUNT_TOLERANCE
  ) * 100),
  set: (v: number) => {
    config.value.wordCountTolerance = Math.min(BODY_WORD_COUNT_TOLERANCE_MAX, Math.max(0.05, (Number(v) || 25) / 100))
  }
})

const chapterWordUnit = computed(() =>
  props.workType === 'story' ? '每拍' : '每章'
)

const chapterWordRangeHint = computed(() => {
  const target = Number(config.value.wordsPerChapter)
  if (!target || target <= 0) return ''
  const ratio = Math.min(
    BODY_WORD_COUNT_TOLERANCE_MAX,
    config.value.wordCountTolerance || BODY_WORD_COUNT_TOLERANCE
  )
  const min = Math.floor(target * (1 - ratio))
  const max = Math.ceil(target * (1 + ratio))
  return `门禁范围约 ${min}-${max} 字`
})

async function hydrateWordsPerChapterFromPlan(): Promise<void> {
  try {
    const plan = await window.anovel.invoke('writingPlan:get', props.workId) as { wordsPerChapter?: number }
    if (
      (config.value.wordsPerChapter == null || config.value.wordsPerChapter <= 0)
      && typeof plan.wordsPerChapter === 'number'
      && plan.wordsPerChapter > 0
    ) {
      config.value.wordsPerChapter = plan.wordsPerChapter
    }
  } catch { /* ignore */ }
}

async function refreshState() {
  const res = await window.anovel.invoke('goal:getState', props.workId) as {
    state: GoalState | null
    turns: GoalTurn[]
    steps: WorkflowStep[]
    harnessIssues: StoryHarnessIssue[]
    chapterAcceptance: ChapterAcceptanceSummary | null
  }
  state.value = res.state
  turns.value = res.turns
  workflowSteps.value = res.steps ?? []
  chapterAcceptance.value = res.chapterAcceptance ?? null
  harnessIssues.value = res.harnessIssues ?? []
  if (res.state?.state_json) {
    try {
      const runtime = JSON.parse(res.state.state_json) as {
        lastCheck?: GoalCheckResult
        terminalReason?: string
        titleHookCandidates?: TitleHookCandidate[]
        titleHookPreferredIndex?: number
        liveProgress?: {
          turn: number
          phase: string
          status: string
          message: string
          updatedAt: string
        }
      }
      lastCheck.value = runtime.lastCheck ?? null
      terminalReason.value = runtime.terminalReason ?? null
      if (chapterAcceptance.value?.status === 'blocked') {
        terminalReason.value = 'needs_manual_editor'
      }
      titleHookCandidates.value = runtime.titleHookCandidates ?? []
      titleHookPreferredIndex.value = runtime.titleHookPreferredIndex ?? 0
      if (runtime.liveProgress?.message) {
        lastMessage.value = runtime.liveProgress.message
        lastStatus.value = runtime.liveProgress.status
        liveTurn.value = runtime.liveProgress.status === 'running'
          ? {
              workId: props.workId,
              turn: runtime.liveProgress.turn,
              maxTurns: res.state.max_turns,
              phase: runtime.liveProgress.phase,
              status: runtime.liveProgress.status,
              message: runtime.liveProgress.message
            }
          : null
      }
    } catch {
      lastCheck.value = null
      terminalReason.value = chapterAcceptance.value?.status === 'blocked'
        ? 'needs_manual_editor'
        : null
      titleHookCandidates.value = []
      titleHookPreferredIndex.value = 0
    }
  } else {
    lastCheck.value = null
    terminalReason.value = null
    if (chapterAcceptance.value?.status === 'blocked') {
      terminalReason.value = 'needs_manual_editor'
    }
    titleHookCandidates.value = []
    titleHookPreferredIndex.value = 0
  }
  if (!lastMessage.value && res.turns[0]?.summary) {
    lastMessage.value = res.turns[0].summary
  }
  if (chapterAcceptance.value?.status === 'blocked') {
    lastStatus.value = 'paused'
    liveTurn.value = null
    const gateLabel = chapterAcceptance.value.blockedGate === 'emotion'
      ? '情绪门禁未通过'
      : chapterAcceptance.value.blockedGate === 'execution_contract'
        ? '章节合同未通过'
        : '质量修订未收敛'
    lastMessage.value = `${gateLabel}，已保存正文、决策与逐轮证据：${
      chapterAcceptance.value.terminalReason ?? chapterAcceptance.value.blockingFailures.join('、')
    }`
  }
  running.value = await window.anovel.invoke('goal:isRunning', props.workId) as boolean
  if (props.workType === 'story') {
    const feedback = await window.anovel.invoke('goal:getReaderFeedback', props.workId) as {
      releaseSnapshots: ReleaseSnapshot[]
      calibration: ReaderCalibration
    }
    releaseSnapshots.value = feedback.releaseSnapshots ?? []
    readerCalibration.value = feedback.calibration ?? null
    if (!readerFeedbackForm.value.releaseSnapshotId && releaseSnapshots.value[0]) {
      readerFeedbackForm.value.releaseSnapshotId = releaseSnapshots.value[0].id
    }
  }
  syncResumePhaseFromState()
}

async function selectTitleHook(index: number) {
  if (selectingTitleHook.value || running.value) return
  selectingTitleHook.value = true
  try {
    await window.anovel.invoke('goal:selectTitleHook', props.workId, index)
    lastMessage.value = `已确认书名「${titleHookCandidates.value[index]?.title ?? ''}」，可断点续跑`
    await refreshState()
  } catch (error) {
    lastStatus.value = 'error'
    lastMessage.value = `确认书名导语失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    selectingTitleHook.value = false
  }
}

async function saveReaderFeedback() {
  if (savingReaderFeedback.value || !readerFeedbackForm.value.releaseSnapshotId) return
  savingReaderFeedback.value = true
  try {
    const result = await window.anovel.invoke('goal:recordReaderFeedback', props.workId, {
      ...readerFeedbackForm.value,
      collectedAt: new Date().toISOString()
    }) as { calibration: ReaderCalibration }
    readerCalibration.value = result.calibration
    lastStatus.value = 'success'
    lastMessage.value = '发布后读者数据已保存，并重新计算校准建议'
  } catch (error) {
    lastStatus.value = 'error'
    lastMessage.value = `保存读者数据失败：${error instanceof Error ? error.message : String(error)}`
  } finally {
    savingReaderFeedback.value = false
  }
}

function goalInvokePayload() {
  return {
    goalDescription: config.value.goalDescription,
    requireAllBeatsContent: config.value.requireAllBeatsContent,
    targetTotalWords: config.value.targetTotalWords,
    wordsPerChapter: config.value.wordsPerChapter,
    wordCountTolerance: Math.min(BODY_WORD_COUNT_TOLERANCE_MAX, Math.max(0.05, Number(config.value.wordCountTolerance) || BODY_WORD_COUNT_TOLERANCE)),
    qualityMin: config.value.qualityMin,
    qualityMetricMins: { ...config.value.qualityMetricMins },
    diagnoseBodyAfterGeneration: config.value.diagnoseBodyAfterGeneration,
    checkEmotionContract: config.value.checkEmotionContract,
    checkEmotionGate: config.value.checkEmotionGate,
    humanReviewTitleHook: config.value.humanReviewTitleHook,
    checkConsistencyGate: config.value.checkConsistencyGate,
    checkAntiAiRules: config.value.checkAntiAiRules,
    maxTurns: requireGoalTurnLimit(config.value.maxTurns),
    goalMatchMin: config.value.goalMatchMin,
    overallStoryMin: config.value.overallStoryMin,
    previewHookMin: config.value.previewHookMin,
    proseReadMin: config.value.proseReadMin,
    previewRatio: config.value.previewRatio,
    ...(props.workType === 'novel'
      ? {
          incubatorEnabled: config.value.incubatorEnabled,
          goldenFingerRequired: config.value.goldenFingerRequired
        }
      : {}),
    ...bodyModelParams()
  }
}

function resumeInvokePayload() {
  const payload = goalInvokePayload()
  if (isGoalRoutinePhase(resumeFromPhase.value)) {
    return { ...payload, forcePhase: resumeFromPhase.value }
  }
  return payload
}

async function start() {
  if (running.value) return
  if (hasResumeCheckpoint.value) {
    const confirmed = window.confirm(
      '当前存在可恢复断点。“启动新一轮”会将轮次归零并可能重新执行所选阶段；已有正文和版本不会删除。若要保留原轮次，请取消并点击“断点续跑”。\n\n确定放弃本次断点位置并启动新一轮吗？'
    )
    if (!confirmed) return
  }
  const useResumePayload = showResumePhasePicker.value
  const payload = useResumePayload ? resumeInvokePayload() : goalInvokePayload()
  const message = useResumePayload
    ? `从「${goalRoutinePhaseLabel(resumeFromPhase.value, props.workType)}」启动新一轮…`
    : '目标循环启动新一轮…'
  phasePickerTouched.value = false
  running.value = true
  lastStatus.value = 'running'
  lastMessage.value = message
  liveTurn.value = null
  await window.anovel.invoke('goal:start', props.workId, payload)
  await refreshState()
}

async function cancel() {
  await window.anovel.invoke('goal:cancel', props.workId)
  lastMessage.value = '正在取消…'
}

async function resume() {
  if (running.value) return
  const payload = {
    ...goalInvokePayload(),
    expectedRunId: state.value?.id
  }
  const savedPhase = normalizePhase(state.value?.current_phase)
  const message = state.value?.status === 'timeout'
    ? `从断点「${goalRoutinePhaseLabel(savedPhase, props.workType)}」继续运行…`
    : `从断点「${goalRoutinePhaseLabel(savedPhase, props.workType)}」续跑…`
  phasePickerTouched.value = false
  running.value = true
  lastStatus.value = 'running'
  lastMessage.value = message
  liveTurn.value = null
  await window.anovel.invoke('goal:resume', props.workId, payload)
  await refreshState()
}

async function resumeAtPhase(phase: GoalRoutinePhase, message: string) {
  if (running.value) return
  running.value = true
  lastStatus.value = 'running'
  lastMessage.value = message
  liveTurn.value = null
  await window.anovel.invoke('goal:resume', props.workId, {
    ...goalInvokePayload(),
    expectedRunId: state.value?.id,
    forcePhase: phase
  })
  await refreshState()
}

async function recheckExistingNovel() {
  if (running.value) return
  resumeFromPhase.value = 'goal_check'
  phasePickerTouched.value = true
  await start()
}

async function copyEvaluationData() {
  try {
    const data = await window.anovel.invoke('goal:getEvaluationData', props.workId)
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    lastMessage.value = '评测记录已复制，可用于人工盲评与阈值校准'
  } catch (error) {
    lastMessage.value = `复制评测记录失败：${error instanceof Error ? error.message : String(error)}`
  }
}

function openAcceptanceChapter() {
  nav?.goToPanel('chapters')
}

async function copyChapterAcceptanceEvidence() {
  if (!chapterAcceptance.value) return
  await navigator.clipboard.writeText(JSON.stringify(chapterAcceptance.value, null, 2))
  lastMessage.value = '章节验收证据已复制'
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
  void hydrateWordsPerChapterFromPlan()
})

onActivated(() => {
  void refreshState()
  void hydrateWordsPerChapterFromPlan()
})

onUnmounted(() => {
  window.anovel.off('goal:progress', onProgress)
})

watch(() => props.workId, () => {
  config.value = loadConfig()
  phasePickerTouched.value = false
  void refreshState()
  void hydrateWordsPerChapterFromPlan()
})

watch(config, saveConfig, { deep: true })
</script>

<template>
  <div class="w-full min-w-0 space-y-5">
    <div class="flex items-center gap-3">
      <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
        <font-awesome-icon icon="rotate" class="text-lg" />
      </div>
      <div>
        <h3 class="text-lg font-bold">目标循环</h3>
        <p class="text-xs text-base-content/50">
          {{ `给定创作目标，AI 自主生成一篇完整${workType === 'story' ? '短故事' : '小说'}直到达成或轮次上限` }}
        </p>
      </div>
      <span class="badge badge-sm ml-auto" :class="statusBadge">{{ statusLabel }}</span>
    </div>

    <div v-if="workType === 'story' && titleHookCandidates.length > 0"
      class="card bg-warning/5 border border-warning/30 shadow-sm p-5 space-y-3">
      <div>
        <h4 class="font-semibold text-sm">确认书名与导语</h4>
        <p class="text-xs text-base-content/50 mt-1">循环已暂停。只有你确认后才会写入作品并继续；“编辑推荐”只表示盲评优胜，不会自动采用。</p>
      </div>
      <button
        v-for="(candidate, index) in titleHookCandidates"
        :key="`${candidate.title}-${index}`"
        type="button"
        class="w-full text-left rounded-xl border p-4 transition-colors hover:border-primary"
        :class="index === titleHookPreferredIndex ? 'border-primary/60 bg-primary/5' : 'border-base-300 bg-base-100'"
        :disabled="selectingTitleHook || running"
        @click="selectTitleHook(index)"
      >
        <div class="flex items-center gap-2">
          <span class="font-semibold text-sm">{{ candidate.title }}</span>
          <span v-if="index === titleHookPreferredIndex" class="badge badge-primary badge-xs">编辑推荐</span>
        </div>
        <p class="text-xs leading-relaxed text-base-content/70 mt-2">{{ candidate.hook }}</p>
      </button>
    </div>

    <div v-if="workType === 'story' && releaseSnapshots.length > 0"
      class="card bg-base-200 border border-base-300 shadow-sm p-5 space-y-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h4 class="font-semibold text-sm">发布后读者反馈</h4>
          <p class="text-xs text-base-content/40 mt-1">只记录真实平台漏斗；样本不足时不调整模型阈值。</p>
        </div>
        <span v-if="readerCalibration" class="badge badge-sm"
          :class="readerCalibration.confidence === 'stable' ? 'badge-success' : readerCalibration.confidence === 'directional' ? 'badge-warning' : 'badge-ghost'">
          {{ readerCalibration.confidence === 'stable' ? '稳定样本' : readerCalibration.confidence === 'directional' ? '方向样本' : '样本不足' }}
        </span>
      </div>
      <div v-if="readerCalibration" class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <div class="rounded-lg bg-base-100 p-3"><span class="text-base-content/40">打开率</span><p class="font-semibold mt-1">{{ (readerCalibration.openRate * 100).toFixed(1) }}%</p></div>
        <div class="rounded-lg bg-base-100 p-3"><span class="text-base-content/40">试读完成</span><p class="font-semibold mt-1">{{ (readerCalibration.previewCompletionRate * 100).toFixed(1) }}%</p></div>
        <div class="rounded-lg bg-base-100 p-3"><span class="text-base-content/40">全文完成</span><p class="font-semibold mt-1">{{ (readerCalibration.completionRate * 100).toFixed(1) }}%</p></div>
        <div class="rounded-lg bg-base-100 p-3"><span class="text-base-content/40">互动率</span><p class="font-semibold mt-1">{{ (readerCalibration.engagementRate * 100).toFixed(1) }}%</p></div>
      </div>
      <p v-if="readerCalibration?.suggestedPreviewHookMin != null" class="text-xs text-base-content/60">
        校准建议：试读追读力阈值 {{ readerCalibration.suggestedPreviewHookMin }}，整篇兑现阈值 {{ readerCalibration.suggestedOverallStoryMin }}。建议人工确认后再改配置。
      </p>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
        <select v-model.number="readerFeedbackForm.releaseSnapshotId" class="select select-bordered select-xs">
          <option v-for="snapshot in releaseSnapshots" :key="snapshot.id" :value="snapshot.id">快照 #{{ snapshot.id }}</option>
        </select>
        <input v-model.trim="readerFeedbackForm.source" class="input input-bordered input-xs" placeholder="数据来源" />
        <input v-model.number="readerFeedbackForm.impressions" type="number" min="0" class="input input-bordered input-xs" placeholder="曝光" />
        <input v-model.number="readerFeedbackForm.openedReads" type="number" min="0" class="input input-bordered input-xs" placeholder="打开阅读" />
        <input v-model.number="readerFeedbackForm.previewCompletions" type="number" min="0" class="input input-bordered input-xs" placeholder="试读完成" />
        <input v-model.number="readerFeedbackForm.completions" type="number" min="0" class="input input-bordered input-xs" placeholder="全文完成" />
        <input v-model.number="readerFeedbackForm.likes" type="number" min="0" class="input input-bordered input-xs" placeholder="点赞" />
        <input v-model.number="readerFeedbackForm.comments" type="number" min="0" class="input input-bordered input-xs" placeholder="评论" />
        <input v-model.number="readerFeedbackForm.shares" type="number" min="0" class="input input-bordered input-xs" placeholder="分享" />
        <input v-model.number="readerFeedbackForm.follows" type="number" min="0" class="input input-bordered input-xs" placeholder="关注" />
        <input v-model.number="readerFeedbackForm.avgReadSeconds" type="number" min="0" class="input input-bordered input-xs" placeholder="平均阅读秒数" />
        <input v-model.trim="readerFeedbackForm.notes" class="input input-bordered input-xs" placeholder="备注" />
      </div>
      <button type="button" class="btn btn-primary btn-sm self-start" :disabled="savingReaderFeedback" @click="saveReaderFeedback">
        {{ savingReaderFeedback ? '保存中…' : '保存并校准' }}
      </button>
    </div>

    <!-- 创作目标（自由文字） -->
    <div class="card bg-base-200 border border-base-300 shadow-sm p-5 space-y-3">
      <h4 class="font-semibold text-sm">创作目标</h4>
      <textarea
        v-model="config.goalDescription"
        :disabled="running"
        rows="3"
        :placeholder="workType === 'novel'
          ? '描述你想要的小说：题材、风格、主角、情节走向、结局要求……例如「都市重生，男主修仙，20章，逆袭爽文」'
          : '描述你想要的故事：题材、风格、主角、情节走向、结局要求……例如「都市言情，女主复仇，5个节拍，反转结局」'"
        class="textarea textarea-bordered w-full text-sm rounded-lg resize-none leading-relaxed"
      ></textarea>
      <p class="text-xs text-base-content/40">会自动回填：{{ workType === 'novel'
          ? (config.incubatorEnabled ? '大纲孵化 → AI 门禁/冻结 → ' : '') + '核心设定 → 主角人设卡 → 整体自检 → 分卷大纲 → 章节大纲 → 权威因果决策 → 书名导语 → 正文门禁 → 章后事实原子提交'
          : '核心设定 → 主角人设卡 → 故事发动机 → 节拍大纲 → 书名导语 → 整体自检 → 正文生成' }}；进度区会显示当前子步骤。</p>
      <div v-if="workType === 'novel'" class="flex flex-wrap items-center gap-x-6 gap-y-2 pt-1 border-t border-base-300/40">
        <label class="flex items-center gap-2 text-xs cursor-pointer">
          <input v-model="config.incubatorEnabled" type="checkbox" :disabled="running"
            class="checkbox checkbox-xs checkbox-primary" />
          <span>启用大纲孵化器</span>
          <span class="text-base-content/40">— 先孵化情绪定位、核心冲突和黄金开局</span>
        </label>
        <label class="flex items-center gap-2 text-xs cursor-pointer">
          <input v-model="config.goldenFingerRequired" type="checkbox" :disabled="running"
            class="checkbox checkbox-xs checkbox-primary" />
          <span>金手指</span>
          <span class="text-base-content/40">— 选择后必须生成并通过结构化校验</span>
        </label>
      </div>
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
            <span>所有{{ workType === 'novel' ? '章节' : '节拍' }}须有正文</span>
            <input v-model="config.requireAllBeatsContent" type="checkbox" :disabled="running"
              class="checkbox checkbox-xs checkbox-primary" />
          </label>
          <label class="flex items-center justify-between gap-3 text-xs">
            <span>总字数目标</span>
            <input v-model.number="config.targetTotalWords" type="number" min="0" step="1000"
              :disabled="running" placeholder="作品设定"
              class="input input-bordered input-xs w-28 rounded-lg text-right" />
          </label>
          <label class="flex items-center justify-between gap-3 text-xs">
            <span>{{ chapterWordUnit }}目标字数</span>
            <input
              v-model.number="config.wordsPerChapter"
              type="number"
              min="500"
              step="100"
              :list="`goal-words-per-chapter-${workId}`"
              :disabled="running"
              placeholder="写作计划"
              class="input input-bordered input-xs w-28 rounded-lg text-right"
            />
          </label>
          <datalist :id="`goal-words-per-chapter-${workId}`">
            <option v-for="n in WORDS_PER_CHAPTER_PRESETS" :key="n" :value="n">{{ n }} 字</option>
          </datalist>
          <label class="flex items-center justify-between gap-3 text-xs">
            <span>字数门禁容差</span>
            <div class="flex items-center gap-1.5">
              <span class="text-base-content/40">±</span>
              <input v-model.number="wordCountTolerancePct" type="number" min="5"
                :max="BODY_WORD_COUNT_TOLERANCE_MAX * 100" step="5"
                :disabled="running" class="input input-bordered input-xs w-16 rounded-lg text-right" />
              <span class="text-base-content/40">%</span>
            </div>
          </label>
          <p class="text-[11px] text-base-content/40 leading-relaxed">
            默认 ±25%，最高 ±100%。{{ chapterWordRangeHint || '填写目标字数后显示门禁区间。' }}
            同类问题只在局部预算内修复；不收敛时冻结正文、候选与检查点并暂停，避免无效空转。
          </p>
          <label v-if="workType === 'story'" class="flex items-center justify-between gap-3 text-xs">
            <span>试读比例</span>
            <div class="flex items-center gap-1.5">
              <input v-model.number="previewRatioPct" type="number" min="1" max="95"
                :disabled="running" class="input input-bordered input-xs w-20 rounded-lg text-right" />
              <span class="text-base-content/40">%</span>
            </div>
          </label>
        </div>

        <div v-if="workType === 'novel'" class="rounded-xl bg-base-100 border border-base-300/70 p-4 space-y-3">
          <p class="text-xs font-bold text-base-content/70">情绪策略</p>
          <label class="flex items-center justify-between gap-3 text-xs cursor-pointer">
            <span>启用情绪合同校验</span>
            <input v-model="config.checkEmotionContract" type="checkbox" :disabled="running"
              class="checkbox checkbox-xs checkbox-primary" />
          </label>
          <p class="text-[11px] text-base-content/40 leading-relaxed">
            关闭后，已有情绪设计只作为参考，不再作为章节规划、正文生成或提交的硬约束。
          </p>
          <label class="flex items-center justify-between gap-3 text-xs cursor-pointer">
            <span>启用情绪门禁校验</span>
            <input v-model="config.checkEmotionGate" type="checkbox" :disabled="running"
              class="checkbox checkbox-xs checkbox-primary" />
          </label>
          <p class="text-[11px] text-base-content/40 leading-relaxed">
            关闭后不执行情绪评分、不产生情绪编辑债务，也不会因情绪结果阻止进入下一章。
          </p>
        </div>

        <div class="rounded-xl bg-base-100 border border-base-300/70 p-4 space-y-3">
          <p class="text-xs font-bold text-base-content/70">质量验收</p>
          <label class="flex items-center justify-between gap-3 text-xs cursor-pointer">
            <span>正文生成后 AI 诊断</span>
            <input v-model="config.diagnoseBodyAfterGeneration" type="checkbox" :disabled="running"
              class="checkbox checkbox-xs checkbox-primary" />
          </label>
          <p class="text-[11px] text-base-content/40 leading-relaxed">
            开启后每{{ workType === 'novel' ? '章' : '拍' }}正文生成完会立即诊断并尝试修复；关闭则跳过，直接进入下一{{ workType === 'novel' ? '章' : '拍' }}生成。
          </p>
          <p v-if="workType === 'story'" class="text-[11px] text-base-content/40 leading-relaxed">
            书名与导语会经过交换位置盲评；可选择自动采用优胜方案，或暂停后由作者确认。
          </p>
          <label v-if="workType === 'story'" class="flex items-center justify-between gap-3 text-xs cursor-pointer">
            <span>书名导语由作者确认</span>
            <input v-model="config.humanReviewTitleHook" type="checkbox" :disabled="running"
              class="checkbox checkbox-xs checkbox-primary" />
          </label>
          <label class="flex items-center justify-between gap-3 text-xs">
            <span>总质量分下限</span>
            <div class="flex items-center gap-1.5">
              <input v-model.number="config.qualityMin" type="number" min="0" max="100"
                :disabled="running" class="input input-bordered input-xs w-20 rounded-lg text-right" />
              <span class="text-base-content/40">/100</span>
            </div>
          </label>
          <div v-if="workType === 'novel'" class="rounded-xl border border-base-300/70 bg-base-200/35 p-3 space-y-2">
            <div class="flex items-center justify-between gap-3">
              <span class="text-xs font-medium">单项质量分下限</span>
              <button type="button" class="btn btn-ghost btn-xs" :disabled="running"
                @click="QUALITY_AI_METRIC_DEFS.forEach(metric => config.qualityMetricMins[metric.key] = config.qualityMin)">
                同步为总分线
              </button>
            </div>
            <p class="text-[11px] text-base-content/40 leading-relaxed">
              每项独立判定；例如可单独降低“字数达标”，不会放宽其他质量指标。
            </p>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
              <label v-for="metric in QUALITY_AI_METRIC_DEFS" :key="metric.key"
                class="flex items-center justify-between gap-2 text-[11px]">
                <span>{{ metric.label }}</span>
                <input v-model.number="config.qualityMetricMins[metric.key]" type="number" min="0" max="100"
                  :disabled="running" class="input input-bordered input-xs w-16 rounded-lg text-right" />
              </label>
            </div>
          </div>
          <label class="flex items-center justify-between gap-3 text-xs">
            <span>目标匹配度</span>
            <div class="flex items-center gap-1.5">
              <input v-model.number="config.goalMatchMin" type="number" min="0" max="100"
                :disabled="running" class="input input-bordered input-xs w-20 rounded-lg text-right" />
              <span class="text-base-content/40">/100</span>
            </div>
          </label>
          <label v-if="workType === 'story'" class="flex items-center justify-between gap-3 text-xs">
            <span>整篇结构与兑现</span>
            <div class="flex items-center gap-1.5">
              <input v-model.number="config.overallStoryMin" type="number" min="0" max="100"
                :disabled="running" class="input input-bordered input-xs w-20 rounded-lg text-right" />
              <span class="text-base-content/40">/100</span>
            </div>
          </label>
          <label v-if="workType === 'story'" class="flex items-center justify-between gap-3 text-xs">
            <span>试读追读力</span>
            <div class="flex items-center gap-1.5">
              <input v-model.number="config.previewHookMin" type="number" min="0" max="100"
                :disabled="running" class="input input-bordered input-xs w-20 rounded-lg text-right" />
              <span class="text-base-content/40">/100</span>
            </div>
          </label>
          <label v-if="workType === 'story'" class="flex items-center justify-between gap-3 text-xs">
            <span>原文匿名盲读</span>
            <div class="flex items-center gap-1.5">
              <input v-model.number="config.proseReadMin" type="number" min="0" max="100"
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
          <label class="flex items-center justify-between gap-3 text-xs cursor-pointer">
            <span>{{ workType === 'story' ? 'anti-AI 规则密度门禁' : 'anti-AI 规则零违规' }}</span>
            <input v-model="config.checkAntiAiRules" type="checkbox" :disabled="running"
              class="checkbox checkbox-xs checkbox-primary" />
          </label>
        </div>

        <div class="rounded-xl bg-base-100 border border-base-300/70 p-4 space-y-3">
          <p class="text-xs font-bold text-base-content/70">运行控制</p>
          <label class="flex items-center justify-between gap-3 text-xs">
            <span>每周期轮次</span>
            <input v-model.number="config.maxTurns" type="number" min="1" step="1"
              :disabled="running" class="input input-bordered input-xs w-20 rounded-lg text-right" />
          </label>
          <label v-if="workType === 'novel'" class="flex items-center justify-between gap-3 text-xs">
            <span>自治周期上限</span>
            <input v-model.number="config.autonomousMaxEpochs" type="number" min="1" step="1"
              :disabled="running" class="input input-bordered input-xs w-20 rounded-lg text-right" />
          </label>
          <p class="text-[11px] text-base-content/40 leading-relaxed">
            {{ workType === 'novel'
              ? '每周期达到轮次预算后会自动保存检查点并开启下一周期，无需人工续跑；只有总自治周期用尽才进入明确终态。'
              : '达到预算后保留正文、候选、检查点和权威状态并暂停。' }}
          </p>
          <p class="text-[11px] text-base-content/40 leading-relaxed">轮次包含{{ workType === 'novel' ? '核心设定、卡片、整体自检、分卷大纲、章节大纲、因果决策、书名导语、正文生成、验收和修复' : '核心设定、卡片、故事发动机、节拍、书名导语、自检、正文、验收和修复' }}阶段。</p>
        </div>
      </div>

      <div v-if="showResumePhasePicker" class="rounded-xl bg-base-100 border border-base-300/70 p-4 space-y-2">
        <label class="text-xs font-bold text-base-content/70">新一轮起始步骤（仅用于紫色按钮）</label>
        <select
          v-model="resumeFromPhase"
          :disabled="running"
          class="select select-bordered select-sm w-full rounded-lg"
          @change="phasePickerTouched = true"
        >
          <option v-for="phase in availablePhases" :key="phase" :value="phase">
            {{ phaseMap[phase] }}
          </option>
        </select>
        <p class="text-[11px] text-base-content/40 leading-relaxed">
          紫色“启动新一轮”会从所选步骤创建新运行并将轮次归零；黄色“断点续跑”不读取这里的选择，只恢复界面当前显示的运行编号和保存步骤。
        </p>
        <p v-if="workType === 'novel'" class="text-[11px] text-warning/80 leading-relaxed">
          长篇会按“本卷大纲 → 本卷正文 → 冻结”滚动运行；章节门禁和整书终审失败会自动按“单章 → 章节簇 → 卷级依赖闭包”升级修复，无需人工参与。
        </p>
      </div>

      <div
        v-if="workType === 'novel' && chapterAcceptance && ['blocked', 'awaiting_resume'].includes(chapterAcceptance.status)"
        class="rounded-xl border p-4 space-y-3"
        :class="chapterAcceptance.status === 'awaiting_resume'
          ? 'border-success/50 bg-success/5'
          : 'border-warning/50 bg-warning/5'"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span
            class="badge badge-sm"
            :class="chapterAcceptance.status === 'awaiting_resume' ? 'badge-success' : 'badge-warning'"
          >
            {{ chapterAcceptance.status === 'awaiting_resume'
              ? '历史质量决策已保留'
              : chapterAcceptance.blockedGate === 'emotion'
                ? '情绪门禁未通过'
                : chapterAcceptance.blockedGate === 'execution_contract'
                  ? '章节合同未通过'
                  : '质量修订未收敛' }}
          </span>
          <span class="font-semibold text-sm">{{ chapterAcceptance.chapterTitle }}</span>
          <span class="text-xs text-base-content/50">
            评估 {{ chapterAcceptance.assessmentsUsed }}/{{ chapterAcceptance.maxAssessments }}
            · 修订 {{ chapterAcceptance.repairsUsed }}/{{ chapterAcceptance.maxRepairs }}
            · 最佳分 {{ chapterAcceptance.bestScore ?? '-' }}
          </span>
        </div>
        <p v-if="chapterAcceptance.authorNote" class="text-xs text-base-content/70">
          确认依据：{{ chapterAcceptance.authorNote }}
        </p>
        <p v-if="chapterAcceptance.terminalReason" class="text-xs text-base-content/70">
          {{ chapterAcceptance.terminalReason || '有限预算内未形成可验收候选' }}
        </p>
        <div class="grid gap-2 sm:grid-cols-3">
          <div
            v-for="gate in chapterAcceptance.gates"
            :key="gate.gateType"
            class="rounded-lg border border-base-300/60 bg-base-100 p-2 text-xs"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="font-semibold">{{ chapterGateLabel(gate.gateType) }}</span>
              <span
                class="badge badge-xs"
                :class="gate.status === 'passed_model' || gate.status === 'passed_author'
                  ? 'badge-success'
                  : gate.status === 'failed' ? 'badge-error' : 'badge-ghost'"
              >
                {{ chapterGateStatusLabel(gate.status) }}
              </span>
            </div>
            <p v-if="gate.score != null" class="mt-1 text-base-content/50">评分 {{ gate.score }}</p>
            <p v-if="gate.failureReason" class="mt-1 text-error/80">{{ gate.failureReason }}</p>
          </div>
        </div>
        <div
          v-if="chapterAcceptance.status === 'blocked' && chapterAcceptance.blockingFailures.length"
          class="text-xs text-error"
        >
          未解决：{{ chapterAcceptance.blockingFailures.join('；') }}
        </div>
        <div
          v-if="chapterAcceptance.blockedGate === 'quality' && chapterAcceptance.evidence.length"
          class="space-y-1.5"
        >
          <div
            v-for="(item, index) in chapterAcceptance.evidence.slice(0, 6)"
            :key="`${item.id}-${index}`"
            class="rounded-lg bg-base-100 border border-base-300/60 p-2 text-xs"
          >
            <p v-if="item.evidence" class="text-base-content/70">原文证据：{{ item.evidence }}</p>
            <p v-if="item.fixHint" class="text-base-content/50 mt-0.5">修订目标：{{ item.fixHint }}</p>
          </div>
        </div>
        <p
          class="text-[11px]"
          :class="chapterAcceptance.status === 'awaiting_resume' || chapterAcceptance.contentChanged ? 'text-success' : 'text-warning'"
        >
          {{ chapterAcceptance.status === 'awaiting_resume'
            ? '历史质量决策已不可变保留；新自治循环将从后续门禁继续。'
            : chapterAcceptance.contentChanged
              ? '检测到正文已修改，可以创建新的验收事件。'
              : chapterAcceptance.blockedGate === 'quality'
                ? '本次运行已保留证据并终止；新自治运行会从证据约束的依赖闭包修复继续。'
                : '质量决策仍然有效；自治循环会从当前后置门禁继续，不会退回质量起点。' }}
        </p>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn btn-outline btn-xs" @click="openAcceptanceChapter">
            编辑当前章节
          </button>
          <button type="button" class="btn btn-ghost btn-xs" @click="copyChapterAcceptanceEvidence">
            复制章节证据
          </button>
        </div>
      </div>

      <div class="flex flex-wrap gap-2 pt-2 border-t border-base-300/60">
        <button
          v-if="workType === 'novel' && !running && state"
          class="btn btn-secondary btn-sm gap-2"
          title="保留现有设定、大纲和正文，从目标验收开始补抽取、诊断并按证据修复"
          @click="recheckExistingNovel"
        >
          <font-awesome-icon icon="stethoscope" class="w-3.5 h-3.5" />
          重新验收已有正文
        </button>
        <button
          v-if="!running"
          class="btn btn-primary btn-sm gap-2"
          @click="start"
        >
          <font-awesome-icon icon="play" class="w-3.5 h-3.5" />
          {{ startLabel }}
        </button>
        <button v-if="!running && canResume" class="btn btn-warning btn-sm gap-2" @click="resume">
          <font-awesome-icon icon="forward" class="w-3.5 h-3.5" />
          {{ resumeLabel }}
        </button>
        <button v-if="running" class="btn btn-error btn-sm gap-2" @click="cancel">
          <font-awesome-icon icon="stop" class="w-3.5 h-3.5" />
          取消
        </button>
        <button v-if="!running" class="btn btn-ghost btn-sm gap-2 ml-auto" @click="copyEvaluationData">
          <font-awesome-icon icon="clipboard-check" class="w-3.5 h-3.5" />
          复制评测记录
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
            <span class="text-base-content/50">{{ workType === 'novel' ? '章节' : '节拍' }}完成</span>
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
              <span class="badge badge-xs" :class="subjectiveBadgeClass(dimStatus.quality, lastCheck.qualityHardFail)">{{ subjectiveBadgeLabel(dimStatus.quality, lastCheck.qualityHardFail) }}</span>
            </div>
          </div>
          <div class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">目标匹配</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.goalMatchScore }}</span>
              <span class="badge badge-xs" :class="subjectiveBadgeClass(dimStatus.goal)">{{ subjectiveBadgeLabel(dimStatus.goal) }}</span>
            </div>
          </div>
          <div class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">读者情绪盲读</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.emotionScore >= 0 ? lastCheck.emotionScore : '-' }}</span>
              <span class="badge badge-xs" :class="subjectiveBadgeClass(dimStatus.emotion, lastCheck.reasons.some(reason => reason.includes('情绪门禁未通过')))">{{ subjectiveBadgeLabel(dimStatus.emotion, lastCheck.reasons.some(reason => reason.includes('情绪门禁未通过'))) }}</span>
            </div>
          </div>
          <div v-if="workType === 'story'" class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">整篇结构与兑现</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.overallStoryScore }}</span>
              <span class="badge badge-xs" :class="subjectiveBadgeClass(dimStatus.overall)">{{ subjectiveBadgeLabel(dimStatus.overall) }}</span>
            </div>
          </div>
          <div v-if="workType === 'story'" class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">试读追读力</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.previewHookScore }}</span>
              <span class="badge badge-xs" :class="subjectiveBadgeClass(dimStatus.preview)">{{ subjectiveBadgeLabel(dimStatus.preview) }}</span>
            </div>
          </div>
          <div v-if="workType === 'story'" class="rounded-xl bg-base-100 px-3 py-2 border border-base-300/60 space-y-1">
            <span class="text-base-content/50">原文匿名盲读</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.proseReadScore }}</span>
              <span class="badge badge-xs" :class="subjectiveBadgeClass(dimStatus.prose)">{{ subjectiveBadgeLabel(dimStatus.prose) }}</span>
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
            <span class="text-base-content/50">anti-AI 规则</span>
            <div class="flex items-center justify-between gap-2">
              <span class="font-mono">{{ lastCheck.antiAiViolations }} 违规</span>
              <span class="badge badge-xs" :class="dimStatus.antiAi ? 'badge-success' : 'badge-error'">{{ dimStatus.antiAi ? '达标' : '未达' }}</span>
            </div>
          </div>
        </div>
        <div v-if="lastCheck && !lastCheck.met" class="text-xs text-warning">
          发布阻塞：{{ lastCheck.reasons.join('；') }}
        </div>
        <div v-if="lastCheck?.advisories?.length" class="text-xs text-info">
          编辑建议（不阻断发布）：{{ lastCheck.advisories.join('；') }}
        </div>
        <div v-if="workType === 'story' && harnessIssues.some(issue => issue.status !== 'resolved')" class="rounded-xl border border-warning/40 bg-warning/5 p-3 space-y-2 text-xs">
          <p class="font-bold text-warning">Harness 问题账本</p>
          <div v-for="issue in harnessIssues.filter(item => item.status !== 'resolved').slice(0, 8)" :key="issue.id" class="space-y-0.5">
            <p><span class="font-mono">{{ issue.code }}</span> · {{ issue.status === 'stalled' ? '需人工编辑' : `已尝试 ${issue.attempts} 次` }}</p>
            <p class="text-base-content/60">{{ issue.message }}</p>
            <p v-if="issue.expected_result" class="text-base-content/45">验收结果：{{ issue.expected_result }}</p>
          </div>
        </div>
        <p v-if="lastMessage" class="text-xs text-base-content/50 pt-1">{{ lastMessage }}</p>
      </div>
      <p v-else class="text-xs text-base-content/40">尚未运行</p>
    </div>

    <!-- 试读卡点报告（仅短故事） -->
    <div v-if="workType === 'story' && lastCheck?.previewReport" class="card bg-base-200 border border-base-300 shadow-sm p-5">
      <div class="flex items-center gap-2 mb-3">
        <font-awesome-icon icon="bookmark" class="w-4 h-4 text-primary shrink-0" />
        <h4 class="font-semibold text-sm">试读卡点报告</h4>
        <span class="badge badge-xs badge-primary ml-auto">目标 {{ previewRatioPct }}%</span>
      </div>
      <pre class="text-xs text-base-content/70 whitespace-pre-wrap font-mono leading-relaxed max-h-80 overflow-y-auto bg-base-100 rounded-lg p-3 border border-base-300/60">{{ lastCheck.previewReport }}</pre>
    </div>

    <div v-if="workflowSteps.length > 0" class="card bg-base-200 border border-base-300 shadow-sm p-5">
      <div class="flex items-center justify-between gap-3 mb-3">
        <h4 class="font-semibold text-sm">持久化执行步骤</h4>
        <span class="text-[11px] text-base-content/40">进程退出后从这里精确恢复</span>
      </div>
      <div class="space-y-1.5 max-h-56 overflow-y-auto">
        <div v-for="step in workflowSteps" :key="step.id"
          class="flex items-start gap-2 text-xs py-1.5 border-b border-base-300/40 last:border-0">
          <span class="badge badge-xs shrink-0"
            :class="step.status === 'completed' ? 'badge-success' : step.status === 'running' ? 'badge-primary' : step.status === 'waiting' ? 'badge-info' : step.status === 'needs_repair' ? 'badge-warning' : 'badge-error'">
            {{ step.status === 'needs_repair' ? '待修复' : step.status }}
          </span>
          <span class="font-mono text-base-content/50 shrink-0">{{ workflowStepLabel(step) }} · #{{ step.attempt_no }}</span>
          <span class="text-base-content/50 shrink-0">{{ step.scope_key }}</span>
          <span v-if="step.model_type" class="text-base-content/50 shrink-0">
            {{ step.generation_step || '模型调用' }} · {{ step.model_type }}/{{ step.model_name || '默认模型' }}
          </span>
          <span v-if="step.error_code" class="text-error flex-1">
            {{ workflowStepErrorLabel(step) }}：{{ step.error_message }}
            <span v-if="workflowStepAction(step)" class="block text-base-content/60 mt-0.5">
              {{ workflowStepAction(step) }}
            </span>
          </span>
        </div>
      </div>
    </div>

    <!-- 轮次历史 -->
    <div class="card bg-base-200 border border-base-300 shadow-sm p-5">
      <div class="flex items-center justify-between gap-3 mb-3">
        <h4 class="font-semibold text-sm">轮次历史</h4>
        <span class="text-[11px] text-base-content/40">按发生时间倒序</span>
      </div>
      <div v-if="visibleTurns.length === 0" class="text-xs text-base-content/40 py-4 text-center">无记录</div>
      <div v-else class="space-y-1.5 max-h-72 overflow-y-auto">
        <div v-for="t in visibleTurns" :key="t.id"
          class="flex items-start gap-2 text-xs py-1.5 border-b border-base-300/40 last:border-0">
          <span class="badge badge-xs badge-ghost shrink-0">#{{ t.turn_no }}</span>
          <span class="text-base-content/40 shrink-0 tabular-nums">{{ formatDbUtcAsLocal(t.create_time) }}</span>
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
      <span>每次写正文自动存版本快照；进入「{{ workType === 'novel' ? '章节大纲' : '节拍大纲' }}」步骤可逐{{ workType === 'novel' ? '章' : '拍' }}查看版本历史并回滚。</span>
    </div>
  </div>
</template>
