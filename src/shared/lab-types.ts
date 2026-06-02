export type LabTaskStatus = 'pending' | 'running' | 'done' | 'error'

export interface LabTaskRow {
  id: number
  original_text: string
  result_text: string | null
  style_id: number
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
  sourceFile?: string
}

export interface LabUploadParseInput {
  fileName: string
  base64: string
}
