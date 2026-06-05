<script setup lang="ts">
import { ref, computed, onMounted, inject, watch, nextTick } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import FavoriteButton from '../../components/FavoriteButton.vue'
import SettingVersionHistory from '../../components/SettingVersionHistory.vue'
import AiInterventionBar from './AiInterventionBar.vue'
import StepNavFooter from './StepNavFooter.vue'
import CharacterCardsPanel from './CharacterCardsPanel.vue'
import SettingsQualityPanel from './SettingsQualityPanel.vue'
import { editorNavKey } from './editor-nav'

const props = defineProps<{ workId: number }>()
const nav = inject(editorNavKey)

const settingTypes = [
  { type: 'character', label: '人设', icon: 'user', desc: '主角、配角等角色设定' },
  { type: 'worldview', label: '世界观', icon: 'globe', desc: '世界背景、力量体系等' },
  { type: 'conflict', label: '核心冲突', icon: 'bolt', desc: '主线冲突、暗线冲突' }
] as const

type SettingType = (typeof settingTypes)[number]['type']

const aiSystemPrompts: Record<SettingType, string> = {
  character: [
    '基于以下故事方向，生成主要角色设定。',
    '若上下文含「用户补充要求」，须严格遵守（含角色姓名、关系、禁忌等），并在 ## 标题中使用指定姓名。',
    '输出要求：',
    '- 用 Markdown 结构化输出，每个角色一个 ## 标题',
    '- 主角 800-1200 字，重要配角每人 300-500 字',
    '- 全部角色合计不超过 3000 字',
    '- 用结构化字段而非叙事散文，格式示例：',
    '  **性格内核**：一两句话概括',
    '  **语言模式**：分阶段的对话特征（用短条目）',
    '  **行为习惯**：具体的、可辨识的动作细节（用短条目）',
    '  **核心矛盾**：一段话说清内在撕裂',
    '  **行为逻辑**：「当 条件 → 动作」式的决策规则',
    '  **角色弧线**：起点→转折→终点，三句话以内',
    '- 禁止写场景示例或叙事性段落，那些属于大纲而非人设',
    '- 重点写 AI 写每一章都需遵守的约束，而非一次性的角色分析'
  ].join('\n'),
  worldview: [
    '基于以下故事设定，生成世界观规则。',
    '输出要求：',
    '- 用 Markdown 输出，按体系分节：## 世界结构 / ## 核心规则 / ## 力量体系 / ## 关键限制',
    '- 总字数控制在 800-2000 字',
    '- 只写"规则"和"限制"，不写百科词条式的冗长描述',
    '- 每条规则用一两句话说清：是什么、为什么、违反会怎样',
    '- 重点写会影响情节走向的硬性约束，而非装饰性背景'
  ].join('\n'),
  conflict: [
    '基于以下设定，提炼核心冲突。',
    '输出要求：',
    '- 用 Markdown 输出：## 主线冲突 / ## 副线冲突 / ## 冲突升级路径',
    '- 总字数控制在 500-1200 字',
    '- 主线冲突用一段话说清对立双方、不可调和之处、赌注',
    '- 副线冲突列出 2-3 条，每条两三句话',
    '- 升级路径用时间线式条目，标注冲突在何时加剧、何时反转',
    '- 禁止写具体的场景描写或对话，那些属于大纲层级'
  ].join('\n')
}

const coreSettings = ref<{ type: string; content: string }[]>([])
const editingType = ref<SettingType | null>(null)
const draftByType = ref<Partial<Record<SettingType, string>>>({})
const aiLoadingByType = ref<Partial<Record<SettingType, boolean>>>({})
const aiErrorByType = ref<Partial<Record<SettingType, string>>>({})
const lastAiContext = ref('')
/** 人设 AI 生成弹窗中的用户补充（按作品持久化，不写入人设正文） */
const characterGenHints = ref('')
const characterHintsDialogOpen = ref(false)
const characterHintsInputRef = ref<HTMLTextAreaElement | null>(null)
const expandedTypes = ref<Set<SettingType>>(new Set())
const versionHistoryRefs = ref<Partial<Record<SettingType, { load: () => Promise<void> }>>>({})
const characterCardsRef = ref<{ expandPanel?: () => void; load?: () => Promise<void> } | null>(null)
const qualityPanelRef = ref<{ load?: () => Promise<void> } | null>(null)

const editingMeta = computed(() =>
  settingTypes.find(st => st.type === editingType.value) ?? null
)

const hasAnyCoreSetting = computed(() =>
  settingTypes.some(st => getSetting(st.type).trim())
)

onMounted(() => {
  void loadCoreSettings()
})

watch(
  () => props.workId,
  () => {
    characterGenHints.value = ''
  }
)

async function loadCoreSettings() {
  coreSettings.value = await window.anovel.invoke('setting:listByWork', props.workId) as never[]
}

async function loadCharacterGenHints() {
  characterGenHints.value = (await window.anovel.invoke(
    'setting:getCharacterGenHints',
    props.workId
  )) as string
}

function bindVersionRef(type: SettingType, el: Element | ComponentPublicInstance | null) {
  if (el && typeof el === 'object' && 'load' in el) {
    versionHistoryRefs.value[type] = el as { load: () => Promise<void> }
  }
}

async function refreshVersionHistory(type: SettingType) {
  await versionHistoryRefs.value[type]?.load?.()
}

async function onSettingVersionRestored(type: SettingType) {
  await loadCoreSettings()
  await nav?.refreshProgress()
  await refreshVersionHistory(type)
}

function getSetting(type: string) {
  return coreSettings.value.find(s => s.type === type)?.content || ''
}

function isExpanded(type: SettingType) {
  return expandedTypes.value.has(type)
}

function toggleExpand(type: SettingType) {
  if (editingType.value === type) return
  const next = new Set(expandedTypes.value)
  if (next.has(type)) next.delete(type)
  else next.add(type)
  expandedTypes.value = next
}

function contentSummary(type: SettingType): string {
  const text = getSetting(type)
  if (!text) return ''
  const firstLine = text.split('\n').find(line => line.trim())?.trim() ?? ''
  const plain = firstLine.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim()
  const charCount = text.replace(/\s/g, '').length
  if (plain) {
    return plain.length > 48 ? `${plain.slice(0, 48)}… · ${charCount} 字` : `${plain} · ${charCount} 字`
  }
  return `已设定 · ${charCount} 字`
}

function getDraft(type: SettingType) {
  return draftByType.value[type] ?? ''
}

function setDraft(type: SettingType, value: string) {
  draftByType.value = { ...draftByType.value, [type]: value }
}

async function getStoryContext(type: SettingType, userHints?: string): Promise<string> {
  const draft = getDraft(type).trim() || getSetting(type).trim()
  const hints = userHints?.trim() ?? ''
  const options: { selfDraft?: string; userHints?: string } = {}
  if (draft) options.selfDraft = draft
  if (hints) options.userHints = hints
  const ctx = await window.anovel.invoke(
    'context:buildSettingsGeneration',
    props.workId,
    type,
    Object.keys(options).length ? options : undefined
  ) as { text: string }
  if (ctx.text) return ctx.text
  return ideaInputFallback()
}

function ideaInputFallback(): string {
  return getSetting('idea') || '（尚未填写故事方向，请先在孵化器中输入想法）'
}

function startEditSetting(type: SettingType, content?: string) {
  editingType.value = type
  setDraft(type, content ?? getSetting(type))
}

function cancelEdit() {
  editingType.value = null
}

async function saveSetting() {
  const type = editingType.value
  if (!type) return
  const content = getDraft(type).trim()
  await window.anovel.invoke('setting:upsert', props.workId, type, content)
  cancelEdit()
  await loadCoreSettings()
  await refreshVersionHistory(type)
  await qualityPanelRef.value?.load?.()
  await nav?.refreshProgress()
}

interface ModelChatIpcResult {
  success: boolean
  content: string
  error?: string
}

function onAiSuggestClick(type: SettingType) {
  if (aiLoadingByType.value[type]) return
  if (type === 'character') {
    void openCharacterHintsDialog()
    return
  }
  void runAiSuggest(type)
}

async function openCharacterHintsDialog() {
  await loadCharacterGenHints()
  characterHintsDialogOpen.value = true
  await nextTick()
  characterHintsInputRef.value?.focus()
}

function closeCharacterHintsDialog() {
  characterHintsDialogOpen.value = false
}

async function confirmCharacterAiSuggest() {
  const hints = characterGenHints.value.trim()
  await window.anovel.invoke('setting:setCharacterGenHints', props.workId, hints)
  closeCharacterHintsDialog()
  await runAiSuggest('character', hints)
}

async function runAiSuggest(type: SettingType, userHints?: string) {
  if (aiLoadingByType.value[type]) return

  aiLoadingByType.value = { ...aiLoadingByType.value, [type]: true }
  aiErrorByType.value = { ...aiErrorByType.value, [type]: '' }

  try {
    const context = await getStoryContext(type, userHints)
    lastAiContext.value = context

    const res = await window.anovel.invoke('model:chat', {
      prompt: context,
      systemPrompt: aiSystemPrompts[type],
      workId: props.workId,
      step: `settings_${type}`,
      enrichWorkContext: false
    }) as ModelChatIpcResult

    if (res.success) {
      setDraft(type, res.content)
      editingType.value = type
    } else {
      aiErrorByType.value = { ...aiErrorByType.value, [type]: res.error || '生成失败' }
    }
  } catch (e) {
    aiErrorByType.value = { ...aiErrorByType.value, [type]: String(e) }
  } finally {
    const nextLoading = { ...aiLoadingByType.value }
    delete nextLoading[type]
    aiLoadingByType.value = nextLoading
  }
}

function openAnchors() {
  nav?.goToPanel?.('anchors')
}

async function onSettingContentChanged() {
  await qualityPanelRef.value?.load?.()
  await nav?.refreshProgress()
}

async function onQualityRefreshed() {
  await loadCoreSettings()
  await characterCardsRef.value?.load?.()
  await qualityPanelRef.value?.load?.()
  await nav?.refreshProgress()
}
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="sliders" title="核心设定" />
    <p class="text-sm text-base-content/50 mb-6">定义人设、世界观和核心冲突，这些将作为 AI 生成的基础约束。各区块的 AI 生成可同时进行。</p>

    <div class="space-y-4">
      <div v-for="st in settingTypes" :key="st.type" class="card bg-base-200 border border-base-300 shadow-sm p-4">
        <div class="flex items-start justify-between mb-2">
          <div>
            <h4 class="font-semibold flex items-center gap-2">
              <font-awesome-icon :icon="st.icon" class="w-3.5 h-3.5 text-primary shrink-0" />
              {{ st.label }}
            </h4>
            <p class="text-xs text-base-content/40 mt-0.5">{{ st.desc }}</p>
          </div>
          <div class="flex gap-2">
            <button
              class="btn btn-primary btn-xs gap-1"
              :disabled="!!aiLoadingByType[st.type]"
              @click="onAiSuggestClick(st.type)"
            >
              <font-awesome-icon
                :icon="aiLoadingByType[st.type] ? 'spinner' : 'robot'"
                :spin="!!aiLoadingByType[st.type]"
                class="w-3 h-3"
              />
              {{ aiLoadingByType[st.type] ? '生成中...' : 'AI 生成建议' }}
            </button>
            <button
              class="btn btn-outline btn-primary btn-xs gap-1"
              @click="startEditSetting(st.type)"
            >
              <font-awesome-icon :icon="getSetting(st.type) ? 'edit' : 'plus'" class="w-3 h-3" />
              {{ getSetting(st.type) ? '编辑' : '添加' }}
            </button>
          </div>
        </div>

        <div v-if="aiErrorByType[st.type]" class="alert alert-error text-xs py-2 mb-3">
          {{ aiErrorByType[st.type] }}
        </div>

        <div v-if="getSetting(st.type)" class="mt-1">
          <button
            type="button"
            class="w-full flex items-center justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-base-100/80 transition-colors"
            @click="toggleExpand(st.type)"
          >
            <span class="text-xs text-base-content/60 truncate">{{ contentSummary(st.type) }}</span>
            <font-awesome-icon
              :icon="isExpanded(st.type) ? 'chevron-up' : 'chevron-down'"
              class="w-3 h-3 shrink-0 text-base-content/40"
            />
          </button>
          <div v-show="isExpanded(st.type)" class="mt-2 pt-2 border-t border-base-300/50">
            <MarkdownContent :content="getSetting(st.type)" size="sm" />
          </div>
        </div>
        <p v-else class="text-sm text-base-content/40 italic">尚未设定</p>

        <SettingVersionHistory
          :ref="(el) => bindVersionRef(st.type, el)"
          :work-id="workId"
          :type="st.type"
          @restored="onSettingVersionRestored(st.type)"
        />
      </div>

      <CharacterCardsPanel ref="characterCardsRef" :work-id="workId" @content-changed="onSettingContentChanged" />
    </div>

    <SettingsQualityPanel
      v-if="hasAnyCoreSetting"
      ref="qualityPanelRef"
      :work-id="workId"
      @open-anchors="openAnchors"
      @refreshed="onQualityRefreshed"
    />

    <StepNavFooter step="settings" :work-id="workId" />

    <dialog :class="['modal', { 'modal-open': characterHintsDialogOpen }]">
      <div class="modal-box max-w-lg">
        <h3 class="font-bold text-lg mb-1">人设 · AI 生成</h3>
        <p class="text-sm text-base-content/50 mb-4">
          可填写本次生成的补充要求（如角色姓名、关系、禁忌）。留空则仅依据故事方向生成。
        </p>
        <textarea
          ref="characterHintsInputRef"
          v-model="characterGenHints"
          rows="4"
          class="textarea textarea-bordered w-full text-sm leading-relaxed"
          placeholder="例如：男主名沈辙，女主名温荞；男二为发小未婚夫；不要用真实明星姓名…"
          @keydown.ctrl.enter.prevent="confirmCharacterAiSuggest"
          @keydown.meta.enter.prevent="confirmCharacterAiSuggest"
        />
        <p class="text-xs text-base-content/40 mt-2">
          补充说明会注入 prompt，并记住以便下次生成；不会直接写入人设正文。⌘/Ctrl + Enter 开始生成。
        </p>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost" @click="closeCharacterHintsDialog">取消</button>
          <button
            type="button"
            class="btn btn-primary gap-1"
            :disabled="!!aiLoadingByType.character"
            @click="confirmCharacterAiSuggest"
          >
            <font-awesome-icon
              v-if="aiLoadingByType.character"
              icon="spinner"
              spin
              class="w-3.5 h-3.5"
            />
            {{ aiLoadingByType.character ? '生成中...' : '开始生成' }}
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop bg-black/40" @click="closeCharacterHintsDialog">
        <button type="button">close</button>
      </form>
    </dialog>

    <dialog :class="['modal', { 'modal-open': editingType !== null }]">
      <div v-if="editingMeta && editingType" class="modal-box w-[92vw] max-w-6xl h-[88vh] p-0 flex flex-col">
        <div class="flex items-center justify-between gap-4 px-6 py-4 border-b border-base-300 shrink-0">
          <div class="flex items-center gap-2 min-w-0">
            <font-awesome-icon :icon="editingMeta.icon" class="w-4 h-4 text-primary shrink-0" />
            <h3 class="font-bold text-lg truncate">编辑 · {{ editingMeta.label }}</h3>
          </div>
          <div class="flex gap-2 shrink-0">
            <button
              type="button"
              class="btn btn-primary btn-sm gap-1"
              @click="saveSetting"
            >
              <font-awesome-icon icon="save" class="w-3 h-3" />
              {{ getDraft(editingType).trim() ? '保存' : '清空并保存' }}
            </button>
            <FavoriteButton
              v-if="getDraft(editingType).trim()"
              :work-id="workId"
              :source-step="`settings_${editingType}`"
              :source-label="`${editingMeta.label}建议`"
              :content="getDraft(editingType)"
              :source-input="lastAiContext"
              size="sm"
            />
            <button type="button" class="btn btn-outline btn-neutral btn-sm gap-1" @click="cancelEdit">
              <font-awesome-icon icon="times" class="w-3 h-3" />
              取消
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 flex-1 min-h-0 px-6 py-4 overflow-hidden">
          <div class="flex flex-col min-h-0">
            <p class="text-xs font-medium text-base-content/50 mb-2">编辑</p>
            <textarea
              :value="getDraft(editingType)"
              class="textarea textarea-bordered w-full flex-1 min-h-0 resize-none text-sm leading-relaxed"
              :placeholder="`输入${editingMeta.label}...`"
              @input="(e: Event) => setDraft(editingType, (e.target as HTMLTextAreaElement).value)"
            />
          </div>
          <div class="flex flex-col min-h-0">
            <p class="text-xs font-medium text-base-content/50 mb-2">Markdown 预览</p>
            <div class="rounded-lg border border-base-300/60 p-4 bg-base-100 flex-1 min-h-0 overflow-auto">
              <MarkdownContent v-if="getDraft(editingType).trim()" :content="getDraft(editingType)" size="sm" />
              <p v-else class="text-sm text-base-content/40 italic">输入内容后在此实时预览</p>
            </div>
          </div>
        </div>

        <div v-if="getDraft(editingType).trim()" class="px-6 py-4 border-t border-base-300 shrink-0 overflow-auto max-h-48">
          <AiInterventionBar
            :work-id="workId"
            :step="`settings_${editingType}`"
            :content="getDraft(editingType)"
            :regenerate-prompt="lastAiContext || ideaInputFallback()"
            :regenerate-system-prompt="aiSystemPrompts[editingType]"
            @update:content="setDraft(editingType, $event)"
          />
        </div>
      </div>
      <form method="dialog" class="modal-backdrop bg-black/40" @click="cancelEdit">
        <button type="button">close</button>
      </form>
    </dialog>
  </div>
</template>
