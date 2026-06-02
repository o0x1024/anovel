<script setup lang="ts">
import {
  ALL_THEMES,
  getThemeLabel,
  useAppearanceSettings
} from '../../services/appearanceSettings'
import LogSettingsPanel from './LogSettingsPanel.vue'

const { appearance, update, reset } = useAppearanceSettings()

function formatSize(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}
</script>

<template>
  <div class="space-y-4">
    <div class="mb-2">
      <h3 class="text-xl font-bold">常规设置</h3>
      <p class="text-sm text-base-content/50 mt-1">调整界面主题、字体、组件尺寸与布局间距</p>
    </div>

    <!-- 概览 -->
    <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
      <div class="stat bg-base-100 border border-base-300/60 rounded-xl shadow-sm">
        <div class="stat-figure text-primary">
          <font-awesome-icon icon="palette" class="text-2xl" />
        </div>
        <div class="stat-title text-xs uppercase tracking-wider opacity-60">当前主题</div>
        <div class="stat-value text-base capitalize">{{ getThemeLabel(appearance.theme) }}</div>
      </div>
      <div class="stat bg-base-100 border border-base-300/60 rounded-xl shadow-sm">
        <div class="stat-figure text-secondary">
          <font-awesome-icon icon="font" class="text-2xl" />
        </div>
        <div class="stat-title text-xs uppercase tracking-wider opacity-60">字体大小</div>
        <div class="stat-value text-base">{{ formatSize(appearance.fontSize) }}px</div>
      </div>
      <div class="stat bg-base-100 border border-base-300/60 rounded-xl shadow-sm">
        <div class="stat-figure text-accent">
          <font-awesome-icon icon="expand" class="text-2xl" />
        </div>
        <div class="stat-title text-xs uppercase tracking-wider opacity-60">布局间隔</div>
        <div class="stat-value text-base">{{ formatSize(appearance.spacing) }}%</div>
      </div>
    </div>

    <!-- 外观 -->
    <div class="card bg-base-100 shadow-sm border border-base-300/60">
      <div class="card-body p-6">
        <div class="flex items-center gap-3 mb-5">
          <div class="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <font-awesome-icon icon="desktop" class="text-base" />
          </div>
          <div>
            <h4 class="font-semibold">界面外观</h4>
            <p class="text-xs text-base-content/50">主题与字体设置会立即生效并自动保存</p>
          </div>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <!-- 主题 -->
          <div class="space-y-4">
            <h5 class="text-sm font-bold text-base-content/60 uppercase tracking-wider border-b border-base-300/60 pb-2">
              主题
            </h5>

            <div class="form-control">
              <label class="label py-1">
                <span class="label-text font-medium text-sm">主题方案</span>
              </label>
              <select
                :value="appearance.theme"
                class="select select-bordered w-full rounded-lg"
                @change="(e: Event) => update({ theme: (e.target as HTMLSelectElement).value })"
              >
                <option v-for="theme in ALL_THEMES" :key="theme" :value="theme">
                  {{ getThemeLabel(theme) }}
                </option>
              </select>
            </div>
          </div>

          <!-- 字体 -->
          <div class="space-y-4">
            <h5 class="text-sm font-bold text-base-content/60 uppercase tracking-wider border-b border-base-300/60 pb-2">
              字体
            </h5>

            <div class="form-control">
              <label class="label py-1">
                <span class="label-text font-medium text-sm">字体大小</span>
                <span class="label-text-alt font-mono text-sm">{{ formatSize(appearance.fontSize) }}px</span>
              </label>
              <input
                :value="appearance.fontSize"
                type="range"
                min="12"
                max="20"
                step="0.1"
                class="range range-primary range-sm"
                @input="(e: Event) => update({ fontSize: Number((e.target as HTMLInputElement).value) })"
              />
              <div class="flex justify-between text-xs text-base-content/30 mt-1 px-1">
                <span>12px</span>
                <span>20px</span>
              </div>
              <p class="text-xs text-base-content/40 mt-2">统一缩放界面文字（标题、正文、菜单、标签等）</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 布局与组件 -->
    <div class="card bg-base-100 shadow-sm border border-base-300/60">
      <div class="card-body p-6">
        <div class="flex items-center gap-3 mb-5">
          <div class="w-9 h-9 rounded-lg bg-secondary/10 flex items-center justify-center text-secondary">
            <font-awesome-icon icon="sliders" class="text-base" />
          </div>
          <div>
            <h4 class="font-semibold">布局与组件</h4>
            <p class="text-xs text-base-content/50">调整按钮、输入框等组件尺寸，以及页面元素间距</p>
          </div>
        </div>

        <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <div class="form-control">
            <label class="label py-1">
              <span class="label-text font-medium text-sm">组件大小</span>
              <span class="label-text-alt font-mono text-sm">{{ formatSize(appearance.uiScale) }}%</span>
            </label>
            <input
              :value="appearance.uiScale"
              type="range"
              min="80"
              max="120"
              step="0.1"
              class="range range-secondary range-sm"
              @input="(e: Event) => update({ uiScale: Number((e.target as HTMLInputElement).value) })"
            />
            <div class="flex justify-between text-xs text-base-content/30 mt-1 px-1">
              <span>80%</span>
              <span>120%</span>
            </div>
            <p class="text-xs text-base-content/40 mt-2">仅影响按钮、输入框、下拉框等 DaisyUI 组件的尺寸</p>
          </div>

          <div class="form-control">
            <label class="label py-1">
              <span class="label-text font-medium text-sm">布局间隔</span>
              <span class="label-text-alt font-mono text-sm">{{ formatSize(appearance.spacing) }}%</span>
            </label>
            <input
              :value="appearance.spacing"
              type="range"
              min="75"
              max="125"
              step="0.1"
              class="range range-accent range-sm"
              @input="(e: Event) => update({ spacing: Number((e.target as HTMLInputElement).value) })"
            />
            <div class="flex justify-between text-xs text-base-content/30 mt-1 px-1">
              <span>75%</span>
              <span>125%</span>
            </div>
            <p class="text-xs text-base-content/40 mt-2">影响页面边距、卡片间距、侧边栏菜单项间隔等</p>
          </div>
        </div>

        <!-- 预览 -->
        <div class="mt-6 rounded-xl border border-base-300/60 bg-base-200/40 p-4">
          <p class="text-xs font-bold text-base-content/40 uppercase tracking-wider mb-3">预览</p>
          <div
            class="rounded-lg border border-base-300/60 bg-base-100 p-4 space-y-3"
            :style="{ padding: `calc(1rem * var(--spacing-scale, 1))`, gap: `calc(0.75rem * var(--spacing-scale, 1))` }"
          >
            <p class="text-sm">这是一段示例文字，用于预览当前字体大小效果。</p>
            <div class="flex flex-wrap items-center gap-2">
              <button type="button" class="btn btn-primary btn-sm">主要按钮</button>
              <button type="button" class="btn btn-outline btn-neutral btn-sm">次要按钮</button>
              <input type="text" class="input input-bordered input-sm w-40" placeholder="输入框" />
            </div>
          </div>
        </div>
      </div>
    </div>

    <LogSettingsPanel />

    <!-- 重置 -->
    <div class="flex justify-end">
      <button type="button" class="btn btn-ghost btn-sm gap-2" @click="reset">
        <font-awesome-icon icon="rotate" class="w-3.5 h-3.5 mr-1.5" />
        恢复默认外观
      </button>
    </div>
  </div>
</template>
