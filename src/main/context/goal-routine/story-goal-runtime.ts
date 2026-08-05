import { goalRoutineDAO } from '../../db'
import type { StoryCategoryTags } from '../../../shared/story-category-tags'
import type { ParsedChapter } from '../parse-chapters'
import type { StoryForensicIssue } from './story-whole-evaluator'
import type { GoalCheckResult } from './story-goal-checker'
import type { GoalRoutinePhase } from '../../../shared/goal-routine-phases'

export type Phase = GoalRoutinePhase

export interface RepairPlan {
  action: 'draft_missing' | 'resize' | 'deai' | 'quality' | 'goal_align' | 'storyline' | 'beat' | 'scene' | 'paragraph'
  targetChapterIds: number[]
  targetWordCounts?: Record<number, number>
  hint: string
  issues?: string[]
  forensicIssues?: StoryForensicIssue[]
  forensicFingerprint?: string
  continuityEscalation?: boolean
  targetLead?: boolean
  issueKeys?: string[]
  /** 只修复节拍合同/共享边界，不得改写已经验收的正文。 */
  blueprintOnly?: boolean
}

export interface TitleHookCandidate {
  title: string
  hook: string
  type?: string
  summary?: string
  tags: StoryCategoryTags
}

export interface RoutineRuntimeState {
  repairProtocolVersion?: number
  lastCheck?: GoalCheckResult
  repairPlan?: RepairPlan
  overallRepairRounds?: number
  wholeAuditCount?: number
  lastCheckComposite?: number
  lastCheckSignature?: string
  stagnantChecks?: number
  structuralResetCount?: number
  structuralFeedback?: string
  forceBeatRebuild?: boolean
  beatGateFailureCount?: number
  pendingMemoryChapterIds?: number[]
  memoryCompensationAttempts?: Record<string, number>
  forensicRepairStall?: { fingerprint: string; count: number }
  continuityRepairFailure?: {
    chapterId: number
    blockers: string[]
    attempts: number
    fingerprint?: string
    escalationCount?: number
    updatedAt: string
  }
  continuityPendingRepair?: RepairPlan
  executionFailure?: {
    phase: Phase
    signature: string
    count: number
    message: string
    updatedAt: string
  }
  terminalReason?: 'needs_manual_editor'
  titleHookCandidates?: TitleHookCandidate[]
  titleHookPreferredIndex?: number
  liveProgress?: {
    turn: number
    phase: Phase
    status: string
    message: string
    updatedAt: string
  }
  beatGenerationDraft?: {
    round: number
    score: number
    issues: string[]
    chapters: ParsedChapter[]
    updatedAt: string
  }
  beatGenerationStage?: {
    key: string
    round: number
    gateFeedback: string
    skeletons: ParsedChapter[]
    enriched: ParsedChapter[]
    repairIndexes?: number[]
    gateIssues?: string[]
    updatedAt: string
  }
  evaluationHistory?: Array<{
    checkedAt: string
    qualityScore: number
    goalMatchScore: number
    overallStoryScore: number
    previewHookScore: number
    proseReadScore: number
    composite: number
    weakestLayer: string
    issues: string[]
  }>
}

export function readStoryGoalRuntimeState(workId: number): RoutineRuntimeState {
  const raw = goalRoutineDAO.getByWork(workId)?.state_json
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as RoutineRuntimeState
      : {}
  } catch {
    return {}
  }
}

export function patchStoryGoalRuntimeState(
  workId: number,
  patch: Partial<RoutineRuntimeState>
): RoutineRuntimeState {
  const next = { ...readStoryGoalRuntimeState(workId), ...patch }
  goalRoutineDAO.update(workId, { state_json: JSON.stringify(next) })
  return next
}
