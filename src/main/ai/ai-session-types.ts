export type AiStepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

export interface AiSessionStep {
  id: string
  label: string
  status: AiStepStatus
}

export interface AiSessionStartPayload {
  sessionId: string
  title: string
  steps: AiSessionStep[]
  startedAt: number
}

export interface AiPhasePayload {
  sessionId: string
  label: string
  status: AiStepStatus
  stepIndex?: number
}

export interface AiThinkingDeltaPayload {
  sessionId: string
  delta: string
  thinking: string
}

export interface AiDeltaPayload {
  sessionId: string
  delta: string
  content: string
}

export interface AiSessionEndPayload {
  sessionId: string
  success: boolean
  error?: string
  durationMs: number
  modelType?: string
  modelName?: string
}

export interface AiSessionCancelledPayload {
  sessionId: string
}

export interface AiModelInfoPayload {
  sessionId: string
  modelType: string
  modelName?: string
}
