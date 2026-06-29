<script setup lang="ts">
import { ref, onMounted, onActivated, onUnmounted, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  DEFAULT_NOVEL_LENGTH,
  getPresetsForType,
  novelLengthSummary,
  type NovelLength,
  type PresetNovelLength
} from '../../../../shared/writing-plan-presets'
import {
  WORK_COVER_ACCEPT,
  isWorkCoverFile,
  pickWorkCover,
  removeWorkCover,
  setWorkCoverFromFile,
  workCoverSrc
} from '../../utils/workCover'
import {
  goalRoutinePhaseLabel,
  type GoalRoutinePhase
} from '../../../../shared/goal-routine-phases'
import { workUnitLabels } from '../../../../shared/work-terminology'
import { tagsArrayToStoryCategoryTags, storyCategoryTagsToStorage } from '../../../../shared/story-category-tags'

const route = useRoute()
const router = useRouter()

/** 由路由名区分小说 / 短故事，同一组件复用 */
const workType: 'novel' | 'story' = route.name === 'stories' ? 'story' : 'novel'
const editorPath = (id: number) => `/${workType}/${id}`

interface WorkTypeLabels {
  pageTitle: string
  pageSubtitle: string
  createBtnText: string
  importBtnText: string
  emptyTitleText: string
  emptySubtitleText: string
  loadingText: string
  projectLabel: string
  defaultDescText: string
  createDialogTitle: string
  createDialogSubtitle: string
  titleFieldLabel: string
  descFieldLabel: string
  editDialogTitle: string
  editDialogSubtitle: string
  unitLabel: string
  trashSubtitle: string
  purgeHint: string
}

const LABELS: Record<'novel' | 'story', WorkTypeLabels> = {
  novel: {
    pageTitle: '我的小说',
    pageSubtitle: '管理并孵化你的小说创作项目，开启 AI 创作之旅',
    createBtnText: '新建小说',
    importBtnText: '导入备份',
    emptyTitleText: '还没有任何小说',
    emptySubtitleText: '点击上方按钮或下方快速开始，开启你的第一个精彩故事。',
    loadingText: '正在加载小说列表...',
    projectLabel: 'PROJECT',
    defaultDescText: '暂无简介，点击进入编辑，为你的小说添加一段精彩的大纲或背景设定。',
    createDialogTitle: '新建小说',
    createDialogSubtitle: '开始孵化一个新的小说灵感',
    titleFieldLabel: '小说标题',
    descFieldLabel: '小说简介',
    editDialogTitle: '编辑小说',
    editDialogSubtitle: '修改小说名称、简介与封面',
    unitLabel: '章',
    trashSubtitle: '已删除的作品可在此恢复，或彻底清除',
    purgeHint: '此操作不可撤销，作品及其所有章节、设定、记忆体将被永久清除。'
  },
  story: {
    pageTitle: '我的短故事',
    pageSubtitle: '管理并孵化你的短故事创作项目，开启 AI 创作之旅',
    createBtnText: '新建短故事',
    importBtnText: '导入备份',
    emptyTitleText: '还没有任何短故事',
    emptySubtitleText: '点击上方按钮，开启你的第一个精彩短故事。',
    loadingText: '正在加载短故事列表...',
    projectLabel: 'STORY',
    defaultDescText: '暂无简介，点击进入编辑，为你的短故事添加一段精彩的大纲或背景设定。',
    createDialogTitle: '新建短故事',
    createDialogSubtitle: '开始孵化一个新的短故事灵感',
    titleFieldLabel: '故事标题',
    descFieldLabel: '故事简介',
    editDialogTitle: '编辑短故事',
    editDialogSubtitle: '修改故事名称、简介与封面',
    unitLabel: '拍',
    trashSubtitle: '已删除的短故事可在此恢复，或彻底清除',
    purgeHint: '此操作不可撤销，作品及其所有节拍、设定、记忆体将被永久清除。'
  }
}

const t = LABELS[workType]
const VIEW_MODE_KEY = `workListViewMode_${workType}`
type WorkViewMode = 'card' | 'list'

function loadViewMode(): WorkViewMode {
  return localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'card'
}

interface Work {
  id: number
  title: string
  description: string | null
  cover_image: string | null
  novel_length: string | null
  target_total_words: number | null
  target_chapters: number | null
  stat_total_words: number
  stat_chapter_count: number
  stat_completed_count: number
  status: string | null
  genre: string | null
  tags: string | null
  create_time: string
  update_time: string
}

// 作品状态：连载中 / 完结 / 暂更 / 弃坑
const STATUS_OPTIONS: { value: string; label: string; badge: string }[] = [
  { value: 'ongoing', label: '连载中', badge: 'badge-primary' },
  { value: 'completed', label: '完结', badge: 'badge-success' },
  { value: 'paused', label: '暂更', badge: 'badge-warning' },
  { value: 'dropped', label: '弃坑', badge: 'badge-ghost' }
]
const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUS_OPTIONS.map(s => [s.value, s.label]))
const STATUS_BADGE: Record<string, string> = Object.fromEntries(STATUS_OPTIONS.map(s => [s.value, s.badge]))

// 常见题材（输入时可自由填写，datalist 仅作提示）
const GENRE_PRESETS = [
  '玄幻', '奇幻', '武侠', '仙侠', '都市', '现实', '言情', '悬疑',
  '科幻', '历史', '军事', '游戏', '体育', '二次元', '其他'
]

function statusLabel(s: string | null): string {
  return (s && STATUS_LABEL[s]) || '连载中'
}
function statusBadgeClass(s: string | null): string {
  return (s && STATUS_BADGE[s]) || 'badge-primary'
}

/** 标签：存储为 JSON 数组字符串，UI 用逗号分隔输入 */
function parseTags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function tagsToStorage(input: string): string {
  const arr = input.split(/[,，]/).map(t => t.trim()).filter(Boolean)
  return JSON.stringify(arr)
}
function mergeGenreTagsToStorage(genre: string, input: string): string {
  const arr = input.split(/[,，]/).map(t => t.trim()).filter(Boolean)
  return storyCategoryTagsToStorage(tagsArrayToStoryCategoryTags([genre.trim(), ...arr].filter(Boolean)))
}

const works = ref<Work[]>([])
const loading = ref(true)
const showCreateDialog = ref(false)
const showEditDialog = ref(false)
const newWork = ref({ title: '', description: '', genre: '', tags: '' })
const newNovelLength = ref<NovelLength>(DEFAULT_NOVEL_LENGTH)
const customTargetTotalWords = ref(workType === 'story' ? 30_000 : 800_000)
const customTargetChapters = ref(workType === 'story' ? 10 : 200)
const customWordsPerChapter = ref(workType === 'story' ? 3000 : 4000)
const editWork = ref({
  id: 0,
  title: '',
  description: '',
  cover_image: null as string | null,
  status: 'ongoing' as string,
  genre: '',
  tags: ''
})

// 列表筛选与排序
const searchQuery = ref('')
const statusFilter = ref<string>('ongoing')
const genreFilter = ref<string>('')
const sortKey = ref<'update' | 'create' | 'words' | 'progress'>('update')

/** 当前列表中出现的题材，用于筛选下拉 */
const availableGenres = computed(() => {
  const set = new Set<string>()
  for (const w of works.value) {
    if (w.genre) set.add(w.genre)
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'))
})

const filteredWorks = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const sf = statusFilter.value
  const gf = genreFilter.value
  let list = works.value.filter(w => {
    if (q && !w.title.toLowerCase().includes(q) && !(w.description ?? '').toLowerCase().includes(q)) return false
    if (sf && (w.status || 'ongoing') !== sf) return false
    if (gf && w.genre !== gf) return false
    return true
  })
  const byWords = (w: Work) => w.stat_total_words
  const byProgress = (w: Work) => progressPct(w)
  switch (sortKey.value) {
    case 'create': list = [...list].sort((a, b) => b.create_time.localeCompare(a.create_time)); break
    case 'words': list = [...list].sort((a, b) => byWords(b) - byWords(a)); break
    case 'progress': list = [...list].sort((a, b) => byProgress(b) - byProgress(a)); break
    default: list = [...list].sort((a, b) => b.update_time.localeCompare(a.update_time))
  }
  return list
})
const creating = ref(false)
const saving = ref(false)
const backupBusy = ref<number | null>(null)
const coverBusy = ref<number | null>(null)
const coverInputRef = ref<HTMLInputElement | null>(null)
const coverPickerTarget = ref<'create' | number | null>(null)
const pendingCoverFile = ref<File | null>(null)
const pendingCoverPreview = ref<string | null>(null)
const viewMode = ref<WorkViewMode>(loadViewMode())

// ==================== 目标循环进度（短故事列表全局感知）====================
interface GoalProgressSummary {
  workId: number
  status: string
  turn: number
  maxTurns: number
  phase: GoalRoutinePhase | string
  message: string
  updateTime: string
}

interface GoalProgressEvent {
  workId: number
  turn: number
  maxTurns: number
  phase: string
  status: string
  message: string
}

const goalProgressMap = ref<Map<number, GoalProgressSummary>>(new Map())

const runningGoalCount = computed(() => {
  let count = 0
  for (const p of goalProgressMap.value.values()) {
    if (p.status === 'running') count++
  }
  return count
})

function goalStatusBadgeClass(status: string): string {
  const map: Record<string, string> = {
    running: 'badge-primary',
    paused: 'badge-warning',
    goal_met: 'badge-success',
    timeout: 'badge-warning',
    cancelled: 'badge-ghost',
    error: 'badge-error',
    idle: 'badge-ghost'
  }
  return map[status] ?? 'badge-ghost'
}

function goalStatusLabel(status: string): string {
  const map: Record<string, string> = {
    running: '运行中',
    paused: '已暂停',
    goal_met: '已达成',
    timeout: '轮次上限',
    cancelled: '已取消',
    error: '出错',
    idle: '空闲'
  }
  return map[status] ?? status
}

function getWorkGoalProgress(workId: number): GoalProgressSummary | undefined {
  return goalProgressMap.value.get(workId)
}

async function fetchAllGoalStates() {
  try {
    const rows = await window.anovel.invoke('goal:listAllStates') as Array<{
      workId: number
      status: string
      turnCount: number
      maxTurns: number
      currentPhase: string | null
      lastQualityScore: number | null
      goalMet: boolean
      updateTime: string
    }>
    const map = new Map<number, GoalProgressSummary>()
    for (const r of rows) {
      map.set(r.workId, {
        workId: r.workId,
        status: r.status,
        turn: r.turnCount ?? 0,
        maxTurns: r.maxTurns ?? 0,
        phase: r.currentPhase ?? '',
        message: r.goalMet ? '目标已达成' : (goalRoutinePhaseLabel(r.currentPhase) || ''),
        updateTime: r.updateTime
      })
    }
    goalProgressMap.value = map
  } catch (e) {
    console.error('加载目标循环状态失败:', e)
  }
}

function onGoalProgress(payload: unknown) {
  const ev = payload as GoalProgressEvent
  if (!ev || typeof ev.workId !== 'number') return
  goalProgressMap.value.set(ev.workId, {
    workId: ev.workId,
    status: ev.status,
    turn: ev.turn,
    maxTurns: ev.maxTurns,
    phase: ev.phase,
    message: ev.message,
    updateTime: new Date().toISOString()
  })
  // 触发响应式更新
  goalProgressMap.value = new Map(goalProgressMap.value)
}

async function startGoalLoop(workId: number) {
  try {
    await window.anovel.invoke('goal:start', workId, {})
  } catch (e) {
    alert(e instanceof Error ? e.message : '启动目标循环失败')
  }
}

async function resumeGoalLoop(workId: number) {
  try {
    await window.anovel.invoke('goal:resume', workId, {})
  } catch (e) {
    alert(e instanceof Error ? e.message : '继续目标循环失败')
  }
}

async function cancelGoalLoop(workId: number) {
  try {
    await window.anovel.invoke('goal:cancel', workId)
  } catch (e) {
    alert(e instanceof Error ? e.message : '取消目标循环失败')
  }
}

function canStartGoalFromList(progress: GoalProgressSummary | undefined): boolean {
  if (!progress) return true
  return !progress.status || progress.status === 'idle' || progress.status === 'goal_met'
}

function canResumeGoalFromList(progress: GoalProgressSummary | undefined): boolean {
  if (!progress) return false
  return progress.status === 'paused' || progress.status === 'cancelled' || progress.status === 'timeout'
}

function canCancelGoalFromList(progress: GoalProgressSummary | undefined): boolean {
  if (!progress) return false
  return progress.status === 'running'
}

async function reloadWorks() {
  works.value = await window.anovel.invoke('work:list', workType) as Work[]
  for (const w of works.value) {
    localStorage.setItem(`work:${w.id}:type`, workType)
  }
}

function clearPendingCover() {
  if (pendingCoverPreview.value) URL.revokeObjectURL(pendingCoverPreview.value)
  pendingCoverFile.value = null
  pendingCoverPreview.value = null
}

function openCreateDialog() {
  clearPendingCover()
  showCreateDialog.value = true
}

function triggerCoverPicker(target: 'create' | number) {
  coverPickerTarget.value = target
  coverInputRef.value?.click()
}

async function handleCoverFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const target = coverPickerTarget.value
  coverPickerTarget.value = null
  if (!file || target === null) return

  if (!isWorkCoverFile(file)) {
    alert('请选择 JPG、PNG、WebP 或 GIF 图片')
    return
  }

  if (target === 'create') {
    clearPendingCover()
    pendingCoverFile.value = file
    pendingCoverPreview.value = URL.createObjectURL(file)
    return
  }

  coverBusy.value = target
  try {
    await setWorkCoverFromFile(target, file)
    await reloadWorks()
    if (editWork.value.id === target) {
      editWork.value.cover_image = works.value.find(w => w.id === target)?.cover_image ?? null
    }
  } catch (e) {
    alert(e instanceof Error ? e.message : '设置封面失败')
  } finally {
    coverBusy.value = null
  }
}

async function pickCoverForWork(workId: number) {
  coverBusy.value = workId
  try {
    const coverPath = await pickWorkCover(workId)
    if (!coverPath) return
    await reloadWorks()
    if (editWork.value.id === workId) {
      editWork.value.cover_image = coverPath
    }
  } catch (e) {
    alert(e instanceof Error ? e.message : '设置封面失败')
  } finally {
    coverBusy.value = null
  }
}

async function removeCoverForWork(workId: number) {
  if (!confirm('确定移除作品封面？')) return
  coverBusy.value = workId
  try {
    await removeWorkCover(workId)
    await reloadWorks()
    if (editWork.value.id === workId) {
      editWork.value.cover_image = null
    }
  } catch (e) {
    alert(e instanceof Error ? e.message : '移除封面失败')
  } finally {
    coverBusy.value = null
  }
}

function clearCreateCover() {
  clearPendingCover()
}

watch(viewMode, (mode) => {
  localStorage.setItem(VIEW_MODE_KEY, mode)
})

async function exportWork(workId: number, title: string) {
  backupBusy.value = workId
  try {
    const bundle = await window.anovel.invoke('backup:exportWork', workId) as object
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title}-backup.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    console.error('导出失败:', e)
    alert('导出失败')
  } finally {
    backupBusy.value = null
  }
}

async function importWorkFromFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const text = await file.text()
    const bundle = JSON.parse(text)
    const newId = await window.anovel.invoke('backup:importWork', bundle) as number
    works.value = await window.anovel.invoke('work:list', workType) as Work[]
    router.push(editorPath(newId))
  } catch (e) {
    console.error('导入失败:', e)
    alert('导入失败，请检查文件格式')
  } finally {
    input.value = ''
  }
}

async function importManuscript() {
  try {
    const res = await window.anovel.invoke('work:importManuscript', workType) as {
      success: boolean
      workId?: number
      chapterCount?: number
      error?: string
      cancelled?: boolean
    }
    if (!res.success) {
      if (!res.cancelled) alert(res.error || '导入失败')
      return
    }
    await reloadWorks()
    if (res.workId) router.push(editorPath(res.workId))
  } catch (e) {
    console.error('导入文稿失败:', e)
    alert('导入文稿失败')
  }
}

onMounted(async () => {
  window.anovel.on('goal:progress', onGoalProgress)
  try {
    await reloadWorks()
    await fetchAllGoalStates()
  } catch (e) {
    console.error('加载作品列表失败:', e)
  } finally {
    loading.value = false
  }
})

onActivated(async () => {
  try {
    await reloadWorks()
    await fetchAllGoalStates()
  } catch (e) {
    console.error('刷新作品列表失败:', e)
  }
})

onUnmounted(() => {
  window.anovel.off('goal:progress', onGoalProgress)
})

const novelLengthOptions = computed(() => {
  const presets = getPresetsForType(workType)
  return (Object.keys(presets) as PresetNovelLength[]).map(key => ({
    key,
    ...presets[key],
    summary: novelLengthSummary(key, workType)
  }))
})

const chapterUnit = computed(() => workUnitLabels(workType).short)
const customLengthSummary = computed(() => `${formatWords(customTargetTotalWords.value)} · ${customTargetChapters.value} ${chapterUnit.value} · 每${chapterUnit.value} ${customWordsPerChapter.value} 字`)

function normalizeCreatePlan() {
  const targetTotalWords = Math.max(1, Math.round(Number(customTargetTotalWords.value) || 1))
  const targetChapters = Math.max(1, Math.round(Number(customTargetChapters.value) || 1))
  const wordsPerChapter = Math.max(1, Math.round(Number(customWordsPerChapter.value) || Math.ceil(targetTotalWords / targetChapters)))
  return { targetTotalWords, targetChapters, wordsPerChapter }
}

function syncCustomWordsPerChapter() {
  const targetTotalWords = Math.max(1, Math.round(Number(customTargetTotalWords.value) || 1))
  const targetChapters = Math.max(1, Math.round(Number(customTargetChapters.value) || 1))
  customWordsPerChapter.value = Math.max(1, Math.round(targetTotalWords / targetChapters))
}

function syncCustomTargetTotalWords() {
  const targetChapters = Math.max(1, Math.round(Number(customTargetChapters.value) || 1))
  const wordsPerChapter = Math.max(1, Math.round(Number(customWordsPerChapter.value) || 1))
  customTargetTotalWords.value = targetChapters * wordsPerChapter
}

function resetCreateForm() {
  newWork.value = { title: '', description: '', genre: '', tags: '' }
  newNovelLength.value = DEFAULT_NOVEL_LENGTH
  customTargetTotalWords.value = workType === 'story' ? 30_000 : 800_000
  customTargetChapters.value = workType === 'story' ? 10 : 200
  customWordsPerChapter.value = workType === 'story' ? 3000 : 4000
}

async function createWork() {
  if (!newWork.value.title.trim()) return
  const customPlan = newNovelLength.value === 'custom' ? normalizeCreatePlan() : null
  creating.value = true
  try {
    const id = await window.anovel.invoke('work:create', {
      title: newWork.value.title.trim(),
      description: newWork.value.description.trim() || undefined,
      novelLength: newNovelLength.value,
      targetTotalWords: customPlan?.targetTotalWords,
      targetChapters: customPlan?.targetChapters,
      wordsPerChapter: customPlan?.wordsPerChapter,
      workType: workType,
      genre: newWork.value.genre.trim() || undefined,
      tags: mergeGenreTagsToStorage(newWork.value.genre, newWork.value.tags) || undefined
    }) as number
    localStorage.setItem(`work:${id}:type`, workType)
    if (pendingCoverFile.value) {
      try {
        await setWorkCoverFromFile(id, pendingCoverFile.value)
      } catch (e) {
        console.error('设置封面失败:', e)
        alert(e instanceof Error ? e.message : '作品已创建，但封面设置失败')
      }
    }
    showCreateDialog.value = false
    resetCreateForm()
    clearPendingCover()
    await reloadWorks()
    router.push(editorPath(id))
  } catch (e) {
    console.error('创建作品失败:', e)
  } finally {
    creating.value = false
  }
}

async function deleteWork(id: number, title: string) {
  if (!confirm(`确定删除作品「${title}」吗？\n作品将移入回收站，可随时恢复。`)) return
  try {
    await window.anovel.invoke('work:delete', id)
    works.value = works.value.filter(w => w.id !== id)
  } catch (e) {
    console.error('删除作品失败:', e)
  }
}

// ==================== 回收站 ====================
const showTrashDialog = ref(false)
const trashWorks = ref<Work[]>([])
const trashLoading = ref(false)
const trashBusy = ref<number | null>(null)

async function openTrashDialog() {
  showTrashDialog.value = true
  await loadTrash()
}

async function loadTrash() {
  trashLoading.value = true
  try {
    trashWorks.value = await window.anovel.invoke('work:listTrash', workType) as Work[]
  } catch (e) {
    console.error('加载回收站失败:', e)
  } finally {
    trashLoading.value = false
  }
}

async function restoreWork(id: number) {
  trashBusy.value = id
  try {
    await window.anovel.invoke('work:restore', id)
    await loadTrash()
    await reloadWorks()
  } catch (e) {
    console.error('恢复作品失败:', e)
    alert('恢复失败，请重试')
  } finally {
    trashBusy.value = null
  }
}

async function purgeWork(id: number, title: string) {
  if (!confirm(`确定彻底删除「${title}」吗？\n${t.purgeHint}`)) return
  trashBusy.value = id
  try {
    await window.anovel.invoke('work:purge', id)
    await loadTrash()
  } catch (e) {
    console.error('彻底删除失败:', e)
    alert('删除失败，请重试')
  } finally {
    trashBusy.value = null
  }
}

function openEditDialog(work: Work) {
  editWork.value = {
    id: work.id,
    title: work.title,
    description: work.description ?? '',
    cover_image: work.cover_image,
    status: work.status || 'ongoing',
    genre: work.genre ?? '',
    tags: parseTags(work.tags).join(', ')
  }
  showEditDialog.value = true
}

function closeEditDialog() {
  showEditDialog.value = false
  editWork.value = { id: 0, title: '', description: '', cover_image: null, status: 'ongoing', genre: '', tags: '' }
}

async function saveWorkEdit() {
  if (!editWork.value.title.trim() || saving.value) return
  saving.value = true
  try {
    await window.anovel.invoke('work:update', editWork.value.id, {
      title: editWork.value.title.trim(),
      description: editWork.value.description.trim() || null,
      status: editWork.value.status,
      genre: editWork.value.genre.trim() || null,
      tags: mergeGenreTagsToStorage(editWork.value.genre, editWork.value.tags)
    })
    await reloadWorks()
    closeEditDialog()
  } catch (e) {
    console.error('更新作品失败:', e)
    alert('保存失败，请重试')
  } finally {
    saving.value = false
  }
}

function enterWork(id: number) {
  router.push(editorPath(id))
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'Z')
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前'
  if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前'
  return d.toLocaleDateString('zh-CN')
}

/** 字数格式化：1万以上显示「X.X万」，否则千分位 */
function formatWords(n: number): string {
  if (!n || n <= 0) return '0 字'
  if (n >= 10000) {
    const wan = n / 10000
    return (Number.isInteger(wan) ? `${wan}` : wan.toFixed(1)) + ' 万字'
  }
  return n.toLocaleString('zh-CN') + ' 字'
}

/** 目标进度百分比，无目标时返回 0 */
function progressPct(work: Work): number {
  const target = work.target_total_words
  if (!target || target <= 0) return 0
  return Math.min(100, Math.round((work.stat_total_words / target) * 100))
}
</script>

<template>
  <div class="p-8 animate-fade-in">
    <!-- 头部区域 -->
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8 border-b border-base-300/60 pb-6">
      <div>
        <div class="flex items-center gap-3">
          <h2 class="text-2xl font-extrabold tracking-tight">{{ t.pageTitle }}</h2>
          <span
            v-if="workType === 'story' && runningGoalCount > 0"
            class="badge badge-primary badge-sm gap-1.5 animate-pulse"
          >
            <font-awesome-icon icon="rotate" class="w-3 h-3" />
            {{ runningGoalCount }} 个目标循环运行中
          </span>
        </div>
        <p class="text-sm text-base-content/50 mt-1">{{ t.pageSubtitle }}</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <div v-if="!loading && works.length > 0" class="join">
          <button
            type="button"
            class="btn btn-sm join-item gap-1.5"
            :class="viewMode === 'card' ? 'btn-primary' : 'btn-ghost'"
            title="卡片视图"
            @click="viewMode = 'card'"
          >
            <font-awesome-icon icon="th-large" class="w-3.5 h-3.5" />
            卡片
          </button>
          <button
            type="button"
            class="btn btn-sm join-item gap-1.5"
            :class="viewMode === 'list' ? 'btn-primary' : 'btn-ghost'"
            title="列表视图"
            @click="viewMode = 'list'"
          >
            <font-awesome-icon icon="list-ol" class="w-3.5 h-3.5" />
            列表
          </button>
        </div>
        <button type="button" @click="openCreateDialog" class="btn btn-primary gap-2">
          <font-awesome-icon icon="plus" class="w-4 h-4 mr-1.5" />
          {{ t.createBtnText }}
        </button>
        <label class="btn btn-outline gap-2 cursor-pointer" title="导入本系统的备份文件（.json）">
          <font-awesome-icon icon="upload" class="w-4 h-4" />
          {{ t.importBtnText }}
          <input type="file" accept=".json,application/json" class="hidden" @change="importWorkFromFile" />
        </label>
        <button type="button" class="btn btn-outline gap-2" @click="importManuscript" title="从 txt/docx 书稿导入并自动切分章节">
          <font-awesome-icon icon="file-import" class="w-4 h-4" />
          导入文稿
        </button>
        <button type="button" class="btn btn-ghost gap-2" @click="openTrashDialog" title="回收站">
          <font-awesome-icon icon="trash-restore" class="w-4 h-4" />
          回收站
        </button>
      </div>
    </div>

    <!-- 筛选与排序（独立显示，不参与下方渲染链） -->
    <div v-if="!loading && works.length > 0" class="mb-5 flex items-center gap-2">
      <div class="relative flex-[2] min-w-0">
        <font-awesome-icon icon="search" class="w-3.5 h-3.5 text-base-content/30 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          v-model="searchQuery"
          placeholder="搜索标题或简介"
          class="input input-bordered input-sm w-full pl-8 rounded-lg"
        />
      </div>
      <select v-model="statusFilter" class="select select-bordered select-sm flex-1 min-w-0 rounded-lg">
        <option value="">全部状态</option>
        <option v-for="s in STATUS_OPTIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
      </select>
      <select v-model="genreFilter" class="select select-bordered select-sm flex-1 min-w-0 rounded-lg">
        <option value="">全部题材</option>
        <option v-for="g in availableGenres" :key="g" :value="g">{{ g }}</option>
      </select>
      <select v-model="sortKey" class="select select-bordered select-sm flex-1 min-w-0 rounded-lg">
        <option value="update">按更新时间</option>
        <option value="create">按创建时间</option>
        <option value="words">按字数</option>
        <option value="progress">按进度</option>
      </select>
      <span class="text-xs text-base-content/40 shrink-0">{{ filteredWorks.length }} / {{ works.length }}</span>
    </div>

    <!-- 加载中 -->
    <div v-if="loading" class="flex flex-col items-center justify-center py-32 text-base-content/40">
      <span class="loading loading-spinner loading-lg text-primary mb-4"></span>
      <p class="text-sm font-medium tracking-wide">{{ t.loadingText }}</p>
    </div>

    <!-- 空状态 -->
    <div v-else-if="works.length === 0" class="flex flex-col items-center justify-center py-24 text-center border border-dashed border-base-300 rounded-2xl bg-base-200/20">
      <div class="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary mb-4">
        <font-awesome-icon icon="book-open" class="text-2xl" />
      </div>
      <h3 class="text-lg font-bold">{{ t.emptyTitleText }}</h3>
      <p class="text-sm text-base-content/50 mt-1 max-w-xs">
        {{ t.emptySubtitleText }}
      </p>
      <button @click="openCreateDialog" class="btn btn-primary btn-sm mt-6">
        <font-awesome-icon icon="plus" class="w-3.5 h-3.5 mr-1" />
        开始创作
      </button>
    </div>

    <!-- 无匹配结果 -->
    <div v-else-if="filteredWorks.length === 0" class="flex flex-col items-center justify-center py-20 text-center text-base-content/40">
      <font-awesome-icon icon="search-minus" class="text-3xl mb-3" />
      <p class="text-sm">没有符合条件的作品，试试调整搜索或筛选</p>
    </div>

    <!-- 卡片视图 -->
    <div v-else-if="viewMode === 'card'" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      <div
        v-for="work in filteredWorks"
        :key="work.id"
        class="card bg-base-200/40 border border-base-300 hover:border-primary/40 hover:bg-base-200/80 shadow-sm hover:shadow-md
               cursor-pointer group transition-all duration-300 rounded-xl overflow-hidden"
        @click="enterWork(work.id)"
      >
        <div
          class="h-36 bg-base-300/50 overflow-hidden"
          :class="work.cover_image ? '' : 'flex items-center justify-center'"
        >
          <img
            v-if="work.cover_image"
            :src="workCoverSrc(work.cover_image)!"
            :alt="work.title"
            class="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
          />
          <div v-else class="flex flex-col items-center text-base-content/25">
            <font-awesome-icon icon="book-open" class="text-3xl" />
            <span class="text-[10px] mt-1">暂无封面</span>
          </div>
        </div>
        <div class="card-body p-5 flex flex-col justify-between min-h-[9.5rem]">
          <div>
            <div class="flex items-start justify-between gap-2 mb-2">
              <div class="min-w-0">
                <h3 class="font-bold text-base-content leading-snug group-hover:text-primary transition-colors truncate">
                  {{ work.title }}
                </h3>
                <span class="text-xs font-bold text-base-content/30 uppercase tracking-wider">{{ t.projectLabel }} #{{ work.id }}</span>
              </div>
              <span class="badge badge-xs shrink-0" :class="statusBadgeClass(work.status)">{{ statusLabel(work.status) }}</span>
            </div>
            <p class="text-xs text-base-content/60 line-clamp-2 leading-relaxed">
              {{ work.description || t.defaultDescText }}
            </p>

            <div class="mt-3">
              <div class="flex items-center justify-between text-[11px] text-base-content/50 mb-1">
                <span>
                  {{ formatWords(work.stat_total_words) }}
                  <span class="text-base-content/30">/ {{ work.target_total_words ? formatWords(work.target_total_words) : '未设目标' }}</span>
                </span>
                <span>{{ work.stat_completed_count }}/{{ work.stat_chapter_count }} {{ t.unitLabel }}</span>
              </div>
              <progress
                class="progress progress-primary w-full h-1.5"
                :value="progressPct(work)"
                max="100"
              ></progress>
            </div>

            <!-- 短故事目标循环进度 -->
            <div v-if="getWorkGoalProgress(work.id)" class="mt-3 pt-3 border-t border-base-300/40">
              <div class="flex items-center justify-between gap-2 mb-1.5">
                <div class="flex items-center gap-1.5 min-w-0">
                  <font-awesome-icon icon="rotate" class="w-3 h-3 text-base-content/40" :class="{ 'animate-spin': getWorkGoalProgress(work.id)!.status === 'running' }" />
                  <span class="text-[11px] font-medium text-base-content/60 truncate">
                    {{ goalRoutinePhaseLabel(getWorkGoalProgress(work.id)!.phase) }}
                  </span>
                </div>
                <span class="badge badge-xs shrink-0" :class="goalStatusBadgeClass(getWorkGoalProgress(work.id)!.status)">
                  {{ goalStatusLabel(getWorkGoalProgress(work.id)!.status) }}
                </span>
              </div>
              <div v-if="getWorkGoalProgress(work.id)!.maxTurns > 0" class="mb-1.5">
                <progress
                  class="progress progress-accent w-full h-1"
                  :value="getWorkGoalProgress(work.id)!.turn"
                  :max="getWorkGoalProgress(work.id)!.maxTurns"
                ></progress>
                <div class="flex justify-between text-[10px] text-base-content/40 mt-0.5">
                  <span>轮次 {{ getWorkGoalProgress(work.id)!.turn }} / {{ getWorkGoalProgress(work.id)!.maxTurns }}</span>
                </div>
              </div>
              <p class="text-[11px] text-base-content/50 line-clamp-1" :title="getWorkGoalProgress(work.id)!.message">
                {{ getWorkGoalProgress(work.id)!.message }}
              </p>
              <div class="flex gap-1.5 mt-2">
                <button
                  v-if="canStartGoalFromList(getWorkGoalProgress(work.id))"
                  type="button"
                  class="btn btn-primary btn-xs gap-1"
                  @click.stop="startGoalLoop(work.id)"
                >
                  <font-awesome-icon icon="play" class="w-3 h-3" />
                  启动目标循环
                </button>
                <button
                  v-if="canResumeGoalFromList(getWorkGoalProgress(work.id))"
                  type="button"
                  class="btn btn-warning btn-xs gap-1"
                  @click.stop="resumeGoalLoop(work.id)"
                >
                  <font-awesome-icon icon="forward" class="w-3 h-3" />
                  继续
                </button>
                <button
                  v-if="canCancelGoalFromList(getWorkGoalProgress(work.id))"
                  type="button"
                  class="btn btn-error btn-xs gap-1"
                  @click.stop="cancelGoalLoop(work.id)"
                >
                  <font-awesome-icon icon="stop" class="w-3 h-3" />
                  取消
                </button>
              </div>
            </div>
          </div>

          <div class="flex items-center justify-between mt-4 pt-3 border-t border-base-300/40">
            <span class="text-xs font-medium text-base-content/40 flex items-center gap-1.5">
              <font-awesome-icon icon="clock" class="w-3 h-3 opacity-60" />
              {{ formatDate(work.update_time) }}更新
            </span>
            <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                title="封面"
                :disabled="coverBusy === work.id"
                @click.stop="openEditDialog(work)"
              >
                <font-awesome-icon icon="palette" class="w-3 h-3 mr-1" />
                封面
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click.stop="openEditDialog(work)">
                <font-awesome-icon icon="edit" class="w-3 h-3 mr-1" />
                编辑
              </button>
              <button
                type="button"
                :disabled="backupBusy === work.id"
                class="btn btn-ghost btn-xs"
                @click.stop="exportWork(work.id, work.title)"
              >
                <font-awesome-icon icon="download" class="w-3 h-3 mr-1" />
                备份
              </button>
              <button type="button" class="btn btn-ghost btn-xs text-error" @click.stop="deleteWork(work.id, work.title)">
                <font-awesome-icon icon="trash" class="w-3 h-3 mr-1" />
                删除
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 列表视图 -->
    <div v-else-if="filteredWorks.length > 0" class="border border-base-300 rounded-xl overflow-hidden bg-base-200/20">
      <div
        v-for="(work, index) in filteredWorks"
        :key="work.id"
        class="flex items-center gap-4 px-4 py-3 hover:bg-base-200/70 cursor-pointer group transition-colors"
        :class="index > 0 ? 'border-t border-base-300/60' : ''"
        @click="enterWork(work.id)"
      >
        <div
          class="w-10 h-14 rounded overflow-hidden shrink-0 border border-base-300/60 bg-primary/10 flex items-center justify-center text-primary group-hover:border-primary/30 transition-colors"
        >
          <img
            v-if="work.cover_image"
            :src="workCoverSrc(work.cover_image)!"
            :alt="work.title"
            class="w-full h-full object-cover"
          />
          <font-awesome-icon v-else icon="book-open" class="text-sm" />
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <h3 class="font-semibold text-sm truncate group-hover:text-primary transition-colors">
              {{ work.title }}
            </h3>
            <span class="badge badge-xs shrink-0" :class="statusBadgeClass(work.status)">{{ statusLabel(work.status) }}</span>
            <span class="text-[10px] font-bold text-base-content/30 uppercase tracking-wider shrink-0 hidden sm:inline">
              #{{ work.id }}
            </span>
          </div>
          <p class="text-xs text-base-content/50 line-clamp-1 mt-0.5">
            {{ work.description || '暂无简介' }}
          </p>
          <div class="flex items-center gap-2 mt-1.5">
            <progress
              class="progress progress-primary h-1 w-20"
              :value="progressPct(work)"
              max="100"
            ></progress>
            <span class="text-[10px] text-base-content/40 shrink-0">
              {{ formatWords(work.stat_total_words) }} · {{ work.stat_completed_count }}/{{ work.stat_chapter_count }} {{ t.unitLabel }}
            </span>
          </div>

          <!-- 短故事目标循环进度 -->
          <div v-if="getWorkGoalProgress(work.id)" class="flex items-center gap-2 mt-1.5">
            <font-awesome-icon icon="rotate" class="w-3 h-3 text-base-content/40" :class="{ 'animate-spin': getWorkGoalProgress(work.id)!.status === 'running' }" />
            <span class="badge badge-xs shrink-0" :class="goalStatusBadgeClass(getWorkGoalProgress(work.id)!.status)">
              {{ goalStatusLabel(getWorkGoalProgress(work.id)!.status) }}
            </span>
            <span class="text-[10px] text-base-content/50 truncate max-w-[10rem]" :title="getWorkGoalProgress(work.id)!.message">
              {{ goalRoutinePhaseLabel(getWorkGoalProgress(work.id)!.phase) }}
              <template v-if="getWorkGoalProgress(work.id)!.maxTurns > 0">
                · {{ getWorkGoalProgress(work.id)!.turn }} / {{ getWorkGoalProgress(work.id)!.maxTurns }}
              </template>
            </span>
          </div>
        </div>
        <div class="flex flex-col items-end gap-1 shrink-0">
          <span class="text-xs text-base-content/40 hidden md:flex items-center gap-1.5 w-28 justify-end">
            <font-awesome-icon icon="clock" class="w-3 h-3 opacity-60" />
            {{ formatDate(work.update_time) }}
          </span>
          <div class="flex gap-0.5" @click.stop>
            <button
              v-if="canResumeGoalFromList(getWorkGoalProgress(work.id))"
              type="button"
              class="btn btn-ghost btn-xs btn-square text-warning"
              title="继续目标循环"
              @click="resumeGoalLoop(work.id)"
            >
              <font-awesome-icon icon="forward" class="w-3 h-3" />
            </button>
            <button
              v-if="canCancelGoalFromList(getWorkGoalProgress(work.id))"
              type="button"
              class="btn btn-ghost btn-xs btn-square text-error"
              title="取消目标循环"
              @click="cancelGoalLoop(work.id)"
            >
              <font-awesome-icon icon="stop" class="w-3 h-3" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-xs btn-square"
              title="封面"
              :disabled="coverBusy === work.id"
              @click="openEditDialog(work)"
            >
              <font-awesome-icon icon="palette" class="w-3 h-3" />
            </button>
            <button type="button" class="btn btn-ghost btn-xs btn-square" title="编辑" @click="openEditDialog(work)">
              <font-awesome-icon icon="edit" class="w-3 h-3" />
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-xs btn-square"
              title="备份"
              :disabled="backupBusy === work.id"
              @click="exportWork(work.id, work.title)"
            >
              <font-awesome-icon icon="download" class="w-3 h-3" />
            </button>
            <button type="button" class="btn btn-ghost btn-xs btn-square text-error" title="删除" @click="deleteWork(work.id, work.title)">
              <font-awesome-icon icon="trash" class="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建作品弹窗 -->
    <dialog :class="['modal modal-bottom sm:modal-middle', showCreateDialog && 'modal-open']">
      <div class="modal-box border border-base-300/80 shadow-2xl p-6 rounded-2xl max-w-2xl">
        <div class="flex items-center gap-3 mb-5">
          <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <font-awesome-icon icon="plus" class="text-lg" />
          </div>
          <div>
            <h3 class="text-lg font-bold">{{ t.createDialogTitle }}</h3>
            <p class="text-xs text-base-content/50">{{ t.createDialogSubtitle }}</p>
          </div>
        </div>

        <div class="space-y-4">
          <label class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">{{ t.titleFieldLabel }} <span class="text-error">*</span></span>
            </div>
            <input
              v-model="newWork.title"
              placeholder="给你的故事起个响亮的名字"
              class="input input-bordered w-full focus:input-primary text-sm rounded-lg"
              @keyup.enter="createWork"
            />
          </label>
          <label class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">{{ t.descFieldLabel }}</span>
            </div>
            <textarea
              v-model="newWork.description"
              placeholder="简单描述一下你的故事背景、核心创意或主角设定..."
              rows="4"
              class="textarea textarea-bordered w-full focus:textarea-primary text-sm rounded-lg resize-none leading-relaxed"
            />
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="form-control w-full">
              <div class="label py-1">
                <span class="label-text text-xs font-bold text-base-content/60">题材</span>
              </div>
              <input
                v-model="newWork.genre"
                list="genrePresets"
                placeholder="如：玄幻、都市"
                class="input input-bordered w-full focus:input-primary text-sm rounded-lg"
              />
            </label>
            <label class="form-control w-full">
              <div class="label py-1">
                <span class="label-text text-xs font-bold text-base-content/60">标签</span>
              </div>
              <input
                v-model="newWork.tags"
                placeholder="逗号分隔，如：爽文,群像"
                class="input input-bordered w-full focus:input-primary text-sm rounded-lg"
              />
            </label>
          </div>
          <datalist id="genrePresets">
            <option v-for="g in GENRE_PRESETS" :key="g" :value="g"></option>
          </datalist>
          <div class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">作品封面</span>
            </div>
            <div class="flex items-start gap-4">
              <div
                class="w-20 h-28 rounded-lg border border-base-300 overflow-hidden bg-base-200/60 shrink-0 flex items-center justify-center text-base-content/25"
              >
                <img
                  v-if="pendingCoverPreview"
                  :src="pendingCoverPreview"
                  alt="封面预览"
                  class="w-full h-full object-cover"
                />
                <font-awesome-icon v-else icon="book-open" class="text-xl" />
              </div>
              <div class="flex flex-wrap gap-2">
                <button type="button" class="btn btn-outline btn-sm" @click="triggerCoverPicker('create')">
                  选择封面
                </button>
                <button
                  v-if="pendingCoverPreview"
                  type="button"
                  class="btn btn-ghost btn-sm text-error"
                  @click="clearCreateCover"
                >
                  移除
                </button>
              </div>
            </div>
          </div>
          <div class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">篇幅类型</span>
            </div>
            <div class="grid grid-cols-1 gap-2">
              <label
                v-for="opt in novelLengthOptions"
                :key="opt.key"
                class="flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors"
                :class="newNovelLength === opt.key ? 'border-primary bg-primary/5' : 'border-base-300 hover:border-base-content/20'"
              >
                <input
                  v-model="newNovelLength"
                  type="radio"
                  name="novelLength"
                  class="radio radio-primary radio-sm mt-0.5"
                  :value="opt.key"
                />
                <div class="min-w-0">
                  <div class="text-sm font-semibold">{{ opt.label }}</div>
                  <div class="text-xs text-base-content/50 mt-0.5">{{ opt.description }}</div>
                  <div class="text-xs text-primary/80 mt-1">建议 {{ opt.summary }}</div>
                </div>
              </label>
              <label
                class="flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors"
                :class="newNovelLength === 'custom' ? 'border-primary bg-primary/5' : 'border-base-300 hover:border-base-content/20'"
              >
                <input
                  v-model="newNovelLength"
                  type="radio"
                  name="novelLength"
                  class="radio radio-primary radio-sm mt-0.5"
                  value="custom"
                />
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-semibold">自定义篇幅</div>
                  <div class="text-xs text-base-content/50 mt-0.5">由你设置总字数、{{ chapterUnit }}数和每{{ chapterUnit }}字数</div>
                  <div class="text-xs text-primary/80 mt-1">当前 {{ customLengthSummary }}</div>
                  <div v-if="newNovelLength === 'custom'" class="grid grid-cols-3 gap-2 mt-3">
                    <label class="form-control">
                      <span class="label-text text-[11px] text-base-content/50">目标总字数</span>
                      <input
                        v-model.number="customTargetTotalWords"
                        type="number"
                        min="1"
                        step="1000"
                        class="input input-bordered input-sm w-full rounded-lg"
                        @change="syncCustomWordsPerChapter"
                      />
                    </label>
                    <label class="form-control">
                      <span class="label-text text-[11px] text-base-content/50">目标{{ chapterUnit }}数</span>
                      <input
                        v-model.number="customTargetChapters"
                        type="number"
                        min="1"
                        step="1"
                        class="input input-bordered input-sm w-full rounded-lg"
                        @change="syncCustomWordsPerChapter"
                      />
                    </label>
                    <label class="form-control">
                      <span class="label-text text-[11px] text-base-content/50">每{{ chapterUnit }}字数</span>
                      <input
                        v-model.number="customWordsPerChapter"
                        type="number"
                        min="1"
                        step="100"
                        class="input input-bordered input-sm w-full rounded-lg"
                        @change="syncCustomTargetTotalWords"
                      />
                    </label>
                  </div>
                </div>
              </label>
            </div>
          </div>
        </div>

        <div class="modal-action gap-2 mt-6">
          <button type="button" class="btn btn-ghost btn-sm" @click="showCreateDialog = false; clearPendingCover()">取消</button>
          <button
            type="button"
            @click="createWork"
            :disabled="!newWork.title.trim() || creating"
            class="btn btn-primary btn-sm gap-2"
          >
            <font-awesome-icon v-if="creating" icon="spinner" spin class="w-3.5 h-3.5 mr-1" />
            {{ creating ? '创建中...' : t.createBtnText }}
          </button>
        </div>
      </div>
      <div class="modal-backdrop bg-black/40 backdrop-blur-xs" @click="showCreateDialog = false; clearPendingCover()"></div>
    </dialog>

    <!-- 编辑作品弹窗 -->
    <dialog :class="['modal modal-bottom sm:modal-middle', showEditDialog && 'modal-open']">
      <div class="modal-box border border-base-300/80 shadow-2xl p-6 rounded-2xl">
        <div class="flex items-center gap-3 mb-5">
          <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
            <font-awesome-icon icon="edit" class="text-lg" />
          </div>
          <div>
            <h3 class="text-lg font-bold">{{ t.editDialogTitle }}</h3>
            <p class="text-xs text-base-content/50">{{ t.editDialogSubtitle }}</p>
          </div>
        </div>

        <div class="space-y-4">
          <label class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">{{ t.titleFieldLabel }} <span class="text-error">*</span></span>
            </div>
            <input
              v-model="editWork.title"
              placeholder="作品名称"
              class="input input-bordered w-full focus:input-primary text-sm rounded-lg"
              @keyup.enter="saveWorkEdit"
            />
          </label>
          <label class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">{{ t.descFieldLabel }}</span>
            </div>
            <textarea
              v-model="editWork.description"
              placeholder="作品简介..."
              rows="4"
              class="textarea textarea-bordered w-full focus:textarea-primary text-sm rounded-lg resize-none leading-relaxed"
            />
          </label>
          <div class="grid grid-cols-3 gap-3">
            <label class="form-control w-full">
              <div class="label py-1">
                <span class="label-text text-xs font-bold text-base-content/60">状态</span>
              </div>
              <select v-model="editWork.status" class="select select-bordered select-sm w-full rounded-lg">
                <option v-for="s in STATUS_OPTIONS" :key="s.value" :value="s.value">{{ s.label }}</option>
              </select>
            </label>
            <label class="form-control w-full">
              <div class="label py-1">
                <span class="label-text text-xs font-bold text-base-content/60">题材</span>
              </div>
              <input
                v-model="editWork.genre"
                list="genrePresets"
                placeholder="如：玄幻"
                class="input input-bordered input-sm w-full focus:input-primary rounded-lg"
              />
            </label>
            <label class="form-control w-full">
              <div class="label py-1">
                <span class="label-text text-xs font-bold text-base-content/60">标签</span>
              </div>
              <input
                v-model="editWork.tags"
                placeholder="逗号分隔"
                class="input input-bordered input-sm w-full focus:input-primary rounded-lg"
              />
            </label>
          </div>
          <div class="form-control w-full">
            <div class="label py-1">
              <span class="label-text text-xs font-bold text-base-content/60">作品封面</span>
            </div>
            <div class="flex items-start gap-4">
              <div
                class="w-24 h-32 rounded-lg border border-base-300 overflow-hidden bg-base-200/60 shrink-0 flex items-center justify-center text-base-content/25"
              >
                <img
                  v-if="editWork.cover_image"
                  :src="workCoverSrc(editWork.cover_image)!"
                  alt="封面预览"
                  class="w-full h-full object-cover"
                />
                <font-awesome-icon v-else icon="book-open" class="text-2xl" />
              </div>
              <div class="flex flex-col gap-2">
                <button
                  type="button"
                  class="btn btn-outline btn-sm self-start"
                  :disabled="coverBusy === editWork.id"
                  @click="pickCoverForWork(editWork.id)"
                >
                  {{ editWork.cover_image ? '更换封面' : '选择封面' }}
                </button>
                <button
                  v-if="editWork.cover_image"
                  type="button"
                  class="btn btn-ghost btn-sm text-error self-start"
                  :disabled="coverBusy === editWork.id"
                  @click="removeCoverForWork(editWork.id)"
                >
                  移除封面
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-action gap-2 mt-6">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeEditDialog">取消</button>
          <button
            type="button"
            :disabled="!editWork.title.trim() || saving"
            class="btn btn-primary btn-sm gap-2"
            @click="saveWorkEdit"
          >
            <font-awesome-icon v-if="saving" icon="spinner" spin class="w-3.5 h-3.5 mr-1" />
            {{ saving ? '保存中...' : '保存' }}
          </button>
        </div>
      </div>
      <div class="modal-backdrop bg-black/40 backdrop-blur-xs" @click="closeEditDialog"></div>
    </dialog>

    <!-- 回收站弹窗 -->
    <dialog :class="['modal modal-bottom sm:modal-middle', showTrashDialog && 'modal-open']">
      <div class="modal-box border border-base-300/80 shadow-2xl p-6 rounded-2xl max-w-2xl">
        <div class="flex items-center gap-3 mb-5">
          <div class="w-10 h-10 rounded-xl bg-error/10 flex items-center justify-center text-error">
            <font-awesome-icon icon="trash-restore" class="text-lg" />
          </div>
          <div>
            <h3 class="text-lg font-bold">回收站</h3>
            <p class="text-xs text-base-content/50">{{ t.trashSubtitle }}</p>
          </div>
        </div>

        <div v-if="trashLoading" class="flex justify-center py-12">
          <span class="loading loading-spinner loading-md text-primary"></span>
        </div>

        <div v-else-if="trashWorks.length === 0" class="text-center py-12 text-base-content/40">
          <font-awesome-icon icon="inbox" class="text-3xl mb-3" />
          <p class="text-sm">回收站是空的</p>
        </div>

        <div v-else class="space-y-2 max-h-[50vh] overflow-y-auto">
          <div
            v-for="w in trashWorks"
            :key="w.id"
            class="flex items-center gap-3 p-3 rounded-lg border border-base-300/60 bg-base-200/40"
          >
            <div class="flex-1 min-w-0">
              <h4 class="font-semibold text-sm truncate">{{ w.title }}</h4>
              <p class="text-xs text-base-content/50 mt-0.5">
                {{ formatWords(w.stat_total_words) }} · {{ w.stat_completed_count }}/{{ w.stat_chapter_count }} {{ t.unitLabel }}
              </p>
            </div>
            <div class="flex gap-1 shrink-0">
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                :disabled="trashBusy === w.id"
                @click="restoreWork(w.id)"
              >
                <font-awesome-icon icon="rotate-left" class="w-3 h-3 mr-1" />
                恢复
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-xs text-error"
                :disabled="trashBusy === w.id"
                @click="purgeWork(w.id, w.title)"
              >
                <font-awesome-icon icon="trash" class="w-3 h-3 mr-1" />
                彻底删除
              </button>
            </div>
          </div>
        </div>

        <div class="modal-action mt-6">
          <button type="button" class="btn btn-ghost btn-sm" @click="showTrashDialog = false">关闭</button>
        </div>
      </div>
      <div class="modal-backdrop bg-black/40 backdrop-blur-xs" @click="showTrashDialog = false"></div>
    </dialog>

    <input
      ref="coverInputRef"
      type="file"
      :accept="WORK_COVER_ACCEPT"
      class="hidden"
      @change="handleCoverFileSelect"
    />
  </div>
</template>
