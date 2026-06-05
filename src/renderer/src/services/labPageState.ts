const STORAGE_KEY = 'anovel:lab-page-state'
const TEXT_MAX = 50_000

export type LabResultViewMode = 'diff' | 'plain'

export interface LabPageState {
  styleId?: number | null
  systemPrompt?: string
  antiAiRules?: string[]
  originalText?: string
  sourceFile?: string
  viewMode?: LabResultViewMode
}

export function loadLabPageState(): LabPageState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LabPageState
    if (!parsed || typeof parsed !== 'object') return null
    const state: LabPageState = {}
    if (typeof parsed.styleId === 'number' && parsed.styleId > 0) {
      state.styleId = parsed.styleId
    }
    if (typeof parsed.systemPrompt === 'string') {
      state.systemPrompt = parsed.systemPrompt.slice(0, TEXT_MAX)
    }
    if (Array.isArray(parsed.antiAiRules)) {
      state.antiAiRules = parsed.antiAiRules.filter(
        (r): r is string => typeof r === 'string' && r.trim().length > 0
      )
    }
    if (typeof parsed.originalText === 'string') {
      state.originalText = parsed.originalText.slice(0, TEXT_MAX)
    }
    if (typeof parsed.sourceFile === 'string') {
      state.sourceFile = parsed.sourceFile.slice(0, 200)
    }
    if (parsed.viewMode === 'diff' || parsed.viewMode === 'plain') {
      state.viewMode = parsed.viewMode
    }
    return state
  } catch {
    return null
  }
}

export function saveLabPageState(state: LabPageState): void {
  try {
    const payload: LabPageState = {}
    if (typeof state.styleId === 'number' && state.styleId > 0) {
      payload.styleId = state.styleId
    }
    if (state.systemPrompt?.trim()) {
      payload.systemPrompt = state.systemPrompt.slice(0, TEXT_MAX)
    }
    if (state.antiAiRules?.length) {
      payload.antiAiRules = state.antiAiRules
    }
    if (state.originalText?.trim()) {
      payload.originalText = state.originalText.slice(0, TEXT_MAX)
    }
    if (state.sourceFile?.trim()) {
      payload.sourceFile = state.sourceFile.trim().slice(0, 200)
    }
    if (state.viewMode === 'diff' || state.viewMode === 'plain') {
      payload.viewMode = state.viewMode
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    /* quota or private mode */
  }
}
