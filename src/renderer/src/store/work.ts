import { defineStore } from 'pinia'
import { ref } from 'vue'

interface Work {
  id: number
  title: string
  description: string | null
  coverImage: string | null
  novelLength: string | null
  targetTotalWords: number | null
  wordsPerChapter: number | null
  updateTime: string
  createTime: string
}

export const useWorkStore = defineStore('work', () => {
  const currentWork = ref<Work | null>(null)
  const works = ref<Work[]>([])
  const currentStep = ref('incubator')

  const steps = [
    { key: 'incubator', label: '大岗孵化' },
    { key: 'ideas', label: '初始想法' },
    { key: 'settings', label: '核心设定' },
    { key: 'volumes', label: '分卷大纲' },
    { key: 'plot', label: '分章情节' },
    { key: 'outline', label: '章节大纲' },
    { key: 'content', label: '正文生成' }
  ]

  function setCurrentWork(work: Work) {
    currentWork.value = work
  }

  function setWorks(list: Work[]) {
    works.value = list
  }

  function setStep(step: string) {
    currentStep.value = step
  }

  return { currentWork, works, currentStep, steps, setCurrentWork, setWorks, setStep }
})
