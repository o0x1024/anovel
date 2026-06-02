<script setup lang="ts">
import { ref, onMounted } from 'vue'

const dbPath = ref('')
const autoBackups = ref<{ name: string; path: string; size: number; mtime: string }[]>([])
const busy = ref(false)
const message = ref('')
const messageType = ref<'success' | 'error' | 'info'>('info')

onMounted(load)

async function load() {
  dbPath.value = await window.anovel.invoke('backup:getDbPath') as string
  autoBackups.value = await window.anovel.invoke('backup:listAuto') as typeof autoBackups.value
}

function showMsg(type: typeof messageType.value, text: string) {
  messageType.value = type
  message.value = text
  setTimeout(() => { message.value = '' }, 4000)
}

async function saveDatabaseBackup() {
  busy.value = true
  try {
    const res = await window.anovel.invoke('backup:saveDatabase') as { success: boolean; path?: string }
    if (res.success) showMsg('success', `已保存至 ${res.path}`)
    else showMsg('info', '已取消')
  } catch (e) {
    showMsg('error', e instanceof Error ? e.message : '备份失败')
  } finally {
    busy.value = false
  }
}

async function restoreDatabase() {
  if (!confirm('恢复数据库将覆盖当前所有数据，应用将需要重启。确定继续？')) return
  busy.value = true
  try {
    const res = await window.anovel.invoke('backup:restoreDatabase') as { success: boolean; needsRestart?: boolean }
    if (res.success) showMsg('success', '数据库已恢复，请重启应用')
    else showMsg('info', '已取消')
  } catch (e) {
    showMsg('error', e instanceof Error ? e.message : '恢复失败')
  } finally {
    busy.value = false
  }
}

async function createAutoBackup() {
  busy.value = true
  try {
    const path = await window.anovel.invoke('backup:auto') as string
    showMsg('success', `自动备份已创建`)
    await load()
    console.log(path)
  } catch (e) {
    showMsg('error', e instanceof Error ? e.message : '备份失败')
  } finally {
    busy.value = false
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}
</script>

<template>
  <div class="space-y-4">
    <div class="mb-2">
      <h3 class="text-xl font-bold">数据备份</h3>
      <p class="text-sm text-base-content/50 mt-1">备份与恢复本地 SQLite 数据库，所有创作数据均存储于此</p>
    </div>

    <div v-if="message" :class="['alert text-sm', messageType === 'success' ? 'alert-success' : messageType === 'error' ? 'alert-error' : 'alert-info']">
      {{ message }}
    </div>

    <div class="card bg-base-100 border border-base-300/60">
      <div class="card-body p-5 space-y-4">
        <div class="text-xs text-base-content/50 font-mono break-all">数据库路径：{{ dbPath }}</div>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn btn-primary btn-sm gap-2" :disabled="busy" @click="saveDatabaseBackup">
            <font-awesome-icon icon="download" class="w-3.5 h-3.5" />
            导出数据库备份
          </button>
          <button type="button" class="btn btn-outline btn-sm gap-2" :disabled="busy" @click="createAutoBackup">
            <font-awesome-icon icon="save" class="w-3.5 h-3.5" />
            创建自动备份
          </button>
          <button type="button" class="btn btn-outline btn-error btn-sm gap-2" :disabled="busy" @click="restoreDatabase">
            <font-awesome-icon icon="upload" class="w-3.5 h-3.5" />
            从备份恢复
          </button>
        </div>
        <p class="text-xs text-base-content/40">恢复后请完全退出并重新打开应用。建议在重大操作前先备份。</p>
      </div>
    </div>

    <div v-if="autoBackups.length" class="card bg-base-100 border border-base-300/60">
      <div class="card-body p-5">
        <h4 class="font-semibold text-sm mb-3">本地自动备份记录</h4>
        <ul class="space-y-2 text-sm">
          <li v-for="b in autoBackups.slice(0, 5)" :key="b.path" class="flex justify-between text-base-content/70">
            <span class="font-mono text-xs">{{ b.name }}</span>
            <span class="text-xs">{{ formatSize(b.size) }} · {{ new Date(b.mtime).toLocaleString('zh-CN') }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>
