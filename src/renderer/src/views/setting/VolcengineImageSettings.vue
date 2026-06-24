<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

const emit = defineEmits<{
  toast: [type: 'success' | 'error' | 'info', message: string]
}>()

const accessKey = ref('')
const secretKey = ref('')
const region = ref('cn-beijing')
const enabled = ref(true)
const hasStoredSecret = ref(false)
const saving = ref(false)

const statusLabel = computed(() => {
  if (!accessKey.value.trim()) return { text: '未配置', className: 'badge-ghost' }
  if (!hasStoredSecret.value && !secretKey.value.trim()) {
    return { text: '缺少 Secret Key', className: 'badge-warning' }
  }
  return enabled.value
    ? { text: '已启用', className: 'badge-success' }
    : { text: '已保存但未启用', className: 'badge-warning' }
})

onMounted(() => void loadConfig())

async function loadConfig() {
  const cfg = await window.anovel.invoke('image:getVolcengineConfig') as {
    access_key?: string
    region?: string
    is_enabled?: number
    secret_key?: string
  } | null
  if (!cfg) return
  accessKey.value = cfg.access_key || ''
  region.value = cfg.region || 'cn-beijing'
  enabled.value = cfg.is_enabled !== 0
  hasStoredSecret.value = Boolean(cfg.secret_key)
}

async function saveConfig() {
  if (!accessKey.value.trim()) {
    emit('toast', 'error', '请填写 Access Key')
    return
  }
  if (!hasStoredSecret.value && !secretKey.value.trim()) {
    emit('toast', 'error', '请填写 Secret Key')
    return
  }
  saving.value = true
  try {
    await window.anovel.invoke(
      'image:setVolcengineConfig',
      accessKey.value.trim(),
      secretKey.value.trim(),
      region.value.trim() || 'cn-beijing',
      enabled.value
    )
    hasStoredSecret.value = true
    secretKey.value = ''
    emit('toast', 'success', '火山引擎密钥已保存')
  } catch (e) {
    emit('toast', 'error', e instanceof Error ? e.message : '保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="card bg-base-100 shadow-sm border border-base-300/60">
    <div class="card-body p-5 space-y-4">
      <div class="flex items-start justify-between gap-4">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center text-accent">
            <font-awesome-icon icon="palette" class="text-base" />
          </div>
          <div>
            <h4 class="font-semibold">AI 配图（火山引擎）</h4>
            <p class="text-xs text-base-content/50 mt-0.5">
              用于作品封面、人设、场景与章节插图；密钥仅存于本机
            </p>
          </div>
        </div>
        <span class="badge badge-sm" :class="statusLabel.className">{{ statusLabel.text }}</span>
      </div>

      <p class="text-xs text-base-content/45">
        在火山引擎控制台创建 Access Key / Secret Key 后填入下方。当前版本保存密钥后仍生成占位图，完整画图 API 对接待后续版本启用。
      </p>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-control md:col-span-2">
          <label class="label py-1">
            <span class="label-text font-medium text-sm">Access Key</span>
          </label>
          <input
            v-model="accessKey"
            class="input input-bordered w-full text-sm"
            placeholder="AKxxxxxxxx"
            autocomplete="off"
          />
        </div>
        <div class="form-control md:col-span-2">
          <label class="label py-1">
            <span class="label-text font-medium text-sm">Secret Key</span>
          </label>
          <input
            v-model="secretKey"
            type="password"
            class="input input-bordered w-full text-sm"
            :placeholder="hasStoredSecret ? '已保存，留空则不修改' : 'SKxxxxxxxx'"
            autocomplete="new-password"
          />
        </div>
        <div class="form-control">
          <label class="label py-1">
            <span class="label-text font-medium text-sm">Region</span>
          </label>
          <input v-model="region" class="input input-bordered w-full text-sm" placeholder="cn-beijing" />
        </div>
        <div class="form-control justify-end">
          <label class="label cursor-pointer justify-start gap-3 py-2">
            <input v-model="enabled" type="checkbox" class="toggle toggle-primary toggle-sm" />
            <span class="label-text font-medium text-sm">启用 AI 配图</span>
          </label>
        </div>
      </div>

      <div class="flex justify-end pt-1">
        <button
          type="button"
          class="btn btn-primary btn-sm"
          :disabled="saving"
          @click="saveConfig"
        >
          {{ saving ? '保存中…' : '保存火山引擎配置' }}
        </button>
      </div>
    </div>
  </div>
</template>
