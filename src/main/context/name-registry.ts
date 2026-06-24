import { coreSettingDAO, nameEntryDAO, volumeChapterDAO } from '../db'
import { loadCharacterCards } from './character-cards'
import { findSimilarNames } from './name-similarity'
import {
  NAME_CATEGORY_LABELS,
  type NameCategory,
  type NameSimilarityMatch,
  type UsedNamesSummary
} from '../../shared/name-registry-types'

/** 汇总作品内已用名称，供生成去重与冲突检测 */
export function collectUsedNames(workId: number): UsedNamesSummary {
  const characters = loadCharacterCards(workId)
    .map(c => c.name.trim())
    .filter(Boolean)

  const volumes = volumeChapterDAO.listVolumes(workId)
    .map(v => v.name.trim())
    .filter(Boolean)

  const adopted = nameEntryDAO.listAdoptedNames(workId)

  const allSet = new Set<string>()
  for (const n of [...characters, ...volumes, ...adopted]) {
    allSet.add(n)
  }

  return {
    characters,
    volumes,
    adopted,
    all: [...allSet]
  }
}

/** 检测名称是否与已有名称冲突（大小写不敏感） */
export function findNameConflict(workId: number, name: string, excludeId?: number): string | null {
  const trimmed = name.trim()
  if (!trimmed) return '名称不能为空'

  const lower = trimmed.toLowerCase()
  const used = collectUsedNames(workId)
  if (used.all.some(n => n.toLowerCase() === lower)) {
    return `与已有名称「${trimmed}」冲突`
  }

  const existing = nameEntryDAO.findByName(workId, trimmed, excludeId)
  if (existing) {
    return `名称库中已存在「${trimmed}」`
  }

  return null
}

/** 检测谐音/近义/易混淆名称（ advisory，不阻断保存） */
export function findNameSimilarityWarnings(
  workId: number,
  name: string,
  excludeId?: number
): NameSimilarityMatch[] {
  const trimmed = name.trim()
  if (!trimmed) return []

  const used = collectUsedNames(workId)
  const pool = used.all.filter(n => n.toLowerCase() !== trimmed.toLowerCase())

  const entryRows = nameEntryDAO.listByWork(workId)
  for (const row of entryRows) {
    if (row.id === excludeId) continue
    if (!pool.some(n => n.toLowerCase() === row.name.toLowerCase())) {
      pool.push(row.name)
    }
  }

  return findSimilarNames(trimmed, pool)
}

/** 格式化已采纳名称（按分类），供正文生成注入 */
export function formatAdoptedNamesForBodyContext(workId: number): string {
  const entries = nameEntryDAO.listByWork(workId, undefined, 'adopted')
  if (entries.length === 0) return ''

  const cardNames = new Set(
    loadCharacterCards(workId).map(c => c.name.trim().toLowerCase()).filter(Boolean)
  )

  const byCategory = new Map<NameCategory, string[]>()
  for (const entry of entries) {
    if (entry.category === 'character' && cardNames.has(entry.name.toLowerCase())) {
      continue
    }
    const list = byCategory.get(entry.category) ?? []
    list.push(entry.meaning ? `${entry.name}（${entry.meaning}）` : entry.name)
    byCategory.set(entry.category, list)
  }

  if (byCategory.size === 0) return ''

  const lines = ['【已确立名称 - 正文须统一使用下列称谓，勿另造易混淆新名】']
  for (const cat of ['character', 'skill', 'location', 'faction', 'item'] as NameCategory[]) {
    const names = byCategory.get(cat)
    if (names?.length) {
      lines.push(`${NAME_CATEGORY_LABELS[cat]}：${names.join('、')}`)
    }
  }
  return lines.join('\n')
}

/** 格式化已用名称块，注入 AI prompt */
export function formatUsedNamesBlock(workId: number): string {
  const used = collectUsedNames(workId)
  if (used.all.length === 0) return ''

  const lines: string[] = ['【作品已用名称 - 禁止重复或近似撞名】']
  if (used.characters.length) {
    lines.push(`角色：${used.characters.join('、')}`)
  }
  if (used.volumes.length) {
    lines.push(`分卷/地点相关：${used.volumes.join('、')}`)
  }
  if (used.adopted.length) {
    lines.push(`已采纳名称：${used.adopted.join('、')}`)
  }
  return lines.join('\n')
}

/** 从 core_settings 提取世界观摘要（截断） */
export function getWorldviewSnippet(workId: number, maxChars = 800): string {
  const row = coreSettingDAO.getByType(workId, 'world_pressure') ?? coreSettingDAO.getByType(workId, 'worldview')
  const text = row?.content?.trim()
  if (!text) return ''
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`
}
