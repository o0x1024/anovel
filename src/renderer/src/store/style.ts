import { defineStore } from 'pinia'
import { ref } from 'vue'

interface Style {
  id: number
  name: string
  description: string
  isBuiltin: boolean
}

export const useStyleStore = defineStore('style', () => {
  const styles = ref<Style[]>([])
  const currentStyleId = ref<number | null>(null)
  const workStyleMap = ref<Record<number, number>>({}) // workId -> styleId

  function getWorkStyle(workId: number): number | null {
    return workStyleMap.value[workId] || currentStyleId.value
  }

  function bindWorkStyle(workId: number, styleId: number) {
    workStyleMap.value[workId] = styleId
  }

  return { styles, currentStyleId, workStyleMap, getWorkStyle, bindWorkStyle }
})
