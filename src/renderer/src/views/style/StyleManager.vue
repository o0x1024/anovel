<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import {
  parseStyleStepRules,
  emptyStyleStepRules,
  type StyleStepRules
} from '../../../../shared/style-step-rules'
import { MAX_STYLE_REFERENCE_TEXT_CHARS } from '../../../../shared/style-reference-limits'
import type { StyleAnalysisResult } from '../../../../shared/assistant-types'
import { toPlainForIpc } from '../../../../shared/ipc-plain'

interface Style {
  id: number
  name: string
  description: string | null
  sample_text: string | null
  reference_text: string | null
  prompt_template: string
  step_rules_json: string | null
  is_builtin: number
  create_time: string
}

interface StepRulesForm {
  emotional_core: string
  target_reader: string
  style_keywords: string
  decision_rules: string
  conflict_interval: string
  payoff_interval: string
  chapter_end_must: string
  emotion_loop: string
  quality_checklist: string
}

const styles = ref<Style[]>([])
const loading = ref(true)
const selectedId = ref<number | null>(null)
const panelMode = ref<'detail' | 'create' | 'edit' | 'edit_step_rules' | 'ai_generate'>('detail')
const saving = ref(false)

const aiDescription = ref('')
const aiGenerating = ref(false)
const aiError = ref('')
const aiPreviewMarkdown = ref('')
const aiAnalysis = ref<StyleAnalysisResult | null>(null)
const aiSaving = ref(false)

const form = ref({
  name: '',
  description: '',
  sample_text: '',
  reference_text: '',
  prompt_template: ''
})
const refTextCharCount = computed(() => form.value.reference_text.length)
const stepRulesExpanded = ref(false)
const stepRulesForm = ref<StepRulesForm>(emptyStepRulesForm())

const selectedStyle = computed(() =>
  styles.value.find(s => s.id === selectedId.value) ?? null
)

const selectedStepRules = computed(() =>
  parseStyleStepRules(selectedStyle.value?.step_rules_json)
)

function emptyStepRulesForm(): StepRulesForm {
  return {
    emotional_core: '',
    target_reader: '',
    style_keywords: '',
    decision_rules: '',
    conflict_interval: '',
    payoff_interval: '',
    chapter_end_must: '',
    emotion_loop: '',
    quality_checklist: ''
  }
}

function splitCsv(s: string): string[] {
  return s.split(/[,，]/).map(x => x.trim()).filter(Boolean)
}

function stepRulesToForm(rules: StyleStepRules | null): StepRulesForm {
  const r = rules ?? emptyStyleStepRules()
  return {
    emotional_core: r.identity.emotional_core.join(', '),
    target_reader: r.identity.target_reader,
    style_keywords: r.identity.style_keywords.join(', '),
    decision_rules: r.decision_rules.join('\n'),
    conflict_interval: r.pacing_rules.conflict_interval,
    payoff_interval: r.pacing_rules.payoff_interval,
    chapter_end_must: r.pacing_rules.chapter_end_must.join(', '),
    emotion_loop: r.pacing_rules.emotion_loop.join(', '),
    quality_checklist: r.quality_checklist.join('\n')
  }
}

function formToStepRulesJson(sf: StepRulesForm): string | undefined {
  const rules: StyleStepRules = {
    identity: {
      emotional_core: splitCsv(sf.emotional_core),
      target_reader: sf.target_reader.trim(),
      style_keywords: splitCsv(sf.style_keywords)
    },
    decision_rules: sf.decision_rules.split('\n').map(s => s.trim()).filter(Boolean),
    pacing_rules: {
      conflict_interval: sf.conflict_interval.trim(),
      payoff_interval: sf.payoff_interval.trim(),
      chapter_end_must: splitCsv(sf.chapter_end_must),
      emotion_loop: splitCsv(sf.emotion_loop)
    },
    quality_checklist: sf.quality_checklist.split('\n').map(s => s.trim()).filter(Boolean)
  }
  const hasContent =
    rules.identity.emotional_core.length > 0 ||
    rules.identity.target_reader ||
    rules.identity.style_keywords.length > 0 ||
    rules.decision_rules.length > 0 ||
    rules.pacing_rules.conflict_interval ||
    rules.pacing_rules.payoff_interval ||
    rules.pacing_rules.chapter_end_must.length > 0 ||
    rules.pacing_rules.emotion_loop.length > 0 ||
    rules.quality_checklist.length > 0
  return hasContent ? JSON.stringify(rules) : undefined
}

function onStyleChanged(_id: unknown) {
  void loadStyles().then(() => {
    if (typeof _id === 'number') {
      selectedId.value = _id
      panelMode.value = 'detail'
    }
  })
}

onMounted(async () => {
  window.anovel.on('style:changed', onStyleChanged)
  await loadStyles()
})

onUnmounted(() => {
  window.anovel.off('style:changed', onStyleChanged)
})

watch(styles, (list) => {
  if (list.length === 0) {
    selectedId.value = null
    panelMode.value = 'detail'
    return
  }
  if (selectedId.value && !list.some(s => s.id === selectedId.value)) {
    selectedId.value = list[0]?.id ?? null
  }
  if (!selectedId.value && list.length) {
    selectedId.value = list[0].id
  }
})

async function loadStyles() {
  loading.value = true
  try {
    styles.value = await window.anovel.invoke('style:list') as Style[]
  } catch (e) {
    console.error('加载文风列表失败:', e)
  } finally {
    loading.value = false
  }
}

function selectStyle(style: Style) {
  selectedId.value = style.id
  panelMode.value = 'detail'
}

function openCreate() {
  selectedId.value = null
  panelMode.value = 'create'
  form.value = { name: '', description: '', sample_text: '', reference_text: '', prompt_template: '' }
  stepRulesForm.value = emptyStepRulesForm()
  stepRulesExpanded.value = false
}

function openAiGenerate() {
  selectedId.value = null
  panelMode.value = 'ai_generate'
  aiDescription.value = ''
  aiError.value = ''
  aiPreviewMarkdown.value = ''
  aiAnalysis.value = null
}

function applyAnalysisToForm(analysis: StyleAnalysisResult) {
  form.value = {
    name: analysis.styleName,
    description: analysis.description,
    prompt_template: analysis.promptTemplate,
    sample_text: analysis.sampleExcerpts.filter(s => s.trim()).join('\n\n').slice(0, 3000),
    reference_text: analysis.referenceText?.slice(0, MAX_STYLE_REFERENCE_TEXT_CHARS) ?? ''
  }
  if (analysis.stepRules) {
    stepRulesForm.value = stepRulesToForm(analysis.stepRules)
    stepRulesExpanded.value = true
  } else {
    stepRulesForm.value = emptyStepRulesForm()
    stepRulesExpanded.value = false
  }
  panelMode.value = 'create'
}

async function generateStyleFromAi() {
  const desc = aiDescription.value.trim()
  if (!desc || aiGenerating.value) return

  aiGenerating.value = true
  aiError.value = ''
  aiPreviewMarkdown.value = ''
  aiAnalysis.value = null

  try {
    const res = await window.anovel.invoke('style:generateFromDescription', desc) as {
      success: boolean
      analysis?: StyleAnalysisResult
      previewMarkdown?: string
      error?: string
    }
    if (res.success && res.analysis) {
      aiAnalysis.value = res.analysis
      aiPreviewMarkdown.value = res.previewMarkdown ?? ''
    } else {
      aiError.value = res.error || '生成失败'
    }
  } catch (e) {
    aiError.value = String(e)
  } finally {
    aiGenerating.value = false
  }
}

async function saveAiAnalysis() {
  if (!aiAnalysis.value || aiSaving.value) return
  aiSaving.value = true
  aiError.value = ''
  try {
    const id = await window.anovel.invoke('assistant:exportStyle', toPlainForIpc(aiAnalysis.value)) as number
    selectedId.value = id
    panelMode.value = 'detail'
    await loadStyles()
  } catch (e) {
    aiError.value = e instanceof Error ? e.message : String(e)
  } finally {
    aiSaving.value = false
  }
}

function openEdit(style?: Style) {
  const target = style ?? selectedStyle.value
  if (!target) return
  selectedId.value = target.id
  panelMode.value = 'edit'
  fillForm(target)
}

function openEditStepRules(style?: Style) {
  const target = style ?? selectedStyle.value
  if (!target) return
  selectedId.value = target.id
  panelMode.value = 'edit_step_rules'
  stepRulesForm.value = stepRulesToForm(parseStyleStepRules(target.step_rules_json))
  stepRulesExpanded.value = true
}

async function saveStepRulesOnly() {
  if (!selectedId.value || saving.value) return
  saving.value = true
  try {
    const stepRulesJson = formToStepRulesJson(stepRulesForm.value)
    await window.anovel.invoke('style:update', selectedId.value, {
      step_rules_json: stepRulesJson ?? null
    })
    panelMode.value = 'detail'
    await loadStyles()
  } catch (e) {
    console.error('保存分步规则失败:', e)
  } finally {
    saving.value = false
  }
}

function fillForm(style: Style) {
  form.value = {
    name: style.name,
    description: style.description || '',
    sample_text: style.sample_text || '',
    reference_text: style.reference_text || '',
    prompt_template: style.prompt_template
  }
  stepRulesForm.value = stepRulesToForm(parseStyleStepRules(style.step_rules_json))
  stepRulesExpanded.value = !!style.step_rules_json
}

function cancelForm() {
  panelMode.value = 'detail'
  if (!selectedId.value && styles.value.length) {
    selectedId.value = styles.value[0].id
  }
}

async function saveStyle() {
  if (!form.value.name.trim() || saving.value) return
  saving.value = true
  try {
    const stepRulesJson = formToStepRulesJson(stepRulesForm.value)
    const payload = {
      ...form.value,
      description: form.value.description.trim() || null,
      sample_text: form.value.sample_text.trim() || null,
      reference_text: form.value.reference_text.trim() || null,
      prompt_template: form.value.prompt_template.trim(),
      step_rules_json: stepRulesJson ?? null
    }
    if (panelMode.value === 'edit' && selectedId.value) {
      await window.anovel.invoke('style:update', selectedId.value, payload)
    } else {
      const id = await window.anovel.invoke('style:create', payload) as number
      selectedId.value = id
    }
    panelMode.value = 'detail'
    await loadStyles()
  } catch (e) {
    console.error('保存文风失败:', e)
  } finally {
    saving.value = false
  }
}

async function deleteStyle(style: Style) {
  if (!confirm(`删除文风「${style.name}」？`)) return
  try {
    await window.anovel.invoke('style:delete', style.id)
    await loadStyles()
    panelMode.value = 'detail'
  } catch (e) {
    console.error('删除文风失败:', e)
  }
}

async function extractFingerprint(style: Style) {
  const text = style.sample_text?.trim()
  if (!text) {
    alert('请先编辑文风并填写样例文本')
    return
  }
  await window.anovel.invoke('fingerprint:saveToStyle', style.id, text)
  alert('文风指纹已提取并保存')
}

function handleRefTextFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const text = (reader.result as string).slice(0, MAX_STYLE_REFERENCE_TEXT_CHARS)
    form.value.reference_text = text
  }
  reader.readAsText(file)
  input.value = ''
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + 'Z').toLocaleString('zh-CN')
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- 左侧文风列表 -->
    <aside class="w-72 shrink-0 border-r border-base-300 flex flex-col min-h-0 bg-base-200/30">
      <div class="p-4 border-b border-base-300 shrink-0">
        <div class="flex items-center justify-between gap-2">
          <h2 class="font-bold text-sm">文风列表</h2>
          <button
            type="button"
            class="btn btn-ghost btn-xs btn-square shrink-0"
            title="刷新列表"
            :disabled="loading"
            @click="loadStyles"
          >
            <font-awesome-icon icon="rotate" class="w-3 h-3" :spin="loading" />
          </button>
        </div>
        <p class="text-xs text-base-content/40 mt-0.5">点击文风查看详情</p>
        <div class="flex gap-2 mt-3">
          <button type="button" class="btn btn-primary btn-sm flex-1 gap-1" @click="openCreate">
            <font-awesome-icon icon="plus" class="w-3 h-3" />
            新建
          </button>
          <button type="button" class="btn btn-outline btn-primary btn-sm flex-1 gap-1" @click="openAiGenerate">
            <font-awesome-icon icon="robot" class="w-3 h-3" />
            AI 生成
          </button>
        </div>
      </div>

      <div v-if="loading" class="flex-1 flex items-center justify-center">
        <span class="loading loading-spinner loading-sm" />
      </div>

      <div v-else-if="styles.length === 0" class="flex-1 flex flex-col items-center justify-center text-base-content/40 gap-2 p-4">
        <font-awesome-icon icon="palette" class="text-3xl opacity-20" />
        <p class="text-xs text-center">暂无文风</p>
      </div>

      <ul v-else class="menu menu-sm flex-1 overflow-y-auto p-2 gap-0.5">
        <li v-for="style in styles" :key="style.id">
          <button
            type="button"
            class="flex items-center gap-2"
            :class="{ 'menu-active': selectedId === style.id && panelMode === 'detail' }"
            @click="selectStyle(style)"
          >
            <font-awesome-icon icon="palette" class="w-3.5 h-3.5 opacity-70 shrink-0" />
            <span class="flex-1 truncate text-left">{{ style.name }}</span>
            <span
              :class="style.is_builtin ? 'badge badge-primary badge-xs shrink-0' : 'badge badge-success badge-xs shrink-0'"
            >
              {{ style.is_builtin ? '内置' : '自定义' }}
            </span>
          </button>
        </li>
      </ul>
    </aside>

    <!-- 右侧详情 / 编辑 -->
    <main class="flex-1 min-w-0 overflow-y-auto scrollbar-thin">
      <!-- 新建 / 编辑表单 -->
      <div v-if="panelMode === 'edit_step_rules'" class="p-6 lg:p-8 max-w-3xl">
        <h2 class="text-xl font-bold mb-1">编辑分步创作规则</h2>
        <p class="text-xs text-base-content/40 mb-4">
          {{ selectedStyle?.name }} — 仅更新大纲/设定/自检阶段注入的规则，不修改 Prompt 模板
        </p>
        <div class="space-y-3">
          <!-- reuse same fields as collapse in edit form - duplicate minimal set -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="text-xs text-base-content/50">核心情绪（逗号分隔）</label>
              <input v-model="stepRulesForm.emotional_core" class="input input-bordered input-sm w-full mt-1" />
            </div>
            <div>
              <label class="text-xs text-base-content/50">目标读者</label>
              <input v-model="stepRulesForm.target_reader" class="input input-bordered input-sm w-full mt-1" />
            </div>
          </div>
          <div>
            <label class="text-xs text-base-content/50">决策规则（每行一条）</label>
            <textarea v-model="stepRulesForm.decision_rules" rows="5" class="textarea textarea-bordered w-full mt-1 text-xs font-mono" />
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label class="text-xs text-base-content/50">冲突间隔</label>
              <input v-model="stepRulesForm.conflict_interval" class="input input-bordered input-sm w-full mt-1" />
            </div>
            <div>
              <label class="text-xs text-base-content/50">爽点间隔</label>
              <input v-model="stepRulesForm.payoff_interval" class="input input-bordered input-sm w-full mt-1" />
            </div>
          </div>
          <div>
            <label class="text-xs text-base-content/50">质量检查清单（每行一条）</label>
            <textarea v-model="stepRulesForm.quality_checklist" rows="4" class="textarea textarea-bordered w-full mt-1 text-xs" />
          </div>
          <div class="flex gap-2 pt-2">
            <button type="button" class="btn btn-primary btn-sm" :disabled="saving" @click="saveStepRulesOnly">
              {{ saving ? '保存中…' : '保存分步规则' }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="cancelForm">取消</button>
          </div>
        </div>
      </div>

      <!-- AI 文风生成功能 -->
      <div v-else-if="panelMode === 'ai_generate'" class="p-6 lg:p-8 max-w-3xl">
        <h2 class="text-xl font-bold mb-1">AI 生成文风</h2>
        <p class="text-xs text-base-content/40 mb-4">
          用自然语言描述想要的写作风格，AI 将自动生成 Prompt 模板、分步规则与样例段落
        </p>

        <div class="space-y-4">
          <div>
            <label class="text-xs text-base-content/50">文风描述 <span class="text-error">*</span></label>
            <textarea
              v-model="aiDescription"
              placeholder="例如：快节奏都市爽文，主角碾压反派，对话 witty，每章末尾留悬念，句子短促，对话占比高，禁止 AI 痕迹连接词…"
              rows="5"
              class="textarea textarea-bordered w-full mt-1 resize-none text-sm"
              :disabled="aiGenerating"
            />
          </div>

          <div class="flex gap-2">
            <button
              type="button"
              class="btn btn-primary btn-sm gap-1"
              :disabled="!aiDescription.trim() || aiGenerating"
              @click="generateStyleFromAi"
            >
              <font-awesome-icon :icon="aiGenerating ? 'spinner' : 'robot'" class="w-3.5 h-3.5" :spin="aiGenerating" />
              {{ aiGenerating ? '生成中…' : '开始生成' }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="aiGenerating" @click="cancelForm">
              取消
            </button>
          </div>

          <div v-if="aiError" class="alert alert-error text-xs py-2">{{ aiError }}</div>

          <div v-if="aiAnalysis" class="card bg-base-200 border border-primary/20">
            <div class="card-body p-4 gap-3">
              <div class="flex items-start justify-between gap-2">
                <div>
                  <h3 class="font-bold">{{ aiAnalysis.styleName }}</h3>
                  <p class="text-xs text-base-content/50 mt-1">{{ aiAnalysis.description }}</p>
                </div>
                <span
                  class="badge badge-sm"
                  :class="{
                    'badge-success': aiAnalysis.confidence === 'high',
                    'badge-warning': aiAnalysis.confidence === 'medium',
                    'badge-ghost': aiAnalysis.confidence === 'low'
                  }"
                >
                  {{ aiAnalysis.confidence }}
                </span>
              </div>

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                <div><span class="text-base-content/40">句长节奏</span> {{ aiAnalysis.dimensions.sentenceRhythm }}</div>
                <div><span class="text-base-content/40">对话风格</span> {{ aiAnalysis.dimensions.dialogueStyle }}</div>
                <div><span class="text-base-content/40">叙述距离</span> {{ aiAnalysis.dimensions.narrativeDistance }}</div>
                <div><span class="text-base-content/40">节奏</span> {{ aiAnalysis.dimensions.pacing }}</div>
              </div>

              <div v-if="aiAnalysis.warnings?.length" class="text-xs text-warning">
                {{ aiAnalysis.warnings.join('；') }}
              </div>

              <div
                v-if="aiAnalysis.stepRules?.decision_rules?.length || aiAnalysis.stepRules?.quality_checklist?.length"
                class="text-xs bg-base-300/40 rounded-lg p-2 space-y-1"
              >
                <p class="font-medium text-base-content/60">分步规则</p>
                <p v-if="aiAnalysis.stepRules.identity?.emotional_core?.length">
                  情绪：{{ aiAnalysis.stepRules.identity.emotional_core.join('、') }}
                </p>
                <p v-if="aiAnalysis.stepRules.decision_rules?.length">
                  决策规则 {{ aiAnalysis.stepRules.decision_rules.length }} 条
                </p>
                <p v-if="aiAnalysis.stepRules.quality_checklist?.length">
                  检查清单 {{ aiAnalysis.stepRules.quality_checklist.length }} 条
                </p>
              </div>

              <div>
                <label class="text-xs text-base-content/50">Prompt 模板预览</label>
                <pre class="bg-base-300/40 rounded-lg p-3 text-xs whitespace-pre-wrap font-mono mt-1 max-h-40 overflow-y-auto scrollbar-thin">{{ aiAnalysis.promptTemplate }}</pre>
              </div>

              <div v-if="aiAnalysis.sampleExcerpts?.length">
                <label class="text-xs text-base-content/50">样例段落预览</label>
                <p class="bg-base-300/40 rounded-lg p-3 text-sm italic text-base-content/70 whitespace-pre-wrap mt-1 max-h-32 overflow-y-auto scrollbar-thin">
                  {{ aiAnalysis.sampleExcerpts.join('\n\n') }}
                </p>
              </div>

              <div v-if="aiPreviewMarkdown" class="collapse collapse-arrow bg-base-300/30 border border-base-300 rounded-lg">
                <input type="checkbox" />
                <div class="collapse-title text-xs font-medium py-2 min-h-0">查看完整分析报告</div>
                <div class="collapse-content">
                  <pre class="text-xs whitespace-pre-wrap text-base-content/70 pb-2">{{ aiPreviewMarkdown }}</pre>
                </div>
              </div>

              <div class="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  class="btn btn-primary btn-sm gap-1"
                  :disabled="aiSaving"
                  @click="saveAiAnalysis"
                >
                  <font-awesome-icon icon="save" class="w-3.5 h-3.5" />
                  {{ aiSaving ? '保存中…' : '直接保存' }}
                </button>
                <button type="button" class="btn btn-outline btn-sm" @click="applyAnalysisToForm(aiAnalysis)">
                  填入表单编辑
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-else-if="panelMode === 'create' || panelMode === 'edit'" class="p-6 lg:p-8 max-w-3xl">
        <h2 class="text-xl font-bold mb-1">
          {{ panelMode === 'edit' ? '编辑文风' : '新建文风' }}
        </h2>
        <p class="text-xs text-base-content/40 mb-4">配置文风名称、Prompt 模板与样例文本</p>

        <div class="space-y-3">
          <div>
            <label class="text-xs text-base-content/50">名称 <span class="text-error">*</span></label>
            <input
              v-model="form.name"
              placeholder="如：古风言情-婉约"
              class="input input-bordered input-sm w-full mt-1"
            />
          </div>
          <div>
            <label class="text-xs text-base-content/50">简短描述</label>
            <input
              v-model="form.description"
              placeholder="一句话描述这种文风的特点"
              class="input input-bordered input-sm w-full mt-1"
            />
          </div>
          <div>
            <label class="text-xs text-base-content/50">Prompt 模板（可选）</label>
            <textarea
              v-model="form.prompt_template"
              placeholder="编写 AI 遵循的风格指令；可留空，仅依赖参考范文或分步规则"
              rows="8"
              class="textarea textarea-bordered w-full mt-1 resize-none font-mono text-xs"
            />
          </div>
          <div>
            <label class="text-xs text-base-content/50">样例文本（可选，100-500字，用于文风指纹计算）</label>
            <textarea
              v-model="form.sample_text"
              placeholder="粘贴一段代表该文风的示例文段（100-500字）"
              rows="4"
              class="textarea textarea-bordered w-full mt-1 resize-none text-sm"
            />
          </div>

          <div>
            <div class="flex items-center justify-between">
              <label class="text-xs text-base-content/50">参考范文（可选，≤{{ MAX_STYLE_REFERENCE_TEXT_CHARS }}字，用于 few-shot 风格注入，是降低 AI 检测率的核心手段）</label>
              <span class="text-xs text-base-content/30">{{ refTextCharCount }} / {{ MAX_STYLE_REFERENCE_TEXT_CHARS }}</span>
            </div>
            <textarea
              v-model="form.reference_text"
              placeholder="粘贴一段目标风格的长范文（如某小说的精彩片段），AI 将模仿此文本的用词、句式和节奏"
              rows="8"
              :maxlength="MAX_STYLE_REFERENCE_TEXT_CHARS"
              class="textarea textarea-bordered w-full mt-1 resize-none text-sm"
            />
            <div class="mt-1">
              <label class="btn btn-ghost btn-xs gap-1 cursor-pointer">
                <font-awesome-icon icon="upload" class="w-3 h-3" />
                从文件导入
                <input type="file" accept=".txt,.text" class="hidden" @change="handleRefTextFile" />
              </label>
            </div>
          </div>

          <div class="collapse collapse-arrow bg-base-200/50 border border-base-300 rounded-lg">
            <input v-model="stepRulesExpanded" type="checkbox" />
            <div class="collapse-title text-sm font-medium py-3 min-h-0">
              分步创作规则（大纲/设定/自检阶段注入）
            </div>
            <div class="collapse-content space-y-3 pb-4">
              <p class="text-xs text-base-content/50">
                正文阶段使用上方 Prompt 模板（可留空）；大纲与情节阶段使用决策规则与节奏约束。
              </p>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs text-base-content/50">核心情绪（逗号分隔）</label>
                  <input v-model="stepRulesForm.emotional_core" class="input input-bordered input-sm w-full mt-1" placeholder="爽感, 好奇" />
                </div>
                <div>
                  <label class="text-xs text-base-content/50">目标读者</label>
                  <input v-model="stepRulesForm.target_reader" class="input input-bordered input-sm w-full mt-1" placeholder="男频18-35岁" />
                </div>
              </div>
              <div>
                <label class="text-xs text-base-content/50">风格关键词（逗号分隔）</label>
                <input v-model="stepRulesForm.style_keywords" class="input input-bordered input-sm w-full mt-1" placeholder="快节奏, 高反馈" />
              </div>
              <div>
                <label class="text-xs text-base-content/50">决策规则（每行一条，「当 条件 → 动作」格式）</label>
                <textarea
                  v-model="stepRulesForm.decision_rules"
                  rows="4"
                  class="textarea textarea-bordered w-full mt-1 text-xs font-mono"
                  placeholder="当 当前场景无冲突 → 创建冲突"
                />
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs text-base-content/50">冲突间隔</label>
                  <input v-model="stepRulesForm.conflict_interval" class="input input-bordered input-sm w-full mt-1" placeholder="300-800字" />
                </div>
                <div>
                  <label class="text-xs text-base-content/50">爽点间隔</label>
                  <input v-model="stepRulesForm.payoff_interval" class="input input-bordered input-sm w-full mt-1" placeholder="500-1500字" />
                </div>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs text-base-content/50">章末必须（逗号分隔）</label>
                  <input v-model="stepRulesForm.chapter_end_must" class="input input-bordered input-sm w-full mt-1" placeholder="新冲突, 悬念" />
                </div>
                <div>
                  <label class="text-xs text-base-content/50">情绪循环（逗号分隔）</label>
                  <input v-model="stepRulesForm.emotion_loop" class="input input-bordered input-sm w-full mt-1" placeholder="压抑, 爆发, 奖励" />
                </div>
              </div>
              <div>
                <label class="text-xs text-base-content/50">质量检查清单（每行一条）</label>
                <textarea
                  v-model="stepRulesForm.quality_checklist"
                  rows="4"
                  class="textarea textarea-bordered w-full mt-1 text-xs"
                  placeholder="本章是否有至少1次冲突？"
                />
              </div>
            </div>
          </div>

          <div class="flex gap-2 pt-2">
            <button
              type="button"
              class="btn btn-primary btn-sm gap-1"
              :disabled="!form.name.trim() || saving"
              @click="saveStyle"
            >
              <font-awesome-icon icon="save" class="w-3.5 h-3.5" />
              {{ saving ? '保存中…' : '保存' }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="cancelForm">取消</button>
          </div>
        </div>
      </div>

      <!-- 详情预览 -->
      <div v-else-if="selectedStyle" class="p-6 lg:p-8">
        <div class="flex items-start justify-between gap-4 mb-6">
          <div class="flex items-start gap-4 min-w-0">
            <div class="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
              <font-awesome-icon icon="palette" class="w-5 h-5" />
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h2 class="text-xl font-bold">{{ selectedStyle.name }}</h2>
                <span v-if="selectedStyle.is_builtin" class="badge badge-primary badge-sm">内置</span>
                <span v-else class="badge badge-success badge-sm">自定义</span>
              </div>
              <p class="text-sm text-base-content/60 mt-1">
                {{ selectedStyle.description || '暂无描述' }}
              </p>
              <p class="text-xs text-base-content/30 mt-2">
                创建于 {{ formatDate(selectedStyle.create_time) }}
              </p>
            </div>
          </div>
          <div class="flex flex-wrap gap-1 shrink-0 justify-end">
            <button
              type="button"
              class="btn btn-outline btn-sm"
              @click="openEditStepRules()"
            >
              分步规则
            </button>
            <button
              v-if="selectedStyle.sample_text"
              type="button"
              class="btn btn-outline btn-primary btn-sm"
              @click="extractFingerprint(selectedStyle)"
            >
              提取指纹
            </button>
            <button
              v-if="!selectedStyle.is_builtin"
              type="button"
              class="btn btn-primary btn-sm"
              @click="openEdit()"
            >
              编辑
            </button>
            <button
              type="button"
              class="btn btn-ghost btn-sm text-error"
              @click="deleteStyle(selectedStyle)"
            >
              删除
            </button>
          </div>
        </div>

        <div class="space-y-5">
          <section v-if="selectedStyle.prompt_template?.trim()">
            <h3 class="text-xs font-bold text-base-content/40 uppercase tracking-wider mb-2">Prompt 模板</h3>
            <pre class="bg-base-200 border border-base-300 rounded-lg p-4 text-xs whitespace-pre-wrap font-mono text-base-content/80">{{ selectedStyle.prompt_template }}</pre>
          </section>

          <section v-if="selectedStyle.sample_text">
            <h3 class="text-xs font-bold text-base-content/40 uppercase tracking-wider mb-2">样例文本</h3>
            <p class="bg-base-200 border border-base-300 rounded-lg p-4 text-sm italic text-base-content/70 leading-relaxed whitespace-pre-wrap">
              {{ selectedStyle.sample_text }}
            </p>
          </section>

          <section v-if="selectedStyle.reference_text">
            <h3 class="text-xs font-bold text-base-content/40 uppercase tracking-wider mb-2">
              参考范文
              <span class="text-base-content/20 font-normal ml-2">{{ selectedStyle.reference_text.length }} 字</span>
            </h3>
            <p class="bg-base-200 border border-base-300 rounded-lg p-4 text-sm text-base-content/70 leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto scrollbar-thin">
              {{ selectedStyle.reference_text }}
            </p>
          </section>

          <section v-if="selectedStepRules">
            <h3 class="text-xs font-bold text-base-content/40 uppercase tracking-wider mb-2">分步创作规则</h3>
            <div class="bg-base-200 border border-base-300 rounded-lg p-4 text-sm space-y-3">
              <div v-if="selectedStepRules.identity.emotional_core.length">
                <span class="text-base-content/50 text-xs">核心情绪</span>
                <p>{{ selectedStepRules.identity.emotional_core.join('、') }}</p>
              </div>
              <div v-if="selectedStepRules.identity.target_reader">
                <span class="text-base-content/50 text-xs">目标读者</span>
                <p>{{ selectedStepRules.identity.target_reader }}</p>
              </div>
              <ul v-if="selectedStepRules.decision_rules.length" class="list-disc list-inside text-xs space-y-0.5">
                <li v-for="(rule, i) in selectedStepRules.decision_rules" :key="i">{{ rule }}</li>
              </ul>
              <div v-if="selectedStepRules.pacing_rules.conflict_interval" class="text-xs text-base-content/70">
                冲突间隔 {{ selectedStepRules.pacing_rules.conflict_interval }} ·
                爽点间隔 {{ selectedStepRules.pacing_rules.payoff_interval || '—' }}
              </div>
              <ul v-if="selectedStepRules.quality_checklist.length" class="text-xs space-y-0.5 text-base-content/70">
                <li v-for="(item, i) in selectedStepRules.quality_checklist" :key="i">□ {{ item }}</li>
              </ul>
            </div>
          </section>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else class="flex flex-col items-center justify-center h-full text-base-content/40 gap-2 py-20">
        <font-awesome-icon icon="palette" class="text-4xl opacity-20" />
        <p class="text-sm">暂无文风，或点击左侧列表选择</p>
      </div>
    </main>
  </div>
</template>
