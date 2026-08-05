<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

interface GlobalModel {
  provider: string
  model: string
}

interface NovelSummary {
  id: number
  title: string
  revision: number
  stateHash: string
  chapterCount: number
}

interface NovelDetail {
  id: number
  title: string
  state: { revision: number; stateHash: string }
  chapters: Array<{ id: string; chapterOrdinal: number; content: string; committedRevision: number }>
}

interface AutoNovelRun {
  id: string
  status: 'running' | 'blocked' | 'cancelled' | 'completed'
  currentPhase: string
  targetChapters: number
  recoveredFromRunId?: string
  errorCode?: string
  errorMessage?: string
}

interface AutoNovelProgress {
  run: AutoNovelRun
  committedChapterCount: number
  currentChapter?: {
    ordinal: number
    status: 'running' | 'blocked' | 'cancelled' | 'completed'
    phase: 'generate_candidate' | 'extract_patch' | 'editorial_review' | 'revise_candidate' | 'commit_chapter' | 'completed'
    editorialGateIndex: number
    editorialGateCount: number
    repairCount: number
    maxRepairs: number
    candidate?: { id: string; content: string; wordCount: number }
  }
}

interface ReaderChapter {
  key: string
  ordinal: number
  status: 'committed' | 'draft'
  content: string
  wordCount: number
  revision?: number
}

const globalModel = ref<GlobalModel | null>(null)
const route = useRoute()
const router = useRouter()
const novels = ref<NovelSummary[]>([])
const selectedNovelId = ref<number | null>(null)
const detail = ref<NovelDetail | null>(null)
const runs = ref<AutoNovelRun[]>([])
const autoProgress = ref<AutoNovelProgress | null>(null)
const selectedReaderKey = ref<string | null>(null)
const newTitle = ref('')
const premise = ref('')
const targetChapters = ref(20)
const minWords = ref(1800)
const maxWords = ref(2600)
const loading = ref(false)
const running = ref(false)
const message = ref('')
const error = ref('')

const selectedNovel = computed(() => novels.value.find(novel => novel.id === selectedNovelId.value) ?? null)
const canStart = computed(() => Boolean(
  selectedNovel.value && premise.value.trim().length >= 10 &&
  Number.isInteger(targetChapters.value) && targetChapters.value > 0 && targetChapters.value <= 2000 &&
  Number.isInteger(minWords.value) && Number.isInteger(maxWords.value) &&
  minWords.value > 0 && maxWords.value >= minWords.value && !running.value
))
const hasActiveAutoRun = computed(() => runs.value.some(run => run.status === 'running'))
const observedRun = computed(() => runs.value.find(run => run.status === 'running') ?? runs.value[0] ?? null)
const overallPercent = computed(() => {
  if (!autoProgress.value) return 0
  return Math.floor((autoProgress.value.committedChapterCount / autoProgress.value.run.targetChapters) * 100)
})
const readerChapters = computed<ReaderChapter[]>(() => {
  const committed = (detail.value?.chapters ?? []).map(chapter => ({
    key: `committed:${chapter.id}`,
    ordinal: chapter.chapterOrdinal,
    status: 'committed' as const,
    content: chapter.content,
    wordCount: countWords(chapter.content),
    revision: chapter.committedRevision
  }))
  const candidate = autoProgress.value?.currentChapter?.candidate
  if (!candidate || !autoProgress.value?.currentChapter) return committed
  return [...committed, {
    key: `draft:${candidate.id}`,
    ordinal: autoProgress.value.currentChapter.ordinal,
    status: 'draft' as const,
    content: candidate.content,
    wordCount: candidate.wordCount
  }]
})
const selectedReaderChapter = computed(() => (
  readerChapters.value.find(chapter => chapter.key === selectedReaderKey.value) ?? readerChapters.value.at(-1) ?? null
))
let pollingTimer: ReturnType<typeof setInterval> | undefined

function showError(value: unknown): void {
  error.value = value instanceof Error ? value.message : String(value)
  message.value = ''
}

function countWords(content: string): number {
  return content.replace(/\s/g, '').length
}

function syncReaderSelection(): void {
  if (readerChapters.value.some(chapter => chapter.key === selectedReaderKey.value)) return
  selectedReaderKey.value = readerChapters.value.at(-1)?.key ?? null
}

function phaseLabel(progress: AutoNovelProgress): string {
  if (progress.run.status === 'completed') return '全书已完成并通过逐章验收'
  if (progress.run.status === 'blocked') return '运行已暂停，等待处理'
  if (progress.run.status === 'cancelled') return '运行已取消'
  if (progress.run.currentPhase === 'plan_novel') return '正在规划全书蓝图'
  const current = progress.currentChapter
  if (!current) return '正在准备下一章'
  const prefix = `第 ${current.ordinal} 章：`
  switch (current.phase) {
    case 'generate_candidate': return `${prefix}正在生成正文`
    case 'extract_patch': return `${prefix}正在提取叙事状态与证据`
    case 'editorial_review': return `${prefix}正在执行文学审校（${current.editorialGateIndex + 1}/${current.editorialGateCount}）`
    case 'revise_candidate': return `${prefix}正在根据审校结果修订（${current.repairCount + 1}/${current.maxRepairs}）`
    case 'commit_chapter': return `${prefix}正在原子提交`
    case 'completed': return `${prefix}已提交`
  }
}

async function loadGlobalModel(): Promise<void> {
  globalModel.value = await window.anovel.invoke('narrativeV2:getGlobalModel') as GlobalModel
}

async function loadNovels(): Promise<void> {
  if (!globalModel.value) {
    novels.value = []
    selectedNovelId.value = null
    return
  }
  loading.value = true
  try {
    novels.value = await window.anovel.invoke('narrativeV2:listNovels') as NovelSummary[]
    if (!novels.value.some(novel => novel.id === selectedNovelId.value)) {
      selectedNovelId.value = novels.value[0]?.id ?? null
    }
  } catch (cause) {
    showError(cause)
  } finally {
    loading.value = false
  }
}

async function loadDetail(): Promise<void> {
  if (!globalModel.value || selectedNovelId.value == null) {
    detail.value = null
    runs.value = []
    autoProgress.value = null
    return
  }
  loading.value = true
  try {
    const [novel, nextRuns] = await Promise.all([
      window.anovel.invoke('narrativeV2:getNovel', selectedNovelId.value),
      window.anovel.invoke('narrativeV2:listAutoNovelRuns', selectedNovelId.value)
    ])
    detail.value = novel as NovelDetail
    novels.value = [{
      id: detail.value.id,
      title: detail.value.title,
      revision: detail.value.state.revision,
      stateHash: detail.value.state.stateHash,
      chapterCount: detail.value.chapters.length
    }]
    runs.value = nextRuns as AutoNovelRun[]
    const observed = observedRun.value
    autoProgress.value = observed
      ? await window.anovel.invoke('narrativeV2:getAutoNovelProgress', observed.id) as AutoNovelProgress
      : null
    syncReaderSelection()
  } catch (cause) {
    showError(cause)
  } finally {
    loading.value = false
  }
}

async function refresh(): Promise<void> {
  error.value = ''
  try {
    await loadGlobalModel()
    await loadDetail()
  } catch (cause) {
    globalModel.value = null
    novels.value = []
    selectedNovelId.value = null
    detail.value = null
    runs.value = []
    autoProgress.value = null
    selectedReaderKey.value = null
    showError(cause)
  }
}

async function createNovel(): Promise<void> {
  if (!newTitle.value.trim() || !globalModel.value) return
  running.value = true
  error.value = ''
  try {
    const created = await window.anovel.invoke('narrativeV2:createNovel', newTitle.value.trim()) as NovelSummary
    newTitle.value = ''
    selectedNovelId.value = created.id
    message.value = `已创建《${created.title}》`
    await refresh()
  } catch (cause) {
    showError(cause)
  } finally {
    running.value = false
  }
}

async function startAutoNovel(): Promise<void> {
  if (!canStart.value || selectedNovelId.value == null) return
  running.value = true
  error.value = ''
  message.value = '正在自动规划全书，并逐章生成、提取证据、验收和提交…'
  try {
    const run = await window.anovel.invoke('narrativeV2:startAutoNovel', {
      novelId: selectedNovelId.value,
      premise: premise.value.trim(),
      targetChapters: targetChapters.value,
      wordRange: { min: minWords.value, max: maxWords.value }
    }) as AutoNovelRun
    message.value = `自动全书运行已在后台启动：${run.id}`
    await refresh()
  } catch (cause) {
    showError(cause)
  } finally {
    running.value = false
  }
}

async function resume(runId: string): Promise<void> {
  running.value = true
  error.value = ''
  try {
    const run = await window.anovel.invoke('narrativeV2:resumeAutoNovel', runId) as AutoNovelRun
    message.value = `运行 ${run.status === 'completed' ? '已完成' : `状态为 ${run.status}`}`
    await refresh()
  } catch (cause) {
    showError(cause)
  } finally {
    running.value = false
  }
}

async function recover(runId: string): Promise<void> {
  running.value = true
  error.value = ''
  try {
    const run = await window.anovel.invoke('narrativeV2:recoverAutoNovel', runId) as AutoNovelRun
    message.value = '已创建恢复运行，将从当前已提交章节继续生成。'
    await refresh()
    selectedReaderKey.value = null
    if (run.status !== 'running') throw new Error('恢复运行未能启动')
  } catch (cause) {
    showError(cause)
  } finally {
    running.value = false
  }
}

async function cancel(runId: string): Promise<void> {
  try {
    await window.anovel.invoke('narrativeV2:cancelAutoNovel', runId)
    message.value = '已请求取消；当前模型调用结束后运行会停止。'
    await loadDetail()
  } catch (cause) {
    showError(cause)
  }
}

async function exportNovel(): Promise<void> {
  if (selectedNovelId.value == null) return
  error.value = ''
  try {
    const result = await window.anovel.invoke('narrativeV2:export', selectedNovelId.value) as { cancelled: boolean; path?: string }
    if (!result.cancelled) message.value = `已导出发布稿：${result.path}`
  } catch (cause) {
    showError(cause)
  }
}

watch(selectedNovelId, () => { void loadDetail() })

onMounted(async () => {
  const routeNovelId = Number(route.params.id)
  if (!Number.isInteger(routeNovelId) || routeNovelId <= 0) {
    showError('小说 ID 无效')
    return
  }
  selectedNovelId.value = routeNovelId
  await refresh()
  pollingTimer = setInterval(() => {
    if (hasActiveAutoRun.value) void loadDetail()
  }, 2000)
})

onUnmounted(() => {
  if (pollingTimer) clearInterval(pollingTimer)
})
</script>

<template>
  <div class="p-8 max-w-7xl mx-auto space-y-6 animate-fade-in">
    <header class="flex flex-wrap items-start justify-between gap-4 border-b border-base-300 pb-5">
      <div>
        <div class="flex items-center gap-2 text-primary font-semibold text-sm">
          <font-awesome-icon icon="project-diagram" /> Narrative V2
        </div>
        <h2 class="text-3xl font-extrabold tracking-tight mt-1">V2 自动生成</h2>
        <p class="text-sm text-base-content/55 mt-2">
          在当前小说内执行全书规划、逐章生成、证据验收与原子提交。
        </p>
      </div>
      <div class="flex gap-2">
        <button class="btn btn-ghost btn-sm" @click="router.push('/')">返回小说列表</button>
        <button class="btn btn-outline btn-sm" :disabled="loading || running" @click="refresh">
          <font-awesome-icon icon="sync" :class="{ 'animate-spin': loading }" /> 刷新
        </button>
      </div>
    </header>

    <div v-if="error" class="alert alert-error">
      <font-awesome-icon icon="exclamation-circle" />
      <span>{{ error }}</span>
    </div>
    <div v-if="message" class="alert alert-info">
      <font-awesome-icon icon="info-circle" />
      <span>{{ message }}</span>
    </div>

    <section v-if="globalModel">

      <main v-if="detail && selectedNovel" class="space-y-6 min-w-0">
        <section class="card bg-base-200 border border-base-300 shadow-sm">
          <div class="card-body p-5 flex-row flex-wrap justify-between items-center gap-3">
            <div>
              <h3 class="text-xl font-bold">{{ detail.title }}</h3>
              <p class="text-sm text-base-content/55 mt-1">{{ detail.chapters.length }} 个正式章节 · 权威状态 r{{ detail.state.revision }}</p>
            </div>
            <button class="btn btn-outline btn-sm" :disabled="running || !detail.chapters.length" @click="exportNovel">
              <font-awesome-icon icon="file-export" /> 导出发布稿
            </button>
          </div>
        </section>

        <section class="grid xl:grid-cols-[15rem_minmax(0,1fr)_20rem] gap-4 items-start">
          <aside class="card bg-base-200 border border-base-300 shadow-sm">
            <div class="card-body p-4 gap-3">
              <div>
                <h3 class="font-bold">章节目录</h3>
                <p class="text-xs text-base-content/55 mt-1">点击章节阅读正文</p>
              </div>
              <div v-if="!readerChapters.length" class="text-sm text-base-content/50 py-8 text-center">正文将在首章提交后出现</div>
              <button
                v-for="chapter in readerChapters"
                :key="chapter.key"
                class="rounded-lg border p-3 text-left transition-colors"
                :class="selectedReaderChapter?.key === chapter.key ? 'border-primary bg-primary text-primary-content' : 'border-base-300 bg-base-100 hover:border-primary/50'"
                @click="selectedReaderKey = chapter.key"
              >
                <div class="flex justify-between gap-2 text-sm font-semibold">
                  <span>第 {{ chapter.ordinal }} 章</span>
                  <span class="text-xs opacity-70">{{ chapter.status === 'committed' ? '已提交' : '审核中' }}</span>
                </div>
                <div class="mt-1 text-xs opacity-70">{{ chapter.wordCount }} 字<span v-if="chapter.revision"> · r{{ chapter.revision }}</span></div>
              </button>
            </div>
          </aside>

          <article class="card bg-base-200 border border-base-300 shadow-sm min-h-[48rem]">
            <div v-if="selectedReaderChapter" class="card-body p-6">
              <div class="flex flex-wrap items-center justify-between gap-3 border-b border-base-300 pb-4">
                <div>
                  <h3 class="text-xl font-bold">第 {{ selectedReaderChapter.ordinal }} 章</h3>
                  <p class="text-sm mt-1" :class="selectedReaderChapter.status === 'committed' ? 'text-success' : 'text-warning'">
                    {{ selectedReaderChapter.status === 'committed' ? '正式已提交' : '审核中草稿，尚未成为正式内容' }} · {{ selectedReaderChapter.wordCount }} 字
                  </p>
                </div>
              </div>
              <div class="mt-5 whitespace-pre-wrap text-base leading-8 text-base-content/85">{{ selectedReaderChapter.content }}</div>
            </div>
            <div v-else class="min-h-[48rem] flex items-center justify-center text-base-content/50">
              生成开始后，正文会在这里出现。
            </div>
          </article>

          <aside class="card bg-base-200 border border-primary/30 shadow-sm">
            <div class="card-body p-5 gap-4">
              <div class="flex items-center gap-2 text-primary font-semibold text-sm">
                <span v-if="autoProgress?.run.status === 'running'" class="loading loading-spinner loading-xs" />
                生成现场
              </div>
              <template v-if="autoProgress">
                <div>
                  <div class="font-bold leading-6">{{ phaseLabel(autoProgress) }}</div>
                  <div class="mt-3 flex justify-between text-sm"><span>已提交</span><span>{{ autoProgress.committedChapterCount }} / {{ autoProgress.run.targetChapters }} 章</span></div>
                  <progress class="progress progress-primary w-full mt-2" :value="autoProgress.committedChapterCount" :max="autoProgress.run.targetChapters" />
                  <div class="text-right text-xs text-base-content/55 mt-1">{{ overallPercent }}%</div>
                </div>
                <div v-if="autoProgress.currentChapter" class="border-t border-base-300 pt-4 text-sm space-y-2">
                  <div>当前章节：第 {{ autoProgress.currentChapter.ordinal }} 章</div>
                  <div v-if="autoProgress.currentChapter.phase === 'editorial_review'">审校：{{ autoProgress.currentChapter.editorialGateIndex + 1 }} / {{ autoProgress.currentChapter.editorialGateCount }}</div>
                  <div v-if="autoProgress.currentChapter.repairCount" class="text-warning">已修订 {{ autoProgress.currentChapter.repairCount }} / {{ autoProgress.currentChapter.maxRepairs }} 次</div>
                </div>
                <div v-if="autoProgress.run.errorMessage" class="border-t border-base-300 pt-4 text-sm text-error">
                  {{ autoProgress.run.errorCode }}：{{ autoProgress.run.errorMessage }}
                </div>
              </template>
              <p v-else class="text-sm text-base-content/55">尚未启动自动生成。</p>
            </div>
          </aside>
        </section>

        <section class="card bg-base-200 border border-base-300 shadow-sm">
          <div class="card-body p-6 gap-4">
            <div>
              <h3 class="font-bold">一键自动生成整本小说</h3>
              <p class="text-sm text-base-content/55 mt-1">先生成全书蓝图，再按当前权威状态自动规划、生成、验收并提交每一章。</p>
            </div>
            <label class="form-control">
              <span class="label-text">小说创意 / 故事梗概</span>
              <textarea v-model="premise" class="textarea textarea-bordered mt-1 min-h-32" :disabled="running" placeholder="写下主角、世界、核心冲突、想要的情绪与结局方向。系统将据此自动规划全书。" />
            </label>
            <div class="grid md:grid-cols-3 gap-4">
              <label class="form-control"><span class="label-text">目标章节数</span><input v-model.number="targetChapters" class="input input-bordered mt-1" type="number" min="1" max="2000" :disabled="running"></label>
              <label class="form-control"><span class="label-text">最少字数</span><input v-model.number="minWords" class="input input-bordered mt-1" type="number" min="1" :disabled="running"></label>
              <label class="form-control"><span class="label-text">最多字数</span><input v-model.number="maxWords" class="input input-bordered mt-1" type="number" min="1" :disabled="running"></label>
            </div>
            <p class="text-xs text-base-content/55">无需填写章节 JSON、事件或实体 ID；它们会按每章提交后的权威状态自动生成并验证。</p>
            <button class="btn btn-primary self-start" :disabled="!canStart || hasActiveAutoRun" @click="startAutoNovel">
              <span v-if="running" class="loading loading-spinner loading-sm" />
              {{ running ? '正在启动…' : hasActiveAutoRun ? '自动生成正在后台运行' : '开始自动生成整本小说' }}
            </button>
          </div>
        </section>

        <section v-if="runs.length" class="card bg-base-200 border border-base-300 shadow-sm">
          <div class="card-body p-6">
            <h3 class="font-bold">运行记录</h3>
            <div class="mt-2 space-y-2">
              <div v-for="run in runs" :key="run.id" class="border border-base-300 rounded-lg bg-base-100 p-3 flex flex-wrap gap-3 justify-between items-center">
                <div>
                  <div class="font-mono text-xs">{{ run.id }}</div>
                  <div class="text-sm mt-1">
                    {{ autoProgress?.run.id === run.id ? phaseLabel(autoProgress) : `${run.status} · ${run.currentPhase}` }} · 目标 {{ run.targetChapters }} 章
                  </div>
                  <div v-if="run.recoveredFromRunId" class="text-xs text-base-content/55 mt-1">从暂停运行恢复</div>
                  <div v-if="run.errorMessage" class="text-xs text-error mt-1">{{ run.errorCode }}：{{ run.errorMessage }}</div>
                </div>
                <div class="flex gap-2">
                  <button v-if="run.status === 'running'" class="btn btn-outline btn-xs" :disabled="running" @click="resume(run.id)">继续</button>
                  <button v-if="run.status === 'blocked'" class="btn btn-primary btn-xs" :disabled="running || hasActiveAutoRun" @click="recover(run.id)">从已提交章节恢复</button>
                  <button v-if="run.status === 'running'" class="btn btn-ghost btn-xs text-error" :disabled="running" @click="cancel(run.id)">取消</button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <main v-else class="card bg-base-200 border border-base-300 min-h-72 flex items-center justify-center text-base-content/50">
        选择或新建一本 V2 小说后开始。
      </main>
    </section>
  </div>
</template>
