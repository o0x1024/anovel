<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  CausalChapterDecisionRecord,
  CausalChapterOutcome,
  CausalChapterPlan
} from '../../../../shared/causal-novel-types'

const props = defineProps<{ workId: number }>()

interface ChapterListItem {
  id: number
  title: string
  status: string
  hasContent: boolean
  wordCount: number
  ordinal: number
  stateRevision: number | null
  decisionStatus: CausalChapterDecisionRecord['status'] | null
}

interface ChapterDetail {
  chapter: {
    id: number
    title: string
    content: string
    wordCount: number
    status: string
    updateTime: string
    decisionCard: string
    qualityAssessment: unknown
    emotionAssessment: unknown
  }
  decision: CausalChapterDecisionRecord | null
  stateFacts: Array<{
    id: number
    entity: string
    key: string
    value: unknown
    transition: string
    irreversible: boolean
    evidence: string | null
  }>
  emotionalStates: Array<{
    characterName: string
    feltState: string
    displayedState: string
    unresolvedEmotion: string
    behavioralAftereffect: string
    sourceEvent: string
  }>
  versions: Array<{
    id: number
    versionNumber: number
    wordCount: number
    modelType: string | null
    generationRound: number
    createTime: string
    hasContent: boolean
  }>
}

interface VersionPreview {
  id: number
  versionNumber: number
  content: string
  wordCount: number
  modelType: string | null
  createTime: string
}

interface CausalStyleRewritePreview {
  chapterId: number
  originalContent: string
  candidateContent: string
  originalWordCount: number
  candidateWordCount: number
  evidenceAnchors: string[]
  auditReasons: string[]
  expectedUpdateTime: string
  validationToken: string
  styleId: number
  styleName: string
}

type DetailTab = 'decision' | 'outcome' | 'facts' | 'versions'

const chapters = ref<ChapterListItem[]>([])
const selectedId = ref<number | null>(null)
const detail = ref<ChapterDetail | null>(null)
const query = ref('')
const loading = ref(true)
const detailLoading = ref(false)
const drawerOpen = ref(false)
const activeTab = ref<DetailTab>('decision')
const versionPreview = ref<VersionPreview | null>(null)
const editMode = ref(true)
const editTitle = ref('')
const editContent = ref('')
const saving = ref(false)
const errorMessage = ref('')
const copied = ref(false)
const rewriteGenerating = ref(false)
const rewriteApplying = ref(false)
const rewritePreview = ref<CausalStyleRewritePreview | null>(null)
const currentPage = ref(1)
const pageSize = ref(10)
const listWidth = ref(240)
const layoutRef = ref<HTMLElement | null>(null)
const resizingList = ref(false)
let reloadTimer: number | null = null
let resizeStartX = 0
let resizeStartWidth = 0

const filteredChapters = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return keyword
    ? chapters.value.filter(chapter => chapter.title.toLowerCase().includes(keyword))
    : chapters.value
})
const totalPages = computed(() => Math.max(1, Math.ceil(filteredChapters.value.length / pageSize.value)))
const paginatedChapters = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return filteredChapters.value.slice(start, start + pageSize.value)
})
const selectedListItem = computed(() => chapters.value.find(chapter => chapter.id === selectedId.value) ?? null)
const decisionPlan = computed<CausalChapterPlan | null>(() => detail.value?.decision?.plan ?? null)
const outcome = computed<CausalChapterOutcome | null>(() => detail.value?.decision?.outcome ?? null)
const directEditLocked = computed(() => detail.value?.decision?.status === 'committed')
const titleEditLocked = computed(() => Boolean(detail.value?.decision))
const editWordCount = computed(() => editContent.value.replace(/\s/g, '').length)
const hasUnsavedChanges = computed(() => Boolean(
  editMode.value && detail.value && (
    editTitle.value.trim() !== detail.value.chapter.title ||
    editContent.value !== detail.value.chapter.content
  )
))

watch([query, pageSize], () => { currentPage.value = 1 })
watch(totalPages, value => {
  if (currentPage.value > value) currentPage.value = value
})
watch(pageSize, value => localStorage.setItem(`causal-chapter-page-size:${props.workId}`, String(value)))
watch(listWidth, value => localStorage.setItem(`causal-chapter-list-width:${props.workId}`, String(value)))

const tabLabels: Array<{ key: DetailTab; label: string }> = [
  { key: 'decision', label: '章节决策' },
  { key: 'outcome', label: '章后变化' },
  { key: 'facts', label: '事实证据' },
  { key: 'versions', label: '历史版本' }
]

function statusText(chapter: ChapterListItem): string {
  if (!chapter.decisionStatus) return '非权威草稿'
  if (chapter.decisionStatus === 'committed' && chapter.status === 'completed') return '已提交'
  if (chapter.hasContent) return '待验收'
  return '待生成'
}

function statusClass(chapter: ChapterListItem): string {
  if (!chapter.decisionStatus) return 'badge-info badge-outline'
  if (chapter.decisionStatus === 'committed' && chapter.status === 'completed') return 'badge-success'
  return chapter.hasContent ? 'badge-warning' : 'badge-ghost'
}

function formatTime(value: string): string {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function syncEditor(): void {
  editTitle.value = detail.value?.chapter.title ?? ''
  editContent.value = detail.value?.chapter.content ?? ''
}

async function loadChapters(keepDrawer = true): Promise<void> {
  try {
    const snapshot = await window.anovel.invoke('causal:getState', props.workId) as {
      state: unknown | null
      decisions: CausalChapterDecisionRecord[]
      chapters: Array<{ id: number; title: string; status: string; hasContent: boolean; wordCount: number }>
    }
    const decisions = new Map(snapshot.decisions.map(item => [item.chapterId, item]))
    chapters.value = snapshot.chapters.map((chapter, index) => {
      const decision = decisions.get(chapter.id)
      return {
        ...chapter,
        ordinal: index + 1,
        stateRevision: decision?.stateRevision ?? null,
        decisionStatus: decision?.status ?? null
      }
    })
    if (selectedId.value && !chapters.value.some(chapter => chapter.id === selectedId.value)) {
      selectedId.value = null
      detail.value = null
      drawerOpen.value = false
    }
    if (!selectedId.value && chapters.value.length) selectedId.value = chapters.value[0].id
    if (keepDrawer && selectedId.value && !hasUnsavedChanges.value) {
      await loadDetail(selectedId.value)
    }
  } catch (error) {
    errorMessage.value = String(error)
  } finally {
    loading.value = false
  }
}

async function loadDetail(chapterId: number): Promise<void> {
  selectedId.value = chapterId
  detailLoading.value = true
  versionPreview.value = null
  try {
    detail.value = await window.anovel.invoke(
      'causal:getChapterDetail', props.workId, chapterId
    ) as ChapterDetail
    syncEditor()
    editMode.value = true
  } finally {
    detailLoading.value = false
  }
}

async function selectChapter(chapterId: number): Promise<void> {
  if (chapterId === selectedId.value) return
  if (hasUnsavedChanges.value && !confirm('当前修改尚未保存，确定切换章节吗？')) return
  errorMessage.value = ''
  try {
    await loadDetail(chapterId)
  } catch (error) {
    errorMessage.value = String(error)
  }
}

async function openDrawer(tab: DetailTab): Promise<void> {
  if (!selectedId.value) return
  errorMessage.value = ''
  activeTab.value = tab
  versionPreview.value = null
  drawerOpen.value = true
}

function closeDrawer(): void {
  drawerOpen.value = false
  versionPreview.value = null
}

function cancelEditing(): void {
  if (hasUnsavedChanges.value && !confirm('放弃本次修改？')) return
  syncEditor()
}

function switchTab(tab: DetailTab): void {
  if (tab === activeTab.value) return
  activeTab.value = tab
  versionPreview.value = null
}

async function saveChapter(): Promise<void> {
  if (!detail.value || saving.value) return
  if (directEditLocked.value) {
    errorMessage.value = '已提交章节已冻结；只调整表达请使用“AI 按当前文风重写”'
    return
  }
  const title = editTitle.value.trim()
  if (!title) {
    errorMessage.value = '章节标题不能为空'
    return
  }
  saving.value = true
  errorMessage.value = ''
  try {
    const updated = await window.anovel.invoke(
      'causal:updateChapter', props.workId, detail.value.chapter.id,
      { title, content: editContent.value, expectedUpdateTime: detail.value.chapter.updateTime }
    ) as boolean
    if (!updated) throw new Error('章节已被其他操作修改，请刷新后重试')
    await loadChapters(false)
    await loadDetail(detail.value.chapter.id)
    editMode.value = true
  } catch (error) {
    errorMessage.value = String(error)
  } finally {
    saving.value = false
  }
}

async function deleteChapter(chapter: ChapterListItem): Promise<void> {
  if (chapter.decisionStatus === 'committed') {
    errorMessage.value = '已提交章节属于权威历史，不能直接删除'
    return
  }
  const warning = `删除草稿章节「${chapter.title}」会同时删除其未提交决策和历史版本，且无法恢复。确定继续？`
  if (!confirm(warning)) return
  errorMessage.value = ''
  try {
    await window.anovel.invoke('causal:deleteChapter', props.workId, chapter.id)
    await loadChapters(true)
  } catch (error) {
    errorMessage.value = String(error)
  }
}

async function openVersion(versionId: number): Promise<void> {
  if (!selectedId.value) return
  versionPreview.value = await window.anovel.invoke(
    'causal:getChapterVersion', props.workId, selectedId.value, versionId
  ) as VersionPreview
}

async function copyBody(content: string): Promise<void> {
  if (!content) return
  await navigator.clipboard.writeText(content)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1200)
}

async function generateStyleRewrite(): Promise<void> {
  if (!detail.value || rewriteGenerating.value) return
  if (hasUnsavedChanges.value) {
    errorMessage.value = '请先保存当前手动修改，再生成 AI 文风重写候选'
    return
  }
  rewriteGenerating.value = true
  errorMessage.value = ''
  try {
    rewritePreview.value = await window.anovel.invoke(
      'causal:rewriteChapterPreview', props.workId, detail.value.chapter.id
    ) as CausalStyleRewritePreview
  } catch (error) {
    errorMessage.value = String(error)
  } finally {
    rewriteGenerating.value = false
  }
}

async function applyStyleRewrite(): Promise<void> {
  const preview = rewritePreview.value
  if (!preview || rewriteApplying.value) return
  rewriteApplying.value = true
  errorMessage.value = ''
  try {
    const applied = await window.anovel.invoke('causal:applyChapterRewrite', {
      workId: props.workId,
      chapterId: preview.chapterId,
      candidateContent: preview.candidateContent,
      expectedUpdateTime: preview.expectedUpdateTime,
      validationToken: preview.validationToken
    }) as boolean
    if (!applied) throw new Error('应用重写失败')
    rewritePreview.value = null
    await loadChapters(false)
    await loadDetail(preview.chapterId)
  } catch (error) {
    errorMessage.value = String(error)
  } finally {
    rewriteApplying.value = false
  }
}

function onResizeMove(event: PointerEvent): void {
  if (!resizingList.value) return
  const layoutWidth = layoutRef.value?.clientWidth ?? 1200
  const maxWidth = Math.max(180, Math.min(420, layoutWidth - 520))
  listWidth.value = Math.round(Math.min(maxWidth, Math.max(180, resizeStartWidth + event.clientX - resizeStartX)))
}

function stopResize(): void {
  resizingList.value = false
  window.removeEventListener('pointermove', onResizeMove)
  window.removeEventListener('pointerup', stopResize)
}

function startResize(event: PointerEvent): void {
  resizeStartX = event.clientX
  resizeStartWidth = listWidth.value
  resizingList.value = true
  window.addEventListener('pointermove', onResizeMove)
  window.addEventListener('pointerup', stopResize)
  event.preventDefault()
}

function onProgress(payload: unknown): void {
  const event = payload as { workId?: number }
  if (event.workId !== props.workId) return
  if (reloadTimer != null) window.clearTimeout(reloadTimer)
  reloadTimer = window.setTimeout(() => void loadChapters(true), 500)
}

function onKeydown(event: KeyboardEvent): void {
  if (drawerOpen.value && event.key === 'Escape') closeDrawer()
}

onMounted(async () => {
  const storedPageSize = Number(localStorage.getItem(`causal-chapter-page-size:${props.workId}`))
  if ([5, 10, 20, 50, 100].includes(storedPageSize)) pageSize.value = storedPageSize
  const storedListWidth = Number(localStorage.getItem(`causal-chapter-list-width:${props.workId}`))
  if (Number.isFinite(storedListWidth)) listWidth.value = Math.min(420, Math.max(180, storedListWidth))
  window.anovel.on('goal:progress', onProgress)
  window.addEventListener('keydown', onKeydown)
  await loadChapters(true)
})

onUnmounted(() => {
  window.anovel.off('goal:progress', onProgress)
  window.removeEventListener('keydown', onKeydown)
  stopResize()
  if (reloadTimer != null) window.clearTimeout(reloadTimer)
})
</script>

<template>
  <div class="w-full min-w-0 space-y-4">
    <div class="flex items-start gap-3">
      <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
        <font-awesome-icon icon="book-open" class="text-lg" />
      </div>
      <div>
        <h3 class="text-lg font-bold">章节管理</h3>
        <p class="text-xs text-base-content/50 mt-1">左侧选择章节，右侧阅读或编辑正文；决策、变化、证据与版本使用抽屉查看。</p>
      </div>
      <span class="badge badge-sm badge-ghost ml-auto">{{ chapters.length }} 章</span>
    </div>

    <div v-if="errorMessage" class="alert alert-error py-2 text-sm">
      <span>{{ errorMessage }}</span>
      <button type="button" class="btn btn-ghost btn-xs ml-auto" @click="errorMessage = ''">关闭</button>
    </div>

    <div class="card bg-base-100 border border-base-300 px-4 py-3 text-xs text-base-content/55 leading-relaxed">
      因果正文只能由“候选决策 → 正文门禁 → 状态提交”事务创建。章节管理用于查看权威历史、处理尚未提交的自动草稿，以及执行因果锁定文风重写。
    </div>

    <div v-if="loading" class="card bg-base-200 border border-base-300 p-8 text-center text-sm text-base-content/50">
      正在加载章节…
    </div>

    <div v-else-if="chapters.length === 0" class="card bg-base-200 border border-base-300 p-10 text-center space-y-2">
      <font-awesome-icon icon="book-open" class="text-3xl text-base-content/20" />
      <p class="font-semibold">尚无章节</p>
      <p class="text-xs text-base-content/50">初始化滚动因果后，可以自动运行，也可以在这里手动新增。</p>
    </div>

    <div
      v-else
      ref="layoutRef"
      class="grid gap-0 min-h-[560px]"
      :class="{ 'select-none': resizingList }"
      :style="{
        gridTemplateColumns: `${listWidth}px 8px minmax(0, 1fr)`,
        height: 'max(560px, calc(100vh - 17.5rem))'
      }"
    >
      <aside class="card bg-base-200 border border-base-300 shadow-sm p-3 flex flex-col min-h-0 h-full">
        <div class="flex items-center justify-between gap-2 mb-2 shrink-0">
          <h4 class="font-semibold text-sm">章节列表</h4>
          <label class="flex items-center gap-1 text-[11px] text-base-content/45">
            <select v-model.number="pageSize" class="select select-bordered select-xs h-6 min-h-6 px-1">
              <option :value="5">5</option>
              <option :value="10">10</option>
              <option :value="20">20</option>
              <option :value="50">50</option>
              <option :value="100">100</option>
            </select>
          </label>
        </div>
        <input v-model="query" class="input input-bordered input-sm w-full mb-2 shrink-0" placeholder="搜索章节标题" />
        <div v-if="filteredChapters.length" class="flex-1 overflow-y-auto space-y-1 min-h-0 -mx-1 px-1">
          <button
            v-for="chapter in paginatedChapters"
            :key="chapter.id"
            type="button"
            class="w-full text-left rounded-lg px-3 py-2.5 transition-colors border"
            :class="selectedId === chapter.id ? 'border-primary/40 bg-primary/10' : 'border-transparent hover:bg-base-100/80'"
            @click="selectChapter(chapter.id)"
          >
            <div class="flex items-center gap-2">
              <span class="text-xs text-base-content/40">{{ chapter.ordinal }}</span>
              <span class="font-medium text-sm truncate flex-1">{{ chapter.title }}</span>
            </div>
            <div class="flex items-center gap-2 mt-1.5 text-[11px] text-base-content/40">
              <span>正文 {{ chapter.wordCount }} 字</span>
              <span v-if="chapter.stateRevision != null">r{{ chapter.stateRevision }}</span>
              <span class="badge badge-xs ml-auto" :class="statusClass(chapter)">{{ statusText(chapter) }}</span>
            </div>
          </button>
        </div>
        <p v-else class="flex-1 grid place-items-center text-sm text-base-content/40">没有匹配的章节。</p>
        <div v-if="filteredChapters.length" class="flex items-center justify-between gap-2 mt-3 pt-2 border-t border-base-300/50 shrink-0">
          <span class="text-[11px] text-base-content/45">共 {{ filteredChapters.length }} 章</span>
          <div class="flex items-center gap-1">
            <button type="button" class="btn btn-outline btn-xs" :disabled="currentPage <= 1" @click="currentPage--">‹</button>
            <span class="text-xs tabular-nums min-w-12 text-center">{{ currentPage }} / {{ totalPages }}</span>
            <button type="button" class="btn btn-outline btn-xs" :disabled="currentPage >= totalPages" @click="currentPage++">›</button>
          </div>
        </div>
      </aside>

      <button
        type="button"
        class="group relative cursor-col-resize touch-none flex items-stretch justify-center"
        aria-label="拖动调整章节列表宽度"
        title="拖动调整章节列表宽度"
        @pointerdown="startResize"
      >
        <span class="w-px bg-base-300 group-hover:bg-primary transition-colors" :class="{ 'bg-primary': resizingList }" />
        <span class="absolute top-1/2 -translate-y-1/2 w-1.5 h-10 rounded-full bg-base-300 group-hover:bg-primary transition-colors" :class="{ 'bg-primary': resizingList }" />
      </button>

      <main class="card bg-base-200 border border-base-300 shadow-sm px-4 pt-4 pb-0 min-w-0 min-h-0 h-full flex flex-col ml-1 overflow-hidden">
        <div v-if="detailLoading" class="flex-1 grid place-items-center text-sm text-base-content/50">正在加载章节正文…</div>
        <template v-else-if="detail">
          <div class="flex items-start justify-between gap-3 mb-3 flex-wrap shrink-0">
            <div class="min-w-0">
              <h4 class="font-semibold text-base truncate">{{ detail.chapter.title }}</h4>
              <p class="text-[11px] text-base-content/40 mt-1">{{ detail.chapter.wordCount }} 字 · {{ formatTime(detail.chapter.updateTime) }}</p>
            </div>
            <div class="flex items-center gap-1 flex-wrap justify-end">
              <button
                type="button"
                class="btn btn-outline btn-primary btn-xs gap-1"
                :disabled="rewriteGenerating || rewriteApplying || !detail.chapter.content"
                title="锁定本章情节、事实、证据与章后状态，只按当前绑定文风重写表达"
                @click="generateStyleRewrite"
              >
                <font-awesome-icon :icon="rewriteGenerating ? 'spinner' : 'wand-magic-sparkles'" :spin="rewriteGenerating" class="w-3 h-3" />
                {{ rewriteGenerating ? '重写并审计中…' : 'AI 按当前文风重写' }}
              </button>
              <button v-for="tab in tabLabels" :key="tab.key" type="button" class="btn btn-ghost btn-xs" @click="openDrawer(tab.key)">{{ tab.label }}</button>
              <span class="w-px h-4 bg-base-300 mx-1" />
              <button type="button" class="btn btn-ghost btn-xs text-error gap-1" :disabled="!selectedListItem || directEditLocked" :title="directEditLocked ? '已提交章节属于权威历史，不能直接删除' : '删除草稿章节'" @click="selectedListItem && deleteChapter(selectedListItem)"><font-awesome-icon icon="trash" class="w-3 h-3" />删除</button>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-2 mb-3 shrink-0">
            <input v-model="editTitle" class="input input-bordered input-sm min-w-0 flex-1" placeholder="章节标题" :disabled="titleEditLocked" />
            <span class="text-xs text-base-content/45">{{ editWordCount }} 字</span>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="directEditLocked || saving || !hasUnsavedChanges" @click="cancelEditing">还原修改</button>
            <button type="button" class="btn btn-primary btn-sm" :disabled="directEditLocked || saving || !editTitle.trim()" @click="saveChapter">{{ saving ? '保存中…' : '保存修改' }}</button>
          </div>
          <p v-if="detail.decision?.status === 'committed'" class="rounded-lg bg-warning/10 border border-warning/30 px-3 py-2 text-xs text-warning-content mb-3 shrink-0">
            这是已提交的权威章节，正文和标题已冻结。只调整表达请使用上方“AI 按当前文风重写”；事实修改需要后续因果重放流程。
          </p>
          <textarea v-model="editContent" :disabled="directEditLocked" class="textarea textarea-bordered w-full flex-1 min-h-[460px] resize-none rounded-b-none border-b-0 font-serif text-[16px] leading-8 bg-base-100 disabled:bg-base-100 disabled:text-base-content/90" placeholder="输入章节正文" />
        </template>
        <p v-else class="flex-1 grid place-items-center text-sm text-base-content/40">请从左侧选择章节</p>
      </main>
    </div>

    <Teleport to="body">
      <div v-if="rewritePreview" class="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4">
        <div class="card bg-base-100 border border-base-300 shadow-2xl w-[96vw] max-w-6xl h-[88vh] overflow-hidden flex flex-col">
          <header class="px-5 py-3 border-b border-base-300 flex items-center gap-3 shrink-0">
            <div class="min-w-0 flex-1">
              <h2 class="font-bold">因果锁定文风重写 · {{ detail?.chapter.title }}</h2>
              <p class="text-xs text-base-content/50 mt-1">
                文风：{{ rewritePreview.styleName }} · 原文 {{ rewritePreview.originalWordCount }} 字 · 候选 {{ rewritePreview.candidateWordCount }} 字 · 锁定 {{ rewritePreview.evidenceAnchors.length }} 条逐字证据
              </p>
            </div>
            <span class="badge badge-success badge-outline">因果一致性审计通过</span>
            <button type="button" class="btn btn-ghost btn-sm btn-circle" aria-label="关闭" :disabled="rewriteApplying" @click="rewritePreview = null"><font-awesome-icon icon="times" /></button>
          </header>
          <div class="grid grid-cols-2 flex-1 min-h-0">
            <section class="min-w-0 min-h-0 border-r border-base-300 flex flex-col">
              <h3 class="px-4 py-2 text-xs font-semibold text-base-content/55 border-b border-base-300 bg-base-200/50 shrink-0">当前正文（应用后自动进入历史版本）</h3>
              <pre class="flex-1 overflow-auto whitespace-pre-wrap p-4 text-sm leading-7 font-serif text-base-content/75">{{ rewritePreview.originalContent }}</pre>
            </section>
            <section class="min-w-0 min-h-0 flex flex-col">
              <h3 class="px-4 py-2 text-xs font-semibold text-primary border-b border-base-300 bg-primary/5 shrink-0">重写候选（情节、事实和逐字证据已锁定）</h3>
              <pre class="flex-1 overflow-auto whitespace-pre-wrap p-4 text-sm leading-7 font-serif">{{ rewritePreview.candidateContent }}</pre>
            </section>
          </div>
          <footer class="px-5 py-3 border-t border-base-300 flex items-center gap-3 shrink-0">
            <p class="text-xs text-base-content/45 flex-1">应用只替换正文与字数，保留因果状态修订号、章后事实和情绪账本。</p>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="rewriteApplying" @click="rewritePreview = null">保留原文</button>
            <button type="button" class="btn btn-primary btn-sm" :disabled="rewriteApplying" @click="applyStyleRewrite">
              <font-awesome-icon v-if="rewriteApplying" icon="spinner" spin class="w-3.5 h-3.5" />
              {{ rewriteApplying ? '正在应用…' : '应用重写候选' }}
            </button>
          </footer>
        </div>
      </div>
    </Teleport>

    <Teleport to="body">
      <Transition name="chapter-drawer">
        <div v-if="drawerOpen" class="fixed inset-0 z-[100] flex justify-end">
          <button type="button" class="drawer-backdrop absolute inset-0 bg-black/30 cursor-default" aria-label="关闭章节详情" @click="closeDrawer" />
          <aside class="drawer-panel relative h-full w-[min(42rem,90vw)] bg-base-100 shadow-2xl border-l border-base-300 flex flex-col">
          <header class="px-4 py-3 border-b border-base-300 shrink-0 space-y-3">
            <div class="flex items-center gap-2">
              <div class="min-w-0 flex-1">
                <h2 class="font-bold truncate">{{ tabLabels.find(tab => tab.key === activeTab)?.label }} · {{ detail?.chapter.title || '章节详情' }}</h2>
                <p v-if="detail" class="text-[11px] text-base-content/40 mt-0.5">正文 {{ detail.chapter.wordCount }} 字 · {{ formatTime(detail.chapter.updateTime) }}</p>
              </div>
              <button type="button" class="btn btn-ghost btn-sm btn-circle ml-1" aria-label="关闭" @click="closeDrawer">
                <font-awesome-icon icon="times" />
              </button>
            </div>
            <div class="tabs tabs-boxed bg-base-200/70 overflow-x-auto flex-nowrap">
              <button
                v-for="tab in tabLabels"
                :key="tab.key"
                class="tab tab-sm whitespace-nowrap flex-1"
                :class="{ 'tab-active': activeTab === tab.key }"
                @click="switchTab(tab.key)"
              >{{ tab.label }}</button>
            </div>
          </header>

          <div v-if="detailLoading" class="flex-1 grid place-items-center text-sm text-base-content/50">正在加载章节详情…</div>

          <div v-else-if="detail" class="flex-1 min-h-0 overflow-y-auto p-5 sm:p-7">
            <section v-if="activeTab === 'decision'" class="max-w-4xl mx-auto space-y-4">
              <div v-if="decisionPlan" class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                <div class="card bg-base-200 border border-base-300 p-4"><span class="text-xs text-base-content/40">发起人 / 视角</span><p class="mt-1">{{ decisionPlan.decision.initiator }} / {{ decisionPlan.decision.pov }}</p></div>
                <div class="card bg-base-200 border border-base-300 p-4"><span class="text-xs text-base-content/40">即时目标</span><p class="mt-1">{{ decisionPlan.decision.immediateWant }}</p></div>
                <div class="card bg-base-200 border border-base-300 p-4"><span class="text-xs text-base-content/40">选择行动</span><p class="mt-1">{{ decisionPlan.decision.chosenAction }}</p></div>
                <div class="card bg-base-200 border border-base-300 p-4"><span class="text-xs text-base-content/40">阻力与代价</span><p class="mt-1">{{ decisionPlan.decision.opposition }}；{{ decisionPlan.decision.cost }}</p></div>
              </div>
              <div v-if="decisionPlan" class="card bg-base-200 border border-base-300 p-4 space-y-2">
                <p class="text-xs font-bold text-base-content/50">必须覆盖</p>
                <p v-for="item in decisionPlan.decision.mustCover" :key="item" class="text-sm">• {{ item }}</p>
                <p class="text-xs font-bold text-base-content/50 pt-2">禁止越界</p>
                <p v-for="item in decisionPlan.decision.forbiddenEvents" :key="item" class="text-sm">• {{ item }}</p>
              </div>
              <div v-if="decisionPlan" class="card bg-base-200 border border-base-300 p-4 space-y-3">
                <div class="flex items-center gap-2"><p class="text-xs font-bold text-base-content/50">本章因果情绪事务</p><span class="badge badge-xs badge-primary">{{ decisionPlan.emotionContract.arc_role }}</span></div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div><span class="text-xs text-base-content/40">依恋依据</span><p class="mt-1">{{ decisionPlan.emotionContract.attachment_anchor }}</p></div>
                  <div><span class="text-xs text-base-content/40">被威胁的价值</span><p class="mt-1">{{ decisionPlan.emotionContract.value_at_stake }}</p></div>
                  <div><span class="text-xs text-base-content/40">人物主观意义</span><p class="mt-1">{{ decisionPlan.emotionContract.character_appraisal.perceived_meaning }}</p></div>
                  <div><span class="text-xs text-base-content/40">选择与代价</span><p class="mt-1">{{ decisionPlan.emotionContract.choice_and_cost }}</p></div>
                  <div><span class="text-xs text-base-content/40">私人细节锚点</span><p class="mt-1">{{ decisionPlan.emotionContract.private_detail_anchor }}</p></div>
                  <div><span class="text-xs text-base-content/40">带入下一章的余波</span><p class="mt-1">{{ decisionPlan.emotionContract.residue_into_next }}</p></div>
                </div>
                <div><p class="text-xs text-base-content/40 mb-1">权威依据</p><div class="flex flex-wrap gap-1"><span v-for="refItem in decisionPlan.emotionContract.grounding_refs" :key="refItem" class="badge badge-sm badge-outline">{{ refItem }}</span></div></div>
              </div>
              <div v-if="decisionPlan" class="space-y-2">
                <h3 class="font-semibold text-sm">候选事件与评分</h3>
                <div v-for="candidate in decisionPlan.candidates" :key="candidate.id" class="rounded-lg border p-3" :class="candidate.id === decisionPlan.selectedCandidateId ? 'border-primary bg-primary/5' : 'border-base-300'">
                  <div class="flex gap-2"><span class="font-semibold text-sm">{{ candidate.action }}</span><span class="badge badge-xs ml-auto">{{ candidate.scores.total }}分</span></div>
                  <p class="text-xs text-base-content/50 mt-1">阻力：{{ candidate.opposition }} · 代价：{{ candidate.cost }}</p>
                </div>
              </div>
              <div v-if="decisionPlan?.rollingHorizon?.length" class="space-y-2">
                <h3 class="font-semibold text-sm">近期滚动窗口</h3>
                <div v-for="beat in decisionPlan.rollingHorizon" :key="beat.offset" class="rounded-lg border border-base-300 p-3 text-sm">
                  <div class="flex items-center gap-2"><span class="badge badge-xs" :class="beat.offset === 0 ? 'badge-primary' : 'badge-ghost'">+{{ beat.offset }}</span><strong>{{ beat.objective }}</strong></div>
                  <p class="text-xs text-base-content/55 mt-1">预期不可逆变化：{{ beat.expectedIrreversibleChange }}</p>
                  <p class="text-xs text-base-content/40 mt-1">重算触发：{{ beat.replanningTrigger }}</p>
                </div>
              </div>
              <p v-if="!decisionPlan" class="text-sm text-base-content/40 text-center py-16">手动章节没有自动生成的因果决策记录。</p>
            </section>

            <section v-else-if="activeTab === 'outcome'" class="max-w-4xl mx-auto space-y-4">
              <template v-if="outcome">
                <div class="card bg-base-200 border border-base-300 p-4"><p class="text-xs text-base-content/40">章后摘要</p><p class="mt-1 text-sm">{{ outcome.summary }}</p></div>
                <div class="card bg-base-200 border border-base-300 p-4 space-y-2">
                  <p class="text-xs font-bold text-base-content/50">已经挣得的情绪结果</p>
                  <p class="text-sm">{{ outcome.emotionalOutcome.readerEffectSummary }}</p>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-base-content/60">
                    <p>触发证据：“{{ outcome.emotionalOutcome.triggerEvidence }}”</p><p>选择证据：“{{ outcome.emotionalOutcome.choiceEvidence }}”</p>
                    <p>代价证据：“{{ outcome.emotionalOutcome.costEvidence }}”</p><p>余波证据：“{{ outcome.emotionalOutcome.residueEvidence }}”</p>
                  </div>
                  <p v-if="outcome.emotionalOutcome.emotionalDebtOpened" class="text-sm">新增情绪债：{{ outcome.emotionalOutcome.emotionalDebtOpened }}</p>
                  <p v-if="outcome.emotionalOutcome.emotionalDebtPaid" class="text-sm">本章兑现：{{ outcome.emotionalOutcome.emotionalDebtPaid }}</p>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div class="card bg-base-200 border border-base-300 p-4"><p class="text-xs font-bold text-base-content/50">推进的读者承诺</p><p class="text-sm mt-2">{{ outcome.advancedPromiseIds.join('、') || '无' }}</p></div>
                  <div class="card bg-base-200 border border-base-300 p-4"><p class="text-xs font-bold text-base-content/50">关闭的读者承诺</p><p class="text-sm mt-2">{{ outcome.resolvedPromiseIds.join('、') || '无' }}</p></div>
                </div>
                <div v-if="outcome.newPromises.length" class="space-y-2"><h3 class="font-semibold text-sm">新增读者承诺</h3><div v-for="item in outcome.newPromises" :key="item.id" class="rounded-lg border border-base-300 p-3 text-sm"><strong>{{ item.id }}</strong>：{{ item.question }}</div></div>
                <div v-if="outcome.actorUpdates.length" class="space-y-2">
                  <h3 class="font-semibold text-sm">人物状态变化</h3>
                  <div v-for="item in outcome.actorUpdates" :key="`${item.actor}-${item.evidence}`" class="rounded-lg border border-base-300 p-3 text-sm space-y-1">
                    <strong>{{ item.actor }}</strong><p v-if="item.currentGoal">当前目标 → {{ item.currentGoal }}</p><p v-if="item.constraint">约束 → {{ item.constraint }}</p>
                    <p v-if="item.knowledgeAdded?.length">新增认知：{{ item.knowledgeAdded.join('、') }}</p><p v-if="item.resourcesAdded?.length">获得资源：{{ item.resourcesAdded.join('、') }}</p><p v-if="item.resourcesRemoved?.length">失去资源：{{ item.resourcesRemoved.join('、') }}</p>
                    <p class="text-xs text-base-content/60 pt-1">证据：“{{ item.evidence }}”</p>
                  </div>
                </div>
                <div v-if="outcome.newActors?.length" class="space-y-2">
                  <h3 class="font-semibold text-sm">进入权威状态的新人物</h3>
                  <div v-for="item in outcome.newActors" :key="item.actor.name" class="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                    <strong>{{ item.actor.name }}</strong><p class="mt-1">当前目标：{{ item.actor.currentGoal }}</p><p class="text-xs text-base-content/60 mt-1">证据：“{{ item.evidence }}”</p>
                  </div>
                </div>
                <div v-if="outcome.pressureUpdates.length || outcome.newPressures.length" class="space-y-2">
                  <h3 class="font-semibold text-sm">世界压力变化</h3>
                  <div v-for="item in outcome.pressureUpdates" :key="item.id" class="rounded-lg border border-base-300 p-3 text-sm"><strong>{{ item.id }}</strong>：{{ item.status }}<span v-if="item.urgency != null"> · 紧迫度 {{ item.urgency }}</span><p v-if="item.condition" class="mt-1">条件 → {{ item.condition }}</p><p class="text-xs text-base-content/60 mt-1">证据：“{{ item.evidence }}”</p></div>
                  <div v-for="item in outcome.newPressures" :key="item.pressure.id" class="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"><strong>新增 · {{ item.pressure.id }}</strong>：{{ item.pressure.source }} → {{ item.pressure.target }}<p class="mt-1">紧迫度 {{ item.pressure.urgency }} · 条件：{{ item.pressure.condition }}</p><p class="mt-1">升级方式：{{ item.pressure.escalation }}</p><p class="text-xs text-base-content/60 mt-1">证据：“{{ item.evidence }}”</p></div>
                </div>
              </template>
              <p v-else class="text-sm text-base-content/40 text-center py-16">本章尚未提交章后因果状态。</p>
            </section>

            <section v-else-if="activeTab === 'facts'" class="max-w-4xl mx-auto space-y-4">
              <div v-if="detail.stateFacts.length" class="space-y-2">
                <div v-for="fact in detail.stateFacts" :key="fact.id" class="rounded-lg border border-base-300 p-3">
                  <div class="flex items-center gap-2 text-sm"><strong>{{ fact.entity }}.{{ fact.key }}</strong><span class="badge badge-xs">{{ fact.transition }}</span><span v-if="fact.irreversible" class="badge badge-error badge-xs">不可逆</span></div>
                  <pre class="text-xs whitespace-pre-wrap mt-2 font-sans">{{ formatValue(fact.value) }}</pre><p v-if="fact.evidence" class="text-xs text-base-content/50 mt-2">证据：“{{ fact.evidence }}”</p>
                </div>
              </div>
              <div v-if="detail.emotionalStates.length" class="space-y-2"><h3 class="font-semibold text-sm">人物情绪余波</h3><div v-for="item in detail.emotionalStates" :key="item.characterName" class="rounded-lg border border-base-300 p-3 text-sm"><strong>{{ item.characterName }}</strong><p class="text-xs text-base-content/60 mt-1">{{ item.feltState }}；后续影响：{{ item.behavioralAftereffect }}</p></div></div>
              <p v-if="!detail.stateFacts.length && !detail.emotionalStates.length" class="text-sm text-base-content/40 text-center py-16">本章尚无已提交事实证据。</p>
            </section>

            <section v-else class="max-w-4xl mx-auto">
              <template v-if="versionPreview">
                <div class="flex items-center gap-2 mb-4"><button type="button" class="btn btn-outline btn-xs" @click="versionPreview = null">← 返回版本列表</button><span class="text-xs text-base-content/45">v{{ versionPreview.versionNumber }} · {{ versionPreview.wordCount }} 字 · {{ formatTime(versionPreview.createTime) }}</span><button type="button" class="btn btn-ghost btn-xs ml-auto" :disabled="!versionPreview.content" @click="copyBody(versionPreview.content)">{{ copied ? '已复制' : '复制' }}</button></div>
                <article v-if="versionPreview.content" class="whitespace-pre-wrap text-[16px] leading-8 font-serif text-base-content/90">{{ versionPreview.content }}</article>
                <p v-else class="text-sm text-base-content/40 text-center py-16">该版本没有正文内容。</p>
              </template>
              <template v-else>
                <div class="space-y-2"><div v-for="version in detail.versions" :key="version.id" class="flex items-center gap-3 rounded-lg border border-base-300 p-3"><div class="min-w-0 flex-1"><p class="font-semibold text-sm">版本 v{{ version.versionNumber }}</p><p class="text-xs text-base-content/40 mt-1">{{ formatTime(version.createTime) }} · {{ version.wordCount }} 字 · {{ version.modelType || '未标记来源' }}</p></div><button type="button" class="btn btn-outline btn-xs" :disabled="!version.hasContent" @click="openVersion(version.id)">查看</button></div></div>
                <p v-if="detail.versions.length === 0" class="text-sm text-base-content/40 text-center py-16">本章暂无历史版本。手动保存正文后会自动保留修改前快照。</p>
              </template>
            </section>
          </div>
          </aside>
        </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.chapter-drawer-enter-active,
.chapter-drawer-leave-active,
.chapter-drawer-enter-active .drawer-backdrop,
.chapter-drawer-leave-active .drawer-backdrop,
.chapter-drawer-enter-active .drawer-panel,
.chapter-drawer-leave-active .drawer-panel {
  transition: opacity 220ms ease, transform 220ms ease;
}

.chapter-drawer-enter-from .drawer-backdrop,
.chapter-drawer-leave-to .drawer-backdrop {
  opacity: 0;
}

.chapter-drawer-enter-from .drawer-panel,
.chapter-drawer-leave-to .drawer-panel {
  transform: translateX(100%);
}
</style>
