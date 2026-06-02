import type { StyleStepRules } from './style-step-rules'

export interface StyleAnalysisResult {
  styleName: string
  description: string
  dimensions: {
    sentenceRhythm: string
    dialogueStyle: string
    narrativeDistance: string
    rhetoricPrefs: string[]
    pacing: string
    vocabularyNotes: string
    taboos: string[]
  }
  promptTemplate: string
  sampleExcerpts: string[]
  /** 参考范文（3000-5000字），用于 few-shot 风格注入 */
  referenceText?: string
  confidence: 'high' | 'medium' | 'low'
  warnings: string[]
  /** 分步创作规则，供大纲/设定/自检阶段注入 */
  stepRules?: StyleStepRules
}

export interface WorkSummaryResult {
  title: string
  logline: string
  characters: { name: string; role: string; traits: string }[]
  plotOutline: string[]
  themes: string[]
  pacingNotes: string
  confidence: 'high' | 'medium' | 'low'
  warnings: string[]
}

export type AssistantMessageType = 'text' | 'attachment' | 'tool_result'
export type AssistantMessageRole = 'user' | 'assistant' | 'system'

export interface AssistantRoleRow {
  id: number
  name: string
  description: string | null
  icon: string
  system_prompt: string
  analysis_rules_json: string | null
  capabilities_json: string | null
  is_builtin: number
  create_time: string
  update_time: string
}

export interface AssistantDocumentRow {
  id: number
  title: string
  file_name: string | null
  content_text: string
  char_count: number
  fingerprint_json: string | null
  create_time: string
}

export interface AssistantConversationRow {
  id: number
  role_id: number | null
  title: string
  document_ids_json: string | null
  model_type: string | null
  model_name: string | null
  create_time: string
  update_time: string
}

export interface AssistantModelOption {
  model_type: string
  model_name: string
}

export interface AssistantMessageRow {
  id: number
  conversation_id: number
  role: AssistantMessageRole
  content: string
  message_type: AssistantMessageType
  metadata_json: string | null
  create_time: string
}

export interface AssistantRoleCreateInput {
  name: string
  description?: string
  icon?: string
  system_prompt: string
  analysis_rules_json?: string | null
  capabilities_json?: string | null
  is_builtin?: number
}

export interface AssistantDocumentCreateInput {
  title: string
  file_name?: string
  content_text: string
}

export interface AssistantConversationCreateInput {
  role_id: number | null
  title?: string
  document_ids?: number[]
}

export interface AssistantMessageCreateInput {
  conversation_id: number
  role: AssistantMessageRole
  content: string
  message_type?: AssistantMessageType
  metadata_json?: string | null
}

/** AI 助手引用的 ANovel 作品正文（章节或全书） */
export interface AssistantWorkReference {
  workId: number
  chapterId?: number | null
  title: string
}
