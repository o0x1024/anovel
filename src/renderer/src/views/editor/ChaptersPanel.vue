<script setup lang="ts">
import { ref, onMounted, watch, inject, computed } from 'vue'
import { useModelChat } from './useModelChat'
import PanelTitle from '../../components/PanelTitle.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import FavoriteButton from '../../components/FavoriteButton.vue'
import AiInterventionBar from './AiInterventionBar.vue'
import AiSelfCheckPanel from './AiSelfCheckPanel.vue'
import StepNavFooter from './StepNavFooter.vue'
import ChapterPlanPanel from './ChapterPlanPanel.vue'
import { editorNavKey } from './editor-nav'
import { type WritingPlanStatus, volumePlanLabel } from './chapter-plan-ui'

const props = defineProps<{ workId: number }>()
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

const { loading, result, error, chat, clearResult } = useModelChat(() => props.workId)

const batchSystemPrompt = [
  '根据当前分卷信息与作品创作上下文，生成该卷下的章节情节大纲。',
  '【输出格式 - 必须严格遵守】',
  '只输出一个 JSON 对象；禁止 Markdown 章节标题、前置说明、思考过程，以及 ``` 代码块围栏。',
  'chapters 数组每一项为一章；不要把「卷X章节大纲」「分章情节」「章节结尾钩子」等文档标题当作 title。',
  '每章字段：title、outline（或 plot_points 数组）、beat_role、foreshadow_target、next_hook、characters（本章出场角色名数组）。',
  'beat_role: A(爽点释放)/B(进行中)/C(铺垫)/transition(过渡)',
  'foreshadow_target: 本章铺垫的下一节点；next_hook: 章末钩子（仅写在 JSON 字段内，不要单独成章）。',
  'characters: 从人设卡片或核心设定中选取本章实际出场角色。',
  '【长度】每章 outline / plot_points 合计 300-600 字梗概，禁止正文级长文。',
  '格式：{"chapters":[{"title":"第1章 标题","outline":"情节摘要","beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"]}]}'
].join('\n')

function outlineCharCount(outline: string | null | undefined): number {
  return (outline ?? '').replace(/\s/g, '').length
}

function outlineLengthLabel(ch: Chapter): string {
  const n = outlineCharCount(ch.outline)
  if (!n) return ''
  return n > 800 ? `大纲 ${n} 字（偏长）` : `大纲 ${n} 字`
}

function parseCharacterNames(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return []
  return raw.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
}

const selectedVolumeInfo = ref<{ id: number; name: string; description?: string | null } | null>(null)

onMounted(async () => {
  volumes.value = await window.anovel.invoke('volume:list', props.workId) as never[]
  if (volumes.value.length) selectedVolume.value = volumes.value[0].id
})

watch(selectedVolume, async (v) => {
  if (v) {
    selectedVolumeInfo.value = volumes.value.find(vol => vol.id === v) ?? null
    await loadChapters(v)
    batchChapterCount.value = await window.anovel.invoke(
      'writingPlan:suggestBatchCount',
      props.workId,
      v
    ) as number
  }
})

function onPlanStatusChange(s: WritingPlanStatus) {
  planStatus.value = s
}

function volumePlanBadge(volumeId: number): string {
  const vol = planStatus.value?.volumes.find(v => v.id === volumeId)
  return vol ? volumePlanLabel(vol) : ''
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
  if (chapters.value.length === 0) {
    await applyParsedChapters('append')
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
  if (!confirm(`删除章节「${title}」？`)) return
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
  if (!confirm(`确定删除选中的 ${count} 个章节？此操作不可撤销。`)) return
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
  if (!editingChapterId.value || !confirm('恢复此版本将覆盖当前章节内容，确定继续？')) return
  await window.anovel.invoke('chapter:versionRestore', editingChapterId.value, versionId)
  const ch = chapters.value.find(c => c.id === editingChapterId.value)
  if (ch) {
    const updated = await window.anovel.invoke('chapter:get', editingChapterId.value) as Chapter
    chapterContent.value = updated.content || ''
    chapterOutline.value = updated.outline || ''
  }
  await loadChapters(selectedVolume.value!)
  await loadChapterVersions(editingChapterId.value)
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
  return [
    `分卷：${vol.name}`,
    vol.description ? `分卷说明：${vol.description}` : '',
    `请生成 ${batchChapterCount.value} 章的情节大纲。`
  ].filter(Boolean).join('\n\n')
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
      systemPrompt: batchSystemPrompt,
      workId: props.workId,
      step: 'volume_chapters_batch',
      workContextOptions: { includeVolumes: true }
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

async function applyParsedChapters(mode: 'append' | 'replace') {
  if (!selectedVolume.value || parsedChapters.value.length === 0 || applyingChapters.value) return
  if (mode === 'replace' && chapters.value.length > 0) {
    if (!confirm(`将替换当前分卷下 ${chapters.value.length} 个章节，确定继续？`)) return
  }
  applyingChapters.value = true
  try {
    const items = parsedChapters.value.map(c => ({
      title: c.title,
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
  const outlineSystem = [
    '为以上章节生成情节大纲（写作指令，不是正文）。',
    '3-5 个情节节点，每节点 1-2 句：出场人物、关键冲突、转折、章末钩子。',
    '全文 300-600 字，禁止写完整对话、场景描写或心理独白。',
    '标注 beat_role(A/B/C/transition)、foreshadow_target、next_hook、characters（本章出场角色名数组），放在末尾 JSON 代码块。',
    '末尾附 JSON：{"beat_role":"B","foreshadow_target":"...","next_hook":"...","characters":["角色A","角色B"]}'
  ].join('\n')
  const res = await chat(context, outlineSystem, 'chapter_outline')
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
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="list-ol" title="章节情节" />

    <div v-if="volumes.length === 0" class="text-center py-16 text-base-content/40">
      <font-awesome-icon icon="book" class="text-4xl mb-3 opacity-30" />
      <p>请先在分卷大纲中创建分卷</p>
      <StepNavFooter step="chapters" hint="请先在「分卷大纲」中创建或应用分卷" />
    </div>
    <template v-else>
      <ChapterPlanPanel
        ref="planPanelRef"
        :work-id="workId"
        :selected-volume-id="selectedVolume"
        @status-change="onPlanStatusChange"
      />

      <div class="flex gap-2 mb-4 flex-wrap">
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

      <div class="card bg-base-200 border border-base-300 shadow-sm p-4 mb-6">
        <h4 class="font-semibold text-sm mb-3">AI 批量生成本卷章节</h4>
        <div class="flex flex-wrap gap-2 mb-3 items-center">
          <label class="text-xs text-base-content/50">章节数</label>
          <select v-model="batchChapterCount" class="select select-bordered select-sm w-24">
            <option v-for="n in [3, 4, 5, 6, 8, 10]" :key="n" :value="n">{{ n }} 章</option>
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
        <div v-if="batchResult" class="border border-base-300 rounded-lg p-3 bg-base-100 max-h-96 overflow-auto w-full">
          <MarkdownContent :content="batchResult" size="xs" />
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

      <div v-if="selectedVolume" class="flex gap-2 mb-6">
        <input
          v-model="newChapterTitle"
          placeholder="章节标题"
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
        <p>还没有章节，可手动添加或使用 AI 批量生成</p>
      </div>
      <div v-else class="grid grid-cols-1 xl:grid-cols-[minmax(260px,320px)_1fr] gap-3 min-h-[480px]">
        <div class="card bg-base-200 border border-base-300 shadow-sm p-3 flex flex-col min-h-0 max-h-[70vh] xl:max-h-none">
          <div class="flex items-center justify-between gap-2 mb-2 shrink-0">
            <h4 class="font-semibold text-sm">章节列表</h4>
            <div class="flex items-center gap-2">
              <span class="text-xs text-base-content/40">{{ chapters.length }} 章</span>
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
              v-for="ch in chapters"
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
                  {{ aiChapterId === selectedChapter.id ? '生成中...' : 'AI 生成章节大纲' }}
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
              <p v-else class="text-sm text-base-content/40 italic">暂无章节大纲，可点击「AI 生成章节大纲」或「编辑」</p>
            </div>

            <div v-else class="flex-1 min-h-0 overflow-y-auto space-y-3">
            <textarea
              v-model="chapterOutline"
              rows="12"
              class="textarea textarea-bordered w-full resize-y min-h-[200px]"
              placeholder="章节大纲..."
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
                source-label="章节大纲"
                :content="chapterOutline"
                :source-input="lastAiContext"
                size="xs"
              />
              <button class="btn btn-ghost btn-sm" @click="editingChapterId = null">取消</button>
            </div>
            <div v-if="chapterVersions.length" class="mt-3 pt-3 border-t border-base-300">
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
            <p v-else-if="loadingVersions" class="text-xs text-base-content/40 mt-2">加载版本...</p>
            </div>
          </template>
          <p v-else class="text-sm text-base-content/40 italic flex-1 flex items-center justify-center">
            请从左侧选择章节
          </p>
        </div>
      </div>

      <StepNavFooter step="chapters" />
    </template>
  </div>
</template>
