<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

const props = defineProps<{ workId: number }>()
const emit = defineEmits<{ updated: [rules: string[]] }>()

interface Preset {
  label: string
  rule: string
  demo?: { before: string; after: string }
}

interface PresetGroup {
  name: string
  hint: string
  presets: Preset[]
}

const rules = ref<string[]>([])
const builtInPresets = ref<Preset[]>([])
const customPresets = ref<Preset[]>([])
const newRule = ref('')
const saving = ref(false)
const expanded = ref(false)
const previewPreset = ref<Preset | null>(null)
const editingIndex = ref<number | null>(null)
const editingText = ref('')

const showCustomEditor = ref(false)
const editingPreset = ref<{ label: string; rule: string; before: string; after: string } | null>(null)
const editingPresetIndex = ref<number | null>(null)

const presetGroups = computed<PresetGroup[]>(() => {
  const surfaceLabels = ['禁模板情感句', '修辞去陈词', '禁总结式段尾', '对话口语化']
  const surface = builtInPresets.value.filter(p => surfaceLabels.includes(p.label))
  const deep = builtInPresets.value.filter(p => !surfaceLabels.includes(p.label))
  const groups: PresetGroup[] = []
  if (surface.length) groups.push({ name: '表层去AI味', hint: '清除 AI 高频词和模板句式', presets: surface })
  if (deep.length) groups.push({ name: '深层反检测', hint: '针对 AI 检测器的统计特征（困惑度、突发性、修辞密度）', presets: deep })
  if (customPresets.value.length) groups.push({ name: '自定义预设', hint: '你添加的预设规则', presets: customPresets.value })
  return groups
})

const allPresets = computed(() => [...builtInPresets.value, ...customPresets.value])

onMounted(loadAll)

async function loadAll() {
  await Promise.all([loadRules(), loadPresets()])
}

async function loadRules() {
  rules.value = await window.anovel.invoke('setting:getAntiAiRules', props.workId) as string[]
}

async function loadPresets() {
  try {
    const data = await window.anovel.invoke('setting:getAllAntiAiPresets', props.workId) as {
      builtIn: Preset[]; custom: Preset[]
    }
    builtInPresets.value = data.builtIn
    customPresets.value = data.custom
  } catch { /* fallback: no presets */ }
}

async function persist(next: string[]) {
  saving.value = true
  try {
    rules.value = await window.anovel.invoke('setting:setAntiAiRules', props.workId, next) as string[]
    emit('updated', rules.value)
  } finally {
    saving.value = false
  }
}

async function addRule() {
  const text = newRule.value.trim()
  if (!text) return
  newRule.value = ''
  await persist([...rules.value, text])
}

async function addPreset(preset: Preset) {
  if (rules.value.includes(preset.rule)) return
  await persist([...rules.value, preset.rule])
}

async function removeRule(index: number) {
  if (editingIndex.value === index) cancelEdit()
  await persist(rules.value.filter((_, i) => i !== index))
}

function startEdit(index: number) {
  editingIndex.value = index
  editingText.value = rules.value[index]
}

function cancelEdit() {
  editingIndex.value = null
  editingText.value = ''
}

async function saveEdit() {
  const idx = editingIndex.value
  if (idx === null) return
  const text = editingText.value.trim()
  if (!text) return
  const next = [...rules.value]
  next[idx] = text
  cancelEdit()
  await persist(next)
}

function togglePreview(preset: Preset) {
  previewPreset.value = previewPreset.value === preset ? null : preset
}

function findDemo(rule: string): Preset['demo'] | undefined {
  return allPresets.value.find(p => p.rule === rule)?.demo
}

async function appendRules(incoming: string[]) {
  if (!incoming.length) return
  rules.value = await window.anovel.invoke('setting:appendAntiAiRules', props.workId, incoming) as string[]
  emit('updated', rules.value)
}

function openNewPreset() {
  editingPreset.value = { label: '', rule: '', before: '', after: '' }
  editingPresetIndex.value = null
  showCustomEditor.value = true
}

function openEditPreset(index: number) {
  const p = customPresets.value[index]
  editingPreset.value = {
    label: p.label,
    rule: p.rule,
    before: p.demo?.before ?? '',
    after: p.demo?.after ?? ''
  }
  editingPresetIndex.value = index
  showCustomEditor.value = true
}

function cancelPresetEdit() {
  showCustomEditor.value = false
  editingPreset.value = null
  editingPresetIndex.value = null
}

async function savePresetEdit() {
  if (!editingPreset.value) return
  const { label, rule, before, after } = editingPreset.value
  if (!label.trim() || !rule.trim()) return

  const preset: Preset = {
    label: label.trim(),
    rule: rule.trim(),
    ...(before.trim() || after.trim() ? { demo: { before: before.trim(), after: after.trim() } } : {})
  }

  const next = [...customPresets.value]
  if (editingPresetIndex.value !== null) {
    next[editingPresetIndex.value] = preset
  } else {
    next.push(preset)
  }

  saving.value = true
  try {
    customPresets.value = await window.anovel.invoke('setting:setCustomAntiAiPresets', props.workId, next) as Preset[]
  } finally {
    saving.value = false
  }
  cancelPresetEdit()
}

async function removeCustomPreset(index: number) {
  const next = customPresets.value.filter((_, i) => i !== index)
  saving.value = true
  try {
    customPresets.value = await window.anovel.invoke('setting:setCustomAntiAiPresets', props.workId, next) as Preset[]
  } finally {
    saving.value = false
  }
}

defineExpose({ reload: loadAll, appendRules })
</script>

<template>
  <div class="rounded-lg border border-base-300/70 bg-base-100/80 p-3">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-2 text-left"
      @click="expanded = !expanded"
    >
      <span class="text-xs font-medium text-base-content/70">
        去AI味强制规则
        <span v-if="rules.length" class="badge badge-primary badge-xs ml-1">{{ rules.length }}</span>
      </span>
      <font-awesome-icon :icon="expanded ? 'chevron-up' : 'chevron-down'" class="w-3 h-3 opacity-50" />
    </button>

    <div v-if="expanded" class="mt-3 space-y-3">
      <p class="text-xs text-base-content/45 leading-relaxed">
        规则会注入正文生成 system prompt 的<strong>开头高注意力区</strong>（优先级最高）。模型仍可能偶发违规，生成后会自动检测并提示。
      </p>

      <ul v-if="rules.length" class="space-y-1.5">
        <li
          v-for="(rule, idx) in rules"
          :key="idx"
          class="text-xs bg-base-200 rounded px-2 py-1.5"
        >
          <div class="flex items-start gap-2">
            <span class="text-base-content/30 shrink-0">{{ idx + 1 }}.</span>
            <template v-if="editingIndex === idx">
              <textarea
                v-model="editingText"
                rows="3"
                class="textarea textarea-bordered textarea-xs flex-1 min-h-0 text-xs leading-relaxed"
                @keyup.esc="cancelEdit"
              />
            </template>
            <span v-else class="flex-1 leading-relaxed">{{ rule }}</span>
            <div v-if="editingIndex === idx" class="flex flex-col gap-1 shrink-0">
              <button
                type="button"
                class="btn btn-primary btn-xs px-2 min-h-0 h-6"
                :disabled="saving || !editingText.trim()"
                @click="saveEdit"
              >
                保存
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-xs px-2 min-h-0 h-6"
                :disabled="saving"
                @click="cancelEdit"
              >
                取消
              </button>
            </div>
            <div v-else class="flex shrink-0 gap-0.5">
              <button
                type="button"
                class="btn btn-ghost btn-xs px-1 min-h-0 h-auto"
                title="编辑"
                :disabled="saving || editingIndex !== null"
                @click="startEdit(idx)"
              >
                <font-awesome-icon icon="edit" class="w-3 h-3" />
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-xs px-1 min-h-0 h-auto text-error"
                title="删除"
                :disabled="saving || editingIndex !== null"
                @click="removeRule(idx)"
              >
                &times;
              </button>
            </div>
          </div>
          <div v-if="editingIndex !== idx && findDemo(rule)" class="mt-1.5 ml-4 pl-2 border-l-2 border-base-300 space-y-0.5 text-[11px]">
            <p class="text-error/70 line-through decoration-error/30">{{ findDemo(rule)!.before }}</p>
            <p class="text-success/80">{{ findDemo(rule)!.after }}</p>
          </div>
        </li>
      </ul>
      <p v-else class="text-xs text-base-content/35 italic">尚未添加规则，可从下方预设快速添加</p>

      <div class="space-y-2">
        <div v-for="group in presetGroups" :key="group.name" class="space-y-1">
          <p class="text-[11px] font-medium text-base-content/50">
            {{ group.name }}
            <span class="font-normal text-base-content/30 ml-1">{{ group.hint }}</span>
          </p>
          <div class="flex flex-wrap gap-1">
            <template v-for="(preset, pIdx) in group.presets" :key="preset.label">
              <span class="inline-flex items-center gap-0.5">
                <button
                  type="button"
                  class="btn btn-outline btn-xs"
                  :class="rules.includes(preset.rule) ? 'btn-disabled opacity-40' : ''"
                  :disabled="saving || rules.includes(preset.rule)"
                  @click="addPreset(preset)"
                  @mouseenter="togglePreview(preset)"
                  @mouseleave="previewPreset = null"
                >
                  + {{ preset.label }}
                </button>
                <template v-if="group.name === '自定义预设'">
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs px-0.5 min-h-0 h-auto opacity-50 hover:opacity-100"
                    title="编辑预设"
                    @click="openEditPreset(pIdx)"
                  >
                    <font-awesome-icon icon="edit" class="w-2.5 h-2.5" />
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost btn-xs px-0.5 min-h-0 h-auto text-error/50 hover:text-error"
                    title="删除预设"
                    @click="removeCustomPreset(pIdx)"
                  >
                    <font-awesome-icon icon="times" class="w-2.5 h-2.5" />
                  </button>
                </template>
              </span>
            </template>
          </div>
        </div>
        <div
          v-if="previewPreset?.demo"
          class="rounded border border-base-300 bg-base-200/50 px-2 py-1.5 text-[11px] space-y-0.5 transition-all"
        >
          <p class="font-medium text-base-content/50">{{ previewPreset.label }} 示范</p>
          <p class="text-error/70 line-through decoration-error/30">{{ previewPreset.demo.before }}</p>
          <p class="text-success/80">{{ previewPreset.demo.after }}</p>
        </div>
      </div>

      <!-- 自定义预设编辑器 -->
      <div v-if="showCustomEditor" class="rounded border border-primary/30 bg-base-200/50 p-3 space-y-2">
        <p class="text-xs font-medium text-base-content/70">
          {{ editingPresetIndex !== null ? '编辑预设' : '新建自定义预设' }}
        </p>
        <div class="form-control">
          <input
            v-model="editingPreset!.label"
            type="text"
            class="input input-bordered input-xs"
            placeholder="预设名称，如：禁用感叹号堆叠"
          />
        </div>
        <div class="form-control">
          <textarea
            v-model="editingPreset!.rule"
            rows="2"
            class="textarea textarea-bordered textarea-xs text-xs leading-relaxed"
            placeholder="规则内容（将注入到 prompt 中）"
          />
        </div>
        <div class="grid grid-cols-2 gap-2">
          <div class="form-control">
            <label class="label py-0.5">
              <span class="label-text text-[11px] text-error/60">AI 腔示范（可选）</span>
            </label>
            <textarea
              v-model="editingPreset!.before"
              rows="2"
              class="textarea textarea-bordered textarea-xs text-[11px] leading-relaxed"
              placeholder="反面写法"
            />
          </div>
          <div class="form-control">
            <label class="label py-0.5">
              <span class="label-text text-[11px] text-success/60">人味示范（可选）</span>
            </label>
            <textarea
              v-model="editingPreset!.after"
              rows="2"
              class="textarea textarea-bordered textarea-xs text-[11px] leading-relaxed"
              placeholder="正确写法"
            />
          </div>
        </div>
        <div class="flex justify-end gap-1">
          <button type="button" class="btn btn-ghost btn-xs" @click="cancelPresetEdit">取消</button>
          <button
            type="button"
            class="btn btn-primary btn-xs"
            :disabled="!editingPreset?.label?.trim() || !editingPreset?.rule?.trim() || saving"
            @click="savePresetEdit"
          >
            {{ editingPresetIndex !== null ? '保存修改' : '添加预设' }}
          </button>
        </div>
      </div>

      <div class="flex gap-1">
        <input
          v-model="newRule"
          type="text"
          class="input input-bordered input-xs flex-1"
          placeholder="自定义规则，如：禁止用「在这个…」开头"
          @keyup.enter="addRule"
        />
        <button type="button" class="btn btn-primary btn-xs" :disabled="!newRule.trim() || saving" @click="addRule">
          添加
        </button>
        <button type="button" class="btn btn-outline btn-xs" :disabled="saving || showCustomEditor" @click="openNewPreset">
          新建预设
        </button>
      </div>
    </div>
  </div>
</template>
