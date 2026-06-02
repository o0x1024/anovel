<script setup lang="ts">
import { ref, onMounted } from 'vue'

const props = defineProps<{ workId: number }>()

const rules = ref<string[]>([])
const newRule = ref('')
const saving = ref(false)
const expanded = ref(false)

onMounted(loadRules)

async function loadRules() {
  rules.value = await window.anovel.invoke('setting:getConditionRules', props.workId) as string[]
}

async function saveRules() {
  saving.value = true
  try {
    rules.value = await window.anovel.invoke('setting:setConditionRules', props.workId, rules.value) as string[]
  } finally {
    saving.value = false
  }
}

async function addRule() {
  const text = newRule.value.trim()
  if (!text) return
  rules.value = [...rules.value, text]
  newRule.value = ''
  await saveRules()
}

async function removeRule(index: number) {
  rules.value = rules.value.filter((_, i) => i !== index)
  await saveRules()
}
</script>

<template>
  <div class="px-4 pb-2">
    <button
      type="button"
      class="btn btn-ghost btn-xs w-full justify-between normal-case font-normal"
      @click="expanded = !expanded"
    >
      <span class="text-xs text-base-content/60">全局创作规则</span>
      <font-awesome-icon :icon="expanded ? 'chevron-up' : 'chevron-down'" class="w-3 h-3 opacity-50" />
    </button>
    <div v-if="expanded" class="mt-2 space-y-2">
      <p class="text-xs text-base-content/40 leading-relaxed">
        规则会注入所有 AI 请求，如「禁止出现现代词汇」「主角不能死亡」等。
      </p>
      <ul v-if="rules.length" class="space-y-1">
        <li
          v-for="(rule, idx) in rules"
          :key="idx"
          class="flex items-start gap-1 text-xs bg-base-100 rounded px-2 py-1"
        >
          <span class="flex-1">{{ rule }}</span>
          <button type="button" class="btn btn-ghost btn-xs px-1 min-h-0 h-auto text-error" @click="removeRule(idx)">×</button>
        </li>
      </ul>
      <div class="flex gap-1">
        <input
          v-model="newRule"
          type="text"
          class="input input-bordered input-xs flex-1"
          placeholder="添加规则..."
          @keyup.enter="addRule"
        />
        <button type="button" class="btn btn-primary btn-xs" :disabled="!newRule.trim() || saving" @click="addRule">
          添加
        </button>
      </div>
    </div>
  </div>
</template>
