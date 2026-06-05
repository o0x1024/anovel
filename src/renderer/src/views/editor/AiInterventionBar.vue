<script setup lang="ts">
import { ref } from 'vue'
import {
  INCUBATOR_AB_VARIANTS_USER_SUFFIX,
  INCUBATOR_MICRO_INSTRUCT_SYSTEM,
  INCUBATOR_REJECT_RETRY_SUFFIX
} from '../../../../shared/incubator-analysis-prompts'
import type { ModelChatResult } from './useModelChat'

const props = defineProps<{
  workId: number
  step: string
  content: string
  regeneratePrompt: string
  regenerateSystemPrompt: string
  maxTokens?: number
  /** 批量章节大纲等：当前分卷，用于精简 work_context */
  volumeId?: number
  /** 设为 false 可跳过核心设定注入（孵化器等探索阶段使用） */
  enrichWorkContext?: boolean
}>()

const emit = defineEmits<{
  'update:content': [value: string]
}>()

const microInstruction = ref('')
const microLoading = ref(false)
const rejectLoading = ref(false)
const abLoading = ref(false)
const showReject = ref(false)
const abVariants = ref<{ label: string; text: string }[]>([])

const rejectReasons = [
  { value: 'off_anchor', label: '偏离锚点' },
  { value: 'wrong_style', label: '文风不对' },
  { value: 'slow_pace', label: '情节拖沓' },
  { value: 'logic_error', label: '逻辑不通' },
  { value: 'cliche', label: '太俗套' },
  { value: 'bad_dialogue', label: '对话不自然' },
  { value: 'no_surprise', label: '缺乏惊喜' },
  { value: 'other', label: '其他问题' }
]

async function callModel(prompt: string, systemPrompt: string, stepSuffix: string): Promise<ModelChatResult> {
  return await window.anovel.invoke('model:chat', {
    prompt,
    systemPrompt,
    workId: props.workId,
    step: `${props.step}_${stepSuffix}`,
    maxTokens: props.maxTokens,
    volumeId: props.volumeId,
    enrichWorkContext: props.enrichWorkContext
  }) as ModelChatResult
}

async function applyMicroInstruction() {
  if (!microInstruction.value.trim() || !props.content.trim() || microLoading.value) return
  microLoading.value = true
  try {
    const res = await callModel(
      `【原文】\n${props.content}\n\n【修改指令】\n${microInstruction.value.trim()}\n\n请输出修改后的完整内容。`,
      INCUBATOR_MICRO_INSTRUCT_SYSTEM,
      'micro_instruct'
    )
    if (res.success) {
      emit('update:content', res.content)
      microInstruction.value = ''
    } else {
      alert(res.error || '修改失败')
    }
  } finally {
    microLoading.value = false
  }
}

async function rejectAndRegenerate(reason: string) {
  if (!props.regeneratePrompt.trim() || rejectLoading.value) return
  rejectLoading.value = true
  showReject.value = false
  try {
    await window.anovel.invoke('genlog:recordReject', props.workId, props.step, reason)
    await window.anovel.invoke('taste:recordReject', props.workId, reason)
    const reasonLabel = rejectReasons.find(r => r.value === reason)?.label ?? reason
    const res = await callModel(
      `${props.regeneratePrompt}\n\n【上次生成被拒绝】原因：${reasonLabel}。${INCUBATOR_REJECT_RETRY_SUFFIX}`,
      props.regenerateSystemPrompt,
      'reject_retry'
    )
    if (res.success) {
      emit('update:content', res.content)
    } else {
      alert(res.error || '重新生成失败')
    }
  } finally {
    rejectLoading.value = false
  }
}

async function generateAbVariants() {
  if (!props.regeneratePrompt.trim() || abLoading.value) return
  abLoading.value = true
  abVariants.value = []
  try {
    const res = await callModel(
      `${props.regeneratePrompt}\n\n${INCUBATOR_AB_VARIANTS_USER_SUFFIX}`,
      props.regenerateSystemPrompt,
      'ab_variants'
    )
    if (res.success) {
      const match = res.content.match(/```json\s*([\s\S]*?)```/)
      const raw = match?.[1] ?? res.content
      try {
        const parsed = JSON.parse(raw) as {
          variants?: { label?: string; text?: string; summary?: string }[]
        }
        abVariants.value = (parsed.variants ?? [])
          .filter(v => (v.summary ?? v.text)?.trim())
          .map((v, i) => ({
            label: v.label || `版本${String.fromCharCode(65 + i)}`,
            text: (v.summary ?? v.text)!.trim()
          }))
      } catch {
        alert('未能解析 A/B 版本，请重试')
      }
    } else {
      alert(res.error || 'A/B 生成失败')
    }
  } finally {
    abLoading.value = false
  }
}

function pickVariant(text: string) {
  emit('update:content', text)
  abVariants.value = []
  void window.anovel.invoke('taste:recordChoice', props.workId, 'ab_pick', text.slice(0, 80))
}
</script>

<template>
  <div class="mt-3 pt-3 border-t border-base-300 space-y-3">
    <p class="text-xs font-medium text-base-content/50">过程干预</p>

    <div class="flex flex-wrap gap-2 items-end">
      <input
        v-model="microInstruction"
        type="text"
        class="input input-bordered input-xs flex-1 min-w-[160px]"
        placeholder="微指令，如：加强冲突感、缩短开头..."
        @keyup.enter="applyMicroInstruction"
      />
      <button
        class="btn btn-outline btn-xs"
        :disabled="!microInstruction.trim() || !content.trim() || microLoading"
        @click="applyMicroInstruction"
      >
        {{ microLoading ? '修改中...' : '微指令修改' }}
      </button>
      <button
        class="btn btn-outline btn-xs"
        :disabled="rejectLoading"
        @click="showReject = !showReject"
      >
        {{ rejectLoading ? '重生成中...' : '否决重试' }}
      </button>
      <button
        class="btn btn-outline btn-xs"
        :disabled="abLoading"
        @click="generateAbVariants"
      >
        {{ abLoading ? '生成中...' : 'A/B 对比' }}
      </button>
    </div>

    <div v-if="showReject" class="flex flex-wrap gap-1">
      <button
        v-for="r in rejectReasons"
        :key="r.value"
        class="btn btn-ghost btn-xs"
        :disabled="rejectLoading"
        @click="rejectAndRegenerate(r.value)"
      >
        {{ r.label }}
      </button>
    </div>

    <div v-if="abVariants.length" class="grid grid-cols-1 sm:grid-cols-2 gap-2">
      <div
        v-for="v in abVariants"
        :key="v.label"
        class="border border-base-300 rounded-lg p-2 bg-base-100"
      >
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs font-semibold">{{ v.label }}</span>
          <button class="btn btn-primary btn-xs" @click="pickVariant(v.text)">选用</button>
        </div>
        <p class="text-xs text-base-content/70 whitespace-pre-wrap max-h-32 overflow-auto">{{ v.text }}</p>
      </div>
    </div>
  </div>
</template>
