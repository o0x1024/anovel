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
const lastAiContext = ref('')

const batchChapterCount = ref(5)
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
const batchCountOptions = computed(() =>
  workType.value === 'story'
    ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    : [1, 2, 3, 4, 5, 6, 8, 10]
)
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
  } else {
    chapterVersions.value = []
  }
}, { immediate: true })

const { loading, result, error, chat, clearResult } = useModelChat(() => props.workId)

const batchSystemPrompt = computed(() => {
  const startNum = chapters.value.length + 1
  const wpc = planStatus.value?.plan.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER
  const oc = outlineConstraintsForWordTarget(wpc)
  
  if (workType.value === 'story') {
    return [
      '这是一篇一镜到底的短故事。请根据短故事的主线规划，将其拆解为连续的情节节拍（Beats），每个节拍负责推进一段核心剧情。',
      '【极度紧凑与高潮迭起约束 - 硬要求】',
      '短故事要求剧情极度紧凑，节奏极快。禁止安排任何平淡的“过渡节拍”或“日常水文”。',
      '每个节拍都必须有核心矛盾冲突或情绪爆发，爽点或反转必须一个接一个密集抛出。',
      '【输出格式 - 必须严格遵守】',
      '只输出一个 JSON 对象；禁止 Markdown 标题、前置说明、思考过程，以及 ``` 代码块围栏。',
      'chapters 数组每一项为一个节拍（请勿输出“第X章”或“节拍X”字样，直接写节拍剧情标题即可）。',
      `每章字段：title、plot_points（${oc.pointsMin}-${oc.pointsMax} 条情节节点数组）、beat_role、foreshadow_target、next_hook、characters（本章出场角色名数组）。`,
      'beat_role: A(爽点释放)/B(进行中)/C(铺垫)/transition(过渡)',
      'foreshadow_target: 铺垫的下一节点；next_hook: 结尾悬念（仅写在 JSON 字段内，不要单独成章）。',
      'characters: 从人设卡片或核心设定中选取本节拍实际出场角色。',
      `【长度】每项 plot_points 合计 ${oc.charsMin}-${oc.charsMax} 字梗概（每节拍目标 ${wpc} 字正文），禁止正文级长文。`,
      `格式：{"chapters":[{"title":"节拍剧情标题","plot_points":["节点1","节点2","节点3"],"beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"]}]}`
    ].join('\n')
  }

  return [
    '根据当前分卷信息与作品创作上下文，生成该卷下的章节情节大纲。',
    '【输出格式 - 必须严格遵守】',
    '只输出一个 JSON 对象；禁止 Markdown 章节标题、前置说明、思考过程，以及 ``` 代码块围栏。',
    'chapters 数组每一项为一章；不要把「卷X章节大纲」「分章情节」「章节结尾钩子」等文档标题当作 title。',
    `每章字段：title、plot_points（${oc.pointsMin}-${oc.pointsMax} 条情节节点数组）、beat_role、foreshadow_target、next_hook、characters（本章出场角色名数组）。`,
    'beat_role: A(爽点释放)/B(进行中)/C(铺垫)/transition(过渡)',
    'foreshadow_target: 本章铺垫的下一节点；next_hook: 章末钩子（仅写在 JSON 字段内，不要单独成章）。',
    'characters: 从人设卡片或核心设定中选取本章实际出场角色。',
    `【长度】每章 plot_points 合计 ${oc.charsMin}-${oc.charsMax} 字梗概（每章目标 ${wpc} 字正文），禁止正文级长文。`,
    `【章节编号】title 中的章节序号必须从第 ${startNum} 章开始，依次递增。`,
    `格式：{"chapters":[{"title":"第${startNum}章 标题","plot_points":["节点1","节点2","节点3"],"beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"]}]}`
  ].join('\n')
})

function outlineCharCount(outline: string | null | undefined): number {
  return (outline ?? '').replace(/\s/g, '').length
}

function outlineLengthLabel(ch: Chapter): string {
  const n = outlineCharCount(ch.outline)
  if (!n) return ''
  const warnThreshold = outlineConstraintsForWordTarget(
    planStatus.value?.plan.wordsPerChapter ?? DEFAULT_WORDS_PER_CHAPTER
  ).charsWarn
  return n > warnThreshold ? `大纲 ${n} 字（偏长）` : `大纲 ${n} 字`
}

function parseCharacterNames(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return []
  return raw.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
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
    batchParseHint.value = /"chapters"\s*:|第\s*\d+\s*章/.test(content)
      ? '未能从生成结果中解析出章节，请确认末尾 JSON 完整，或点击「重新解析」重试'
      : '生成结果中未识别到章节结构，请重新生成或检查 AI 是否输出了 JSON 代码块'
    return
  }
})

async function reparseBatchResult() {
  if (!batchResult.value) return
  parsedChapters.value = await window.anovel.invoke('chapter:parseSuggestions', batchResult.value) as ParsedChapter[]
  if (parsedChapters.value.length === 0) {
    batchParseHint.value = '仍未解析到章节，请检查 JSON 是否完整、未被截断'
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
  }
}

const selectedChapter = computed(() =>
  chapters.value.find(c => c.id === selectedChapterId.value) ?? null
)

const selectedChapterCharacters = computed(() =>
  parseCharacterNames(selectedChapter.value?.characters)
)

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
  const noun = workType.value === 'story' ? '节拍' : '章节'
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
  const noun = workType.value === 'story' ? '节拍' : '章节'
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
  chapterCharacters.value = ch.characters || ''
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
  const noun = workType.value === 'story' ? '节拍' : '章节'
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
  const startNum = existingCount + 1
  const endNum = startNum + batchChapterCount.value - 1
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
    lines.push(`请生成 ${batchChapterCount.value} 章的情节大纲（即第 1 章到第 ${endNum} 章）。`)
  }

  if (volPlan && volPlan.suggestedChapters > 0) {
    if (endNum < volPlan.suggestedChapters) {
      lines.push(`【重要写作指令】：\n当前生成的第 ${endNum} 章并不是本卷的最后一章（本卷规划为 ${volPlan.suggestedChapters} 章，后续还有其他章节）。请保持剧情悬念与故事张力，绝对不要在该章进行卷末收尾或强行结局，以确保与后续章节的情节顺畅衔接。`)
    } else if (endNum === volPlan.suggestedChapters) {
      lines.push(`【重要写作指令】：\n当前生成的第 ${endNum} 章是本卷的最后一章（本卷规划为 ${volPlan.suggestedChapters} 章）。请在第 ${endNum} 章进行合理的卷末情节收尾，并为下一卷留出适当的铺垫或悬念。`)
    } else {
      lines.push(`【重要写作指令】：\n当前生成已超出本卷原规划总章节数（规划为 ${volPlan.suggestedChapters} 章）。请根据当前剧情发展合理推进，并在适当位置安排情节的收敛或向下一阶段的过渡。`)
    }
  }

  return lines.filter(Boolean).join('\n\n')
}

async function aiBatchChapters() {
  if (!selectedVolume.value || batchLoading.value) return
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
  const noun = workType.value === 'story' ? '节拍' : '章节'
  if (mode === 'replace') {
    if (!confirm(`将替换当前分卷下 ${chapters.value.length} 个${noun}，确定继续？`)) return
  }
  applyingChapters.value = true
  try {
    const startNum = mode === 'append' ? chapters.value.length + 1 : 1
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
    `${oc.pointsMin}-${oc.pointsMax} 个情节节点，每节点 1-2 句：出场人物、关键冲突、转折、极限悬念钩子。`,
    `全文 ${oc.charsMin}-${oc.charsMax} 字（本节拍目标 ${wpc} 字正文），禁止写完整对话、场景描写或心理独白。`,
    '标注 beat_role(A/B/C/transition)、foreshadow_target、next_hook、characters（本章出场角色名数组），放在末尾 JSON 代码块。',
    '末尾附 JSON：{"beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"]}'
  ].join('\n') : [
    '为以上章节生成情节大纲（写作指令，不是正文）。',
    `${oc.pointsMin}-${oc.pointsMax} 个情节节点，每节点 1-2 句：出场人物、关键冲突、转折、章末钩子。`,
    `全文 ${oc.charsMin}-${oc.charsMax} 字（本章目标 ${wpc} 字正文），禁止写完整对话、场景描写或心理独白。`,
    '标注 beat_role(A/B/C/transition)、foreshadow_target、next_hook、characters（本章出场角色名数组），放在末尾 JSON 代码块。',
    '末尾附 JSON：{"beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"]}'
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
const diagnosisScope = ref<'volume' | 'cross' | 'all'>('volume')
const savedDiagnoses = ref<Record<string, string>>({})

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
      let reportStr = parsed.report ? String(parsed.report) : ''
      if (!reportStr && Array.isArray(parsed.revised_chapters)) {
        reportStr = '### 大纲修订补丁预览\n\n请点击右上角 **“应用 AI 修复”** 按钮直接将以下修改应用至对应的章节大纲中：\n\n'
        parsed.revised_chapters.forEach((ch: any) => {
          reportStr += `#### 针对第 ${ch.chapter_id} 章的修改\n`
          if (ch.outline) reportStr += `**优化后大纲：**\n${ch.outline}\n\n`
          if (ch.beat_role) reportStr += `- **节拍角色：** ${ch.beat_role}\n`
          if (ch.foreshadow_target) reportStr += `- **铺垫目标：** ${ch.foreshadow_target}\n`
          if (ch.next_hook) reportStr += `- **章末钩子：** ${ch.next_hook}\n`
          if (ch.pov_mode) reportStr += `- **视角模式：** ${ch.pov_mode}\n`
          if (ch.characters) reportStr += `- **出场角色：** ${ch.characters}\n`
          reportStr += '\n---\n\n'
        })
      }
      
      return {
        report: reportStr,
        revised_chapters: Array.isArray(parsed.revised_chapters) ? parsed.revised_chapters : null
      }
    }
  } catch (e) {
    console.error('Failed to parse diagnosis JSON:', e)
  }
  return {
    report: raw,
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

async function runOutlineDiagnosis() {
  if (!selectedVolume.value || diagnosisLoading.value) return
  diagnosisLoading.value = true
  clearResult()
  
  try {
    let promptContext = ''
    if (diagnosisScope.value === 'volume') {
      const vol = volumes.value.find(v => v.id === selectedVolume.value)
      const chaptersText = chapters.value.map(c => `[ID: ${c.id}] ${c.title}：\n${c.outline || '（暂无大纲）'}`).join('\n\n')
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
          return `${header}- [ID: ${c.id}] ${c.title}：\n${c.outline || '（暂无大纲）'}`
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
        return `${header}- [ID: ${c.id}] ${c.title}：\n${c.outline || '（暂无大纲）'}`
      }).join('\n')
      
      promptContext = `【全书分卷与章节大纲列表】\n${chaptersText}`
    }

    const basePrompt = workType.value === 'story' ? [
      '你是犀利、资深的番茄短故事主编，擅长发现大纲中的节奏拖沓、爽点不足、情节注水以及人设世界观冲突。',
      '短故事要求剧情极度紧凑、起步即冲刺、爽点一个接一个。请用最严苛的标准对作者提供的节拍大纲进行诊断。',
      '如果发现平淡过渡、节奏缓慢或冲突不够尖锐的地方，请大胆指出并直接在 revised_chapters 中重写优化。',
      '请必须严格按照以下 JSON 格式输出，禁止包含 markdown 代码块外壳 (如 ```json) 或任何前后置文字：',
      '{',
      '  "revised_chapters": ['
    ] : [
      '你是犀利、资深的网文总编辑，擅长发现大纲中的逻辑漏洞、剧情合理性问题以及人设世界观冲突。',
      '请对作者提供的章节大纲列表进行深入诊断，并与作品的「核心设定」（人设、世界观规则、核心冲突、金手指等）进行联动对比。',
      '请必须严格按照以下 JSON 格式输出，禁止包含 markdown 代码块外壳 (如 ```json) 或任何前后置文字：',
      '{',
      '  "revised_chapters": ['
    ]

    const systemPrompt = [
      ...basePrompt,
      '    {',
      '      "chapter_id": 章节的数字ID,',
      '      "outline": "修改优化后的完整章节大纲文本（不要写任何批注，保持直接可用）",',
      '      "beat_role": "A/B/C/transition 中的一个或空字符串",',
      '      "foreshadow_target": "修改建议的铺垫目标或空字符串",',
      '      "next_hook": "修改建议的章末钩子或空字符串",',
      '      "pov_mode": "修改建议的视角模式，可选项为: third_limited(限知)/first(第一人称)/omniscient(全知) 或空字符串",',
      '      "characters": "修改建议的出场角色列表，如：韩立,南宫婉（逗号分隔）或空字符串"',
      '    }',
      '  ]',
      '}',
      '【注意事项】',
      '1. 核心约束：本系统暂不支持自动合并、拆分或删除章节。因此，**绝对禁止**提出结构性破坏建议。所有的剧情压缩、延展或节奏调整，都必须在**保持原有章节数和原有 chapter_id 不变**的前提下，通过修改现有每一章的内部大纲（outline）来实现。',
      '2. revised_chapters 数组中仅包含你需要进行修复和调整的章节。未指出逻辑或剧情硬伤的章节无需放入该数组中。',
      '3. 拒绝说明报告：不要输出任何形式的整体报告、概述或修改意见！你必须将所有发现的逻辑漏洞、设定冲突、爽点缺失等问题，**直接通过重写该章大纲文本（outline）来解决**。输出必须是只包含 revised_chapters 的干净 JSON。',
      '【诊断维度】',
      '1. 【逻辑与设定合理性】：检测整体剧情因果关系是否成立，是否存在吃设定、时间线错乱或跨章跨卷矛盾。',
      '2. 【期待感与目标拉扯】：检测主角目标是否明确，阻力是否有效，是否建立充足期待感并得到良好的延迟满足（核心爽点）。',
      '3. 【章末钩子与悬念】：检测关键章节结尾是否留有悬念、反转、未解之谜或危机，以此保证读者的追读率。',
      '4. 【人物高光与共情】：检测角色是否过于工具化，是否做出符合人设的抉择，是否具备高光时刻并能引发读者强烈的情绪共鸣。',
      '5. 【情节密度与情绪刺激】：检测主线推进效率，是否存在连续的无效过渡或注水灌水，剧情起伏波折与情绪刺激是否到位。',
      '6. 【遗漏与改进建议】：评估是否有未考虑到的地方，并给出具体的改进建议和详细修复步骤。'
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
    }
  } catch (e) {
    alert('诊断失败: ' + String(e))
  } finally {
    diagnosisLoading.value = false
  }
}

async function applyAiFixes(revisedChapters: any[]) {
  if (!revisedChapters || revisedChapters.length === 0 || applyingAiFixId.value) return
  const noun = workType.value === 'story' ? '节拍' : '章节'
  if (!confirm(`AI 建议修正其中的 ${revisedChapters.length} 个${noun}大纲，这会覆盖这些${noun}现有的大纲与元属性，并自动备份这些${noun}到各自的「版本历史」中。确定继续？`)) return
  
  applyingAiFixId.value = true
  try {
    const styleId = await window.anovel.invoke('style:getWorkStyleId', props.workId) as number | null
    
    const resolveChapterId = (idOrNo: any): number | null => {
      const num = Number(idOrNo)
      if (isNaN(num)) return null
      const directMatch = chapters.value.find(c => c.id === num)
      if (directMatch) return directMatch.id
      const numMatch = chapters.value.find(c => {
        const match = c.title.match(/^第\s*(\d+)\s*章/)
        return match && Number(match[1]) === num
      })
      if (numMatch) return numMatch.id
      return null
    }

    let successCount = 0
    for (const item of revisedChapters) {
      const chId = resolveChapterId(item.chapter_id)
      if (!chId) continue
      
      const currentCh = await window.anovel.invoke('chapter:get', chId) as Chapter
      if (!currentCh) continue
      
      await window.anovel.invoke('chapter:versionCreate', chId, {
        outline: currentCh.outline || undefined,
        content: currentCh.content || undefined,
        word_count: currentCh.word_count,
        style_id: styleId ?? undefined
      })
      
      const fields: Record<string, any> = {}
      if (item.outline !== undefined) fields.outline = item.outline
      if (item.beat_role !== undefined) fields.beat_role = item.beat_role || null
      if (item.foreshadow_target !== undefined) fields.foreshadow_target = item.foreshadow_target || null
      if (item.next_hook !== undefined) fields.next_hook = item.next_hook || null
      if (item.pov_mode !== undefined) fields.pov_mode = item.pov_mode || null
      if (item.characters !== undefined) fields.characters = item.characters || null
      
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
    
    alert(`成功应用了 ${successCount} 个章节的大纲修复！旧内容均已存入各自章节的「版本历史」。`)
  } catch (e) {
    alert('应用修复失败: ' + String(e))
  } finally {
    applyingAiFixId.value = false
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
    <PanelTitle icon="list-ol" :title="workType === 'story' ? '节拍大纲' : '章节情节'" />

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
            <select v-model="batchChapterCount" class="select select-bordered select-sm w-24">
              <option v-for="n in batchCountOptions" :key="n" :value="n">{{ n }} 拍</option>
            </select>
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
        <!-- AI 批量生成本卷章节 -->
        <div v-if="workType !== 'story'" class="card bg-base-200 border border-base-300 shadow-sm p-4">
          <h4 class="font-semibold text-sm mb-3">AI 批量生成本卷章节</h4>
          <div class="flex flex-wrap gap-2 mb-3 items-center">
            <label class="text-xs text-base-content/50">章节数</label>
            <select v-model="batchChapterCount" class="select select-bordered select-sm w-24">
              <option v-for="n in batchCountOptions" :key="n" :value="n">{{ n }} 章</option>
            </select>
            <button
              class="btn btn-outline btn-primary btn-sm gap-1"
              :disabled="batchLoading || !selectedVolume"
              @click="aiBatchChapters"
            >
              <font-awesome-icon :icon="batchLoading ? 'spinner' : 'robot'" :spin="batchLoading" class="w-3 h-3" />
              {{ batchLoading ? '生成中...' : 'AI 批量生成章节' }}
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

        <!-- AI 大纲诊断 -->
        <div class="card bg-base-200 border border-base-300 shadow-sm p-4 min-w-0 flex flex-col">
          <h4 class="font-semibold text-sm mb-3">{{ workType === 'story' ? 'AI 节拍大纲诊断' : 'AI 章节大纲诊断' }}</h4>
          <div class="flex flex-wrap gap-2 mb-3 items-center">
            <label v-if="workType !== 'story'" class="text-xs text-base-content/50">诊断范围</label>
            <select v-if="workType !== 'story'" v-model="diagnosisScope" class="select select-bordered select-sm w-36">
              <option value="volume">本卷大纲</option>
              <option value="cross">跨卷大纲(邻卷)</option>
              <option value="all">全书大纲</option>
            </select>
            <button
              class="btn btn-outline btn-secondary btn-sm gap-1"
              :disabled="diagnosisLoading || !selectedVolume || chapters.length === 0"
              @click="runOutlineDiagnosis"
            >
              <font-awesome-icon :icon="diagnosisLoading ? 'spinner' : 'clipboard-check'" :spin="diagnosisLoading" class="w-3 h-3" />
              {{ diagnosisLoading ? '诊断中...' : '运行大纲诊断' }}
            </button>
            <template v-if="parsedDiagnosisResult">
              <button
                v-if="parsedDiagnosisResult.revised_chapters && parsedDiagnosisResult.revised_chapters.length > 0"
                class="btn btn-primary btn-sm gap-1"
                :disabled="applyingAiFixId"
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
          :placeholder="workType === 'story' ? '节拍标题' : '章节标题'"
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
            <h4 class="font-semibold text-sm">{{ workType === 'story' ? '节拍列表' : '章节列表' }}</h4>
            <div class="flex items-center gap-2">
              <span class="text-xs text-base-content/40">{{ chapters.length }} {{ workType === 'story' ? '拍' : '章' }}</span>
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
                {{ selectedChapter.outline }}
              </p>
              <p v-else class="text-sm text-base-content/40 italic">{{ workType === 'story' ? '暂无大纲，可点击「AI 生成大纲」或「编辑」' : '暂无章节大纲，可点击「AI 生成章节大纲」或「编辑」' }}</p>
            </div>

            <div v-else class="flex-1 min-h-0 overflow-y-auto space-y-3">
            <textarea
              v-model="chapterOutline"
              rows="12"
              class="textarea textarea-bordered w-full resize-y min-h-[200px]"
              :placeholder="workType === 'story' ? '节拍大纲...' : '章节大纲...'"
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
                :source-label="workType === 'story' ? '节拍大纲' : '章节大纲'"
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
            请从左侧选择{{ workType === 'story' ? '节拍' : '章节' }}
          </p>
        </div>
      </div>

      <StepNavFooter step="chapters" />
    </template>
  </div>
</template>
