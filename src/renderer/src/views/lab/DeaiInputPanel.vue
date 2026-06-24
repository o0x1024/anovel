<script setup lang="ts">
import { ref } from 'vue'
import WorkBodyPicker from '../../components/WorkBodyPicker.vue'
import LabAntiAiPresetPicker from './LabAntiAiPresetPicker.vue'
import LabTextFullscreenDialog from './LabTextFullscreenDialog.vue'
import type { LabWritingStyleOption } from '../../composables/useDeaiTask'
import { LAB_UPLOAD_ACCEPT, parseLabFile } from '../../utils/labUpload'
import type { AssistantWorkReference } from '../../../../shared/assistant-types'

const LAB_TEXT_MAX = 50_000
const SYSTEM_PROMPT_MAX = 50_000

type FullscreenField = 'systemPrompt' | 'originalText'

const props = defineProps<{
  originalText: string
  styleId: number | null
  systemPrompt: string
  antiAiRules: string[]
  writingStyles: LabWritingStyleOption[]
  status: 'idle' | 'running' | 'done' | 'error'
}>()

const emit = defineEmits<{
  'update:originalText': [value: string]
  'update:styleId': [value: number | null]
  'update:systemPrompt': [value: string]
  'update:antiAiRules': [value: string[]]
  'file-loaded': [fileName: string]
  'style-changed': [styleId: number | null]
  run: []
  cancel: []
}>()

function onStyleChange(event: Event) {
  const raw = (event.target as HTMLSelectElement).value
  const nextId = raw ? Number(raw) : null
  emit('update:styleId', nextId)
  emit('style-changed', nextId)
}

const uploadError = ref('')
const importLoading = ref(false)
const fullscreenField = ref<FullscreenField | null>(null)

function openFullscreen(field: FullscreenField) {
  fullscreenField.value = field
}

function closeFullscreen() {
  fullscreenField.value = null
}

const canRun = () =>
  props.status !== 'running'
  && props.originalText.trim().length > 0
  && props.systemPrompt.trim().length > 0

async function onWorkImport(ref: AssistantWorkReference) {
  uploadError.value = ''
  importLoading.value = true
  try {
    const text = (await window.anovel.invoke(
      'work:getBodyText',
      ref.workId,
      ref.chapterId ?? null
    )) as string
    const trimmed = text.trim()
    if (!trimmed) {
      uploadError.value = '所选章节暂无正文'
      return
    }
    if (trimmed.length > LAB_TEXT_MAX) {
      uploadError.value = `正文 ${trimmed.length.toLocaleString()} 字，超过 ${LAB_TEXT_MAX.toLocaleString()} 字上限，请选择单章导入`
      return
    }
    emit('update:originalText', trimmed)
    emit('file-loaded', ref.title)
  } catch (error) {
    uploadError.value = error instanceof Error ? error.message : '导入失败'
  } finally {
    importLoading.value = false
  }
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadError.value = ''
  try {
    const text = await parseLabFile(file)
    emit('update:originalText', text)
    emit('file-loaded', file.name)
  } catch (error) {
    uploadError.value = error instanceof Error ? error.message : '文件解析失败'
  } finally {
    input.value = ''
  }
}
</script>

<template>
  <div class="flex flex-col gap-2 shrink-0 min-h-0">
    <!-- 1. 文风选择 -->
    <section class="border border-base-300 rounded-lg bg-base-200/30 shrink-0">
      <div class="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <select
          class="select select-bordered select-xs w-44 shrink-0"
          :value="props.styleId ?? ''"
          :disabled="props.status === 'running'"
          @change="onStyleChange"
        >
          <option value="">不选文风</option>
          <option v-if="!props.writingStyles.length" disabled value="__empty__">暂无可用文风</option>
          <option v-for="style in props.writingStyles" :key="style.id" :value="style.id">
            {{ style.name }}{{ style.is_builtin ? '（内置）' : '' }}
          </option>
        </select>
      </div>
    </section>

    <!-- 2. System Prompt -->
    <section class="border border-base-300 rounded-lg bg-base-200/30 shrink-0 flex flex-col min-h-0">
      <div class="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-base-300/60">
        <span class="text-xs font-semibold text-base-content/70 shrink-0">System Prompt</span>
        <span class="text-[11px] text-base-content/45 shrink-0">可手动编辑</span>
        <div class="flex items-center gap-1 shrink-0 ml-auto">
          <span class="text-[11px] text-base-content/45 tabular-nums">
            {{ props.systemPrompt.length.toLocaleString() }}/50,000
          </span>
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square"
            title="全屏编辑"
            :disabled="props.status === 'running'"
            @click="openFullscreen('systemPrompt')"
          >
            <font-awesome-icon icon="expand" class="w-3 h-3" />
          </button>
        </div>
      </div>
      <textarea
        :value="props.systemPrompt"
        class="w-full h-28 max-h-[26vh] resize-y border-0 rounded-b-lg bg-base-100 text-xs leading-5 p-3 font-mono focus:outline-none focus:ring-0 overflow-y-auto scrollbar-thin"
        :maxlength="SYSTEM_PROMPT_MAX"
        :disabled="props.status === 'running'"
        placeholder="可选文风自动填入 System Prompt，也可直接手动编写"
        @input="emit('update:systemPrompt', ($event.target as HTMLTextAreaElement).value)"
      />
    </section>

    <!-- 3. 输入原文 -->
    <section class="border border-base-300 rounded-lg bg-base-200/30 shrink-0 flex flex-col min-h-0">
      <div class="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-base-300/60">
        <span class="text-xs font-semibold text-base-content/70 shrink-0">输入原文</span>
        <WorkBodyPicker
          :disabled="props.status === 'running' || importLoading"
          show-label
          close-on-select
          dialog-hint="从作品管理中选择章节或全书正文填入输入框"
          @select="onWorkImport"
        />
        <label class="btn btn-ghost btn-xs shrink-0 cursor-pointer">
          <font-awesome-icon icon="upload" class="w-3 h-3" />
          上传
          <input type="file" class="hidden" :accept="LAB_UPLOAD_ACCEPT" @change="onFileChange">
        </label>
        <span class="text-[11px] text-base-content/45 tabular-nums shrink-0">
          {{ props.originalText.length.toLocaleString() }}/50,000
        </span>
        <button
          type="button"
          class="btn btn-ghost btn-xs btn-square shrink-0"
          title="全屏编辑"
          :disabled="props.status === 'running'"
          @click="openFullscreen('originalText')"
        >
          <font-awesome-icon icon="expand" class="w-3 h-3" />
        </button>
        <div class="flex items-center gap-2 shrink-0 ml-auto">
          <button
            v-if="props.status === 'running'"
            type="button"
            class="btn btn-outline btn-error btn-xs"
            @click="emit('cancel')"
          >
            取消
          </button>
          <button
            type="button"
            class="btn btn-primary btn-xs"
            :disabled="!canRun()"
            @click="emit('run')"
          >
            <span v-if="props.status === 'running'" class="loading loading-spinner loading-xs" />
            去AI味
          </button>
        </div>
      </div>

      <textarea
        :value="props.originalText"
        class="w-full h-24 max-h-[22vh] resize-y border-0 rounded-none bg-base-100 text-sm leading-5 p-3 focus:outline-none focus:ring-0 overflow-y-auto scrollbar-thin"
        maxlength="50000"
        placeholder="粘贴、从作品导入或上传 txt / md / docx，可拖拽调整高度"
        @input="emit('update:originalText', ($event.target as HTMLTextAreaElement).value)"
      />

      <div class="px-3 py-2 border-t border-base-300/60">
        <LabAntiAiPresetPicker
          :model-value="props.antiAiRules"
          :disabled="props.status === 'running'"
          @update:model-value="emit('update:antiAiRules', $event)"
        />
      </div>

      <p v-if="uploadError" class="px-3 py-1 text-[11px] text-error border-t border-base-300/60">{{ uploadError }}</p>
    </section>
  </div>

  <LabTextFullscreenDialog
    :open="fullscreenField === 'systemPrompt'"
    title="System Prompt"
    :model-value="props.systemPrompt"
    :max-length="SYSTEM_PROMPT_MAX"
    :disabled="props.status === 'running'"
    monospace
    placeholder="可选文风自动填入 System Prompt，也可直接手动编写"
    @update:model-value="emit('update:systemPrompt', $event)"
    @close="closeFullscreen"
  />

  <LabTextFullscreenDialog
    :open="fullscreenField === 'originalText'"
    title="输入原文"
    :model-value="props.originalText"
    :max-length="LAB_TEXT_MAX"
    :disabled="props.status === 'running'"
    placeholder="粘贴、从作品导入或上传 txt / md / docx"
    @update:model-value="emit('update:originalText', $event)"
    @close="closeFullscreen"
  />
</template>
