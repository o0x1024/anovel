import type { IncubatorSlotKey } from './incubator-slots'

export type IncubatorWorkflowState =
  | 'SeedReady'
  | 'CandidatesGenerated'
  | 'CandidatesEvaluated'
  | 'Composing'
  | 'DraftReady'
  | 'GateChecking'
  | 'V1Frozen'

export type IncubatorCandidateSourceStep =
  | 'variants'
  | 'expand'
  | 'microinnovation'
  | 'manual'
  | 'diagnose'
  | 'reverse'
  | 'anchors'
  | 'benchmark'
  | 'tone'
  | 'frontstory'
  | 'premise_gen'
  | 'role_engine_gen'
  | 'world_rules_gen'
  | 'rhythm_curve_gen'
  | 'ending_gen'

export type IncubatorCandidateStatus =
  | 'new'
  | 'evaluated'
  | 'adopted'
  | 'rejected'
  | 'archived'

export type IncubatorAdoptMode = 'replace_slot' | 'append_slot' | 'pool_only'

export interface IncubatorSeed {
  workId: number
  content: string
  updateTime: string | null
}

export interface IncubatorCandidate {
  id: number
  workId: number
  sourceStep: IncubatorCandidateSourceStep
  title: string
  summary: string
  dimension: string | null
  highlights: string | null
  audience: string | null
  status: IncubatorCandidateStatus
  createdAt: string
}

export interface IncubatorCandidateScore {
  id: number
  candidateId: number
  attractionScore: number
  serializabilityScore: number
  differentiationScore: number
  conflictClosureScore: number
  executabilityScore: number
  systemTotal: number
  userAdjustment: number
  finalTotal: number
  rationale: string | null
  createdAt: string
}

export interface IncubatorDraftSlot {
  id: number
  workId: number
  slotKey: IncubatorSlotKey
  content: string
  sourceCandidateId: number | null
  status: 'active' | 'deprecated'
  versionTag: string
  updateTime: string | null
}

export interface IncubatorStorylineVersion {
  id: number
  workId: number
  versionNo: number
  label: string
  snapshotJson: string
  baseVersionId: number | null
  isFrozen: boolean
  createdAt: string
}

export interface IncubatorGateReport {
  passed: boolean
  filledSlotCount: number
  serializabilityScore: number
  conflictClosureScore: number
  issues: string[]
  suggestions: string[]
  coherence: {
    slotKey: IncubatorSlotKey
    severity: 'blocking' | 'warning'
    issue: string
    suggestion: string
    /** LLM 产出的局部替换列表，original→replacement 逐条应用 */
    replacements?: { original: string; replacement: string }[]
  }[]
  globalAnalysis?: string
}

export interface IncubatorLastAdoptAction {
  slotKey: IncubatorSlotKey
  previousContent: string
  candidateId: number
  mode: IncubatorAdoptMode
}

export interface IncubatorWorkspaceState {
  state: IncubatorWorkflowState
  seed: IncubatorSeed | null
  activeDraftSlots: IncubatorDraftSlot[]
  candidates: (IncubatorCandidate & { latestScore?: IncubatorCandidateScore | null })[]
  versions: IncubatorStorylineVersion[]
  latestFrozenVersion: IncubatorStorylineVersion | null
  /** 草案相对最新冻结有改动，可再次冻结 */
  draftDirtySinceFreeze: boolean
  /** 下次冻结将使用的 version_no */
  nextFreezeVersionNo: number
  branchBaseVersionId: number | null
  gateSummary: IncubatorGateReport | null
  lastAdopt: IncubatorLastAdoptAction | null
  ideaCompat: string
}

export interface IncubatorAdoptToSlotInput {
  workId: number
  candidateId: number
  slotKey: IncubatorSlotKey
  mode: IncubatorAdoptMode
  /** 从候选 summary 提取的片段；空则使用候选全文 */
  excerpt?: string
}

export interface IncubatorAdoptToSlotResult {
  success: boolean
  error?: string
  slot?: IncubatorDraftSlot
  workflowState?: IncubatorWorkflowState
}

export interface IncubatorVersionSlotDiff {
  slotKey: IncubatorSlotKey
  label: string
  textA: string
  textB: string
  changed: boolean
}

export interface IncubatorVersionCompareResult {
  versionA: { id: number; label: string; versionNo: number }
  versionB: { id: number; label: string; versionNo: number }
  slotDiffs: IncubatorVersionSlotDiff[]
}

export interface IncubatorVersionDetail {
  version: IncubatorStorylineVersion
  filledSlotCount: number
  slotPreviews: { slotKey: IncubatorSlotKey; label: string; content: string }[]
  synthesizedSummary?: string | null
  qualitySnapshot?: string | null
  gate?: IncubatorGateReport | null
}
