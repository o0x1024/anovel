import type {
  HumanRewriteAiSymptom,
  HumanRewriteSceneType
} from './human-rewrite-reference-types'
import type { AigcDetectResult, AigcDistribution } from './aigc-detect-types'

export const AIGC_REWRITE_REQUIRED_TARGET_COVERAGE_PERCENT = 85

export type AigcSentenceRewriteStatus =
  | 'analyzing'
  | 'rewriting'
  | 'improving'
  | 'passed'
  | 'rejected'
  | 'unmatched'
  | 'unchanged'

export type AigcSentencePatchDecision = 'pending' | 'accepted' | 'rejected'

export interface AigcSentenceCandidateAttempt {
  text: string
  score: number
  issues: string[]
}

export interface AigcSentenceRewriteAttempt {
  attempt: number
  candidates: AigcSentenceCandidateAttempt[]
}

export interface AigcSentencePatch {
  id: string
  scope?: 'sentence' | 'block'
  sentenceCount?: number
  start: number
  end: number
  segmentIndex: number
  paragraphIndex: number
  sentenceIndex: number
  originalText: string
  rewrittenText?: string
  status: AigcSentenceRewriteStatus
  sceneTypes: HumanRewriteSceneType[]
  aiSymptoms: HumanRewriteAiSymptom[]
  evidence: string
  referenceTitles: string[]
  issues: string[]
  windowScoreBefore: number
  windowScoreAfter?: number
  attempts?: AigcSentenceRewriteAttempt[]
}

export interface AigcSentenceRewriteEvent {
  runId: string
  patch: AigcSentencePatch
}

export interface AigcSentenceRewriteResult {
  originalText: string
  finalText: string
  patches: AigcSentencePatch[]
  goal: AigcRewriteGoalResult
  /** 仅在生成质量门禁与本地风险门禁均通过时返回。 */
  verifiedDetection?: AigcDetectResult
}

export interface AigcRewriteGoalResult {
  status: 'achieved' | 'awaiting_recheck' | 'not_achieved'
  humanPercent: number
  suspectedAiPercent: number
  aiPercent: number
  iterations: number
  remainingSentenceIds: string[]
  targetCoveragePercent: number
  passedCoveragePercent: number
  fullDocumentRewrite: boolean
  /** 一键改写完成前的本地融合检测复检结果，不代表作者身份。 */
  localVerification?: {
    attempts: number
    distribution: AigcDistribution
    passed: boolean
    reasons: string[]
  }
}

export interface StableSentenceUnit {
  id: string
  start: number
  end: number
  paragraphIndex: number
  sentenceIndex: number
  text: string
}

export interface StableRewriteBlock {
  id: string
  start: number
  end: number
  paragraphIndex: number
  sentenceIndex: number
  sentenceIds: string[]
  text: string
}
