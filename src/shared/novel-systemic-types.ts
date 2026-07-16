export type StoryStateValueType = 'number' | 'enum' | 'boolean' | 'set' | 'text'
export type StoryStateTransition = 'create' | 'update' | 'increase' | 'decrease' | 'unlock' | 'complete' | 'invalidate'

export interface StoryStateFactInput {
  entity: string
  key: string
  valueType: StoryStateValueType
  value: unknown
  transition: StoryStateTransition
  irreversible?: boolean
  evidence?: string
}

export interface ChapterPatternFingerprintInput {
  conflictType: string
  protagonistMethod: string
  antagonistTactic: string
  antagonistOutcome: string
  opponentAdjustment: string
  locationType: string
  hookType: string
  costType: string
  relationshipDelta: string
  volumeObjectiveDelta: string
  payoffType: 'debt' | 'partial' | 'major' | 'aftertaste'
}

export type NovelIssueCode =
  | 'STATE_CONTRADICTION'
  | 'STATE_REGRESSION'
  | 'TASK_COMPLETED_TWICE'
  | 'STATE_DUPLICATE_UNLOCK'
  | 'MISSING_PATTERN_FINGERPRINT'
  | 'REPEATED_SOLUTION'
  | 'REPEATED_HOOK'
  | 'ANTAGONIST_NO_LEARNING'
  | 'PAYOFF_DEBT_STREAK'
  | 'VOLUME_OBJECTIVE_STAGNATION'
  | 'RELATIONSHIP_STAGNATION'
  | 'PROSE_TEMPLATE_REPETITION'
  | 'VOLUME_NO_CLOSURE'
  | 'CLIMAX_NO_COST'
  | 'EVALUATOR_ERROR'

export type NovelIssueScope = 'sentence' | 'chapter' | 'cluster' | 'volume'

export interface NovelSystemIssue {
  code: NovelIssueCode
  scope: NovelIssueScope
  severity: 'warning' | 'blocker'
  chapterIds: number[]
  evidence: string[]
  message: string
  recommendedAction: string
}

export interface NovelSystemicAssessment {
  issues: NovelSystemIssue[]
  issueFingerprint: string
  blockerCount: number
  warningCount: number
}

export function issueEvidenceFingerprint(issues: NovelSystemIssue[]): string {
  return issues
    .map(issue => `${issue.code}:${issue.chapterIds.join(',')}:${issue.evidence.join('|')}`)
    .sort()
    .join('\n')
    .slice(0, 12000)
}

