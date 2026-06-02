<script setup lang="ts">
import { ref, onMounted } from 'vue'

const logDir = ref('')
const todayFile = ref('')
const recentLines = ref<string[]>([])
const loading = ref(false)
const message = ref('')

onMounted(load)

async function load() {
  loading.value = true
  try {
    const info = await window.anovel.invoke('log:getInfo') as {
      logDir: string
      todayFile: string
      recentLines: string[]
    }
    logDir.value = info.logDir
    todayFile.value = info.todayFile
    recentLines.value = info.recentLines
  } finally {
    loading.value = false
  }
}

async function openLogDir() {
  const res = await window.anovel.invoke('log:openDir') as { success: boolean; error?: string }
  if (!res.success) message.value = res.error || '无法打开日志目录'
}

async function openTodayLog() {
  const res = await window.anovel.invoke('log:openToday') as { success: boolean; error?: string }
  if (!res.success) message.value = res.error || '无法打开今日日志'
}

async function refresh() {
  message.value = ''
  await load()
}
</script>

<template>
  <div class="card bg-base-100 border border-base-300/60 shadow-sm">
    <div class="card-body p-5">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div>
          <h4 class="font-semibold">应用日志</h4>
          <p class="text-xs text-base-content/50 mt-1">
            AI 调用失败、人设卡片解析错误等信息会写入本地日志文件，便于排查问题
          </p>
        </div>
        <button type="button" class="btn btn-ghost btn-xs" :disabled="loading" @click="refresh">
          {{ loading ? '刷新中...' : '刷新' }}
        </button>
      </div>

      <p v-if="message" class="text-xs text-error mb-2">{{ message }}</p>

      <div class="text-xs text-base-content/60 space-y-1 mb-4 font-mono break-all">
        <p>目录：{{ logDir || '—' }}</p>
        <p>今日：{{ todayFile || '—' }}</p>
      </div>

      <div class="flex flex-wrap gap-2 mb-4">
        <button type="button" class="btn btn-outline btn-sm" @click="openTodayLog">打开今日日志</button>
        <button type="button" class="btn btn-outline btn-sm" @click="openLogDir">打开日志目录</button>
      </div>

      <div v-if="recentLines.length" class="rounded-lg border border-base-300/60 bg-base-200/50 p-3 max-h-48 overflow-auto">
        <p class="text-xs text-base-content/50 mb-2">最近日志</p>
        <pre class="text-[11px] leading-relaxed whitespace-pre-wrap break-all text-base-content/70">{{ recentLines.join('\n') }}</pre>
      </div>
      <p v-else class="text-xs text-base-content/40">今日暂无日志记录</p>
    </div>
  </div>
</template>
