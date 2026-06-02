<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import MarkdownContent from '../../components/MarkdownContent.vue'
import type { AssistantRoleRow } from '../../../../shared/assistant-types'

const ICON_OPTIONS = [
  'robot', 'palette', 'feather-alt', 'book-open', 'brain', 'lightbulb', 'pen-nib', 'anchor'
]

const CAPABILITY_LABELS: Record<string, string> = {
  style_export: '文风分析卡片',
  summary_export: '作品导读卡片'
}

const roles = ref<AssistantRoleRow[]>([])
const loading = ref(true)
const selectedId = ref<number | null>(null)
const panelMode = ref<'detail' | 'create' | 'edit'>('detail')
const form = ref(emptyForm())
const saving = ref(false)

const emit = defineEmits<{
  changed: []
}>()

function emptyForm() {
  return {
    name: '',
    description: '',
    icon: 'robot',
    system_prompt: '',
    rulesText: '',
    capabilities: [] as string[]
  }
}

const selectedRole = computed(() =>
  roles.value.find(r => r.id === selectedId.value) ?? null
)

onMounted(() => { void refresh(true) })

watch(roles, (list) => {
  if (list.length === 0) {
    selectedId.value = null
    panelMode.value = 'detail'
    return
  }
  if (selectedId.value && !list.some(r => r.id === selectedId.value)) {
    selectedId.value = list[0]?.id ?? null
  }
  if (!selectedId.value && list.length) {
    selectedId.value = list[0].id
  }
})

async function refresh(silent = false) {
  loading.value = true
  try {
    roles.value = await window.anovel.invoke('assistant:roleList') as AssistantRoleRow[]
  } finally {
    loading.value = false
  }
  if (!silent) emit('changed')
}

defineExpose({ refresh })

function selectRole(role: AssistantRoleRow) {
  selectedId.value = role.id
  panelMode.value = 'detail'
}

function openCreate() {
  selectedId.value = null
  panelMode.value = 'create'
  form.value = emptyForm()
}

function openEdit(role?: AssistantRoleRow) {
  const target = role ?? selectedRole.value
  if (!target) return
  selectedId.value = target.id
  panelMode.value = 'edit'
  fillForm(target)
}

function fillForm(role: AssistantRoleRow) {
  const rules: string[] = role.analysis_rules_json ? JSON.parse(role.analysis_rules_json) : []
  const caps: string[] = role.capabilities_json ? JSON.parse(role.capabilities_json) : []
  form.value = {
    name: role.name,
    description: role.description ?? '',
    icon: role.icon,
    system_prompt: role.system_prompt,
    rulesText: rules.join('\n'),
    capabilities: [...caps]
  }
}

function cancelForm() {
  panelMode.value = 'detail'
  if (!selectedId.value && roles.value.length) {
    selectedId.value = roles.value[0].id
  }
}

async function save() {
  if (!form.value.name.trim() || !form.value.system_prompt.trim()) return
  saving.value = true
  try {
    const rules = form.value.rulesText.split('\n').map(s => s.trim()).filter(Boolean)
    const payload = {
      name: form.value.name.trim(),
      description: form.value.description.trim() || undefined,
      icon: form.value.icon,
      system_prompt: form.value.system_prompt.trim(),
      analysis_rules_json: rules.length ? JSON.stringify(rules) : null,
      capabilities_json: JSON.stringify(form.value.capabilities)
    }
    if (panelMode.value === 'edit' && selectedId.value) {
      await window.anovel.invoke('assistant:roleUpdate', selectedId.value, payload)
    } else {
      const id = await window.anovel.invoke('assistant:roleCreate', payload) as number
      selectedId.value = id
    }
    panelMode.value = 'detail'
    await refresh()
  } finally {
    saving.value = false
  }
}

async function resetBuiltin(role: AssistantRoleRow) {
  if (!role.is_builtin) return
  if (!confirm(`将「${role.name}」恢复为出厂默认配置？`)) return
  try {
    await window.anovel.invoke('assistant:roleResetBuiltin', role.id)
    await refresh()
    panelMode.value = 'detail'
  } catch (e) {
    alert(e instanceof Error ? e.message : '恢复失败')
  }
}

async function cloneRole(role: AssistantRoleRow) {
  const name = prompt('新角色名称', `${role.name}（副本）`)
  if (!name?.trim()) return
  const id = await window.anovel.invoke('assistant:roleClone', role.id, name.trim()) as number
  await refresh()
  selectedId.value = id
  panelMode.value = 'detail'
}

async function deleteRole(role: AssistantRoleRow) {
  if (role.is_builtin) return
  if (!confirm(`删除角色「${role.name}」？`)) return
  await window.anovel.invoke('assistant:roleDelete', role.id)
  await refresh()
  panelMode.value = 'detail'
}

function toggleCapability(value: string) {
  const idx = form.value.capabilities.indexOf(value)
  if (idx >= 0) form.value.capabilities.splice(idx, 1)
  else form.value.capabilities.push(value)
}

function parseRules(json: string | null): string[] {
  if (!json) return []
  try { return JSON.parse(json) } catch { return [] }
}

function parseCapabilities(json: string | null): string[] {
  if (!json) return []
  try { return JSON.parse(json) } catch { return [] }
}

function capabilityLabel(cap: string) {
  return CAPABILITY_LABELS[cap] ?? cap
}
</script>

<template>
  <div class="flex h-full min-h-0">
    <!-- 左侧角色列表 -->
    <aside class="w-72 shrink-0 border-r border-base-300 flex flex-col min-h-0 bg-base-200/30">
      <div class="p-4 border-b border-base-300 shrink-0">
        <h2 class="font-bold text-sm">角色列表</h2>
        <p class="text-xs text-base-content/40 mt-0.5">点击角色查看详情</p>
        <button type="button" class="btn btn-primary btn-sm btn-block mt-3 gap-1" @click="openCreate">
          <font-awesome-icon icon="plus" class="w-3 h-3" />
          新建角色
        </button>
      </div>

      <div v-if="loading" class="flex-1 flex items-center justify-center">
        <span class="loading loading-spinner loading-sm" />
      </div>

      <ul v-else class="menu menu-sm flex-1 overflow-y-auto p-2 gap-0.5">
        <li v-for="role in roles" :key="role.id">
          <button
            type="button"
            class="flex items-center gap-2"
            :class="{ 'menu-active': selectedId === role.id }"
            @click="selectRole(role)"
          >
            <font-awesome-icon :icon="role.icon" class="w-3.5 h-3.5 opacity-70 shrink-0" />
            <span class="flex-1 truncate text-left">{{ role.name }}</span>
            <span v-if="role.is_builtin" class="badge badge-primary badge-xs shrink-0">内置</span>
          </button>
        </li>
      </ul>
    </aside>

    <!-- 右侧详情 / 编辑 -->
    <main class="flex-1 min-w-0 overflow-y-auto scrollbar-thin">
      <!-- 新建 / 编辑表单 -->
      <div v-if="panelMode === 'create' || panelMode === 'edit'" class="p-6 lg:p-8 max-w-3xl">
        <h2 class="text-xl font-bold mb-1">
          {{ panelMode === 'edit' ? (selectedRole?.is_builtin ? '编辑内置角色' : '编辑角色') : '新建角色' }}
        </h2>
        <p v-if="selectedRole?.is_builtin && panelMode === 'edit'" class="text-xs text-base-content/40 mb-4">
          内置角色可自由修改；若改乱可恢复默认。改名后恢复需改回出厂名称。
        </p>
        <p v-else class="text-xs text-base-content/40 mb-4">配置角色人格、解析规则与输出能力</p>

        <div class="space-y-3">
          <input v-model="form.name" class="input input-bordered input-sm w-full" placeholder="角色名称" />
          <input v-model="form.description" class="input input-bordered input-sm w-full" placeholder="简短描述" />
          <div>
            <label class="text-xs text-base-content/50">图标</label>
            <select v-model="form.icon" class="select select-bordered select-sm w-full mt-1">
              <option v-for="icon in ICON_OPTIONS" :key="icon" :value="icon">{{ icon }}</option>
            </select>
          </div>
          <div>
            <label class="text-xs text-base-content/50">系统提示词</label>
            <textarea
              v-model="form.system_prompt"
              class="textarea textarea-bordered w-full mt-1 min-h-40 font-mono text-xs"
              placeholder="角色人设与输出规范…"
            />
          </div>
          <div>
            <label class="text-xs text-base-content/50">解析规则（每行一条）</label>
            <textarea
              v-model="form.rulesText"
              class="textarea textarea-bordered w-full mt-1 min-h-24 text-xs"
            />
          </div>
          <div>
            <label class="text-xs text-base-content/50 mb-1 block">能力</label>
            <div class="flex flex-wrap gap-3">
              <label
                v-for="(label, value) in CAPABILITY_LABELS"
                :key="value"
                class="label cursor-pointer gap-2 py-0"
              >
                <input
                  type="checkbox"
                  class="checkbox checkbox-sm"
                  :checked="form.capabilities.includes(value)"
                  @change="toggleCapability(value)"
                />
                <span class="label-text text-sm">{{ label }}</span>
              </label>
            </div>
          </div>
          <div class="flex gap-2 pt-2">
            <button type="button" class="btn btn-primary btn-sm" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </button>
            <button type="button" class="btn btn-ghost btn-sm" @click="cancelForm">取消</button>
          </div>
        </div>
      </div>

      <!-- 详情预览 -->
      <div v-else-if="selectedRole" class="p-6 lg:p-8">
        <div class="flex items-start justify-between gap-4 mb-6">
          <div class="flex items-start gap-4 min-w-0">
            <div class="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
              <font-awesome-icon :icon="selectedRole.icon" class="w-5 h-5" />
            </div>
            <div class="min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <h2 class="text-xl font-bold">{{ selectedRole.name }}</h2>
                <span v-if="selectedRole.is_builtin" class="badge badge-primary badge-sm">内置</span>
                <span v-else class="badge badge-success badge-sm">自定义</span>
              </div>
              <div v-if="selectedRole.description" class="mt-1 text-base-content/70">
                <MarkdownContent :content="selectedRole.description" />
              </div>
              <p v-else class="text-sm text-base-content/50 mt-1">暂无描述</p>
              <div class="flex flex-wrap gap-1 mt-2">
                <span
                  v-for="cap in parseCapabilities(selectedRole.capabilities_json)"
                  :key="cap"
                  class="badge badge-outline badge-sm"
                >
                  {{ capabilityLabel(cap) }}
                </span>
                <span
                  v-if="!parseCapabilities(selectedRole.capabilities_json).length"
                  class="text-xs text-base-content/30"
                >
                  无结构化输出能力（纯对话）
                </span>
              </div>
            </div>
          </div>
          <div class="flex flex-wrap gap-1 shrink-0 justify-end">
            <button type="button" class="btn btn-primary btn-sm" @click="openEdit()">编辑</button>
            <button type="button" class="btn btn-ghost btn-sm" @click="cloneRole(selectedRole)">克隆</button>
            <button
              v-if="selectedRole.is_builtin"
              type="button"
              class="btn btn-outline btn-sm"
              @click="resetBuiltin(selectedRole)"
            >
              恢复默认
            </button>
            <button
              v-if="!selectedRole.is_builtin"
              type="button"
              class="btn btn-ghost btn-sm text-error"
              @click="deleteRole(selectedRole)"
            >
              删除
            </button>
          </div>
        </div>

        <div class="space-y-5">
          <section>
            <h3 class="text-xs font-bold text-base-content/40 uppercase tracking-wider mb-2">系统提示词</h3>
            <div class="bg-base-200 border border-base-300 rounded-lg p-4">
              <MarkdownContent :content="selectedRole.system_prompt" />
            </div>
          </section>

          <section v-if="parseRules(selectedRole.analysis_rules_json).length">
            <h3 class="text-xs font-bold text-base-content/40 uppercase tracking-wider mb-2">解析规则</h3>
            <ul class="space-y-1.5">
              <li
                v-for="(rule, idx) in parseRules(selectedRole.analysis_rules_json)"
                :key="idx"
                class="bg-base-200 border border-base-300 rounded-lg px-3 py-2"
              >
                <MarkdownContent :content="rule" size="xs" />
              </li>
            </ul>
          </section>

          <section class="text-xs text-base-content/30">
            更新于 {{ new Date(selectedRole.update_time + 'Z').toLocaleString('zh-CN') }}
          </section>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else class="flex flex-col items-center justify-center h-full text-base-content/40 gap-2 py-20">
        <font-awesome-icon icon="robot" class="text-4xl opacity-20" />
        <p class="text-sm">暂无角色，或点击左侧列表选择</p>
      </div>
    </main>
  </div>
</template>
