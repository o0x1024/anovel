<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MarkdownContent from './MarkdownContent.vue'
import { useAiActivityLifecycle } from '../composables/useAiActivity'
import { useAiPanelResize, maxPanelWidth, maxPanelHeight } from '../composables/useAiPanelResize'
import { useStickToBottomScroll } from '../composables/useStickToBottomScroll'

const {
  active,
  history,
  showHistory,
  thinkingExpanded,
  elapsedMs,
  isRunning,
  isVisible,
  isMinimized,
  cancelSession,
  minimize,
  restore,
  dismiss,
  toggleHistory,
  formatDuration
} = useAiActivityLifecycle()

const { panelWidth, panelHeight, isResizing, startResize, clampToViewport } = useAiPanelResize()

const streamRef = ref<HTMLElement | null>(null)
const hasThinking = computed(() => !!(active.value?.thinkingContent?.trim()))
const hasContent = computed(() => !!(active.value?.content?.trim()))

const panelStyle = computed(() => ({
  width: `${Math.min(panelWidth.value, maxPanelWidth())}px`,
  height: `${Math.min(panelHeight.value, maxPanelHeight())}px`
}))

const { stickToBottom, onScroll, jumpToBottom, resetStickToBottom } = useStickToBottomScroll(
  streamRef,
  () => [active.value?.content, active.value?.thinkingContent]
)

watch(
  () => active.value?.sessionId,
  () => {
    resetStickToBottom()
    clampToViewport()
  }
)

watch(isVisible, (visible) => {
  if (visible) clampToViewport()
})

function stepIcon(status: string) {
  if (status === 'done') return 'check-circle'
  if (status === 'running') return 'spinner'
  if (status === 'error') return 'exclamation-circle'
  return 'circle'
}

function statusBadgeClass(status: string) {
  if (status === 'success') return 'badge-success'
  if (status === 'error') return 'badge-error'
  if (status === 'cancelled') return 'badge-warning'
  return 'badge-primary'
}

function statusLabel(status: string) {
  if (status === 'success') return '完成'
  if (status === 'error') return '失败'
  if (status === 'cancelled') return '已取消'
  return '进行中'
}

function toggleThinking() {
  thinkingExpanded.value = !thinkingExpanded.value
}
</script>

<template>
  <!-- 最小化 pill -->
  <button
    v-if="isMinimized && active"
    type="button"
    class="fixed bottom-4 right-4 z-50 btn btn-primary btn-sm shadow-lg gap-2"
    @click="restore"
  >
    <font-awesome-icon :icon="isRunning ? 'spinner' : 'robot'" :spin="isRunning" class="w-3.5 h-3.5" />
    {{ active.title }}
    <span v-if="isRunning" class="opacity-80">{{ formatDuration(elapsedMs) }}</span>
  </button>

  <!-- 主浮窗 -->
  <div
    v-if="isVisible && active"
    class="ai-activity-panel fixed bottom-4 right-4 z-50 flex flex-col rounded-xl border border-base-300 bg-base-100 shadow-2xl overflow-hidden"
    :class="{ 'select-none': isResizing }"
    :style="panelStyle"
  >
    <!-- 左上角：同时调整宽度和高度 -->
    <div
      class="ai-resize-handle ai-resize-corner"
      title="拖动调整大小"
      @mousedown="startResize($event, 'corner')"
    />
    <!-- 顶边：调整高度 -->
    <div
      class="ai-resize-handle ai-resize-top"
      title="拖动调整高度"
      @mousedown="startResize($event, 'top')"
    />
    <!-- 左边：调整宽度 -->
    <div
      class="ai-resize-handle ai-resize-left"
      title="拖动调整宽度"
      @mousedown="startResize($event, 'left')"
    />

    <div class="flex items-center gap-2 px-3 py-2 border-b border-base-300 bg-base-200/60 shrink-0">
      <font-awesome-icon
        :icon="isRunning ? 'spinner' : 'robot'"
        :spin="isRunning"
        class="w-4 h-4 text-primary shrink-0"
      />
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium truncate">{{ active.title }}</div>
        <div class="text-xs text-base-content/50 truncate">
          {{ active.currentPhase }}
          <span v-if="active.modelType"> · {{ active.modelName || active.modelType }}</span>
        </div>
      </div>
      <span class="badge badge-xs" :class="statusBadgeClass(active.status)">
        {{ statusLabel(active.status) }}
      </span>
      <button type="button" class="btn btn-ghost btn-xs btn-square" title="历史" @click="toggleHistory">
        <font-awesome-icon icon="clock" class="w-3 h-3" />
      </button>
      <button type="button" class="btn btn-ghost btn-xs btn-square" title="最小化" @click="minimize">
        <font-awesome-icon icon="chevron-down" class="w-3 h-3" />
      </button>
      <button type="button" class="btn btn-ghost btn-xs btn-square" title="关闭" @click="dismiss">
        <font-awesome-icon icon="times" class="w-3 h-3" />
      </button>
    </div>

    <div v-if="showHistory" class="border-b border-base-300 max-h-36 overflow-y-auto shrink-0">
      <div class="px-3 py-2 text-xs font-medium text-base-content/60">最近任务</div>
      <ul class="menu menu-xs px-1 pb-2">
        <li v-for="item in history" :key="item.sessionId">
          <a class="flex items-center gap-2">
            <font-awesome-icon
              :icon="item.success ? 'check-circle' : 'exclamation-circle'"
              class="w-3 h-3 shrink-0"
              :class="item.success ? 'text-success' : 'text-error'"
            />
            <span class="truncate flex-1">{{ item.title }}</span>
            <span class="text-base-content/40">{{ formatDuration(item.durationMs) }}</span>
          </a>
        </li>
        <li v-if="history.length === 0">
          <span class="text-base-content/40 px-3">暂无历史</span>
        </li>
      </ul>
    </div>

    <ul v-if="active.steps.length > 0" class="px-3 py-2 space-y-1 border-b border-base-300 shrink-0 max-h-28 overflow-y-auto">
      <li
        v-for="step in active.steps"
        :key="step.id"
        class="flex items-center gap-2 text-xs"
        :class="step.status === 'running' ? 'text-primary' : 'text-base-content/70'"
      >
        <font-awesome-icon
          :icon="stepIcon(step.status)"
          :spin="step.status === 'running'"
          class="w-3 h-3 shrink-0"
        />
        <span class="truncate">{{ step.label }}</span>
      </li>
    </ul>

    <div class="relative flex-1 min-h-0 flex flex-col">
      <div
        ref="streamRef"
        class="flex-1 min-h-[120px] overflow-y-auto px-3 py-2 bg-base-200/30 space-y-2"
        @scroll="onScroll"
      >
      <!-- 思考过程 -->
      <div v-if="hasThinking" class="rounded-lg border border-warning/30 bg-warning/5">
        <button
          type="button"
          class="flex w-full items-center gap-2 px-2 py-1.5 text-xs font-medium text-warning/90"
          @click="toggleThinking"
        >
          <font-awesome-icon
            :icon="thinkingExpanded ? 'chevron-down' : 'chevron-right'"
            class="w-3 h-3 shrink-0"
          />
          <font-awesome-icon icon="brain" class="w-3 h-3 shrink-0" />
          思考过程
          <span v-if="isRunning && !active.content" class="badge badge-warning badge-xs">推理中</span>
        </button>
        <div v-show="thinkingExpanded" class="px-2 pb-2 border-t border-warning/20">
          <MarkdownContent :content="active.thinkingContent" size="xs" />
          <span
            v-if="isRunning && !hasContent"
            class="inline-block w-2 h-3.5 ml-0.5 bg-warning animate-pulse align-middle"
          />
        </div>
      </div>

      <!-- 正文输出 -->
      <div v-if="hasContent" class="ai-activity-output">
        <div v-if="hasThinking" class="mb-1 text-xs font-medium text-base-content/50">输出</div>
        <MarkdownContent :content="active.content" size="xs" />
        <span v-if="isRunning" class="inline-block w-2 h-3.5 ml-0.5 bg-primary animate-pulse align-middle" />
      </div>

      <p v-if="!hasThinking && !hasContent && isRunning" class="text-xs text-base-content/40">
        等待模型输出…
      </p>
      <p v-else-if="!hasThinking && !hasContent && !isRunning" class="text-xs text-base-content/40">
        无输出内容
      </p>
      </div>

      <button
        v-if="!stickToBottom && (hasContent || hasThinking)"
        type="button"
        class="absolute bottom-2 left-1/2 -translate-x-1/2 btn btn-primary btn-xs shadow-md gap-1"
        @click="jumpToBottom"
      >
        <font-awesome-icon icon="arrow-down" class="w-3 h-3" />
        回到底部
      </button>
    </div>

    <div class="flex items-center justify-between gap-2 px-3 py-2 border-t border-base-300 shrink-0 text-xs text-base-content/50">
      <span>已用时 {{ formatDuration(elapsedMs) }}</span>
      <div class="flex gap-1">
        <button
          v-if="isRunning"
          type="button"
          class="btn btn-outline btn-error btn-xs"
          @click="cancelSession"
        >
          取消
        </button>
        <button
          v-if="!isRunning"
          type="button"
          class="btn btn-ghost btn-xs"
          @click="dismiss"
        >
          关闭
        </button>
      </div>
    </div>

    <p v-if="active.error && active.status === 'error'" class="px-3 pb-2 text-xs text-error shrink-0">
      {{ active.error }}
    </p>
  </div>
</template>

<style scoped>
.ai-activity-output :deep(.markdown-content) {
  color: oklch(var(--bc) / 0.85);
}

.ai-activity-panel {
  /* 勿设 position:relative，否则会覆盖 Tailwind 的 fixed，浮窗会落到页面底部不可见区域 */
  min-width: 300px;
  min-height: 260px;
  max-width: calc(100vw - 2rem);
  max-height: calc(100vh - 2rem);
}

.ai-resize-handle {
  position: absolute;
  z-index: 10;
}

.ai-resize-corner {
  top: 0;
  left: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
}

.ai-resize-corner::after {
  content: '';
  position: absolute;
  top: 4px;
  left: 4px;
  width: 8px;
  height: 8px;
  border-top: 2px solid oklch(var(--bc) / 0.25);
  border-left: 2px solid oklch(var(--bc) / 0.25);
  border-radius: 2px 0 0 0;
  pointer-events: none;
}

.ai-resize-top {
  top: 0;
  left: 16px;
  right: 0;
  height: 6px;
  cursor: ns-resize;
}

.ai-resize-left {
  top: 16px;
  left: 0;
  bottom: 0;
  width: 6px;
  cursor: ew-resize;
}

.ai-resize-corner:hover::after,
.ai-resize-top:hover,
.ai-resize-left:hover {
  opacity: 1;
}

.ai-resize-top:hover {
  background: oklch(var(--p) / 0.12);
}

.ai-resize-left:hover {
  background: oklch(var(--p) / 0.12);
}
</style>
