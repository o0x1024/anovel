<script lang="ts">
const unsavedContentCache = new Map<number, string>()
</script>

<script setup lang="ts">
import { ref, onMounted, watch, computed, inject, nextTick } from 'vue'
import { useStyleChangeSync } from '../../composables/useStyleChangeSync'
import { useModelChat } from './useModelChat'
import PanelTitle from '../../components/PanelTitle.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import FavoriteButton from '../../components/FavoriteButton.vue'
import StepNavFooter from './StepNavFooter.vue'
import AnchorAlignmentReport from './AnchorAlignmentReport.vue'
import AiInterventionBar from './AiInterventionBar.vue'
import ChapterCritiqueReport from './ChapterCritiqueReport.vue'
import ChapterQualityReport from './ChapterQualityReport.vue'
import AntiMeanPanel from './AntiMeanPanel.vue'
import ModelDebatePanel from './ModelDebatePanel.vue'
import AiTraceReport from './AiTraceReport.vue'
import AntiAiRulesPanel from './AntiAiRulesPanel.vue'
import { editorNavKey } from './editor-nav'
import { normalizeBodyParagraphSpacing } from '../../../../shared/normalize-body-text'
import { formatBodyWordTargetLine } from '../../../../shared/body-word-target'
import { WORDS_PER_CHAPTER_PRESETS } from '../../../../shared/writing-plan-presets'

const props = defineProps<{ workId: number }>()
const nav = inject(editorNavKey)

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
const wordTarget = ref(4000)
const wordOptions = WORDS_PER_CHAPTER_PRESETS

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

interface AlignmentReport {
  items: {
    anchorId: number
    title: string
    content: string
    type: string
    aligned: 0 | 1 | 2 | null
    detail: string
    skipped?: boolean
    skipReason?: string
  }[]
  summary: {
    total: number
    applicable?: number
    aligned: number
    partial: number
    missing: number
    skipped?: number
  }
}

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
  items: { key: string; label: string; severity: string; passed: boolean; detail: string }[]
  fatalCount: number
  warningCount: number
  passed: boolean
  summary: string
  writerBlockHint?: string
}

const alignmentReport = ref<AlignmentReport | null>(null)
const critiqueResult = ref<CritiqueResult | null>(null)
const qualityResult = ref<QualityResult | null>(null)
const qualityAiReport = ref('')
const worldviewViolations = ref<{ rule: string; detail: string }[]>([])
const checkingAlignment = ref(false)
const runningV15Checks = ref(false)
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
const humanizing = ref(false)
const styleRewriting = ref(false)
const humanizeStats = ref<{ wordSubstitutionHits: number; uniformSentenceRuns: number; avgTokenPredictability: string } | null>(null)
const workReferenceText = ref('')
const workRefSaving = ref(false)

const { loading, result, error, contextBudget, chat } = useModelChat(() => props.workId)
const lastPrompt = ref('')

const selectedChapter = computed(() =>
  chapters.value.find(c => c.id === selectedChapterId.value) ?? null
)

const contentWordCount = computed(() => result.value.replace(/\s/g, '').length)
const previewMode = ref(false)
const antiAiRulesInjected = computed(() =>
  budgetPreview.value?.sections?.some(s => s.key === 'anti_ai_rules' && s.included) ?? false
)
const hasEmDashViolation = computed(() =>
  antiAiViolations.value.some(v => /破折号/.test(v.rule) || /破折号/.test(v.detail))
)

function selectChapter(ch: Chapter) {
  selectedChapterId.value = ch.id
}

const bodySystemPrompt = ref('')

async function loadBodySystemPrompt() {
  bodySystemPrompt.value = await window.anovel.invoke('prompt:resolve', 'body_generation.system') as string
}

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
  await loadBodySystemPrompt()
  const plan = await window.anovel.invoke('writingPlan:get', props.workId) as { wordsPerChapter: number }
  if (plan.wordsPerChapter) wordTarget.value = plan.wordsPerChapter
  volumes.value = await window.anovel.invoke('volume:list', props.workId) as never[]
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
})

watch(selectedVolume, async (v) => {
  selectedChapterId.value = null
  if (v) {
    chapters.value = await window.anovel.invoke('chapter:list', v) as never[]
    if (chapters.value.length) selectedChapterId.value = chapters.value[0].id
  } else {
    chapters.value = []
  }
})

watch(result, (val) => {
  const chId = selectedChapterId.value
  if (chId != null) {
    unsavedContentCache.set(chId, val)
  }
})

watch(selectedChapterId, async (id) => {
  if (id) {
    await loadNarrativeMemory(id)
    const ch = chapters.value.find(c => c.id === id)
    const dbContent = ch?.content ?? ''
    const cached = unsavedContentCache.get(id)
    const raw = (cached !== undefined && cached !== dbContent) ? cached : dbContent
    result.value = raw ? normalizeBodyParagraphSpacing(raw) : raw
    critiqueResult.value = null
    qualityResult.value = null
    qualityAiReport.value = ''
    worldviewViolations.value = []
    alignmentReport.value = null
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
    ch.outline ? `章节大纲：\n${ch.outline}` : '（暂无章节大纲，请尽量根据作品上下文创作）'
  ].filter(Boolean).join('\n\n')

  const report = await window.anovel.invoke('context:estimateBudget', {
    prompt,
    systemPrompt: bodySystemPrompt.value,
    workId: props.workId,
    step: 'body_generation',
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
    ch.outline ? `章节大纲：\n${ch.outline}` : '（暂无章节大纲，请尽量根据作品上下文创作）'
  ].filter(Boolean).join('\n\n')

  lastPrompt.value = prompt
  critiqueResult.value = null
  qualityResult.value = null
  qualityAiReport.value = ''
  worldviewViolations.value = []
  gateResult.value = null
  humanizeMsg.value = ''
  humanizeHint.value = ''

  await refreshBudgetPreview(ch.id)

  await chat(prompt, bodySystemPrompt.value, 'body_generation', {
    workContextOptions: {
      includeVolumes: true,
      includeIncubator: false,
      excludeCoreTypes: ['worldview']
    },
    chapterId: ch.id,
    volumeId: ch.volume_id,
    enrichNarrativeMemory: true
  })
  if (result.value) {
    if (autoHumanize.value) {
      result.value = await applyHumanize(result.value)
    }
    await runPostGenerateChecks(result.value, false)
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
  if (!result.value.trim() || styleRewriting.value) return
  styleRewriting.value = true
  try {
    const res = await window.anovel.invoke(
      'body:styleRewrite',
      props.workId,
      result.value,
      wordTarget.value,
      selectedChapterId.value ?? undefined
    ) as {
      success: boolean
      content?: string
      error?: string
    }
    if (res.success && res.content) {
      result.value = res.content
      if (autoHumanize.value) {
        result.value = await applyHumanize(result.value)
      }
      await recheckAntiAiViolations(result.value)
    } else {
      error.value = res.error || '稿件优化失败'
    }
  } finally {
    styleRewriting.value = false
  }
}

async function recheckAntiAiViolations(content: string) {
  antiAiViolations.value = await window.anovel.invoke(
    'antiai:checkViolations',
    props.workId,
    content
  ) as AntiAiViolation[]
}

async function runPostGenerateChecks(content: string, persistAlignment: boolean) {
  await runAlignmentCheck(content, persistAlignment)
  await recheckAntiAiViolations(content)
  runningV15Checks.value = true
  try {
    const chId = selectedChapterId.value!
    const [critique, quality, worldview] = await Promise.all([
      window.anovel.invoke('critique:run', props.workId, content, chId),
      window.anovel.invoke('quality:diagnose', props.workId, chId, content),
      window.anovel.invoke('narrative:checkWorldview', props.workId, content)
    ])
    if ((critique as { success?: boolean }).success) {
      critiqueResult.value = critique as CritiqueResult
    }
    qualityResult.value = quality as QualityResult
    worldviewViolations.value = worldview as { rule: string; detail: string }[]
  } finally {
    runningV15Checks.value = false
  }
}

const applyingFixes = ref(false)
const applyingCritiqueFixes = ref(false)

async function runQualityAI() {
  if (!result.value || !selectedChapterId.value) return
  const res = await window.anovel.invoke('quality:diagnoseAI', props.workId, selectedChapterId.value, result.value) as {
    success: boolean
    report?: string
    error?: string
  }
  if (res.success) qualityAiReport.value = res.report || ''
  else alert(res.error || 'AI 诊断失败')
}

async function applyDiagnosisFixes() {
  if (!result.value || !qualityAiReport.value || applyingFixes.value) return
  applyingFixes.value = true
  try {
    const res = await window.anovel.invoke('quality:applyFixes', props.workId, result.value, qualityAiReport.value) as {
      success: boolean
      content?: string
      error?: string
    }
    if (res.success && res.content) {
      updateGeneratedContent(res.content)
      qualityAiReport.value = ''
    } else {
      alert(res.error || '修改失败')
    }
  } finally {
    applyingFixes.value = false
  }
}

async function applyCritiqueFixes() {
  if (!result.value || !critiqueResult.value || applyingCritiqueFixes.value) return
  applyingCritiqueFixes.value = true
  try {
    const res = await window.anovel.invoke('critique:applyFixes', props.workId, result.value, critiqueResult.value) as {
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

async function runAlignmentCheck(content: string, persist = true) {
  if (!content.trim() || checkingAlignment.value) return
  checkingAlignment.value = true
  try {
    alignmentReport.value = await window.anovel.invoke('alignment:checkContent', props.workId, content, {
      chapterId: selectedChapterId.value ?? undefined,
      step: 'body_generation',
      persist
    }) as AlignmentReport
  } finally {
    checkingAlignment.value = false
  }
}

async function extractNarrativeMemory(chapterId: number, content: string) {
  extractingMemory.value = true
  memoryExtractMsg.value = ''
  try {
    const extract = await window.anovel.invoke('memory:extractFromChapter', props.workId, chapterId, content) as {
      success: boolean
      planted?: number
      resolved?: number
      snapshots?: number
      error?: string
    }
    if (extract.success) {
      memoryExtractMsg.value = `叙事记忆已更新：+${extract.planted ?? 0} 伏笔 · 回收 ${extract.resolved ?? 0} · ${extract.snapshots ?? 0} 角色快照`
      if (selectedChapterId.value) await loadNarrativeMemory(selectedChapterId.value)
    } else if (extract.error) {
      memoryExtractMsg.value = `叙事记忆更新失败：${extract.error}`
    }
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
    const wordCount = result.value.replace(/\s/g, '').length
    const styleId = await window.anovel.invoke('style:getWorkStyleId', props.workId) as number | null
    await window.anovel.invoke('chapter:versionCreate', ch.id, {
      outline: ch.outline ?? undefined,
      content: ch.content ?? undefined,
      word_count: (ch.content || '').replace(/\s/g, '').length,
      style_id: styleId ?? undefined
    })
    await window.anovel.invoke('chapter:update', ch.id, {
      content: result.value,
      word_count: wordCount,
      status: 'draft'
    })
    const idx = chapters.value.findIndex(c => c.id === ch.id)
    if (idx >= 0) {
      chapters.value[idx] = { ...chapters.value[idx], content: result.value, word_count: wordCount }
    }
    unsavedContentCache.delete(ch.id)
    await nav?.refreshProgress()
    await runAlignmentCheck(result.value, true)

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

function updateGeneratedContent(content: string) {
  result.value = content
  void runPostGenerateChecks(content, false)
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
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <PanelTitle icon="pen-nib" title="正文生成" />

    <div v-if="volumes.length === 0" class="text-center py-12 text-base-content/40">
      <p>请先创建分卷和章节</p>
    </div>

    <template v-else>
      <div class="flex gap-2 mb-3 flex-wrap shrink-0">
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
        <p>本卷还没有章节，请先在「章节情节」中添加</p>
      </div>

      <div
        v-else
        class="flex-1 grid grid-cols-1 xl:grid-cols-[minmax(240px,280px)_1fr] gap-3 min-h-[calc(100vh-14rem)]"
      >
        <div class="card bg-base-200 border border-base-300 shadow-sm p-3 flex flex-col min-h-0 max-h-[70vh] xl:max-h-none">
          <div class="flex items-center justify-between gap-2 mb-2 shrink-0">
            <h4 class="font-semibold text-sm">章节</h4>
            <span class="text-xs text-base-content/40">{{ chapters.length }} 章</span>
          </div>
          <div class="flex-1 overflow-y-auto space-y-1 min-h-0 -mx-1 px-1 mb-3">
            <button
              v-for="ch in chapters"
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
        </div>

        <div class="card bg-base-200 border border-base-300 shadow-sm p-4 min-w-0 flex flex-col min-h-0">
          <template v-if="selectedChapter">
            <div class="flex flex-wrap items-center gap-2 mb-3 shrink-0">
              <h4 class="font-semibold text-base min-w-0 truncate flex-1">{{ selectedChapter.title }}</h4>
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
              <label class="flex items-center gap-1 text-xs cursor-pointer" title="生成后自动进行词级人性化处理，降低AI检测率">
                <input v-model="autoHumanize" type="checkbox" class="checkbox checkbox-xs checkbox-primary" />
                <span class="text-base-content/60">自动去AI</span>
              </label>
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
                title="用文风范文对初稿进行风格重写，大幅降低AI检测率（需额外一次模型调用）"
                @click="styleRewrite"
              >
                <font-awesome-icon :icon="styleRewriting ? 'spinner' : 'pen-nib'" :spin="styleRewriting" class="w-3 h-3" />
                {{ styleRewriting ? '优化中...' : '稿件优化' }}
              </button>
              <button class="btn btn-ghost btn-xs" @click="runQualityAI">AI 诊断</button>
              <button
                v-if="qualityAiReport"
                class="btn btn-warning btn-xs gap-1"
                :disabled="applyingFixes || loading"
                @click="applyDiagnosisFixes"
              >
                <font-awesome-icon :icon="applyingFixes ? 'spinner' : 'wrench'" :spin="applyingFixes" class="w-3 h-3" />
                {{ applyingFixes ? '修改中...' : '按建议修改' }}
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
                @polished="updateGeneratedContent"
                @rules-added="onAntiAiRulesAdded"
              />
            </div>

            <details
              v-if="result.trim() || critiqueResult || qualityResult || alignmentReport || crossChapterIssues.length"
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
                <p v-if="runningV15Checks" class="text-xs text-base-content/40">批判通道与质量诊断运行中...</p>
                <ChapterCritiqueReport
                  :result="critiqueResult"
                  :applying="applyingCritiqueFixes"
                  @apply-fixes="applyCritiqueFixes"
                />
                <ChapterQualityReport :result="qualityResult" :ai-report="qualityAiReport" :block-hints="blockHints" />
                <div v-if="worldviewViolations.length" class="space-y-1">
                  <p class="text-xs font-medium text-warning">世界观校验</p>
                  <p v-for="(v, i) in worldviewViolations" :key="i" class="text-xs text-warning">{{ v.detail }}</p>
                </div>
                <AnchorAlignmentReport :report="alignmentReport" />
                <p v-if="checkingAlignment" class="text-xs text-base-content/40">锚点对齐检测中...</p>
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
</template>
