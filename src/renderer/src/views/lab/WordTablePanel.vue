<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import type { WordTableEntryRow } from '../../../../shared/aigc-wordtable-types'
import ListBatchToolbar from '../../components/ListBatchToolbar.vue'
import { useListSelection, confirmBatchDelete, confirmDeleteAll } from '../../composables/useListSelection'

interface PresetInfo {
  id: string
  name: string
  description: string
  count: number
}

const entries = ref<WordTableEntryRow[]>([])
const loading = ref(false)
const showAddForm = ref(false)

const newType = ref<'word' | 'pattern'>('word')
const newSource = ref('')
const newTarget = ref('')

const editingId = ref<number | null>(null)
const editSource = ref('')
const editTarget = ref('')
const editType = ref<'word' | 'pattern'>('word')

const previewText = ref('')
const previewResult = ref('')
const showPreview = ref(false)

const showPresetPicker = ref(false)
const presetList = ref<PresetInfo[]>([])
const importingPreset = ref<string | null>(null)
const importMessage = ref('')

const enabledCount = computed(() => entries.value.filter(e => e.enabled).length)

async function loadEntries() {
  loading.value = true
  try {
    entries.value = await window.anovel.invoke('lab:wordtable:list') as WordTableEntryRow[]
  } finally {
    loading.value = false
  }
}

async function addEntry() {
  if (!newSource.value.trim()) return
  await window.anovel.invoke('lab:wordtable:create', {
    type: newType.value,
    source: newSource.value.trim(),
    target: newTarget.value.trim()
  })
  newSource.value = ''
  newTarget.value = ''
  showAddForm.value = false
  await loadEntries()
}

function startEdit(entry: WordTableEntryRow) {
  editingId.value = entry.id
  editSource.value = entry.source
  editTarget.value = entry.target
  editType.value = entry.type as 'word' | 'pattern'
}

async function saveEdit() {
  if (editingId.value === null) return
  await window.anovel.invoke('lab:wordtable:update', editingId.value, {
    type: editType.value,
    source: editSource.value.trim(),
    target: editTarget.value.trim()
  })
  editingId.value = null
  await loadEntries()
}

function cancelEdit() {
  editingId.value = null
}

async function toggleEntry(id: number, enabled: boolean) {
  await window.anovel.invoke('lab:wordtable:toggle', id, enabled)
  const entry = entries.value.find(e => e.id === id)
  if (entry) entry.enabled = enabled ? 1 : 0
}

async function deleteEntry(id: number) {
  if (!confirm('删除该条目？')) return
  await window.anovel.invoke('lab:wordtable:delete', id)
  await loadEntries()
}

async function applyPreview() {
  if (!previewText.value.trim()) return
  previewResult.value = await window.anovel.invoke('lab:wordtable:apply', previewText.value) as string
}

async function openPresetPicker() {
  importMessage.value = ''
  presetList.value = await window.anovel.invoke('lab:wordtable:listPresets') as PresetInfo[]
  showPresetPicker.value = true
}

async function importPreset(presetId: string) {
  importingPreset.value = presetId
  importMessage.value = ''
  try {
    const result = await window.anovel.invoke('lab:wordtable:importPreset', presetId) as { imported: number; skipped: number }
    if (result.imported > 0) {
      importMessage.value = `成功导入 ${result.imported} 条` + (result.skipped > 0 ? `，跳过 ${result.skipped} 条重复` : '')
      await loadEntries()
    } else {
      importMessage.value = `所有 ${result.skipped} 条均已存在，无需重复导入`
    }
  } finally {
    importingPreset.value = null
  }
}

const selection = useListSelection(() => entries.value)

async function batchDeleteSelected() {
  const items = selection.getSelectedItems() as WordTableEntryRow[]
  if (!await confirmBatchDelete(items.length, '词表条目')) return
  const ids = items.map(e => e.id)
  await window.anovel.invoke('lab:wordtable:batchDelete', ids)
  selection.clearSelection()
  await loadEntries()
}

async function batchDeleteAll() {
  if (!await confirmDeleteAll(entries.value.length, '词表条目')) return
  await window.anovel.invoke('lab:wordtable:deleteAll')
  selection.clearSelection()
  await loadEntries()
}

onMounted(loadEntries)
</script>

<template>
  <div class="flex flex-col gap-3 h-full min-h-0 overflow-hidden">
    <!-- 工具栏 -->
    <div class="flex items-center gap-2 shrink-0 flex-wrap">
      <button class="btn btn-primary btn-xs" @click="showAddForm = !showAddForm">
        <font-awesome-icon icon="plus" class="w-3 h-3" />
        添加条目
      </button>
      <button class="btn btn-ghost btn-xs" @click="openPresetPicker">
        <font-awesome-icon icon="wand-magic-sparkles" class="w-3 h-3" />
        导入预设
      </button>
      <button class="btn btn-ghost btn-xs" @click="showPreview = !showPreview">
        <font-awesome-icon icon="eye" class="w-3 h-3" />
        手动替换
      </button>
      <span class="text-xs text-base-content/50 ml-auto">
        {{ enabledCount }}/{{ entries.length }} 条启用
      </span>
    </div>
    <p class="text-xs text-base-content/50">
      词表条目在“一键改写”后自动应用；也可通过“手动替换”单独使用。导入预设可快速添加。
    </p>

    <!-- 添加表单 -->
    <div v-if="showAddForm" class="bg-base-200 rounded-lg p-3 shrink-0 space-y-2">
      <div class="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 items-center">
        <select
          v-model="newType"
          class="select select-xs select-bordered w-full max-w-[5.5rem] shrink-0"
        >
          <option value="word">词/短语</option>
          <option value="pattern">句式模板</option>
        </select>
        <input
          v-model="newSource"
          class="input input-xs input-bordered min-w-0 w-full"
          :placeholder="newType === 'word' ? '输入要匹配的词（如：微微）' : '输入句式模板，用...分隔（如：不是...而是）'"
        />
      </div>
      <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-2">
        <div class="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 items-center flex-1 min-w-0">
          <span class="text-xs text-base-content/60 text-right whitespace-nowrap">替换为 →</span>
          <input
            v-model="newTarget"
            class="input input-xs input-bordered min-w-0 w-full"
            placeholder="替换目标，多个用 | 分隔。句式可用 {1}/{2} 引用匹配片段"
          />
        </div>
        <div class="flex items-center gap-2 shrink-0 sm:pl-0 pl-[5.5rem]">
          <button class="btn btn-primary btn-xs" :disabled="!newSource.trim()" @click="addEntry">
            确认
          </button>
          <button class="btn btn-ghost btn-xs" @click="showAddForm = false">取消</button>
        </div>
      </div>
      <p v-if="newType === 'pattern'" class="text-xs text-base-content/50 pl-[5.5rem]">
        句式模板用 <code class="badge badge-xs">...</code> 表示中间可变内容；
        target 可用 <code class="badge badge-xs">{1}</code>/<code class="badge badge-xs">{2}</code> 回填，如
        "不是...而是..." + "与其说{1}，不如说{2}"。
      </p>
    </div>

    <!-- 手动替换面板 -->
    <div v-if="showPreview" class="bg-base-200 rounded-lg p-3 shrink-0 space-y-2">
      <textarea
        v-model="previewText"
        class="textarea textarea-bordered textarea-xs w-full h-20"
        placeholder="粘贴文本，点击执行替换（手动触发）…"
      ></textarea>
      <div class="flex items-center gap-2">
        <button class="btn btn-xs btn-primary" :disabled="!previewText.trim()" @click="applyPreview">
          执行替换
        </button>
        <button class="btn btn-xs btn-ghost" @click="showPreview = false">关闭</button>
      </div>
      <div v-if="previewResult" class="bg-base-100 rounded p-2 text-xs whitespace-pre-wrap max-h-32 overflow-y-auto">
        {{ previewResult }}
      </div>
    </div>

    <!-- 预设选择面板 -->
    <div v-if="showPresetPicker" class="bg-base-200 rounded-lg p-3 shrink-0 space-y-2">
      <div class="flex items-center justify-between mb-1">
        <span class="text-xs font-semibold">选择预设（从真实小说提取的替换词）</span>
        <button class="btn btn-xs btn-ghost" @click="showPresetPicker = false">关闭</button>
      </div>
      <div v-for="preset in presetList" :key="preset.id" class="bg-base-100 rounded-lg p-2 flex items-start gap-2">
        <div class="flex-1 min-w-0">
          <div class="text-xs font-medium">{{ preset.name }}</div>
          <div class="text-[11px] text-base-content/50 mt-0.5">{{ preset.description }}</div>
          <div class="text-[10px] text-base-content/40 mt-0.5">{{ preset.count }} 条替换规则</div>
        </div>
        <button
          class="btn btn-xs btn-primary shrink-0"
          :class="{ loading: importingPreset === preset.id }"
          :disabled="importingPreset !== null"
          @click="importPreset(preset.id)"
        >
          导入
        </button>
      </div>
      <div v-if="importMessage" class="text-xs text-success text-center">{{ importMessage }}</div>
    </div>

    <!-- 词表列表 -->
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div v-if="loading" class="text-xs text-base-content/50 text-center py-4">加载中…</div>
      <div v-else-if="entries.length === 0" class="text-xs text-base-content/50 text-center py-8">
        <p>暂无词表条目</p>
        <p class="mt-1">点击"导入预设"快速添加常见 AI 高频词和句式</p>
      </div>
      <template v-else>
        <ListBatchToolbar
          :total="entries.length"
          :selectable-count="selection.selectableCount"
          :selected-count="selection.selectedCount"
          :all-selected="selection.allSelected"
          item-label="条目"
          @toggle-all="selection.toggleAll()"
          @delete-selected="batchDeleteSelected"
          @delete-all="batchDeleteAll"
        />
        <table class="table table-xs w-full">
          <thead class="sticky top-0 bg-base-100 z-10">
            <tr>
              <th class="w-8">选</th>
              <th class="w-8">启用</th>
              <th class="w-16">类型</th>
              <th>匹配</th>
              <th>替换为</th>
              <th class="w-20">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(entry, idx) in entries"
              :key="entry.id"
              :class="{ 'opacity-40': !entry.enabled, 'bg-primary/5': selection.isSelected(entry, idx) }"
            >
              <td>
                <input
                  type="checkbox"
                  class="checkbox checkbox-xs"
                  :checked="selection.isSelected(entry, idx)"
                  @change="selection.toggle(entry, idx)"
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  class="checkbox checkbox-xs"
                  :checked="!!entry.enabled"
                  @change="toggleEntry(entry.id, !entry.enabled)"
                />
              </td>
              <td>
                <span class="badge badge-xs" :class="entry.type === 'pattern' ? 'badge-accent' : 'badge-info'">
                  {{ entry.type === 'word' ? '词' : '句式' }}
                </span>
              </td>
              <template v-if="editingId === entry.id">
                <td>
                  <input v-model="editSource" class="input input-xs input-bordered w-full" />
                </td>
                <td>
                  <input v-model="editTarget" class="input input-xs input-bordered w-full" placeholder="留空=删除" />
                </td>
                <td class="flex gap-1">
                  <button class="btn btn-xs btn-success" @click="saveEdit">保存</button>
                  <button class="btn btn-xs btn-ghost" @click="cancelEdit">取消</button>
                </td>
              </template>
              <template v-else>
                <td class="font-mono text-xs">{{ entry.source }}</td>
                <td class="text-xs">
                  <span v-if="entry.target" class="text-success">{{ entry.target }}</span>
                  <span v-else class="text-error/50 italic">删除</span>
                </td>
                <td class="flex gap-1">
                  <button class="btn btn-xs btn-ghost" @click="startEdit(entry)">
                    <font-awesome-icon icon="pen" class="w-3 h-3" />
                  </button>
                  <button class="btn btn-xs btn-ghost text-error" @click="deleteEntry(entry.id)">
                    <font-awesome-icon icon="trash" class="w-3 h-3" />
                  </button>
                </td>
              </template>
            </tr>
          </tbody>
        </table>
      </template>
    </div>
  </div>
</template>
