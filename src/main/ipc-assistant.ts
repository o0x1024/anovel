import { ipcMain } from 'electron'
import {
  appPreferenceDAO,
  assistantConversationDAO,
  assistantDocumentDAO,
  assistantMessageDAO,
  assistantRoleDAO
} from './db'
import type { StyleAnalysisResult, AssistantWorkReference } from './context/assistant/types'
import { broadcastStyleChanged } from './style-events'
import {
  cancelAssistantChat,
  clearAssistantConversationMessages,
  editAndResendAssistantChat,
  exportStyleFromAnalysis,
  runAssistantChat
} from './context/assistant/assistant-chat'
import { extractTextFromDocx } from './context/assistant/docx-extract'
import { resetBuiltinRole } from './db/assistant-seed'
import { ASSISTANT_GLOBAL_ROLE_KEY } from './context/assistant/global-role'

export function registerAssistantIpcHandlers(): void {
  ipcMain.handle('assistant:roleList', () => assistantRoleDAO.list())
  ipcMain.handle('assistant:roleGet', (_e, id: number) => assistantRoleDAO.getById(id))
  ipcMain.handle('assistant:roleCreate', (_e, input: Record<string, unknown>) =>
    assistantRoleDAO.create(input as Parameters<typeof assistantRoleDAO.create>[0]))
  ipcMain.handle('assistant:roleUpdate', (_e, id: number, input: Record<string, unknown>) =>
    assistantRoleDAO.update(id, input as Parameters<typeof assistantRoleDAO.update>[1]))
  ipcMain.handle('assistant:roleDelete', (_e, id: number) => assistantRoleDAO.delete(id))
  ipcMain.handle('assistant:roleClone', (_e, id: number, newName: string) =>
    assistantRoleDAO.clone(id, newName))
  ipcMain.handle('assistant:roleResetBuiltin', (_e, id: number) => resetBuiltinRole(id))
  ipcMain.handle('assistant:getGlobalRole', () => {
    const raw = appPreferenceDAO.getPreference(ASSISTANT_GLOBAL_ROLE_KEY)
    const roleId = raw ? Number(raw) : NaN
    return Number.isFinite(roleId) && roleId > 0 ? roleId : null
  })
  ipcMain.handle('assistant:setGlobalRole', (_e, roleId: number | null) => {
    if (roleId === null) {
      appPreferenceDAO.setPreference(ASSISTANT_GLOBAL_ROLE_KEY, null)
      return null
    }
    const role = assistantRoleDAO.getById(roleId)
    if (!role) throw new Error('角色不存在')
    appPreferenceDAO.setPreference(ASSISTANT_GLOBAL_ROLE_KEY, String(roleId))
    return roleId
  })

  ipcMain.handle('assistant:docUpload', (_e, input: {
    title?: string
    fileName?: string
    content: string
  }) => {
    const id = assistantDocumentDAO.create({
      title: input.title?.trim() || input.fileName?.trim() || '未命名文档',
      file_name: input.fileName,
      content_text: input.content
    })
    return assistantDocumentDAO.getById(id)
  })

  ipcMain.handle('assistant:docUploadBinary', async (_e, input: {
    title?: string
    fileName: string
    base64: string
  }) => {
    const buffer = Buffer.from(input.base64, 'base64')
    const content = await extractTextFromDocx(buffer)
    const id = assistantDocumentDAO.create({
      title: input.title?.trim() || input.fileName.replace(/\.docx$/i, '') || '未命名文档',
      file_name: input.fileName,
      content_text: content
    })
    return assistantDocumentDAO.getById(id)
  })

  ipcMain.handle('assistant:docList', () => assistantDocumentDAO.list())
  ipcMain.handle('assistant:docGet', (_e, id: number) => assistantDocumentDAO.getById(id))
  ipcMain.handle('assistant:docUpdate', (_e, id: number, input: {
    title?: string
    fileName?: string
    content: string
  }) => {
    const ok = assistantDocumentDAO.update(id, {
      title: input.title?.trim() || input.fileName?.trim() || '未命名文档',
      file_name: input.fileName,
      content_text: input.content
    })
    return ok ? assistantDocumentDAO.getById(id) : undefined
  })
  ipcMain.handle('assistant:docDelete', (_e, id: number) => assistantDocumentDAO.delete(id))

  ipcMain.handle('assistant:convList', () => assistantConversationDAO.list())
  ipcMain.handle('assistant:convGet', (_e, id: number) => assistantConversationDAO.getById(id))
  ipcMain.handle('assistant:convCreate', (_e, input?: {
    title?: string
    documentIds?: number[]
  }) => {
    const id = assistantConversationDAO.create({
      role_id: null,
      title: input?.title,
      document_ids: input?.documentIds
    })
    return assistantConversationDAO.getById(id)
  })
  ipcMain.handle('assistant:convUpdate', (_e, id: number, title: string) => {
    assistantConversationDAO.updateTitle(id, title)
    return assistantConversationDAO.getById(id)
  })
  ipcMain.handle('assistant:convUpdateModel', (
    _e,
    id: number,
    modelType: string | null,
    modelName?: string | null
  ) => {
    assistantConversationDAO.updateModel(id, modelType, modelName ?? null)
    return assistantConversationDAO.getById(id)
  })
  ipcMain.handle('assistant:convDelete', (_e, id: number) => {
    assistantMessageDAO.deleteByConversation(id)
    return assistantConversationDAO.delete(id)
  })

  ipcMain.handle('assistant:messageList', (_e, conversationId: number) =>
    assistantMessageDAO.listByConversation(conversationId))

  ipcMain.handle('assistant:clearMessages', (_e, conversationId: number) => {
    clearAssistantConversationMessages(conversationId)
    return assistantConversationDAO.getById(conversationId)
  })

  ipcMain.handle('assistant:chat', async (
    e,
    conversationId: number,
    userText: string,
    documentIds?: number[],
    workReferences?: AssistantWorkReference[]
  ) => runAssistantChat(
    e.sender,
    conversationId,
    userText,
    documentIds ?? [],
    workReferences ?? []
  ))

  ipcMain.handle('assistant:editAndResend', async (
    e,
    conversationId: number,
    messageId: number,
    newText: string,
    documentIds?: number[],
    workReferences?: AssistantWorkReference[]
  ) => editAndResendAssistantChat(
    e.sender,
    conversationId,
    messageId,
    newText,
    documentIds,
    workReferences
  ))

  ipcMain.handle('assistant:cancelChat', (_e, conversationId: number) =>
    cancelAssistantChat(conversationId))

  ipcMain.handle('assistant:exportStyle', (e, analysis: StyleAnalysisResult, options?: {
    overwriteStyleId?: number
    rename?: string
  }) => {
    const id = exportStyleFromAnalysis(analysis, options)
    broadcastStyleChanged(id)
    return id
  })
}
