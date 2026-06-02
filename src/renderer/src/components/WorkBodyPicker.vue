<script setup lang="ts">
import { ref } from 'vue'
import type { AssistantWorkReference } from '../../../shared/assistant-types'

interface WorkRow {
  id: number
  title: string
}

interface ChapterRow {
  id: number
  title: string
  word_count: number
}

const props = withDefaults(
  defineProps<{
    /** 已选中的引用键，用于多选场景显示「已添加」 */
    attachedKeys?: string[]
    disabled?: boolean
    /** 触发按钮上的 tooltip */
    title?: string
    /** 弹窗标题 */
    dialogTitle?: string
    /** 弹窗说明 */
    dialogHint?: string
    /** 按钮样式类 */
    buttonClass?: string
    /** 是否在按钮上显示文字标签 */
    showLabel?: boolean
    /** 选中后是否关闭弹窗（助手多选时保持打开） */
    closeOnSelect?: boolean
  }>(),
  {
    attachedKeys: () => [],
    title: '从作品导入正文',
    dialogTitle: '从作品导入正文',
    dialogHint: '选择作品中的章节或全书正文',
    buttonClass: 'btn btn-ghost btn-xs shrink-0 cursor-pointer',
    showLabel: false,
    closeOnSelect: false
  }
)

const emit = defineEmits<{
  select: [ref: AssistantWorkReference]
}>()

const showPicker = ref(false)
const works = ref<WorkRow[]>([])
const selectedWork = ref<WorkRow | null>(null)
const chapters = ref<ChapterRow[]>([])
const loading = ref(false)

function refKey(workId: number, chapterId?: number | null): string {
  return `${workId}:${chapterId ?? 'all'}`
}

function isAttached(workId: number, chapterId?: number | null): boolean {
  return props.attachedKeys.includes(refKey(workId, chapterId))
}

async function openPicker() {
  loading.value = true
  selectedWork.value = null
  chapters.value = []
  try {
    works.value = await window.anovel.invoke('work:list') as WorkRow[]
    showPicker.value = true
  } finally {
    loading.value = false
  }
}

async function selectWork(work: WorkRow) {
  selectedWork.value = work
  chapters.value = await window.anovel.invoke('chapter:listByWork', work.id) as ChapterRow[]
}

function pickWork(work: WorkRow, chapterId?: number | null, chapterTitle?: string) {
  if (isAttached(work.id, chapterId)) return
  const refTitle =
    chapterId && chapterTitle ? `《${work.title}》·${chapterTitle}` : `《${work.title}》全文`
  emit('select', { workId: work.id, chapterId: chapterId ?? null, title: refTitle })
  if (props.closeOnSelect) {
    showPicker.value = false
    selectedWork.value = null
  }
}

function fullWorkWordCount(): number {
  return chapters.value.reduce((sum, ch) => sum + (ch.word_count || 0), 0)
}

defineExpose({ openPicker })
</script>

<template>
  <button
    type="button"
    :class="buttonClass"
    :title="title"
    :disabled="disabled || loading"
    @click="openPicker"
  >
    <font-awesome-icon icon="book-open" class="w-3 h-3" />
    <span v-if="showLabel" class="ml-1">作品</span>
  </button>

  <dialog :class="['modal', { 'modal-open': showPicker }]">
    <div class="modal-box max-w-lg w-[92vw]">
      <h3 class="font-bold text-lg mb-1">{{ dialogTitle }}</h3>
      <p class="text-xs text-base-content/45 mb-3">{{ dialogHint }}</p>

      <div v-if="loading" class="py-8 text-center">
        <span class="loading loading-spinner loading-sm" />
      </div>

      <template v-else>
        <div
          v-if="!selectedWork"
          class="max-h-72 overflow-y-auto border border-base-300 rounded-lg divide-y divide-base-300/60"
        >
          <button
            v-for="work in works"
            :key="work.id"
            type="button"
            class="btn btn-ghost btn-sm w-full justify-start rounded-none h-auto min-h-10 py-2"
            @click="selectWork(work)"
          >
            <font-awesome-icon icon="book" class="w-3.5 h-3.5 opacity-50 shrink-0" />
            <span class="truncate">{{ work.title }}</span>
            <font-awesome-icon icon="chevron-right" class="w-3 h-3 opacity-40 ml-auto shrink-0" />
          </button>
          <p v-if="!works.length" class="text-sm text-base-content/40 py-6 text-center">暂无作品</p>
        </div>

        <div v-else class="space-y-2">
          <button
            type="button"
            class="btn btn-ghost btn-xs gap-1 -ml-2 mb-1"
            @click="selectedWork = null"
          >
            <font-awesome-icon icon="arrow-left" class="w-3 h-3" />
            返回作品列表
          </button>

          <p class="text-sm font-medium truncate">{{ selectedWork.title }}</p>

          <button
            type="button"
            class="btn btn-ghost btn-sm w-full justify-start gap-2"
            :class="{ 'btn-disabled opacity-60': isAttached(selectedWork.id, null) || fullWorkWordCount() === 0 }"
            :disabled="isAttached(selectedWork.id, null) || fullWorkWordCount() === 0"
            @click="pickWork(selectedWork)"
          >
            <font-awesome-icon icon="book-open" class="w-3.5 h-3.5 opacity-60 shrink-0" />
            <span class="flex-1 text-left">全书正文</span>
            <span class="text-base-content/40 text-xs">{{ fullWorkWordCount() }} 字</span>
            <span v-if="isAttached(selectedWork.id, null)" class="badge badge-success badge-xs">已添加</span>
          </button>

          <ul class="max-h-52 overflow-y-auto border border-base-300 rounded-lg divide-y divide-base-300/60">
            <li v-for="chapter in chapters" :key="chapter.id">
              <button
                type="button"
                class="btn btn-ghost btn-sm w-full justify-start rounded-none h-auto min-h-9 py-2 gap-2"
                :class="{ 'btn-disabled opacity-60': isAttached(selectedWork.id, chapter.id) || !chapter.word_count }"
                :disabled="isAttached(selectedWork.id, chapter.id) || !chapter.word_count"
                @click="pickWork(selectedWork, chapter.id, chapter.title)"
              >
                <span class="flex-1 truncate text-left">{{ chapter.title }}</span>
                <span class="text-base-content/40 text-xs shrink-0">{{ chapter.word_count || 0 }} 字</span>
                <span
                  v-if="isAttached(selectedWork.id, chapter.id)"
                  class="badge badge-success badge-xs shrink-0"
                >
                  已添加
                </span>
              </button>
            </li>
            <li v-if="!chapters.length" class="text-xs text-base-content/40 py-4 text-center">
              该作品暂无章节
            </li>
          </ul>
        </div>
      </template>

      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" @click="showPicker = false">关闭</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop" @click="showPicker = false">
      <button type="button">close</button>
    </form>
  </dialog>
</template>
