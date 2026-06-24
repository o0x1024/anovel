<script setup lang="ts">
import { computed, ref } from 'vue'
import MarkdownContent from './MarkdownContent.vue'

export interface PreviewSection {
  label: string
  content: string
}

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    sections: PreviewSection[]
    emptyHint?: string
  }>(),
  { emptyHint: '暂无内容可预览' }
)

const emit = defineEmits<{ close: [] }>()

const totalChars = computed(() =>
  props.sections.reduce((n, s) => n + s.content.replace(/\s/g, '').length, 0)
)

const fullText = computed(() =>
  props.sections
    .map(s => `## ${s.label}\n\n${s.content.trim()}`)
    .join('\n\n')
)

const copyHint = ref('')
let copyHintTimer: ReturnType<typeof setTimeout> | null = null

function setCopyHint(text: string) {
  copyHint.value = text
  if (copyHintTimer) clearTimeout(copyHintTimer)
  copyHintTimer = setTimeout(() => {
    copyHint.value = ''
    copyHintTimer = null
  }, 2000)
}

async function copyAll() {
  if (!props.sections.length) return
  try {
    await navigator.clipboard.writeText(fullText.value)
    setCopyHint('已复制')
  } catch {
    setCopyHint('复制失败')
  }
}
</script>

<template>
  <dialog :class="['modal', { 'modal-open': open }]">
    <div class="modal-box w-[94vw] max-w-5xl h-[90vh] p-0 flex flex-col">
      <div class="flex items-center justify-between gap-3 px-5 py-3 border-b border-base-300 shrink-0">
        <h3 class="font-bold text-base truncate">{{ title }}</h3>
        <div class="flex items-center gap-2 shrink-0">
          <span v-if="sections.length" class="text-xs text-base-content/45 tabular-nums">
            {{ sections.length }} 区块 · {{ totalChars.toLocaleString() }} 字
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-sm gap-1"
            :class="{ 'text-success': copyHint === '已复制', 'text-error': copyHint === '复制失败' }"
            :disabled="!sections.length"
            title="复制全部内容"
            @click="copyAll"
          >
            <font-awesome-icon icon="copy" class="w-3.5 h-3.5" />
            {{ copyHint || '复制' }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm btn-square" title="关闭" @click="emit('close')">
            <font-awesome-icon icon="times" class="w-4 h-4" />
          </button>
        </div>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-4">
        <p v-if="!sections.length" class="text-sm text-base-content/40 italic">{{ emptyHint }}</p>
        <div v-else class="space-y-6">
          <section
            v-for="(section, index) in sections"
            :key="`${section.label}-${index}`"
            class="pb-6 border-b border-base-300/50 last:border-0 last:pb-0"
          >
            <h4 class="font-semibold text-sm text-primary mb-2">{{ section.label }}</h4>
            <MarkdownContent :content="section.content" size="sm" />
          </section>
        </div>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop bg-black/40" @click="emit('close')">
      <button type="button">close</button>
    </form>
  </dialog>
</template>
