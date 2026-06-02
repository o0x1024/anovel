<script setup lang="ts">
import { useRouter, useRoute } from 'vue-router'
import { computed, watch } from 'vue'
import { getNavRestorePath, saveNavPath } from '../services/navSession'

const router = useRouter()
const route = useRoute()

const navItems = [
  { path: '/', icon: 'book-open', label: '作品管理', section: 'workspace' },
  { path: '/style', icon: 'palette', label: '文风管理', section: 'workspace' },
  { path: '/assistant', icon: 'robot', label: 'AI 助手', section: 'intelligence' },
  { path: '/ai-lab', icon: 'flask', label: 'AI 实验室', section: 'intelligence' },
  { path: '/assistant-docs', icon: 'book', label: '文档库', section: 'intelligence' },
  { path: '/setting', icon: 'cog', label: '系统设置', section: 'system' }
]

const activeRoute = computed(() => {
  if (route.path.startsWith('/work/')) return '/'
  return route.path
})
const workspaceNavItems = computed(() => navItems.filter(item => item.section === 'workspace'))
const intelligenceNavItems = computed(() => navItems.filter(item => item.section === 'intelligence'))
const systemNavItems = computed(() => navItems.filter(item => item.section === 'system'))

watch(
  () => route.fullPath,
  () => saveNavPath(route.path, route.fullPath),
  { immediate: true }
)

function navigateNav(navPath: string) {
  const target = getNavRestorePath(navPath, navPath)
  if (route.fullPath !== target) {
    router.push(target)
  }
}
</script>

<template>
  <div class="flex h-screen bg-base-100 text-base-content font-sans">
    <aside class="w-64 bg-base-200 border-r border-base-300 flex flex-col shrink-0 select-none">
      <div class="px-6 py-5 border-b border-base-300 flex flex-col gap-1">
        <h1 class="text-xl font-extrabold text-primary flex items-center gap-2.5 tracking-tight">
          <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
            <font-awesome-icon icon="project-diagram" class="text-lg" />
          </div>
          <span class="bg-gradient-to-r from-primary to-secondary bg-clip-text text-transparent">ANovel</span>
        </h1>
        <p class="text-xs text-base-content/40 font-medium tracking-wide">AI-POWERED NOVEL ASSISTANT</p>
      </div>

      <div class="flex-1 py-5 overflow-y-auto scrollbar-thin">
        <div class="px-3 mb-8">
          <h3 class="px-3 mb-3 text-xs font-bold text-base-content/40 uppercase tracking-wider">
            创作工作区
          </h3>
          <ul class="menu menu-sm rounded-box w-full">
            <li v-for="item in workspaceNavItems" :key="item.path">
              <button
                type="button"
                :class="{ 'menu-active': activeRoute === item.path }"
                @click="navigateNav(item.path)"
              >
                <font-awesome-icon :icon="item.icon" class="w-4 h-4 opacity-80" />
                {{ item.label }}
              </button>
            </li>
          </ul>
        </div>

        <div class="px-3 mb-8">
          <h3 class="px-3 mb-3 text-xs font-bold text-base-content/40 uppercase tracking-wider">
            智能中心
          </h3>
          <ul class="menu menu-sm rounded-box w-full">
            <li v-for="item in intelligenceNavItems" :key="item.path">
              <button
                type="button"
                :class="{ 'menu-active': activeRoute === item.path }"
                @click="navigateNav(item.path)"
              >
                <font-awesome-icon :icon="item.icon" class="w-4 h-4 opacity-80" />
                {{ item.label }}
              </button>
            </li>
          </ul>
        </div>

        <div class="px-3">
          <h3 class="px-3 mb-3 text-xs font-bold text-base-content/40 uppercase tracking-wider">
            系统
          </h3>
          <ul class="menu menu-sm rounded-box w-full">
            <li v-for="item in systemNavItems" :key="item.path">
              <button
                type="button"
                :class="{ 'menu-active': activeRoute === item.path }"
                @click="navigateNav(item.path)"
              >
                <font-awesome-icon :icon="item.icon" class="w-4 h-4 opacity-80" />
                {{ item.label }}
              </button>
            </li>
          </ul>
        </div>
      </div>

      <div class="px-6 py-4 border-t border-base-300/50 flex items-center justify-between text-xs font-semibold text-base-content/30 tracking-wider">
        <span>ANovel Desktop</span>
        <span>v1.0.0</span>
      </div>
    </aside>

    <main class="flex-1 min-h-0 overflow-auto bg-base-100 relative">
      <slot />
    </main>
  </div>
</template>
