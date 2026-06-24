<script setup lang="ts">
import { ref, watch } from 'vue'
import { useToast } from '../../composables/useToast'

const props = defineProps<{ workId: number; content: string; modelType?: string; modelName?: string }>()
const emit = defineEmits<{ polished: [content: string]; 'rules-added': [rules: string[]] }>()

const { showToast } = useToast()

interface TraceIssue {
  type: string
  label: string
  severity: string
  count: number
}

interface TraceReport {
  issues: TraceIssue[]
  totalScore: number
  summary: string
}

const report = ref<TraceReport | null>(null)
const polishing = ref(false)
const addingRules = ref(false)
const suggestedRules = ref<string[]>([])

watch(() => props.content, (c) => {
  if (c.trim()) void detect()
  else report.value = null
}, { immediate: true })

async function detect() {
  report.value = await window.anovel.invoke('aitrace:detect', props.content) as TraceReport
  if (props.content.trim()) {
    suggestedRules.value = await window.anovel.invoke('aitrace:suggestRules', props.content) as string[]
  } else {
    suggestedRules.value = []
  }
}

async function addSuggestedRules() {
  if (!suggestedRules.value.length || addingRules.value) return
  addingRules.value = true
  try {
    const merged = await window.anovel.invoke(
      'setting:appendAntiAiRules',
      props.workId,
      suggestedRules.value
    ) as string[]
    emit('rules-added', merged)
    showToast('success', `成功加入 ${suggestedRules.value.length} 条去AI规则，下次生成时生效！`)
  } catch (e) {
    showToast('error', e instanceof Error ? e.message : '添加失败')
  } finally {
    addingRules.value = false
  }
}

async function polish() {
  if (!props.content.trim() || polishing.value) return
  polishing.value = true
  try {
    const modelOpts: { modelType?: string; modelName?: string } = {}
    if (props.modelType) modelOpts.modelType = props.modelType
    if (props.modelName) modelOpts.modelName = props.modelName
    const res = await window.anovel.invoke('aitrace:polish', props.workId, props.content, modelOpts) as {
      success: boolean
      content?: string
      error?: string
    }
    if (res.success && res.content) {
      emit('polished', res.content)
      await detect()
    } else {
      alert(res.error || '润色失败')
    }
  } finally {
    polishing.value = false
  }
}
</script>

<template>
  <div v-if="report && report.issues.length" class="mt-3 pt-3 border-t border-base-300">
    <div class="flex items-center justify-between mb-2 flex-wrap gap-2">
      <span class="text-xs font-medium text-base-content/50">AI 痕迹检测</span>
      <div class="flex gap-1 flex-wrap">
        <button
          v-if="suggestedRules.length"
          type="button"
          class="btn btn-primary btn-xs"
          :disabled="addingRules"
          @click="addSuggestedRules"
        >
          {{ addingRules ? '添加中...' : '加入去AI规则' }}
        </button>
        <button class="btn btn-outline btn-xs" :disabled="polishing" @click="polish">
          {{ polishing ? '消除中...' : '一键润色' }}
        </button>
      </div>
    </div>
    <p class="text-xs text-base-content/60 mb-1">{{ report.summary }}（指数 {{ report.totalScore }}）</p>
    <p v-if="suggestedRules.length" class="text-xs text-base-content/45 mb-2">
      可将检测到的 {{ suggestedRules.length }} 条约束加入 system prompt，下次生成时生效
    </p>
    <ul class="space-y-0.5">
      <li v-for="(issue, i) in report.issues.slice(0, 5)" :key="i" class="text-xs text-warning">
        {{ issue.label }} × {{ issue.count }}
      </li>
    </ul>
  </div>
</template>
