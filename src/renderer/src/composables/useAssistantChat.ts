import { ref, watch, onMounted, onUnmounted, type Ref } from 'vue'

import type { AssistantWorkReference } from '../../../../shared/assistant-types'
import { toPlainDocumentIds, toPlainWorkReferences } from '../utils/assistantPlainPayload'

export interface AssistantMessageView {
  id: number
  conversation_id: number
  role: string
  content: string
  message_type: string
  metadata_json: string | null
  create_time: string
}

export function useAssistantChat(conversationId: Ref<number | null>) {
  const messages = ref<AssistantMessageView[]>([])
  const streamingMessageId = ref<number | null>(null)
  const thinkingStreamingMessageId = ref<number | null>(null)
  const sending = ref(false)
  const error = ref('')
  let localMessageSeq = 0

  async function loadMessages() {
    if (!conversationId.value) {
      messages.value = []
      return
    }
    messages.value = await window.anovel.invoke(
      'assistant:messageList',
      conversationId.value
    ) as AssistantMessageView[]
  }

  function onDelta(payload: {
    conversationId: number
    messageId: number
    content: string
  }) {
    if (payload.conversationId !== conversationId.value) return
    const existing = messages.value.find(m => m.id === payload.messageId)
    if (existing) {
      existing.content = payload.content
    } else {
      messages.value.push({
        id: payload.messageId,
        conversation_id: payload.conversationId,
        role: 'assistant',
        content: payload.content,
        message_type: 'text',
        metadata_json: null,
        create_time: new Date().toISOString()
      })
    }
    streamingMessageId.value = payload.messageId
    if (thinkingStreamingMessageId.value === payload.messageId) {
      // thinking 已进入正文阶段：立即折叠 thinking 面板
      thinkingStreamingMessageId.value = null
    }
  }

  function onThinkingDelta(payload: {
    conversationId: number
    messageId: number
    thinking: string
  }) {
    if (payload.conversationId !== conversationId.value) return
    const existing = messages.value.find(m => m.id === payload.messageId)
    if (!existing) {
      messages.value.push({
        id: payload.messageId,
        conversation_id: payload.conversationId,
        role: 'assistant',
        content: '',
        message_type: 'text',
        metadata_json: JSON.stringify({ thinking: payload.thinking }),
        create_time: new Date().toISOString()
      })
      return
    }
    let metadata: Record<string, unknown> = {}
    if (existing.metadata_json) {
      try {
        metadata = JSON.parse(existing.metadata_json) as Record<string, unknown>
      } catch {
        metadata = {}
      }
    }
    metadata.thinking = payload.thinking
    existing.metadata_json = JSON.stringify(metadata)
    streamingMessageId.value = payload.messageId
    thinkingStreamingMessageId.value = payload.messageId
  }

  function onChatEnd(payload: {
    conversationId: number
    success: boolean
    error?: string
  }) {
    if (payload.conversationId !== conversationId.value) return
    sending.value = false
    streamingMessageId.value = null
    thinkingStreamingMessageId.value = null
    if (!payload.success && payload.error) {
      error.value = payload.error
    }
    void loadMessages()
  }

  const deltaHandler = (payload: unknown) => onDelta(payload as Parameters<typeof onDelta>[0])
  const thinkingHandler = (payload: unknown) =>
    onThinkingDelta(payload as Parameters<typeof onThinkingDelta>[0])
  const endHandler = (payload: unknown) => onChatEnd(payload as Parameters<typeof onChatEnd>[0])

  onMounted(() => {
    window.anovel.on('assistant:delta', deltaHandler)
    window.anovel.on('assistant:thinking-delta', thinkingHandler)
    window.anovel.on('assistant:chat-end', endHandler)
  })

  onUnmounted(() => {
    window.anovel.off('assistant:delta', deltaHandler)
    window.anovel.off('assistant:thinking-delta', thinkingHandler)
    window.anovel.off('assistant:chat-end', endHandler)
  })

  watch(conversationId, () => {
    error.value = ''
    void loadMessages()
  }, { immediate: true })

  async function send(
    text: string,
    documentIds: number[] = [],
    documents: Array<{ id: number; title: string }> = [],
    workReferences: AssistantWorkReference[] = []
  ) {
    if (!conversationId.value || !text.trim() || sending.value) return
    const plainDocIds = toPlainDocumentIds(documentIds)
    const plainWorkRefs = toPlainWorkReferences(workReferences)
    localMessageSeq += 1
    const localUserMessageId = -localMessageSeq
    const hasAttachments = plainDocIds.length > 0 || plainWorkRefs.length > 0
    const metadata: Record<string, unknown> = {}
    if (plainDocIds.length) {
      metadata.documentIds = plainDocIds
      metadata.documents = documents
        .filter(doc => plainDocIds.includes(doc.id))
        .map(doc => ({ id: doc.id, title: doc.title }))
    }
    if (plainWorkRefs.length) {
      metadata.workReferences = plainWorkRefs
    }
    messages.value.push({
      id: localUserMessageId,
      conversation_id: conversationId.value,
      role: 'user',
      content: text.trim(),
      message_type: hasAttachments ? 'attachment' : 'text',
      metadata_json: hasAttachments ? JSON.stringify(metadata) : null,
      create_time: new Date().toISOString()
    })
    sending.value = true
    error.value = ''
    try {
      await window.anovel.invoke(
        'assistant:chat',
        conversationId.value,
        text.trim(),
        plainDocIds,
        plainWorkRefs
      )
    } catch (e) {
      messages.value = messages.value.filter(m => m.id !== localUserMessageId)
      error.value = e instanceof Error ? e.message : '发送失败'
      sending.value = false
      await loadMessages()
    }
  }

  async function cancel() {
    if (!conversationId.value) return
    await window.anovel.invoke('assistant:cancelChat', conversationId.value)
    sending.value = false
    streamingMessageId.value = null
    thinkingStreamingMessageId.value = null
  }

  async function editAndResend(
    messageId: number,
    newText: string,
    documentIds: number[] = [],
    workReferences: AssistantWorkReference[] = []
  ) {
    if (!conversationId.value || !newText.trim() || sending.value) return
    const plainDocIds = toPlainDocumentIds(documentIds)
    const plainWorkRefs = toPlainWorkReferences(workReferences)
    const previousMessages = [...messages.value]
    const keep = messages.value.filter(m => m.id < messageId)
    localMessageSeq += 1
    const localUserMessageId = -localMessageSeq
    const hasAttachments = plainDocIds.length > 0 || plainWorkRefs.length > 0
    const metadata: Record<string, unknown> = {}
    if (plainDocIds.length) metadata.documentIds = plainDocIds
    if (plainWorkRefs.length) metadata.workReferences = plainWorkRefs
    messages.value = [
      ...keep,
      {
        id: localUserMessageId,
        conversation_id: conversationId.value,
        role: 'user',
        content: newText.trim(),
        message_type: hasAttachments ? 'attachment' : 'text',
        metadata_json: hasAttachments ? JSON.stringify(metadata) : null,
        create_time: new Date().toISOString()
      }
    ]
    sending.value = true
    error.value = ''
    try {
      await window.anovel.invoke(
        'assistant:editAndResend',
        conversationId.value,
        messageId,
        newText.trim(),
        plainDocIds,
        plainWorkRefs
      )
    } catch (e) {
      messages.value = previousMessages
      error.value = e instanceof Error ? e.message : '重发失败'
      sending.value = false
      await loadMessages()
    }
  }

  async function clearMessages() {
    if (!conversationId.value) return
    await window.anovel.invoke('assistant:clearMessages', conversationId.value)
    error.value = ''
    sending.value = false
    streamingMessageId.value = null
    thinkingStreamingMessageId.value = null
    await loadMessages()
  }

  return {
    messages,
    sending,
    streamingMessageId,
    thinkingStreamingMessageId,
    error,
    loadMessages,
    send,
    cancel,
    editAndResend,
    clearMessages
  }
}
