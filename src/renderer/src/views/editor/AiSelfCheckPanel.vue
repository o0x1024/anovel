<script setup lang="ts">
import { ref } from 'vue'
import MarkdownContent from '../../components/MarkdownContent.vue'

const props = defineProps<{
  workId: number
  step: string
  content: string
  label?: string
}>()

const DEFAULT_PROMPTS: Record<string, string> = {
  settings: '检查人设/世界观/冲突是否自洽、有无矛盾、角色功能是否清晰，给出改进建议。',
  volumes: '检查分卷结构是否合理、节奏是否均衡、各卷主题是否递进，给出改进建议。',
  chapters: '检查章节大纲是否连贯、冲突是否升级、钩子是否有效，给出改进建议。',
  body_generation: '检查正文是否符合大纲、锚点是否体现、文风是否一致，列出问题与修改建议。',
  incubator: '检查故事方向是否有吸引力、差异化是否足够、潜在风险有哪些。'
}

const loading = ref(false)
const report = ref('')
const error = ref('')

async function runSelfCheck() {
  if (!props.content.trim() || loading.value) return
  loading.value = true
  report.value = ''
  error.value = ''
  try {
    const systemPrompt = [
      '你是资深小说编辑，对作者内容进行自检评审。',
      DEFAULT_PROMPTS[props.step] || '检查内容质量、逻辑自洽性和可改进之处。',
      '输出格式：## 总体评价 / ## 优点 / ## 问题 / ## 修改建议'
    ].join('\n')
    const res = await window.anovel.invoke('model:chat', {
      prompt: props.content,
      systemPrompt: [
        systemPrompt,
        '若系统注入了「文风质量检查清单」，请逐条对照并在「问题」中标注未通过项。'
      ].join('\n'),
      workId: props.workId,
      step: `${props.step}_self_check`,
      enrichWorkContext: true
    }) as { success: boolean; content: string; error?: string }
    if (res.success) {
      report.value = res.content
    } else {
      error.value = res.error || '自检失败'
    }
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="mt-3 pt-3 border-t border-base-300">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs font-medium text-base-content/50">{{ label || 'AI 自检' }}</span>
      <button
        class="btn btn-ghost btn-xs gap-1"
        :disabled="!content.trim() || loading"
        @click="runSelfCheck"
      >
        <font-awesome-icon :icon="loading ? 'spinner' : 'clipboard-check'" :spin="loading" class="w-3 h-3" />
        {{ loading ? '自检中...' : '运行自检' }}
      </button>
    </div>
    <div v-if="error" class="alert alert-error text-xs py-2 mb-2">{{ error }}</div>
    <div v-if="report" class="border border-base-300 rounded-lg p-2 bg-base-100 max-h-48 overflow-auto">
      <MarkdownContent :content="report" size="xs" />
    </div>
  </div>
</template>
