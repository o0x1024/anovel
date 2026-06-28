<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'

interface KnowledgeNote {
  id: number
  title: string
  content: string
  tags_json: string | null
  pinned: number
  create_time: string
  update_time: string
}

const notes = ref<KnowledgeNote[]>([])
const allTags = ref<string[]>([])
const loading = ref(true)
const saving = ref(false)
const searchKeyword = ref('')
const filterTag = ref('')
const selectedId = ref<number | null>(null)
const editingId = ref<number | null>(null)
const formTitle = ref('')
const formContent = ref('')
const formTags = ref('')
const saveError = ref('')

const selectedNote = computed(() => notes.value.find(n => n.id === selectedId.value) ?? null)
const isEditing = computed(() => editingId.value !== null)
const isCreating = computed(() => editingId.value === 0)

function parseTags(note: KnowledgeNote): string[] {
  if (!note.tags_json) return []
  try { return JSON.parse(note.tags_json) as string[] } catch { return [] }
}

onMounted(refresh)

watch(searchKeyword, () => { loadNotes() })
watch(filterTag, () => { loadNotes() })

async function refresh() {
  loading.value = true
  try {
    await Promise.all([loadNotes(), loadTags()])
  } finally {
    loading.value = false
  }
}

async function loadNotes() {
  if (searchKeyword.value.trim()) {
    notes.value = await window.anovel.invoke('kb:search', searchKeyword.value.trim()) as KnowledgeNote[]
  } else if (filterTag.value) {
    notes.value = await window.anovel.invoke('kb:listByTag', filterTag.value) as KnowledgeNote[]
  } else {
    notes.value = await window.anovel.invoke('kb:list') as KnowledgeNote[]
  }
  if (selectedId.value && !notes.value.some(n => n.id === selectedId.value)) {
    selectedId.value = notes.value[0]?.id ?? null
  }
}

async function loadTags() {
  allTags.value = await window.anovel.invoke('kb:allTags') as string[]
}

function startCreate() {
  saveError.value = ''
  editingId.value = 0
  formTitle.value = ''
  formContent.value = ''
  formTags.value = ''
}

function startEdit(note: KnowledgeNote) {
  saveError.value = ''
  selectedId.value = note.id
  editingId.value = note.id
  formTitle.value = note.title
  formContent.value = note.content
  formTags.value = parseTags(note).join(', ')
}

function cancelEdit() {
  editingId.value = null
  saveError.value = ''
}

function parseTagInput(input: string): string[] {
  return input.split(/[,，]/).map(t => t.trim()).filter(Boolean)
}

async function save() {
  saveError.value = ''
  const content = formContent.value.trim()
  if (!content) { saveError.value = '内容不能为空'; return }

  saving.value = true
  try {
    const tags = parseTagInput(formTags.value)
    if (isCreating.value) {
      const created = await window.anovel.invoke('kb:create', {
        title: formTitle.value.trim(),
        content,
        tags: tags.length ? tags : undefined
      }) as KnowledgeNote
      await refresh()
      selectedId.value = created.id
    } else if (editingId.value) {
      await window.anovel.invoke('kb:update', editingId.value, {
        title: formTitle.value.trim(),
        content,
        tags
      })
      await refresh()
    }
    editingId.value = null
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}

async function deleteNote(id: number) {
  if (!confirm('确定删除此笔记？')) return
  await window.anovel.invoke('kb:delete', id)
  if (selectedId.value === id) selectedId.value = null
  if (editingId.value === id) editingId.value = null
  await refresh()
}

async function togglePin(id: number) {
  await window.anovel.invoke('kb:togglePin', id)
  await loadNotes()
}

function selectNote(id: number) {
  selectedId.value = id
}

function formatDate(dateStr: string) {
  return new Date(dateStr + 'Z').toLocaleString('zh-CN')
}

function clearFilter() {
  searchKeyword.value = ''
  filterTag.value = ''
}
</script>

<template>
  <div class="h-full min-h-0 p-6 lg:p-8 flex flex-col">
    <div class="flex items-center justify-between mb-4">
      <div>
        <h2 class="text-lg font-bold">知识库</h2>
        <p class="text-xs text-base-content/50 mt-1">记录想法、灵感、参考资料，支持标签分类和全文搜索</p>
      </div>
      <button type="button" class="btn btn-primary btn-sm gap-1" @click="startCreate">
        <font-awesome-icon icon="plus" class="w-3 h-3" />
        新建笔记
      </button>
    </div>

    <div class="flex items-center gap-2 mb-4">
      <div class="relative flex-1 max-w-xs">
        <font-awesome-icon icon="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-base-content/40" />
        <input
          v-model="searchKeyword"
          type="text"
          class="input input-bordered input-sm w-full pl-8"
          placeholder="搜索笔记..."
        />
      </div>
      <select v-model="filterTag" class="select select-bordered select-sm">
        <option value="">全部标签</option>
        <option v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</option>
      </select>
      <button
        v-if="searchKeyword || filterTag"
        type="button"
        class="btn btn-ghost btn-xs"
        @click="clearFilter"
      >
        清除筛选
      </button>
    </div>

    <div class="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[340px_1fr] gap-4">
      <section class="border border-base-300 rounded-xl bg-base-200/30 min-h-0 flex flex-col">
        <div class="px-4 py-3 border-b border-base-300 text-xs font-semibold text-base-content/60">
          笔记列表（{{ notes.length }}）
        </div>
        <div v-if="loading" class="flex-1 grid place-items-center">
          <span class="loading loading-spinner loading-md" />
        </div>
        <ul v-else class="flex-1 overflow-auto p-2 space-y-2">
          <li v-if="notes.length === 0" class="text-sm text-base-content/40 text-center py-10">
            暂无笔记，点击右上角"新建笔记"开始
          </li>
          <li v-for="note in notes" :key="note.id">
            <button
              type="button"
              class="w-full text-left rounded-lg border p-3 transition-colors"
              :class="selectedId === note.id ? 'border-primary bg-primary/5' : 'border-base-300 bg-base-100 hover:border-base-content/20'"
              @click="selectNote(note.id)"
            >
              <div class="flex items-center gap-1.5">
                <font-awesome-icon
                  v-if="note.pinned"
                  icon="thumbtack"
                  class="w-3 h-3 text-warning shrink-0"
                />
                <div class="font-semibold text-sm truncate">
                  {{ note.title || note.content.slice(0, 30) }}
                </div>
              </div>
              <p class="text-xs text-base-content/50 mt-1 line-clamp-2">
                {{ note.content.slice(0, 80) }}
              </p>
              <div v-if="parseTags(note).length" class="flex flex-wrap gap-1 mt-2">
                <span
                  v-for="tag in parseTags(note)"
                  :key="tag"
                  class="badge badge-sm badge-outline"
                >{{ tag }}</span>
              </div>
              <div class="text-[11px] text-base-content/35 mt-2">
                {{ formatDate(note.update_time) }}
              </div>
            </button>
          </li>
        </ul>
      </section>

      <section class="border border-base-300 rounded-xl bg-base-100 min-h-0 flex flex-col">
        <div class="px-4 py-3 border-b border-base-300 flex items-center justify-between gap-2">
          <h3 class="font-semibold text-sm">
            {{ isCreating ? '新建笔记' : isEditing ? '编辑笔记' : '笔记详情' }}
          </h3>
          <div class="flex items-center gap-2">
            <template v-if="!isEditing && selectedNote">
              <button
                type="button"
                class="btn btn-ghost btn-xs"
                :title="selectedNote.pinned ? '取消置顶' : '置顶'"
                @click="togglePin(selectedNote.id)"
              >
                <font-awesome-icon icon="thumbtack" class="w-3 h-3" :class="selectedNote.pinned ? 'text-warning' : ''" />
              </button>
              <button type="button" class="btn btn-ghost btn-xs" @click="startEdit(selectedNote)">编辑</button>
              <button type="button" class="btn btn-ghost btn-xs text-error" @click="deleteNote(selectedNote.id)">删除</button>
            </template>
            <template v-if="isEditing">
              <button type="button" class="btn btn-ghost btn-xs" :disabled="saving" @click="cancelEdit">取消</button>
              <button type="button" class="btn btn-primary btn-xs" :disabled="saving" @click="save">
                {{ saving ? '保存中...' : '保存' }}
              </button>
            </template>
          </div>
        </div>

        <div v-if="isEditing" class="flex-1 min-h-0 overflow-auto p-4 space-y-3">
          <p v-if="saveError" class="text-xs text-error">{{ saveError }}</p>
          <label class="form-control">
            <div class="label"><span class="label-text text-xs">标题（可选）</span></div>
            <input v-model="formTitle" type="text" class="input input-bordered input-sm" placeholder="给笔记起个名字" />
          </label>
          <label class="form-control">
            <div class="label"><span class="label-text text-xs">标签（逗号分隔）</span></div>
            <input v-model="formTags" type="text" class="input input-bordered input-sm" placeholder="如：世界观, 人物, 灵感" />
          </label>
          <label class="form-control flex-1">
            <div class="label"><span class="label-text text-xs">内容</span></div>
            <textarea
              v-model="formContent"
              class="textarea textarea-bordered flex-1 min-h-[280px] font-mono text-xs leading-5"
              placeholder="写下你的想法..."
            />
          </label>
        </div>

        <div v-else-if="selectedNote" class="flex-1 min-h-0 overflow-auto p-4">
          <h4 class="font-semibold">{{ selectedNote.title || '无标题' }}</h4>
          <p class="text-xs text-base-content/40 mt-1">
            创建于 {{ formatDate(selectedNote.create_time) }}
            · 更新于 {{ formatDate(selectedNote.update_time) }}
          </p>
          <div v-if="parseTags(selectedNote).length" class="flex flex-wrap gap-1.5 mt-2">
            <span
              v-for="tag in parseTags(selectedNote)"
              :key="tag"
              class="badge badge-sm badge-primary badge-outline cursor-pointer"
              @click="filterTag = tag"
            >{{ tag }}</span>
          </div>
          <pre class="mt-4 text-sm bg-base-200 rounded-lg p-4 whitespace-pre-wrap break-words">{{ selectedNote.content }}</pre>
        </div>

        <div v-else class="flex-1 grid place-items-center text-sm text-base-content/40">
          <div class="text-center">
            <font-awesome-icon icon="lightbulb" class="text-4xl mb-3 opacity-20" />
            <p>选择左侧笔记查看，或新建一条</p>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
