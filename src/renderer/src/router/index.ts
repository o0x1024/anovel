import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'novels',
      component: () => import('../views/work/WorkList.vue')
    },
    {
      path: '/stories',
      name: 'stories',
      component: () => import('../views/work/WorkList.vue')
    },
    {
      path: '/novel/:id',
      name: 'novel-editor',
      component: () => import('../views/editor/WorkEditor.vue')
    },
    {
      path: '/story/:id',
      name: 'story-editor',
      component: () => import('../views/editor/WorkEditor.vue')
    },
    {
      path: '/style',
      name: 'style',
      component: () => import('../views/style/StyleManager.vue')
    },
    {
      path: '/assistant',
      name: 'assistant',
      component: () => import('../views/assistant/AssistantHub.vue')
    },
    {
      path: '/assistant-docs',
      name: 'assistant-docs',
      component: () => import('../views/assistant/AssistantDocLibrary.vue')
    },
    {
      path: '/ai-lab',
      name: 'ai-lab',
      component: () => import('../views/lab/AiLaboratory.vue')
    },
    {
      path: '/setting',
      name: 'setting',
      component: () => import('../views/setting/Settings.vue')
    }
  ]
})

export default router
