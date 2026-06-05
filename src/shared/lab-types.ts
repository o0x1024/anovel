export type LabTaskStatus = 'pending' | 'running' | 'done' | 'error'

export interface LabTaskRow {
  id: number
  original_text: string
  result_text: string | null
  style_id: number
  system_prompt: string | null
  anti_ai_rules_json: string | null
  status: LabTaskStatus
  error_message: string | null
  source_file: string | null
  char_count: number
  create_time: string
  update_time: string
}

export interface LabTaskCreateInput {
  originalText: string
  styleId: number
  systemPrompt: string
  sourceFile?: string
  /** 选中的去 AI 规则文案；默认不传或空数组表示不注入 */
  antiAiRules?: string[]
}

export interface LabUploadParseInput {
  fileName: string
  base64: string
}
