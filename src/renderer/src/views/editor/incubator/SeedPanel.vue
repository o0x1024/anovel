<script setup lang="ts">
import { inject, ref, watch, onBeforeUnmount, type Ref } from 'vue'
import { incubatorSeedTextKey, incubatorStateKey } from './incubator-context'

const emit = defineEmits<{ saved: [] }>()

const incubator = inject(incubatorStateKey)!
const seedText = inject(incubatorSeedTextKey) as Ref<string>

const saveState = ref<'idle' | 'saving' | 'saved'>('idle')
let timer: ReturnType<typeof setTimeout> | null = null
let skipNextWatch = false

const predefinedTags = [
  '重生', '穿越', '系统', '丧尸', '女频', '脑洞', '末世', '玄幻', '仙侠', '都市', '甜宠', '虐恋',
  '西方奇幻', '东方仙侠', '科幻末世', '都市日常', '都市修真', '都市高武', '历史古代', '战神赘婿', '都市种田', 
  '传统玄幻', '历史脑洞', '悬疑脑洞', '都市脑洞', '玄幻脑洞', '悬疑灵异', '抗战谍战', '游戏体育', '动漫衍生', 
  '男频衍生', '古风世情', '女频衍生', '玄幻言情', '种田', '年代', '现言脑洞', '宫斗宅斗', '古言脑洞', '快穿', 
  '青春甜宠', '星光璀璨', '女频悬疑', '职场婚恋', '豪门总裁', '民国言情'
]
const selectedTags = ref<string[]>([])
const newTagInput = ref('')
const ideaText = ref('')
const showAllTags = ref(false)

function parseSeedText(raw: string) {
  const match = raw.match(/^【题材标签】：(.*)\n【核心想法】：\n([\s\S]*)$/)
  if (match) {
    selectedTags.value = match[1].split('、').filter(Boolean).map(s => s.trim())
    ideaText.value = match[2].trim()
  } else {
    selectedTags.value = []
    ideaText.value = raw.trim()
  }
}

function buildSeedText(): string {
  const tagsStr = selectedTags.value.join('、')
  const ideaStr = ideaText.value.trim()
  if (!tagsStr && !ideaStr) return ''
  return `【题材标签】：${tagsStr}\n【核心想法】：\n${ideaStr}`
}

function toggleTag(tag: string) {
  const idx = selectedTags.value.indexOf(tag)
  if (idx > -1) {
    selectedTags.value.splice(idx, 1)
  } else {
    selectedTags.value.push(tag)
  }
  updateSeedFromLocalState()
}

function addCustomTag() {
  const t = newTagInput.value.trim()
  if (t && !selectedTags.value.includes(t)) {
    selectedTags.value.push(t)
  }
  newTagInput.value = ''
  updateSeedFromLocalState()
}

function removeTag(tag: string) {
  const idx = selectedTags.value.indexOf(tag)
  if (idx > -1) {
    selectedTags.value.splice(idx, 1)
    updateSeedFromLocalState()
  }
}

function updateSeedFromLocalState() {
  const combined = buildSeedText()
  if (seedText.value !== combined) {
    seedText.value = combined
  }
}

function schedulePersist() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void persist(seedText.value), 800)
}

watch(
  () => seedText.value,
  (newVal) => {
    if (skipNextWatch) return
    const localCombined = buildSeedText()
    if (newVal !== localCombined) {
      parseSeedText(newVal)
    }
    schedulePersist()
  }
)

async function persist(content: string) {
  const trimmed = content.trim()
  saveState.value = 'saving'
  try {
    await incubator.setSeed(trimmed)
    saveState.value = 'saved'
    emit('saved')
    setTimeout(() => {
      if (saveState.value === 'saved') saveState.value = 'idle'
    }, 2000)
  } catch {
    saveState.value = 'idle'
  }
}

/** 父组件载入作品数据时调用，避免触发重复保存 */
function setSeedFromLoad(value: string) {
  skipNextWatch = true
  seedText.value = value
  parseSeedText(value)
  queueMicrotask(() => {
    skipNextWatch = false
  })
}

defineExpose({ setSeedFromLoad })

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  if (seedText.value.trim()) void persist(seedText.value)
})
</script>

<template>
  <div class="card bg-base-200 border border-base-300 shadow-sm p-4">
    <div class="flex items-center justify-between gap-2 mb-2 flex-wrap">
      <label class="text-xs font-medium text-base-content/60">创作种子（稳定保留）</label>
      <span v-if="incubator.workspace" class="badge badge-outline badge-sm">
        {{ incubator.workspace.state }}
      </span>
    </div>

    <div class="mb-3 space-y-2">
      <div class="flex items-center justify-between">
        <div class="text-xs text-base-content/70 font-medium">题材类型</div>
        <button 
          type="button" 
          class="btn btn-ghost btn-xs text-base-content/50 hover:bg-base-300 px-1.5 h-6 min-h-0" 
          @click="showAllTags = !showAllTags"
        >
          {{ showAllTags ? '收起' : '展开全部' }}
          <font-awesome-icon :icon="showAllTags ? 'chevron-up' : 'chevron-down'" class="w-2.5 h-2.5 ml-0.5" />
        </button>
      </div>
      <div class="flex flex-wrap gap-2 items-center" :class="{ 'max-h-9 overflow-hidden': !showAllTags }">
        <div
          v-for="tag in predefinedTags"
          :key="tag"
          class="badge badge-sm cursor-pointer select-none py-2.5 px-3 transition-colors"
          :class="selectedTags.includes(tag) ? 'badge-primary' : 'badge-outline hover:badge-primary hover:bg-opacity-20 hover:text-primary'"
          @click="toggleTag(tag)"
        >
          {{ tag }}
        </div>
      </div>
      <div class="flex flex-wrap gap-2 items-center mt-1">
        <div
          v-for="tag in selectedTags.filter(t => !predefinedTags.includes(t))"
          :key="tag"
          class="badge badge-sm badge-primary cursor-pointer select-none py-2.5 px-3 flex items-center gap-1"
          @click="removeTag(tag)"
        >
          {{ tag }}
          <font-awesome-icon icon="times" class="w-3 h-3 opacity-60 hover:opacity-100" />
        </div>
        <input
          v-model="newTagInput"
          @keydown.enter.prevent="addCustomTag"
          @blur="addCustomTag"
          type="text"
          placeholder="自定义标签 (回车添加)"
          class="input input-bordered input-xs w-36 h-7 text-xs"
        />
      </div>
    </div>

    <div class="text-xs text-base-content/70 font-medium mb-1">一句话想法</div>
    <textarea
      v-model="ideaText"
      rows="3"
      class="textarea textarea-bordered w-full mb-2 resize-none text-sm leading-relaxed"
      placeholder="主角是谁、面对什么、最想写什么…"
      @input="updateSeedFromLocalState"
      @blur="persist(seedText)"
    />
    
    <p class="text-xs text-base-content/40 min-h-[1rem]">
      <span v-if="saveState === 'saving'">正在保存...</span>
      <span v-else-if="saveState === 'saved'" class="text-success">已保存</span>
      <span v-else-if="seedText.trim()">编辑后自动保存</span>
    </p>
  </div>
</template>
