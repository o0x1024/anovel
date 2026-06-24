/** 名称库分类 */
export type NameCategory = 'character' | 'skill' | 'location' | 'faction' | 'item'

export type NameEntryStatus = 'candidate' | 'adopted' | 'rejected'

export type NameEntrySource = 'manual' | 'ai'

export const NAME_CATEGORIES: NameCategory[] = [
  'character',
  'skill',
  'location',
  'faction',
  'item'
]

export const NAME_CATEGORY_LABELS: Record<NameCategory, string> = {
  character: '角色',
  skill: '技能',
  location: '地点',
  faction: '势力',
  item: '物品'
}

export const NAME_STATUS_LABELS: Record<NameEntryStatus, string> = {
  candidate: '候选',
  adopted: '已采纳',
  rejected: '已废弃'
}

export interface NameGenerateConstraints {
  style?: string
  count?: number
  gender?: string
  extra?: string
}

export interface NameEntryRow {
  id: number
  work_id: number
  category: NameCategory
  name: string
  meaning: string | null
  constraints_json: string | null
  status: NameEntryStatus
  linked_entity: string | null
  source: NameEntrySource
  create_time: string
}

export interface NameEntryCreateInput {
  work_id: number
  category: NameCategory
  name: string
  meaning?: string
  constraints_json?: string
  status?: NameEntryStatus
  source?: NameEntrySource
}

export interface NameGenerateInput {
  workId: number
  category: NameCategory
  constraints?: NameGenerateConstraints
  modelType?: string
  modelName?: string
  thinkingEnabled?: boolean
}

export interface GeneratedNameCandidate {
  name: string
  meaning?: string
  note?: string
}

export interface NameGenerateResult {
  success: boolean
  candidates?: GeneratedNameCandidate[]
  conflicts?: string[]
  error?: string
}

export interface UsedNamesSummary {
  characters: string[]
  volumes: string[]
  adopted: string[]
  all: string[]
}

export type NameSimilarityKind = 'homophone' | 'near' | 'prefix' | 'contains'

export interface NameSimilarityMatch {
  name: string
  kind: NameSimilarityKind
  message: string
}
