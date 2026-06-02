<script setup lang="ts">
import { ref } from 'vue'
import PanelTitle from '../../components/PanelTitle.vue'
import ForeshadowingTab from './memory/ForeshadowingTab.vue'
import SnapshotsTab from './memory/SnapshotsTab.vue'
import TimelineTab from './memory/TimelineTab.vue'
import ConsistencyTab from './memory/ConsistencyTab.vue'

defineProps<{ workId: number }>()

const activeTab = ref<'foreshadowing' | 'snapshots' | 'timeline' | 'report'>('foreshadowing')

const tabs = [
  { key: 'foreshadowing' as const, label: '伏笔追踪' },
  { key: 'snapshots' as const, label: '角色快照' },
  { key: 'timeline' as const, label: '时间线' },
  { key: 'report' as const, label: '一致性报告' }
]
</script>

<template>
  <div class="w-full min-w-0">
    <PanelTitle icon="project-diagram" title="叙事记忆体" />
    <p class="text-sm text-base-content/50 mb-4">
      V1.5 长篇一致性保障：伏笔、角色状态、时间线会在正文生成时自动注入 Prompt。
    </p>

    <div role="tablist" class="tabs tabs-box tabs-sm w-fit mb-4">
      <a
        v-for="tab in tabs"
        :key="tab.key"
        role="tab"
        href="#"
        class="tab"
        :class="{ 'tab-active': activeTab === tab.key }"
        :aria-selected="activeTab === tab.key"
        @click.prevent="activeTab = tab.key"
      >
        {{ tab.label }}
      </a>
    </div>

    <div class="card bg-base-200 border border-base-300 shadow-sm p-4">
      <ForeshadowingTab v-if="activeTab === 'foreshadowing'" :work-id="workId" />
      <SnapshotsTab v-else-if="activeTab === 'snapshots'" :work-id="workId" />
      <TimelineTab v-else-if="activeTab === 'timeline'" :work-id="workId" />
      <ConsistencyTab v-else :work-id="workId" />
    </div>
  </div>
</template>
