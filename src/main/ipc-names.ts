import { ipcMain } from 'electron'
import { nameEntryDAO } from './db'
import {
  adoptNameEntry,
  generateNameCandidates,
  rejectNameEntry
} from './context/name-generate'
import { collectUsedNames, findNameConflict, findNameSimilarityWarnings } from './context/name-registry'
import {
  CHARACTER_CARD_TEMPLATE,
  loadCharacterCards,
  saveCharacterCards,
  type CharacterRole
} from './context/character-cards'
import type {
  NameCategory,
  NameEntryCreateInput,
  NameEntryStatus,
  NameGenerateInput
} from '../shared/name-registry-types'

export function registerNamesIpcHandlers(): void {
  ipcMain.handle('name:list', (_e, workId: number, category?: NameCategory, status?: NameEntryStatus) =>
    nameEntryDAO.listByWork(workId, category, status))

  ipcMain.handle('name:usedNames', (_e, workId: number) => collectUsedNames(workId))

  ipcMain.handle('name:similarityCheck', (_e, workId: number, name: string, excludeId?: number) =>
    findNameSimilarityWarnings(workId, name, excludeId))

  ipcMain.handle('name:create', (_e, input: NameEntryCreateInput) => {
    const conflict = findNameConflict(input.work_id, input.name)
    if (conflict) return { success: false, error: conflict }
    const id = nameEntryDAO.create(input)
    return { success: true, entry: nameEntryDAO.getById(id) }
  })

  ipcMain.handle('name:update', (_e, id: number, patch: { name?: string; meaning?: string | null; status?: NameEntryStatus }) => {
    const row = nameEntryDAO.getById(id)
    if (!row) return { success: false, error: '名称不存在' }
    if (patch.name) {
      const conflict = findNameConflict(row.work_id, patch.name, id)
      if (conflict) return { success: false, error: conflict }
    }
    nameEntryDAO.update(id, patch)
    return { success: true, entry: nameEntryDAO.getById(id) }
  })

  ipcMain.handle('name:delete', (_e, id: number) => {
    const ok = nameEntryDAO.delete(id)
    return { success: ok }
  })

  ipcMain.handle('name:generate', async (e, input: NameGenerateInput) =>
    generateNameCandidates(input.workId, input.category, input.constraints ?? {}, {
      webContents: e.sender,
      modelType: input.modelType,
      modelName: input.modelName,
      thinkingEnabled: input.thinkingEnabled
    }))

  ipcMain.handle('name:adopt', (_e, workId: number, entryId: number, linkedEntity?: string) =>
    adoptNameEntry(workId, entryId, linkedEntity))

  ipcMain.handle('name:reject', (_e, workId: number, entryId: number) => ({
    success: rejectNameEntry(workId, entryId)
  }))

  ipcMain.handle(
    'name:adoptToCharacterCard',
    (_e, workId: number, entryId: number, role: CharacterRole = 'supporting') => {
      const row = nameEntryDAO.getById(entryId)
      if (!row || row.work_id !== workId) {
        return { success: false, error: '名称不存在' }
      }
      if (row.category !== 'character') {
        return { success: false, error: '仅角色类名称可写入人设卡片' }
      }

      const cards = loadCharacterCards(workId)
      if (cards.some(c => c.name.trim().toLowerCase() === row.name.trim().toLowerCase())) {
        return { success: false, error: '人设卡片中已有同名角色' }
      }

      cards.push({
        ...CHARACTER_CARD_TEMPLATE,
        name: row.name,
        role,
        memoryTag: row.meaning ?? CHARACTER_CARD_TEMPLATE.memoryTag
      })
      saveCharacterCards(workId, cards)
      adoptNameEntry(workId, entryId, 'character_card')
      return { success: true, cards }
    }
  )
}
