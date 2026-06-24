import type { WebContents } from 'electron'
import { nameEntryDAO } from '../db'
import { modelService } from '../model'
import { extractJsonText } from './parse-json-extract'
import {
  collectUsedNames,
  findNameConflict,
  formatUsedNamesBlock,
  getWorldviewSnippet
} from './name-registry'
import {
  NAME_CATEGORY_LABELS,
  type GeneratedNameCandidate,
  type NameCategory,
  type NameGenerateConstraints,
  type NameGenerateResult
} from '../../shared/name-registry-types'

const DEFAULT_COUNT = 8
const MAX_COUNT = 15

const NAME_GENERATE_SYSTEM = [
  '你是网文与类型小说领域的命名专家，为作者生成原创、好记、有质感的名称。',
  '',
  '通用规则：',
  '1. 名称须原创，禁止直接使用知名作品中的角色名、技能名、地名',
  '2. 须与 user 消息中的世界观、风格约束一致',
  '3. 须避开 user 消息列出的「已用名称」，不得重复或仅改一字',
  '4. 同类名称之间应有明显差异（读音、字形、气质）',
  '5. 角色名：2-4 字为宜，兼顾记忆点与身份感',
  '6. 技能名：可对仗、可意象化，避免空泛的「超级XX术」',
  '7. 地点/势力名：应有地域或文化暗示，避免与常见现实地名雷同',
  '8. 物品名：可暗示功能或来历，不宜过长',
  '',
  '输出格式：仅输出 ```json ... ```，内容为对象数组，每项：',
  '{ "name": "名称", "meaning": "寓意或构词说明（可选）", "note": "适用场景建议（可选）" }'
].join('\n')

function parseGeneratedNames(content: string): GeneratedNameCandidate[] {
  const jsonText = extractJsonText(content)
  if (!jsonText) return []

  try {
    const parsed = JSON.parse(jsonText) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as { names?: unknown }).names)
        ? (parsed as { names: unknown[] }).names
        : null
    if (!list) return []

    const out: GeneratedNameCandidate[] = []
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const name = typeof row.name === 'string' ? row.name.trim() : ''
      if (!name) continue
      out.push({
        name,
        meaning: typeof row.meaning === 'string' ? row.meaning.trim() : undefined,
        note: typeof row.note === 'string' ? row.note.trim() : undefined
      })
    }
    return out
  } catch {
    return []
  }
}

function filterNonConflicting(
  workId: number,
  candidates: GeneratedNameCandidate[]
): { kept: GeneratedNameCandidate[]; conflicts: string[] } {
  const usedLower = new Set(collectUsedNames(workId).all.map(n => n.toLowerCase()))
  const seen = new Set<string>()
  const kept: GeneratedNameCandidate[] = []
  const conflicts: string[] = []

  for (const c of candidates) {
    const lower = c.name.toLowerCase()
    if (usedLower.has(lower) || seen.has(lower)) {
      conflicts.push(c.name)
      continue
    }
    seen.add(lower)
    kept.push(c)
  }
  return { kept, conflicts }
}

function buildUserPrompt(
  category: NameCategory,
  constraints: NameGenerateConstraints,
  workId: number
): string {
  const count = Math.min(MAX_COUNT, Math.max(3, constraints.count ?? DEFAULT_COUNT))
  const parts: string[] = [
    `【生成类型】${NAME_CATEGORY_LABELS[category]}`,
    `【数量】${count} 个`,
    formatUsedNamesBlock(workId),
    ''
  ]

  const worldview = getWorldviewSnippet(workId)
  if (worldview) {
    parts.push('【世界观参考】', worldview, '')
  }

  if (constraints.style?.trim()) {
    parts.push(`【风格约束】${constraints.style.trim()}`)
  }
  if (constraints.gender?.trim() && category === 'character') {
    parts.push(`【性别倾向】${constraints.gender.trim()}`)
  }
  if (constraints.extra?.trim()) {
    parts.push(`【额外要求】${constraints.extra.trim()}`)
  }

  parts.push(
    '',
    '请生成符合以上约束的名称候选。输出 JSON 数组，每项含 name（必填）、meaning（寓意/词源，可选）、note（使用建议，可选）。',
    '只输出 ```json ... ``` 代码块，不要其他解释。'
  )

  return parts.filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== '')).join('\n')
}

export async function generateNameCandidates(
  workId: number,
  category: NameCategory,
  constraints: NameGenerateConstraints = {},
  options?: {
    webContents?: WebContents
    modelType?: string
    modelName?: string
    thinkingEnabled?: boolean
  }
): Promise<NameGenerateResult> {
  const systemPrompt = NAME_GENERATE_SYSTEM
  const userPrompt = buildUserPrompt(category, constraints, workId)

  const res = await modelService.chat(
    {
      prompt: userPrompt,
      systemPrompt,
      workId,
      step: 'name_generate',
      enrichWorkContext: true,
      workContextOptions: {
        includeIdea: true,
        includeIncubator: false,
        includeCoreSettings: true,
        includeVolumes: false,
        includeQualityIssues: false,
        excludeCoreTypes: ['character']
      },
      enrichNarrativeMemory: false,
      temperature: 0.9,
      ...(options?.modelType ? { modelType: options.modelType, modelName: options.modelName } : {}),
      ...(options?.thinkingEnabled !== undefined ? { thinkingEnabled: options.thinkingEnabled } : {})
    },
    { webContents: options?.webContents }
  )

  if (!res.success) {
    return { success: false, error: res.error || '生成失败' }
  }

  const parsed = parseGeneratedNames(res.content)
  if (parsed.length === 0) {
    return { success: false, error: 'AI 返回格式无效，未找到名称 JSON 数组，请重试' }
  }

  const { kept, conflicts } = filterNonConflicting(workId, parsed)
  if (kept.length === 0) {
    return {
      success: false,
      error: '生成的名称均与已有名称冲突，请调整约束后重试',
      conflicts
    }
  }

  const constraintsJson = JSON.stringify(constraints)
  const ids = nameEntryDAO.createMany(
    kept.map(c => ({
      work_id: workId,
      category,
      name: c.name,
      meaning: c.meaning,
      constraints_json: constraintsJson,
      status: 'candidate' as const,
      source: 'ai' as const
    }))
  )

  const rows = ids.map(id => nameEntryDAO.getById(id)).filter(Boolean)
  return {
    success: true,
    candidates: rows.map(r => ({
      name: r!.name,
      meaning: r!.meaning ?? undefined,
      note: undefined
    })),
    conflicts: conflicts.length ? conflicts : undefined
  }
}

export function adoptNameEntry(
  workId: number,
  entryId: number,
  linkedEntity?: string
): { success: boolean; error?: string } {
  const row = nameEntryDAO.getById(entryId)
  if (!row || row.work_id !== workId) {
    return { success: false, error: '名称不存在' }
  }

  if (row.status !== 'adopted') {
    const conflict = findNameConflict(workId, row.name, entryId)
    if (conflict) {
      return { success: false, error: conflict }
    }
  }

  nameEntryDAO.updateStatus(entryId, 'adopted', linkedEntity ?? row.linked_entity)
  return { success: true }
}

export function rejectNameEntry(workId: number, entryId: number): boolean {
  const row = nameEntryDAO.getById(entryId)
  if (!row || row.work_id !== workId) return false
  return nameEntryDAO.updateStatus(entryId, 'rejected')
}
