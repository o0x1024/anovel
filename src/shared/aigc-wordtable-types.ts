/**
 * AIGC 词表替换条目类型
 * 支持两种模式：词级替换 和 正则替换
 */

export type WordTableEntryType = 'word' | 'regex'

export interface WordTableEntry {
  id: number
  /** 'word': 精确词/短语替换; 'regex': 用户自定义正则替换 */
  type: WordTableEntryType
  /** word: 要匹配的词; regex: 正则表达式（不含 //，如 不是[\s\S]+?是[\s\S]+?。） */
  source: string
  /** 替换目标，多个用 | 分隔（随机选一个）。regex 可用 $1/$2... 引用捕获组。为空表示删除 */
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
