<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'

const props = defineProps<{ workId: number }>()

interface Anchor {
  id: number
  work_id: number
  type: string
  title: string
  content: string
  is_active: number
}

interface AnchorConflict {
  severity: 'warning' | 'error'
  message: string
  source: string
}

const anchors = ref<Anchor[]>([])
const anchorTypes = ['scene', 'character', 'plot', 'emotion', 'structure', 'memory', 'contrast'] as const
const anchorTypeLabels: Record<string, string> = {
  scene: '场景',
  character: '角色',
  plot: '情节',
  emotion: '情感',
  structure: '结构',
  memory: '记忆',
  contrast: '反差'
}

const newAnchor = ref({ type: 'scene', title: '', content: '' })
const showAnchorForm = ref(false)
const conflicts = ref<AnchorConflict[]>([])
const checkingConflict = ref(false)

const groupedAnchors = computed(() => {
  const groups: Record<string, Anchor[]> = {}
  for (const t of anchorTypes) groups[t] = []
  for (const a of anchors.value) {
    if (!groups[a.type]) groups[a.type] = []
    groups[a.type].push(a)
  }
  return groups
})

const activeCount = computed(() => anchors.value.filter(a => a.is_active).length)

onMounted(loadAnchors)

async function loadAnchors() {
  anchors.value = await window.anovel.invoke('anchor:listByWork', props.workId) as never[]
}

async function checkConflicts() {
  if (!newAnchor.value.title.trim() || !newAnchor.value.content.trim()) return
  checkingConflict.value = true
  try {
    conflicts.value = await window.anovel.invoke('anchor:checkConflict', props.workId, newAnchor.value) as AnchorConflict[]
  } finally {
    checkingConflict.value = false
  }
}

async function createAnchor() {
  if (!newAnchor.value.title.trim() || !newAnchor.value.content.trim()) return
  await checkConflicts()
  if (conflicts.value.some(c => c.severity === 'error')) {
    alert('存在严重冲突，请修改后重试')
    return
  }
  if (conflicts.value.length > 0 && !confirm(`检测到 ${conflicts.value.length} 条潜在冲突，仍要创建？`)) return
  await window.anovel.invoke('anchor:create', { ...newAnchor.value, work_id: props.workId })
  newAnchor.value = { type: 'scene', title: '', content: '' }
  conflicts.value = []
  showAnchorForm.value = false
  await loadAnchors()
}

async function toggleAnchor(id: number, active: boolean) {
  await window.anovel.invoke('anchor:toggleActive', id, active)
  await loadAnchors()
}

async function deleteAnchor(id: number) {
  if (!confirm('删除此锚点？')) return
  await window.anovel.invoke('anchor:delete', id)
  await loadAnchors()
}
</script>

<template>
  <div class="w-full min-w-0">
    <div class="flex items-center justify-between mb-4">
      <PanelTitle icon="anchor" title="锚点管理" no-margin />
      <div class="flex gap-2 text-xs">
        <span class="badge badge-neutral">共 {{ anchors.length }} 个</span>
        <span class="badge badge-primary">活跃 {{ activeCount }} 个</span>
      </div>
    </div>
    <p class="text-sm text-base-content/50 mb-6">
      锚点是贯穿创作全流程的「创作宪法」，确保 AI 不偏离核心方向。
      建议活跃锚点 ≤ 12 个，超出部分不会全部注入正文，以免叙事断片。
    </p>

    <div v-if="activeCount > 12" class="alert alert-warning text-sm py-2 mb-4">
      当前活跃锚点 {{ activeCount }} 个，超过建议上限 12。正文生成时仅注入优先级最高的 12 个，请禁用次要锚点。
    </div>

    <button class="btn btn-primary btn-sm mb-4 gap-1" @click="showAnchorForm = !showAnchorForm">
      <font-awesome-icon :icon="showAnchorForm ? 'times' : 'plus'" class="w-3 h-3" />
      {{ showAnchorForm ? '取消' : '新建锚点' }}
    </button>

    <div v-if="showAnchorForm" class="card bg-base-200 border border-base-300 shadow-sm p-4 mb-6">
      <select v-model="newAnchor.type" class="select select-bordered w-full mb-3">
        <option v-for="t in anchorTypes" :key="t" :value="t">{{ anchorTypeLabels[t] }}</option>
      </select>
      <input v-model="newAnchor.title" placeholder="锚点名称" class="input input-bordered w-full mb-3" @blur="checkConflicts" />
      <textarea
        v-model="newAnchor.content"
        rows="4"
        placeholder="锚点详细描述"
        class="textarea textarea-bordered w-full mb-3 resize-none"
        @blur="checkConflicts"
      />
      <div v-if="conflicts.length" class="alert alert-warning text-xs py-2 mb-3">
        <ul class="list-disc list-inside space-y-0.5">
          <li v-for="(c, i) in conflicts" :key="i">{{ c.message }}</li>
        </ul>
      </div>
      <div class="flex gap-2">
        <button
          class="btn btn-outline btn-sm"
          :disabled="checkingConflict"
          @click="checkConflicts"
        >
          {{ checkingConflict ? '检测中...' : '检测冲突' }}
        </button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="!newAnchor.title.trim() || !newAnchor.content.trim()"
          @click="createAnchor"
        >
          保存锚点
        </button>
      </div>
    </div>

    <div v-if="anchors.length === 0" class="text-center py-12 text-base-content/40">
      <font-awesome-icon icon="anchor" class="text-4xl mb-3 opacity-30" />
      <p>暂无锚点</p>
    </div>

    <div v-else class="space-y-6">
      <div v-for="t in anchorTypes" :key="t">
        <template v-if="groupedAnchors[t]?.length">
          <h4 class="text-sm font-semibold mb-2 flex items-center gap-2">
            <span>{{ anchorTypeLabels[t] }}</span>
            <span class="badge badge-ghost badge-sm">{{ groupedAnchors[t].length }}</span>
          </h4>
          <div class="space-y-2">
            <div
              v-for="anchor in groupedAnchors[t]"
              :key="anchor.id"
              :class="['card bg-base-200 border border-base-300 shadow-sm p-3', anchor.is_active ? '' : 'opacity-50']"
            >
              <div class="flex items-start justify-between mb-1">
                <h5 class="font-semibold text-sm">{{ anchor.title }}</h5>
                <div class="flex gap-1">
                  <button class="btn btn-ghost btn-xs gap-1" @click="toggleAnchor(anchor.id, !anchor.is_active)">
                    <font-awesome-icon :icon="anchor.is_active ? 'eye-slash' : 'eye'" class="w-3 h-3" />
                    {{ anchor.is_active ? '禁用' : '启用' }}
                  </button>
                  <button class="btn btn-ghost btn-xs text-error gap-1" @click="deleteAnchor(anchor.id)">
                    <font-awesome-icon icon="trash" class="w-3 h-3" />
                    删除
                  </button>
                </div>
              </div>
              <p class="text-sm text-base-content/50">{{ anchor.content }}</p>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
