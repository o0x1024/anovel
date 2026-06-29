<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
import {
  EMPTY_GOLDEN_FINGER,
  normalizeGoldenFinger,
  renderGoldenFingerMarkdown,
  goldenFingerValidationIssues,
  type GoldenFingerStructured
} from '../../../../shared/golden-finger-types'

const props = defineProps<{ workId: number }>()
const emit = defineEmits<{
  (e: 'saved'): void
  (e: 'cancel'): void
}>()

const gf = ref<GoldenFingerStructured>(normalizeGoldenFinger({}))
const loading = ref(false)
const saving = ref(false)
const validationVisible = ref(false)

const issues = computed(() => goldenFingerValidationIssues(gf.value))
const renderedMarkdown = computed(() => renderGoldenFingerMarkdown(gf.value))

async function load() {
  loading.value = true
  try {
    const raw = await window.anovel.invoke('setting:getStructured', props.workId, 'golden_finger') as Partial<GoldenFingerStructured> | null
    gf.value = raw ? normalizeGoldenFinger(raw) : normalizeGoldenFinger({})
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
    await window.anovel.invoke(
      'setting:upsertStructured',
      props.workId,
      'golden_finger',
      markdown,
      gf.value
    )
    emit('saved')
  } finally {
    saving.value = false
  }
}

function reset() {
  gf.value = normalizeGoldenFinger({})
}
</script>

<template>
  <div class="flex flex-col gap-4 max-h-[70vh] overflow-y-auto pr-1">
    <div v-if="loading" class="text-sm text-base-content/50">加载中...</div>

    <div class="flex items-center justify-between">
      <h4 class="font-semibold text-sm">金手指结构化编辑</h4>
      <button type="button" class="btn btn-ghost btn-xs" @click="validationVisible = !validationVisible">
        {{ validationVisible ? '隐藏检查' : '显示检查' }}
      </button>
    </div>

    <div v-if="validationVisible" class="alert alert-warning text-xs py-2">
      <div v-if="issues.length">
        <p class="font-medium mb-1">未填必填项：</p>
        <ul class="list-disc list-inside space-y-0.5">
          <li v-for="(issue, i) in issues" :key="i">{{ issue }}</li>
        </ul>
      </div>
      <p v-else>所有必填项已填写。</p>
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

    <div class="flex justify-end gap-2 pt-2">
      <button type="button" class="btn btn-ghost btn-sm" @click="reset">清空</button>
      <button type="button" class="btn btn-ghost btn-sm" @click="emit('cancel')">取消</button>
      <button type="button" class="btn btn-primary btn-sm" :disabled="saving" @click="save">
        {{ saving ? '保存中...' : '保存' }}
      </button>
    </div>
  </div>
</template>
