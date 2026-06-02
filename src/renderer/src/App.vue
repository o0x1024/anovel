<script setup lang="ts">
import { RouterView } from 'vue-router'
import AppLayout from './components/AppLayout.vue'
import AiActivityPanel from './components/AiActivityPanel.vue'
</script>

<template>
  <AppLayout>
    <RouterView v-slot="{ Component, route }">
      <KeepAlive :max="10">
        <component :is="Component" :key="route.path" class="h-full min-h-0" />
      </KeepAlive>
    </RouterView>
  </AppLayout>
  <AiActivityPanel />
</template>
