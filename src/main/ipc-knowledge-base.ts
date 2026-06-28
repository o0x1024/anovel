import { ipcMain } from 'electron'
import { knowledgeNoteDAO } from './db'
import type { KnowledgeNoteCreateInput, KnowledgeNoteUpdateInput } from './db'

export function registerKnowledgeBaseIpcHandlers(): void {
  ipcMain.handle('kb:list', () => knowledgeNoteDAO.list())

  ipcMain.handle('kb:get', (_e, id: number) => knowledgeNoteDAO.getById(id))

  ipcMain.handle('kb:search', (_e, keyword: string) => knowledgeNoteDAO.search(keyword))

  ipcMain.handle('kb:listByTag', (_e, tag: string) => knowledgeNoteDAO.listByTag(tag))

  ipcMain.handle('kb:allTags', () => knowledgeNoteDAO.allTags())

  ipcMain.handle('kb:create', (_e, input: KnowledgeNoteCreateInput) => {
    const id = knowledgeNoteDAO.create(input)
    return knowledgeNoteDAO.getById(id)
  })

  ipcMain.handle('kb:update', (_e, id: number, input: KnowledgeNoteUpdateInput) => {
    knowledgeNoteDAO.update(id, input)
    return knowledgeNoteDAO.getById(id)
  })

  ipcMain.handle('kb:delete', (_e, id: number) => knowledgeNoteDAO.delete(id))

  ipcMain.handle('kb:togglePin', (_e, id: number) => {
    knowledgeNoteDAO.togglePin(id)
    return knowledgeNoteDAO.getById(id)
  })
}
