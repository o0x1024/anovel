import type { WebContents } from 'electron'
import type {
  AiDeltaPayload,
  AiModelInfoPayload,
  AiPhasePayload,
  AiSessionEndPayload,
  AiSessionStartPayload,
  AiSessionStep,
  AiStepStatus,
  AiThinkingDeltaPayload
} from './ai-session-types'

export interface AiSessionHandle {
  readonly id: string
  emitPhase(label: string, status?: AiStepStatus, stepIndex?: number): void
  emitDelta(delta: string): void
  emitThinkingDelta(delta: string): void
  setModelInfo(modelType: string, modelName?: string): void
  clearStream(): void
  setStepRunning(stepIndex: number): void
  setStepDone(stepIndex: number): void
  setStepError(stepIndex: number, message?: string): void
  complete(success: boolean, error?: string): void
  getSignal(): AbortSignal
  isCancelled(): boolean
}

interface SessionRecord {
  sender: WebContents
  controller: AbortController
  title: string
  steps: AiSessionStep[]
  content: string
  thinkingContent: string
  startedAt: number
  modelType?: string
  modelName?: string
  ended: boolean
  flushTimer: ReturnType<typeof setTimeout> | null
  pendingDelta: string
  thinkingFlushTimer: ReturnType<typeof setTimeout> | null
  pendingThinkingDelta: string
}

function makeStepId(): string {
  return `step_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function flushThinkingDelta(sessionId: string, record: SessionRecord) {
  if (record.thinkingFlushTimer) {
    clearTimeout(record.thinkingFlushTimer)
    record.thinkingFlushTimer = null
  }
  if (!record.pendingThinkingDelta || record.ended) {
    record.pendingThinkingDelta = ''
    return
  }
  const payload: AiThinkingDeltaPayload = {
    sessionId,
    delta: record.pendingThinkingDelta,
    thinking: record.thinkingContent
  }
  record.sender.send('ai:thinking-delta', payload)
  record.pendingThinkingDelta = ''
}

function flushDelta(sessionId: string, record: SessionRecord) {
  if (record.flushTimer) {
    clearTimeout(record.flushTimer)
    record.flushTimer = null
  }
  if (!record.pendingDelta || record.ended) {
    record.pendingDelta = ''
    return
  }
  const payload: AiDeltaPayload = {
    sessionId,
    delta: record.pendingDelta,
    content: record.content
  }
  record.sender.send('ai:delta', payload)
  record.pendingDelta = ''
}

class AiSessionManagerImpl {
  private sessions = new Map<string, SessionRecord>()
  private activeSessionId: string | null = null

  create(sender: WebContents, title: string, stepLabels?: string[]): AiSessionHandle {
    if (this.activeSessionId) {
      this.cancel(this.activeSessionId)
    }

    const sessionId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const steps: AiSessionStep[] = (stepLabels ?? []).map(label => ({
      id: makeStepId(),
      label,
      status: 'pending' as AiStepStatus
    }))

    const record: SessionRecord = {
      sender,
      controller: new AbortController(),
      title,
      steps,
      content: '',
      thinkingContent: '',
      startedAt: Date.now(),
      ended: false,
      flushTimer: null,
      pendingDelta: '',
      thinkingFlushTimer: null,
      pendingThinkingDelta: ''
    }

    this.sessions.set(sessionId, record)
    this.activeSessionId = sessionId

    const payload: AiSessionStartPayload = {
      sessionId,
      title,
      steps,
      startedAt: record.startedAt
    }
    sender.send('ai:session-start', payload)

    return this.buildHandle(sessionId, record)
  }

  cancel(sessionId: string): boolean {
    const record = this.sessions.get(sessionId)
    if (!record || record.ended) return false

    record.controller.abort()
    flushDelta(sessionId, record)
    flushThinkingDelta(sessionId, record)
    record.sender.send('ai:session-cancelled', { sessionId })
    record.ended = true
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null
    }
    this.sessions.delete(sessionId)
    return true
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId
  }

  private clearActive(sessionId: string) {
    if (this.activeSessionId === sessionId) {
      this.activeSessionId = null
    }
    this.sessions.delete(sessionId)
  }

  private buildHandle(sessionId: string, record: SessionRecord): AiSessionHandle {
    const manager = this

    const sendPhase = (payload: AiPhasePayload) => {
      if (record.ended) return
      record.sender.send('ai:phase', payload)
    }

    const updateStep = (stepIndex: number, status: AiStepStatus) => {
      const step = record.steps[stepIndex]
      if (!step) return
      step.status = status
      sendPhase({
        sessionId,
        label: step.label,
        status,
        stepIndex
      })
    }

    return {
      id: sessionId,

      emitPhase(label: string, status: AiStepStatus = 'running', stepIndex?: number) {
        sendPhase({ sessionId, label, status, stepIndex })
      },

      emitDelta(delta: string) {
        if (record.ended || !delta) return
        record.content += delta
        record.pendingDelta += delta
        if (record.flushTimer) return
        record.flushTimer = setTimeout(() => {
          record.flushTimer = null
          flushDelta(sessionId, record)
        }, 80)
      },

      emitThinkingDelta(delta: string) {
        if (record.ended || !delta) return
        record.thinkingContent += delta
        record.pendingThinkingDelta += delta
        if (record.thinkingFlushTimer) return
        record.thinkingFlushTimer = setTimeout(() => {
          record.thinkingFlushTimer = null
          flushThinkingDelta(sessionId, record)
        }, 80)
      },

      setModelInfo(modelType: string, modelName?: string) {
        record.modelType = modelType
        record.modelName = modelName
        if (record.ended) return
        const payload: AiModelInfoPayload = { sessionId, modelType, modelName }
        record.sender.send('ai:model-info', payload)
      },

      clearStream() {
        flushDelta(sessionId, record)
        flushThinkingDelta(sessionId, record)
        record.content = ''
        record.thinkingContent = ''
        record.pendingDelta = ''
        record.pendingThinkingDelta = ''
      },

      setStepRunning(stepIndex: number) {
        updateStep(stepIndex, 'running')
      },

      setStepDone(stepIndex: number) {
        updateStep(stepIndex, 'done')
      },

      setStepError(stepIndex: number, message?: string) {
        updateStep(stepIndex, 'error')
        if (message) {
          sendPhase({
            sessionId,
            label: message,
            status: 'error',
            stepIndex
          })
        }
      },

      complete(success: boolean, error?: string) {
        if (record.ended) return
        flushDelta(sessionId, record)
        flushThinkingDelta(sessionId, record)
        const payload: AiSessionEndPayload = {
          sessionId,
          success,
          error,
          durationMs: Date.now() - record.startedAt,
          modelType: record.modelType,
          modelName: record.modelName
        }
        record.sender.send('ai:session-end', payload)
        record.ended = true
        manager.clearActive(sessionId)
      },

      getSignal(): AbortSignal {
        return record.controller.signal
      },

      isCancelled(): boolean {
        return record.controller.signal.aborted
      }
    }
  }
}

export const aiSessionManager = new AiSessionManagerImpl()
