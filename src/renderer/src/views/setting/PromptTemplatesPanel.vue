<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface PromptTemplateInfo {
  key: string
  category: string
  label: string
  builtinVersion: number
  builtinText: string
  userText: string | null
  description: string | null
  variables: string[]
  riskLevel: string
  isCustomized: boolean
}

const CATEGORY_META: Record<string, { label: string; icon: string; color: string }> = {
  body: { label: '正文生成', icon: 'pen-nib', color: 'text-primary' },
  outline: { label: '大纲规划', icon: 'sitemap', color: 'text-secondary' },
  quality: { label: '质量检查', icon: 'magnifying-glass', color: 'text-accent' },
  lab: { label: '实验室', icon: 'flask', color: 'text-warning' },
  tool: { label: '工具', icon: 'screwdriver-wrench', color: 'text-info' },
  internal: { label: '内部', icon: 'lock', color: 'text-base-content/50' }
}

/** 各模板 key 对应图标（未列出的回退到分类图标） */
const TEMPLATE_ICONS: Record<string, string> = {
  'body_generation.system': 'pen-nib',
  'body_generation.continuity_rule': 'link',
  'body_generation.human_writing_meta': 'feather-alt',
  'body_style_rewrite.system': 'rotate',
  'ai_trace_polish.system': 'eraser',
  'quality_diagnosis_ai.system': 'stethoscope',
  'quality_apply_fixes.system': 'wand-magic-sparkles',
  'lab_deai.system': 'flask',
  'debate_fusion.system': 'code'
}

function templateIcon(tpl: PromptTemplateInfo): string {
  return TEMPLATE_ICONS[tpl.key] ?? CATEGORY_META[tpl.category]?.icon ?? 'file-lines'
}

function templateIconColor(tpl: PromptTemplateInfo): string {
  return CATEGORY_META[tpl.category]?.color ?? 'text-base-content/50'
}

const templates = ref<PromptTemplateInfo[]>([])
const loading = ref(true)
const editing = ref<string | null>(null)
const editText = ref('')
const saving = ref(false)
const searchQuery = ref('')
const filterCategory = ref<string | null>(null)
const confirmResetKey = ref<string | null>(null)
const confirmResetAll = ref(false)
const resettingKey = ref<string | null>(null)
const resettingAll = ref(false)

const confirmResetTemplate = computed(() =>
  templates.value.find(t => t.key === confirmResetKey.value) ?? null
)

const categories = computed(() => {
  const cats = new Set(templates.value.map(t => t.category))
  return [...cats].sort()
})

const filteredTemplates = computed(() => {
  let list = templates.value
  if (filterCategory.value) {
    list = list.filter(t => t.category === filterCategory.value)
  }
  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(t =>
      t.label.toLowerCase().includes(q) ||
      t.key.toLowerCase().includes(q) ||
      (t.description ?? '').toLowerCase().includes(q)
    )
  }
  return list
})

const groupedTemplates = computed(() => {
  const groups: Record<string, PromptTemplateInfo[]> = {}
  for (const t of filteredTemplates.value) {
    if (!groups[t.category]) groups[t.category] = []
    groups[t.category].push(t)
  }
  return groups
})

const customizedCount = computed(() => templates.value.filter(t => t.isCustomized).length)

async function load() {
  loading.value = true
  try {
    templates.value = await window.anovel.invoke('prompt:list') as PromptTemplateInfo[]
  } finally {
    loading.value = false
  }
}

function startEdit(t: PromptTemplateInfo) {
  editing.value = t.key
  editText.value = t.userText ?? t.builtinText
}

function cancelEdit() {
  editing.value = null
  editText.value = ''
}

async function saveEdit(key: string) {
  saving.value = true
  try {
    const tpl = templates.value.find(t => t.key === key)
    const text = editText.value.trim() === tpl?.builtinText.trim() ? null : editText.value
    await window.anovel.invoke('prompt:setUserText', key, text)
    await load()
    editing.value = null
  } finally {
    saving.value = false
  }
}

function requestResetOne(key: string) {
  confirmResetKey.value = key
}

async function resetOne(key: string) {
  resettingKey.value = key
  try {
    await window.anovel.invoke('prompt:resetToDefault', key)
    if (editing.value === key) {
      editing.value = null
      editText.value = ''
    }
    confirmResetKey.value = null
    await load()
  } finally {
    resettingKey.value = null
  }
}

async function resetAll() {
  resettingAll.value = true
  try {
    await window.anovel.invoke('prompt:resetAll')
    editing.value = null
    editText.value = ''
    confirmResetAll.value = false
    await load()
  } finally {
    resettingAll.value = false
  }
}

function effectiveText(t: PromptTemplateInfo): string {
  return t.userText ?? t.builtinText
}

onMounted(load)
</script>

<template>
  <div class="space-y-4">
    <div class="mb-2">
      <h3 class="text-xl font-bold">Prompt 模板管理</h3>
      <p class="text-sm text-base-content/50 mt-1">
        查看和自定义 AI 生成使用的所有提示词模板。修改后立即生效，可随时重置为内置默认值。
      </p>
    </div>

    <!-- 概览 -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      <div class="stat bg-base-100 border border-base-300/60 rounded-xl shadow-sm">
        <div class="stat-figure text-primary">
          <font-awesome-icon icon="file-lines" class="text-2xl" />
        </div>
        <div class="stat-title text-xs uppercase tracking-wider opacity-60">模板总数</div>
        <div class="stat-value text-base">{{ templates.length }}</div>
      </div>
      <div class="stat bg-base-100 border border-base-300/60 rounded-xl shadow-sm">
        <div class="stat-figure text-warning">
          <font-awesome-icon icon="pen" class="text-2xl" />
        </div>
        <div class="stat-title text-xs uppercase tracking-wider opacity-60">已自定义</div>
        <div class="stat-value text-base">{{ customizedCount }}</div>
      </div>
      <div class="stat bg-base-100 border border-base-300/60 rounded-xl shadow-sm">
        <div class="stat-figure text-secondary">
          <font-awesome-icon icon="layer-group" class="text-2xl" />
        </div>
        <div class="stat-title text-xs uppercase tracking-wider opacity-60">分类数</div>
        <div class="stat-value text-base">{{ categories.length }}</div>
      </div>
    </div>

    <!-- 工具栏 -->
    <div class="card bg-base-100 shadow-sm border border-base-300/60">
      <div class="card-body p-4">
        <div class="flex flex-wrap items-center gap-3">
          <!-- 搜索 -->
          <div class="form-control flex-1 min-w-[200px]">
            <label class="input input-bordered input-sm flex items-center gap-2">
              <font-awesome-icon icon="magnifying-glass" class="opacity-40" />
              <input
                v-model="searchQuery"
                type="text"
                placeholder="搜索模板名称或关键词…"
                class="grow bg-transparent"
              />
            </label>
          </div>

          <!-- 分类筛选 -->
          <div class="flex items-center gap-1">
            <button
              class="btn btn-xs"
              :class="filterCategory === null ? 'btn-primary' : 'btn-ghost'"
              @click="filterCategory = null"
            >全部</button>
            <button
              v-for="cat in categories" :key="cat"
              class="btn btn-xs"
              :class="filterCategory === cat ? 'btn-primary' : 'btn-ghost'"
              @click="filterCategory = cat"
            >
              <font-awesome-icon :icon="CATEGORY_META[cat]?.icon ?? 'tag'" class="text-xs mr-1" />
              {{ CATEGORY_META[cat]?.label ?? cat }}
            </button>
          </div>

          <!-- 一键恢复默认 -->
          <button
            v-if="templates.length > 0"
            class="btn btn-xs btn-outline btn-error"
            :class="{ loading: resettingAll }"
            :disabled="resettingAll || loading"
            @click="confirmResetAll = true"
          >
            <font-awesome-icon v-if="!resettingAll" icon="rotate-left" class="mr-1" />
            一键恢复默认
            <span v-if="customizedCount > 0" class="badge badge-error badge-xs ml-1">{{ customizedCount }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 加载态 -->
    <div v-if="loading" class="flex justify-center py-12">
      <span class="loading loading-spinner loading-md"></span>
    </div>

    <!-- 空态 -->
    <div v-else-if="filteredTemplates.length === 0" class="text-center py-12 text-base-content/40">
      <font-awesome-icon icon="inbox" class="text-4xl mb-3" />
      <p>{{ searchQuery || filterCategory ? '没有匹配的模板' : '暂无 Prompt 模板' }}</p>
    </div>

    <!-- 模板列表（按分类分组） -->
    <template v-else>
      <div v-for="(items, cat) in groupedTemplates" :key="cat" class="space-y-2">
        <h4 class="text-sm font-semibold text-base-content/70 flex items-center gap-2 mt-2">
          <font-awesome-icon
            :icon="CATEGORY_META[cat]?.icon ?? 'tag'"
            :class="CATEGORY_META[cat]?.color ?? 'text-base-content/50'"
          />
          {{ CATEGORY_META[cat]?.label ?? cat }}
          <span class="badge badge-ghost badge-xs">{{ items.length }}</span>
        </h4>

        <div
          v-for="tpl in items" :key="tpl.key"
          class="card bg-base-100 shadow-sm border border-base-300/60"
        >
          <div class="card-body p-4">
            <!-- 标题行 -->
            <div class="flex items-start justify-between gap-2">
              <div class="flex-1 min-w-0 flex items-start gap-3">
                <div
                  class="w-9 h-9 rounded-lg bg-base-200 flex items-center justify-center shrink-0"
                  :class="templateIconColor(tpl)"
                >
                  <font-awesome-icon :icon="templateIcon(tpl)" class="text-base" />
                </div>
                <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="font-medium">{{ tpl.label }}</span>
                  <span
                    v-if="tpl.isCustomized"
                    class="badge badge-warning badge-xs"
                  >已自定义</span>
                  <span class="badge badge-ghost badge-xs font-mono">{{ tpl.key }}</span>
                </div>
                <p v-if="tpl.description" class="text-xs text-base-content/50 mt-1">
                  {{ tpl.description }}
                </p>
                </div>
              </div>
              <div class="flex items-center gap-1 shrink-0">
                <button
                  v-if="editing !== tpl.key"
                  class="btn btn-xs btn-ghost"
                  @click="startEdit(tpl)"
                >
                  <font-awesome-icon icon="pen-to-square" />
                  编辑
                </button>
                <button
                  v-if="editing !== tpl.key"
                  class="btn btn-xs btn-outline"
                  :class="tpl.isCustomized ? 'btn-error' : 'btn-ghost'"
                  :disabled="resettingKey === tpl.key"
                  :title="tpl.isCustomized ? '清除自定义内容，恢复为内置默认' : '当前已是内置默认，点击可确认恢复'"
                  @click="requestResetOne(tpl.key)"
                >
                  <font-awesome-icon
                    icon="rotate-left"
                    class="mr-0.5"
                    :spin="resettingKey === tpl.key"
                  />
                  恢复默认
                </button>
              </div>
            </div>

            <!-- 查看模式：显示当前有效文本 -->
            <div v-if="editing !== tpl.key" class="mt-2">
              <pre class="text-xs bg-base-200/50 p-3 rounded-lg whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-mono leading-relaxed">{{ effectiveText(tpl) }}</pre>
            </div>

            <!-- 编辑模式 -->
            <div v-else class="mt-2 space-y-3">
              <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
                <div>
                  <label class="text-xs font-medium text-base-content/60 mb-1 block">内置默认</label>
                  <pre class="text-xs bg-base-200/30 p-3 rounded-lg whitespace-pre-wrap break-words max-h-60 overflow-y-auto font-mono leading-relaxed border border-base-300/40">{{ tpl.builtinText }}</pre>
                </div>
                <div>
                  <label class="text-xs font-medium text-base-content/60 mb-1 block">自定义内容</label>
                  <textarea
                    v-model="editText"
                    class="textarea textarea-bordered w-full font-mono text-xs leading-relaxed min-h-[15rem] max-h-[24rem]"
                    placeholder="留空则使用内置默认值"
                  ></textarea>
                </div>
              </div>
              <div class="flex items-center justify-between gap-2">
                <button
                  class="btn btn-xs btn-outline btn-error"
                  :class="{ loading: resettingKey === tpl.key }"
                  :disabled="saving || resettingKey === tpl.key"
                  @click="requestResetOne(tpl.key)"
                >
                  <font-awesome-icon v-if="resettingKey !== tpl.key" icon="rotate-left" class="mr-1" />
                  恢复默认
                </button>
                <div class="flex items-center gap-2">
                  <button class="btn btn-xs btn-ghost" :disabled="saving" @click="cancelEdit">取消</button>
                  <button
                    class="btn btn-xs btn-primary"
                    :class="{ loading: saving }"
                    :disabled="saving || resettingKey === tpl.key"
                    @click="saveEdit(tpl.key)"
                  >
                    <font-awesome-icon icon="check" class="mr-1" />
                    保存
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 恢复默认确认弹窗（单条） -->
    <dialog :open="confirmResetKey !== null" class="modal modal-bottom sm:modal-middle">
      <div class="modal-box">
        <h3 class="text-lg font-bold">恢复默认</h3>
        <p class="py-4 text-sm text-base-content/70">
          <template v-if="confirmResetTemplate?.isCustomized">
            将「<strong>{{ confirmResetTemplate.label }}</strong>」恢复为内置默认值？当前自定义内容将被清除。
          </template>
          <template v-else>
            「<strong>{{ confirmResetTemplate?.label ?? confirmResetKey }}</strong>」当前已是内置默认。确认执行恢复操作（无变更）。
          </template>
        </p>
        <p class="text-xs font-mono text-base-content/40 -mt-2 pb-2">{{ confirmResetKey }}</p>
        <div class="modal-action">
          <button class="btn btn-sm btn-ghost" :disabled="!!resettingKey" @click="confirmResetKey = null">取消</button>
          <button
            class="btn btn-sm btn-error"
            :class="{ loading: !!resettingKey }"
            :disabled="!!resettingKey"
            @click="resetOne(confirmResetKey!)"
          >
            确认恢复
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button type="button" :disabled="!!resettingKey" @click="confirmResetKey = null">close</button>
      </form>
    </dialog>

    <!-- 一键恢复默认确认弹窗 -->
    <dialog :open="confirmResetAll" class="modal modal-bottom sm:modal-middle">
      <div class="modal-box">
        <h3 class="text-lg font-bold text-error">一键恢复默认</h3>
        <p class="py-4 text-sm text-base-content/70">
          <template v-if="customizedCount > 0">
            将全部 <strong>{{ templates.length }}</strong> 个模板恢复为内置默认值？
            其中 <strong>{{ customizedCount }}</strong> 个含自定义内容，恢复后将被清除。
          </template>
          <template v-else>
            将全部 <strong>{{ templates.length }}</strong> 个模板恢复为内置默认值。当前均无自定义内容，执行后无变更。
          </template>
        </p>
        <div class="modal-action">
          <button class="btn btn-sm btn-ghost" :disabled="resettingAll" @click="confirmResetAll = false">取消</button>
          <button
            class="btn btn-sm btn-error"
            :class="{ loading: resettingAll }"
            :disabled="resettingAll"
            @click="resetAll"
          >
            确认全部恢复
          </button>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button type="button" :disabled="resettingAll" @click="confirmResetAll = false">close</button>
      </form>
    </dialog>
  </div>
</template>
