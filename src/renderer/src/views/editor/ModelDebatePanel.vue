<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  workId: number
  prompt: string
  systemPrompt: string
}>()

const emit = defineEmits<{ apply: [content: string] }>()

const loading = ref(false)
const result = ref<{
  variants: { modelType: string; content: string; success: boolean; error?: string }[]
  diffSummary: string
  fusionSuggestion: string
} | null>(null)

async function runDebate() {
  if (!props.prompt.trim() || loading.value) return
  loading.value = true
  result.value = null
  try {
    result.value = await window.anovel.invoke('debate:run', props.workId, props.prompt, props.systemPrompt) as typeof result.value
    await window.anovel.invoke('taste:recordChoice', props.workId, 'model_debate', '触发多模型辩论')
  } finally {
    loading.value = false
  }
}

function pickVariant(content: string, modelType: string) {
  emit('apply', content)
  void window.anovel.invoke('taste:recordChoice', props.workId, 'debate_pick', modelType)
}
</script>

<template>
  <div class="mt-3 pt-3 border-t border-base-300">
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs font-medium text-base-content/50">多模型辩论</span>
      <button class="btn btn-outline btn-xs" :disabled="!prompt.trim() || loading" @click="runDebate">
        {{ loading ? '辩论中...' : '双模型并行生成' }}
      </button>
    </div>
    <template v-if="result">
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
        <div
          v-for="v in result.variants"
          :key="v.modelType"
          class="border border-base-300 rounded-lg p-2 bg-base-100"
        >
          <div class="flex justify-between items-center mb-1">
            <span class="text-xs font-semibold uppercase">{{ v.modelType }}</span>
            <button
              v-if="v.success"
              class="btn btn-primary btn-xs"
              @click="pickVariant(v.content, v.modelType)"
            >
              选用
            </button>
          </div>
          <p v-if="v.success" class="text-xs text-base-content/70 whitespace-pre-wrap max-h-32 overflow-auto">{{ v.content }}</p>
          <p v-else class="text-xs text-error">{{ v.error || '生成失败' }}</p>
        </div>
      </div>
      <div v-if="result.diffSummary" class="text-xs text-base-content/60 mb-1">
        <strong>差异：</strong>{{ result.diffSummary.slice(0, 200) }}
      </div>
      <div v-if="result.fusionSuggestion" class="text-xs text-primary">
        <strong>融合建议：</strong>{{ result.fusionSuggestion }}
      </div>
    </template>
  </div>
</template>
