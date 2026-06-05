<script setup lang="ts">
import { ref, watch, nextTick, onMounted, computed } from 'vue'
import { uploadAssistantDocument, ASSISTANT_UPLOAD_ACCEPT } from '../../utils/assistantUpload'
import { assistantModelLabel, isSameAssistantModel, ASSISTANT_MODEL_LABELS } from '../../services/assistantSession'
import AssistantWorkPicker from './AssistantWorkPicker.vue'
import type { AssistantModelOption, AssistantWorkReference } from '../../../../shared/assistant-types'

const props = defineProps<{
  sending: boolean
  attachedDocs: { id: number; title: string }[]
  attachedWorks: AssistantWorkReference[]
  modelOptions: AssistantModelOption[]
}>()

const modelType = defineModel<string | null>('modelType', { default: null })
const modelName = defineModel<string | null>('modelName', { default: null })

const emit = defineEmits<{
  send: [text: string, documentIds: number[], workReferences: AssistantWorkReference[]]
  cancel: []
  docsCleared: []
  worksCleared: []
  docAttached: [doc: { id: number; title: string }]
  docRemoved: [id: number]
  workAttached: [ref: AssistantWorkReference]
  workRemoved: [key: string]
}>()

const attachedDocIds = defineModel<number[]>('attachedDocIds', { default: () => [] })

function workRefKey(ref: AssistantWorkReference): string {
  return `${ref.workId}:${ref.chapterId ?? 'all'}`
}

const attachedWorkKeys = computed(() => props.attachedWorks.map(workRefKey))

const groupedModelOptions = computed(() => {
  const order: string[] = []
  const groups = new Map<string, AssistantModelOption[]>()
  const labelByType = new Map<string, string>()
  for (const option of props.modelOptions) {
    if (!groups.has(option.model_type)) {
      order.push(option.model_type)
      groups.set(option.model_type, [])
      labelByType.set(
        option.model_type,
        option.provider_label ?? ASSISTANT_MODEL_LABELS[option.model_type] ?? option.model_type
      )
    }
    groups.get(option.model_type)!.push(option)
  }
  return order.map(modelType => ({
    modelType,
    providerLabel: labelByType.get(modelType)!,
    options: groups.get(modelType)!
  }))
})

const currentModelLabel = computed(() => {
  if (!modelType.value) return '全局默认'
  return assistantModelLabel(modelType.value, modelName.value, { showProvider: true })
})

function selectModel(option: AssistantModelOption) {
  modelType.value = option.model_type
  modelName.value = option.model_name
}

function selectGlobalDefault() {
  modelType.value = null
  modelName.value = null
}

function isOptionActive(option: AssistantModelOption): boolean {
  return isSameAssistantModel(
    { modelType: modelType.value, modelName: modelName.value },
    option
  )
}

const draft = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const MAX_INPUT_LINES = 3
const uploadError = ref('')
const showDocPicker = ref(false)
const libraryDocs = ref<{ id: number; title: string; char_count: number }[]>([])

watch(attachedDocIds, (ids) => {
  if (ids.length === 0) emit('docsCleared')
})

watch(() => props.attachedWorks.length, (count) => {
  if (count === 0) emit('worksCleared')
})

function resizeTextarea() {
  const el = textareaRef.value
  if (!el) return
  el.style.height = '0px'
  const styles = getComputedStyle(el)
  const lineHeight = Number.parseFloat(styles.lineHeight) || 20
  const paddingY = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom)
  const minHeight = lineHeight + paddingY
  const maxHeight = lineHeight * MAX_INPUT_LINES + paddingY
  const nextHeight = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)
  el.style.height = `${nextHeight}px`
  el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
}

watch(draft, () => nextTick(resizeTextarea))
onMounted(() => nextTick(resizeTextarea))

async function loadLibraryDocs() {
  libraryDocs.value = await window.anovel.invoke('assistant:docList') as typeof libraryDocs.value
  showDocPicker.value = true
}

function pickFromLibrary(doc: { id: number; title: string }) {
  if (!attachedDocIds.value.includes(doc.id)) {
    attachedDocIds.value = [...attachedDocIds.value, doc.id]
    emit('docAttached', { id: doc.id, title: doc.title })
  }
  showDocPicker.value = false
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadError.value = ''
  try {
    const doc = await uploadAssistantDocument(file)
    if (!attachedDocIds.value.includes(doc.id)) {
      attachedDocIds.value = [...attachedDocIds.value, doc.id]
      emit('docAttached', doc)
    }
  } catch (e) {
    uploadError.value = e instanceof Error ? e.message : '上传失败'
  } finally {
    input.value = ''
  }
}

async function onLibraryUploadChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadError.value = ''
  try {
    await uploadAssistantDocument(file)
    libraryDocs.value = await window.anovel.invoke('assistant:docList') as typeof libraryDocs.value
  } catch (e) {
    uploadError.value = e instanceof Error ? e.message : '上传失败'
  } finally {
    input.value = ''
  }
}

function removeDoc(id: number) {
  attachedDocIds.value = attachedDocIds.value.filter(x => x !== id)
  emit('docRemoved', id)
}

function removeWork(ref: AssistantWorkReference) {
  emit('workRemoved', workRefKey(ref))
}

function onWorkPicked(ref: AssistantWorkReference) {
  if (attachedWorkKeys.value.includes(workRefKey(ref))) return
  emit('workAttached', ref)
}

function submit() {
  const text = draft.value.trim()
  if (!text) return
  const docIds = [...attachedDocIds.value]
  const workRefs = [...props.attachedWorks]
  draft.value = ''
  emit('send', text, docIds, workRefs)
  attachedDocIds.value = []
  emit('docsCleared')
  emit('worksCleared')
  nextTick(resizeTextarea)
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
}
</script>

<template>
  <div class="border-t border-base-300 px-4 py-3 shrink-0 bg-base-100">
    <p v-if="uploadError" class="text-xs text-error mb-2">{{ uploadError }}</p>

    <div v-if="attachedDocs.length || attachedWorks.length" class="flex flex-wrap gap-2 mb-2">
      <div
        v-for="doc in attachedDocs"
        :key="`doc-${doc.id}`"
        class="inline-flex items-center gap-1.5 rounded-md border border-base-300 bg-base-100 px-2 py-1 text-xs text-base-content/80 max-w-full"
      >
        <span class="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-primary/10 shrink-0">
          <font-awesome-icon icon="paperclip" class="w-2.5 h-2.5 text-primary" />
        </span>
        <span class="truncate max-w-[220px]" :title="doc.title">{{ doc.title }}</span>
        <button
          type="button"
          class="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] leading-none text-error border border-error/20 bg-error/10 hover:bg-error/20 shrink-0"
          title="移除附件"
          @click="removeDoc(doc.id)"
        >
          ×
        </button>
      </div>
      <div
        v-for="work in attachedWorks"
        :key="`work-${workRefKey(work)}`"
        class="inline-flex items-center gap-1.5 rounded-md border border-secondary/30 bg-secondary/5 px-2 py-1 text-xs text-base-content/80 max-w-full"
      >
        <span class="inline-flex items-center justify-center w-4 h-4 rounded-sm bg-secondary/15 shrink-0">
          <font-awesome-icon icon="book-open" class="w-2.5 h-2.5 text-secondary" />
        </span>
        <span class="truncate max-w-[220px]" :title="work.title">{{ work.title }}</span>
        <button
          type="button"
          class="inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] leading-none text-error border border-error/20 bg-error/10 hover:bg-error/20 shrink-0"
          title="移除引用"
          @click="removeWork(work)"
        >
          ×
        </button>
      </div>
    </div>

    <div
      class="rounded-2xl border border-base-300 bg-base-200/40 shadow-sm transition-colors focus-within:border-primary/30 focus-within:ring-1 focus-within:ring-primary/15"
    >
      <textarea
        ref="textareaRef"
        v-model="draft"
        rows="1"
        class="w-full resize-none bg-transparent border-0 outline-none px-4 py-3 text-sm placeholder:text-base-content/35 leading-relaxed overflow-y-auto"
        placeholder="在这里输入消息，按 Enter 发送"
        :disabled="sending"
        @keydown="onKeydown"
        @input="resizeTextarea"
      />

      <div class="flex items-center justify-between gap-2 px-2 pb-2 pt-0.5 mx-1">
        <div class="flex items-center gap-0.5">
          <label
            class="btn btn-ghost btn-xs btn-square text-base-content/50 hover:text-base-content cursor-pointer"
            title="上传 txt / md / docx"
          >
            <font-awesome-icon icon="paperclip" class="w-3.5 h-3.5" />
            <input
              type="file"
              :accept="ASSISTANT_UPLOAD_ACCEPT"
              class="hidden"
              :disabled="sending"
              @change="onFileChange"
            />
          </label>
          <AssistantWorkPicker
            :attached-keys="attachedWorkKeys"
            :disabled="sending"
            @pick="onWorkPicked"
          />
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square text-base-content/50 hover:text-base-content"
            title="从文档库选择"
            :disabled="sending"
            @click="loadLibraryDocs"
          >
            <font-awesome-icon icon="book" class="w-3.5 h-3.5" />
          </button>
        </div>

        <div class="flex items-center gap-2 min-w-0">
          <span
            v-if="attachedDocs.length || attachedWorks.length"
            class="hidden sm:inline text-[11px] text-base-content/40 tabular-nums shrink-0"
          >
            {{ attachedDocs.length + attachedWorks.length }} 个引用
          </span>

          <div class="dropdown dropdown-top dropdown-end shrink min-w-0">
            <label
              tabindex="0"
              class="btn btn-ghost btn-xs h-7 min-h-7 px-2 gap-1 text-base-content/70 hover:text-base-content max-w-[240px]"
              title="切换模型"
            >
              <font-awesome-icon icon="server" class="w-3 h-3 opacity-60 shrink-0" />
              <span class="truncate text-xs">{{ currentModelLabel }}</span>
              <font-awesome-icon icon="chevron-down" class="w-2.5 h-2.5 opacity-40 shrink-0" />
            </label>
            <ul
              tabindex="0"
              class="dropdown-content menu menu-sm bg-base-100 rounded-box z-20 min-w-[280px] w-max max-w-[min(100vw-2rem,380px)] p-1 shadow border border-base-300 mb-1 max-h-72 overflow-y-auto"
            >
              <li>
                <button
                  type="button"
                  class="whitespace-nowrap"
                  :class="{ active: !modelType }"
                  @click="selectGlobalDefault"
                >
                  全局默认
                </button>
              </li>
              <template v-for="group in groupedModelOptions" :key="group.modelType">
                <li class="menu-title px-3 pt-2 pb-0.5 pointer-events-none">
                  <span class="text-[11px] font-semibold tracking-wide text-base-content/45 uppercase">
                    {{ group.providerLabel }}
                  </span>
                </li>
                <li v-for="option in group.options" :key="`${option.model_type}:${option.model_name}`">
                  <button
                    type="button"
                    class="whitespace-nowrap font-mono text-xs"
                    :class="{ active: isOptionActive(option) }"
                    @click="selectModel(option)"
                  >
                    {{ option.model_name }}
                  </button>
                </li>
              </template>
              <li v-if="!modelOptions.length" class="disabled">
                <span class="text-base-content/40 text-xs px-3 py-2 whitespace-normal">请先在设置中启用模型并刷新目录</span>
              </li>
            </ul>
          </div>

          <button
            v-if="sending"
            type="button"
            class="btn btn-square btn-xs btn-ghost text-base-content/60 hover:text-error shrink-0"
            title="停止生成"
            @click="emit('cancel')"
          >
            <font-awesome-icon icon="stop" class="w-3 h-3" />
          </button>
          <button
            v-else
            type="button"
            class="btn btn-square btn-xs shrink-0 transition-colors"
            :class="draft.trim() ? 'btn-primary' : 'btn-ghost text-base-content/30'"
            :disabled="!draft.trim()"
            title="发送"
            @click="submit"
          >
            <font-awesome-icon icon="arrow-up" class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  </div>

  <dialog :class="['modal', { 'modal-open': showDocPicker }]">
    <div class="modal-box max-w-md">
      <div class="flex items-center justify-between mb-3 gap-2">
        <h3 class="font-bold text-lg">从文档库选择</h3>
        <label class="btn btn-primary btn-sm gap-1 cursor-pointer">
          <font-awesome-icon icon="upload" class="w-3 h-3" />
          上传
          <input
            type="file"
            :accept="ASSISTANT_UPLOAD_ACCEPT"
            class="hidden"
            :disabled="sending"
            @change="onLibraryUploadChange"
          />
        </label>
      </div>
      <ul v-if="libraryDocs.length" class="space-y-1 max-h-60 overflow-y-auto">
        <li v-for="doc in libraryDocs" :key="doc.id">
          <button
            type="button"
            class="btn btn-ghost btn-sm w-full justify-start"
            :class="{ 'btn-disabled opacity-60': attachedDocIds.includes(doc.id) }"
            :disabled="attachedDocIds.includes(doc.id)"
            @click="pickFromLibrary(doc)"
          >
            {{ doc.title }}
            <span
              v-if="attachedDocIds.includes(doc.id)"
              class="badge badge-success badge-xs ml-2 shrink-0"
            >
              已添加
            </span>
            <span class="text-base-content/40 ml-auto">{{ doc.char_count }} 字</span>
          </button>
        </li>
      </ul>
      <p v-else class="text-sm text-base-content/40 py-4 text-center">文档库为空</p>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" @click="showDocPicker = false">关闭</button>
      </div>
    </div>
    <form method="dialog" class="modal-backdrop" @click="showDocPicker = false">
      <button type="button">close</button>
    </form>
  </dialog>
</template>
