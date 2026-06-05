<script setup lang="ts">
import { ref, onMounted, watch, inject } from 'vue'
import { useModelChat } from './useModelChat'
import PanelTitle from '../../components/PanelTitle.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import FavoriteButton from '../../components/FavoriteButton.vue'
import AiInterventionBar from './AiInterventionBar.vue'
import AiSelfCheckPanel from './AiSelfCheckPanel.vue'
import StepNavFooter from './StepNavFooter.vue'
import { editorNavKey } from './editor-nav'

const props = defineProps<{ workId: number }>()
const nav = inject(editorNavKey)

interface ParsedVolume {
  name: string
  description: string
}

const volumes = ref<{ id: number; name: string; description: string | null; sort: number }[]>([])
const newVolumeName = ref('')
const addingVolume = ref(false)
const editingVolumeId = ref<number | null>(null)
const editVolumeName = ref('')
const editVolumeDesc = ref('')
const parsedVolumes = ref<ParsedVolume[]>([])
const applyingVolumes = ref(false)
const aiSuggestionExpanded = ref(true)
const expandedVolumeIds = ref<Set<number>>(new Set())
const { loading, result, error, chat, clearResult } = useModelChat(() => props.workId)
const lastContext = ref('')

const volumeSystemPrompt = [
  '根据作品创作上下文，生成 3-5 卷分卷大纲。',
  '只输出一个 JSON 对象，禁止 Markdown 正文、标题、解释或代码块外的任何文字。',
  'volumes 数组每项为一卷；不要把「分卷大纲」「卷末钩子」「核心冲突」等标签当作 name。',
  '每卷 description 80-300 字（主题 + 主冲突 + 卷末钩子），禁止写具体章节情节或市场分析。',
  'name 须像真实分卷名（如「卷一：《标题》」），不要写作品名或文档标题。',
  '示例：{"volumes":[{"name":"卷一：《雨夜书店的猫》","description":"主题…；主冲突…；卷末钩子…"}]}'
].join('\n')

const parseError = ref('')

onMounted(loadVolumes)

watch(result, async (content) => {
  if (!content) {
    parsedVolumes.value = []
    parseError.value = ''
    return
  }
  const list = await window.anovel.invoke('volume:parseSuggestions', content) as ParsedVolume[]
  parsedVolumes.value = list
  parseError.value = list.length === 0
    ? '未能从 AI 回复解析出分卷 JSON，请重新生成（需为 {"volumes":[...]} 格式）'
    : ''
})

function isInvalidVolumeName(name: string): boolean {
  const n = name.trim().replace(/^\*+|\*+$/g, '')
  return /^(?:卷末钩子|结尾钩子|核心冲突|核心主题|分卷大纲|分卷说明)/.test(n)
}

async function loadVolumes() {
  volumes.value = await window.anovel.invoke('volume:list', props.workId) as never[]
}

async function addVolume() {
  if (!newVolumeName.value.trim()) return
  addingVolume.value = true
  await window.anovel.invoke('volume:create', props.workId, newVolumeName.value.trim())
  newVolumeName.value = ''
  await loadVolumes()
  addingVolume.value = false
}

async function deleteVolume(id: number, name: string) {
  if (!confirm(`删除分卷「${name}」？`)) return
  await window.anovel.invoke('volume:delete', id)
  await loadVolumes()
}

function startEditVolume(vol: { id: number; name: string; description: string | null }) {
  editingVolumeId.value = vol.id
  editVolumeName.value = vol.name
  editVolumeDesc.value = vol.description || ''
  expandedVolumeIds.value = new Set([...expandedVolumeIds.value, vol.id])
}

function isVolumeExpanded(id: number): boolean {
  return expandedVolumeIds.value.has(id)
}

function toggleVolumeExpanded(id: number) {
  const next = new Set(expandedVolumeIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedVolumeIds.value = next
}

async function saveVolumeEdit() {
  if (!editingVolumeId.value || !editVolumeName.value.trim()) return
  await window.anovel.invoke('volume:update', editingVolumeId.value, {
    name: editVolumeName.value.trim(),
    description: editVolumeDesc.value.trim() || null
  })
  editingVolumeId.value = null
  await loadVolumes()
}

async function aiGenerateVolumes() {
  clearResult()
  parseError.value = ''
  const ctx = await window.anovel.invoke('context:buildWork', props.workId) as { text: string }
  lastContext.value = ctx.text
  await chat('请生成分卷大纲建议。', volumeSystemPrompt, 'volumes_outline', {
    workContextOptions: {
      includeVolumes: false,
      includeIncubator: false
    }
  })
}

async function applyParsedVolumes(mode: 'append' | 'replace') {
  if (parsedVolumes.value.length === 0 || applyingVolumes.value) return
  if (mode === 'replace' && volumes.value.length > 0) {
    if (!confirm(`将替换现有 ${volumes.value.length} 个分卷及其下属章节，确定继续？`)) return
  }
  applyingVolumes.value = true
  try {
    const items = parsedVolumes.value.map(v => ({
      name: v.name,
      description: v.description ?? ''
    }))
    await window.anovel.invoke('volume:batchUpsert', props.workId, items, mode)
    await loadVolumes()
    await nav?.refreshProgress()
    aiSuggestionExpanded.value = false
  } finally {
    applyingVolumes.value = false
  }
}

defineExpose({ loadVolumes })

function updateAiResult(content: string) {
  result.value = content
}

function aiSuggestionSummary(): string {
  if (parsedVolumes.value.length > 0) {
    return `已解析 ${parsedVolumes.value.length} 卷 · 点击展开查看详情`
  }
  const line = result.value?.split('\n').find(l => l.trim())?.trim() ?? ''
  return line.replace(/^#+\s*/, '').slice(0, 48) || 'AI 分卷建议'
}
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="book" title="分卷大纲" />
    <p class="text-sm text-base-content/50 mb-6">规划作品分卷结构，或使用 AI 根据核心设定生成分卷建议并一键应用。</p>

    <div class="flex flex-wrap gap-2 mb-4">
      <input
        v-model="newVolumeName"
        placeholder="分卷名称"
        class="input input-bordered flex-1 min-w-[200px]"
        @keyup.enter="addVolume"
      />
      <button class="btn btn-primary" :disabled="!newVolumeName.trim() || addingVolume" @click="addVolume">
        <font-awesome-icon v-if="addingVolume" icon="spinner" spin class="w-3.5 h-3.5 mr-1" />
        <font-awesome-icon v-else icon="plus" class="w-3.5 h-3.5 mr-1" />
        {{ addingVolume ? '添加中...' : '添加' }}
      </button>
      <button class="btn btn-outline btn-primary" :disabled="loading" @click="aiGenerateVolumes">
        <font-awesome-icon :icon="loading ? 'spinner' : 'robot'" :spin="loading" class="w-3.5 h-3.5 mr-1" />
        {{ loading ? '生成中...' : 'AI 生成分卷大纲' }}
      </button>
    </div>

    <div v-if="error" class="alert alert-error text-sm mb-4">{{ error }}</div>
    <div v-if="result" class="card bg-base-200 border border-base-300 shadow-sm mb-4">
      <div class="p-4 pb-2">
        <div class="flex items-center justify-between gap-2 flex-wrap">
          <button
            type="button"
            class="flex items-center gap-2 min-w-0 text-left hover:opacity-80 transition-opacity"
            @click="aiSuggestionExpanded = !aiSuggestionExpanded"
          >
            <h4 class="font-semibold text-sm shrink-0">AI 分卷建议</h4>
            <span v-if="!aiSuggestionExpanded" class="text-xs text-base-content/50 truncate">
              {{ aiSuggestionSummary() }}
            </span>
            <font-awesome-icon
              :icon="aiSuggestionExpanded ? 'chevron-up' : 'chevron-down'"
              class="w-3 h-3 shrink-0 text-base-content/40"
            />
          </button>
          <div class="flex items-center gap-2 flex-wrap shrink-0">
            <template v-if="parsedVolumes.length">
              <span v-if="aiSuggestionExpanded" class="text-xs text-base-content/50">
                已解析 {{ parsedVolumes.length }} 卷
              </span>
              <button
                class="btn btn-primary btn-xs"
                :disabled="applyingVolumes"
                @click.stop="applyParsedVolumes('append')"
              >
                {{ applyingVolumes ? '应用中...' : '追加到分卷列表' }}
              </button>
              <button
                class="btn btn-outline btn-xs"
                :disabled="applyingVolumes"
                @click.stop="applyParsedVolumes('replace')"
              >
                替换现有分卷
              </button>
            </template>
            <span v-else-if="parseError" class="text-xs text-warning">{{ parseError }}</span>
            <span v-else class="text-xs text-warning">未能解析结构化分卷</span>
            <FavoriteButton
              :work-id="workId"
              source-step="volumes_outline"
              source-label="分卷大纲"
              :content="result"
              :source-input="lastContext"
              size="xs"
            />
          </div>
        </div>
      </div>
      <div v-show="aiSuggestionExpanded" class="px-4 pb-4 pt-0 space-y-3 border-t border-base-300/50">
        <div v-if="parseError" class="alert alert-warning text-xs py-2">{{ parseError }}</div>
        <div v-if="parsedVolumes.length" class="space-y-2">
          <p class="text-xs font-medium text-base-content/50">解析预览（将写入分卷列表）</p>
          <div
            v-for="(pv, idx) in parsedVolumes"
            :key="idx"
            class="text-xs bg-base-100 rounded-lg px-3 py-2 border border-base-300/60"
          >
            <div class="font-medium">{{ pv.name }}</div>
            <p class="text-base-content/60 mt-1 whitespace-pre-wrap line-clamp-4">{{ pv.description }}</p>
          </div>
        </div>
        <details v-if="!parsedVolumes.length && result">
          <summary class="text-xs cursor-pointer text-base-content/50 mb-2">查看原始 AI 输出</summary>
          <MarkdownContent :content="result" />
        </details>
        <details v-if="parsedVolumes.length && result" class="text-xs">
          <summary class="cursor-pointer text-base-content/50 mb-2">查看原始 JSON</summary>
          <pre class="whitespace-pre-wrap break-words text-[11px] opacity-70">{{ result }}</pre>
        </details>
        <AiInterventionBar
          :work-id="workId"
          step="volumes_outline"
          :content="result"
          regenerate-prompt="请生成分卷大纲建议。"
          :regenerate-system-prompt="volumeSystemPrompt"
          @update:content="updateAiResult"
        />
        <AiSelfCheckPanel :work-id="workId" step="volumes" :content="result" />
      </div>
    </div>

    <div class="card bg-base-200 border border-base-300 shadow-sm">
      <div class="px-4 py-3 border-b border-base-300/50">
        <h4 class="font-semibold text-sm">分卷列表</h4>
        <p v-if="volumes.length" class="text-xs text-base-content/50 mt-0.5">共 {{ volumes.length }} 卷</p>
      </div>
      <div class="px-4 pb-4 pt-3">
        <div v-if="volumes.length === 0" class="text-center py-12 text-base-content/40">
          <font-awesome-icon icon="book" class="text-4xl mb-3 opacity-30" />
          <p>还没有分卷</p>
        </div>
        <div v-else class="space-y-3">
          <div
            v-for="vol in volumes"
            :key="vol.id"
            class="card bg-base-100 border shadow-sm overflow-hidden"
            :class="isInvalidVolumeName(vol.name) ? 'border-warning/50' : 'border-base-300'"
          >
            <div v-if="editingVolumeId === vol.id" class="p-4 space-y-2">
              <input v-model="editVolumeName" class="input input-bordered input-sm w-full" placeholder="分卷名称" />
              <textarea
                v-model="editVolumeDesc"
                rows="3"
                class="textarea textarea-bordered w-full textarea-sm resize-none"
                placeholder="分卷说明（主题、冲突、钩子...）"
              />
              <div class="flex gap-2">
                <button class="btn btn-primary btn-xs" @click="saveVolumeEdit">保存</button>
                <button class="btn btn-ghost btn-xs" @click="editingVolumeId = null">取消</button>
              </div>
            </div>
            <template v-else>
              <div class="flex items-center justify-between gap-2 px-4 py-3">
                <button
                  type="button"
                  class="flex items-center gap-2 min-w-0 flex-1 text-left hover:opacity-80 transition-opacity"
                  @click="toggleVolumeExpanded(vol.id)"
                >
                  <h4 class="font-semibold text-sm truncate flex items-center gap-1">
                    <span class="truncate">{{ vol.name }}</span>
                    <span v-if="isInvalidVolumeName(vol.name)" class="badge badge-warning badge-xs shrink-0">无效</span>
                  </h4>
                  <font-awesome-icon
                    :icon="isVolumeExpanded(vol.id) ? 'chevron-up' : 'chevron-down'"
                    class="w-3 h-3 shrink-0 text-base-content/40"
                  />
                </button>
                <div class="flex gap-1 shrink-0">
                  <button class="btn btn-ghost btn-xs gap-1" @click.stop="startEditVolume(vol)">
                    <font-awesome-icon icon="edit" class="w-3 h-3" />
                    编辑
                  </button>
                  <button class="btn btn-ghost btn-xs text-error gap-1" @click.stop="deleteVolume(vol.id, vol.name)">
                    <font-awesome-icon icon="trash" class="w-3 h-3" />
                    删除
                  </button>
                </div>
              </div>
              <div
                v-show="isVolumeExpanded(vol.id)"
                class="px-4 pb-4 pt-0 border-t border-base-300/50"
              >
                <p v-if="vol.description" class="text-sm text-base-content/50 mt-3 whitespace-pre-wrap">{{ vol.description }}</p>
                <p v-else class="text-xs text-base-content/30 mt-3 italic">暂无分卷说明，点击编辑添加</p>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <StepNavFooter step="volumes" class="mt-4" />
  </div>
</template>
