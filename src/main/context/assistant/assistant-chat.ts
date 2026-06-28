import type { WebContents } from 'electron'
import {
  assistantConversationDAO,
  assistantDocumentDAO,
  assistantMessageDAO,
  assistantRoleDAO,
  writingStyleDAO,
  knowledgeNoteDAO
} from '../../db'
import { resolveAssistantGlobalRoleId } from './global-role'
import { modelService } from '../../model'
import { extractStyleFingerprint } from '../style-fingerprint'
import { sampleDocumentText } from './document-sampling'
import { buildWorkReferenceContext, buildWorkReferenceMetadata } from './work-reference'
import { extractStyleAnalysisFromReply, stripJsonBlockFromDisplay } from './style-analysis-parser'
import { resolveStepStyleInjection } from '../style-step-rules'
import { computeWorkChapterProgress, formatEvolutionPrompt } from '../style-evolution'
import { extractWorkSummaryFromReply } from './work-summary-parser'
import type { ModelType } from '../../model/types'
import type { StyleAnalysisResult, AssistantWorkReference } from './types'
import { MAX_STYLE_REFERENCE_TEXT_CHARS } from '../../../shared/style-reference-limits'

const activeChats = new Map<number, AbortController>()

const DEFAULT_ASSISTANT_SYSTEM_PROMPT = '你是一位写作助手，可以帮助用户解答写作、改稿与创作相关的问题。'

function buildWorkStyleAddonForAssistant(
  workReferences: AssistantWorkReference[]
): string {
  if (!workReferences.length) return ''
  const ref = workReferences[0]
  const styleId = writingStyleDAO.getWorkStyleId(ref.workId)
  if (!styleId) return ''
  const style = writingStyleDAO.getById(styleId)
  if (!style) return ''
  const injection = resolveStepStyleInjection(
    'assistant_chat',
    style.prompt_template,
    style.step_rules_json
  )
  const parts = [injection.stepRulesText].filter(Boolean)
  const binding = writingStyleDAO.getWorkStyleBinding(ref.workId)
  const progress = computeWorkChapterProgress(ref.workId, ref.chapterId ?? undefined)
  const evo = formatEvolutionPrompt(binding?.evolution_curve_json ?? null, progress)
  if (evo) parts.push(evo)
  if (!parts.length) return ''
  return `\n【引用作品已绑定文风 - 讨论与建议须对齐】\n${parts.join('\n\n')}`
}

function resolveAssistantRole(roleId: number | null) {
  if (roleId === null) {
    return {
      system_prompt: DEFAULT_ASSISTANT_SYSTEM_PROMPT,
      analysis_rules_json: null as string | null,
      capabilities_json: null as string | null
    }
  }
  const role = assistantRoleDAO.getById(roleId)
  if (!role) throw new Error('角色不存在')
  return role
}

function safeParseObject(json: string | null): Record<string, unknown> {
  if (!json) return {}
  try {
    const parsed = JSON.parse(json) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore malformed metadata
  }
  return {}
}

function buildAttachmentMetadata(
  documentIds: number[],
  workReferences: AssistantWorkReference[] = []
): Record<string, unknown> | null {
  const documents: Array<{ id: number; title: string }> = []
  for (const id of documentIds) {
    const doc = assistantDocumentDAO.getById(id)
    if (!doc) continue
    documents.push({ id: doc.id, title: doc.title })
  }

  const metadata: Record<string, unknown> = {}
  if (documentIds.length) metadata.documentIds = documentIds
  if (documents.length) metadata.documents = documents

  const workMeta = buildWorkReferenceMetadata(workReferences)
  if (workMeta?.workReferences) {
    metadata.workReferences = workMeta.workReferences
  }

  return Object.keys(metadata).length ? metadata : null
}

function updateAssistantMetadata(messageId: number, patch: Record<string, unknown>): void {
  const row = assistantMessageDAO.getById(messageId)
  if (!row) return
  const merged = { ...safeParseObject(row.metadata_json), ...patch }
  assistantMessageDAO.updateContent(row.id, row.content, JSON.stringify(merged), row.message_type)
}

function buildDocumentContext(documentIds: number[]): string {
  const parts: string[] = []
  for (const docId of documentIds) {
    const doc = assistantDocumentDAO.getById(docId)
    if (!doc?.content_text?.trim()) continue
    parts.push(sampleDocumentText(doc.content_text))
  }
  return parts.join('\n\n')
}

function buildReferenceContext(
  documentIds: number[],
  workReferences: AssistantWorkReference[] = [],
  knowledgeNoteIds: number[] = []
): string {
  const docContext = buildDocumentContext(documentIds)
  const workContext = buildWorkReferenceContext(workReferences)
  const kbContext = buildKnowledgeNoteContext(knowledgeNoteIds)
  return [docContext, workContext, kbContext].filter(Boolean).join('\n\n').trim()
}

function buildKnowledgeNoteContext(noteIds: number[]): string {
  const parts: string[] = []
  for (const id of noteIds) {
    const note = knowledgeNoteDAO.getById(id)
    if (!note?.content?.trim()) continue
    const label = note.title ? `【知识笔记：${note.title}】` : '【知识笔记】'
    parts.push(`${label}\n${note.content.trim()}`)
  }
  return parts.join('\n\n')
}

function buildUserPrompt(
  history: { id: number; role: string; content: string }[],
  userText: string,
  docContext: string,
  excludeMessageIds: number[]
): string {
  const exclude = new Set(excludeMessageIds)
  const historyLines = history
    .filter(m => !exclude.has(m.id) && m.content.trim())
    .map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`)

  return [
    historyLines.length ? `【对话历史】\n${historyLines.join('\n\n')}` : '',
    docContext
      ? `【当前消息】\n${userText}\n\n【用户引用】\n${docContext}`
      : `【当前消息】\n${userText}`
  ].filter(Boolean).join('\n\n')
}

export async function runAssistantChat(
  sender: WebContents,
  conversationId: number,
  userText: string,
  documentIds: number[] = [],
  workReferences: AssistantWorkReference[] = [],
  knowledgeNoteIds: number[] = []
): Promise<{ userMessageId: number; assistantMessageId: number }> {
  activeChats.get(conversationId)?.abort()
  const controller = new AbortController()
  activeChats.set(conversationId, controller)

  const conv = assistantConversationDAO.getById(conversationId)
  if (!conv) throw new Error('会话不存在')
  const role = resolveAssistantRole(resolveAssistantGlobalRoleId())

  const trimmed = userText.trim()
  if (!trimmed) throw new Error('消息不能为空')

  const hasAttachments = documentIds.length > 0 || workReferences.length > 0 || knowledgeNoteIds.length > 0
  const attachmentMetadata = buildAttachmentMetadata(documentIds, workReferences)
  if (knowledgeNoteIds.length && attachmentMetadata) {
    (attachmentMetadata as Record<string, unknown>).knowledgeNoteIds = knowledgeNoteIds
  }
  const userMessageId = assistantMessageDAO.create({
    conversation_id: conversationId,
    role: 'user',
    content: trimmed,
    message_type: hasAttachments ? 'attachment' : 'text',
    metadata_json: attachmentMetadata ? JSON.stringify(attachmentMetadata) : null
  })

  const docContext = buildReferenceContext(documentIds, workReferences, knowledgeNoteIds)
  const rules: string[] = role.analysis_rules_json ? JSON.parse(role.analysis_rules_json) : []
  const workStyleAddon = buildWorkStyleAddonForAssistant(workReferences)
  const systemPrompt = [
    role.system_prompt,
    rules.length ? `\n【解析规则】\n${rules.map(r => `- ${r}`).join('\n')}` : '',
    workStyleAddon
  ].join('')

  const assistantMessageId = assistantMessageDAO.create({
    conversation_id: conversationId,
    role: 'assistant',
    content: '',
    message_type: 'text',
    metadata_json: null
  })

  const priorRows = assistantMessageDAO.listByConversation(conversationId)
  const userPrompt = buildUserPrompt(
    priorRows,
    trimmed,
    docContext,
    [userMessageId, assistantMessageId]
  )

  let fullContent = ''
  let thinkingContent = ''

  try {
    const res = await modelService.chat(
      {
        prompt: userPrompt,
        systemPrompt,
        step: 'assistant_chat',
        enrichWorkContext: false,
        enrichNarrativeMemory: false,
        modelType: conv.model_type ? conv.model_type as ModelType : undefined,
        modelName: conv.model_name ?? undefined
      },
      {
        signal: controller.signal,
        stream: true,
        suppressPhases: true,
        onDelta: (delta) => {
          fullContent += delta
          assistantMessageDAO.updateContent(assistantMessageId, fullContent)
          sender.send('assistant:delta', {
            conversationId,
            messageId: assistantMessageId,
            delta,
            content: fullContent
          })
        },
        onThinkingDelta: (delta) => {
          thinkingContent += delta
          updateAssistantMetadata(assistantMessageId, { thinking: thinkingContent })
          sender.send('assistant:thinking-delta', {
            conversationId,
            messageId: assistantMessageId,
            delta,
            thinking: thinkingContent
          })
        }
      }
    )

    if (res.cancelled) {
      sender.send('assistant:chat-end', {
        conversationId,
        messageId: assistantMessageId,
        success: false,
        error: '已取消'
      })
      return { userMessageId, assistantMessageId }
    }

    if (!res.success) {
      throw new Error(res.error || '对话失败')
    }

    fullContent = res.content || fullContent
    const capabilities: string[] = role.capabilities_json ? JSON.parse(role.capabilities_json) : []
    let metadata: Record<string, unknown> | null = null
    let messageType: 'text' | 'tool_result' = 'text'
    let displayContent = fullContent

    if (capabilities.includes('style_export')) {
      const analysis = extractStyleAnalysisFromReply(fullContent)
      if (analysis) {
        metadata = { ...(metadata ?? {}), styleAnalysis: analysis }
        messageType = 'tool_result'
        displayContent = stripJsonBlockFromDisplay(fullContent) || '文风分析完成，请查看下方卡片。'
      }
    }

    if (capabilities.includes('summary_export')) {
      const summary = extractWorkSummaryFromReply(fullContent)
      if (summary) {
        metadata = { ...(metadata ?? {}), workSummary: summary }
        messageType = 'tool_result'
        if (!capabilities.includes('style_export') || displayContent === fullContent) {
          displayContent = stripJsonBlockFromDisplay(fullContent) || '作品导读完成，请查看下方卡片。'
        }
      }
    }

    if (thinkingContent.trim()) {
      metadata = { ...(metadata ?? {}), thinking: thinkingContent }
    }

    assistantMessageDAO.updateContent(
      assistantMessageId,
      displayContent,
      metadata ? JSON.stringify(metadata) : null,
      messageType
    )
    assistantConversationDAO.touch(conversationId)

    if (conv.title === '新对话' && trimmed.length > 0) {
      assistantConversationDAO.updateTitle(conversationId, trimmed.slice(0, 40))
    }

    sender.send('assistant:chat-end', {
      conversationId,
      messageId: assistantMessageId,
      success: true
    })
    return { userMessageId, assistantMessageId }
  } catch (err) {
    const msg = err instanceof Error ? err.message : '对话失败'
    const fallbackMetadata = thinkingContent.trim() ? JSON.stringify({ thinking: thinkingContent }) : undefined
    if (fullContent) {
      assistantMessageDAO.updateContent(assistantMessageId, fullContent, fallbackMetadata)
    } else {
      assistantMessageDAO.updateContent(assistantMessageId, `（失败：${msg}）`, fallbackMetadata)
    }
    sender.send('assistant:chat-end', {
      conversationId,
      messageId: assistantMessageId,
      success: false,
      error: msg
    })
    throw err
  } finally {
    activeChats.delete(conversationId)
  }
}

export function cancelAssistantChat(conversationId: number): boolean {
  const c = activeChats.get(conversationId)
  if (!c) return false
  c.abort()
  activeChats.delete(conversationId)
  return true
}

export function clearAssistantConversationMessages(conversationId: number): void {
  cancelAssistantChat(conversationId)
  const conv = assistantConversationDAO.getById(conversationId)
  if (!conv) throw new Error('会话不存在')
  assistantMessageDAO.deleteByConversation(conversationId)
  assistantConversationDAO.touch(conversationId)
}

export async function editAndResendAssistantChat(
  sender: WebContents,
  conversationId: number,
  messageId: number,
  newText: string,
  documentIds?: number[],
  workReferences?: AssistantWorkReference[],
  knowledgeNoteIds?: number[]
): Promise<{ userMessageId: number; assistantMessageId: number }> {
  const msg = assistantMessageDAO.getById(messageId)
  if (!msg || msg.conversation_id !== conversationId) {
    throw new Error('消息不存在')
  }
  if (msg.role !== 'user') {
    throw new Error('只能编辑用户消息')
  }

  let docIds = documentIds ?? []
  let workRefs = workReferences ?? []
  let kbIds = knowledgeNoteIds ?? []
  if (msg.metadata_json) {
    try {
      const meta = JSON.parse(msg.metadata_json) as {
        documentIds?: number[]
        workReferences?: AssistantWorkReference[]
        knowledgeNoteIds?: number[]
      }
      if (!docIds.length) docIds = meta.documentIds ?? []
      if (!workRefs.length) workRefs = meta.workReferences ?? []
      if (!kbIds.length) kbIds = meta.knowledgeNoteIds ?? []
    } catch {
      // ignore malformed metadata
    }
  }

  assistantMessageDAO.deleteFromId(conversationId, messageId)
  return runAssistantChat(sender, conversationId, newText, docIds, workRefs, kbIds)
}

export function exportStyleFromAnalysis(
  analysis: StyleAnalysisResult,
  options?: { overwriteStyleId?: number; rename?: string }
): number {
  const name = (options?.rename ?? analysis.styleName).trim()
  if (!name) throw new Error('文风名称不能为空')

  const sample_text = analysis.sampleExcerpts.join('\n\n').slice(0, 3000)
  if (!sample_text.trim()) throw new Error('样例段落为空，无法保存文风')

  const reference_text = analysis.referenceText?.trim().slice(0, MAX_STYLE_REFERENCE_TEXT_CHARS) || undefined
  const stepRulesJson = analysis.stepRules ? JSON.stringify(analysis.stepRules) : undefined

  if (options?.overwriteStyleId) {
    writingStyleDAO.update(options.overwriteStyleId, {
      name,
      description: analysis.description,
      sample_text,
      reference_text: reference_text ?? null,
      prompt_template: analysis.promptTemplate,
      step_rules_json: stepRulesJson ?? null
    })
    const fp = extractStyleFingerprint(sample_text)
    writingStyleDAO.update(options.overwriteStyleId, { fingerprint_json: JSON.stringify(fp) })
    return options.overwriteStyleId
  }

  const existing = writingStyleDAO.getByName(name)
  if (existing) {
    throw new Error(`文风名称「${name}」已存在`)
  }

  const id = writingStyleDAO.create({
    name,
    description: analysis.description,
    sample_text,
    reference_text,
    prompt_template: analysis.promptTemplate,
    step_rules_json: stepRulesJson
  })
  const fp = extractStyleFingerprint(sample_text)
  writingStyleDAO.update(id, { fingerprint_json: JSON.stringify(fp) })
  return id
}
