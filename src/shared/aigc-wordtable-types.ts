/**
 * AIGC 词表替换条目类型
 * 支持两种模式：词级替换 和 句式模板替换
 */

export type WordTableEntryType = 'word' | 'pattern'

export interface WordTableEntry {
  id: number
  /** 'word': 简单词/短语替换; 'pattern': 句式模板替换（支持通配符） */
  type: WordTableEntryType
  /** 要匹配的原文词或句式模板。句式模板用 ... 表示中间可变内容，如 "不是...而是" */
  source: string
  /** 替换目标，多个用 | 分隔（随机选一个）。为空表示直接删除 */
  target: string
  /** 是否启用 */
  enabled: boolean
  create_time: string
  update_time: string
}

export interface WordTableEntryInput {
  type: WordTableEntryType
  source: string
  target: string
  enabled?: boolean
}

export interface WordTableEntryRow {
  id: number
  type: string
  source: string
  target: string
  enabled: number
  create_time: string
  update_time: string
}
