<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
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

type DetailTab = 'body' | 'decision' | 'outcome' | 'facts' | 'versions'

const chapters = ref<ChapterListItem[]>([])
const selectedId = ref<number | null>(null)
const detail = ref<ChapterDetail | null>(null)
const query = ref('')
const loading = ref(true)
const detailLoading = ref(false)
const activeTab = ref<DetailTab>('body')
const versionPreview = ref<VersionPreview | null>(null)
const copied = ref(false)
let reloadTimer: number | null = null

const filteredChapters = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return keyword
    ? chapters.value.filter(chapter => chapter.title.toLowerCase().includes(keyword))
    : chapters.value
})
const selectedIndex = computed(() => chapters.value.findIndex(chapter => chapter.id === selectedId.value))
const displayedContent = computed(() => versionPreview.value?.content ?? detail.value?.chapter.content ?? '')
const displayedWordCount = computed(() => versionPreview.value?.wordCount ?? detail.value?.chapter.wordCount ?? 0)
const decisionPlan = computed<CausalChapterPlan | null>(() => detail.value?.decision?.plan ?? null)
const outcome = computed<CausalChapterOutcome | null>(() => detail.value?.decision?.outcome ?? null)

function statusText(chapter: ChapterListItem): string {
  if (chapter.decisionStatus === 'committed' && chapter.status === 'completed') return '已提交'
  if (chapter.hasContent) return '待验收'
  return '待生成'
}

function statusClass(chapter: ChapterListItem): string {
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

async function loadChapters(keepSelection = true): Promise<void> {
  const snapshot = await window.anovel.invoke('causal:getState', props.workId) as {
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
  if (!keepSelection || !selectedId.value || !chapters.value.some(chapter => chapter.id === selectedId.value)) {
    selectedId.value = chapters.value[0]?.id ?? null
  }
  if (selectedId.value) await loadDetail(selectedId.value)
  else detail.value = null
  loading.value = false
}

async function loadDetail(chapterId: number): Promise<void> {
  selectedId.value = chapterId
  detailLoading.value = true
  versionPreview.value = null
  try {
    detail.value = await window.anovel.invoke(
      'causal:getChapterDetail', props.workId, chapterId
    ) as ChapterDetail
  } finally {
    detailLoading.value = false
  }
}

async function openVersion(versionId: number): Promise<void> {
  if (!selectedId.value) return
  versionPreview.value = await window.anovel.invoke(
    'causal:getChapterVersion', props.workId, selectedId.value, versionId
  ) as VersionPreview
  activeTab.value = 'body'
}

function selectSibling(offset: number): void {
  const next = chapters.value[selectedIndex.value + offset]
  if (next) void loadDetail(next.id)
}

async function copyBody(): Promise<void> {
  if (!displayedContent.value) return
  await navigator.clipboard.writeText(displayedContent.value)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1200)
}

function onProgress(payload: unknown): void {
  const event = payload as { workId?: number }
  if (event.workId !== props.workId) return
  if (reloadTimer != null) window.clearTimeout(reloadTimer)
  reloadTimer = window.setTimeout(() => void loadChapters(true), 500)
}

onMounted(async () => {
  window.anovel.on('goal:progress', onProgress)
  await loadChapters(false)
})

onUnmounted(() => {
  window.anovel.off('goal:progress', onProgress)
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
        <p class="text-xs text-base-content/50 mt-1">自由阅读因果链生成的章节，并核对决策、状态变化与正文证据。</p>
      </div>
      <span class="badge badge-sm badge-ghost ml-auto">{{ chapters.length }} 章</span>
    </div>

    <div v-if="loading" class="card bg-base-200 border border-base-300 p-8 text-center text-sm text-base-content/50">
      正在加载章节…
    </div>

    <div v-else-if="chapters.length === 0" class="card bg-base-200 border border-base-300 p-10 text-center space-y-2">
      <font-awesome-icon icon="book-open" class="text-3xl text-base-content/20" />
      <p class="font-semibold">尚未生成章节</p>
      <p class="text-xs text-base-content/50">请先在“滚动因果”中初始化并开始运行。</p>
    </div>

    <div v-else class="grid grid-cols-[260px_minmax(0,1fr)] min-h-[70vh] rounded-xl border border-base-300 overflow-hidden bg-base-100">
      <aside class="border-r border-base-300 bg-base-200/60 min-h-0 flex flex-col">
        <div class="p-3 border-b border-base-300">
          <input v-model="query" class="input input-bordered input-sm w-full" placeholder="搜索章节标题" />
        </div>
        <div class="flex-1 overflow-y-auto p-2 space-y-1">
          <button
            v-for="chapter in filteredChapters"
            :key="chapter.id"
            type="button"
            class="w-full rounded-lg px-3 py-2.5 text-left border transition-colors"
            :class="selectedId === chapter.id ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-base-100'"
            @click="loadDetail(chapter.id)"
          >
            <div class="flex items-center gap-2">
              <span class="text-xs text-base-content/40">{{ chapter.ordinal }}</span>
              <span class="text-sm font-semibold truncate flex-1">{{ chapter.title }}</span>
            </div>
            <div class="flex items-center gap-2 mt-1.5 text-[11px] text-base-content/40">
              <span>{{ chapter.wordCount }} 字</span>
              <span v-if="chapter.stateRevision != null">基于 r{{ chapter.stateRevision }}</span>
              <span class="badge badge-xs ml-auto" :class="statusClass(chapter)">{{ statusText(chapter) }}</span>
            </div>
          </button>
        </div>
      </aside>

      <main class="min-w-0 flex flex-col">
        <div v-if="detailLoading" class="flex-1 flex items-center justify-center text-sm text-base-content/50">
          正在加载章节详情…
        </div>

        <template v-else-if="detail">
          <header class="border-b border-base-300 px-5 py-4 space-y-3">
            <div class="flex items-center gap-3">
              <button type="button" class="btn btn-ghost btn-xs" :disabled="selectedIndex <= 0" @click="selectSibling(-1)">← 上一章</button>
              <div class="min-w-0 flex-1 text-center">
                <h4 class="font-bold truncate">{{ detail.chapter.title }}</h4>
                <p class="text-[11px] text-base-content/40 mt-0.5">
                  {{ displayedWordCount }} 字 · {{ formatTime(versionPreview?.createTime ?? detail.chapter.updateTime) }}
                  <span v-if="versionPreview"> · 历史版本 v{{ versionPreview.versionNumber }}</span>
                </p>
              </div>
              <button type="button" class="btn btn-ghost btn-xs" :disabled="selectedIndex >= chapters.length - 1" @click="selectSibling(1)">下一章 →</button>
            </div>
            <div class="tabs tabs-boxed justify-center bg-base-200/70">
              <button class="tab tab-sm" :class="{ 'tab-active': activeTab === 'body' }" @click="activeTab = 'body'">正文</button>
              <button class="tab tab-sm" :class="{ 'tab-active': activeTab === 'decision' }" @click="activeTab = 'decision'">章节决策</button>
              <button class="tab tab-sm" :class="{ 'tab-active': activeTab === 'outcome' }" @click="activeTab = 'outcome'">章后变化</button>
              <button class="tab tab-sm" :class="{ 'tab-active': activeTab === 'facts' }" @click="activeTab = 'facts'">事实证据</button>
              <button class="tab tab-sm" :class="{ 'tab-active': activeTab === 'versions' }" @click="activeTab = 'versions'">历史版本</button>
            </div>
          </header>

          <div class="flex-1 overflow-y-auto p-5 sm:p-7">
            <section v-if="activeTab === 'body'" class="max-w-4xl mx-auto">
              <div class="flex justify-end gap-2 mb-4">
                <button v-if="versionPreview" type="button" class="btn btn-outline btn-xs" @click="versionPreview = null">返回当前正文</button>
                <button type="button" class="btn btn-outline btn-xs" :disabled="!displayedContent" @click="copyBody">
                  {{ copied ? '已复制' : '复制正文' }}
                </button>
              </div>
              <article v-if="displayedContent" class="whitespace-pre-wrap text-[16px] leading-8 font-serif text-base-content/90">{{ displayedContent }}</article>
              <p v-else class="text-sm text-base-content/40 text-center py-16">本章正文尚未生成。</p>
            </section>

            <section v-else-if="activeTab === 'decision'" class="max-w-4xl mx-auto space-y-4">
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
                <div class="flex items-center gap-2">
                  <p class="text-xs font-bold text-base-content/50">本章因果情绪事务</p>
                  <span class="badge badge-xs badge-primary">{{ decisionPlan.emotionContract.arc_role }}</span>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div><span class="text-xs text-base-content/40">依恋依据</span><p class="mt-1">{{ decisionPlan.emotionContract.attachment_anchor }}</p></div>
                  <div><span class="text-xs text-base-content/40">被威胁的价值</span><p class="mt-1">{{ decisionPlan.emotionContract.value_at_stake }}</p></div>
                  <div><span class="text-xs text-base-content/40">人物主观意义</span><p class="mt-1">{{ decisionPlan.emotionContract.character_appraisal.perceived_meaning }}</p></div>
                  <div><span class="text-xs text-base-content/40">选择与代价</span><p class="mt-1">{{ decisionPlan.emotionContract.choice_and_cost }}</p></div>
                  <div><span class="text-xs text-base-content/40">私人细节锚点</span><p class="mt-1">{{ decisionPlan.emotionContract.private_detail_anchor }}</p></div>
                  <div><span class="text-xs text-base-content/40">带入下一章的余波</span><p class="mt-1">{{ decisionPlan.emotionContract.residue_into_next }}</p></div>
                </div>
                <div>
                  <p class="text-xs text-base-content/40 mb-1">权威依据</p>
                  <div class="flex flex-wrap gap-1">
                    <span v-for="ref in decisionPlan.emotionContract.grounding_refs" :key="ref" class="badge badge-sm badge-outline">{{ ref }}</span>
                  </div>
                </div>
              </div>
              <div v-if="decisionPlan" class="space-y-2">
                <h5 class="font-semibold text-sm">候选事件与评分</h5>
                <div v-for="candidate in decisionPlan.candidates" :key="candidate.id" class="rounded-lg border p-3" :class="candidate.id === decisionPlan.selectedCandidateId ? 'border-primary bg-primary/5' : 'border-base-300'">
                  <div class="flex gap-2"><span class="font-semibold text-sm">{{ candidate.action }}</span><span class="badge badge-xs ml-auto">{{ candidate.scores.total }}分</span></div>
                  <p class="text-xs text-base-content/50 mt-1">阻力：{{ candidate.opposition }} · 代价：{{ candidate.cost }}</p>
                </div>
              </div>
              <p v-if="!decisionPlan" class="text-sm text-base-content/40 text-center py-16">本章没有因果决策记录。</p>
            </section>

            <section v-else-if="activeTab === 'outcome'" class="max-w-4xl mx-auto space-y-4">
              <template v-if="outcome">
                <div class="card bg-base-200 border border-base-300 p-4"><p class="text-xs text-base-content/40">章后摘要</p><p class="mt-1 text-sm">{{ outcome.summary }}</p></div>
                <div class="card bg-base-200 border border-base-300 p-4 space-y-2">
                  <p class="text-xs font-bold text-base-content/50">已经挣得的情绪结果</p>
                  <p class="text-sm">{{ outcome.emotionalOutcome.readerEffectSummary }}</p>
                  <div class="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-base-content/60">
                    <p>触发证据：“{{ outcome.emotionalOutcome.triggerEvidence }}”</p>
                    <p>选择证据：“{{ outcome.emotionalOutcome.choiceEvidence }}”</p>
                    <p>代价证据：“{{ outcome.emotionalOutcome.costEvidence }}”</p>
                    <p>余波证据：“{{ outcome.emotionalOutcome.residueEvidence }}”</p>
                  </div>
                  <p v-if="outcome.emotionalOutcome.emotionalDebtOpened" class="text-sm">新增情绪债：{{ outcome.emotionalOutcome.emotionalDebtOpened }}</p>
                  <p v-if="outcome.emotionalOutcome.emotionalDebtPaid" class="text-sm">本章兑现：{{ outcome.emotionalOutcome.emotionalDebtPaid }}</p>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div class="card bg-base-200 border border-base-300 p-4"><p class="text-xs font-bold text-base-content/50">推进的读者承诺</p><p class="text-sm mt-2">{{ outcome.advancedPromiseIds.join('、') || '无' }}</p></div>
                  <div class="card bg-base-200 border border-base-300 p-4"><p class="text-xs font-bold text-base-content/50">关闭的读者承诺</p><p class="text-sm mt-2">{{ outcome.resolvedPromiseIds.join('、') || '无' }}</p></div>
                </div>
                <div v-if="outcome.newPromises.length" class="space-y-2">
                  <h5 class="font-semibold text-sm">新增读者承诺</h5>
                  <div v-for="item in outcome.newPromises" :key="item.id" class="rounded-lg border border-base-300 p-3 text-sm">
                    <strong>{{ item.id }}</strong>：{{ item.question }}
                  </div>
                </div>
                <div v-if="outcome.actorUpdates.length" class="space-y-2">
                  <h5 class="font-semibold text-sm">人物状态变化</h5>
                  <div v-for="item in outcome.actorUpdates" :key="`${item.actor}-${item.evidence}`" class="rounded-lg border border-base-300 p-3 text-sm space-y-1">
                    <strong>{{ item.actor }}</strong>
                    <p v-if="item.currentGoal">当前目标 → {{ item.currentGoal }}</p>
                    <p v-if="item.constraint">约束 → {{ item.constraint }}</p>
                    <p v-if="item.knowledgeAdded?.length">新增认知：{{ item.knowledgeAdded.join('、') }}</p>
                    <p v-if="item.resourcesAdded?.length">获得资源：{{ item.resourcesAdded.join('、') }}</p>
                    <p v-if="item.resourcesRemoved?.length">失去资源：{{ item.resourcesRemoved.join('、') }}</p>
                    <p class="text-xs text-base-content/60 pt-1">证据：“{{ item.evidence }}”</p>
                  </div>
                </div>
                <div v-if="outcome.pressureUpdates.length || outcome.newPressures.length" class="space-y-2">
                  <h5 class="font-semibold text-sm">世界压力变化</h5>
                  <div v-for="item in outcome.pressureUpdates" :key="item.id" class="rounded-lg border border-base-300 p-3 text-sm">
                    <strong>{{ item.id }}</strong>：{{ item.status }}
                    <span v-if="item.urgency != null"> · 紧迫度 {{ item.urgency }}</span>
                    <p v-if="item.condition" class="mt-1">条件 → {{ item.condition }}</p>
                    <p class="text-xs text-base-content/60 mt-1">证据：“{{ item.evidence }}”</p>
                  </div>
                  <div v-for="item in outcome.newPressures" :key="item.pressure.id" class="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
                    <strong>新增 · {{ item.pressure.id }}</strong>：{{ item.pressure.source }} → {{ item.pressure.target }}
                    <p class="mt-1">紧迫度 {{ item.pressure.urgency }} · 条件：{{ item.pressure.condition }}</p>
                    <p class="mt-1">升级方式：{{ item.pressure.escalation }}</p>
                    <p class="text-xs text-base-content/60 mt-1">证据：“{{ item.evidence }}”</p>
                  </div>
                </div>
              </template>
              <p v-else class="text-sm text-base-content/40 text-center py-16">本章尚未提交章后因果状态。</p>
            </section>

            <section v-else-if="activeTab === 'facts'" class="max-w-4xl mx-auto space-y-4">
              <div v-if="detail.stateFacts.length" class="space-y-2">
                <div v-for="fact in detail.stateFacts" :key="fact.id" class="rounded-lg border border-base-300 p-3">
                  <div class="flex items-center gap-2 text-sm"><strong>{{ fact.entity }}.{{ fact.key }}</strong><span class="badge badge-xs">{{ fact.transition }}</span><span v-if="fact.irreversible" class="badge badge-error badge-xs">不可逆</span></div>
                  <pre class="text-xs whitespace-pre-wrap mt-2 font-sans">{{ formatValue(fact.value) }}</pre>
                  <p v-if="fact.evidence" class="text-xs text-base-content/50 mt-2">证据：“{{ fact.evidence }}”</p>
                </div>
              </div>
              <div v-if="detail.emotionalStates.length" class="space-y-2"><h5 class="font-semibold text-sm">人物情绪余波</h5><div v-for="item in detail.emotionalStates" :key="item.characterName" class="rounded-lg border border-base-300 p-3 text-sm"><strong>{{ item.characterName }}</strong><p class="text-xs text-base-content/60 mt-1">{{ item.feltState }}；后续影响：{{ item.behavioralAftereffect }}</p></div></div>
              <p v-if="!detail.stateFacts.length && !detail.emotionalStates.length" class="text-sm text-base-content/40 text-center py-16">本章尚无已提交事实证据。</p>
            </section>

            <section v-else class="max-w-4xl mx-auto space-y-2">
              <div v-for="version in detail.versions" :key="version.id" class="flex items-center gap-3 rounded-lg border border-base-300 p-3">
                <div class="min-w-0 flex-1"><p class="font-semibold text-sm">版本 v{{ version.versionNumber }}</p><p class="text-xs text-base-content/40 mt-1">{{ formatTime(version.createTime) }} · {{ version.wordCount }} 字 · {{ version.modelType || '未标记来源' }}</p></div>
                <button type="button" class="btn btn-outline btn-xs" :disabled="!version.hasContent" @click="openVersion(version.id)">查看</button>
              </div>
              <p v-if="detail.versions.length === 0" class="text-sm text-base-content/40 text-center py-16">本章暂无历史版本。</p>
            </section>
          </div>
        </template>
      </main>
    </div>
  </div>
</template>
