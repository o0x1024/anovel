<script setup lang="ts">
import { ref } from 'vue'
import DeaiInputPanel from './DeaiInputPanel.vue'
import DeaiResultPanel from './DeaiResultPanel.vue'
import DeaiHistoryDrawer from './DeaiHistoryDrawer.vue'
import { useDeaiTask } from '../../composables/useDeaiTask'

const showHistory = ref(false)
const {
  originalText,
  resultText,
  styleId,
  systemPrompt,
  writingStyles,
  styleNameById,
  sourceFile,
  selectedAntiAiRules,
  resultViewMode,
  status,
  errorMessage,
  historyList,
  loadingHistory,
  run,
  cancel,
  loadFromHistory,
  deleteHistory,
  refreshSystemPromptFromStyle
} = useDeaiTask()

const pageError = ref('')

async function onRun() {
  pageError.value = ''
  try {
    await run()
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : '执行失败'
  }
}

async function onSelectHistory(taskId: number) {
  await loadFromHistory(taskId)
  showHistory.value = false
}

async function onDeleteHistory(taskId: number) {
  if (!confirm('删除该历史记录？')) return
  await deleteHistory(taskId)
}

function onFileLoaded(name: string) {
  sourceFile.value = name
}

async function onStyleChanged(styleIdValue: number | null) {
  pageError.value = ''
  try {
    await refreshSystemPromptFromStyle(styleIdValue)
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : '生成 System Prompt 失败'
  }
}
</script>

<template>
  <div class="h-full min-h-0 flex flex-col gap-2 p-3 lg:p-4 overflow-hidden">
    <header class="flex items-center gap-2 shrink-0 min-h-9">
      <font-awesome-icon icon="flask" class="w-4 h-4 text-primary shrink-0" />
      <h1 class="text-sm font-bold shrink-0">AI 实验室 · 去AI味</h1>
      <span class="text-[11px] text-base-content/45 truncate hidden md:inline">
        编辑 System Prompt，选择文风自动填入
      </span>
      <button type="button" class="btn btn-ghost btn-xs ml-auto shrink-0" @click="showHistory = true">
        历史记录
      </button>
    </header>

    <p v-if="pageError" class="text-xs text-error shrink-0 px-1">{{ pageError }}</p>

    <DeaiInputPanel
      v-model:original-text="originalText"
      v-model:style-id="styleId"
      v-model:system-prompt="systemPrompt"
      v-model:anti-ai-rules="selectedAntiAiRules"
      :writing-styles="writingStyles"
      :status="status"
      @run="onRun"
      @cancel="cancel"
      @file-loaded="onFileLoaded"
      @style-changed="onStyleChanged"
    />

    <!-- 4. 处理结果 -->
    <DeaiResultPanel
      v-model:view-mode="resultViewMode"
      :original-text="originalText"
      :result-text="resultText"
      :status="status"
      :error-message="errorMessage"
      class="flex-1 min-h-0"
    />
  </div>

  <DeaiHistoryDrawer
    :open="showHistory"
    :loading="loadingHistory"
    :items="historyList"
    :style-name-by-id="styleNameById"
    @close="showHistory = false"
    @select="onSelectHistory"
    @delete="onDeleteHistory"
  />
</template>
