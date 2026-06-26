<script setup lang="ts">
import { ref, onMounted, onActivated, onUnmounted, watch, computed, inject, nextTick } from 'vue'
import { useStyleChangeSync } from '../../composables/useStyleChangeSync'
import { useBodyGenerationModel } from '../../composables/useBodyGenerationModel'
import { useToast } from '../../composables/useToast'
import { useModelChat } from './useModelChat'
import PanelTitle from '../../components/PanelTitle.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import FavoriteButton from '../../components/FavoriteButton.vue'
import StepNavFooter from './StepNavFooter.vue'
import AiInterventionBar from './AiInterventionBar.vue'
import ChapterCritiqueReport from './ChapterCritiqueReport.vue'
import ChapterQualityReport from './ChapterQualityReport.vue'
import ChapterVersionHistory from './ChapterVersionHistory.vue'
import AntiMeanPanel from './AntiMeanPanel.vue'
import ModelDebatePanel from './ModelDebatePanel.vue'
import AiTraceReport from './AiTraceReport.vue'
import AntiAiRulesPanel from './AntiAiRulesPanel.vue'
import { editorNavKey } from './editor-nav'
import { toPlainForIpc } from '../../../../shared/ipc-plain'
import { normalizeBodyParagraphSpacing } from '../../../../shared/normalize-body-text'
import { formatBodyWordTargetLine, countWords } from '../../../../shared/body-word-target'
import { BODY_GENERATION_SYSTEM, STORY_BODY_GENERATION_SYSTEM, extractEmotionIntensity } from '../../../../shared/body-generation-prompt'
import { WORDS_PER_CHAPTER_PRESETS } from '../../../../shared/writing-plan-presets'
import { DEFAULT_AUTO_OPTIMIZE_CONFIG } from '../../../../shared/auto-optimize-config'
import type { AutoOptimizeConfig } from '../../../../shared/auto-optimize-config'
import {
  beginBodyGeneration,
  endBodyGeneration,
  cacheBodyContent,
  setCachedBodyContent,
  getCachedBodyContent,
  clearCachedBodyContent,
  onBodyContentDelivered
} from '../../services/body-generation-state'
import {
  getPanelPage,
  setPanelPage,
  getPanelSelection,
  setPanelSelection
} from '../../services/editorPanelPageState'

const props = defineProps<{ workId: number }>()
const nav = inject(editorNavKey)
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)

interface Chapter {
  id: number
  volume_id: number
  title: string
  outline: string | null
  content: string | null
  word_count: number
  status: string
}

const volumes = ref<{ id: number; name: string; description?: string | null }[]>([])
const chapters = ref<Chapter[]>([])
const selectedVolume = ref<number | null>(null)
const selectedChapterId = ref<number | null>(null)
const workType = ref<string | null>(null)
const wordTarget = ref(4000)
const wordOptions = WORDS_PER_CHAPTER_PRESETS

const currentPage = ref(1)
const pageSize = 10

function saveCurrentPage() {
  setPanelPage('generate', props.workId, selectedVolume.value, currentPage.value)
}

watch(currentPage, saveCurrentPage)

const paginatedChapters = computed(() => {
  const start = (currentPage.value - 1) * pageSize
  return chapters.value.slice(start, start + pageSize)
})

const totalPages = computed(() => Math.ceil(chapters.value.length / pageSize))

watch(totalPages, (newVal) => {
  if (currentPage.value > newVal) {
    currentPage.value = Math.max(1, newVal)
  }
})

function estimateWordRange(outline: string | null | undefined, target: number): { min: number; max: number; recommended: number } {
  if (!outline?.trim()) return { min: Math.round(target * 0.7), max: target, recommended: target }
  const text = outline.trim()
  const charLen = text.length
  const bulletPoints = (text.match(/^[\s]*[-*•\d.]+/gm) || []).length
  const density = Math.max(bulletPoints, Math.ceil(charLen / 80))

  let recommended: number
  if (density <= 2) recommended = Math.min(target, 2500)
  else if (density <= 4) recommended = Math.min(target, 3500)
  else if (density <= 6) recommended = Math.min(target, 4500)
  else recommended = target

  recommended = Math.min(recommended, target)
  const min = Math.round(recommended * 0.7)
  const max = Math.round(recommended * 1.15)
  return { min, max: Math.min(max, target), recommended }
}

const wordRange = computed(() => {
  const ch = selectedChapter.value
  return estimateWordRange(ch?.outline, wordTarget.value)
})

const coreSettings = ref<{ type: string; content: string }[]>([])
const anchors = ref<{ type: string; title: string; content: string }[]>([])
const workContextText = ref('')
const narrativeMemoryText = ref('')
const memoryStats = ref({
  pendingForeshadowingCount: 0,
  snapshotCharacterCount: 0,
  timelineEventCount: 0,
  hasPreviousChapter: false,
  previousChapterTitle: null as string | null,
  previousChapterCharCount: 0,
  characterCardsText: '',
  anchorLimitWarning: null as string | null
})
const activeAnchorCount = ref(0)
const maxActiveAnchors = ref(12)
const boundStyleName = ref<string | null>(null)

interface CritiqueResult {
  dimensions: { key: string; label: string; score: number; passed: boolean; issues: string[] }[]
  overallScore: number
  needsReview: boolean
  summary: string
}

interface CrossChapterIssue {
  severity: 'error' | 'warning' | 'info'
  chapterId?: number
  chapterTitle?: string
  message: string
}

interface ConsistencyGateResult {
  passed: boolean
  blockers: string[]
  warnings: string[]
}

interface BudgetPreview {
  maxContextTokens: number
  usedTokens: number
  usageRatio: number
  pressure: 'safe' | 'warning' | 'critical' | 'blocking'
  warnings: string[]
  continuityMode: 'full' | 'tail' | 'none'
  sections?: { key: string; label: string; included: boolean; tokens: number }[]
}

interface AntiAiViolation {
  rule: string
  detail: string
  count?: number
}

interface QualityResult {
  items: { key: string; label: string; severity: 'fatal' | 'warning' | 'info'; passed: boolean; detail: string }[]
  fatalCount: number
  warningCount: number
  passed: boolean
  summary: string
  writerBlockHint?: string
}

interface QualityAiMetrics {
  scoreTotal: number
  hardFail: boolean
  cappedByGate: boolean
  breakdown?: import('../../../../shared/quality-ai-score').QualityAiScoreBreakdown | null
}

const critiqueResult = ref<CritiqueResult | null>(null)
const qualityResult = ref<QualityResult | null>(null)
const qualityAiReport = ref('')
const qualityAiMetrics = ref<QualityAiMetrics | null>(null)
const worldviewViolations = ref<{ rule: string; detail: string }[]>([])
const runningV15Checks = ref(false)
const runningCritique = ref(false)
const savingChapter = ref(false)
const extractingMemory = ref(false)
const copyHint = ref('')
const humanizeHint = ref('')
const humanizeMsg = ref('')
const humanizeMsgTone = ref<'success' | 'warning' | 'error'>('success')
let humanizeHintTimer: ReturnType<typeof setTimeout> | null = null
let humanizeMsgTimer: ReturnType<typeof setTimeout> | null = null
const memoryExtractMsg = ref('')
const fingerprintMsg = ref('')
const blockHints = ref<Record<string, { label: string; hint: string }>>({})
const budgetPreview = ref<BudgetPreview | null>(null)
const crossChapterIssues = ref<CrossChapterIssue[]>([])
const scanningCrossChapter = ref(false)
const crossChapterScanHint = ref('')
const crossChapterScanMsg = ref('')
const crossChapterScanTone = ref<'success' | 'warning' | 'error' | 'info'>('info')
const crossChapterReportRef = ref<HTMLElement | null>(null)
let crossChapterScanHintTimer: ReturnType<typeof setTimeout> | null = null
let crossChapterScanMsgTimer: ReturnType<typeof setTimeout> | null = null
const gateResult = ref<ConsistencyGateResult | null>(null)
const antiAiRulesPanelRef = ref<{ reload: () => Promise<void>; appendRules: (rules: string[]) => Promise<void> } | null>(null)
const antiAiViolations = ref<AntiAiViolation[]>([])
const autoHumanize = ref(true)
const autoRewrite = ref(false)
const humanizing = ref(false)
const styleRewriting = ref(false)
const autoOptimizeConfig = ref<AutoOptimizeConfig>({ ...DEFAULT_AUTO_OPTIMIZE_CONFIG })
const autoOptimizeUnlimited = computed({
  get: () => autoOptimizeConfig.value.maxIterations <= 0,
  set: (v: boolean) => {
    autoOptimizeConfig.value.maxIterations = v ? 0 : (autoOptimizeConfig.value.maxIterations > 0 ? autoOptimizeConfig.value.maxIterations : 3)
  }
})
const autoOptimizing = ref(false)
const autoOptimizeMsg = ref('')
const autoOptimizeModalOpen = ref(false)
const humanizeStats = ref<{ wordSubstitutionHits: number; uniformSentenceRuns: number; avgTokenPredictability: string } | null>(null)
const versionHistoryRef = ref<InstanceType<typeof ChapterVersionHistory> | null>(null)
const workReferenceText = ref('')
const workRefSaving = ref(false)

const { loading, result, error, contextBudget, chat } = useModelChat(() => props.workId)
const { showToast } = useToast()
const lastPrompt = ref('')

const selectedChapter = computed(() =>
  chapters.value.find(c => c.id === selectedChapterId.value) ?? null
)

const contentWordCount = computed(() => countWords(result.value))
const isWordCountShort = computed(() => {
  if (!result.value || !wordTarget.value) return false
  const deviation = ((contentWordCount.value - wordTarget.value) / wordTarget.value) * 100
  return deviation < -10
})
const isWordCountLong = computed(() => {
  if (!result.value || !wordTarget.value) return false
  const deviation = ((contentWordCount.value - wordTarget.value) / wordTarget.value) * 100
  return deviation > 10
})
const previewMode = ref(false)
const antiAiRulesInjected = computed(() =>
  budgetPreview.value?.sections?.some(s => s.key === 'anti_ai_rules' && s.included) ?? false
)
const hasEmDashViolation = computed(() =>
  antiAiViolations.value.some(v => /破折号/.test(v.rule) || /破折号/.test(v.detail))
)
const hasEmDashInResult = computed(() =>
  /——|—/.test(result.value)
)

function selectChapter(ch: Chapter) {
  selectedChapterId.value = ch.id
  const idx = chapters.value.findIndex(c => c.id === ch.id)
  if (idx !== -1) {
    currentPage.value = Math.floor(idx / pageSize) + 1
  }
  if (selectedVolume.value) {
    setPanelSelection('generate', props.workId, selectedVolume.value, ch.id)
  }
}

function pickSelectedChapterId(fallbackId: number | null): number | null {
  if (!selectedVolume.value || chapters.value.length === 0) return null
  const persisted = getPanelSelection('generate', props.workId, selectedVolume.value)
  if (persisted != null && chapters.value.some(c => c.id === persisted)) return persisted
  if (fallbackId != null && chapters.value.some(c => c.id === fallbackId)) return fallbackId
  return chapters.value[0].id
}

const bodySystemPrompt = computed(() => workType.value === 'story' ? STORY_BODY_GENERATION_SYSTEM : BODY_GENERATION_SYSTEM)

watch(wordTarget, async (value) => {
  if (selectedChapterId.value) await refreshBudgetPreview(selectedChapterId.value)
  await window.anovel.invoke('writingPlan:update', props.workId, { wordsPerChapter: value })
})

async function refreshBoundStyleName() {
  const styleId = await window.anovel.invoke('style:getWorkStyleId', props.workId) as number | null
  if (!styleId) {
    boundStyleName.value = null
    return
  }
  const style = await window.anovel.invoke('style:get', styleId) as { name: string } | null
  boundStyleName.value = style?.name ?? null
}

useStyleChangeSync(refreshBoundStyleName)

onMounted(async () => {
  const plan = await window.anovel.invoke('writingPlan:get', props.workId) as { wordsPerChapter: number }
  if (plan.wordsPerChapter) wordTarget.value = plan.wordsPerChapter

  const work = await window.anovel.invoke('work:get', props.workId) as { work_type?: string } | null
  workType.value = work?.work_type ?? null

  volumes.value = await window.anovel.invoke('volume:list', props.workId) as never[]
  if (volumes.value.length === 0 && workType.value === 'story') {
    try {
      const volId = await window.anovel.invoke('volume:create', props.workId, '正文', '短故事主线剧情') as number
      volumes.value = [{ id: volId, name: '正文', description: '短故事主线剧情' }] as never[]
    } catch (e) {
      console.error('Failed to create default volume for story on mount', e)
    }
  }

  coreSettings.value = await window.anovel.invoke('setting:listByWork', props.workId) as never[]
  anchors.value = await window.anovel.invoke('anchor:listActive', props.workId) as never[]
  const limit = await window.anovel.invoke('anchor:activeLimitStatus', props.workId) as {
    activeCount: number
    maxActive: number
    message: string | null
  }
  activeAnchorCount.value = limit.activeCount
  maxActiveAnchors.value = limit.maxActive
  const ctx = await window.anovel.invoke('context:buildWork', props.workId, { includeVolumes: true }) as { text: string }
  workContextText.value = ctx.text
  await refreshBoundStyleName()
  if (volumes.value.length) selectedVolume.value = volumes.value[0].id
  blockHints.value = await window.anovel.invoke('writerBlock:types') as typeof blockHints.value
  workReferenceText.value = await window.anovel.invoke('setting:getWorkReferenceText', props.workId) as string
  try {
    const saved = await window.anovel.invoke('quality:getAutoOptimizeConfig') as AutoOptimizeConfig
    autoOptimizeConfig.value = { ...DEFAULT_AUTO_OPTIMIZE_CONFIG, ...saved }
  } catch { /* ignore */ }
})

async function reloadChapters() {
  if (!selectedVolume.value) return
  const oldSelectedId = selectedChapterId.value
  chapters.value = await window.anovel.invoke('chapter:list', selectedVolume.value) as never[]
  if (chapters.value.length === 0 && workType.value === 'story') {
    try {
      await window.anovel.invoke('chapter:create', selectedVolume.value, '正文', '短故事正文内容')
      chapters.value = await window.anovel.invoke('chapter:list', selectedVolume.value) as never[]
    } catch (e) {
      console.error('Failed to create default chapter for story', e)
    }
  }
  selectedChapterId.value = pickSelectedChapterId(oldSelectedId)
}

watch(selectedVolume, async (v) => {
  selectedChapterId.value = null
  currentPage.value = v ? getPanelPage('generate', props.workId, v) : 1
  saveCurrentPage()
  if (v) {
    chapters.value = await window.anovel.invoke('chapter:list', v) as never[]
    if (chapters.value.length === 0 && workType.value === 'story') {
      try {
        await window.anovel.invoke('chapter:create', v, '正文', '短故事正文内容')
        chapters.value = await window.anovel.invoke('chapter:list', v) as never[]
      } catch (e) {
        console.error('Failed to create default chapter for story', e)
      }
    }
    selectedChapterId.value = pickSelectedChapterId(null)
  } else {
    chapters.value = []
  }
})

function syncResultFromCache(chapterId: number) {
  const ch = chapters.value.find(c => c.id === chapterId)
  const dbContent = ch?.content ?? ''
  const cached = getCachedBodyContent(chapterId)
  if (cached === undefined || cached === dbContent) return
  result.value = cached ? normalizeBodyParagraphSpacing(cached) : cached
}

onActivated(async () => {
  volumes.value = await window.anovel.invoke('volume:list', props.workId) as never[]
  await reloadChapters()
  currentPage.value = getPanelPage('generate', props.workId, selectedVolume.value)
  if (selectedChapterId.value != null) {
    syncResultFromCache(selectedChapterId.value)
  }
})

// 存储最近一次 AI 生成的情绪强度（由 saveToChapter 消费后清除）
const pendingEmotionIntensity = ref<number | null>(null)

const unsubscribeBodyDelivery = onBodyContentDelivered((chapterId, content) => {
  if (selectedChapterId.value === chapterId) {
    const { cleanedContent, intensity } = extractEmotionIntensity(content)
    pendingEmotionIntensity.value = intensity
    result.value = cleanedContent
  }
})

onUnmounted(() => {
  unsubscribeBodyDelivery()
})

watch(result, (val) => {
  const chId = selectedChapterId.value
  if (chId != null) {
    setCachedBodyContent(chId, val)
  }
})

watch(selectedChapterId, async (id) => {
  if (id) {
    await loadNarrativeMemory(id)
    const ch = chapters.value.find(c => c.id === id)
    const dbContent = ch?.content ?? ''
    const cached = getCachedBodyContent(id)
    const raw = (cached !== undefined && cached !== dbContent) ? cached : dbContent
    result.value = raw ? normalizeBodyParagraphSpacing(raw) : raw
    critiqueResult.value = null
    qualityResult.value = null
    qualityAiReport.value = ''
    qualityAiMetrics.value = null
    worldviewViolations.value = []
    gateResult.value = null
    memoryExtractMsg.value = ''
    fingerprintMsg.value = ''
    antiAiViolations.value = []
  } else {
    result.value = ''
    narrativeMemoryText.value = ''
    memoryStats.value = {
      pendingForeshadowingCount: 0,
      snapshotCharacterCount: 0,
      timelineEventCount: 0,
      hasPreviousChapter: false,
      previousChapterTitle: null,
      previousChapterCharCount: 0,
      characterCardsText: '',
      anchorLimitWarning: null
    }
    budgetPreview.value = null
  }
})

async function loadNarrativeMemory(chapterId: number) {
  const mem = await window.anovel.invoke('narrative:buildMemory', props.workId, chapterId) as {
    text: string
    pendingForeshadowingCount: number
    snapshotCharacterCount: number
    timelineEventCount: number
    hasPreviousChapter: boolean
    previousChapterTitle: string | null
    previousChapterContent: string
    previousChapterCharCount: number
    characterCardsText: string
    anchorLimitWarning: string | null
  }
  narrativeMemoryText.value = mem.text
  const limit = await window.anovel.invoke('anchor:activeLimitStatus', props.workId) as {
    activeCount: number
    maxActive: number
    message: string | null
  }
  activeAnchorCount.value = limit.activeCount
  memoryStats.value = {
    pendingForeshadowingCount: mem.pendingForeshadowingCount,
    snapshotCharacterCount: mem.snapshotCharacterCount,
    timelineEventCount: mem.timelineEventCount,
    hasPreviousChapter: mem.hasPreviousChapter,
    previousChapterTitle: mem.previousChapterTitle,
    previousChapterCharCount: mem.previousChapterCharCount,
    characterCardsText: mem.characterCardsText,
    anchorLimitWarning: limit.message ?? mem.anchorLimitWarning
  }
  await refreshBudgetPreview(chapterId)
}

function buildWordTargetLine(): string {
  return formatBodyWordTargetLine(wordTarget.value)
}

async function refreshBudgetPreview(chapterId: number) {
  const ch = chapters.value.find(c => c.id === chapterId)
  if (!ch) {
    budgetPreview.value = null
    return
  }
  const vol = volumes.value.find(v => v.id === ch.volume_id)
  const prompt = [
    `分卷：${vol?.name || ''}`,
    vol?.description ? `分卷说明：${vol.description}` : '',
    `章节：${ch.title}`,
    buildWordTargetLine(),
    ch.outline ? `章节大纲（本章内容指引，非叙事起点；须先衔接上一章结尾再自然展开）：\n${ch.outline}` : '（暂无章节大纲，请尽量根据作品上下文创作）'
  ].filter(Boolean).join('\n\n')

  const report = await window.anovel.invoke('context:estimateBudget', {
    prompt,
    systemPrompt: bodySystemPrompt.value,
    workId: props.workId,
    step: 'body_generation',
    ...bodyModelParams(),
    workContextOptions: {
      includeVolumes: true,
      includeIncubator: false,
      excludeCoreTypes: ['worldview']
    },
    chapterId: ch.id,
    volumeId: ch.volume_id,
    enrichNarrativeMemory: true
  }) as BudgetPreview

  budgetPreview.value = report
}

function summarizeCrossChapterIssues(issues: CrossChapterIssue[]): {
  msg: string
  tone: 'success' | 'warning' | 'error' | 'info'
} {
  if (issues.length === 0) {
    return { msg: '跨章扫描完成，无返回结果', tone: 'warning' }
  }
  const sole = issues.length === 1 ? issues[0] : null
  if (sole?.message.includes('章节不足 2 章')) {
    return { msg: sole.message, tone: 'info' }
  }
  if (sole?.message.includes('未发现明显跨章逻辑问题')) {
    return { msg: '跨章扫描完成：未发现明显跨章逻辑问题', tone: 'success' }
  }
  const errors = issues.filter(i => i.severity === 'error').length
  const warnings = issues.filter(i => i.severity === 'warning').length
  const infos = issues.filter(i => i.severity === 'info').length
  const parts: string[] = []
  if (errors) parts.push(`${errors} 条错误`)
  if (warnings) parts.push(`${warnings} 条警告`)
  if (infos) parts.push(`${infos} 条提示`)
  const tone: 'success' | 'warning' | 'error' | 'info' =
    errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'info'
  return {
    msg: `跨章扫描完成：发现 ${parts.join('、')}（详情见下方列表）`,
    tone
  }
}

function showCrossChapterScanFeedback(
  hint: string,
  msg: string,
  tone: 'success' | 'warning' | 'error' | 'info'
) {
  crossChapterScanHint.value = hint
  crossChapterScanMsg.value = msg
  crossChapterScanTone.value = tone
  if (crossChapterScanHintTimer) clearTimeout(crossChapterScanHintTimer)
  crossChapterScanHintTimer = setTimeout(() => {
    crossChapterScanHint.value = ''
    crossChapterScanHintTimer = null
  }, 4000)
  if (crossChapterScanMsgTimer) clearTimeout(crossChapterScanMsgTimer)
  crossChapterScanMsgTimer = setTimeout(() => {
    crossChapterScanMsg.value = ''
    crossChapterScanMsgTimer = null
  }, 12000)
}

async function runCrossChapterScan() {
  if (scanningCrossChapter.value) return
  scanningCrossChapter.value = true
  crossChapterScanMsg.value = ''
  try {
    crossChapterIssues.value = await window.anovel.invoke(
      'narrative:crossChapterScan',
      props.workId
    ) as CrossChapterIssue[]
    const { msg, tone } = summarizeCrossChapterIssues(crossChapterIssues.value)
    const hint =
      tone === 'success' ? '无问题' : tone === 'error' ? '有问题' : tone === 'warning' ? '有警告' : '已扫描'
    showCrossChapterScanFeedback(hint, msg, tone)
    await nextTick()
    crossChapterReportRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  } catch (e) {
    const message = e instanceof Error ? e.message : '跨章扫描失败'
    showCrossChapterScanFeedback('失败', message, 'error')
  } finally {
    scanningCrossChapter.value = false
  }
}

function budgetPressureClass(pressure: BudgetPreview['pressure']): string {
  if (pressure === 'blocking') return 'text-error'
  if (pressure === 'critical') return 'text-error'
  if (pressure === 'warning') return 'text-warning'
  return 'text-success'
}

async function generateBody() {
  const ch = selectedChapter.value
  if (!ch) return

  const vol = volumes.value.find(v => v.id === ch.volume_id)
  const prompt = [
    `分卷：${vol?.name || ''}`,
    vol?.description ? `分卷说明：${vol.description}` : '',
    `章节：${ch.title}`,
    buildWordTargetLine(),
    ch.outline ? `章节大纲（本章内容指引，非叙事起点；须先衔接上一章结尾再自然展开）：\n${ch.outline}` : '（暂无章节大纲，请尽量根据作品上下文创作）'
  ].filter(Boolean).join('\n\n')

  lastPrompt.value = prompt
  critiqueResult.value = null
  qualityResult.value = null
  qualityAiReport.value = ''
  qualityAiMetrics.value = null
  worldviewViolations.value = []
  gateResult.value = null
  humanizeMsg.value = ''
  humanizeHint.value = ''

  await refreshBudgetPreview(ch.id)

  const chapterId = ch.id
  beginBodyGeneration(chapterId, props.workId)
  try {
    await chat(prompt, bodySystemPrompt.value, 'body_generation', {
      ...bodyModelParams(),
      workContextOptions: {
        includeVolumes: true,
        includeIncubator: false,
        excludeCoreTypes: ['worldview']
      },
      chapterId,
      volumeId: ch.volume_id,
      enrichNarrativeMemory: true
    })
    let content = result.value
    if (content && autoHumanize.value) {
      content = await applyHumanize(content)
      result.value = content
    }
    if (content && autoRewrite.value) {
      content = await applyAutoRewrite(content)
      result.value = content
    }
    if (content) {
      cacheBodyContent(chapterId, content)
      if (selectedChapterId.value === chapterId) {
        await runPostGenerateChecks(content)
      }
    }
  } finally {
    endBodyGeneration()
  }
}

function showHumanizeFeedback(
  hint: string,
  msg: string,
  tone: 'success' | 'warning' | 'error'
) {
  humanizeHint.value = hint
  humanizeMsg.value = msg
  humanizeMsgTone.value = tone
  if (humanizeHintTimer) clearTimeout(humanizeHintTimer)
  humanizeHintTimer = setTimeout(() => {
    humanizeHint.value = ''
    humanizeHintTimer = null
  }, 4000)
  if (humanizeMsgTimer) clearTimeout(humanizeMsgTimer)
  humanizeMsgTimer = setTimeout(() => {
    humanizeMsg.value = ''
    humanizeMsgTimer = null
  }, 10000)
}

async function applyHumanize(content: string): Promise<string> {
  humanizing.value = true
  const before = content
  try {
    const refText = workReferenceText.value.trim()
    const humanized = await window.anovel.invoke(
      'antiai:humanize',
      content,
      refText ? { referenceText: refText } : {}
    ) as string
    humanizeStats.value = await window.anovel.invoke('antiai:measureAiSignature', humanized) as typeof humanizeStats.value
    const stats = humanizeStats.value
    const statsLine = stats
      ? `剩余 AI 高频词 ${stats.wordSubstitutionHits} 处 · 均匀句群 ${stats.uniformSentenceRuns} 组 · 可预测性 ${stats.avgTokenPredictability}`
      : ''
    if (humanized === before) {
      showHumanizeFeedback(
        '无变化',
        `本地去AI已完成，正文未改动（无匹配词或未触发扰动）。${statsLine}`,
        'warning'
      )
    } else {
      showHumanizeFeedback(
        '已处理',
        `正文已更新。${statsLine}`,
        'success'
      )
    }
    return humanized
  } catch (e) {
    const message = e instanceof Error ? e.message : '去AI处理失败'
    showHumanizeFeedback('失败', message, 'error')
    return before
  } finally {
    humanizing.value = false
  }
}

/** 生成后自动去 AI 闭环：分段启发式打分 → 高 AI 段落生成式重写 → 本地择优 */
async function applyAutoRewrite(content: string): Promise<string> {
  if (!content.trim()) return content
  humanizing.value = true
  try {
    const res = await window.anovel.invoke('antiai:autoRewriteBody', content) as {
      content: string
      changed: boolean
      stats: { totalSegments: number; highAiSegments: number; rewrittenSegments: number; originalScore: number; finalScore: number }
    }
    if (res.changed) {
      showHumanizeFeedback(
        '深度去AI',
        `已重写 ${res.stats.rewrittenSegments}/${res.stats.highAiSegments} 个高 AI 段落，启发式分 ${res.stats.originalScore} → ${res.stats.finalScore}`,
        'success'
      )
      return res.content
    }
    return content
  } catch (e) {
    showHumanizeFeedback('失败', e instanceof Error ? e.message : '深度去AI失败', 'error')
    return content
  } finally {
    humanizing.value = false
  }
}

async function saveWorkReferenceText() {
  if (workRefSaving.value) return
  workRefSaving.value = true
  try {
    await window.anovel.invoke('setting:setWorkReferenceText', props.workId, workReferenceText.value)
  } catch (e) {
    console.error('保存作品参考范文失败:', e)
  } finally {
    workRefSaving.value = false
  }
}

function handleWorkRefFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    workReferenceText.value = (reader.result as string).slice(0, 5000)
  }
  reader.readAsText(file)
  input.value = ''
}

async function manualHumanize() {
  if (!result.value.trim() || humanizing.value) return
  const humanized = await applyHumanize(result.value)
  result.value = humanized
  await recheckAntiAiViolations(humanized)
}

async function styleRewrite() {
  if (!result.value.trim() || styleRewriting.value || !selectedChapterId.value) return
  styleRewriting.value = true
  try {
    const chId = selectedChapterId.value

    // ====== Step 1: AI 诊断 ======
    const [gate, diagRes] = await Promise.all([
      window.anovel.invoke('quality:diagnose', props.workId, chId, result.value),
      window.anovel.invoke('quality:diagnoseAI', props.workId, chId, result.value, { ...bodyModelParams(), wordTarget: wordTarget.value })
    ])
    qualityResult.value = gate as QualityResult
    const aiRes = diagRes as {
      success: boolean
      report?: string
      scoreTotal?: number
      hardFail?: boolean
      cappedByGate?: boolean
      scoreBreakdown?: QualityAiMetrics['breakdown']
      error?: string
    }
    if (!aiRes.success) {
      showToast('error', aiRes.error || 'AI 诊断失败')
      return
    }
    qualityAiReport.value = aiRes.report || ''
    if (typeof aiRes.scoreTotal === 'number' && typeof aiRes.hardFail === 'boolean') {
      qualityAiMetrics.value = {
        scoreTotal: aiRes.scoreTotal,
        hardFail: aiRes.hardFail,
        cappedByGate: !!aiRes.cappedByGate,
        breakdown: aiRes.scoreBreakdown ?? null
      }
    } else {
      qualityAiMetrics.value = null
    }

    // ====== Step 2: 按建议修改（Patch 优先） ======
    const patches = toPlainForIpc(qualityAiMetrics.value?.breakdown?.patches ?? [])
    if (patches.length > 0) {
      const patchRes = await window.anovel.invoke(
        'quality:applyLocalPatches',
        result.value,
        patches
      ) as {
        success: boolean
        patchedText?: string
        appliedCount?: number
        patches?: { find: string; replace: string }[]
        error?: string
      }
      if (patchRes.success && patchRes.patchedText) {
        result.value = patchRes.patchedText
        const count = patchRes.appliedCount ?? 0
        if (count > 0) {
          qualityAiReport.value = ''
          qualityAiMetrics.value = null
          showToast('success', `已修复 ${count} 处问题`)
          if (autoHumanize.value) {
            result.value = await applyHumanize(result.value)
          }
          await recheckAntiAiViolations(result.value)
          if (autoOptimizeConfig.value.enabled) {
            result.value = await runAutoOptimize(result.value)
          }
          return
        }
        showToast('info', 'AI 未找到可匹配原文的修改，已跳过')
        qualityAiMetrics.value = null
        if (autoOptimizeConfig.value.enabled) {
          result.value = await runAutoOptimize(result.value)
        }
        return
      }
      if (patchRes.error) {
        console.warn('[styleRewrite] 本地 Patch 失败，回退到全文重写模式：', patchRes.error)
      }
    } else if (workType.value === 'story') {
      if (autoOptimizeConfig.value.enabled) {
        result.value = await runAutoOptimize(result.value)
      }
      showToast('info', 'AI 未在诊断中生成可修复的 patches')
      return
    }

    // ====== 回退：全文重写模式 ======
    if (!qualityAiReport.value) {
      showToast('error', 'AI 诊断未返回报告，无法进行修改')
      return
    }
    const fixRes = await window.anovel.invoke('quality:applyFixes', props.workId, result.value, qualityAiReport.value, { ...bodyModelParams(), wordTarget: wordTarget.value }) as {
      success: boolean
      content?: string
      error?: string
    }
    if (fixRes.success && fixRes.content) {
      result.value = fixRes.content
      qualityAiReport.value = ''
      qualityAiMetrics.value = null
      if (autoHumanize.value) {
        result.value = await applyHumanize(result.value)
      }
      await recheckAntiAiViolations(result.value)
      if (autoOptimizeConfig.value.enabled) {
        result.value = await runAutoOptimize(result.value)
      }
    } else {
      showToast('error', fixRes.error || '稿件优化失败')
    }
  } catch (e) {
    showToast('error', e instanceof Error ? e.message : '稿件优化失败')
  } finally {
    styleRewriting.value = false
  }
}

async function runAutoOptimize(content: string): Promise<string> {
  const config = autoOptimizeConfig.value
  if (!config.enabled) return content
  if (autoOptimizing.value) return content

  let currentContent = content
  autoOptimizing.value = true
  autoOptimizeMsg.value = ''

  try {
    const unlimited = config.maxIterations <= 0
    const max = unlimited ? Infinity : config.maxIterations

    for (let i = 1; i <= max; i++) {
      const roundLabel = unlimited ? `第 ${i} 轮` : `第 ${i}/${config.maxIterations} 轮`
      autoOptimizeMsg.value = `自动优化中（${roundLabel}）…`

      const diagRes = await window.anovel.invoke(
        'quality:diagnoseAI',
        props.workId,
        selectedChapterId.value,
        currentContent,
        { ...bodyModelParams(), wordTarget: wordTarget.value }
      ) as {
        success: boolean
        report?: string
        scoreTotal?: number
        hardFail?: boolean
        scoreBreakdown?: QualityAiMetrics['breakdown']
        error?: string
      }

      if (!diagRes.success) {
        autoOptimizeMsg.value = `${roundLabel} 诊断失败：${diagRes.error}`
        break
      }

      const scoreTotal = diagRes.scoreTotal ?? 0
      const hardFail = diagRes.hardFail ?? false

      if (config.stopOnHardFail && hardFail) {
        autoOptimizeMsg.value = `${roundLabel} 总分 ${scoreTotal}，硬失败，停止优化`
        break
      }

      const items = diagRes.scoreBreakdown?.items
      const hasBreakdown = items && items.length > 0
      const allAboveMin = hasBreakdown
        ? items!.every(item => item.ratio >= config.minSubScoreRatio)
        : true

      if (scoreTotal >= config.targetTotalScore && allAboveMin) {
        const pct = Math.round(config.minSubScoreRatio * 100)
        autoOptimizeMsg.value = `优化完成：总分 ${scoreTotal}，各项均 ≥ ${pct}%，已达目标`
        break
      }

      if (scoreTotal >= config.targetTotalScore && !allAboveMin) {
        autoOptimizeMsg.value = `总分 ${scoreTotal} 已达目标，但存在低于 ${Math.round(config.minSubScoreRatio * 100)}% 的小项，继续优化`
      }

      if (!unlimited && i === config.maxIterations) {
        autoOptimizeMsg.value = `已达最大轮次，当前总分 ${scoreTotal}（目标 ${config.targetTotalScore}）`
        break
      }

      const patches = toPlainForIpc(diagRes.scoreBreakdown?.patches ?? [])
      if (patches.length > 0) {
        const patchRes = await window.anovel.invoke(
          'quality:applyLocalPatches',
          currentContent,
          patches
        ) as { success: boolean; patchedText?: string; appliedCount?: number }
        if (patchRes.success && patchRes.patchedText && (patchRes.appliedCount ?? 0) > 0) {
          currentContent = patchRes.patchedText
          continue
        }
      }

      if (!diagRes.report) {
        autoOptimizeMsg.value = `${roundLabel} 无诊断报告，停止优化`
        break
      }

      const fixRes = await window.anovel.invoke(
        'quality:applyFixes',
        props.workId,
        currentContent,
        diagRes.report,
        { ...bodyModelParams(), wordTarget: wordTarget.value }
      ) as { success: boolean; content?: string; error?: string }

      if (fixRes.success && fixRes.content) {
        currentContent = fixRes.content
      } else {
        autoOptimizeMsg.value = `${roundLabel} 优化失败：${fixRes.error || '未知错误'}`
        break
      }
    }
  } catch (e) {
    autoOptimizeMsg.value = `自动优化异常：${e instanceof Error ? e.message : String(e)}`
  } finally {
    autoOptimizing.value = false
  }

  return currentContent
}

async function saveAutoOptimizeConfig(config: Partial<AutoOptimizeConfig>) {
  try {
    const saved = await window.anovel.invoke('quality:setAutoOptimizeConfig', config) as AutoOptimizeConfig
    autoOptimizeConfig.value = { ...autoOptimizeConfig.value, ...saved }
    showToast('success', '自动优化配置已保存')
  } catch {
    showToast('error', '保存配置失败')
  }
}

async function recheckAntiAiViolations(content: string) {
  antiAiViolations.value = await window.anovel.invoke(
    'antiai:checkViolations',
    props.workId,
    content
  ) as AntiAiViolation[]
}

async function runPostGenerateChecks(content: string) {
  await recheckAntiAiViolations(content)
  runningV15Checks.value = true
  try {
    const chId = selectedChapterId.value!
    const [quality, worldview] = await Promise.all([
      window.anovel.invoke('quality:diagnose', props.workId, chId, content),
      window.anovel.invoke('narrative:checkWorldview', props.workId, content)
    ])
    qualityResult.value = quality as QualityResult
    worldviewViolations.value = worldview as { rule: string; detail: string }[]
  } finally {
    runningV15Checks.value = false
  }
}

async function runDualChannelCritique() {
  if (!result.value.trim() || !selectedChapterId.value || runningCritique.value) return
  runningCritique.value = true
  critiqueResult.value = null
  try {
    const res = await window.anovel.invoke(
      'critique:run',
      props.workId,
      result.value,
      selectedChapterId.value,
      bodyModelParams()
    ) as CritiqueResult & { success?: boolean; error?: string }
    if (res.success) {
      critiqueResult.value = res
    } else {
      alert(res.error || '双通道批判失败')
    }
  } finally {
    runningCritique.value = false
  }
}

const applyingFixes = ref(false)
const applyingCritiqueFixes = ref(false)
const runningQualityAI = ref(false)
const adjustingWordCount = ref(false)

async function runQualityAI() {
  if (!result.value || !selectedChapterId.value || runningQualityAI.value) return
  runningQualityAI.value = true
  try {
    const chId = selectedChapterId.value
    const [gate, res] = await Promise.all([
      window.anovel.invoke('quality:diagnose', props.workId, chId, result.value),
      window.anovel.invoke('quality:diagnoseAI', props.workId, chId, result.value, { ...bodyModelParams(), wordTarget: wordTarget.value })
    ])
    qualityResult.value = gate as QualityResult
    const aiRes = res as {
      success: boolean
      report?: string
      scoreTotal?: number
      hardFail?: boolean
      cappedByGate?: boolean
      scoreBreakdown?: QualityAiMetrics['breakdown']
      error?: string
    }
    if (aiRes.success) {
      qualityAiReport.value = aiRes.report || ''
      if (typeof aiRes.scoreTotal === 'number' && typeof aiRes.hardFail === 'boolean') {
        qualityAiMetrics.value = {
          scoreTotal: aiRes.scoreTotal,
          hardFail: aiRes.hardFail,
          cappedByGate: !!aiRes.cappedByGate,
          breakdown: aiRes.scoreBreakdown ?? null
        }
      } else {
        qualityAiMetrics.value = null
      }
      await nextTick()
      crossChapterReportRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    } else {
      alert(aiRes.error || 'AI 诊断失败')
    }
  } finally {
    runningQualityAI.value = false
  }
}

async function applyDiagnosisFixes() {
  if (!result.value || applyingFixes.value) return
  applyingFixes.value = true
  try {
    // 优先使用已在诊断中直接生成的 Patch 进行局部替换，无需再次请求 LLM
    const patches = toPlainForIpc(qualityAiMetrics.value?.breakdown?.patches ?? [])
    if (patches.length > 0) {
      const patchRes = await window.anovel.invoke(
        'quality:applyLocalPatches',
        result.value,
        patches
      ) as {
        success: boolean
        patchedText?: string
        appliedCount?: number
        patches?: { find: string; replace: string }[]
        error?: string
      }
      if (patchRes.success && patchRes.patchedText) {
        updateGeneratedContent(patchRes.patchedText)
        qualityAiReport.value = ''
        qualityAiMetrics.value = null
        const count = patchRes.appliedCount ?? 0
        if (count > 0) {
          showToast('success', `已应用本地 Patch，修复 ${count} 处问题`)
        } else {
          showToast('info', 'AI 诊断生成的修改建议未匹配到原文，已回退到全文重写模式')
        }
        if (count > 0) {
          return
        }
      }
      if (patchRes.error) {
        console.warn('[LocalPatch] 应用失败，回退到全文重写模式：', patchRes.error)
      }
    } else {
      if (workType.value === 'story') {
        alert('AI 未在诊断中生成可修复的具体 patches，请确认是否已运行诊断且存在扣分项')
        return
      }
    }

    // 回退：全文重写模式（无 patches 或本地应用 patches 失败时）
    if (!qualityAiReport.value) {
      alert('请先运行 AI 诊断')
      return
    }
    const res = await window.anovel.invoke('quality:applyFixes', props.workId, result.value, qualityAiReport.value, { ...bodyModelParams(), wordTarget: wordTarget.value }) as {
      success: boolean
      content?: string
      error?: string
    }
    if (res.success && res.content) {
      updateGeneratedContent(res.content)
      qualityAiReport.value = ''
      qualityAiMetrics.value = null
      showToast('success', '已通过全文重写应用修改建议')
    } else {
      alert(res.error || '修改失败')
    }
  } catch (e) {
    showToast('error', e instanceof Error ? e.message : '修改失败')
  } finally {
    applyingFixes.value = false
  }
}

async function applyCritiqueFixes() {
  if (!result.value || !critiqueResult.value || applyingCritiqueFixes.value) return
  applyingCritiqueFixes.value = true
  try {
    const res = await window.anovel.invoke('critique:applyFixes', props.workId, result.value, critiqueResult.value, bodyModelParams()) as {
      success: boolean
      content?: string
      error?: string
    }
    if (res.success && res.content) {
      updateGeneratedContent(res.content)
    } else {
      alert(res.error || '修改失败')
    }
  } finally {
    applyingCritiqueFixes.value = false
  }
}

async function adjustWordCount(action: 'expand' | 'compress') {
  if (!result.value || !selectedChapterId.value || adjustingWordCount.value) return
  adjustingWordCount.value = true
  try {
    const res = await window.anovel.invoke('quality:adjustWordCount', props.workId, result.value, action, { ...bodyModelParams(), wordTarget: wordTarget.value }) as {
      success: boolean
      content?: string
      error?: string
    }
    if (res.success && res.content) {
      updateGeneratedContent(res.content)
      qualityAiReport.value = ''
      qualityAiMetrics.value = null
      showToast('success', action === 'expand' ? '字数扩写成功' : '字数压缩成功')
    } else {
      showToast('error', res.error || (action === 'expand' ? '字数扩写失败' : '字数压缩失败'))
    }
  } catch (e) {
    showToast('error', e instanceof Error ? e.message : '调整字数失败')
  } finally {
    adjustingWordCount.value = false
  }
}

async function extractNarrativeMemory(chapterId: number, content: string) {
  extractingMemory.value = true
  memoryExtractMsg.value = ''
  try {
    const extract = await window.anovel.invoke('memory:extractFromChapter', props.workId, chapterId, content, bodyModelParams()) as {
      success: boolean
      planted?: number
      resolved?: number
      snapshots?: number
      error?: string
    }
    if (!extract.success) {
      memoryExtractMsg.value = `叙事记忆更新失败：${extract.error}`
      return
    }

    // AI 语义检测伏笔回收（替换旧硬编码匹配）
    let resolveMsg = ''
    try {
      const detect = await window.anovel.invoke(
        'foreshadowing:detectResolutions',
        props.workId,
        chapterId,
        content,
        toPlainForIpc(bodyModelParams())
      ) as { success: boolean; resolved?: number; partial?: number; total?: number; error?: string }
      if (detect.success && (detect.resolved || detect.partial)) {
        const parts: string[] = []
        if (detect.resolved) parts.push(`${detect.resolved} 条已回收`)
        if (detect.partial) parts.push(`${detect.partial} 条部分推进`)
        resolveMsg = ` · AI 回收检测：${parts.join('，')}`
      }
    } catch { /* 非关键，静默忽略 */ }

    memoryExtractMsg.value = `叙事记忆已更新：+${extract.planted ?? 0} 伏笔${resolveMsg} · ${extract.snapshots ?? 0} 角色快照`
    if (selectedChapterId.value) await loadNarrativeMemory(selectedChapterId.value)
  } finally {
    extractingMemory.value = false
  }
}

async function saveToChapter() {
  const ch = selectedChapter.value
  if (!ch || !result.value) return

  const gate = await window.anovel.invoke('consistency:gate', props.workId, ch.id, result.value) as ConsistencyGateResult
  gateResult.value = gate
  if (!gate.passed) {
    const msg = ['保存被 consistency 门禁拦截：', ...gate.blockers].join('\n')
    if (!confirm(`${msg}\n\n仍要强制保存吗？`)) return
  } else if (gate.warnings.length > 0) {
    const msg = gate.warnings.slice(0, 5).join('\n')
    if (!confirm(`保存前发现 ${gate.warnings.length} 条警告：\n${msg}\n\n继续保存？`)) return
  }

  savingChapter.value = true
  memoryExtractMsg.value = ''
  fingerprintMsg.value = ''
  try {
    // 使用 AI 生成时提取的情绪强度（如有），否则尝试从文本中解析
    const intensity = pendingEmotionIntensity.value ?? extractEmotionIntensity(result.value).intensity
    pendingEmotionIntensity.value = null

    const wordCount = countWords(result.value)
    // 版本快照由 chapter:update IPC 自动创建（修改 content 时自动存档）
    const updateFields: Record<string, unknown> = {
      content: result.value,
      word_count: wordCount,
      status: 'draft'
    }
    if (intensity != null) updateFields.emotion_intensity = intensity
    await window.anovel.invoke('chapter:update', ch.id, updateFields)
    const idx = chapters.value.findIndex(c => c.id === ch.id)
    if (idx >= 0) {
      chapters.value[idx] = { ...chapters.value[idx], content: result.value, word_count: wordCount }
    }
    clearCachedBodyContent(ch.id)
    await nav?.refreshProgress()

    const fp = await window.anovel.invoke('fingerprint:checkDeviation', props.workId, ch.id, result.value) as {
      success?: boolean
      score?: number
      styleName?: string
      error?: string
    }
    if (fp.success) {
      fingerprintMsg.value = `文风偏差 ${fp.score}（${fp.styleName}）`
    }
  } finally {
    savingChapter.value = false
  }

  const updateMemory = confirm(
    '正文已保存。\n\n是否从本章提取叙事记忆（伏笔、角色快照）？\n\n确定后将调用 AI 分析本章并更新记忆体，供后续章节生成使用。'
  )
  if (updateMemory) {
    await extractNarrativeMemory(ch.id, result.value)
  }
}

async function updateGeneratedContent(content: string) {
  // 重新生成 / 润色 / 辩论融合等路径同样接自动去AI，避免绕过 humanize 落入裸 AI 文本
  if (content && autoHumanize.value) {
    content = await applyHumanize(content)
  }
  if (content && autoRewrite.value) {
    content = await applyAutoRewrite(content)
  }
  result.value = content
  void runPostGenerateChecks(content)
}

function onAntiAiRulesAdded() {
  void antiAiRulesPanelRef.value?.reload()
  onAntiAiRulesUpdated()
}

function onAntiAiRulesUpdated() {
  if (selectedChapterId.value) {
    void refreshBudgetPreview(selectedChapterId.value)
  }
}

async function applyStripEmDashes(mode: 'comma' | 'delete') {
  if (!result.value.trim()) return
  const cleaned = await window.anovel.invoke('antiai:stripEmDashes', result.value, mode) as string
  result.value = cleaned
  await recheckAntiAiViolations(cleaned)
}

async function copyBodyContent() {
  if (!result.value.trim()) return
  try {
    await navigator.clipboard.writeText(result.value)
    copyHint.value = '已复制'
    setTimeout(() => { copyHint.value = '' }, 2000)
  } catch {
    copyHint.value = '复制失败'
    setTimeout(() => { copyHint.value = '' }, 2000)
  }
}

const isExportingStory = ref(false)
async function copyCompleteStory() {
  if (chapters.value.length === 0) return
  isExportingStory.value = true
  try {
    const fullText = chapters.value
      .filter(ch => ch.content && ch.content.trim() !== '')
      .map((ch, index) => [`第${index + 1}章 ${ch.title.trim()}`, ch.content?.trim()].filter(Boolean).join('\n\n'))
      .join('\n\n')
    
    if (!fullText) {
      alert('所有节拍均无正文，无法复制！')
      return
    }

    await navigator.clipboard.writeText(fullText)
    alert('合并成功！已复制全文到剪贴板，请直接粘贴到发布平台。')
  } catch (err) {
    alert('复制失败: ' + String(err))
  } finally {
    isExportingStory.value = false
  }
}
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <PanelTitle icon="pen-nib" title="正文生成" />

    <div v-if="volumes.length === 0" class="text-center py-12 text-base-content/40">
      <p>请先创建分卷和章节</p>
    </div>

    <template v-else>
      <div v-if="workType !== 'story'" class="flex gap-2 mb-3 flex-wrap shrink-0">
        <button
          v-for="vol in volumes"
          :key="vol.id"
          :class="['btn btn-sm', selectedVolume === vol.id ? 'btn-primary' : 'btn-ghost']"
          @click="selectedVolume = vol.id"
        >
          {{ vol.name }}
        </button>
      </div>

      <div
        v-if="chapters.length === 0"
        class="text-center py-12 text-base-content/40"
      >
        <p>{{ workType === 'story' ? '还没有节拍，请先在「节拍大纲」中拆解' : '本卷还没有章节，请先在「章节情节」中添加' }}</p>
      </div>

      <div
        v-else
        class="flex-1 grid gap-3 min-h-[calc(100vh-14rem)] grid-cols-1 xl:grid-cols-[minmax(240px,280px)_1fr]"
      >
        <div class="card bg-base-200 border border-base-300 shadow-sm p-3 flex flex-col min-h-0 max-h-[70vh] xl:max-h-none">
          <div class="flex items-center justify-between gap-2 mb-2 shrink-0">
            <h4 class="font-semibold text-sm">{{ workType === 'story' ? '创作节拍' : '章节' }}</h4>
            <span class="text-xs text-base-content/40">{{ chapters.length }} {{ workType === 'story' ? '拍' : '章' }}</span>
          </div>
          <div class="shrink-0 overflow-y-auto space-y-1 min-h-0 max-h-[calc(100vh-18rem)] -mx-1 px-1 mb-3">
            <button
              v-for="ch in paginatedChapters"
              :key="ch.id"
              type="button"
              class="w-full text-left rounded-lg px-3 py-2 transition-colors border"
              :class="selectedChapterId === ch.id
                ? 'border-primary/40 bg-primary/10'
                : 'border-transparent hover:bg-base-100/80'"
              @click="selectChapter(ch)"
            >
              <div class="font-medium text-sm truncate">{{ ch.title }}</div>
              <div class="flex flex-wrap gap-1 mt-1">
                <span class="text-[11px] text-base-content/40">{{ ch.word_count || 0 }} 字</span>
                <span
                  :class="ch.content
                    ? (ch.status === 'draft' ? 'badge badge-warning badge-xs' : 'badge badge-success badge-xs')
                    : 'badge badge-ghost badge-xs'"
                >
                  {{ ch.content ? (ch.status === 'draft' ? '草稿' : '已有正文') : '未生成' }}
                </span>
              </div>
            </button>
          </div>

          <!-- 分页控件 -->
          <div v-if="totalPages > 1" class="flex justify-center items-center gap-2 mb-3 pb-2 border-b border-base-300/40 shrink-0">
            <button
              type="button"
              class="btn btn-xs btn-outline"
              :disabled="currentPage === 1"
              @click="currentPage--"
            >
              <font-awesome-icon icon="chevron-left" />
            </button>
            <span class="text-xs text-base-content/60 font-semibold">{{ currentPage }} / {{ totalPages }}</span>
            <button
              type="button"
              class="btn btn-xs btn-outline"
              :disabled="currentPage === totalPages"
              @click="currentPage++"
            >
              <font-awesome-icon icon="chevron-right" />
            </button>
          </div>

          <details class="collapse collapse-arrow bg-base-100 border border-base-300/60 rounded-lg shrink-0">
            <summary class="collapse-title min-h-0 py-2 text-xs font-medium">创作上下文</summary>
            <div class="collapse-content text-xs space-y-2 pb-2">
              <template v-if="selectedChapter">
                <div>
                  <span class="text-base-content/50">章节大纲</span>
                  <p class="mt-0.5 whitespace-pre-wrap text-base-content/70 max-h-24 overflow-auto">
                    {{ selectedChapter.outline || '（暂无大纲）' }}
                  </p>
                </div>
                <div>
                  <span class="text-base-content/50">叙事记忆</span>
                  <p class="mt-0.5 text-base-content/60">
                    伏笔 {{ memoryStats.pendingForeshadowingCount }} · 快照 {{ memoryStats.snapshotCharacterCount }} · 时间线 {{ memoryStats.timelineEventCount }}
                  </p>
                  <p v-if="memoryStats.hasPreviousChapter" class="text-success mt-0.5">
                    衔接：{{ memoryStats.previousChapterTitle }}
                  </p>
                  <p v-if="narrativeMemoryText" class="mt-0.5 whitespace-pre-wrap text-base-content/60 max-h-20 overflow-auto">
                    {{ narrativeMemoryText }}
                  </p>
                  <p v-if="memoryStats.anchorLimitWarning" class="text-warning mt-0.5">{{ memoryStats.anchorLimitWarning }}</p>
                </div>
                <div>
                  <span class="text-base-content/50">文风 · 锚点</span>
                  <p class="mt-0.5 text-base-content/60">{{ boundStyleName || '未绑定' }} · {{ activeAnchorCount }}/{{ maxActiveAnchors }}</p>
                </div>
                <details>
                  <summary class="text-base-content/50 cursor-pointer select-none hover:text-base-content/70">
                    参考范文（作品级）
                    <span v-if="workReferenceText" class="text-base-content/30 ml-1">{{ workReferenceText.length }}字</span>
                  </summary>
                  <div class="mt-1 space-y-1">
                    <textarea
                      v-model="workReferenceText"
                      placeholder="粘贴目标风格的范文，AI 将模仿其用词和句式"
                      rows="4"
                      maxlength="5000"
                      class="textarea textarea-bordered textarea-xs w-full text-xs resize-none"
                    />
                    <div class="flex items-center gap-1">
                      <button
                        type="button"
                        class="btn btn-primary btn-xs"
                        :disabled="workRefSaving"
                        @click="saveWorkReferenceText"
                      >
                        {{ workRefSaving ? '保存中…' : '保存' }}
                      </button>
                      <label class="btn btn-ghost btn-xs gap-1 cursor-pointer">
                        <font-awesome-icon icon="upload" class="w-3 h-3" />
                        导入
                        <input type="file" accept=".txt,.text" class="hidden" @change="handleWorkRefFile" />
                      </label>
                      <span class="text-base-content/30 text-xs ml-auto">{{ workReferenceText.length }} / 5000</span>
                    </div>
                  </div>
                </details>
              </template>
            </div>
          </details>

          <div v-if="workType === 'story'" class="shrink-0 mt-3">
            <button
              type="button"
              class="btn btn-primary btn-block btn-sm gap-2"
              :disabled="isExportingStory || chapters.length === 0"
              @click="copyCompleteStory"
            >
              <font-awesome-icon :icon="isExportingStory ? 'spinner' : 'copy'" :spin="isExportingStory" class="w-3.5 h-3.5" />
              {{ isExportingStory ? '合并复制中...' : '一键合并并复制全文' }}
            </button>
          </div>
        </div>

        <div class="card bg-base-200 border border-base-300 shadow-sm p-4 min-w-0 flex flex-col min-h-0">
          <template v-if="selectedChapter">
            <div class="flex flex-wrap items-center gap-2 mb-3 shrink-0">
              <h4 class="font-semibold text-base min-w-0 truncate flex-1">
                {{ workType === 'story' ? '整篇正文' : selectedChapter.title }}
              </h4>
              <span class="text-xs text-base-content/40">{{ contentWordCount.toLocaleString() }} 字</span>
              <label class="text-xs text-base-content/50">目标</label>
              <select v-model="wordTarget" class="select select-bordered select-xs w-24">
                <option v-for="w in wordOptions" :key="w" :value="w">{{ w }} 字</option>
              </select>
              <span v-if="wordRange.recommended < wordTarget" class="text-xs text-warning" :title="`根据大纲密度，建议 ${wordRange.min}-${wordRange.max} 字`">
                建议 ≤{{ wordRange.recommended }}
              </span>
              <div class="join join-horizontal">
                <button
                  type="button"
                  class="btn btn-xs join-item"
                  :class="!previewMode ? 'btn-primary' : 'btn-ghost'"
                  @click="previewMode = false"
                >
                  编辑
                </button>
                <button
                  type="button"
                  class="btn btn-xs join-item"
                  :class="previewMode ? 'btn-primary' : 'btn-ghost'"
                  @click="previewMode = true"
                >
                  预览
                </button>
              </div>
              <button
                type="button"
                class="btn btn-ghost btn-xs gap-1"
                :disabled="!result.trim()"
                title="复制正文"
                @click="copyBodyContent"
              >
                <font-awesome-icon icon="copy" class="w-3 h-3" />
                {{ copyHint || '复制' }}
              </button>
              <button
                class="btn btn-primary btn-sm gap-1"
                :disabled="loading"
                @click="generateBody"
              >
                <font-awesome-icon :icon="loading ? 'spinner' : 'pen-nib'" :spin="loading" class="w-3.5 h-3.5" />
                {{ loading ? '生成中...' : 'AI 生成' }}
              </button>
              <button
                class="btn btn-outline btn-primary btn-sm gap-1"
                :disabled="!result.trim() || savingChapter || extractingMemory"
                @click="saveToChapter"
              >
                <font-awesome-icon
                  :icon="savingChapter || extractingMemory ? 'spinner' : 'save'"
                  :spin="savingChapter || extractingMemory"
                  class="w-3.5 h-3.5"
                />
                {{ savingChapter ? '保存中...' : extractingMemory ? '更新记忆中...' : '保存' }}
              </button>
              <ChapterVersionHistory ref="versionHistoryRef" :chapter-id="selectedChapterId" :current-content="result" />
              <label class="flex items-center gap-1 text-xs cursor-pointer" title="生成后自动进行词级人性化处理，降低AI检测率">
                <input v-model="autoHumanize" type="checkbox" class="checkbox checkbox-xs checkbox-primary" />
                <span class="text-base-content/60">自动去AI</span>
              </label>
              <label class="flex items-center gap-1 text-xs cursor-pointer" title="生成后对高AI段落生成式重写择优（更慢、更深，直击困惑度）">
                <input v-model="autoRewrite" type="checkbox" class="checkbox checkbox-xs checkbox-primary" />
                <span class="text-base-content/60">深度去AI</span>
              </label>
              <div class="flex items-center gap-1" title="生成后自动运行 AI 诊断与优化，直到分项评分达到目标">
                <label class="flex items-center gap-1 text-xs cursor-pointer">
                  <input
                    v-model="autoOptimizeConfig.enabled"
                    type="checkbox"
                    class="checkbox checkbox-xs checkbox-primary"
                    @change="saveAutoOptimizeConfig({ enabled: autoOptimizeConfig.enabled })"
                  />
                  <span class="text-base-content/60" :class="{ 'text-primary font-medium': autoOptimizeConfig.enabled }">自动优化</span>
                </label>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs px-1"
                  title="设置自动优化目标"
                  @click="autoOptimizeModalOpen = true"
                >
                  <font-awesome-icon icon="cog" class="w-3 h-3" />
                </button>
              </div>
              <button
                v-if="result.trim()"
                type="button"
                class="btn btn-ghost btn-xs gap-1"
                :disabled="humanizing"
                title="对当前正文进行词级替换和句式扰动，降低AI检测率"
                @click="manualHumanize"
              >
                <font-awesome-icon :icon="humanizing ? 'spinner' : 'eraser'" :spin="humanizing" class="w-3 h-3" />
                {{ humanizing ? '处理中...' : (humanizeHint || '手动去AI') }}
              </button>
              <button
                v-if="result.trim()"
                type="button"
                class="btn btn-accent btn-xs gap-1"
                :disabled="styleRewriting || loading"
                title="先运行 AI 诊断，再按诊断建议精准 Patch 修改（等同于 AI 诊断 + 按建议修改）"
                @click="styleRewrite"
              >
                <font-awesome-icon :icon="styleRewriting ? 'spinner' : 'pen-nib'" :spin="styleRewriting" class="w-3 h-3" />
                {{ styleRewriting ? '优化中...' : '稿件优化' }}
              </button>
              <button
                class="btn btn-ghost btn-xs gap-1"
                :disabled="!result.trim() || runningQualityAI"
                @click="runQualityAI"
              >
                <font-awesome-icon :icon="runningQualityAI ? 'spinner' : 'clipboard-check'" :spin="runningQualityAI" class="w-3 h-3" />
                {{ runningQualityAI ? '诊断中...' : 'AI 诊断' }}
              </button>
              <button
                v-if="qualityAiReport"
                class="btn btn-warning btn-xs gap-1"
                :disabled="applyingFixes || loading"
                @click="applyDiagnosisFixes"
              >
                <font-awesome-icon :icon="applyingFixes ? 'spinner' : 'wrench'" :spin="applyingFixes" class="w-3 h-3" />
                {{ applyingFixes ? '修改中...' : '按建议修改' }}
              </button>
              <button
                v-if="result.trim() && isWordCountShort"
                type="button"
                class="btn btn-warning btn-xs gap-1 btn-outline"
                :disabled="adjustingWordCount || loading"
                title="字数严重不足（偏离目标>10%），由 AI 合理丰富细节以扩充字数"
                @click="adjustWordCount('expand')"
              >
                <font-awesome-icon :icon="adjustingWordCount ? 'spinner' : 'expand'" :spin="adjustingWordCount" class="w-3 h-3" />
                {{ adjustingWordCount ? '扩写中...' : 'AI 扩写字数' }}
              </button>
              <button
                v-if="result.trim() && isWordCountLong"
                type="button"
                class="btn btn-warning btn-xs gap-1 btn-outline"
                :disabled="adjustingWordCount || loading"
                title="字数严重超标（偏离目标>10%），由 AI 裁剪注水以精简字数"
                @click="adjustWordCount('compress')"
              >
                <font-awesome-icon :icon="adjustingWordCount ? 'spinner' : 'compress'" :spin="adjustingWordCount" class="w-3 h-3" />
                {{ adjustingWordCount ? '压缩中...' : 'AI 压缩字数' }}
              </button>
              <FavoriteButton
                v-if="result.trim()"
                :work-id="workId"
                source-step="body_generation"
                source-label="正文生成"
                :content="result"
                :source-input="lastPrompt"
                size="xs"
              />
              </div>
              <p
                v-if="autoOptimizeMsg"
                class="text-xs shrink-0"
                :class="autoOptimizing ? 'text-info' : (autoOptimizeMsg.includes('完成') || autoOptimizeMsg.includes('已达') ? 'text-success' : 'text-warning')"
              >
                <font-awesome-icon v-if="autoOptimizing" icon="spinner" spin class="w-3 h-3 mr-1" />
                {{ autoOptimizeMsg }}
              </p>

            <AntiAiRulesPanel
              ref="antiAiRulesPanelRef"
              :work-id="workId"
              class="mb-3 shrink-0"
              @updated="onAntiAiRulesUpdated"
            />

            <div v-if="budgetPreview" class="mb-2 rounded-lg border border-base-300 px-3 py-2 text-xs flex flex-wrap items-center gap-x-4 gap-y-1 shrink-0">
              <span class="font-medium">Token 预算</span>
              <span :class="budgetPressureClass(budgetPreview.pressure)">
                {{ Math.round(budgetPreview.usageRatio * 100) }}%
              </span>
              <span class="text-base-content/50">
                {{ budgetPreview.usedTokens.toLocaleString() }} / {{ budgetPreview.maxContextTokens.toLocaleString() }}
              </span>
              <span v-if="budgetPreview.continuityMode === 'full'" class="text-success">上章全文</span>
              <span v-else-if="budgetPreview.continuityMode === 'tail'" class="text-warning">上章末尾裁剪</span>
              <span
                v-if="antiAiRulesInjected"
                class="text-success"
                title="去AI味规则已写入 system prompt 末尾"
              >
                去AI规则已注入
              </span>
              <button
                type="button"
                class="btn btn-ghost btn-xs gap-1 ml-auto"
                :disabled="scanningCrossChapter"
                title="基于已保存章节正文、伏笔与角色快照，检查全书衔接与一致性（不调用 AI）"
                @click="runCrossChapterScan"
              >
                <font-awesome-icon :icon="scanningCrossChapter ? 'spinner' : 'search'" :spin="scanningCrossChapter" class="w-3 h-3" />
                {{ scanningCrossChapter ? '扫描中...' : (crossChapterScanHint || '跨章扫描') }}
              </button>
            </div>

            <div v-if="error" class="alert alert-error text-xs py-2 mb-2 shrink-0">{{ error }}</div>
            <p v-if="memoryExtractMsg" class="text-xs text-success mb-2 shrink-0">{{ memoryExtractMsg }}</p>
            <p v-if="fingerprintMsg" class="text-xs text-base-content/50 mb-2 shrink-0">{{ fingerprintMsg }}</p>
            <p
              v-if="humanizeMsg"
              class="text-xs mb-2 shrink-0 rounded-lg border px-3 py-2"
              :class="humanizeMsgTone === 'success'
                ? 'text-success border-success/30 bg-success/5'
                : humanizeMsgTone === 'warning'
                  ? 'text-warning border-warning/30 bg-warning/5'
                  : 'text-error border-error/30 bg-error/5'"
            >
              {{ humanizeMsg }}
            </p>
            <div
              v-if="crossChapterScanMsg"
              class="text-xs mb-2 shrink-0 rounded-lg border px-3 py-2 space-y-1"
              :class="crossChapterScanTone === 'success'
                ? 'text-success border-success/30 bg-success/5'
                : crossChapterScanTone === 'warning'
                  ? 'text-warning border-warning/30 bg-warning/5'
                  : crossChapterScanTone === 'error'
                    ? 'text-error border-error/30 bg-error/5'
                    : 'text-base-content/70 border-base-300 bg-base-100'"
            >
              <p class="font-medium">{{ crossChapterScanMsg }}</p>
              <ul
                v-if="crossChapterIssues.length && !crossChapterScanMsg.includes('章节不足')"
                class="space-y-0.5 max-h-24 overflow-auto"
              >
                <li
                  v-for="(issue, i) in crossChapterIssues"
                  :key="i"
                  :class="issue.severity === 'warning'
                    ? 'text-warning'
                    : issue.severity === 'error'
                      ? 'text-error'
                      : 'text-base-content/60'"
                >
                  {{ issue.chapterTitle ? `「${issue.chapterTitle}」` : '' }}{{ issue.message }}
                </li>
              </ul>
            </div>
            <div v-if="gateResult && !gateResult.passed" class="text-xs text-error mb-2 shrink-0">
              门禁拦截：{{ gateResult.blockers.join('；') }}
            </div>
            <div v-if="antiAiViolations.length" class="alert alert-warning text-xs py-2 mb-2 shrink-0">
              <p class="font-medium mb-1">去AI规则违规（模型未完全遵守 system prompt）</p>
              <ul class="space-y-0.5">
                <li v-for="(v, i) in antiAiViolations" :key="i">{{ v.detail }}</li>
              </ul>
              <div v-if="hasEmDashViolation" class="flex flex-wrap gap-1 mt-2">
                <button
                  type="button"
                  class="btn btn-primary btn-xs"
                  @click="applyStripEmDashes('comma')"
                >
                  一键换逗号
                </button>
                <button
                  type="button"
                  class="btn btn-outline btn-xs"
                  @click="applyStripEmDashes('delete')"
                >
                  一键删除破折号
                </button>
              </div>
              <p v-else class="mt-1 text-base-content/50">可点「AI 生成」重试，或使用微指令修改。</p>
            </div>
            <div v-if="hasEmDashInResult && !hasEmDashViolation" class="flex flex-wrap gap-1 mb-2 shrink-0">
              <button
                type="button"
                class="btn btn-primary btn-xs"
                @click="applyStripEmDashes('comma')"
              >
                一键换逗号
              </button>
              <button
                type="button"
                class="btn btn-outline btn-xs"
                @click="applyStripEmDashes('delete')"
              >
                一键删除破折号
              </button>
            </div>

            <div class="flex-1 min-h-[50vh] flex flex-col min-h-0 mb-3">
              <textarea
                v-if="!previewMode"
                v-model="result"
                class="textarea textarea-bordered w-full flex-1 min-h-[50vh] resize-y font-serif text-base leading-relaxed p-4"
                placeholder="在此编辑正文，或点击「AI 生成」自动撰写..."
              />
              <div
                v-else
                class="flex-1 min-h-[50vh] overflow-auto border border-base-300 rounded-lg p-4 bg-base-100"
              >
                <MarkdownContent v-if="result.trim()" :content="result" size="sm" />
                <p v-else class="text-sm text-base-content/40 italic">暂无正文</p>
              </div>
            </div>

            <div v-if="result.trim()" class="space-y-2 shrink-0">
              <AiInterventionBar
                :work-id="workId"
                step="body_generation"
                :content="result"
                :regenerate-prompt="lastPrompt"
                :regenerate-system-prompt="bodySystemPrompt"
                v-bind="bodyModelParams()"
                @update:content="updateGeneratedContent"
              />
              <AntiMeanPanel :work-id="workId" :content="result" @apply-content="updateGeneratedContent" />
              <ModelDebatePanel
                :work-id="workId"
                :prompt="lastPrompt"
                :system-prompt="bodySystemPrompt"
                @apply="updateGeneratedContent"
              />
              <AiTraceReport
                :work-id="workId"
                :content="result"
                :model-type="bodyModelParams().modelType"
                :model-name="bodyModelParams().modelName"
                @polished="updateGeneratedContent"
                @rules-added="onAntiAiRulesAdded"
              />
            </div>

            <details
              v-if="result.trim() || critiqueResult || qualityResult || qualityAiReport || qualityAiMetrics || crossChapterIssues.length"
              ref="crossChapterReportRef"
              class="collapse collapse-arrow bg-base-100 border border-base-300/60 rounded-lg mt-3 shrink-0"
              open
            >
              <summary class="collapse-title min-h-0 py-2 text-xs font-medium">
                质量报告与对齐检测
                <span v-if="crossChapterIssues.length" class="text-base-content/40 font-normal ml-1">
                  · 跨章 {{ crossChapterIssues.length }} 条
                </span>
              </summary>
              <div class="collapse-content space-y-2 pb-3">
                <div v-if="contextBudget" class="rounded-lg border border-base-300 p-2 text-xs">
                  <p class="font-medium mb-1">本次生成上下文</p>
                  <p :class="budgetPressureClass(contextBudget.pressure)">
                    使用率 {{ Math.round(contextBudget.usageRatio * 100) }}%
                    · {{ contextBudget.continuityMode === 'full' ? '上章全文' : contextBudget.continuityMode === 'tail' ? '上章末尾' : '无上章' }}
                  </p>
                </div>
                <div v-if="crossChapterIssues.length" class="text-xs space-y-1 max-h-32 overflow-auto">
                  <p
                    v-for="(issue, i) in crossChapterIssues"
                    :key="i"
                    :class="issue.severity === 'warning' ? 'text-warning' : issue.severity === 'error' ? 'text-error' : 'text-base-content/50'"
                  >
                    {{ issue.chapterTitle ? `「${issue.chapterTitle}」` : '' }}{{ issue.message }}
                  </p>
                </div>
                <p v-if="runningV15Checks" class="text-xs text-base-content/40">质量诊断运行中...</p>
                <div class="flex items-center gap-2">
                  <button
                    type="button"
                    class="btn btn-outline btn-xs gap-1"
                    :disabled="!result.trim() || runningCritique"
                    @click="runDualChannelCritique"
                  >
                    <font-awesome-icon :icon="runningCritique ? 'spinner' : 'balance-scale'" :spin="runningCritique" class="w-3 h-3" />
                    {{ runningCritique ? '批判中...' : '双通道批判' }}
                  </button>
                </div>
                <ChapterCritiqueReport
                  :result="critiqueResult"
                  :applying="applyingCritiqueFixes"
                  @apply-fixes="applyCritiqueFixes"
                />
                <ChapterQualityReport
                  :result="qualityResult"
                  :ai-report="qualityAiReport"
                  :ai-metrics="qualityAiMetrics"
                  :block-hints="blockHints"
                />
                <div v-if="worldviewViolations.length" class="space-y-1">
                  <p class="text-xs font-medium text-warning">世界观校验</p>
                  <p v-for="(v, i) in worldviewViolations" :key="i" class="text-xs text-warning">{{ v.detail }}</p>
                </div>
              </div>
            </details>
          </template>

          <p v-else class="text-sm text-base-content/40 italic flex-1 flex items-center justify-center">
            请从左侧选择章节
          </p>
        </div>
      </div>
    </template>

    <StepNavFooter step="generate" hint="保存正文后可选择是否更新叙事记忆体；可在侧边栏「叙事记忆体」查看伏笔与快照" class="shrink-0 mt-4" />
  </div>

  <dialog class="modal" :class="{ 'modal-open': autoOptimizeModalOpen }">
    <div class="modal-box max-w-sm">
      <h3 class="font-bold text-sm mb-4">自动优化设置</h3>

      <div class="space-y-4">
        <label class="flex items-center justify-between gap-2 text-sm">
          <span>目标总分</span>
          <div class="flex items-center gap-2">
            <input
              v-model.number="autoOptimizeConfig.targetTotalScore"
              type="range"
              min="60"
              max="100"
              step="5"
              class="range range-xs range-primary w-28"
            />
            <span class="text-xs font-mono w-8 text-right">{{ autoOptimizeConfig.targetTotalScore }}</span>
          </div>
        </label>

        <label class="flex items-center justify-between gap-2 text-sm">
          <span>小项最低比率</span>
          <div class="flex items-center gap-2">
            <input
              v-model.number="autoOptimizeConfig.minSubScoreRatio"
              type="range"
              min="0.5"
              max="1"
              step="0.05"
              class="range range-xs range-primary w-28"
            />
            <span class="text-xs font-mono w-8 text-right">{{ Math.round(autoOptimizeConfig.minSubScoreRatio * 100) }}%</span>
          </div>
        </label>

        <div class="space-y-2">
          <label class="flex items-center justify-between gap-2 text-sm">
            <span>最大优化轮次</span>
            <input
              v-model.number="autoOptimizeConfig.maxIterations"
              type="number"
              min="1"
              max="99"
              step="1"
              class="input input-bordered input-xs w-28 text-center"
              :disabled="autoOptimizeUnlimited"
            />
          </label>
          <label class="flex items-center gap-2 text-sm cursor-pointer">
            <input v-model="autoOptimizeUnlimited" type="checkbox" class="checkbox checkbox-xs checkbox-primary" />
            <span>不限轮次</span>
          </label>
        </div>

        <label class="flex items-center gap-2 text-sm cursor-pointer">
          <input v-model="autoOptimizeConfig.stopOnHardFail" type="checkbox" class="checkbox checkbox-xs checkbox-primary" />
          <span>硬失败时停止</span>
        </label>
      </div>

      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" @click="autoOptimizeModalOpen = false">取消</button>
        <button
          type="button"
          class="btn btn-primary btn-sm"
          @click="saveAutoOptimizeConfig({ targetTotalScore: autoOptimizeConfig.targetTotalScore, minSubScoreRatio: autoOptimizeConfig.minSubScoreRatio, maxIterations: autoOptimizeConfig.maxIterations, stopOnHardFail: autoOptimizeConfig.stopOnHardFail }); autoOptimizeModalOpen = false"
        >
          保存
        </button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop" @click="autoOptimizeModalOpen = false">
      <button type="button">close</button>
    </form>
  </dialog>
</template>
