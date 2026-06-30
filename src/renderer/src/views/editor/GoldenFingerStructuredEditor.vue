<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
import {
  EMPTY_GOLDEN_FINGER,
  normalizeGoldenFinger,
  parseGoldenFingerFromMarkdown,
  renderGoldenFingerMarkdown,
  goldenFingerValidationIssues,
  extractGoldenFingerFromAiContent,
  mergeGoldenFinger,
  type GoldenFingerStructured
} from '../../../../shared/golden-finger-types'
import SettingAssistantPanel from './SettingAssistantPanel.vue'

const props = defineProps<{ workId: number }>()
const emit = defineEmits<{
  (e: 'saved'): void
  (e: 'cancel'): void
}>()

const gf = ref<GoldenFingerStructured>(normalizeGoldenFinger({}))
const loading = ref(false)
const saving = ref(false)
const saveSuccess = ref(false)
const editorRef = ref<HTMLElement | null>(null)

const leftPanelRatio = ref(55)
const isResizingHorizontal = ref(false)
let horizontalResizeStart = { x: 0, ratio: 55 }

const issues = computed(() => goldenFingerValidationIssues(gf.value))
const renderedMarkdown = computed(() => renderGoldenFingerMarkdown(gf.value))

function startHorizontalResize(event: MouseEvent) {
  event.preventDefault()
  isResizingHorizontal.value = true
  horizontalResizeStart = { x: event.clientX, ratio: leftPanelRatio.value }
  window.addEventListener('mousemove', onHorizontalResize)
  window.addEventListener('mouseup', stopHorizontalResize)
}

function onHorizontalResize(event: MouseEvent) {
  if (!isResizingHorizontal.value || !editorRef.value) return
  const rect = editorRef.value.getBoundingClientRect()
  const dx = event.clientX - horizontalResizeStart.x
  const ratioDelta = (dx / rect.width) * 100
  leftPanelRatio.value = Math.max(30, Math.min(75, horizontalResizeStart.ratio + ratioDelta))
}

function stopHorizontalResize() {
  isResizingHorizontal.value = false
  window.removeEventListener('mousemove', onHorizontalResize)
  window.removeEventListener('mouseup', stopHorizontalResize)
}

async function load() {
  loading.value = true
  try {
    const raw = await window.anovel.invoke('setting:getStructured', props.workId, 'golden_finger') as Partial<GoldenFingerStructured> | null
    if (raw) {
      gf.value = normalizeGoldenFinger(raw)
      return
    }
    const settings = await window.anovel.invoke('setting:listByWork', props.workId) as { type: string; content: string }[]
    const markdown = settings.find(s => s.type === 'golden_finger')?.content?.trim() ?? ''
    gf.value = markdown ? parseGoldenFingerFromMarkdown(markdown) : normalizeGoldenFinger({})
  } catch {
    gf.value = normalizeGoldenFinger({})
  } finally {
    loading.value = false
  }
}

onMounted(load)

watch(() => props.workId, load)

function addAbility() {
  if (gf.value.abilities.length >= 5) return
  gf.value.abilities.push({ name: '', effect: '', scope: '' })
}

function removeAbility(idx: number) {
  gf.value.abilities.splice(idx, 1)
  if (gf.value.abilities.length === 0) gf.value.abilities.push({ name: '', effect: '', scope: '' })
}

function addUpgrade() {
  if (gf.value.upgrades.length >= 6) return
  gf.value.upgrades.push({ stage: '', condition: '', unlocks: '' })
}

function removeUpgrade(idx: number) {
  gf.value.upgrades.splice(idx, 1)
  if (gf.value.upgrades.length === 0) gf.value.upgrades.push({ stage: '', condition: '', unlocks: '' })
}

async function save() {
  saving.value = true
  try {
    const markdown = renderedMarkdown.value
    const payload = JSON.parse(JSON.stringify(gf.value))
    await window.anovel.invoke(
      'setting:upsertStructured',
      props.workId,
      'golden_finger',
      markdown,
      payload
    )
    saveSuccess.value = true
    setTimeout(() => { saveSuccess.value = false }, 2000)
    emit('saved')
  } finally {
    saving.value = false
  }
}

function reset() {
  gf.value = normalizeGoldenFinger({})
}

function onApplySuggestion(text: string) {
  const trimmed = text.trim()
  if (!trimmed) return
  const extracted = extractGoldenFingerFromAiContent(trimmed)
  if (extracted?.structured) {
    gf.value = mergeGoldenFinger(gf.value, extracted.structured)
  }
}

async function onSlotApplied() {
  await load()
}

const jsonImportOpen = ref(false)
const jsonImportText = ref('')
const jsonImportMode = ref<'merge' | 'replace'>('merge')
const jsonImportError = ref('')
const jsonImportPreview = ref<GoldenFingerStructured | null>(null)
const jsonImportFields = ref<string[]>([])

const FIELD_LABELS: Record<string, string> = {
  nameAndForm: '名称形态', abilities: '核心能力', acquisition: '获取方式',
  limit: '限制条件', backlash: '反噬机制', upgrades: '升级路径',
  infoAdvantage: '信息差', sideEffects: '副作用', forbiddenScenes: '禁用场景',
  tagline: '一句话卖点', firstPayoffScene: '首次爽点', visualMetric: '可视化指标'
}

function openJsonImport() {
  jsonImportOpen.value = true
  jsonImportText.value = ''
  jsonImportMode.value = 'merge'
  jsonImportError.value = ''
  jsonImportPreview.value = null
  jsonImportFields.value = []
}

function parseJsonImport() {
  jsonImportError.value = ''
  jsonImportPreview.value = null
  jsonImportFields.value = []
  const trimmed = jsonImportText.value.trim()
  if (!trimmed) {
    jsonImportError.value = '请粘贴 JSON 内容'
    return
  }
  const result = extractGoldenFingerFromAiContent(trimmed)
  if (!result) {
    jsonImportError.value = '无法解析为有效的金手指 JSON 数据'
    return
  }
  const hasContent = Object.values(result.structured).some(v => {
    if (typeof v === 'string') return v.trim().length > 0
    if (Array.isArray(v)) return v.some(item => Object.values(item).some(x => typeof x === 'string' && x.trim().length > 0))
    if (v && typeof v === 'object') return Object.values(v).some(x => typeof x === 'string' && x.trim().length > 0)
    return false
  })
  if (!hasContent) {
    jsonImportError.value = '解析成功但所有字段为空，可能字段名不匹配（需使用英文字段名如 nameAndForm、abilities 等）'
    return
  }
  jsonImportPreview.value = result.structured
  jsonImportFields.value = Object.entries(result.structured)
    .filter(([, v]) => {
      if (typeof v === 'string') return v.trim().length > 0
      if (Array.isArray(v)) return v.length > 0
      if (v && typeof v === 'object') return Object.values(v).some(x => typeof x === 'string' && x.trim().length > 0)
      return false
    })
    .map(([k]) => FIELD_LABELS[k] ?? k)
}

function confirmJsonImport() {
  if (!jsonImportPreview.value) {
    parseJsonImport()
  }
  if (!jsonImportPreview.value) {
    return
  }
  if (jsonImportMode.value === 'replace') {
    gf.value = normalizeGoldenFinger(jsonImportPreview.value)
  } else {
    gf.value = mergeGoldenFinger(gf.value, jsonImportPreview.value)
  }
  jsonImportOpen.value = false
}
</script>

<template>
  <div ref="editorRef" class="flex flex-col h-full p-5">
    <div v-if="loading" class="text-sm text-base-content/50 shrink-0">加载中...</div>

    <div class="flex items-center justify-between shrink-0 mb-3">
      <h4 class="font-semibold text-sm">金手指结构化编辑</h4>
      <div class="flex gap-2">
        <button type="button" class="btn btn-outline btn-accent btn-xs gap-1" @click="openJsonImport">
          <font-awesome-icon icon="braces" class="w-3 h-3" />
          从 JSON 导入
        </button>
      </div>
    </div>

    <div class="flex-1 min-h-0 flex overflow-hidden">
      <div class="min-h-0 overflow-y-auto pr-1 space-y-3" :style="{ width: `${leftPanelRatio}%` }">
        <div class="alert alert-warning text-xs py-2">
          <div v-if="issues.length">
            <p class="font-medium mb-1">未填必填项：</p>
            <ul class="list-disc list-inside space-y-0.5">
              <li v-for="(issue, i) in issues" :key="i">{{ issue }}</li>
            </ul>
          </div>
          <p v-else>所有必填项已填写。</p>
        </div>

        <div v-if="saveSuccess" class="alert alert-success text-xs py-2">
          已保存到金手指设定。
        </div>

        <div class="space-y-3">
          <label class="form-control">
            <span class="label-text text-xs font-medium">番茄一句话卖点 *</span>
            <input v-model="gf.tagline" type="text" class="input input-bordered input-sm w-full" placeholder="让读者3秒看懂：签到流！开局一个亿！末世空间囤货！" />
          </label>

          <label class="form-control">
            <span class="label-text text-xs font-medium">名称与形态 *</span>
            <input v-model="gf.nameAndForm" type="text" class="input input-bordered input-sm w-full" placeholder="金手指叫什么、外在表现形式" />
          </label>

          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-medium">核心能力 *</span>
              <button type="button" class="btn btn-ghost btn-xs" @click="addAbility">+ 添加</button>
            </div>
            <div v-for="(ability, idx) in gf.abilities" :key="idx" class="card bg-base-200 p-2 mb-2">
              <div class="grid grid-cols-1 gap-2">
                <input v-model="ability.name" type="text" class="input input-bordered input-sm" placeholder="能力名" />
                <textarea v-model="ability.effect" class="textarea textarea-bordered textarea-sm" placeholder="具体效果" rows="2" />
                <input v-model="ability.scope" type="text" class="input input-bordered input-sm" placeholder="作用范围（可选）" />
              </div>
              <button type="button" class="btn btn-ghost btn-xs text-error mt-1" @click="removeAbility(idx)">删除</button>
            </div>
          </div>

          <label class="form-control">
            <span class="label-text text-xs font-medium">获取方式与觉醒条件 *</span>
            <textarea v-model="gf.acquisition" class="textarea textarea-bordered textarea-sm" rows="2" placeholder="主角如何获得金手指、第一次激活需要什么条件" />
          </label>

          <div class="card bg-base-200 p-3">
            <p class="text-xs font-medium mb-2">限制条件 *（至少填一项）</p>
            <div class="grid grid-cols-2 gap-2">
              <label class="form-control">
                <span class="label-text text-xs">冷却/间隔</span>
                <input v-model="gf.limit.cooldown" type="text" class="input input-bordered input-sm" placeholder="如：24小时/每章一次" />
              </label>
              <label class="form-control">
                <span class="label-text text-xs">消耗</span>
                <input v-model="gf.limit.cost" type="text" class="input input-bordered input-sm" placeholder="如：100点能量/寿命-1天" />
              </label>
              <label class="form-control">
                <span class="label-text text-xs">次数/容量上限</span>
                <input v-model="gf.limit.usageLimit" type="text" class="input input-bordered input-sm" placeholder="如：每日3次/背包100格" />
              </label>
              <label class="form-control">
                <span class="label-text text-xs">失效场景</span>
                <input v-model="gf.limit.invalidScenes" type="text" class="input input-bordered input-sm" placeholder="如：敌对势力结界内/情绪失控时" />
              </label>
            </div>
          </div>

          <label class="form-control">
            <span class="label-text text-xs font-medium">反噬/代价机制 *</span>
            <textarea v-model="gf.backlash" class="textarea textarea-bordered textarea-sm" rows="2" placeholder="使用过度或违反规则的真实后果" />
          </label>

          <label class="form-control">
            <span class="label-text text-xs font-medium">信息差优势 *</span>
            <textarea v-model="gf.infoAdvantage" class="textarea textarea-bordered textarea-sm" rows="2" placeholder="主角知道而别人不知道什么？读者是否先知？" />
          </label>

          <div>
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-medium">升级路径</span>
              <button type="button" class="btn btn-ghost btn-xs" @click="addUpgrade">+ 添加</button>
            </div>
            <div v-for="(upgrade, idx) in gf.upgrades" :key="idx" class="card bg-base-200 p-2 mb-2">
              <div class="grid grid-cols-1 gap-2">
                <input v-model="upgrade.stage" type="text" class="input input-bordered input-sm" placeholder="阶段名（如：Lv.1 / 入门）" />
                <input v-model="upgrade.condition" type="text" class="input input-bordered input-sm" placeholder="升级条件" />
                <input v-model="upgrade.unlocks" type="text" class="input input-bordered input-sm" placeholder="解锁能力" />
              </div>
              <button type="button" class="btn btn-ghost btn-xs text-error mt-1" @click="removeUpgrade(idx)">删除</button>
            </div>
          </div>

          <label class="form-control">
            <span class="label-text text-xs font-medium">副作用/负面绑定</span>
            <textarea v-model="gf.sideEffects" class="textarea textarea-bordered textarea-sm" rows="2" placeholder="与主角缺陷、世界观规则的冲突点" />
          </label>

          <label class="form-control">
            <span class="label-text text-xs font-medium">禁用/红线场景</span>
            <textarea v-model="gf.forbiddenScenes" class="textarea textarea-bordered textarea-sm" rows="2" placeholder="绝对不能做的事，做了必出 bug" />
          </label>

          <div class="card bg-base-200 p-3">
            <p class="text-xs font-medium mb-2 text-primary">可视化限制指标（番茄核心） *</p>
            <div class="grid grid-cols-2 gap-2">
              <label class="form-control">
                <span class="label-text text-xs">当前等级/阶段 *</span>
                <input v-model="gf.visualMetric.currentLevel" type="text" class="input input-bordered input-sm" placeholder="如：Lv.1 新手" />
              </label>
              <label class="form-control">
                <span class="label-text text-xs">每次使用消耗 *</span>
                <input v-model="gf.visualMetric.costPerUse" type="text" class="input input-bordered input-sm" placeholder="如：10点精神力" />
              </label>
              <label class="form-control">
                <span class="label-text text-xs">冷却时间 *</span>
                <input v-model="gf.visualMetric.cooldown" type="text" class="input input-bordered input-sm" placeholder="如：6小时" />
              </label>
              <label class="form-control">
                <span class="label-text text-xs">使用次数上限 *</span>
                <input v-model="gf.visualMetric.usageCap" type="text" class="input input-bordered input-sm" placeholder="如：每日5次" />
              </label>
              <label class="form-control col-span-2">
                <span class="label-text text-xs">进度条形态</span>
                <input v-model="gf.visualMetric.progressBar" type="text" class="input input-bordered input-sm" placeholder="如：经验条/积分/能量槽/签到天数" />
              </label>
              <label class="form-control col-span-2">
                <span class="label-text text-xs">越级/失效后果 *</span>
                <input v-model="gf.visualMetric.failureScene" type="text" class="input input-bordered input-sm" placeholder="如：强行使用会昏迷12小时" />
              </label>
            </div>
          </div>

          <label class="form-control">
            <span class="label-text text-xs font-medium">前三章首次爽点场景 *</span>
            <textarea v-model="gf.firstPayoffScene" class="textarea textarea-bordered textarea-sm" rows="3" placeholder="具体写出触发事件、金手指如何发挥作用、读者爽感来源" />
          </label>
        </div>

        <div class="border-t border-base-300 pt-3">
          <p class="text-xs font-medium mb-2">Markdown 预览</p>
          <div class="bg-base-200 rounded-lg p-3 text-xs whitespace-pre-wrap max-h-48 overflow-y-auto">{{ renderedMarkdown }}</div>
        </div>
      </div>

      <div
        class="w-1.5 shrink-0 cursor-col-resize flex items-center justify-center hover:bg-primary/30 active:bg-primary/50 transition-colors"
        title="拖动调整左右宽度"
        @mousedown="startHorizontalResize"
      >
        <div class="w-0.5 h-8 rounded-full bg-base-content/20" />
      </div>

      <div class="flex-1 min-h-0 border-l border-base-300 pl-4 flex flex-col">
        <SettingAssistantPanel
          :work-id="workId"
          setting-type="golden_finger"
          setting-label="金手指系统"
          position="right"
          @apply-suggestion="onApplySuggestion"
          @slot-applied="onSlotApplied"
        />
      </div>
    </div>

    <div class="flex justify-end gap-2 pt-3 border-t border-base-300 shrink-0">
      <button type="button" class="btn btn-ghost btn-sm" @click="reset">清空</button>
      <button type="button" class="btn btn-ghost btn-sm" @click="emit('cancel')">取消</button>
      <button type="button" class="btn btn-primary btn-sm" :disabled="saving" @click="save">
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </div>

    <div
      v-if="jsonImportOpen"
      class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      @click.self="jsonImportOpen = false"
    >
        <div class="modal-box max-w-2xl w-full max-h-[85vh] flex flex-col p-0">
          <div class="flex items-center justify-between gap-4 px-5 py-3 border-b border-base-300 shrink-0">
            <h3 class="font-bold text-base">从 JSON 导入金手指</h3>
            <button type="button" class="btn btn-ghost btn-xs btn-square" @click="jsonImportOpen = false">
              <font-awesome-icon icon="times" class="w-3 h-3" />
            </button>
          </div>

          <div class="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-3">
            <p class="text-xs text-base-content/50">
              粘贴 AI 输出的 JSON（支持代码块包裹或裸 JSON），系统会自动解析并映射字段。中文字段名也会自动兼容。
            </p>

            <textarea
              v-model="jsonImportText"
              rows="10"
              class="textarea textarea-bordered w-full text-xs font-mono leading-relaxed"
              placeholder='粘贴 JSON 内容，例如：
{
  "nameAndForm": "签到系统",
  "abilities": [{ "name": "每日签到", "effect": "获得随机奖励", "scope": "每日一次" }],
  ...
}'
              @input="jsonImportPreview = null; jsonImportError = ''; jsonImportFields = []"
              @paste="setTimeout(() => parseJsonImport(), 50)"
            />

            <div v-if="jsonImportError" class="alert alert-error text-xs py-2">
              <font-awesome-icon icon="exclamation-circle" class="w-3 h-3" />
              {{ jsonImportError }}
            </div>

            <div v-if="jsonImportPreview" class="alert alert-success text-xs py-2">
              <div>
                <p class="font-medium mb-1">解析成功！已识别字段：</p>
                <div class="flex flex-wrap gap-1">
                  <span v-for="f in jsonImportFields" :key="f" class="badge badge-success badge-xs">{{ f }}</span>
                </div>
              </div>
            </div>

            <div class="form-control">
              <label class="label cursor-pointer">
                <span class="label-text text-xs">合并模式（仅更新非空字段，保留已有内容）</span>
                <input v-model="jsonImportMode" type="radio" value="merge" class="radio radio-primary radio-xs" />
              </label>
              <label class="label cursor-pointer">
                <span class="label-text text-xs">替换模式（用 JSON 内容完全覆盖当前数据）</span>
                <input v-model="jsonImportMode" type="radio" value="replace" class="radio radio-primary radio-xs" />
              </label>
            </div>
          </div>

          <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-base-300 shrink-0">
            <button type="button" class="btn btn-ghost btn-sm" @click="jsonImportOpen = false">取消</button>
            <button type="button" class="btn btn-outline btn-sm" @click="parseJsonImport">
              <font-awesome-icon icon="braces" class="w-3 h-3" />
              解析
            </button>
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="!jsonImportText.trim()"
              @click="jsonImportPreview ? confirmJsonImport() : parseJsonImport()"
            >
              {{ jsonImportPreview ? '确认导入' : '解析并导入' }}
            </button>
          </div>
        </div>
    </div>
  </div>
</template>
