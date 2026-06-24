import { onMounted } from 'vue'
import {
  bindBodySession,
  clearBodySession,
  deliverBodySession,
  trackBodySessionContent
} from '../services/body-generation-state'

const BODY_SESSION_TITLE = '生成正文'

let eventsBound = false

function bindBodyGenerationEvents(): void {
  if (eventsBound) return
  eventsBound = true

  window.anovel.on('ai:session-start', (payload: unknown) => {
    const p = payload as { sessionId: string; title: string }
    if (p.title !== BODY_SESSION_TITLE) return
    bindBodySession(p.sessionId)
  })

  window.anovel.on('ai:delta', (payload: unknown) => {
    const p = payload as { sessionId: string; content: string }
    trackBodySessionContent(p.sessionId, p.content)
  })

  window.anovel.on('ai:session-end', (payload: unknown) => {
    const p = payload as { sessionId: string; success: boolean }
    deliverBodySession(p.sessionId, p.success)
  })

  window.anovel.on('ai:session-cancelled', (payload: unknown) => {
    const p = payload as { sessionId: string }
    clearBodySession(p.sessionId)
  })
}

/** 全局监听正文生成 AI 会话，确保离开正文生成页后内容仍能写入章节草稿缓存 */
export function useBodyGenerationDelivery(): void {
  onMounted(() => {
    bindBodyGenerationEvents()
  })
}
