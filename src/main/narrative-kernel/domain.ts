export const NARRATIVE_KERNEL_SCHEMA_VERSION = 1 as const

export interface EvidenceSpan {
  chapterVersionId: string
  startOffset: number
  endOffset: number
  quoteHash: string
}

export interface NarrativeEventBase {
  id: string
  chapterOrdinal: number
  evidence: EvidenceSpan
}

export interface ActorIntroducedEvent extends NarrativeEventBase {
  type: 'ActorIntroduced'
  actorId: string
  canonicalName: string
  aliases: string[]
}

export interface LocationIntroducedEvent extends NarrativeEventBase {
  type: 'LocationIntroduced'
  locationId: string
  canonicalName: string
  aliases: string[]
}

export interface ArtifactIntroducedEvent extends NarrativeEventBase {
  type: 'ArtifactIntroduced'
  artifactId: string
  canonicalName: string
  aliases: string[]
  provenance: ArtifactProvenance
  holder: ArtifactHolder
  quantity: number
}

export interface ArtifactTransferredEvent extends NarrativeEventBase {
  type: 'ArtifactTransferred'
  artifactId: string
  from: ArtifactHolder
  to: ArtifactHolder
}

export interface ArtifactUsedEvent extends NarrativeEventBase {
  type: 'ArtifactUsed'
  artifactId: string
  actorId: string
  action: string
}

export interface ArtifactConsumedEvent extends NarrativeEventBase {
  type: 'ArtifactConsumed'
  artifactId: string
  actorId: string
  quantity: number
}

export interface ClaimEstablishedEvent extends NarrativeEventBase {
  type: 'ClaimEstablished'
  claimId: string
  subjectEntityId: string
  predicate: string
  objectValue: string
  truthStatus: 'true' | 'false'
}

export interface ActorLearnedClaimEvent extends NarrativeEventBase {
  type: 'ActorLearnedClaim'
  actorId: string
  claimId: string
  belief: 'knows' | 'believes' | 'suspects' | 'disbelieves'
}

export interface ActorActedOnClaimEvent extends NarrativeEventBase {
  type: 'ActorActedOnClaim'
  actorId: string
  claimId: string
  action: string
}

export type NarrativeEvent =
  | ActorIntroducedEvent
  | LocationIntroducedEvent
  | ArtifactIntroducedEvent
  | ArtifactTransferredEvent
  | ArtifactUsedEvent
  | ArtifactConsumedEvent
  | ClaimEstablishedEvent
  | ActorLearnedClaimEvent
  | ActorActedOnClaimEvent

export interface NarrativeCommit {
  id: string
  workId: number
  chapterVersionId: string
  chapterOrdinal: number
  baseRevision: number
  revision: number
  events: NarrativeEvent[]
}

export interface ArtifactProvenance {
  kind: 'created' | 'found' | 'inherited' | 'purchased' | 'stolen'
  sourceEntityId: string
}

export type ArtifactHolder =
  | { kind: 'actor'; actorId: string }
  | { kind: 'location'; locationId: string }

export interface ActorState {
  id: string
  canonicalName: string
  aliases: string[]
  alive: boolean
}

export interface LocationState {
  id: string
  canonicalName: string
  aliases: string[]
}

export interface ArtifactState {
  id: string
  canonicalName: string
  aliases: string[]
  provenance: ArtifactProvenance
  holder: ArtifactHolder
  quantity: number
  retired: boolean
  lastMutationEventId: string
}

export interface ClaimState {
  id: string
  subjectEntityId: string
  predicate: string
  objectValue: string
  truthStatus: 'true' | 'false'
  establishedByEventId: string
}

export interface ActorKnowledgeState {
  actorId: string
  claimId: string
  belief: 'knows' | 'believes' | 'suspects' | 'disbelieves'
  learnedByEventId: string
}

export interface NarrativeState {
  schemaVersion: typeof NARRATIVE_KERNEL_SCHEMA_VERSION
  workId: number
  revision: number
  actors: Record<string, ActorState>
  locations: Record<string, LocationState>
  artifacts: Record<string, ArtifactState>
  claims: Record<string, ClaimState>
  actorKnowledge: Record<string, ActorKnowledgeState>
  appliedEventIds: Record<string, true>
  stateHash: string
}

export interface ChapterContentRegistry {
  getChapterContent(chapterVersionId: string): string | undefined
}

export type NarrativeEntityKind = 'actor' | 'location' | 'artifact' | 'claim'

export function actorKnowledgeKey(actorId: string, claimId: string): string {
  return `${actorId}:${claimId}`
}

export function artifactHolderKey(holder: ArtifactHolder): string {
  return holder.kind === 'actor'
    ? `actor:${holder.actorId}`
    : `location:${holder.locationId}`
}
