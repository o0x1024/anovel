<script setup lang="ts">
import { computed, ref } from 'vue'
import { buildTextDiff } from '../../../../shared/text-diff'
import DeaiDiffText from './DeaiDiffText.vue'

const props = defineProps<{
  originalText: string
  resultText: string
  status: 'idle' | 'running' | 'done' | 'error'
  errorMessage: string
}>()

const viewMode = ref<'diff' | 'plain'>('diff')
const hasResult = computed(() => props.resultText.trim().length > 0)
const showContent = computed(() => props.status !== 'idle' || hasResult.value)
const diffView = computed(() => buildTextDiff(props.originalText, props.resultText))
const showDiffHighlight = computed(() => hasResult.value && props.originalText !== props.resultText)

const originalScrollRef = ref<HTMLElement | null>(null)
const resultScrollRef = ref<HTMLElement | null>(null)
let syncingScroll = false

function isSideBySideDiff(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(min-width: 768px)').matches
}

function syncScrollFrom(source: HTMLElement, target: HTMLElement) {
  if (syncingScroll || !isSideBySideDiff()) return
  syncingScroll = true
  const sourceMax = source.scrollHeight - source.clientHeight
  const targetMax = target.scrollHeight - target.clientHeight
  if (sourceMax <= 0 || targetMax <= 0) {
    target.scrollTop = source.scrollTop
  } else {
    target.scrollTop = (source.scrollTop / sourceMax) * targetMax
  }
  requestAnimationFrame(() => {
    syncingScroll = false
  })
}

function onOriginalScroll(event: Event) {
  const target = resultScrollRef.value
  if (!target) return
  syncScrollFrom(event.currentTarget as HTMLElement, target)
}

function onResultScroll(event: Event) {
  const target = originalScrollRef.value
  if (!target) return
  syncScrollFrom(event.currentTarget as HTMLElement, target)
}

const scrollPaneClass =
  'flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 py-2 scrollbar-thin'

const copyHint = ref('')
const exportHint = ref('')
let copyHintTimer: ReturnType<typeof setTimeout> | null = null
let exportHintTimer: ReturnType<typeof setTimeout> | null = null

function setCopyHint(text: string) {
  copyHint.value = text
  if (copyHintTimer) clearTimeout(copyHintTimer)
  copyHintTimer = setTimeout(() => {
    copyHint.value = ''
    copyHintTimer = null
  }, 2000)
}

function setExportHint(text: string) {
  exportHint.value = text
  if (exportHintTimer) clearTimeout(exportHintTimer)
  exportHintTimer = setTimeout(() => {
    exportHint.value = ''
    exportHintTimer = null
  }, 2000)
}

async function copyResult() {
  if (!hasResult.value) return
  try {
    await navigator.clipboard.writeText(props.resultText)
    setCopyHint('已复制')
  } catch {
    setCopyHint('复制失败')
  }
}

function exportResult() {
  if (!hasResult.value) return
  try {
    const blob = new Blob([props.resultText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `deai-result-${Date.now()}.txt`
    a.click()
    URL.revokeObjectURL(url)
    setExportHint('已导出')
  } catch {
    setExportHint('导出失败')
  }
}
</script>

<template>
  <section class="border border-base-300 rounded-lg bg-base-100 flex flex-col min-h-0 h-full">
    <div class="px-3 py-1.5 border-b border-base-300/60 flex items-center gap-2 shrink-0 flex-wrap">
      <span class="text-xs font-semibold text-base-content/70 shrink-0">处理结果</span>
      <div class="join join-horizontal">
        <button
          type="button"
          class="btn btn-xs join-item"
          :class="viewMode === 'diff' ? 'btn-primary' : 'btn-ghost'"
          @click="viewMode = 'diff'"
        >
          对比
        </button>
        <button
          type="button"
          class="btn btn-xs join-item"
          :class="viewMode === 'plain' ? 'btn-primary' : 'btn-ghost'"
          @click="viewMode = 'plain'"
        >
          纯结果
        </button>
      </div>
      <span v-if="props.status === 'running'" class="text-[11px] text-base-content/50 flex items-center gap-1">
        <span class="loading loading-dots loading-xs" />
        生成中
      </span>
      <span v-else-if="showContent" class="text-[11px] text-base-content/45 tabular-nums">
        {{ props.originalText.length.toLocaleString() }}
        <span v-if="hasResult">→ {{ props.resultText.length.toLocaleString() }} 字</span>
      </span>
      <span
        v-if="showDiffHighlight && viewMode === 'diff'"
        class="text-[10px] text-base-content/40 inline-flex items-center gap-1"
      >
        <span class="inline-block w-2.5 h-2.5 rounded-sm bg-yellow-200/90 dark:bg-yellow-400/30" />
        标黄为改动
      </span>
      <div class="flex items-center gap-1 ml-auto">
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          :class="{ 'text-success': copyHint === '已复制' }"
          :disabled="!hasResult"
          @click="copyResult"
        >
          {{ copyHint || '复制' }}
        </button>
        <button
          type="button"
          class="btn btn-ghost btn-xs"
          :class="{ 'text-success': exportHint === '已导出' }"
          :disabled="!hasResult"
          @click="exportResult"
        >
          {{ exportHint || '导出' }}
        </button>
      </div>
    </div>

    <div v-if="props.status === 'idle' && !hasResult" class="flex-1 grid place-items-center text-xs text-base-content/40 px-4 text-center">
      输入文本并点击「去AI味」后在此查看结果
    </div>

    <div v-else-if="props.status === 'error'" class="px-3 py-2 shrink-0">
      <div class="alert alert-error py-2 min-h-0 text-xs">
        <span>{{ props.errorMessage || '处理失败，请重试' }}</span>
      </div>
    </div>

    <div v-else-if="showContent" class="flex-1 min-h-0 flex flex-col p-2 gap-2">
      <div
        v-if="viewMode === 'diff'"
        class="grid grid-cols-1 md:grid-cols-2 gap-2 flex-1 min-h-0"
      >
        <article class="border border-base-300/80 rounded-md bg-base-200/20 flex flex-col min-h-0 min-h-[200px] md:min-h-0">
          <h3 class="text-[11px] font-medium text-base-content/50 px-2 py-1 shrink-0 border-b border-base-300/50">
            原文
          </h3>
          <div
            ref="originalScrollRef"
            :class="scrollPaneClass"
            @scroll="onOriginalScroll"
          >
            <pre class="text-xs whitespace-pre-wrap break-words leading-5">
              <DeaiDiffText
                v-if="showDiffHighlight"
                :segments="diffView.original"
              />
              <template v-else>{{ props.originalText }}</template>
            </pre>
          </div>
        </article>
        <article class="border border-base-300/80 rounded-md bg-base-200/20 flex flex-col min-h-0 min-h-[200px] md:min-h-0">
          <h3 class="text-[11px] font-medium text-base-content/50 px-2 py-1 shrink-0 border-b border-base-300/50">
            去AI味结果
          </h3>
          <div
            ref="resultScrollRef"
            :class="scrollPaneClass"
            @scroll="onResultScroll"
          >
            <pre class="text-xs whitespace-pre-wrap break-words leading-5">
              <DeaiDiffText
                v-if="showDiffHighlight"
                :segments="diffView.modified"
                placeholder="等待生成..."
              />
              <template v-else>{{ props.resultText || '等待生成...' }}</template>
            </pre>
          </div>
        </article>
      </div>

      <article v-else class="border border-base-300/80 rounded-md bg-base-200/20 flex flex-col flex-1 min-h-0">
        <h3 class="text-[11px] font-medium text-base-content/50 px-2 py-1 shrink-0 border-b border-base-300/50">
          去AI味结果
        </h3>
        <div :class="scrollPaneClass">
          <pre class="text-xs whitespace-pre-wrap break-words leading-5">
            <DeaiDiffText
              v-if="showDiffHighlight"
              :segments="diffView.modified"
              placeholder="等待生成..."
            />
            <template v-else>{{ props.resultText || '等待生成...' }}</template>
          </pre>
        </div>
      </article>
    </div>
  </section>
</template>
