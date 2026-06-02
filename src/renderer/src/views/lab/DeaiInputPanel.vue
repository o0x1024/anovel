<script setup lang="ts">
import { computed, ref } from 'vue'
import WorkBodyPicker from '../../components/WorkBodyPicker.vue'
import type { LabWritingStyleOption } from '../../composables/useDeaiTask'
import { LAB_UPLOAD_ACCEPT, parseLabFile } from '../../utils/labUpload'
import type { AssistantWorkReference } from '../../../../shared/assistant-types'

const LAB_TEXT_MAX = 50_000

const props = defineProps<{
  originalText: string
  styleId: number | null
  writingStyles: LabWritingStyleOption[]
  status: 'idle' | 'running' | 'done' | 'error'
}>()

const emit = defineEmits<{
  'update:originalText': [value: string]
  'update:styleId': [value: number | null]
  'file-loaded': [fileName: string]
  run: []
  cancel: []
}>()

const selectedWritingStyle = computed(() =>
  props.writingStyles.find(style => style.id === props.styleId) ?? null
)

function onStyleChange(event: Event) {
  const raw = (event.target as HTMLSelectElement).value
  emit('update:styleId', raw ? Number(raw) : null)
}

const uploadError = ref('')
const importLoading = ref(false)

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
  <section class="border border-base-300 rounded-lg bg-base-200/30 shrink-0">
    <div class="px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-base-300/60">
      <span class="text-xs font-semibold text-base-content/70 shrink-0">输入原文</span>
      <select
        class="select select-bordered select-xs w-36 shrink-0"
        :value="props.styleId ?? ''"
        :disabled="!props.writingStyles.length"
        @change="onStyleChange"
      >
        <option v-if="!props.writingStyles.length" value="">暂无文风</option>
        <option v-for="style in props.writingStyles" :key="style.id" :value="style.id">
          {{ style.name }}{{ style.is_builtin ? '（内置）' : '' }}
        </option>
      </select>
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
      <p
        v-if="selectedWritingStyle?.description"
        class="text-[11px] text-base-content/50 line-clamp-1 flex-1 min-w-[120px]"
        :title="selectedWritingStyle.description"
      >
        {{ selectedWritingStyle.description }}
      </p>
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
          :disabled="props.status === 'running' || !props.styleId"
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

    <p v-if="uploadError" class="px-3 py-1 text-[11px] text-error border-t border-base-300/60">{{ uploadError }}</p>
  </section>
</template>
