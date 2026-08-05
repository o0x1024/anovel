import {
  CausalOutcomeProtocolError,
  type CausalOutcomeActorDraft
} from '../../../shared/causal-outcome-protocol'

export function validateCausalOutcomeActorMutationReferences(
  draft: CausalOutcomeActorDraft,
  knownActorNames: readonly string[]
): void {
  const knownNames = new Set(knownActorNames)
  draft.actorMutations.forEach((mutation, index) => {
    if (knownNames.has(mutation.actor)) return
    const path = `actors.actorMutations[${index}].actor`
    throw new CausalOutcomeProtocolError(
      'OUTCOME_REFERENCE',
      `${path} 只能引用权威状态中的既有人物；正文中新登场人物必须改写到 newActors：${mutation.actor}`,
      [path]
    )
  })
}
