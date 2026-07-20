<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  HUMAN_REWRITE_AI_SYMPTOMS,
  HUMAN_REWRITE_AI_SYMPTOM_LABELS,
  HUMAN_REWRITE_SCENE_LABELS,
  HUMAN_REWRITE_SCENE_TYPES,
  type HumanRewriteAiSymptom,
  type HumanRewriteReference,
  type HumanRewriteReferenceInput,
  type HumanRewriteSceneType
} from '../../../../shared/human-rewrite-reference-types'

interface ReferenceForm {
  title: string
  sceneTypes: HumanRewriteSceneType[]
  aiSymptoms: HumanRewriteAiSymptom[]
  originalText: string
  rewrittenText: string
  rewritePrinciplesText: string
  preservedFactsText: string
  forbiddenChangesText: string
  enabled: boolean
  priority: number
}

interface ReferencePresetInfo {
  id: string
  name: string
  description: string
  sourceTitle: string
  count: number
}

const references = ref<HumanRewriteReference[]>([])
const loading = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const editingId = ref<number | null>(null)
const formOpen = ref(false)
const presetList = ref<ReferencePresetInfo[]>([])
const importingPreset = ref<string | null>(null)
const importMessage = ref('')

function emptyForm(): ReferenceForm {
  return {
    title: '',
    sceneTypes: [],
    aiSymptoms: [],
    originalText: '',
    rewrittenText: '',
    rewritePrinciplesText: '',
    preservedFactsText: '',
    forbiddenChangesText: '',
    enabled: true,
    priority: 50
  }
}

const form = reactive<ReferenceForm>(emptyForm())
const enabledCount = computed(() => references.value.filter(item => item.enabled).length)

function splitLines(text: string): string[] {
  return text.split('\n').map(item => item.trim()).filter(Boolean)
}

function assignForm(value: ReferenceForm): void {
  Object.assign(form, value)
}

async function loadReferences(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    references.value = await window.anovel.invoke('lab:rewrite-reference:list') as HumanRewriteReference[]
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '加载案例库失败'
  } finally {
    loading.value = false
  }
}

async function loadPresets(): Promise<void> {
  presetList.value = await window.anovel.invoke(
    'lab:rewrite-reference:list-presets'
  ) as ReferencePresetInfo[]
}

async function importPreset(preset: ReferencePresetInfo): Promise<void> {
  importingPreset.value = preset.id
  errorMessage.value = ''
  importMessage.value = ''
  try {
    const result = await window.anovel.invoke(
      'lab:rewrite-reference:import-preset', preset.id
    ) as { imported: number; skipped: number }
    importMessage.value = result.imported > 0
      ? `已导入 ${result.imported} 条“${preset.sourceTitle}”改写案例${result.skipped > 0 ? `，跳过 ${result.skipped} 条重复` : ''}`
      : `${result.skipped} 条案例均已存在，无需重复导入`
    await loadReferences()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '导入案例预设失败'
  } finally {
    importingPreset.value = null
  }
}

function openCreate(): void {
  editingId.value = null
  assignForm(emptyForm())
  formOpen.value = true
  errorMessage.value = ''
}

function openEdit(reference: HumanRewriteReference): void {
  editingId.value = reference.id
  assignForm({
    title: reference.title,
    sceneTypes: [...reference.sceneTypes],
    aiSymptoms: [...reference.aiSymptoms],
    originalText: reference.originalText,
    rewrittenText: reference.rewrittenText,
    rewritePrinciplesText: reference.rewritePrinciples.join('\n'),
    preservedFactsText: reference.preservedFacts.join('\n'),
    forbiddenChangesText: reference.forbiddenChanges.join('\n'),
    enabled: reference.enabled,
    priority: reference.priority
  })
  formOpen.value = true
  errorMessage.value = ''
}

function closeForm(): void {
  formOpen.value = false
  editingId.value = null
  errorMessage.value = ''
}

function toggleSceneType(type: HumanRewriteSceneType): void {
  if (form.sceneTypes.includes(type)) {
    form.sceneTypes = form.sceneTypes.filter(item => item !== type)
    return
  }
  if (form.sceneTypes.length >= 2) {
    errorMessage.value = '每条案例最多选择 2 个场景类型'
    return
  }
  errorMessage.value = ''
  form.sceneTypes = [...form.sceneTypes, type]
}

function toggleAiSymptom(symptom: HumanRewriteAiSymptom): void {
  if (form.aiSymptoms.includes(symptom)) {
    form.aiSymptoms = form.aiSymptoms.filter(item => item !== symptom)
    return
  }
  if (form.aiSymptoms.length >= 3) {
    errorMessage.value = '每条案例最多选择 3 个 AI 痕迹'
    return
  }
  errorMessage.value = ''
  form.aiSymptoms = [...form.aiSymptoms, symptom]
}

function buildInput(): HumanRewriteReferenceInput {
  return {
    title: form.title.trim(),
    sceneTypes: [...form.sceneTypes],
    aiSymptoms: [...form.aiSymptoms],
    originalText: form.originalText.trim(),
    rewrittenText: form.rewrittenText.trim(),
    rewritePrinciples: splitLines(form.rewritePrinciplesText),
    preservedFacts: splitLines(form.preservedFactsText),
    forbiddenChanges: splitLines(form.forbiddenChangesText),
    enabled: form.enabled,
    priority: form.priority
  }
}

async function saveReference(): Promise<void> {
  saving.value = true
  errorMessage.value = ''
  try {
    const input = buildInput()
    if (editingId.value === null) {
      await window.anovel.invoke('lab:rewrite-reference:create', input)
    } else {
      await window.anovel.invoke('lab:rewrite-reference:update', editingId.value, input)
    }
    closeForm()
    await loadReferences()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '保存案例失败'
  } finally {
    saving.value = false
  }
}

async function toggleEnabled(reference: HumanRewriteReference): Promise<void> {
  try {
    await window.anovel.invoke('lab:rewrite-reference:toggle', reference.id, !reference.enabled)
    reference.enabled = !reference.enabled
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '更新案例失败'
  }
}

async function deleteReference(reference: HumanRewriteReference): Promise<void> {
  if (!confirm(`删除案例“${reference.title}”？`)) return
  try {
    await window.anovel.invoke('lab:rewrite-reference:delete', reference.id)
    if (editingId.value === reference.id) closeForm()
    await loadReferences()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '删除案例失败'
  }
}

onMounted(() => {
  void Promise.all([loadReferences(), loadPresets()])
})
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto pr-1">
    <div class="sticky top-0 z-10 bg-base-100 pb-2">
      <div class="flex items-center gap-2 flex-wrap">
        <button type="button" class="btn btn-primary btn-xs" @click="openCreate">
          <font-awesome-icon icon="plus" class="w-3 h-3" />
          添加改写案例
        </button>
        <button
          v-for="preset in presetList"
          :key="preset.id"
          type="button"
          class="btn btn-secondary btn-xs"
          :disabled="importingPreset !== null"
          :title="preset.description"
          @click="importPreset(preset)"
        >
          <span v-if="importingPreset === preset.id" class="loading loading-spinner loading-xs" />
          <font-awesome-icon v-else icon="book-open" class="w-3 h-3" />
          导入{{ preset.name }}（{{ preset.count }}条）
        </button>
        <span class="text-xs text-base-content/50">
          {{ enabledCount }}/{{ references.length }} 条启用
        </span>
      </div>
      <p class="mt-1 text-xs text-base-content/55">
        案例用于教 AI 如何把特定 AI 痕迹改成人类表达。场景与 AI 痕迹必须同时匹配，案例才会进入改写上下文。
      </p>
      <p v-if="errorMessage" class="mt-1 text-xs text-error">{{ errorMessage }}</p>
      <p v-if="importMessage" class="mt-1 text-xs text-success">{{ importMessage }}</p>
    </div>

    <section v-if="formOpen" class="rounded-xl border border-primary/25 bg-base-200/45 p-3 mb-3 space-y-3">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold">{{ editingId === null ? '新增人工化改写案例' : '编辑人工化改写案例' }}</h2>
        <span class="text-[11px] text-base-content/45">每行一条原则或约束</span>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_7rem] gap-2">
        <label class="form-control">
          <span class="label-text text-xs mb-1">案例名称</span>
          <input v-model="form.title" class="input input-bordered input-sm" placeholder="如：删除对话前镜头链" />
        </label>
        <label class="form-control">
          <span class="label-text text-xs mb-1">优先级</span>
          <input v-model.number="form.priority" type="number" min="0" max="100" class="input input-bordered input-sm" />
        </label>
      </div>

      <div>
        <div class="text-xs font-medium mb-1">场景类型</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="type in HUMAN_REWRITE_SCENE_TYPES"
            :key="type"
            type="button"
            class="btn btn-xs"
            :class="form.sceneTypes.includes(type) ? 'btn-primary' : 'btn-ghost border border-base-300'"
            @click="toggleSceneType(type)"
          >{{ HUMAN_REWRITE_SCENE_LABELS[type] }}</button>
        </div>
      </div>

      <div>
        <div class="text-xs font-medium mb-1">针对的 AI 痕迹</div>
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="symptom in HUMAN_REWRITE_AI_SYMPTOMS"
            :key="symptom"
            type="button"
            class="btn btn-xs"
            :class="form.aiSymptoms.includes(symptom) ? 'btn-secondary' : 'btn-ghost border border-base-300'"
            @click="toggleAiSymptom(symptom)"
          >{{ HUMAN_REWRITE_AI_SYMPTOM_LABELS[symptom] }}</button>
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-2">
        <label class="form-control">
          <span class="label-text text-xs mb-1">改写前</span>
          <textarea v-model="form.originalText" class="textarea textarea-bordered min-h-36 text-sm leading-relaxed" placeholder="粘贴带有 AI 痕迹的原文…" />
        </label>
        <label class="form-control">
          <span class="label-text text-xs mb-1">人类改写后</span>
          <textarea v-model="form.rewrittenText" class="textarea textarea-bordered min-h-36 text-sm leading-relaxed" placeholder="粘贴你认可的人类改写结果…" />
        </label>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-2">
        <label class="form-control">
          <span class="label-text text-xs mb-1">改写原则</span>
          <textarea v-model="form.rewritePrinciplesText" class="textarea textarea-bordered min-h-24 text-xs" placeholder="删除说话前的镜头链&#10;用有关系含义的动作承载情绪" />
        </label>
        <label class="form-control">
          <span class="label-text text-xs mb-1">必须保留</span>
          <textarea v-model="form.preservedFactsText" class="textarea textarea-bordered min-h-24 text-xs" placeholder="人物关系不变&#10;台词核心意图不变" />
        </label>
        <label class="form-control">
          <span class="label-text text-xs mb-1">禁止变化</span>
          <textarea v-model="form.forbiddenChangesText" class="textarea textarea-bordered min-h-24 text-xs" placeholder="不得增加新事实&#10;不得复制案例原句" />
        </label>
      </div>

      <div class="flex items-center gap-2">
        <label class="flex items-center gap-1.5 text-xs cursor-pointer">
          <input v-model="form.enabled" type="checkbox" class="checkbox checkbox-xs checkbox-primary" />
          启用
        </label>
        <button type="button" class="btn btn-primary btn-sm ml-auto" :disabled="saving" @click="saveReference">
          <span v-if="saving" class="loading loading-spinner loading-xs" />
          保存案例
        </button>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="saving" @click="closeForm">取消</button>
      </div>
    </section>

    <div v-if="loading" class="py-10 text-center text-xs text-base-content/50">加载中…</div>
    <div v-else-if="references.length === 0" class="py-12 text-center text-sm text-base-content/50">
      <p>还没有人工化改写案例</p>
      <p class="mt-1 text-xs">添加“改写前 → 人类改写后”的成对案例后，才能使用案例增强模式。</p>
    </div>
    <div v-else class="space-y-2 pb-2">
      <article
        v-for="reference in references"
        :key="reference.id"
        class="rounded-xl border border-base-300 bg-base-100 p-3"
        :class="{ 'opacity-55': !reference.enabled }"
      >
        <div class="flex items-start gap-2">
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 flex-wrap">
              <h3 class="text-sm font-semibold">{{ reference.title }}</h3>
              <span class="badge badge-ghost badge-xs">优先级 {{ reference.priority }}</span>
              <span v-if="!reference.enabled" class="badge badge-warning badge-xs">已停用</span>
            </div>
            <div class="mt-1 flex flex-wrap gap-1">
              <span v-for="type in reference.sceneTypes" :key="type" class="badge badge-primary badge-outline badge-xs">
                {{ HUMAN_REWRITE_SCENE_LABELS[type] }}
              </span>
              <span v-for="symptom in reference.aiSymptoms" :key="symptom" class="badge badge-secondary badge-outline badge-xs">
                {{ HUMAN_REWRITE_AI_SYMPTOM_LABELS[symptom] }}
              </span>
            </div>
          </div>
          <button type="button" class="btn btn-ghost btn-xs" @click="toggleEnabled(reference)">
            {{ reference.enabled ? '停用' : '启用' }}
          </button>
          <button type="button" class="btn btn-ghost btn-xs" @click="openEdit(reference)">编辑</button>
          <button type="button" class="btn btn-ghost btn-xs text-error" @click="deleteReference(reference)">删除</button>
        </div>

        <div class="grid grid-cols-1 lg:grid-cols-2 gap-2 mt-2 text-xs leading-relaxed">
          <div class="rounded-lg bg-error/5 border border-error/10 p-2 whitespace-pre-wrap">
            <div class="font-medium text-error/75 mb-1">改写前</div>{{ reference.originalText }}
          </div>
          <div class="rounded-lg bg-success/5 border border-success/10 p-2 whitespace-pre-wrap">
            <div class="font-medium text-success/75 mb-1">人类改写后</div>{{ reference.rewrittenText }}
          </div>
        </div>
        <div class="mt-2 text-[11px] text-base-content/60">
          <span class="font-medium">改写原则：</span>{{ reference.rewritePrinciples.join('；') }}
        </div>
      </article>
    </div>
  </div>
</template>
