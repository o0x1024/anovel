<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { AssistantWorkReference, PatchFixResult, PatchFixPatch, PatchFixSectionRewrite } from '../../../../../shared/assistant-types'

type ItemKind = 'patch' | 'section'
type ItemStatus = 'pending' | 'applying' | 'applied' | 'skipped' | 'failed'

interface ChapterRow {
  id: number
  title: string
  content: string | null
  word_count?: number
}

interface ApplyLocalPatchesResult {
  success: boolean
  patchedText?: string
  appliedCount?: number
  error?: string
}

interface ApplySectionRewriteResult {
  success: boolean
  patchedText?: string
  error?: string
}

interface ApplyFixesResult {
  success: boolean
  content?: string
  error?: string
}

const props = defineProps<{
  fixResult: PatchFixResult
}>()

const itemStatus = reactive<Record<string, ItemStatus>>({})
const itemError = reactive<Record<string, string>>({})
const applyingAll = ref(false)

const patches = computed(() => props.fixResult.patches ?? [])
const sectionRewrites = computed(() => props.fixResult.section_rewrites ?? [])
const firstReference = computed(() => props.fixResult.workReferences?.[0] ?? null)
const hasChapterTarget = computed(() => !!firstReference.value?.chapterId)
const totalCount = computed(() => patches.value.length + sectionRewrites.value.length)
const pendingCount = computed(() => keys.value.filter(key => !itemStatus[key] || itemStatus[key] === 'pending').length)
const keys = computed(() => [
  ...patches.value.map((_, i) => itemKey('patch', i)),
  ...sectionRewrites.value.map((_, i) => itemKey('section', i))
])

function itemKey(kind: ItemKind, index: number): string {
  return `${kind}:${index}`
}

function statusOf(kind: ItemKind, index: number): ItemStatus {
  return itemStatus[itemKey(kind, index)] ?? 'pending'
}

function setStatus(kind: ItemKind, index: number, status: ItemStatus, error = ''): void {
  const key = itemKey(kind, index)
  itemStatus[key] = status
  itemError[key] = error
}

function statusLabel(status: ItemStatus): string {
  if (status === 'applying') return '应用中'
  if (status === 'applied') return '已应用'
  if (status === 'skipped') return '已跳过'
  if (status === 'failed') return '失败'
  return '待处理'
}

function statusClass(status: ItemStatus): string {
  if (status === 'applied') return 'badge-success'
  if (status === 'failed') return 'badge-error'
  if (status === 'skipped') return 'badge-ghost'
  if (status === 'applying') return 'badge-warning'
  return 'badge-outline'
}

function truncate(text: string, length = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > length ? `${oneLine.slice(0, length)}…` : oneLine
}

function currentRef(): AssistantWorkReference {
  const ref = firstReference.value
  if (!ref?.workId) throw new Error('缺少作品引用，无法回写正文')
  return ref
}

async function loadTargetChapters(ref: AssistantWorkReference): Promise<ChapterRow[]> {
  if (ref.chapterId) {
    const chapter = await window.anovel.invoke('chapter:get', ref.chapterId) as ChapterRow | null
    return chapter ? [chapter] : []
  }
  return await window.anovel.invoke('chapter:listByWork', ref.workId) as ChapterRow[]
}

async function updateChapter(chapterId: number, content: string): Promise<void> {
  await window.anovel.invoke('chapter:update', chapterId, { content })
}

async function applyPatch(index: number, patch: PatchFixPatch): Promise<boolean> {
  setStatus('patch', index, 'applying')
  try {
    const ref = currentRef()
    const chapters = await loadTargetChapters(ref)
    for (const chapter of chapters) {
      if (!chapter.content?.trim()) continue
      const res = await window.anovel.invoke(
        'quality:applyLocalPatches',
        chapter.content,
        [{ find: patch.find, replace: patch.replace }]
      ) as ApplyLocalPatchesResult
      if (res.success && (res.appliedCount ?? 0) > 0 && typeof res.patchedText === 'string') {
        await updateChapter(chapter.id, res.patchedText)
        setStatus('patch', index, 'applied')
        return true
      }
    }
    setStatus('patch', index, 'failed', '未在引用正文中定位到原文片段')
    return false
  } catch (e) {
    setStatus('patch', index, 'failed', e instanceof Error ? e.message : String(e))
    return false
  }
}

async function applySectionRewrite(index: number, rewrite: PatchFixSectionRewrite): Promise<boolean> {
  setStatus('section', index, 'applying')
  try {
    const ref = currentRef()
    const chapters = await loadTargetChapters(ref)
    for (const chapter of chapters) {
      if (!chapter.content?.trim()) continue
      const res = await window.anovel.invoke(
        'quality:applySectionRewrite',
        chapter.content,
        rewrite.find_start,
        rewrite.find_end,
        rewrite.replacement
      ) as ApplySectionRewriteResult
      if (res.success && typeof res.patchedText === 'string') {
        await updateChapter(chapter.id, res.patchedText)
        setStatus('section', index, 'applied')
        return true
      }
    }
    setStatus('section', index, 'failed', '未在引用正文中定位到段落范围')
    return false
  } catch (e) {
    setStatus('section', index, 'failed', e instanceof Error ? e.message : String(e))
    return false
  }
}

async function applyOne(kind: ItemKind, index: number): Promise<void> {
  if (kind === 'patch') {
    await applyPatch(index, patches.value[index])
  } else {
    await applySectionRewrite(index, sectionRewrites.value[index])
  }
}

function skipOne(kind: ItemKind, index: number): void {
  setStatus(kind, index, 'skipped')
}

async function applyAll(): Promise<void> {
  if (applyingAll.value) return
  applyingAll.value = true
  try {
    for (let i = 0; i < patches.value.length; i++) {
      if (statusOf('patch', i) === 'pending') await applyPatch(i, patches.value[i])
    }
    for (let i = 0; i < sectionRewrites.value.length; i++) {
      if (statusOf('section', i) === 'pending') await applySectionRewrite(i, sectionRewrites.value[i])
    }
  } finally {
    applyingAll.value = false
  }
}

function skipAll(): void {
  for (let i = 0; i < patches.value.length; i++) {
    if (statusOf('patch', i) === 'pending') setStatus('patch', i, 'skipped')
  }
  for (let i = 0; i < sectionRewrites.value.length; i++) {
    if (statusOf('section', i) === 'pending') setStatus('section', i, 'skipped')
  }
}

async function rewriteWholeChapter(index: number): Promise<void> {
  setStatus('patch', index, 'applying')
  try {
    const ref = currentRef()
    if (!ref.chapterId) throw new Error('全文引用无法确定单章目标')
    const chapter = await window.anovel.invoke('chapter:get', ref.chapterId) as ChapterRow | null
    if (!chapter?.content?.trim()) throw new Error('章节正文为空')
    const res = await window.anovel.invoke(
      'quality:applyFixes',
      ref.workId,
      chapter.content,
      props.fixResult.report || '请根据正文检修师报告修复本章问题。'
    ) as ApplyFixesResult
    if (!res.success || !res.content?.trim()) throw new Error(res.error || '整体重写失败')
    await updateChapter(chapter.id, res.content)
    setStatus('patch', index, 'applied')
  } catch (e) {
    setStatus('patch', index, 'failed', e instanceof Error ? e.message : String(e))
  }
}
</script>

<template>
  <div class="card bg-base-200 border border-warning/20 mt-2">
    <div class="card-body p-4 gap-3">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h4 class="font-bold text-sm">正文检修补丁</h4>
          <p class="text-xs text-base-content/50 mt-1">
            精准补丁 {{ patches.length }} 条 · 段落重写 {{ sectionRewrites.length }} 条
          </p>
          <p v-if="firstReference" class="text-xs text-base-content/40 mt-1">
            目标：{{ firstReference.title }}
          </p>
        </div>
        <span class="badge badge-sm badge-outline">{{ pendingCount }}/{{ totalCount }} 待处理</span>
      </div>

      <div v-if="!firstReference" class="alert alert-warning py-2 text-xs">
        缺少作品引用，无法自动应用补丁。
      </div>

      <div v-if="patches.length" class="space-y-2">
        <p class="text-xs font-semibold text-base-content/50">精准补丁</p>
        <div
          v-for="(patch, index) in patches"
          :key="itemKey('patch', index)"
          class="rounded-lg border border-base-300 bg-base-100 p-3 text-xs space-y-2"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium">#{{ index + 1 }} {{ patch.reason || '局部修复' }}</span>
            <span class="badge badge-xs" :class="statusClass(statusOf('patch', index))">
              {{ statusLabel(statusOf('patch', index)) }}
            </span>
          </div>
          <div class="space-y-1 font-mono">
            <p><span class="text-error">-</span> {{ truncate(patch.find) }}</p>
            <p><span class="text-success">+</span> {{ truncate(patch.replace) }}</p>
          </div>
          <p v-if="itemError[itemKey('patch', index)]" class="text-error">
            {{ itemError[itemKey('patch', index)] }}
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="btn btn-primary btn-xs"
              :disabled="statusOf('patch', index) !== 'pending' || !firstReference"
              @click="applyOne('patch', index)"
            >
              应用
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              :disabled="statusOf('patch', index) !== 'pending'"
              @click="skipOne('patch', index)"
            >
              跳过
            </button>
            <button
              v-if="statusOf('patch', index) === 'failed' && hasChapterTarget"
              type="button"
              class="btn btn-warning btn-xs"
              @click="rewriteWholeChapter(index)"
            >
              整体重写此章节
            </button>
          </div>
        </div>
      </div>

      <div v-if="sectionRewrites.length" class="space-y-2">
        <p class="text-xs font-semibold text-base-content/50">段落重写</p>
        <div
          v-for="(rewrite, index) in sectionRewrites"
          :key="itemKey('section', index)"
          class="rounded-lg border border-base-300 bg-base-100 p-3 text-xs space-y-2"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="font-medium">#{{ index + 1 }} {{ rewrite.title }}</span>
            <span class="badge badge-xs" :class="statusClass(statusOf('section', index))">
              {{ statusLabel(statusOf('section', index)) }}
            </span>
          </div>
          <p class="text-base-content/60">{{ rewrite.reason }}</p>
          <div class="space-y-1 font-mono">
            <p><span class="text-base-content/40">起：</span>{{ truncate(rewrite.find_start) }}</p>
            <p><span class="text-base-content/40">止：</span>{{ truncate(rewrite.find_end) }}</p>
            <p><span class="text-success">替换：</span>{{ truncate(rewrite.replacement) }}</p>
          </div>
          <p v-if="itemError[itemKey('section', index)]" class="text-error">
            {{ itemError[itemKey('section', index)] }}
          </p>
          <div class="flex flex-wrap gap-2">
            <button
              type="button"
              class="btn btn-primary btn-xs"
              :disabled="statusOf('section', index) !== 'pending' || !firstReference"
              @click="applyOne('section', index)"
            >
              应用
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-xs"
              :disabled="statusOf('section', index) !== 'pending'"
              @click="skipOne('section', index)"
            >
              跳过
            </button>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="btn btn-primary btn-xs"
          :disabled="applyingAll || pendingCount === 0 || !firstReference"
          @click="applyAll"
        >
          {{ applyingAll ? '应用中...' : '全部应用' }}
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          :disabled="pendingCount === 0"
          @click="skipAll"
        >
          全部跳过
        </button>
      </div>
    </div>
  </div>
</template>
