<script setup lang="ts">
import { ref, watch } from 'vue'
import { buildTextDiff, type TextDiffSegment } from '../../../../shared/text-diff'

const props = defineProps<{
  chapterId: number | null
  currentContent: string
}>()

interface Version {
  id: number
  version_number: number
  content: string | null
  word_count: number
  model_type: string | null
  create_time: string
}

const versions = ref<Version[]>([])
const loading = ref(false)
const showModal = ref(false)
const selectedVersion = ref<Version | null>(null)
const diffOriginal = ref<TextDiffSegment[]>([])
const diffModified = ref<TextDiffSegment[]>([])

watch(() => props.chapterId, () => { versions.value = []; selectedVersion.value = null })

async function loadVersions() {
  if (!props.chapterId) return
  loading.value = true
  try {
    versions.value = await window.anovel.invoke('chapter:listVersions', props.chapterId) as Version[]
  } finally {
    loading.value = false
  }
}

function open() {
  showModal.value = true
  loadVersions()
}

function selectVersion(v: Version) {
  selectedVersion.value = v
  if (v.content) {
    const diff = buildTextDiff(v.content, props.currentContent)
    diffOriginal.value = diff.original
    diffModified.value = diff.modified
  } else {
    diffOriginal.value = []
    diffModified.value = []
  }
}

function formatTime(t: string) {
  return t.replace('T', ' ').slice(0, 19)
}

defineExpose({ open, loadVersions })
</script>

<template>
  <button
    class="btn btn-ghost btn-xs gap-1"
    :disabled="!chapterId"
    @click="open"
    title="查看版本历史与修改对比"
  >
    <font-awesome-icon icon="clock-rotate-left" class="w-3 h-3" />
    版本
  </button>

  <dialog class="modal" :class="{ 'modal-open': showModal }">
    <div class="modal-box w-[92vw] max-w-6xl h-[85vh] flex flex-col p-0">
      <div class="flex items-center justify-between px-6 py-3 border-b border-base-300 shrink-0">
        <h3 class="font-bold text-sm">章节版本历史 · V{{ versions.length }}</h3>
        <button class="btn btn-ghost btn-xs" @click="showModal = false">关闭</button>
      </div>

      <div class="flex-1 flex min-h-0">
        <div class="w-56 border-r border-base-300 overflow-auto shrink-0 p-3 space-y-1">
          <p v-if="loading" class="text-xs text-base-content/40">加载中...</p>
          <p v-else-if="!versions.length" class="text-xs text-base-content/40">暂无历史版本。<br/>保存章节或 AI 修改时自动创建快照。</p>
          <div
            v-for="v in versions"
            :key="v.id"
            class="rounded p-2 cursor-pointer text-xs transition-colors border"
            :class="selectedVersion?.id === v.id ? 'bg-primary/10 border-primary/30' : 'hover:bg-base-200 border-transparent'"
            @click="selectVersion(v)"
          >
            <p class="font-medium">V{{ v.version_number }}</p>
            <p class="text-base-content/50">{{ formatTime(v.create_time) }}</p>
            <p class="text-base-content/40">{{ v.word_count }} 字</p>
          </div>
        </div>

        <div class="flex-1 overflow-auto">
          <template v-if="selectedVersion && diffOriginal.length">
            <div class="grid grid-cols-2 h-full">
              <div class="overflow-auto border-r border-base-200 p-3">
                <p class="text-xs font-medium text-base-content/50 mb-2 sticky top-0 bg-base-100 pb-1">V{{ selectedVersion.version_number }}（旧）· {{ selectedVersion.word_count }} 字</p>
                <div class="text-xs leading-relaxed whitespace-pre-wrap font-mono">
                  <span
                    v-for="(seg, i) in diffOriginal"
                    :key="'o'+i"
                    :class="seg.changed ? 'bg-error/10 text-error line-through px-0.5' : 'text-base-content/60'"
                  >{{ seg.text }}</span>
                </div>
              </div>
              <div class="overflow-auto p-3">
                <p class="text-xs font-medium text-base-content/50 mb-2 sticky top-0 bg-base-100 pb-1">当前版本 · {{ props.currentContent.replace(/\s/g, '').length }} 字</p>
                <div class="text-xs leading-relaxed whitespace-pre-wrap font-mono">
                  <span
                    v-for="(seg, i) in diffModified"
                    :key="'m'+i"
                    :class="seg.changed ? 'bg-success/10 text-success px-0.5' : 'text-base-content/60'"
                  >{{ seg.text }}</span>
                </div>
              </div>
            </div>
          </template>
          <p v-else-if="selectedVersion && !diffOriginal.length" class="text-xs text-base-content/40 text-center pt-12">
            {{ selectedVersion.content ? '内容相同，无差异' : '该版本无正文内容' }}
          </p>
          <p v-else class="text-xs text-base-content/40 text-center pt-12">
            选择左侧版本查看与当前正文的字符级对比
          </p>
        </div>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop" @click="showModal = false">
      <button type="button">close</button>
    </form>
  </dialog>
</template>
