import type {
  CausalChapterPlanDraft,
  CausalEventCandidateProposal,
  CausalEvidenceFact,
  CausalNarrativeState
} from '../../../shared/causal-novel-types'

export interface CausalPlanReferenceIssue {
  path: string
  actual: string | string[]
  allowed: string[]
}

export interface CausalPlanReferencePatch {
  path: string
  value: string | string[]
}

export class CausalPlanReferenceValidationError extends Error {
  readonly code = 'PLAN_REFERENCE_INVALID'

  constructor(public readonly issues: CausalPlanReferenceIssue[]) {
    super(issues.map(issue => `${issue.path} 引用了当前权威集合之外的值：${
      Array.isArray(issue.actual) ? issue.actual.join('、') : issue.actual
    }`).join('；'))
    this.name = 'CausalPlanReferenceValidationError'
  }
}

export class CausalPlanReferenceRepairExhaustedError extends Error {
  readonly code = 'PLAN_REFERENCE_REPAIR_EXHAUSTED'

  constructor(message: string) {
    super(`权威引用定点修复预算已耗尽：${message}`)
    this.name = 'CausalPlanReferenceRepairExhaustedError'
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function referenceSets(state: CausalNarrativeState, catalog: CausalEvidenceFact[]) {
  return {
    actors: unique(state.actors.map(actor => actor.name)),
    pressures: unique(state.activePressures.filter(item => item.status === 'active').map(item => item.id)),
    promises: unique(state.promises.filter(item => item.status !== 'resolved').map(item => item.id)),
    evidence: unique(catalog.map(item => item.id))
  }
}

function scalarIssue(path: string, actual: string, allowed: string[]): CausalPlanReferenceIssue | null {
  return allowed.includes(actual) ? null : { path, actual, allowed }
}

function arrayIssue(path: string, actual: string[], allowed: string[]): CausalPlanReferenceIssue | null {
  const invalid = unique(actual.filter(value => !allowed.includes(value)))
  return invalid.length > 0 ? { path, actual: invalid, allowed } : null
}

export function candidateReferenceIssues(
  state: CausalNarrativeState,
  candidates: CausalEventCandidateProposal[]
): CausalPlanReferenceIssue[] {
  const sets = referenceSets(state, [])
  return candidates.flatMap((candidate, index) => [
    scalarIssue(`candidates[${index}].initiator`, candidate.initiator, sets.actors),
    scalarIssue(`candidates[${index}].promiseAdvanced`, candidate.promiseAdvanced, sets.promises)
  ].filter((issue): issue is CausalPlanReferenceIssue => issue != null))
}

export function decisionReferenceIssues(
  state: CausalNarrativeState,
  catalog: CausalEvidenceFact[],
  draft: Omit<CausalChapterPlanDraft, 'candidates'>
): CausalPlanReferenceIssue[] {
  const sets = referenceSets(state, catalog)
  const issues: Array<CausalPlanReferenceIssue | null> = [
    scalarIssue('decision.pov', draft.decision.pov, sets.actors),
    scalarIssue(
      'emotionContract.groundingEvidence.attachmentEvidenceId',
      draft.emotionContract.groundingEvidence.attachmentEvidenceId,
      sets.evidence
    ),
    scalarIssue(
      'emotionContract.groundingEvidence.privateDetailEvidenceId',
      draft.emotionContract.groundingEvidence.privateDetailEvidenceId,
      sets.evidence
    )
  ]
  draft.rollingHorizon.forEach((beat, index) => {
    issues.push(
      scalarIssue(`rollingHorizon[${index}].initiator`, beat.initiator, sets.actors),
      arrayIssue(`rollingHorizon[${index}].pressureIds`, beat.pressureIds, sets.pressures),
      arrayIssue(`rollingHorizon[${index}].promiseIds`, beat.promiseIds, sets.promises)
    )
  })
  return issues.filter((issue): issue is CausalPlanReferenceIssue => issue != null)
}

function validatedPatchMap(
  issues: CausalPlanReferenceIssue[],
  patches: CausalPlanReferencePatch[]
): Map<string, string | string[]> {
  const issueByPath = new Map(issues.map(issue => [issue.path, issue]))
  const patchByPath = new Map<string, string | string[]>()
  for (const patch of patches) {
    const issue = issueByPath.get(patch.path)
    if (!issue) throw new Error(`引用补丁试图修改未授权路径：${patch.path}`)
    if (patchByPath.has(patch.path)) throw new Error(`引用补丁重复修改路径：${patch.path}`)
    if (Array.isArray(issue.actual)) {
      if (!Array.isArray(patch.value) || patch.value.length === 0) {
        throw new Error(`引用补丁 ${patch.path} 必须返回非空字符串数组`)
      }
      const values = unique(patch.value.map(String))
      const invalid = values.filter(value => !issue.allowed.includes(value))
      if (invalid.length > 0) throw new Error(`引用补丁 ${patch.path} 仍包含无效值：${invalid.join('、')}`)
      patchByPath.set(patch.path, values)
    } else {
      if (typeof patch.value !== 'string' || !issue.allowed.includes(patch.value)) {
        throw new Error(`引用补丁 ${patch.path} 仍不在当前权威集合中`)
      }
      patchByPath.set(patch.path, patch.value)
    }
  }
  const missing = issues.filter(issue => !patchByPath.has(issue.path))
  if (missing.length > 0) throw new Error(`引用补丁缺少路径：${missing.map(issue => issue.path).join('、')}`)
  return patchByPath
}

export function assertReferencePatches(
  issues: CausalPlanReferenceIssue[],
  patches: CausalPlanReferencePatch[]
): CausalPlanReferencePatch[] {
  validatedPatchMap(issues, patches)
  return patches
}

export function applyCandidateReferencePatches(
  state: CausalNarrativeState,
  candidates: CausalEventCandidateProposal[],
  patches: CausalPlanReferencePatch[]
): CausalEventCandidateProposal[] {
  const issues = candidateReferenceIssues(state, candidates)
  if (issues.length === 0) return candidates
  const patchByPath = validatedPatchMap(issues, patches)
  const repaired = candidates.map((candidate, index) => ({
    ...candidate,
    initiator: patchByPath.get(`candidates[${index}].initiator`) as string ?? candidate.initiator,
    promiseAdvanced: patchByPath.get(`candidates[${index}].promiseAdvanced`) as string ?? candidate.promiseAdvanced
  }))
  const remaining = candidateReferenceIssues(state, repaired)
  if (remaining.length > 0) throw new CausalPlanReferenceValidationError(remaining)
  return repaired
}

export function applyDecisionReferencePatches(
  state: CausalNarrativeState,
  catalog: CausalEvidenceFact[],
  draft: Omit<CausalChapterPlanDraft, 'candidates'>,
  patches: CausalPlanReferencePatch[]
): Omit<CausalChapterPlanDraft, 'candidates'> {
  const issues = decisionReferenceIssues(state, catalog, draft)
  if (issues.length === 0) return draft
  const patchByPath = validatedPatchMap(issues, patches)
  const repaired = {
    ...draft,
    decision: {
      ...draft.decision,
      pov: patchByPath.get('decision.pov') as string ?? draft.decision.pov
    },
    emotionContract: {
      ...draft.emotionContract,
      groundingEvidence: {
        ...draft.emotionContract.groundingEvidence,
        attachmentEvidenceId: patchByPath.get(
          'emotionContract.groundingEvidence.attachmentEvidenceId'
        ) as string ?? draft.emotionContract.groundingEvidence.attachmentEvidenceId,
        privateDetailEvidenceId: patchByPath.get(
          'emotionContract.groundingEvidence.privateDetailEvidenceId'
        ) as string ?? draft.emotionContract.groundingEvidence.privateDetailEvidenceId
      }
    },
    rollingHorizon: draft.rollingHorizon.map((beat, index) => ({
      ...beat,
      initiator: patchByPath.get(`rollingHorizon[${index}].initiator`) as string ?? beat.initiator,
      pressureIds: patchByPath.get(`rollingHorizon[${index}].pressureIds`) as string[] ?? beat.pressureIds,
      promiseIds: patchByPath.get(`rollingHorizon[${index}].promiseIds`) as string[] ?? beat.promiseIds
    }))
  }
  const remaining = decisionReferenceIssues(state, catalog, repaired)
  if (remaining.length > 0) throw new CausalPlanReferenceValidationError(remaining)
  return repaired
}

export function assertCandidateReferences(
  state: CausalNarrativeState,
  candidates: CausalEventCandidateProposal[]
): CausalEventCandidateProposal[] {
  const issues = candidateReferenceIssues(state, candidates)
  if (issues.length > 0) throw new CausalPlanReferenceValidationError(issues)
  return candidates
}

export function assertDecisionReferences(
  state: CausalNarrativeState,
  catalog: CausalEvidenceFact[],
  draft: Omit<CausalChapterPlanDraft, 'candidates'>
): Omit<CausalChapterPlanDraft, 'candidates'> {
  const issues = decisionReferenceIssues(state, catalog, draft)
  if (issues.length > 0) throw new CausalPlanReferenceValidationError(issues)
  return draft
}
