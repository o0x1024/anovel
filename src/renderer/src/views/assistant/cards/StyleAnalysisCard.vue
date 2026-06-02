<script setup lang="ts">
import { ref } from 'vue'
import StyleAnalysisDiffPanel from './StyleAnalysisDiffPanel.vue'
import type { StyleAnalysisResult } from '../../../../../shared/assistant-types'

const props = defineProps<{
  analysis: StyleAnalysisResult
  previousAnalysis?: StyleAnalysisResult | null
}>()

const emit = defineEmits<{
  saved: [styleId: number]
}>()

const promptTemplate = ref(props.analysis.promptTemplate)
const saving = ref(false)
const savedId = ref<number | null>(null)
const renameOpen = ref(false)
const renameValue = ref('')
const saveError = ref('')

async function saveStyle(rename?: string) {
  saving.value = true
  saveError.value = ''
  try {
    const payload: StyleAnalysisResult = {
      ...props.analysis,
      promptTemplate: promptTemplate.value
    }
    const id = await window.anovel.invoke(
      'assistant:exportStyle',
      payload,
      rename ? { rename } : undefined
    ) as number
    savedId.value = id
    renameOpen.value = false
    emit('saved', id)
  } catch (e) {
    const msg = e instanceof Error ? e.message : '保存失败'
    if (msg.includes('已存在')) {
      renameValue.value = `${props.analysis.styleName}（导入）`
      renameOpen.value = true
    }
    saveError.value = msg
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="card bg-base-200 border border-primary/20 mt-2">
    <div class="card-body p-4 gap-3">
      <div class="flex items-start justify-between gap-2">
        <div>
          <h4 class="font-bold text-sm">{{ analysis.styleName }}</h4>
          <p class="text-xs text-base-content/50 mt-1">{{ analysis.description }}</p>
        </div>
        <span
          class="badge badge-sm"
          :class="{
            'badge-success': analysis.confidence === 'high',
            'badge-warning': analysis.confidence === 'medium',
            'badge-ghost': analysis.confidence === 'low'
          }"
        >
          {{ analysis.confidence }}
        </span>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
        <div><span class="text-base-content/40">句长节奏</span> {{ analysis.dimensions.sentenceRhythm }}</div>
        <div><span class="text-base-content/40">对话风格</span> {{ analysis.dimensions.dialogueStyle }}</div>
        <div><span class="text-base-content/40">叙述距离</span> {{ analysis.dimensions.narrativeDistance }}</div>
        <div><span class="text-base-content/40">节奏</span> {{ analysis.dimensions.pacing }}</div>
      </div>

      <div v-if="analysis.warnings?.length" class="text-xs text-warning">
        {{ analysis.warnings.join('；') }}
      </div>

      <div
        v-if="analysis.stepRules?.decision_rules?.length || analysis.stepRules?.quality_checklist?.length"
        class="text-xs bg-base-300/40 rounded-lg p-2 space-y-1"
      >
        <p class="font-medium text-base-content/60">分步规则（将一并保存）</p>
        <p v-if="analysis.stepRules.identity?.emotional_core?.length">
          情绪：{{ analysis.stepRules.identity.emotional_core.join('、') }}
        </p>
        <p v-if="analysis.stepRules.decision_rules?.length">
          决策规则 {{ analysis.stepRules.decision_rules.length }} 条
        </p>
        <p v-if="analysis.stepRules.quality_checklist?.length">
          检查清单 {{ analysis.stepRules.quality_checklist.length }} 条
        </p>
      </div>

      <div v-if="analysis.referenceText" class="text-xs bg-success/10 border border-success/20 rounded-lg p-2">
        <p class="font-medium text-success">参考范文已提取（{{ analysis.referenceText.length }} 字）</p>
        <p class="text-base-content/50 mt-0.5">保存后将用于 few-shot 风格注入，降低 AI 检测率</p>
      </div>

      <div>
        <label class="text-xs text-base-content/50">Prompt 模板</label>
        <textarea
          v-model="promptTemplate"
          class="textarea textarea-bordered textarea-xs w-full mt-1 min-h-24 font-mono"
        />
      </div>

      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="btn btn-primary btn-xs"
          :disabled="saving || savedId !== null"
          @click="saveStyle()"
        >
          {{ savedId ? `已保存 #${savedId}` : saving ? '保存中...' : '保存到文风管理' }}
        </button>
      </div>

      <p v-if="saveError && !renameOpen" class="text-xs text-error">{{ saveError }}</p>

      <div v-if="renameOpen" class="flex gap-2 items-center">
        <input v-model="renameValue" class="input input-bordered input-xs flex-1" />
        <button type="button" class="btn btn-primary btn-xs" :disabled="saving" @click="saveStyle(renameValue)">
          用新名称保存
        </button>
      </div>

      <StyleAnalysisDiffPanel
        v-if="previousAnalysis"
        :previous="previousAnalysis"
        :current="analysis"
      />
    </div>
  </div>
</template>
