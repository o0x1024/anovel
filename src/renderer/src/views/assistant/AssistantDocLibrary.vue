<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { uploadAssistantDocument, ASSISTANT_UPLOAD_ACCEPT } from '../../utils/assistantUpload'
import type { AssistantDocumentRow } from '../../../../shared/assistant-types'

const props = withDefaults(defineProps<{
  allowAttach?: boolean
}>(), {
  allowAttach: false
})

const emit = defineEmits<{
  attach: [doc: { id: number; title: string }]
}>()

const docs = ref<AssistantDocumentRow[]>([])
const loading = ref(true)
const saving = ref(false)
const uploadError = ref('')
const saveError = ref('')
const selectedId = ref<number | null>(null)
const editingId = ref<number | null>(null)
const formTitle = ref('')
const formContent = ref('')
const formFileName = ref('')

const selectedDoc = computed(() => docs.value.find(doc => doc.id === selectedId.value) ?? null)
const isEditing = computed(() => editingId.value !== null)
const isCreating = computed(() => editingId.value === 0)

onMounted(refresh)

async function refresh() {
  loading.value = true
  try {
    docs.value = await window.anovel.invoke('assistant:docList') as AssistantDocumentRow[]
    if (docs.value.length === 0) {
      selectedId.value = null
      if (!isEditing.value) startCreate()
      return
    }
    if (!selectedId.value || !docs.value.some(doc => doc.id === selectedId.value)) {
      selectedId.value = docs.value[0].id
    }
  } finally {
    loading.value = false
  }
}

function fillFormFromDoc(doc: AssistantDocumentRow) {
  formTitle.value = doc.title
  formContent.value = doc.content_text
  formFileName.value = doc.file_name ?? ''
}

function startCreate() {
  saveError.value = ''
  editingId.value = 0
  formTitle.value = ''
  formContent.value = ''
  formFileName.value = ''
}

function startEdit(doc: AssistantDocumentRow) {
  saveError.value = ''
  selectedId.value = doc.id
  editingId.value = doc.id
  fillFormFromDoc(doc)
}

function cancelEdit() {
  editingId.value = null
  saveError.value = ''
}

async function saveDoc() {
  saveError.value = ''
  const title = formTitle.value.trim()
  const content = formContent.value.trim()
  if (!content) {
    saveError.value = '文档内容不能为空'
    return
  }
  saving.value = true
  try {
    if (isCreating.value) {
      const created = await window.anovel.invoke('assistant:docUpload', {
        title: title || '未命名文档',
        fileName: formFileName.value.trim() || undefined,
        content
      }) as AssistantDocumentRow
      await refresh()
      selectedId.value = created.id
    } else if (editingId.value !== null) {
      const updated = await window.anovel.invoke('assistant:docUpdate', editingId.value, {
        title: title || '未命名文档',
        fileName: formFileName.value.trim() || undefined,
        content
      }) as AssistantDocumentRow | undefined
      await refresh()
      if (updated) selectedId.value = updated.id
    }
    editingId.value = null
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadError.value = ''
  try {
    const created = await uploadAssistantDocument(file)
    await refresh()
    selectedId.value = created.id
  } catch (e) {
    uploadError.value = e instanceof Error ? e.message : '上传失败'
  } finally {
    input.value = ''
  }
}

async function removeDoc(id: number) {
  if (!confirm('删除此文档？')) return
  await window.anovel.invoke('assistant:docDelete', id)
  if (editingId.value === id) editingId.value = null
  if (selectedId.value === id) selectedId.value = null
  await refresh()
}

function selectDoc(id: number) {
  selectedId.value = id
}

function formatDate(dateStr: string) {
  return new Date(dateStr + 'Z').toLocaleString('zh-CN')
}

function attachDoc(doc: AssistantDocumentRow) {
  emit('attach', { id: doc.id, title: doc.title })
}
</script>

<template>
  <div class="h-full min-h-0 p-6 lg:p-8 flex flex-col">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h2 class="text-lg font-bold">文档库</h2>
        <p class="text-xs text-base-content/50 mt-1">支持新增、查看、编辑、删除；也可上传 txt / md / docx</p>
      </div>
      <div class="flex items-center gap-2">
        <button type="button" class="btn btn-ghost btn-sm" @click="startCreate">
          <font-awesome-icon icon="plus" class="w-3 h-3" />
          新建
        </button>
        <label class="btn btn-primary btn-sm gap-1 cursor-pointer">
          <font-awesome-icon icon="upload" class="w-3 h-3" />
          上传
          <input type="file" :accept="ASSISTANT_UPLOAD_ACCEPT" class="hidden" @change="onFileChange" />
        </label>
      </div>
    </div>

    <p v-if="uploadError" class="text-xs text-error mb-3">{{ uploadError }}</p>

    <div class="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[340px_1fr] gap-4">
      <section class="border border-base-300 rounded-xl bg-base-200/30 min-h-0 flex flex-col">
        <div class="px-4 py-3 border-b border-base-300 text-xs font-semibold text-base-content/60">
          文档列表（{{ docs.length }}）
        </div>
        <div v-if="loading" class="flex-1 grid place-items-center">
          <span class="loading loading-spinner loading-md" />
        </div>
        <ul v-else class="flex-1 overflow-auto p-2 space-y-2">
          <li v-if="docs.length === 0" class="text-sm text-base-content/40 text-center py-10">
            暂无文档，点击右上角“新建”或“上传”
          </li>
          <li v-for="doc in docs" :key="doc.id">
            <button
              type="button"
              class="w-full text-left rounded-lg border p-3 transition-colors"
              :class="selectedId === doc.id ? 'border-primary bg-primary/5' : 'border-base-300 bg-base-100 hover:border-base-content/20'"
              @click="selectDoc(doc.id)"
            >
              <div class="font-semibold text-sm truncate">{{ doc.title }}</div>
              <div class="text-xs text-base-content/45 mt-1">{{ doc.char_count.toLocaleString() }} 字</div>
              <div class="text-[11px] text-base-content/35 mt-1 truncate">{{ formatDate(doc.create_time) }}</div>
              <div class="flex items-center gap-1 mt-2">
                <button
                  type="button"
                  class="btn btn-ghost btn-xs"
                  @click.stop="startEdit(doc)"
                >
                  编辑
                </button>
                <button
                  type="button"
                  class="btn btn-ghost btn-xs text-error"
                  @click.stop="removeDoc(doc.id)"
                >
                  删除
                </button>
                <button
                  v-if="props.allowAttach"
                  type="button"
                  class="btn btn-primary btn-xs ml-auto"
                  @click.stop="attachDoc(doc)"
                >
                  附加
                </button>
              </div>
            </button>
          </li>
        </ul>
      </section>

      <section class="border border-base-300 rounded-xl bg-base-100 min-h-0 flex flex-col">
        <div class="px-4 py-3 border-b border-base-300 flex items-center justify-between gap-2">
          <h3 class="font-semibold text-sm">
            {{ isCreating ? '新建文档' : isEditing ? '编辑文档' : '文档详情' }}
          </h3>
          <div class="flex items-center gap-2">
            <button
              v-if="!isEditing && selectedDoc"
              type="button"
              class="btn btn-ghost btn-xs"
              @click="startEdit(selectedDoc)"
            >
              编辑
            </button>
            <template v-if="isEditing">
              <button type="button" class="btn btn-ghost btn-xs" :disabled="saving" @click="cancelEdit">取消</button>
              <button type="button" class="btn btn-primary btn-xs" :disabled="saving" @click="saveDoc">
                {{ saving ? '保存中...' : '保存' }}
              </button>
            </template>
          </div>
        </div>

        <div v-if="isEditing" class="flex-1 min-h-0 overflow-auto p-4 space-y-3">
          <p v-if="saveError" class="text-xs text-error">{{ saveError }}</p>
          <label class="form-control">
            <div class="label"><span class="label-text text-xs">标题</span></div>
            <input v-model="formTitle" type="text" class="input input-bordered input-sm" placeholder="请输入标题" />
          </label>
          <label class="form-control">
            <div class="label"><span class="label-text text-xs">原文件名（可选）</span></div>
            <input v-model="formFileName" type="text" class="input input-bordered input-sm" placeholder="如：参考资料.md" />
          </label>
          <label class="form-control">
            <div class="label"><span class="label-text text-xs">正文</span></div>
            <textarea
              v-model="formContent"
              class="textarea textarea-bordered h-[360px] font-mono text-xs leading-5"
              placeholder="请输入文档正文"
            />
          </label>
        </div>

        <div v-else-if="selectedDoc" class="flex-1 min-h-0 overflow-auto p-4">
          <h4 class="font-semibold">{{ selectedDoc.title }}</h4>
          <p class="text-xs text-base-content/40 mt-1">
            {{ selectedDoc.char_count.toLocaleString() }} 字 · {{ formatDate(selectedDoc.create_time) }}
          </p>
          <p v-if="selectedDoc.file_name" class="text-xs text-base-content/45 mt-1">
            文件名：{{ selectedDoc.file_name }}
          </p>
          <pre class="mt-3 text-xs bg-base-200 rounded-lg p-3 whitespace-pre-wrap">{{ selectedDoc.content_text }}</pre>
        </div>

        <div v-else class="flex-1 grid place-items-center text-sm text-base-content/40">
          请选择左侧文档查看
        </div>
      </section>
    </div>
  </div>
</template>
