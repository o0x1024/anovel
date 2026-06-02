import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useAppStore = defineStore('app', () => {
  const darkMode = ref(true)
  const sidebarCollapsed = ref(false)

  function toggleDarkMode() {
    darkMode.value = !darkMode.value
  }

  return { darkMode, sidebarCollapsed, toggleDarkMode }
})
