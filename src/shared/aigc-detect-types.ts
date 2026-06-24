export type AigcCategory = 'human' | 'suspected_ai' | 'ai'

export interface AigcSegment {
  text: string
  category: AigcCategory
  reason?: string
}

export interface AigcDistribution {
  human: number
  suspected_ai: number
  ai: number
}

export interface AigcDetectResult {
  segments: AigcSegment[]
  distribution: AigcDistribution
  summary: string
}

export interface AigcRewriteCandidateView {
  key: string
  docScore: number
  changeRatio: number
  numberAnchorRetention: number
  objectiveScore: number
  issues: string[]
  valid: boolean
}

export interface AigcRewriteSelectionView {
  runId: string
  selectedKey: string
  selectedDocScore: number
  baselineDocScore?: number
  evaluations: AigcRewriteCandidateView[]
}

export interface AigcRewriteCompareView {
  originalText: string
  rewrittenText: string
}

export const AIGC_CATEGORY_LABELS: Record<AigcCategory, string> = {
  human: '人工特征',
  suspected_ai: '疑似AI',
  ai: 'AI特征'
}

/** 困惑度检测引擎模式 */
export type PerplexityEngineMode = 'builtin' | 'api'

/** 本地部署 API 配置（LM Studio / Ollama / llama.cpp server 等 OpenAI 兼容接口） */
export interface PerplexityApiConfig {
  mode: PerplexityEngineMode
  apiBase: string
  modelName: string
  apiKey?: string
}
