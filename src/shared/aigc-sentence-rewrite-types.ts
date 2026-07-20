import type {
  HumanRewriteAiSymptom,
  HumanRewriteSceneType
} from './human-rewrite-reference-types'

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
