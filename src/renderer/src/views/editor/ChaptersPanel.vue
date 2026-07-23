<script setup lang="ts">
import { ref, onMounted, onActivated, watch, inject, computed } from 'vue'
import { useBodyGenerationModel } from '../../composables/useBodyGenerationModel'
import { useModelChat } from './useModelChat'
import PanelTitle from '../../components/PanelTitle.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import FavoriteButton from '../../components/FavoriteButton.vue'
import AiInterventionBar from './AiInterventionBar.vue'
import AiSelfCheckPanel from './AiSelfCheckPanel.vue'
import StepNavFooter from './StepNavFooter.vue'
import ChapterPlanPanel from './ChapterPlanPanel.vue'
import { editorNavKey } from './editor-nav'
import { type WritingPlanStatus, volumePlanLabel, DEFAULT_WORDS_PER_CHAPTER } from './chapter-plan-ui'
import { getPanelPage, setPanelPage } from '../../services/editorPanelPageState'
import { outlineConstraintsForWordTarget } from '../../../../shared/outline-constraints'
import { workUnitLabels } from '../../../../shared/work-terminology'
import { goldenOutlineContract } from '../../../../shared/golden-opening'

const props = defineProps<{ workId: number }>()
const { modelParams: bodyModelParams } = useBodyGenerationModel(() => props.workId)
const nav = inject(editorNavKey)

interface Chapter {
  id: number
  volume_id: number
  title: string
  outline: string | null
  content: string | null
  word_count: number
  sort: number
  status: string
  emotion_intensity: number | null
  beat_role: string | null
  foreshadow_target: string | null
  next_hook: string | null
  pov_mode: string | null
  characters: string | null
  outline_diagnosis: string | null
}

interface ParsedChapter {
  title: string
  outline: string
  beat_role?: string | null
  foreshadow_target?: string | null
  next_hook?: string | null
  pov_mode?: string | null
  characters?: string | null
}

interface OutlineDiagnosisIssue {
  chapter_id: number
  severity?: string
  type?: string
  evidence?: string
  problem?: string
  fix_reason?: string
}

interface OutlineDiagnosisPatch {
  chapter_id: number
  outline?: string
  beat_role?: string | null
  foreshadow_target?: string | null
  next_hook?: string | null
  pov_mode?: string | null
  characters?: string | null
}

interface ContractRow {
  label: string
  value: string
}

interface ChapterPlanningDetails {
  chapterNumber: number
  volumeName: string
  executionContract: {
    openingState: string
    requiredEvents: string[]
    forbiddenEvents: string[]
    endingState: string
    abilityConstraints: string
    continuityConstraints: string
    warnings: string[]
    errors: string[]
  } | null
  structureContract: Record<string, unknown> | null
  emotionContract: Record<string, unknown> | null
  emotionAssessment: Record<string, unknown> | null
  qualityAssessment: Record<string, unknown> | null
  resourceBudgets: Array<{
    id: number
    owner?: string | null
    resource: string
    unit?: string | null
    start_min?: number | null
    start_max?: number | null
    end_min?: number | null
    end_max?: number | null
    allowed_events?: string | null
    forbidden_events?: string | null
    reason?: string | null
  }>
  gate: {
    status: 'not_run' | 'queued' | 'running' | 'repairing' | 'passed' | 'deferred' | 'stalled'
    volume: string
    score?: number
    rounds?: number
    reason?: string
    completedAt?: string
    summary?: string
    historicalScoreMissing?: boolean
    issues: Array<{
      code: string
      problem: string
      requiredFix: string
      repairChapterNumbers: number[]
      appliesToChapter: boolean
    }>
  }
  warnings: string[]
}

const volumes = ref<{ id: number; name: string; description?: string | null }[]>([])
const chapters = ref<Chapter[]>([])
const selectedVolume = ref<number | null>(null)
const newChapterTitle = ref('')
const addingChapter = ref(false)
const editingChapterId = ref<number | null>(null)
const chapterContent = ref('')
const chapterOutline = ref('')
const chapterEmotion = ref(5)
const chapterBeatRole = ref<string>('')
const chapterForeshadow = ref('')
const chapterNextHook = ref('')
const chapterPovMode = ref<string>('')
const chapterCharacters = ref('')
const aiChapterId = ref<number | null>(null)
const batchSelectMode = ref(false)
const batchSelectedIds = ref<Set<number>>(new Set())
const batchClearingBodies = ref(false)
const lastAiContext = ref('')
const planningDetails = ref<ChapterPlanningDetails | null>(null)
const planningDetailsLoading = ref(false)
let planningDetailsRequest = 0

const batchChapterCount = ref(5)
const chapterBaseOffset = ref(0)
const batchLoading = ref(false)
const batchResult = ref('')
const parsedChapters = ref<ParsedChapter[]>([])
const batchParseHint = ref('')
const applyingChapters = ref(false)
const chapterVersions = ref<{ id: number; version_number: number; content: string | null; outline: string | null; create_time: string }[]>([])
const loadingVersions = ref(false)
const planPanelRef = ref<{ reload: () => Promise<void> } | null>(null)
const planStatus = ref<WritingPlanStatus | null>(null)
const selectedChapterId = ref<number | null>(null)
const storyBeatProgress = computed(() => {
  if (workType.value !== 'story' || !planStatus.value) return null
  const target = planStatus.value.suggestedTotalChapters
  const completed = planStatus.value.actualTotalChapters
  const remaining = Math.max(0, target - completed)
  return { target, completed, remaining }
})

const currentPage = ref(1)
const pageSize = 10

function saveCurrentPage() {
  setPanelPage('chapters', props.workId, selectedVolume.value, currentPage.value)
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

watch(selectedChapterId, () => {
  if (selectedChapterId.value) {
    const idx = chapters.value.findIndex(c => c.id === selectedChapterId.value)
    if (idx !== -1) {
      currentPage.value = Math.floor(idx / pageSize) + 1
    }
    void loadChapterVersions(selectedChapterId.value)
    void loadPlanningDetails(selectedChapterId.value)
  } else {
    chapterVersions.value = []
    planningDetails.value = null
  }
}, { immediate: true })

const { loading, result, error, chat, clearResult } = useModelChat(() => props.workId)

const batchSystemPrompt = computed(() => {
  const startNum = chapterBaseOffset.value + chapters.value.length + 1
  const wpc = planStatus.value?.plan.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER
  const oc = outlineConstraintsForWordTarget(wpc)
  
  if (workType.value === 'story') {
    return [
      '这是一篇一镜到底的短故事。请根据短故事的主线规划，将其拆解为连续的情节节拍（Beats），每个节拍负责推进一段核心剧情。',
      '【极度紧凑与高潮迭起约束 - 硬要求】',
      '短故事要求剧情极度紧凑，节奏极快。禁止安排任何平淡的“过渡节拍”或“日常水文”。',
      '每个节拍都必须有核心矛盾冲突或情绪爆发，爽点或反转必须一个接一个密集抛出。',
      goldenOutlineContract('story', startNum, startNum + batchChapterCount.value - 1),
      '【输出格式 - 必须严格遵守】',
      '只输出一个 JSON 对象；禁止 Markdown 标题、前置说明、思考过程，以及 ``` 代码块围栏。',
      'chapters 数组每一项为一个节拍（请勿输出“第X章”或“节拍X”字样，直接写节拍剧情标题即可）。',
      `每拍字段：title、entry_state、must_cover（${oc.pointsMin}-${oc.pointsMax} 条必须覆盖事件数组）、must_not（禁止提前写/越界内容数组）、ending_state、continuity_constraints、plot_points（可选，补充情节节点数组）、beat_role、foreshadow_target、next_hook、characters（本拍出场角色名数组）；如有能力/状态约束，可加 state_constraints。`,
      'beat_role: A(爽点释放)/B(进行中)/C(铺垫)/transition(过渡)',
      'foreshadow_target: 铺垫的下一节点；next_hook: 结尾悬念（仅写在 JSON 字段内，不要单独成拍）。',
      'characters: 从人设卡片或核心设定中选取本节拍实际出场角色。',
      'entry_state 写清本拍开始时人物位置、关系、伤势/资源/情绪等承接状态；ending_state 写清本拍必须停住的位置，禁止把下一拍事件写完。',
      'must_cover 是正文生成验收清单，必须具体到事件、冲突、转折、结果；must_not 写本拍禁止提前兑现的后续情节、禁止新增的支线或禁止改变的状态。',
      '若作品存在需连续追踪的能力/状态机制（如疲惫程度、污染不适、使用间隔、能力阶段、伤势、资源压力、声望处境等），每拍必须在 must_cover 或 state_constraints 中写清消耗、恢复、冷却/间隔、解锁或状态变化；无相关机制则跳过。',
      '若核心设定明确要求无数值表达，state_constraints 禁止输出百分比、固定数值、进度条、固定冷却时间或精确次数，只能用体感、场景边界和阶段性描述。',
      `【长度】每项 must_cover / plot_points 合计 ${oc.charsMin}-${oc.charsMax} 字梗概（每节拍目标 ${wpc} 字正文），禁止正文级长文。`,
      `格式：{"chapters":[{"title":"节拍剧情标题","entry_state":"承接上一拍的状态","must_cover":["必须事件1","必须事件2","必须事件3"],"must_not":["不得提前写下一拍反转"],"ending_state":"停在新危机揭露但未解决","continuity_constraints":"紧接上一拍结尾，不复述旧场景","beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"],"state_constraints":"回收后主角明显乏力，污染刺痒感短暂加重，但仍能勉强行动"}]}`
    ].join('\n')
  }

  return [
    '根据当前分卷信息与作品创作上下文，生成该卷下的章节大纲。',
    goldenOutlineContract('novel', startNum, startNum + batchChapterCount.value - 1),
    '【输出格式 - 必须严格遵守】',
    '只输出一个 JSON 对象；禁止 Markdown 章节标题、前置说明、思考过程，以及 ``` 代码块围栏。',
    'chapters 数组每一项为一章；不要把「卷X章节大纲」「分章情节」「章节结尾钩子」等文档标题当作 title。',
    `每章字段：title、entry_state、must_cover（${oc.pointsMin}-${oc.pointsMax} 条必须覆盖事件数组）、must_not（禁止提前写/越界内容数组）、ending_state、continuity_constraints、plot_points（可选，补充情节节点数组）、beat_role、foreshadow_target、next_hook、characters（本章出场角色名数组）；如有能力/状态约束，可加 state_constraints。`,
    'beat_role: A(爽点释放)/B(进行中)/C(铺垫)/transition(过渡)',
    'foreshadow_target: 本章铺垫的下一节点；next_hook: 章末钩子（仅写在 JSON 字段内，不要单独成章）。',
    'characters: 从人设卡片或核心设定中选取本章实际出场角色。',
    'entry_state 写清本章开始时人物位置、关系、伤势/资源/情绪等承接状态；ending_state 写清本章必须停住的位置，禁止把下一章事件写完。',
    'must_cover 是正文生成验收清单，必须具体到事件、冲突、转折、结果；must_not 写本章禁止提前兑现的后续情节、禁止新增的支线或禁止改变的状态。',
    '若作品存在需连续追踪的能力/状态机制（如疲惫程度、污染不适、使用间隔、能力阶段、伤势、资源压力、声望处境等），每章必须在 must_cover 或 state_constraints 中写清消耗、恢复、冷却/间隔、解锁或状态变化；无相关机制则跳过。',
    '若核心设定明确要求无数值表达，state_constraints 禁止输出百分比、固定数值、进度条、固定冷却时间或精确次数，只能用体感、场景边界和阶段性描述。',
    `【长度】每章 must_cover / plot_points 合计 ${oc.charsMin}-${oc.charsMax} 字梗概（每章目标 ${wpc} 字正文），禁止正文级长文。`,
    `【章节编号】title 中的章节序号必须从第 ${startNum} 章开始，依次递增。`,
    `格式：{"chapters":[{"title":"第${startNum}章 标题","entry_state":"承接上一章的状态","must_cover":["必须事件1","必须事件2","必须事件3"],"must_not":["不得提前写下一章反转"],"ending_state":"停在新危机揭露但未解决","continuity_constraints":"紧接上一章结尾，不复述旧场景","beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"],"state_constraints":"回收后主角明显乏力，污染刺痒感短暂加重，但仍能勉强行动"}]}`
  ].join('\n')
})

function outlineCharCount(outline: string | null | undefined): number {
  return (outline ?? '').replace(/\s/g, '').length
}

function formatOutlineForDisplay(outline: string | null | undefined): string {
  const text = outline?.trim()
  if (!text) return ''
  const sectionLabels = [
    '开场状态',
    '必须覆盖',
    '禁止越界',
    '结尾落点',
    '连续性约束',
    '能力/状态约束',
    '情节节点',
    '章末钩子',
    '戏剧契约'
  ]
  let formatted = text
  for (const label of sectionLabels) {
    formatted = formatted
      .replaceAll(`${label}：`, `【${label}】`)
      .replaceAll(`${label}:`, `【${label}】`)
  }
  return formatted.replace(/\s*(【[^】\r\n]+】)\s*/g, '\n$1\n').trim()
}

function outlineLengthLabel(ch: Chapter): string {
  const n = outlineCharCount(ch.outline)
  if (!n) return ''
  const warnThreshold = outlineConstraintsForWordTarget(
    planStatus.value?.plan.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER
  ).charsWarn
  return n > warnThreshold ? `大纲 ${n} 字（偏长）` : `大纲 ${n} 字`
}

function extractStateConstraintLines(outline: string | null | undefined): string[] {
  const text = outline?.trim()
  if (!text) return []
  const seen = new Set<string>()
  const lines = text
    .split('\n')
    .map(line => line.trim())
    .filter(line =>
      line &&
      /^(?:[-*]\s*)?(?:【(?:能力\/状态约束|金手指数值|金手指状态|数值状态)】|(?:state_constraints|ability_state_constraints|golden_finger_state|numeric_state)\s*[：:])/.test(line)
    )
  return lines.filter(line => {
    const key = line.replace(/\s+/g, '')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function dedupeOutlineLines(outline: string): string {
  const seen = new Set<string>()
  const result: string[] = []
  for (const line of outline.trim().split('\n')) {
    const trimmed = line.trim()
    const key = trimmed.replace(/\s+/g, '')
    if (trimmed && seen.has(key)) continue
    if (trimmed) seen.add(key)
    result.push(line)
  }
  return result.join('\n').trim()
}

function preserveNumericConstraints(currentOutline: string | null | undefined, revisedOutline: string): string {
  const next = dedupeOutlineLines(revisedOutline)
  const nextLines = extractStateConstraintLines(next)
  if (nextLines.length) return next

  const currentLines = extractStateConstraintLines(currentOutline)
  if (!currentLines.length) return next
  return [next, ...currentLines].filter(Boolean).join('\n')
}

function parseCharacterNames(raw: string | null | undefined): string[] {
  const text = raw?.trim()
  if (!text) return []

  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) {
        return [...new Set(
          parsed
            .filter((item): item is string => typeof item === 'string')
            .map(item => item.trim())
            .filter(Boolean)
        )]
      }
    } catch {
      // 继续兼容历史数据中的逗号分隔字符串或不完整 JSON。
    }
  }

  return [...new Set(
    text
      .split(/[,，、]/)
      .map(item => item.trim().replace(/^[\[\s"']+|[\]\s"']+$/g, ''))
      .filter(Boolean)
  )]
}

function formatCharacterNamesInput(raw: string | null | undefined): string {
  return parseCharacterNames(raw).join(', ')
}

function beatRoleLabel(role: string | null | undefined): string {
  if (!role) return ''
  const map: Record<string, string> = {
    A: 'A · 爽点释放',
    B: 'B · 进行中',
    C: 'C · 铺垫下一爽点',
    transition: '过渡缓冲'
  }
  return map[role] ?? role
}

function parsedChapterCharacterNames(ch: ParsedChapter): string[] {
  return parseCharacterNames(ch.characters)
}

const selectedVolumeInfo = ref<{ id: number; name: string; description?: string | null } | null>(null)
const workType = ref<string | null>(null)
const unitLabels = computed(() => workUnitLabels(workType.value))
const unitNoun = computed(() => unitLabels.value.full)

async function reloadVolumes() {
  volumes.value = await window.anovel.invoke('volume:list', props.workId) as never[]
  const workInfo = await window.anovel.invoke('work:get', props.workId) as { work_type?: string } | null
  workType.value = workInfo?.work_type ?? null

  if (volumes.value.length === 0) {
    if (workType.value === 'story') {
      await window.anovel.invoke('volume:create', props.workId, '正文', '短故事主线剧情')
      volumes.value = await window.anovel.invoke('volume:list', props.workId) as never[]
    } else {
      selectedVolume.value = null
      selectedVolumeInfo.value = null
      chapters.value = []
      return
    }
  }
  const stillValid = selectedVolume.value != null
    && volumes.value.some(v => v.id === selectedVolume.value)
  if (!stillValid) {
    selectedVolume.value = volumes.value[0].id
    return
  }
  selectedVolumeInfo.value = volumes.value.find(vol => vol.id === selectedVolume.value) ?? null
  await loadChapters(selectedVolume.value!)
  await refreshChapterBaseOffset()
  batchChapterCount.value = await window.anovel.invoke(
    'writingPlan:suggestBatchCount',
    props.workId,
    selectedVolume.value!
  ) as number
  await loadSavedDiagnoses()
}

async function restoreAndReloadVolumes() {
  await reloadVolumes()
  currentPage.value = getPanelPage('chapters', props.workId, selectedVolume.value)
}

onMounted(() => void restoreAndReloadVolumes())
onActivated(() => void restoreAndReloadVolumes())
watch(() => props.workId, () => void restoreAndReloadVolumes())

watch(selectedVolume, async (v) => {
  currentPage.value = v ? getPanelPage('chapters', props.workId, v) : 1
  saveCurrentPage()
  if (v) {
    selectedVolumeInfo.value = volumes.value.find(vol => vol.id === v) ?? null
    await loadChapters(v)
    await refreshChapterBaseOffset()
    batchChapterCount.value = await window.anovel.invoke(
      'writingPlan:suggestBatchCount',
      props.workId,
      v
    ) as number
    await loadSavedDiagnoses()
  }
})

function onPlanStatusChange(s: WritingPlanStatus) {
  planStatus.value = s
  if (s.plan.workType === 'story') {
    const remaining = Math.max(0, s.suggestedTotalChapters - s.actualTotalChapters)
    if (remaining > 0) {
      batchChapterCount.value = Math.min(10, remaining)
    }
  }
}

function volumePlanBadge(volumeId: number): string {
  const vol = planStatus.value?.volumes.find(v => v.id === volumeId)
  return vol ? volumePlanLabel(vol, workType.value ?? undefined) : ''
}

async function refreshPlan() {
  await planPanelRef.value?.reload()
}

watch(batchResult, async (content) => {
  batchParseHint.value = ''
  if (!content) {
    parsedChapters.value = []
    return
  }
  parsedChapters.value = await window.anovel.invoke('chapter:parseSuggestions', content) as ParsedChapter[]
  if (parsedChapters.value.length === 0) {
    const unit = unitNoun.value
    batchParseHint.value = /"chapters"\s*:|第\s*\d+\s*章/.test(content)
      ? `未能从生成结果中解析出${unit}，请确认末尾 JSON 完整，或点击「重新解析」重试`
      : `生成结果中未识别到${unit}结构，请重新生成或检查 AI 是否输出了 JSON 代码块`
    return
  }
})

async function reparseBatchResult() {
  if (!batchResult.value) return
  parsedChapters.value = await window.anovel.invoke('chapter:parseSuggestions', batchResult.value) as ParsedChapter[]
  if (parsedChapters.value.length === 0) {
    batchParseHint.value = `仍未解析到${unitNoun.value}，请检查 JSON 是否完整、未被截断`
  } else {
    batchParseHint.value = ''
  }
}

async function loadChapters(vid: number) {
  chapters.value = await window.anovel.invoke('chapter:list', vid) as never[]
  if (chapters.value.length === 0) {
    selectedChapterId.value = null
    editingChapterId.value = null
    return
  }
  if (!chapters.value.some(c => c.id === selectedChapterId.value)) {
    selectedChapterId.value = chapters.value[0].id
  } else {
    await loadPlanningDetails(selectedChapterId.value)
  }
}

async function refreshChapterBaseOffset() {
  if (!selectedVolume.value || workType.value === 'story') {
    chapterBaseOffset.value = 0
    return
  }
  const volIndex = volumes.value.findIndex(v => v.id === selectedVolume.value)
  if (volIndex <= 0) {
    chapterBaseOffset.value = 0
    return
  }
  const precedingVolumeIds = new Set(volumes.value.slice(0, volIndex).map(v => v.id))
  const allChapters = await window.anovel.invoke('chapter:listByWork', props.workId) as { volume_id: number }[]
  chapterBaseOffset.value = allChapters.filter(c => precedingVolumeIds.has(c.volume_id)).length
}

const selectedChapter = computed(() =>
  chapters.value.find(c => c.id === selectedChapterId.value) ?? null
)

const selectedChapterOutlineDisplay = computed(() =>
  formatOutlineForDisplay(selectedChapter.value?.outline)
)

const selectedChapterCharacters = computed(() =>
  parseCharacterNames(selectedChapter.value?.characters)
)

const CONTRACT_LABELS: Record<string, string> = {
  dramatic_contract: '戏剧合同',
  pattern_contract: '模式合同',
  tension_plan: '张力计划',
  scene_promise: '本章承诺',
  protagonist_want: '主角目标',
  obstacle: '具体阻力',
  stakes: '失败代价',
  info_gap: '信息差',
  pressure_escalation: '压力升级',
  turn: '关键转折',
  irreversible_change: '不可逆变化',
  payoff_or_debt: '兑现或欠债',
  next_question: '章末追问',
  conflict_type: '冲突类型',
  protagonist_method: '主角方法',
  antagonist_tactic: '对手策略',
  anticipated_opponent_adjustment: '对手后续调整',
  location_type: '场景类型',
  hook_type: '钩子类型',
  cost_type: '代价类型',
  relationship_delta: '关系变化',
  volume_objective_delta: '分卷目标推进',
  level: '张力等级',
  payoff_type: '兑现类型',
  attachment_basis: '读者依恋依据',
  trigger: '情绪触发',
  event_meaning: '事件意义',
  character_appraisal: '人物评价',
  surface_behavior: '表层行为',
  inner_conflict: '内在冲突',
  choice: '关键选择',
  cost: '选择代价',
  reader_inference: '读者推断',
  aftermath: '情绪余波',
  information_position: '信息位置',
  score: '分数',
  passed: '是否通过',
  summary: '结论',
  blockers: '阻塞项',
  warnings: '提醒'
}

function contractLabel(key: string): string {
  return CONTRACT_LABELS[key] ?? key.replaceAll('_', ' ')
}

function scalarContractValue(value: unknown): string {
  if (value == null || value === '') return ''
  if (typeof value === 'boolean') return value ? '是' : '否'
  return String(value).trim()
}

function flattenContractRows(value: unknown, prefix = ''): ContractRow[] {
  if (Array.isArray(value)) {
    const simple = value.map(scalarContractValue).filter(Boolean)
    if (simple.length === value.length) return prefix ? [{ label: prefix, value: simple.join('；') }] : []
    return value.flatMap((item, index) => flattenContractRows(item, `${prefix}${index + 1}`))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
      if (key === 'execution_contract_v3' || key === 'execution_contract_v4' || key === 'execution_acceptance_v4') return []
      const label = prefix ? `${prefix} · ${contractLabel(key)}` : contractLabel(key)
      return flattenContractRows(child, label)
    })
  }
  const text = scalarContractValue(value)
  return text && prefix ? [{ label: prefix, value: text }] : []
}

const structureContractSections = computed(() => {
  const source = planningDetails.value?.structureContract
  if (!source) return []
  return ['dramatic_contract', 'pattern_contract', 'tension_plan'].flatMap(key => {
    const value = source[key]
    const rows = flattenContractRows(value)
    return rows.length ? [{ key, title: contractLabel(key), rows }] : []
  })
})

const emotionContractRows = computed(() =>
  flattenContractRows(planningDetails.value?.emotionContract)
)

const assessmentSections = computed(() => [
  { key: 'emotion', title: '情绪验收', rows: flattenContractRows(planningDetails.value?.emotionAssessment) },
  { key: 'quality', title: '正文质量验收', rows: flattenContractRows(planningDetails.value?.qualityAssessment) }
].filter(section => section.rows.length))

function gateStatusLabel(status: ChapterPlanningDetails['gate']['status']): string {
  return {
    not_run: '未检查',
    queued: '等待检查',
    running: '检查中',
    repairing: '定点修复中',
    passed: '已通过',
    deferred: '延期放行',
    stalled: '已阻塞'
  }[status]
}

function gateBadgeClass(status: ChapterPlanningDetails['gate']['status']): string {
  if (status === 'passed') return 'badge-success'
  if (status === 'deferred' || status === 'repairing' || status === 'queued') return 'badge-warning'
  if (status === 'stalled') return 'badge-error'
  if (status === 'running') return 'badge-info'
  return 'badge-ghost'
}

function formatGateTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function budgetRange(min?: number | null, max?: number | null, unit?: string | null): string {
  if (min == null && max == null) return '未限定'
  const range = min === max ? String(min) : `${min ?? '不限'}～${max ?? '不限'}`
  return `${range}${unit ? ` ${unit}` : ''}`
}

async function loadPlanningDetails(chapterId: number | null) {
  const request = ++planningDetailsRequest
  if (!chapterId || workType.value === 'story') {
    planningDetails.value = null
    planningDetailsLoading.value = false
    return
  }
  planningDetailsLoading.value = true
  try {
    const result = await window.anovel.invoke(
      'chapter:getPlanningDetails', props.workId, chapterId
    ) as ChapterPlanningDetails
    if (request === planningDetailsRequest) planningDetails.value = result
  } finally {
    if (request === planningDetailsRequest) planningDetailsLoading.value = false
  }
}

function selectChapter(ch: Chapter) {
  selectedChapterId.value = ch.id
  if (editingChapterId.value !== ch.id) {
    editingChapterId.value = null
  }
}

async function addChapter() {
  if (!newChapterTitle.value.trim() || !selectedVolume.value) return
  addingChapter.value = true
  await window.anovel.invoke('chapter:create', selectedVolume.value, newChapterTitle.value.trim())
  newChapterTitle.value = ''
  await loadChapters(selectedVolume.value)
  addingChapter.value = false
  await nav?.refreshProgress()
  await refreshPlan()
}

async function deleteChapter(id: number, title: string) {
  const noun = unitNoun.value
  if (!confirm(`删除${noun}「${title}」？`)) return
  await window.anovel.invoke('chapter:delete', id)
  await loadChapters(selectedVolume.value!)
  await nav?.refreshProgress()
  await refreshPlan()
}

function toggleBatchSelect() {
  batchSelectMode.value = !batchSelectMode.value
  if (!batchSelectMode.value) batchSelectedIds.value = new Set()
}

function toggleBatchItem(id: number) {
  const next = new Set(batchSelectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  batchSelectedIds.value = next
}

function selectAllChapters() {
  if (batchSelectedIds.value.size === chapters.value.length) {
    batchSelectedIds.value = new Set()
  } else {
    batchSelectedIds.value = new Set(chapters.value.map(c => c.id))
  }
}

async function batchDeleteChapters() {
  const count = batchSelectedIds.value.size
  if (count === 0) return
  const noun = unitNoun.value
  if (!confirm(`确定删除选中的 ${count} 个${noun}？此操作不可撤销。`)) return
  for (const id of batchSelectedIds.value) {
    await window.anovel.invoke('chapter:delete', id)
  }
  batchSelectedIds.value = new Set()
  batchSelectMode.value = false
  await loadChapters(selectedVolume.value!)
  await nav?.refreshProgress()
  await refreshPlan()
}

async function batchClearCurrentVolumeBodies() {
  if (!selectedVolume.value || batchClearingBodies.value) return
  const bodyCount = chapters.value.filter(chapter => Boolean(chapter.content?.trim()) || chapter.word_count > 0).length
  if (bodyCount === 0) {
    alert('当前卷没有可清空的正文。')
    return
  }
  const volumeName = selectedVolumeInfo.value?.name ?? '当前卷'
  if (!confirm(
    `确定批量清空「${volumeName}」全部 ${bodyCount} 章正文吗？\n\n`
    + '章节大纲和历史版本会保留；正文、字数、质量/情绪验收及派生记忆将被清空。'
  )) return

  batchClearingBodies.value = true
  try {
    const result = await window.anovel.invoke(
      'chapter:clearVolumeBodies', selectedVolume.value
    ) as { clearedCount: number; versionedCount: number }
    if (editingChapterId.value && chapters.value.some(chapter => chapter.id === editingChapterId.value)) {
      chapterContent.value = ''
    }
    batchSelectedIds.value = new Set()
    batchSelectMode.value = false
    await loadChapters(selectedVolume.value)
    if (selectedChapterId.value) await loadChapterVersions(selectedChapterId.value)
    await nav?.refreshProgress()
    await refreshPlan()
    alert(`已清空当前卷 ${result.clearedCount} 章正文，并保留 ${result.versionedCount} 个清空前版本。`)
  } catch (error) {
    alert(error instanceof Error ? error.message : '批量清空正文失败')
  } finally {
    batchClearingBodies.value = false
  }
}

function editChapter(ch: Chapter) {
  selectedChapterId.value = ch.id
  editingChapterId.value = ch.id
  chapterContent.value = ch.content || ''
  chapterOutline.value = ch.outline || ''
  chapterEmotion.value = ch.emotion_intensity ?? 5
  chapterBeatRole.value = ch.beat_role || ''
  chapterForeshadow.value = ch.foreshadow_target || ''
  chapterNextHook.value = ch.next_hook || ''
  chapterPovMode.value = ch.pov_mode || ''
  chapterCharacters.value = formatCharacterNamesInput(ch.characters)
  void loadChapterVersions(ch.id)
}

async function loadChapterVersions(chapterId: number) {
  loadingVersions.value = true
  try {
    chapterVersions.value = await window.anovel.invoke('chapter:versionList', chapterId) as typeof chapterVersions.value
  } finally {
    loadingVersions.value = false
  }
}

async function saveChapterVersion() {
  if (!editingChapterId.value) return
  const styleId = await window.anovel.invoke('style:getWorkStyleId', props.workId) as number | null
  await window.anovel.invoke('chapter:versionCreate', editingChapterId.value, {
    outline: chapterOutline.value || undefined,
    content: chapterContent.value || undefined,
    word_count: chapterContent.value.replace(/\s/g, '').length,
    style_id: styleId ?? undefined
  })
  await loadChapterVersions(editingChapterId.value)
}

async function restoreVersion(versionId: number) {
  const chId = editingChapterId.value || selectedChapterId.value
  const noun = unitNoun.value
  if (!chId || !confirm(`恢复此版本将覆盖当前${noun}内容，确定继续？`)) return
  await window.anovel.invoke('chapter:versionRestore', chId, versionId)
  const updated = await window.anovel.invoke('chapter:get', chId) as Chapter
  if (updated) {
    chapterContent.value = updated.content || ''
    chapterOutline.value = updated.outline || ''
  }
  await loadChapters(selectedVolume.value!)
  await loadChapterVersions(chId)
}

function updateBatchResult(content: string) {
  batchResult.value = content
}

async function saveChapter() {
  if (!editingChapterId.value) return
  await saveChapterVersion()
  await window.anovel.invoke('chapter:update', editingChapterId.value, {
    content: chapterContent.value,
    outline: chapterOutline.value || undefined,
    word_count: chapterContent.value.replace(/\s/g, '').length,
    emotion_intensity: chapterEmotion.value,
    beat_role: chapterBeatRole.value || null,
    foreshadow_target: chapterForeshadow.value.trim() || null,
    next_hook: chapterNextHook.value.trim() || null,
    pov_mode: chapterPovMode.value || null,
    characters: chapterCharacters.value.trim() || null
  })
  editingChapterId.value = null
  await loadChapters(selectedVolume.value!)
  await nav?.refreshProgress()
  await refreshPlan()
}

function buildVolumeContext(): string {
  const vol = selectedVolumeInfo.value
  if (!vol) return ''
  const existingCount = chapters.value.length
  const startNum = chapterBaseOffset.value + existingCount + 1
  const endNum = startNum + batchChapterCount.value - 1
  const localEndNum = existingCount + batchChapterCount.value
  const volPlan = planStatus.value?.volumes.find(v => v.id === vol.id)

  const lines: string[] = []

  if (workType.value === 'story') {
    lines.push(`【短故事一镜到底】当前需要将其拆解为连续的情节节拍。`)
    if (existingCount > 0) {
      const summaries = chapters.value.map(ch => {
        const brief = ch.outline
          ? ch.outline.replace(/\s+/g, '').slice(0, 60) + (ch.outline.length > 60 ? '…' : '')
          : '（无大纲）'
        return `  - ${ch.title}：${brief}`
      }).join('\n')
      lines.push(`已拆解 ${existingCount} 个节拍：\n${summaries}`)
      lines.push(`请顺着现有剧情，继续续写后续的 ${batchChapterCount.value} 个情节节拍。请注意前后情节的流畅衔接和情绪拉扯。`)
    } else {
      lines.push(`请生成最初的 ${batchChapterCount.value} 个情节节拍，确保开篇抓人。`)
    }
    return lines.filter(Boolean).join('\n\n')
  }

  lines.push(`分卷：${vol.name}`)
  if (vol.description) lines.push(`分卷说明：${vol.description}`)

  if (volPlan && volPlan.suggestedChapters > 0) {
    lines.push(`本卷规划总章节数：${volPlan.suggestedChapters} 章。`)
  }

  if (existingCount > 0) {
    const summaries = chapters.value.map(ch => {
      const brief = ch.outline
        ? ch.outline.replace(/\s+/g, '').slice(0, 60) + (ch.outline.length > 60 ? '…' : '')
        : '（无大纲）'
      return `  - ${ch.title}：${brief}`
    }).join('\n')
    lines.push(`本卷已有 ${existingCount} 章：\n${summaries}`)
    lines.push(`请从第 ${startNum} 章开始，续写 ${batchChapterCount.value} 章的情节大纲（即第 ${startNum} 章到第 ${endNum} 章）。注意与前面章节的情节衔接和递进。`)
  } else {
    lines.push(`请生成 ${batchChapterCount.value} 章的情节大纲（即第 ${startNum} 章到第 ${endNum} 章）。`)
  }

  if (volPlan && volPlan.suggestedChapters > 0) {
    if (localEndNum < volPlan.suggestedChapters) {
      lines.push(`【重要写作指令】：\n当前生成的第 ${endNum} 章并不是本卷的最后一章（本卷规划为 ${volPlan.suggestedChapters} 章，后续还有其他章节）。请保持剧情悬念与故事张力，绝对不要在该章进行卷末收尾或强行结局，以确保与后续章节的情节顺畅衔接。`)
    } else if (localEndNum === volPlan.suggestedChapters) {
      lines.push(`【重要写作指令】：\n当前生成的第 ${endNum} 章是本卷的最后一章（本卷规划为 ${volPlan.suggestedChapters} 章）。请在第 ${endNum} 章进行合理的卷末情节收尾，并为下一卷留出适当的铺垫或悬念。`)
    } else {
      lines.push(`【重要写作指令】：\n当前生成已超出本卷原规划总章节数（规划为 ${volPlan.suggestedChapters} 章）。请根据当前剧情发展合理推进，并在适当位置安排情节的收敛或向下一阶段的过渡。`)
    }
  }

  return lines.filter(Boolean).join('\n\n')
}

async function aiBatchChapters() {
  if (!selectedVolume.value || batchLoading.value) return
  const count = Math.max(1, Math.min(20, Math.floor(batchChapterCount.value) || 5))
  batchChapterCount.value = count
  batchLoading.value = true
  batchResult.value = ''
  batchParseHint.value = ''
  parsedChapters.value = []
  try {
    const res = await window.anovel.invoke('model:chat', {
      prompt: buildVolumeContext(),
      systemPrompt: batchSystemPrompt.value,
      workId: props.workId,
      step: 'volume_chapters_batch',
      volumeId: selectedVolume.value,
      workContextOptions: { includeVolumes: true },
      ...bodyModelParams()
    }) as { success: boolean; content: string; error?: string }

    if (res.success) {
      batchResult.value = res.content
    } else {
      alert(res.error || '生成失败')
    }
  } finally {
    batchLoading.value = false
  }
}

function renumberTitle(title: string, newNum: number): string {
  return title.replace(/^第\s*\d+\s*章/, `第${newNum}章`)
}

async function applyParsedChapters(mode: 'append' | 'replace') {
  if (!selectedVolume.value || parsedChapters.value.length === 0 || applyingChapters.value) return
  const noun = unitNoun.value
  if (mode === 'replace') {
    const msg = workType.value === 'story'
      ? `将替换全部 ${chapters.value.length} 个${noun}，确定继续？`
      : `将替换当前分卷下 ${chapters.value.length} 个${noun}，确定继续？`
    if (!confirm(msg)) return
  }
  applyingChapters.value = true
  try {
    const startNum = mode === 'append' ? chapterBaseOffset.value + chapters.value.length + 1 : chapterBaseOffset.value + 1
    const items = parsedChapters.value.map((c, i) => ({
      title: renumberTitle(c.title, startNum + i),
      outline: c.outline ?? '',
      beat_role: c.beat_role ?? null,
      foreshadow_target: c.foreshadow_target ?? null,
      next_hook: c.next_hook ?? null,
      pov_mode: c.pov_mode ?? null,
      characters: c.characters ?? null
    }))
    await window.anovel.invoke('chapter:batchCreate', selectedVolume.value, items, mode)
    await loadChapters(selectedVolume.value)
    await nav?.refreshProgress()
    await refreshPlan()
    batchParseHint.value = ''
    batchResult.value = ''
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (/分卷不存在|FOREIGN KEY/i.test(msg)) {
      await reloadVolumes()
      batchParseHint.value = '当前分卷已失效（可能已在「分卷大纲」中被替换），已刷新分卷列表，请重新点击追加'
    } else {
      throw e
    }
  } finally {
    applyingChapters.value = false
  }
}

async function buildContext(ch: Chapter): Promise<string> {
  const vol = volumes.value.find(v => v.id === ch.volume_id)
  return [
    `分卷：${vol?.name || ''}`,
    vol?.description ? `分卷说明：${vol.description}` : '',
    `章节：${ch.title}`,
    ch.outline ? `现有大纲：${ch.outline}` : ''
  ].filter(Boolean).join('\n\n')
}

async function aiChapterOutline(ch: Chapter) {
  aiChapterId.value = ch.id
  clearResult()
  const context = await buildContext(ch)
  lastAiContext.value = context
  const wpc = planStatus.value?.plan.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER
  const oc = outlineConstraintsForWordTarget(wpc)
  const outlineSystem = workType.value === 'story' ? [
    '为以上短故事节拍生成情节大纲（写作指令，不是正文）。',
    '短故事要求：剧情极度紧凑、节奏极快，必须包含强烈的矛盾冲突或情绪拉扯。禁止流水账式的平铺直叙。',
    `输出 entry_state、must_cover（${oc.pointsMin}-${oc.pointsMax} 条）、must_not、ending_state、continuity_constraints，作为正文生成的执行蓝图；可额外给 plot_points 补充情节节点。`,
    'must_cover 必须具体到出场人物、关键冲突、转折、极限悬念钩子；must_not 必须写清不得提前兑现的后续情节。',
    `全文 ${oc.charsMin}-${oc.charsMax} 字（本节拍目标 ${wpc} 字正文），禁止写完整对话、场景描写或心理独白。`,
    '若作品存在需连续追踪的能力/状态机制（如疲惫程度、污染不适、使用间隔、能力阶段、伤势、资源压力、声望处境等），must_cover 或末尾 JSON 必须写清本节拍消耗、恢复、冷却/间隔、解锁或状态变化；无相关机制则跳过。',
    '若核心设定明确要求无数值表达，state_constraints 禁止输出百分比、固定数值、进度条、固定冷却时间或精确次数，只能用体感、场景边界和阶段性描述。',
    '标注 beat_role(A/B/C/transition)、foreshadow_target、next_hook、characters（本章出场角色名数组）、state_constraints（有能力/状态约束时填写），放在末尾 JSON 代码块。',
    '末尾附 JSON：{"entry_state":"承接状态","must_cover":["必须事件1","必须事件2"],"must_not":["不得提前写后续反转"],"ending_state":"停在未解决危机","continuity_constraints":"紧接上一拍结尾","beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"],"state_constraints":"回收后主角明显乏力，污染刺痒感短暂加重，但仍能勉强行动"}'
  ].join('\n') : [
    '为以上章节生成情节大纲（写作指令，不是正文）。',
    `输出 entry_state、must_cover（${oc.pointsMin}-${oc.pointsMax} 条）、must_not、ending_state、continuity_constraints，作为正文生成的执行蓝图；可额外给 plot_points 补充情节节点。`,
    'must_cover 必须具体到出场人物、关键冲突、转折、章末钩子；must_not 必须写清不得提前兑现的后续章节内容。',
    `全文 ${oc.charsMin}-${oc.charsMax} 字（本章目标 ${wpc} 字正文），禁止写完整对话、场景描写或心理独白。`,
    '若作品存在需连续追踪的能力/状态机制（如疲惫程度、污染不适、使用间隔、能力阶段、伤势、资源压力、声望处境等），must_cover 或末尾 JSON 必须写清本章消耗、恢复、冷却/间隔、解锁或状态变化；无相关机制则跳过。',
    '若核心设定明确要求无数值表达，state_constraints 禁止输出百分比、固定数值、进度条、固定冷却时间或精确次数，只能用体感、场景边界和阶段性描述。',
    '标注 beat_role(A/B/C/transition)、foreshadow_target、next_hook、characters（本章出场角色名数组）、state_constraints（有能力/状态约束时填写），放在末尾 JSON 代码块。',
    '末尾附 JSON：{"entry_state":"承接状态","must_cover":["必须事件1","必须事件2"],"must_not":["不得提前写后续反转"],"ending_state":"停在未解决危机","continuity_constraints":"紧接上一章结尾","beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"],"state_constraints":"回收后主角明显乏力，污染刺痒感短暂加重，但仍能勉强行动"}'
  ].join('\n')
  const res = await chat(context, outlineSystem, 'chapter_outline', {
    chapterId: ch.id,
    volumeId: ch.volume_id
  })
  if (res.success) {
    const cleanedOutline = await window.anovel.invoke('chapter:stripOutline', res.content) as string
    editingChapterId.value = ch.id
    chapterOutline.value = cleanedOutline
    chapterContent.value = ch.content || ''
    const abc = await window.anovel.invoke('chapter:parseAbc', res.content) as {
      beat_role?: string | null
      foreshadow_target?: string | null
      next_hook?: string | null
      characters?: string | null
    }
    if (abc.beat_role) chapterBeatRole.value = abc.beat_role
    if (abc.foreshadow_target) chapterForeshadow.value = abc.foreshadow_target
    if (abc.next_hook) chapterNextHook.value = abc.next_hook
    await window.anovel.invoke('chapter:update', ch.id, {
      outline: cleanedOutline,
      beat_role: abc.beat_role ?? null,
      foreshadow_target: abc.foreshadow_target ?? null,
      next_hook: abc.next_hook ?? null,
      characters: abc.characters ?? null
    })
    await loadChapters(selectedVolume.value!)
    await nav?.refreshProgress()
    await refreshPlan()
  }
  aiChapterId.value = null
}

const diagnosisLoading = ref(false)
const applyingAiFixId = ref(false)
const autoDiagnosisFixLoading = ref(false)
const diagnosisScope = ref<'volume' | 'cross' | 'all'>('volume')
const savedDiagnoses = ref<Record<string, string>>({})
const AUTO_DIAGNOSIS_FIX_MAX_ROUNDS = 8

const currentDiagnosisKey = computed(() => {
  if (diagnosisScope.value === 'volume') return `diagnosis_vol_${selectedVolume.value}`
  if (diagnosisScope.value === 'cross') return `diagnosis_cross_${selectedVolume.value}`
  return 'diagnosis_book'
})

const activeDiagnosisText = computed(() => {
  return savedDiagnoses.value[currentDiagnosisKey.value] || ''
})

function sanitizeJsonString(str: string): string {
  let inString = false
  let escaped = false
  let result = ''
  for (let i = 0; i < str.length; i++) {
    const char = str[i]
    if (inString) {
      if (escaped) {
        result += char
        escaped = false
      } else if (char === '\\') {
        result += char
        escaped = true
      } else if (char === '"') {
        result += char
        inString = false
      } else if (char === '\n') {
        result += '\\n'
      } else if (char === '\r') {
        result += '\\r'
      } else if (char === '\t') {
        result += '\\t'
      } else {
        result += char
      }
    } else {
      if (char === '"') {
        inString = true
      }
      result += char
    }
  }
  return result
}

function chapterLabel(chapterId: number): string {
  const ch = chapters.value.find(c => c.id === chapterId)
  return ch ? `${ch.title} (#${ch.id})` : `#${chapterId}`
}

function parseDiagnosisResult(raw: string) {
  let text = raw.trim()
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (match) {
    text = match[1].trim()
  } else {
    const firstBrace = text.indexOf('{')
    const lastBrace = text.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      text = text.substring(firstBrace, lastBrace + 1)
    }
  }

  text = sanitizeJsonString(text)

  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'revised_chapters' in parsed) {
      const issues = Array.isArray(parsed.issues) ? parsed.issues as OutlineDiagnosisIssue[] : []
      const revisedChapters = Array.isArray(parsed.revised_chapters) ? parsed.revised_chapters as OutlineDiagnosisPatch[] : []
      let reportStr = parsed.report ? String(parsed.report) : ''
      if (!reportStr) {
        const summary = parsed.summary ? String(parsed.summary) : '大纲诊断结果'
        reportStr = `### ${summary}\n\n`
        if (issues.length > 0) {
          reportStr += '#### 诊断问题\n\n'
          issues.forEach((issue, idx) => {
            reportStr += `${idx + 1}. **${chapterLabel(Number(issue.chapter_id))}**`
            if (issue.severity) reportStr += ` · ${issue.severity}`
            if (issue.type) reportStr += ` · ${issue.type}`
            reportStr += '\n'
            if (issue.evidence) reportStr += `   - 证据：${issue.evidence}\n`
            if (issue.problem) reportStr += `   - 问题：${issue.problem}\n`
            if (issue.fix_reason) reportStr += `   - 修复理由：${issue.fix_reason}\n`
          })
          reportStr += '\n'
        }
        if (revisedChapters.length > 0) {
          reportStr += '#### 大纲修订补丁预览\n\n请点击右上角 **“应用 AI 修复”** 将以下修改应用到对应章节。\n\n'
          revisedChapters.forEach(ch => {
            reportStr += `##### ${chapterLabel(Number(ch.chapter_id))}\n`
            if (ch.outline) reportStr += `**优化后大纲：**\n${ch.outline}\n\n`
            if (ch.beat_role) reportStr += `- **节拍角色：** ${ch.beat_role}\n`
            if (ch.foreshadow_target) reportStr += `- **铺垫目标：** ${ch.foreshadow_target}\n`
            if (ch.next_hook) reportStr += `- **章末钩子：** ${ch.next_hook}\n`
            if (ch.pov_mode) reportStr += `- **视角模式：** ${ch.pov_mode}\n`
            if (ch.characters) reportStr += `- **出场角色：** ${ch.characters}\n`
            reportStr += '\n---\n\n'
          })
        }
      }

      return {
        report: reportStr,
        issues,
        revised_chapters: revisedChapters.length > 0 ? revisedChapters : null
      }
    }
  } catch (e) {
    console.error('Failed to parse diagnosis JSON:', e)
  }
  return {
    report: raw,
    issues: [],
    revised_chapters: null
  }
}

const parsedDiagnosisResult = computed(() => {
  const raw = activeDiagnosisText.value
  if (!raw) return null
  return parseDiagnosisResult(raw)
})

async function loadSavedDiagnoses() {
  const settings = await window.anovel.invoke('setting:listByWork', props.workId) as { type: string; content: string }[]
  const diagnoses: Record<string, string> = {}
  for (const s of settings) {
    if (s.type.startsWith('diagnosis_')) {
      diagnoses[s.type] = s.content
    }
  }
  savedDiagnoses.value = diagnoses
}

async function runOutlineDiagnosis(options: { silent?: boolean } = {}) {
  if (!selectedVolume.value || diagnosisLoading.value) return null
  diagnosisLoading.value = true
  clearResult()
  
  try {
    let promptContext = ''
    if (diagnosisScope.value === 'volume') {
      const vol = volumes.value.find(v => v.id === selectedVolume.value)
      const chaptersText = chapters.value.map(c => [
        `- chapter_id: ${c.id}`,
        `  title: ${c.title}`,
        `  beat_role: ${c.beat_role || ''}`,
        `  foreshadow_target: ${c.foreshadow_target || ''}`,
        `  next_hook: ${c.next_hook || ''}`,
        `  characters: ${c.characters || ''}`,
        `  outline: ${c.outline || '（暂无大纲）'}`
      ].join('\n')).join('\n\n')
      promptContext = [
        `当前分卷：${vol?.name || ''}`,
        vol?.description ? `分卷说明：${vol.description}` : '',
        `【当前分卷章节大纲列表】\n${chaptersText}`
      ].filter(Boolean).join('\n\n')
    } else if (diagnosisScope.value === 'cross') {
      const vol = volumes.value.find(v => v.id === selectedVolume.value)
      const allChapters = await window.anovel.invoke('chapter:listByWork', props.workId) as (Chapter & { volume_name: string; volume_id: number })[]
      
      const idx = volumes.value.findIndex(v => v.id === selectedVolume.value)
      const targetVolumeIds = new Set<number>()
      if (idx !== -1) {
        targetVolumeIds.add(selectedVolume.value!)
        if (idx > 0) targetVolumeIds.add(volumes.value[idx - 1].id)
        if (idx < volumes.value.length - 1) targetVolumeIds.add(volumes.value[idx + 1].id)
      }
      
      let currentVolName = ''
      const chaptersText = allChapters
        .filter(c => targetVolumeIds.has(c.volume_id))
        .map(c => {
          let header = ''
          if (c.volume_name !== currentVolName) {
            currentVolName = c.volume_name
            header = `\n### 分卷：${currentVolName}\n`
          }
          return [
            header,
            `- chapter_id: ${c.id}`,
            `  title: ${c.title}`,
            `  volume: ${c.volume_name}`,
            `  beat_role: ${c.beat_role || ''}`,
            `  foreshadow_target: ${c.foreshadow_target || ''}`,
            `  next_hook: ${c.next_hook || ''}`,
            `  characters: ${c.characters || ''}`,
            `  outline: ${c.outline || '（暂无大纲）'}`
          ].filter(Boolean).join('\n')
        }).join('\n')
        
      promptContext = [
        `当前选中分卷：${vol?.name || ''}`,
        `【跨卷章节大纲列表（含相邻卷）】\n${chaptersText}`
      ].filter(Boolean).join('\n\n')
    } else {
      const allChapters = await window.anovel.invoke('chapter:listByWork', props.workId) as (Chapter & { volume_name: string })[]
      let currentVolName = ''
      const chaptersText = allChapters.map(c => {
        let header = ''
        if (c.volume_name !== currentVolName) {
          currentVolName = c.volume_name
          header = `\n### 分卷：${currentVolName}\n`
        }
        return [
          header,
          `- chapter_id: ${c.id}`,
          `  title: ${c.title}`,
          `  volume: ${c.volume_name}`,
          `  beat_role: ${c.beat_role || ''}`,
          `  foreshadow_target: ${c.foreshadow_target || ''}`,
          `  next_hook: ${c.next_hook || ''}`,
          `  characters: ${c.characters || ''}`,
          `  outline: ${c.outline || '（暂无大纲）'}`
        ].filter(Boolean).join('\n')
      }).join('\n')
      
      promptContext = `【全书分卷与章节大纲列表】\n${chaptersText}`
    }

    const roleLine = workType.value === 'story'
      ? '你是番茄短故事节拍大纲门禁编辑。目标是判断是否足够进入正文生成；达标就放行，不为挑刺而挑刺。'
      : '你是网文章节大纲门禁编辑。目标是判断是否足够进入正文生成；达标就放行，不为挑刺而挑刺。'

    const systemPrompt = [
      roleLine,
      '请对输入的大纲做结构化诊断。只有存在会明显影响正文生成、读者理解、追读期待或设定连续性的实质问题时，才给出 issue 与补丁。',
      '【输出格式 - 必须严格遵守】',
      '只输出一个 JSON 对象；禁止 Markdown 标题、前置说明、思考过程，以及 ``` 代码块围栏。',
      '{',
      '  "summary": "一句话总结整体大纲状态",',
      '  "issues": [',
      '    {',
      '      "chapter_id": 123,',
      '      "severity": "high|medium|low",',
      '      "type": "logic|setting|pacing|hook|character|continuity|density|expectation|deviation|other",',
      '      "evidence": "引用或概括现有大纲中的具体证据，必须能定位问题",',
      '      "problem": "具体问题，不要泛泛而谈",',
      '      "fix_reason": "为什么这样修能提升连贯性、爽点、期待感或追读"',
      '    }',
      '  ],',
      '  "revised_chapters": [',
      '    {',
      '      "chapter_id": 123,',
      '      "outline": "修改优化后的完整章节大纲文本（直接可用，不写批注）",',
      '      "beat_role": "A|B|C|transition 或空字符串",',
      '      "foreshadow_target": "修改后的铺垫目标或空字符串",',
      '      "next_hook": "修改后的章末钩子或空字符串",',
      '      "pov_mode": "third_limited|first|omniscient 或空字符串",',
      '      "characters": "出场角色名，逗号分隔，或空字符串"',
      '    }',
      '  ]',
      '}',
      '【硬性规则】',
      '0. 默认立场是 PASS：如果大纲能支撑正文生成，且不存在明确证据指向的硬伤，必须输出 "issues": [], "revised_chapters": []。',
      '1. chapter_id 必须使用输入里给出的数据库 ID，禁止从标题推断，禁止输出不存在的 ID。',
      '2. 不支持自动合并、拆分、删除、重排章节；修复必须保持原章节数量和 chapter_id 不变。',
      '3. issues 必须先给证据，再给问题，再给修复理由；没有证据的问题不要输出。',
      '4. revised_chapters 只包含需要修复的章节；没有硬伤或收益不明确的章节不要放入。',
      '5. 补丁必须解决对应 issues，不要只做文风润色。',
      '6. 若全书/本卷无明显问题，输出空数组："issues": [], "revised_chapters": []。',
      '7. 禁止输出“可更强”“可更细”“建议增强”“略显平淡”这类精修建议；除非能证明它会导致正文无法展开、逻辑断裂、设定冲突或追读钩子断裂。',
      '8. 若原章节大纲包含「【能力/状态约束】」「数值状态」或体力/冷却/消耗/恢复/升级进度等约束，修复后的 outline 必须原样保留或等价更新，禁止因精简而删除。',
      '9. 能力/状态约束缺失只有在同时满足三项时才算问题：作品上下文/分卷说明/相邻章节已明确建立该机制；本章实际涉及使用、消耗、恢复、升级、伤势或资源变化；缺失会造成后续正文生成的连续性风险。否则不得报告。',
      '9a. 若核心设定明确要求无数值表达（如“不用算数值”“无数值”“禁止百分比/进度条”），修复后的「【能力/状态约束】」必须改为体感、场景边界和阶段性描述，禁止输出百分比、固定数值、进度条、固定冷却时间或精确次数。',
      '10. 执行蓝图完整性只在会影响正文生成时才算问题：如果章节大纲缺少「【开场状态】」「【必须覆盖】」「【禁止越界】」「【结尾落点】」「【连续性约束】」中的关键项，且会导致正文无法判断开头承接、必写事件、禁止提前写或结尾停点，才输出 issue 与补丁。',
      '11. 修复执行蓝图时，outline 必须是完整可替换文本：保留原有核心情节与约束，补齐「【开场状态】」「【必须覆盖】」「【禁止越界】」「【结尾落点】」「【连续性约束】」；不得只追加批注，不得删除已有章末钩子与能力/状态约束。',
      '【诊断维度】',
      '1. 逻辑与设定合理性：因果、时间线、能力边界、世界观规则是否自洽。',
      '2. 期待感与目标拉扯：主角目标、阻力、延迟满足、爽点承诺是否连续。',
      '3. 章末钩子与悬念：关键章节是否有反转、危机、未解谜题或强追读点。',
      '4. 人物高光与共情：角色行动是否符合人设，是否有可记忆的高光/情绪爆点。',
      '5. 情节密度与节奏：是否连续过渡、注水、重复信息，是否缺少推进。',
      '6. 连续性与跨卷衔接：伏笔、铺垫、前后卷承接是否断裂或冲突。',
      '7. 主线设定对齐：各章节情节是否与「主线设定」中的故事轨迹、关键转折点、阶段递进逻辑一致？是否存在偏离主线骨架的自由发挥或游离于主线之外的冗余支线？',
      '8. 能力/状态约束覆盖：仅当作品已明确建立需连续追踪的状态机制，且本章发生相关变化时，才检查是否写明「【能力/状态约束】」；无相关机制或本章无变化时跳过。',
      '9. 正文执行蓝图：检查是否有足够明确的开场承接、必须覆盖事件、禁止越界事项、结尾落点与连续性约束；缺失会造成正文跑偏时，自动补成可执行蓝图。'
    ].join('\n')

    const res = await chat(promptContext, systemPrompt, 'chapter_outline_diagnose', {
      volumeId: selectedVolume.value,
      workContextOptions: {
        includeIdea: true,
        includeCoreSettings: true,
        includeVolumes: true,
        includeQualityIssues: true
      }
    })
    
    if (res.success) {
      await window.anovel.invoke('setting:upsert', props.workId, currentDiagnosisKey.value, res.content)
      await loadSavedDiagnoses()
      return parseDiagnosisResult(res.content)
    }
    if (!options.silent) {
      alert('诊断失败: ' + (res.error || 'AI 未返回有效诊断结果'))
    }
  } catch (e) {
    if (!options.silent) alert('诊断失败: ' + String(e))
  } finally {
    diagnosisLoading.value = false
  }
  return null
}

async function applyAiFixes(
  revisedChapters: any[],
  options: { skipConfirm?: boolean; silent?: boolean } = {}
): Promise<{ successCount: number; skippedCount: number } | null> {
  if (!revisedChapters || revisedChapters.length === 0 || applyingAiFixId.value) return null
  const noun = unitNoun.value
  if (!options.skipConfirm && !confirm(`AI 建议修正其中的 ${revisedChapters.length} 个${noun}大纲，这会覆盖这些${noun}现有的大纲与元属性，并自动备份这些${noun}到各自的「版本历史」中。确定继续？`)) return null
  
  applyingAiFixId.value = true
  try {
    const styleId = await window.anovel.invoke('style:getWorkStyleId', props.workId) as number | null
    
    let searchChapters = chapters.value
    if (diagnosisScope.value === 'cross' || diagnosisScope.value === 'all') {
      searchChapters = await window.anovel.invoke('chapter:listByWork', props.workId) as Chapter[]
    }
    const allowedChapterIds = new Set(searchChapters.map(c => c.id))

    let successCount = 0
    let skippedCount = 0
    for (const item of revisedChapters as OutlineDiagnosisPatch[]) {
      const chId = Number(item.chapter_id)
      if (!Number.isInteger(chId) || !allowedChapterIds.has(chId)) {
        skippedCount++
        continue
      }
      
      const currentCh = await window.anovel.invoke('chapter:get', chId) as Chapter
      if (!currentCh) continue
      
      await window.anovel.invoke('chapter:versionCreate', chId, {
        outline: currentCh.outline || undefined,
        content: currentCh.content || undefined,
        word_count: currentCh.word_count,
        style_id: styleId ?? undefined
      })
      
      const fields: Record<string, any> = {}
      if (item.outline !== undefined) {
        fields.outline = preserveNumericConstraints(currentCh.outline, item.outline)
      }
      if (item.beat_role !== undefined) fields.beat_role = item.beat_role || null
      if (item.foreshadow_target !== undefined) fields.foreshadow_target = item.foreshadow_target || null
      if (item.next_hook !== undefined) fields.next_hook = item.next_hook || null
      if (item.pov_mode !== undefined) fields.pov_mode = item.pov_mode || null
      if (item.characters !== undefined) fields.characters = item.characters || null
      if (Object.keys(fields).length === 0) {
        skippedCount++
        continue
      }
      
      await window.anovel.invoke('chapter:update', chId, fields)
      
      if (selectedChapterId.value === chId && editingChapterId.value === chId) {
        chapterOutline.value = fields.outline || ''
        chapterBeatRole.value = fields.beat_role || ''
        chapterForeshadow.value = fields.foreshadow_target || ''
        chapterNextHook.value = fields.next_hook || ''
        chapterPovMode.value = fields.pov_mode || ''
        chapterCharacters.value = fields.characters || ''
      }
      successCount++
    }
    
    await loadChapters(selectedVolume.value!)
    if (selectedChapterId.value) {
      await loadChapterVersions(selectedChapterId.value)
    }
    await nav?.refreshProgress()
    await refreshPlan()
    await window.anovel.invoke('setting:upsert', props.workId, currentDiagnosisKey.value, '')
    await loadSavedDiagnoses()
    
    if (!options.silent) {
      alert(`成功应用了 ${successCount} 个${noun}的大纲修复！旧内容均已存入各自${noun}的「版本历史」。${skippedCount ? ` 跳过 ${skippedCount} 个无效补丁。` : ''}`)
    }
    return { successCount, skippedCount }
  } catch (e) {
    if (!options.silent) alert('应用修复失败: ' + String(e))
  } finally {
    applyingAiFixId.value = false
  }
  return null
}

async function runOutlineDiagnosisAndAutoFix() {
  if (!selectedVolume.value || chapters.value.length === 0 || autoDiagnosisFixLoading.value) return
  const noun = unitNoun.value
  if (!confirm(`将循环运行${unitLabels.value.outline}诊断，并把 AI 返回的所有可应用修复直接写入对应${noun}大纲。每轮修复后会重新诊断，直到没有需要修复的问题，或达到 ${AUTO_DIAGNOSIS_FIX_MAX_ROUNDS} 轮安全上限。旧内容会自动备份到版本历史。确定继续？`)) return

  autoDiagnosisFixLoading.value = true
  try {
    let totalFixed = 0
    let totalSkipped = 0

    for (let round = 1; round <= AUTO_DIAGNOSIS_FIX_MAX_ROUNDS; round++) {
      const parsed = await runOutlineDiagnosis({ silent: true })
      if (!parsed) {
        alert(`自动诊断失败：第 ${round} 轮 AI 未返回有效诊断结果。已修复 ${totalFixed} 个${noun}大纲。`)
        return
      }

      const patches = parsed.revised_chapters ?? []
      if (!patches.length) {
        if (parsed.issues.length > 0) {
          alert(`自动诊断已停止：第 ${round} 轮仍发现 ${parsed.issues.length} 个问题，但 AI 未返回可自动应用的修复补丁。已修复 ${totalFixed} 个${noun}大纲，请查看诊断结果后手动处理。`)
        } else {
          alert(`${unitLabels.value.outline}诊断通过：共运行 ${round} 轮，已修复 ${totalFixed} 个${noun}大纲。${totalSkipped ? `跳过 ${totalSkipped} 个无效补丁。` : ''}`)
        }
        return
      }

      const applied = await applyAiFixes(patches, { skipConfirm: true, silent: true })
      if (!applied) {
        alert(`自动修复失败：第 ${round} 轮未能应用 AI 返回的补丁。已修复 ${totalFixed} 个${noun}大纲。`)
        return
      }

      totalFixed += applied.successCount
      totalSkipped += applied.skippedCount
      if (applied.successCount === 0) {
        alert(`自动诊断已停止：第 ${round} 轮 AI 返回了补丁，但没有任何补丁成功应用。已跳过 ${totalSkipped} 个无效补丁，请查看诊断结果后手动处理。`)
        return
      }
    }

    alert(`自动诊断已达到 ${AUTO_DIAGNOSIS_FIX_MAX_ROUNDS} 轮安全上限：已修复 ${totalFixed} 个${noun}大纲。请再次运行诊断确认是否仍有残留问题。${totalSkipped ? `跳过 ${totalSkipped} 个无效补丁。` : ''}`)
  } finally {
    autoDiagnosisFixLoading.value = false
  }
}

async function clearDiagnosisResult() {
  if (!confirm('确定清除该范围的诊断结果吗？')) return
  await window.anovel.invoke('setting:upsert', props.workId, currentDiagnosisKey.value, '')
  await loadSavedDiagnoses()
}
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="list-ol" :title="unitLabels.outlineStep" />

    <div v-if="volumes.length === 0" class="text-center py-16 text-base-content/40">
      <font-awesome-icon icon="book" class="text-4xl mb-3 opacity-30" />
      <p>{{ workType === 'story' ? '系统准备中...' : '请先在分卷大纲中创建分卷' }}</p>
      <StepNavFooter step="chapters" :hint="workType === 'story' ? '' : '请先在「分卷大纲」中创建或应用分卷'" />
    </div>
    <template v-else>
      <ChapterPlanPanel
        ref="planPanelRef"
        :work-id="workId"
        :selected-volume-id="selectedVolume"
        @status-change="onPlanStatusChange"
      >
        <template #story-batch>
          <h4 class="font-semibold text-sm mb-2">AI 拆解情节节拍</h4>
          <p v-if="storyBeatProgress" class="text-xs text-base-content/60 mb-3">
            目标 {{ storyBeatProgress.target }} 拍 · 已拆解 {{ storyBeatProgress.completed }} 拍 · 剩余 {{ storyBeatProgress.remaining }} 拍
          </p>
          <div class="flex flex-wrap gap-2 mb-3 items-center">
            <label class="text-xs text-base-content/50">本次拆解</label>
            <input
              v-model.number="batchChapterCount"
              type="number"
              min="1"
              max="20"
              class="input input-bordered input-sm w-20 text-center"
            />
            <span class="text-xs text-base-content/50">拍</span>
            <button
              class="btn btn-outline btn-primary btn-sm gap-1"
              :disabled="batchLoading || !selectedVolume"
              @click="aiBatchChapters"
            >
              <font-awesome-icon :icon="batchLoading ? 'spinner' : 'robot'" :spin="batchLoading" class="w-3 h-3" />
              {{ batchLoading ? '拆解中...' : 'AI 拆解节拍' }}
            </button>
            <template v-if="parsedChapters.length">
              <span class="text-xs font-medium text-success">已解析 {{ parsedChapters.length }} 拍</span>
              <button
                class="btn btn-primary btn-sm"
                :disabled="applyingChapters"
                @click="applyParsedChapters('append')"
              >
                <font-awesome-icon icon="plus" class="w-3 h-3" />
                追加到节拍列表
              </button>
              <button
                class="btn btn-outline btn-sm"
                :disabled="applyingChapters"
                @click="applyParsedChapters('replace')"
              >
                替换当前节拍
              </button>
            </template>
            <template v-else-if="batchResult">
              <button type="button" class="btn btn-ghost btn-sm" @click="reparseBatchResult">
                重新解析
              </button>
            </template>
            <p v-if="batchParseHint" class="text-xs text-warning w-full">{{ batchParseHint }}</p>
          </div>
          <div v-if="batchResult" class="border border-base-300 rounded-lg p-3 bg-base-100 max-h-96 overflow-auto w-full space-y-3">
            <div v-if="parsedChapters.length" class="space-y-2">
              <p class="text-xs font-medium text-base-content/50">解析预览（将写入节拍列表）</p>
              <div
                v-for="(ch, idx) in parsedChapters"
                :key="`${ch.title}-${idx}`"
                class="text-sm bg-base-200/60 rounded-lg px-3 py-2.5 border border-base-300/60"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-semibold">{{ ch.title }}</span>
                  <span v-if="ch.beat_role" class="badge badge-outline badge-xs">{{ beatRoleLabel(ch.beat_role) }}</span>
                </div>
                <div v-if="parsedChapterCharacterNames(ch).length" class="flex flex-wrap gap-1.5 mt-2">
                  <span
                    v-for="name in parsedChapterCharacterNames(ch)"
                    :key="name"
                    class="badge badge-primary badge-xs gap-1"
                  >
                    <font-awesome-icon icon="user" class="w-2.5 h-2.5 opacity-80" />
                    {{ name }}
                  </span>
                </div>
                <p class="text-xs text-base-content/70 mt-2 whitespace-pre-wrap leading-relaxed">{{ ch.outline }}</p>
                <p v-if="ch.foreshadow_target" class="text-xs text-base-content/50 mt-2">
                  <span class="font-medium">铺垫目标：</span>{{ ch.foreshadow_target }}
                </p>
                <p v-if="ch.next_hook" class="text-xs text-base-content/50 mt-1">
                  <span class="font-medium">章末钩子：</span>{{ ch.next_hook }}
                </p>
              </div>
            </div>
            <details v-if="!parsedChapters.length" class="text-xs">
              <summary class="cursor-pointer text-base-content/50 mb-2">查看原始 AI 输出</summary>
              <MarkdownContent :content="batchResult" size="xs" />
            </details>
            <details v-else class="text-xs">
              <summary class="cursor-pointer text-base-content/50">查看原始 JSON</summary>
              <pre class="mt-2 whitespace-pre-wrap break-words text-[11px] opacity-70">{{ batchResult }}</pre>
            </details>
            <AiInterventionBar
              :work-id="workId"
              step="volume_chapters_batch"
              :content="batchResult"
              :regenerate-prompt="buildVolumeContext()"
              :regenerate-system-prompt="batchSystemPrompt"
              @update:content="updateBatchResult"
            />
            <AiSelfCheckPanel :work-id="workId" step="chapters" :content="batchResult" />
          </div>
        </template>
      </ChapterPlanPanel>

      <div v-if="workType !== 'story'" class="flex gap-2 mb-4 flex-wrap">
        <button
          v-for="vol in volumes"
          :key="vol.id"
          :class="['btn btn-sm gap-1', selectedVolume === vol.id ? 'btn-primary' : 'btn-ghost']"
          @click="selectedVolume = vol.id"
        >
          <span>{{ vol.name }}</span>
          <span
            v-if="volumePlanBadge(vol.id)"
            class="badge badge-xs"
            :class="selectedVolume === vol.id ? 'badge-primary-content/20' : 'badge-ghost'"
          >
            {{ volumePlanBadge(vol.id) }}
          </span>
        </button>
      </div>

      <div :class="['grid grid-cols-1 gap-4 mb-6', workType === 'story' ? 'lg:grid-cols-1' : 'lg:grid-cols-2']">
        <!-- AI 批量生成本卷章节大纲 -->
        <div v-if="workType !== 'story'" class="card bg-base-200 border border-base-300 shadow-sm p-4">
          <h4 class="font-semibold text-sm mb-3">AI 批量生成本卷章节大纲</h4>
          <div class="flex flex-wrap gap-2 mb-3 items-center">
            <label class="text-xs text-base-content/50">章节数</label>
            <input
              v-model.number="batchChapterCount"
              type="number"
              min="1"
              max="20"
              class="input input-bordered input-sm w-20 text-center"
            />
            <span class="text-xs text-base-content/50">章</span>
            <button
              class="btn btn-outline btn-primary btn-sm gap-1"
              :disabled="batchLoading || !selectedVolume"
              @click="aiBatchChapters"
            >
              <font-awesome-icon :icon="batchLoading ? 'spinner' : 'robot'" :spin="batchLoading" class="w-3 h-3" />
              {{ batchLoading ? '生成大纲中...' : 'AI 批量生成大纲' }}
            </button>
            <template v-if="parsedChapters.length">
              <span class="text-xs font-medium text-success">已解析 {{ parsedChapters.length }} 章</span>
              <button
                class="btn btn-primary btn-sm"
                :disabled="applyingChapters"
                @click="applyParsedChapters('append')"
              >
                <font-awesome-icon icon="plus" class="w-3 h-3" />
                追加到章节列表
              </button>
              <button
                class="btn btn-outline btn-sm"
                :disabled="applyingChapters"
                @click="applyParsedChapters('replace')"
              >
                替换本卷章节
              </button>
            </template>
            <template v-else-if="batchResult">
              <button type="button" class="btn btn-ghost btn-sm" @click="reparseBatchResult">
                重新解析
              </button>
            </template>
            <p v-if="batchParseHint" class="text-xs text-warning w-full">{{ batchParseHint }}</p>
          </div>
          <div v-if="batchResult" class="border border-base-300 rounded-lg p-3 bg-base-100 max-h-96 overflow-auto w-full space-y-3">
            <div v-if="parsedChapters.length" class="space-y-2">
              <p class="text-xs font-medium text-base-content/50">解析预览（将写入章节列表）</p>
              <div
                v-for="(ch, idx) in parsedChapters"
                :key="`${ch.title}-${idx}`"
                class="text-sm bg-base-200/60 rounded-lg px-3 py-2.5 border border-base-300/60"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-semibold">{{ ch.title }}</span>
                  <span v-if="ch.beat_role" class="badge badge-outline badge-xs">{{ beatRoleLabel(ch.beat_role) }}</span>
                </div>
                <div v-if="parsedChapterCharacterNames(ch).length" class="flex flex-wrap gap-1.5 mt-2">
                  <span
                    v-for="name in parsedChapterCharacterNames(ch)"
                    :key="name"
                    class="badge badge-primary badge-xs gap-1"
                  >
                    <font-awesome-icon icon="user" class="w-2.5 h-2.5 opacity-80" />
                    {{ name }}
                  </span>
                </div>
                <p class="text-xs text-base-content/70 mt-2 whitespace-pre-wrap leading-relaxed">{{ ch.outline }}</p>
                <p v-if="ch.foreshadow_target" class="text-xs text-base-content/50 mt-2">
                  <span class="font-medium">铺垫目标：</span>{{ ch.foreshadow_target }}
                </p>
                <p v-if="ch.next_hook" class="text-xs text-base-content/50 mt-1">
                  <span class="font-medium">章末钩子：</span>{{ ch.next_hook }}
                </p>
              </div>
            </div>
            <details v-if="!parsedChapters.length" class="text-xs">
              <summary class="cursor-pointer text-base-content/50 mb-2">查看原始 AI 输出</summary>
              <MarkdownContent :content="batchResult" size="xs" />
            </details>
            <details v-else class="text-xs">
              <summary class="cursor-pointer text-base-content/50">查看原始 JSON</summary>
              <pre class="mt-2 whitespace-pre-wrap break-words text-[11px] opacity-70">{{ batchResult }}</pre>
            </details>
            <AiInterventionBar
              :work-id="workId"
              step="volume_chapters_batch"
              :content="batchResult"
              :regenerate-prompt="buildVolumeContext()"
              :regenerate-system-prompt="batchSystemPrompt"
              @update:content="updateBatchResult"
            />
            <AiSelfCheckPanel :work-id="workId" step="chapters" :content="batchResult" />
          </div>
        </div>

        <!-- 手动大纲诊断（区别于目标循环正式门禁） -->
        <div class="card bg-base-200 border border-base-300 shadow-sm p-4 min-w-0 flex flex-col">
          <div class="flex flex-wrap items-center gap-2 mb-1">
            <h4 class="font-semibold text-sm">手动{{ unitLabels.outline }}诊断</h4>
            <span class="badge badge-ghost badge-xs">辅助检查</span>
          </div>
          <p class="text-[11px] text-base-content/45 mb-3">用于人工发起的诊断与修订，不代表目标循环的正式章节大纲门禁结果。</p>
          <div class="flex flex-wrap gap-2 mb-3 items-center">
            <label v-if="workType !== 'story'" class="text-xs text-base-content/50">诊断范围</label>
            <select v-if="workType !== 'story'" v-model="diagnosisScope" class="select select-bordered select-sm w-36">
              <option value="volume">本卷大纲</option>
              <option value="cross">跨卷大纲(邻卷)</option>
              <option value="all">全书大纲</option>
            </select>
            <button
              class="btn btn-outline btn-secondary btn-sm gap-1"
              :disabled="diagnosisLoading || autoDiagnosisFixLoading || !selectedVolume || chapters.length === 0"
              @click="runOutlineDiagnosis"
            >
              <font-awesome-icon :icon="diagnosisLoading ? 'spinner' : 'clipboard-check'" :spin="diagnosisLoading" class="w-3 h-3" />
              {{ diagnosisLoading ? '诊断中...' : '运行手动诊断' }}
            </button>
            <button
              class="btn btn-secondary btn-sm gap-1"
              :disabled="diagnosisLoading || autoDiagnosisFixLoading || applyingAiFixId || !selectedVolume || chapters.length === 0"
              @click="runOutlineDiagnosisAndAutoFix"
            >
              <font-awesome-icon :icon="autoDiagnosisFixLoading ? 'spinner' : 'wand-magic-sparkles'" :spin="autoDiagnosisFixLoading" class="w-3 h-3" />
              {{ autoDiagnosisFixLoading ? '自动处理中...' : '一键诊断并修复' }}
            </button>
            <template v-if="parsedDiagnosisResult">
              <button
                v-if="parsedDiagnosisResult.revised_chapters && parsedDiagnosisResult.revised_chapters.length > 0"
                class="btn btn-primary btn-sm gap-1"
                :disabled="applyingAiFixId || autoDiagnosisFixLoading"
                @click="applyAiFixes(parsedDiagnosisResult.revised_chapters)"
              >
                <font-awesome-icon :icon="applyingAiFixId ? 'spinner' : 'wand-magic-sparkles'" :spin="applyingAiFixId" class="w-3 h-3" />
                应用 AI 修复 ({{ parsedDiagnosisResult.revised_chapters.length }}处)
              </button>
              <button class="btn btn-ghost btn-xs text-error/70 hover:text-error" @click="clearDiagnosisResult">
                清除结果
              </button>
            </template>
          </div>
          
          <div v-if="activeDiagnosisText" class="border border-base-300 rounded-lg p-3 bg-base-100 max-h-96 overflow-auto w-full flex-1">
            <MarkdownContent :content="parsedDiagnosisResult?.report || activeDiagnosisText" size="sm" />
          </div>
          <p v-else class="text-xs text-base-content/40 py-8 text-center flex-1 flex items-center justify-center">
            {{ workType === 'story' ? '点击上方按钮运行节拍大纲诊断' : '请选择范围并点击上方按钮运行大纲诊断' }}
          </p>
        </div>
      </div>

      <div v-if="selectedVolume" class="flex gap-2 mb-6">
        <input
          v-model="newChapterTitle"
          :placeholder="`${unitLabels.full}标题`"
          class="input input-bordered flex-1"
          @keyup.enter="addChapter"
        />
        <button class="btn btn-primary" :disabled="!newChapterTitle.trim() || addingChapter" @click="addChapter">
          <font-awesome-icon v-if="addingChapter" icon="spinner" spin class="w-3.5 h-3.5 mr-1" />
          <font-awesome-icon v-else icon="plus" class="w-3.5 h-3.5 mr-1" />
          {{ addingChapter ? '添加中...' : '添加' }}
        </button>
      </div>

      <div v-if="error" class="alert alert-error text-sm mb-4">{{ error }}</div>

      <div v-if="chapters.length === 0" class="text-center py-12 text-base-content/40">
        <font-awesome-icon icon="list-ol" class="text-4xl mb-3 opacity-30" />
        <p>{{ workType === 'story' ? '还没有节拍，可手动添加或使用 AI 拆解' : '还没有章节，可手动添加或使用 AI 批量生成' }}</p>
      </div>
      <div v-else class="grid grid-cols-1 xl:grid-cols-[minmax(260px,320px)_1fr] gap-3 min-h-[480px]">
        <div class="card bg-base-200 border border-base-300 shadow-sm p-3 flex flex-col min-h-0 max-h-[70vh] xl:max-h-none">
          <div class="flex items-center justify-between gap-2 mb-2 shrink-0">
            <h4 class="font-semibold text-sm">{{ unitLabels.listTitle }}</h4>
            <div class="flex items-center gap-2">
              <span class="text-xs text-base-content/40">{{ chapters.length }} {{ unitLabels.short }}</span>
              <button
                type="button"
                class="btn btn-outline btn-xs gap-1"
                :class="batchSelectMode ? 'btn-error' : 'btn-neutral'"
                @click="toggleBatchSelect"
              >
                <font-awesome-icon icon="check-double" class="w-3 h-3" />
                {{ batchSelectMode ? '退出批量' : '批量操作' }}
              </button>
            </div>
          </div>
          <div v-if="batchSelectMode" class="flex items-center gap-2 mb-2 shrink-0">
            <button type="button" class="btn btn-ghost btn-xs" @click="selectAllChapters">
              {{ batchSelectedIds.size === chapters.length ? '取消全选' : '全选' }}
            </button>
            <button
              type="button"
              class="btn btn-warning btn-xs"
              :disabled="batchClearingBodies"
              title="清空当前卷全部正文，保留章节大纲和历史版本"
              @click="batchClearCurrentVolumeBodies"
            >
              <font-awesome-icon v-if="batchClearingBodies" icon="spinner" spin class="w-3 h-3 mr-1" />
              <font-awesome-icon v-else icon="eraser" class="w-3 h-3 mr-1" />
              {{ batchClearingBodies ? '清空中...' : '批量清空正文' }}
            </button>
            <button
              type="button"
              class="btn btn-error btn-xs"
              :disabled="batchSelectedIds.size === 0"
              @click="batchDeleteChapters"
            >
              <font-awesome-icon icon="trash" class="w-3 h-3 mr-1" />
              删除 ({{ batchSelectedIds.size }})
            </button>
          </div>
          <div class="flex-1 overflow-y-auto space-y-1 min-h-0 -mx-1 px-1">
            <button
              v-for="ch in paginatedChapters"
              :key="ch.id"
              type="button"
              class="w-full text-left rounded-lg px-3 py-2 transition-colors border flex items-start gap-2"
              :class="batchSelectMode
                ? (batchSelectedIds.has(ch.id) ? 'border-error/40 bg-error/5' : 'border-transparent hover:bg-base-100/80')
                : (selectedChapterId === ch.id ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:bg-base-100/80')"
              @click="batchSelectMode ? toggleBatchItem(ch.id) : selectChapter(ch)"
            >
              <input
                v-if="batchSelectMode"
                type="checkbox"
                class="checkbox checkbox-xs checkbox-error mt-0.5 shrink-0"
                :checked="batchSelectedIds.has(ch.id)"
                @click.stop="toggleBatchItem(ch.id)"
              />
              <div class="min-w-0 flex-1">
                <div class="font-medium text-sm truncate">{{ ch.title }}</div>
                <div class="flex flex-wrap gap-1 mt-1">
                  <span
                    v-if="outlineLengthLabel(ch)"
                    class="text-[11px]"
                    :class="outlineCharCount(ch.outline) > 800 ? 'text-warning' : 'text-base-content/40'"
                  >
                    {{ outlineLengthLabel(ch) }}
                  </span>
                  <span v-if="ch.word_count" class="text-[11px] text-base-content/40">正文 {{ ch.word_count }} 字</span>
                  <span v-if="!outlineCharCount(ch.outline) && !ch.word_count" class="text-[11px] text-base-content/30">未写</span>
                  <span v-if="ch.beat_role" class="badge badge-outline badge-xs">{{ ch.beat_role }}</span>
                  <span :class="ch.status === 'draft' ? 'badge badge-warning badge-xs' : 'badge badge-success badge-xs'">
                    {{ ch.status === 'draft' ? '草稿' : '完成' }}
                  </span>
                </div>
              </div>
            </button>
          </div>

          <!-- Pagination controls -->
          <div v-if="totalPages > 1" class="flex justify-center items-center gap-2 mt-3 pt-2 border-t border-base-300/40 shrink-0">
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
        </div>

        <div class="card bg-base-200 border border-base-300 shadow-sm p-4 min-w-0 flex flex-col">
          <template v-if="selectedChapter">
            <div class="flex items-start justify-between gap-3 mb-3 flex-wrap shrink-0">
              <h4 class="font-semibold text-base min-w-0">{{ selectedChapter.title }}</h4>
              <div class="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                <button
                  class="btn btn-outline btn-primary btn-xs gap-1"
                  :disabled="aiChapterId === selectedChapter.id || loading"
                  @click="aiChapterOutline(selectedChapter)"
                >
                  <font-awesome-icon
                    :icon="aiChapterId === selectedChapter.id ? 'spinner' : 'robot'"
                    :spin="aiChapterId === selectedChapter.id"
                    class="w-3 h-3"
                  />
                  {{ aiChapterId === selectedChapter.id ? '生成中...' : (workType === 'story' ? 'AI 生成大纲' : 'AI 生成章节大纲') }}
                </button>
                <button class="btn btn-ghost btn-xs gap-1" @click="editChapter(selectedChapter)">
                  <font-awesome-icon icon="edit" class="w-3 h-3" />
                  编辑
                </button>
                <button
                  class="btn btn-ghost btn-xs text-error gap-1"
                  @click="deleteChapter(selectedChapter.id, selectedChapter.title)"
                >
                  <font-awesome-icon icon="trash" class="w-3 h-3" />
                  删除
                </button>
              </div>
            </div>

            <div
              v-if="workType !== 'story'"
              class="mb-3 rounded-lg border border-base-300 bg-base-100/80 px-3 py-2.5 shrink-0"
            >
              <div v-if="planningDetailsLoading" class="text-xs text-base-content/40 flex items-center gap-2">
                <font-awesome-icon icon="spinner" spin class="w-3 h-3" />
                正在读取正式门禁与章节合同…
              </div>
              <template v-else-if="planningDetails">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-xs font-semibold">正式章节大纲门禁</span>
                  <span class="badge badge-sm" :class="gateBadgeClass(planningDetails.gate.status)">
                    {{ gateStatusLabel(planningDetails.gate.status) }}
                  </span>
                  <span v-if="planningDetails.gate.score != null" class="text-xs text-base-content/60">
                    {{ planningDetails.gate.score }} 分
                  </span>
                  <span v-if="planningDetails.gate.rounds != null" class="text-xs text-base-content/50">
                    第 {{ planningDetails.gate.rounds }} 轮
                  </span>
                  <span v-if="planningDetails.gate.completedAt" class="text-[11px] text-base-content/40">
                    {{ formatGateTime(planningDetails.gate.completedAt) }}
                  </span>
                </div>
                <p v-if="planningDetails.gate.historicalScoreMissing" class="text-[11px] text-base-content/45 mt-1.5">
                  这是旧版冻结记录，当时未保存分数与大纲快照；重新运行正式门禁后会补齐可追溯结果。
                </p>
                <p v-if="planningDetails.gate.reason" class="text-xs mt-1.5" :class="planningDetails.gate.status === 'stalled' ? 'text-error' : 'text-warning'">
                  {{ planningDetails.gate.reason }}
                </p>
                <p v-if="planningDetails.gate.summary" class="text-xs text-base-content/60 mt-1.5">
                  {{ planningDetails.gate.summary }}
                </p>
                <div v-if="planningDetails.gate.issues.length" class="mt-2 space-y-1.5">
                  <div
                    v-for="(issue, index) in planningDetails.gate.issues"
                    :key="`${issue.code}-${index}`"
                    class="rounded border px-2.5 py-2 text-xs"
                    :class="issue.appliesToChapter ? 'border-warning/40 bg-warning/5' : 'border-base-300/70 bg-base-200/40 opacity-70'"
                  >
                    <div class="flex flex-wrap items-center gap-1.5 font-medium">
                      <span>{{ issue.code }}</span>
                      <span v-if="issue.appliesToChapter" class="badge badge-warning badge-xs">涉及本章</span>
                      <span v-if="issue.repairChapterNumbers.length" class="text-[11px] font-normal text-base-content/45">
                        涉及第 {{ issue.repairChapterNumbers.join('、') }} 章
                      </span>
                    </div>
                    <p v-if="issue.problem" class="mt-1 text-base-content/70">{{ issue.problem }}</p>
                    <p v-if="issue.requiredFix" class="mt-1 text-base-content/50">处理要求：{{ issue.requiredFix }}</p>
                  </div>
                </div>
              </template>
            </div>

            <div v-if="editingChapterId !== selectedChapter.id" class="flex-1 min-h-0 overflow-y-auto">
              <div class="mb-3 pb-3 border-b border-base-300/60">
                <div class="text-xs font-medium text-base-content/60 mb-2">出场角色</div>
                <div v-if="selectedChapterCharacters.length" class="flex flex-wrap gap-2">
                  <span
                    v-for="name in selectedChapterCharacters"
                    :key="name"
                    class="badge badge-primary badge-sm gap-1 px-2.5 py-2 font-medium shadow-sm"
                  >
                    <font-awesome-icon icon="user" class="w-3 h-3 opacity-90" />
                    {{ name }}
                  </span>
                </div>
                <span v-else class="text-xs text-base-content/35 italic">未标注，点击「编辑」添加</span>
              </div>
              <p
                v-if="outlineCharCount(selectedChapter.outline) > 800"
                class="text-xs text-warning mb-2"
              >
                大纲约 {{ outlineCharCount(selectedChapter.outline) }} 字，偏长（建议 300-600 字）。可重新 AI 生成或手动精简。
              </p>
              <p
                v-if="selectedChapter.outline"
                class="text-sm text-base-content/70 whitespace-pre-wrap leading-relaxed"
              >
                {{ selectedChapterOutlineDisplay }}
              </p>
              <p v-else class="text-sm text-base-content/40 italic">{{ workType === 'story' ? '暂无大纲，可点击「AI 生成大纲」或「编辑」' : '暂无章节大纲，可点击「AI 生成章节大纲」或「编辑」' }}</p>

              <div v-if="workType !== 'story' && planningDetails" class="mt-4 space-y-2">
                <details v-if="planningDetails.executionContract" class="collapse collapse-arrow bg-base-100 border border-base-300/70">
                  <summary class="collapse-title min-h-0 py-3 text-sm font-semibold">章节执行合同</summary>
                  <div class="collapse-content text-xs space-y-3">
                    <div v-if="planningDetails.executionContract.openingState">
                      <div class="font-medium text-base-content/55 mb-1">开场状态</div>
                      <p class="whitespace-pre-wrap leading-relaxed">{{ planningDetails.executionContract.openingState }}</p>
                    </div>
                    <div v-if="planningDetails.executionContract.requiredEvents.length">
                      <div class="font-medium text-base-content/55 mb-1">必须覆盖</div>
                      <ol class="list-decimal pl-5 space-y-1">
                        <li v-for="(event, index) in planningDetails.executionContract.requiredEvents" :key="`required-${index}`">{{ event }}</li>
                      </ol>
                    </div>
                    <div v-if="planningDetails.executionContract.forbiddenEvents.length">
                      <div class="font-medium text-base-content/55 mb-1">禁止越界</div>
                      <ul class="list-disc pl-5 space-y-1">
                        <li v-for="(event, index) in planningDetails.executionContract.forbiddenEvents" :key="`forbidden-${index}`">{{ event }}</li>
                      </ul>
                    </div>
                    <div v-if="planningDetails.executionContract.endingState">
                      <div class="font-medium text-base-content/55 mb-1">结尾落点</div>
                      <p class="whitespace-pre-wrap leading-relaxed">{{ planningDetails.executionContract.endingState }}</p>
                    </div>
                    <div v-if="planningDetails.executionContract.continuityConstraints">
                      <div class="font-medium text-base-content/55 mb-1">连续性约束</div>
                      <p class="whitespace-pre-wrap leading-relaxed">{{ planningDetails.executionContract.continuityConstraints }}</p>
                    </div>
                    <div v-if="planningDetails.executionContract.abilityConstraints">
                      <div class="font-medium text-base-content/55 mb-1">能力/状态约束</div>
                      <p class="whitespace-pre-wrap leading-relaxed">{{ planningDetails.executionContract.abilityConstraints }}</p>
                    </div>
                    <div v-if="planningDetails.executionContract.errors.length" class="alert alert-error py-2 text-xs">
                      {{ planningDetails.executionContract.errors.join('；') }}
                    </div>
                    <div v-if="planningDetails.executionContract.warnings.length" class="alert alert-warning py-2 text-xs">
                      {{ planningDetails.executionContract.warnings.join('；') }}
                    </div>
                  </div>
                </details>

                <details
                  v-for="section in structureContractSections"
                  :key="section.key"
                  class="collapse collapse-arrow bg-base-100 border border-base-300/70"
                >
                  <summary class="collapse-title min-h-0 py-3 text-sm font-semibold">{{ section.title }}</summary>
                  <div class="collapse-content text-xs">
                    <dl class="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-x-3 gap-y-2">
                      <template v-for="row in section.rows" :key="`${section.key}-${row.label}`">
                        <dt class="font-medium text-base-content/50">{{ row.label }}</dt>
                        <dd class="whitespace-pre-wrap leading-relaxed">{{ row.value }}</dd>
                      </template>
                    </dl>
                  </div>
                </details>

                <div v-if="!structureContractSections.length" class="rounded-lg border border-base-300/70 bg-base-100 px-3 py-2.5 text-xs text-base-content/45">
                  尚未生成戏剧合同、模式合同与张力计划；正式章节大纲门禁运行前需要补齐。
                </div>

                <details class="collapse collapse-arrow bg-base-100 border border-base-300/70">
                  <summary class="collapse-title min-h-0 py-3 text-sm font-semibold">情绪合同</summary>
                  <div class="collapse-content text-xs">
                    <dl v-if="emotionContractRows.length" class="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-x-3 gap-y-2">
                      <template v-for="row in emotionContractRows" :key="`emotion-${row.label}`">
                        <dt class="font-medium text-base-content/50">{{ row.label }}</dt>
                        <dd class="whitespace-pre-wrap leading-relaxed">{{ row.value }}</dd>
                      </template>
                    </dl>
                    <p v-else class="text-base-content/45">尚未生成；正文生成前由独立情绪引擎补齐。</p>
                  </div>
                </details>

                <details class="collapse collapse-arrow bg-base-100 border border-base-300/70">
                  <summary class="collapse-title min-h-0 py-3 text-sm font-semibold">资源预算</summary>
                  <div class="collapse-content space-y-2">
                    <div v-for="budget in planningDetails.resourceBudgets" :key="budget.id" class="rounded border border-base-300/70 p-2.5 text-xs">
                      <div class="font-semibold">{{ budget.owner ? `${budget.owner} · ` : '' }}{{ budget.resource }}</div>
                      <div class="mt-1 text-base-content/60">起始 {{ budgetRange(budget.start_min, budget.start_max, budget.unit) }} → 结束 {{ budgetRange(budget.end_min, budget.end_max, budget.unit) }}</div>
                      <p v-if="budget.allowed_events" class="mt-1">允许变化：{{ budget.allowed_events }}</p>
                      <p v-if="budget.forbidden_events" class="mt-1 text-warning">禁止变化：{{ budget.forbidden_events }}</p>
                      <p v-if="budget.reason" class="mt-1 text-base-content/50">依据：{{ budget.reason }}</p>
                    </div>
                    <p v-if="!planningDetails.resourceBudgets.length" class="text-xs text-base-content/45">当前章节没有需要数值追踪的资源预算。</p>
                  </div>
                </details>

                <details
                  v-for="section in assessmentSections"
                  :key="section.key"
                  class="collapse collapse-arrow bg-base-100 border border-base-300/70"
                >
                  <summary class="collapse-title min-h-0 py-3 text-sm font-semibold">{{ section.title }}</summary>
                  <div class="collapse-content text-xs">
                    <dl class="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-x-3 gap-y-2">
                      <template v-for="row in section.rows" :key="`${section.key}-${row.label}`">
                        <dt class="font-medium text-base-content/50">{{ row.label }}</dt>
                        <dd class="whitespace-pre-wrap leading-relaxed">{{ row.value }}</dd>
                      </template>
                    </dl>
                  </div>
                </details>

                <div v-if="planningDetails.warnings.length" class="alert alert-warning py-2 text-xs">
                  {{ planningDetails.warnings.join('；') }}
                </div>
              </div>
            </div>

            <div v-else class="flex-1 min-h-0 overflow-y-auto space-y-3">
            <textarea
              v-model="chapterOutline"
              rows="12"
              class="textarea textarea-bordered w-full resize-y min-h-[200px]"
              :placeholder="`${unitLabels.outline}...`"
            />
            <div class="flex items-center gap-2">
              <label class="text-xs text-base-content/50 shrink-0">情绪强度 (1-10)</label>
              <input v-model.number="chapterEmotion" type="range" min="1" max="10" class="range range-primary range-xs flex-1" />
              <span class="text-xs w-6 text-center">{{ chapterEmotion }}</span>
            </div>
            <div class="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 bg-base-100 rounded-lg border border-base-300/60">
              <p class="text-xs font-medium text-base-content/50 md:col-span-2">爽点链 ABC（规划层，正文只执行大纲）</p>
              <label class="form-control">
                <span class="label-text text-xs">爽点角色</span>
                <select v-model="chapterBeatRole" class="select select-bordered select-xs">
                  <option value="">未标注</option>
                  <option value="A">A · 爽点释放</option>
                  <option value="B">B · 进行中</option>
                  <option value="C">C · 铺垫下一爽点</option>
                  <option value="transition">过渡缓冲</option>
                </select>
              </label>
              <label class="form-control">
                <span class="label-text text-xs">叙事视角</span>
                <select v-model="chapterPovMode" class="select select-bordered select-xs">
                  <option value="">默认</option>
                  <option value="third_limited">第三人称限知</option>
                  <option value="first">第一人称</option>
                  <option value="omniscient">第三人称全知</option>
                </select>
              </label>
              <label class="form-control md:col-span-2">
                <span class="label-text text-xs">铺垫目标（foreshadow_target）</span>
                <input v-model="chapterForeshadow" class="input input-bordered input-xs" placeholder="本章为下一节点铺垫什么" />
              </label>
              <label class="form-control md:col-span-2">
                <span class="label-text text-xs">章末钩子（next_hook）</span>
                <input v-model="chapterNextHook" class="input input-bordered input-xs" placeholder="读者翻页的动力" />
              </label>
              <label class="form-control md:col-span-2">
                <span class="label-text text-xs">出场角色（逗号分隔）</span>
                <input v-model="chapterCharacters" class="input input-bordered input-xs" placeholder="韩立,南宫婉,令狐老祖" />
              </label>
            </div>
            <textarea
              v-model="chapterContent"
              rows="10"
              class="textarea textarea-bordered w-full resize-none font-mono text-xs"
              placeholder="正文内容（可在正文生成步骤中生成）..."
            />
            <div class="flex gap-2 flex-wrap">
              <button class="btn btn-primary btn-sm" @click="saveChapter">保存</button>
              <FavoriteButton
                v-if="chapterOutline.trim()"
                :work-id="workId"
                source-step="chapter_outline"
                :source-label="unitLabels.outline"
                :content="chapterOutline"
                :source-input="lastAiContext"
                size="xs"
              />
              <button class="btn btn-ghost btn-sm" @click="editingChapterId = null">取消</button>
            </div>
          </div>

          <!-- 版本历史 -->
            <div v-if="chapterVersions.length" class="mt-3 pt-3 border-t border-base-300 shrink-0">
              <p class="text-xs font-medium text-base-content/50 mb-2">版本历史</p>
              <div class="space-y-1 max-h-32 overflow-auto">
                <div
                  v-for="ver in chapterVersions"
                  :key="ver.id"
                  class="flex items-center justify-between text-xs bg-base-100 rounded px-2 py-1"
                >
                  <span>v{{ ver.version_number }} · {{ ver.create_time?.slice(0, 16) }}</span>
                  <button class="btn btn-ghost btn-xs" @click="restoreVersion(ver.id)">恢复</button>
                </div>
              </div>
            </div>
            <p v-else-if="loadingVersions" class="text-xs text-base-content/40 mt-2 shrink-0">加载版本...</p>
          </template>
          <p v-else class="text-sm text-base-content/40 italic flex-1 flex items-center justify-center">
            请从左侧选择{{ unitLabels.full }}
          </p>
        </div>
      </div>

      <StepNavFooter step="chapters" />
    </template>
  </div>
</template>
