import type {
  CausalChapterPlanDraft
} from '../../../shared/causal-novel-types'
import type { ChapterExecutionContract } from '../../../shared/chapter-execution-contract'

type DecisionDetails = Omit<CausalChapterPlanDraft, 'candidates'>

export type CausalDecisionModelDetails = Omit<DecisionDetails, 'decision'> & {
  decision: Pick<
    DecisionDetails['decision'],
    'pov' | 'immediateWant' | 'characters'
  >
}

export const CAUSAL_DECISION_SERVER_BOUND_FIELDS = [
  'title',
  'openingState',
  'mustCover',
  'forbiddenEvents',
  'endingState',
  'continuityConstraints'
] as const

export function stripServerBoundDecisionSchema(
  decisionSchema: Record<string, unknown>
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(decisionSchema)) as {
    required?: string[]
    properties?: Record<string, unknown>
  }
  const serverBound = new Set<string>(CAUSAL_DECISION_SERVER_BOUND_FIELDS)
  cloned.required = (cloned.required ?? []).filter(field => !serverBound.has(field))
  for (const field of CAUSAL_DECISION_SERVER_BOUND_FIELDS) {
    delete cloned.properties?.[field]
  }
  return cloned as Record<string, unknown>
}

export function bindServerChapterContract(
  draft: CausalDecisionModelDetails,
  contract: Pick<
    ChapterExecutionContract,
    'chapterTitle' | 'openingState' | 'requiredEvents' | 'forbiddenEvents' |
    'endingState' | 'continuityConstraints'
  >
): DecisionDetails {
  return {
    ...draft,
    decision: {
      ...draft.decision,
      title: contract.chapterTitle,
      openingState: contract.openingState,
      mustCover: contract.requiredEvents,
      forbiddenEvents: contract.forbiddenEvents,
      endingState: contract.endingState,
      continuityConstraints: contract.continuityConstraints
        .split('；')
        .map(item => item.trim())
        .filter(Boolean)
    }
  }
}
