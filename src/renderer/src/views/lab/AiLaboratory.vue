<script setup lang="ts">
import { ref } from 'vue'
import DeaiInputPanel from './DeaiInputPanel.vue'
import DeaiResultPanel from './DeaiResultPanel.vue'
import DeaiHistoryDrawer from './DeaiHistoryDrawer.vue'
import AigcDetectInputPanel from './AigcDetectInputPanel.vue'
import WordTablePanel from './WordTablePanel.vue'
import HumanRewriteReferencePanel from './HumanRewriteReferencePanel.vue'
import BodyModelSelect from '../../components/BodyModelSelect.vue'
import { useDeaiTask } from '../../composables/useDeaiTask'
import { useAigcDetect } from '../../composables/useAigcDetect'
import { useLabModel } from '../../composables/useLabModel'
import { normalizeBodyParagraphSpacing } from '../../../../shared/normalize-body-text'

type LabTab = 'deai' | 'aigc-detect' | 'rewrite-reference' | 'wordtable'
const activeTab = ref<LabTab>('aigc-detect')

const { labModelType, labModelName, labThinkingEnabled, modelParams } = useLabModel()

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

const {
  inputText: aigcInputText,
  status: aigcStatus,
  rewriting: aigcRewriting,
  applyingWordTable: aigcApplyingWordTable,
  rewriteProgress: aigcRewriteProgress,
  rewritePatches: aigcRewritePatches,
  rewriteGoal: aigcRewriteGoal,
  needsManualRecheck: aigcNeedsManualRecheck,
  rewriteDecisions: aigcRewriteDecisions,
  rewritePreviewText: aigcRewritePreviewText,
  errorMessage: aigcError,
  result: aigcResult,
  seedOpts: aigcSeedOpts,
  downloadProgress: aigcDownloadProgress,
  run: aigcRun,
  rewrite: aigcRewrite,
  applyWordTableReplace: aigcApplyWordTable,
  decideSentencePatch: aigcDecideSentencePatch,
  acceptAllSentencePatches: aigcAcceptAllSentencePatches,
  applyAcceptedSentencePatches: aigcApplyAcceptedSentencePatches,
  cancel: aigcCancel
} = useAigcDetect()

const pageError = ref('')

function requireLabModelParams() {
  if (!labModelType.value) {
    pageError.value = '请先在右上角选择模型'
    return null
  }
  return modelParams()
}

async function onRun() {
  pageError.value = ''
  const params = requireLabModelParams()
  if (!params) return
  try {
    await run(params)
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : '执行失败'
  }
}

async function onAigcRun() {
  pageError.value = ''
  const params = requireLabModelParams()
  if (!params) return
  try {
    await aigcRun(params)
  } catch (error) {
    if ((error instanceof Error ? error.message : '') !== '已取消') {
      pageError.value = error instanceof Error ? error.message : '检测失败'
    }
  }
}

async function onAigcRewrite() {
  pageError.value = ''
  const params = requireLabModelParams()
  if (!params) return
  try {
    await aigcRewrite(params)
  } catch (error) {
    if ((error instanceof Error ? error.message : '') !== '已取消') {
      pageError.value = error instanceof Error ? error.message : '改写失败'
    }
  }
}

async function onAigcApplyWordTable() {
  pageError.value = ''
  try {
    await aigcApplyWordTable()
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : '词表替换失败'
  }
}

async function onDeaiApplyWordTable() {
  pageError.value = ''
  const text = originalText.value.trim()
  if (!text) {
    pageError.value = '请输入待处理文本'
    return
  }
  try {
    const replaced = await window.anovel.invoke('lab:wordtable:apply', text) as string
    originalText.value = normalizeBodyParagraphSpacing(replaced)
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : '词表替换失败'
  }
}

function onAigcClearResult() {
  aigcResult.value = null
  aigcStatus.value = 'idle'
}

function onApplyAcceptedSentencePatches() {
  pageError.value = ''
  try {
    aigcApplyAcceptedSentencePatches()
  } catch (error) {
    pageError.value = error instanceof Error ? error.message : '应用逐句补丁失败'
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
      <h1 class="text-sm font-bold shrink-0">AI 实验室</h1>

      <!-- Tab switcher -->
      <div role="tablist" class="tabs tabs-box tabs-xs ml-2">
        <a
          role="tab"
          href="#"
          class="tab"
          :class="{ 'tab-active': activeTab === 'aigc-detect' }"
          @click.prevent="activeTab = 'aigc-detect'"
        >AIGC检测</a>
        <a
          role="tab"
          href="#"
          class="tab"
          :class="{ 'tab-active': activeTab === 'deai' }"
          @click.prevent="activeTab = 'deai'"
        >去AI味</a>
        <a
          role="tab"
          href="#"
          class="tab"
          :class="{ 'tab-active': activeTab === 'wordtable' }"
          @click.prevent="activeTab = 'wordtable'"
        >词表替换</a>
        <a
          role="tab"
          href="#"
          class="tab"
          :class="{ 'tab-active': activeTab === 'rewrite-reference' }"
          @click.prevent="activeTab = 'rewrite-reference'"
        >改写案例</a>
      </div>

      <div class="ml-auto flex items-center gap-2 shrink-0">
        <BodyModelSelect
          v-model:model-type="labModelType"
          v-model:model-name="labModelName"
          explicit-selection
        />
        <label
          class="flex items-center gap-1 cursor-pointer shrink-0"
          title="深度思考"
        >
          <font-awesome-icon icon="brain" class="w-3.5 h-3.5 text-base-content/50" />
          <input
            v-model="labThinkingEnabled"
            type="checkbox"
            class="toggle toggle-primary toggle-xs"
          />
        </label>
        <button
          v-if="activeTab === 'deai'"
          type="button"
          class="btn btn-ghost btn-xs"
          @click="showHistory = true"
        >
          历史记录
        </button>
      </div>
    </header>

    <p v-if="pageError" class="text-xs text-error shrink-0 px-1">{{ pageError }}</p>

    <!-- De-AI tab content -->
    <template v-if="activeTab === 'deai'">
      <DeaiInputPanel
        v-model:original-text="originalText"
        v-model:style-id="styleId"
        v-model:system-prompt="systemPrompt"
        v-model:anti-ai-rules="selectedAntiAiRules"
        :writing-styles="writingStyles"
        :status="status"
        @run="onRun"
        @wordtable-apply="onDeaiApplyWordTable"
        @cancel="cancel"
        @file-loaded="onFileLoaded"
        @style-changed="onStyleChanged"
      />

      <DeaiResultPanel
        v-model:view-mode="resultViewMode"
        :original-text="originalText"
        :result-text="resultText"
        :status="status"
        :error-message="errorMessage"
        class="flex-1 min-h-0"
      />
    </template>

    <!-- AIGC Detection tab content -->
    <template v-if="activeTab === 'aigc-detect'">
      <AigcDetectInputPanel
        v-model:input-text="aigcInputText"
        v-model:seed-opts="aigcSeedOpts"
        :status="aigcStatus"
        :rewriting="aigcRewriting"
        :applying-word-table="aigcApplyingWordTable"
        :rewrite-progress="aigcRewriteProgress"
        :rewrite-patches="aigcRewritePatches"
        :rewrite-goal="aigcRewriteGoal"
        :needs-manual-recheck="aigcNeedsManualRecheck"
        :rewrite-decisions="aigcRewriteDecisions"
        :rewrite-preview-text="aigcRewritePreviewText"
        :result="aigcResult"
        :error-message="aigcError"
        :download-progress="aigcDownloadProgress"
        class="flex-1 min-h-0"
        @run="onAigcRun"
        @rewrite="onAigcRewrite"
        @wordtable-apply="onAigcApplyWordTable"
        @cancel="aigcCancel"
        @clear-result="onAigcClearResult"
        @accept-patch="aigcDecideSentencePatch($event, 'accepted')"
        @reject-patch="aigcDecideSentencePatch($event, 'rejected')"
        @accept-all-patches="aigcAcceptAllSentencePatches"
        @apply-accepted-patches="onApplyAcceptedSentencePatches"
      />
    </template>

    <!-- Word Table tab content -->
    <template v-if="activeTab === 'rewrite-reference'">
      <HumanRewriteReferencePanel class="flex-1 min-h-0" />
    </template>

    <!-- Word Table tab content -->
    <template v-if="activeTab === 'wordtable'">
      <WordTablePanel class="flex-1 min-h-0" />
    </template>
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
