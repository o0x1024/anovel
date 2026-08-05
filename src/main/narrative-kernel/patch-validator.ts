import type {
  CandidateEvidenceSpan,
  ChapterCandidate,
  ChapterIntent,
  EventProhibition,
  EventRequirement,
  NarrativePatch,
  ProposedNarrativeEvent
} from './chapter-contracts'
import type {
  ArtifactHolder,
  ChapterContentRegistry,
  NarrativeCommit,
  NarrativeEvent,
  NarrativeState
} from './domain'
import { assertNarrativeKernel } from './errors'
import { validateEvidenceSpan } from './evidence'
import { applyNarrativeCommit } from './reducer'

export interface ValidatedNarrativePatch {
  intentId: string
  intentHash: string
  candidateId: string
  candidateHash: string
  patchId: string
  patchHash: string
  baseStateRevision: number
  previewStateHash: string
}

class CandidateContentRegistry implements ChapterContentRegistry {
  constructor(private readonly candidate: ChapterCandidate) {}

  getChapterContent(chapterVersionId: string): string | undefined {
    return chapterVersionId === this.candidate.id
      ? this.candidate.content
      : undefined
  }
}

function holderEntityId(holder: ArtifactHolder): string {
  return holder.kind === 'actor' ? holder.actorId : holder.locationId
}

function introducedEntityIds(event: ProposedNarrativeEvent): string[] {
  switch (event.type) {
    case 'ActorIntroduced': return [event.actorId]
    case 'LocationIntroduced': return [event.locationId]
    case 'ArtifactIntroduced': return [event.artifactId]
    case 'ClaimEstablished': return [event.claimId]
    default: return []
  }
}

function referencedEntityIds(event: ProposedNarrativeEvent): string[] {
  switch (event.type) {
    case 'ActorIntroduced':
    case 'LocationIntroduced':
      return []
    case 'ArtifactIntroduced':
      return [
        event.provenance.sourceEntityId,
        holderEntityId(event.holder)
      ]
    case 'ArtifactTransferred':
      return [
        event.artifactId,
        holderEntityId(event.from),
        holderEntityId(event.to)
      ]
    case 'ArtifactUsed':
    case 'ArtifactConsumed':
      return [event.artifactId, event.actorId]
    case 'ClaimEstablished':
      return [event.subjectEntityId]
    case 'ActorLearnedClaim':
    case 'ActorActedOnClaim':
      return [event.actorId, event.claimId]
  }
}

function allEventEntityIds(event: ProposedNarrativeEvent): string[] {
  return [...introducedEntityIds(event), ...referencedEntityIds(event)]
}

function stateEntityIds(state: NarrativeState): Set<string> {
  return new Set([
    ...Object.keys(state.actors),
    ...Object.keys(state.locations),
    ...Object.keys(state.artifacts),
    ...Object.keys(state.claims)
  ])
}

function assertString(value: string, field: string, eventId: string): void {
  assertNarrativeKernel(
    typeof value === 'string' && value.trim().length > 0,
    'NARRATIVE_PATCH_INVALID',
    `叙事事件字段不能为空：${field}`,
    { eventId, field }
  )
}

function assertEvidenceShape(evidence: CandidateEvidenceSpan, eventId: string): void {
  assertString(evidence.candidateId, 'evidence.candidateId', eventId)
  assertString(evidence.quoteHash, 'evidence.quoteHash', eventId)
  assertNarrativeKernel(
    Number.isInteger(evidence.startOffset) &&
      Number.isInteger(evidence.endOffset),
    'NARRATIVE_PATCH_INVALID',
    '叙事事件证据偏移必须是整数',
    { eventId, evidence }
  )
}

function assertEventShape(event: ProposedNarrativeEvent): void {
  assertString(event.id, 'id', event.id)
  assertEvidenceShape(event.evidence, event.id)
  assertNarrativeKernel(
    Number.isInteger(event.chapterOrdinal) && event.chapterOrdinal > 0,
    'NARRATIVE_PATCH_INVALID',
    '事件章节序号必须是正整数',
    { eventId: event.id, chapterOrdinal: event.chapterOrdinal }
  )
  switch (event.type) {
    case 'ActorIntroduced':
      assertString(event.actorId, 'actorId', event.id)
      assertString(event.canonicalName, 'canonicalName', event.id)
      break
    case 'LocationIntroduced':
      assertString(event.locationId, 'locationId', event.id)
      assertString(event.canonicalName, 'canonicalName', event.id)
      break
    case 'ArtifactIntroduced':
      assertString(event.artifactId, 'artifactId', event.id)
      assertString(event.canonicalName, 'canonicalName', event.id)
      assertString(event.provenance.sourceEntityId, 'provenance.sourceEntityId', event.id)
      assertNarrativeKernel(
        Number.isInteger(event.quantity) && event.quantity > 0,
        'NARRATIVE_PATCH_INVALID',
        '新道具数量必须是正整数',
        { eventId: event.id, quantity: event.quantity }
      )
      break
    case 'ArtifactTransferred':
      assertString(event.artifactId, 'artifactId', event.id)
      break
    case 'ArtifactUsed':
      assertString(event.artifactId, 'artifactId', event.id)
      assertString(event.actorId, 'actorId', event.id)
      assertString(event.action, 'action', event.id)
      break
    case 'ArtifactConsumed':
      assertString(event.artifactId, 'artifactId', event.id)
      assertString(event.actorId, 'actorId', event.id)
      break
    case 'ClaimEstablished':
      assertString(event.claimId, 'claimId', event.id)
      assertString(event.subjectEntityId, 'subjectEntityId', event.id)
      assertString(event.predicate, 'predicate', event.id)
      assertString(event.objectValue, 'objectValue', event.id)
      break
    case 'ActorLearnedClaim':
      assertString(event.actorId, 'actorId', event.id)
      assertString(event.claimId, 'claimId', event.id)
      break
    case 'ActorActedOnClaim':
      assertString(event.actorId, 'actorId', event.id)
      assertString(event.claimId, 'claimId', event.id)
      assertString(event.action, 'action', event.id)
      break
    default: {
      const exhaustive: never = event
      throw new Error(`UNSUPPORTED_NARRATIVE_EVENT:${String(exhaustive)}`)
    }
  }
}

function eventMatchesConstraint(
  event: ProposedNarrativeEvent,
  constraint: EventRequirement | EventProhibition
): boolean {
  return event.type === constraint.eventType && (
    constraint.entityId == null || allEventEntityIds(event).includes(constraint.entityId)
  )
}

function materializeEvent(
  event: ProposedNarrativeEvent,
  chapterVersionId: string
): NarrativeEvent {
  return {
    ...event,
    evidence: {
      chapterVersionId,
      startOffset: event.evidence.startOffset,
      endOffset: event.evidence.endOffset,
      quoteHash: event.evidence.quoteHash
    }
  } as NarrativeEvent
}

export function validateNarrativePatch(input: {
  intent: ChapterIntent
  candidate: ChapterCandidate
  patch: NarrativePatch
  state: NarrativeState
}): ValidatedNarrativePatch {
  const { intent, candidate, patch, state } = input
  assertNarrativeKernel(
    intent.workId === state.workId && intent.baseStateRevision === state.revision,
    'CHAPTER_INTENT_STALE',
    '章节契约不再基于当前权威状态',
    {
      intentWorkId: intent.workId,
      stateWorkId: state.workId,
      intentRevision: intent.baseStateRevision,
      stateRevision: state.revision
    }
  )
  assertNarrativeKernel(
    candidate.intentId === intent.id &&
      patch.intentId === intent.id &&
      patch.candidateId === candidate.id &&
      patch.baseStateRevision === intent.baseStateRevision,
    'NARRATIVE_PATCH_INVALID',
    '候选正文、补丁和章节契约身份不一致',
    {
      intentId: intent.id,
      candidateIntentId: candidate.intentId,
      patchIntentId: patch.intentId,
      patchCandidateId: patch.candidateId,
      candidateId: candidate.id
    }
  )

  const existingIds = stateEntityIds(state)
  for (const entityId of intent.allowedEntityIds) {
    assertNarrativeKernel(
      existingIds.has(entityId),
      'CHAPTER_INTENT_INVALID',
      '章节契约允许了不存在的权威实体',
      { entityId }
    )
  }
  for (const entityId of intent.creatableEntityIds) {
    assertNarrativeKernel(
      !existingIds.has(entityId),
      'CHAPTER_INTENT_STALE',
      '章节契约计划创建的实体已经存在',
      { entityId }
    )
  }

  const introducedIds = new Set(patch.events.flatMap(introducedEntityIds))
  for (const event of patch.events) {
    assertEventShape(event)
    assertNarrativeKernel(
      event.chapterOrdinal === intent.chapterOrdinal,
      'NARRATIVE_PATCH_INVALID',
      '补丁事件章节序号与章节契约不一致',
      { eventId: event.id, chapterOrdinal: event.chapterOrdinal }
    )
    assertNarrativeKernel(
      event.evidence.candidateId === candidate.id,
      'EVIDENCE_SCOPE_MISMATCH',
      '补丁事件证据不属于当前候选正文',
      { eventId: event.id, candidateId: candidate.id }
    )
    validateEvidenceSpan(
      materializeEvent(event, candidate.id).evidence,
      candidate.id,
      new CandidateContentRegistry(candidate)
    )
    for (const entityId of introducedEntityIds(event)) {
      assertNarrativeKernel(
        intent.creatableEntityIds.includes(entityId),
        'PATCH_ENTITY_NOT_ALLOWED',
        '补丁创建了章节契约未授权的新实体',
        { eventId: event.id, entityId }
      )
    }
    for (const entityId of referencedEntityIds(event)) {
      if (introducedIds.has(entityId)) continue
      assertNarrativeKernel(
        existingIds.has(entityId),
        'ENTITY_REFERENCE_UNKNOWN',
        '补丁引用了不存在的实体',
        { eventId: event.id, entityId }
      )
      assertNarrativeKernel(
        intent.allowedEntityIds.includes(entityId),
        'PATCH_ENTITY_NOT_ALLOWED',
        '补丁引用了章节契约未授权的既有实体',
        { eventId: event.id, entityId }
      )
    }
  }

  for (const requirement of intent.requiredEvents) {
    const count = patch.events.filter(event => eventMatchesConstraint(event, requirement)).length
    assertNarrativeKernel(
      count >= requirement.minCount,
      'PATCH_REQUIRED_EVENT_MISSING',
      '补丁没有完成章节契约要求的事件',
      { requirement, actualCount: count }
    )
  }
  for (const prohibition of intent.forbiddenEvents) {
    const event = patch.events.find(item => eventMatchesConstraint(item, prohibition))
    assertNarrativeKernel(
      !event,
      'PATCH_FORBIDDEN_EVENT_PRESENT',
      '补丁包含章节契约禁止的事件',
      { prohibition, eventId: event?.id }
    )
  }

  const previewCommit: NarrativeCommit = {
    id: `preview:${patch.id}`,
    workId: intent.workId,
    chapterVersionId: candidate.id,
    chapterOrdinal: intent.chapterOrdinal,
    baseRevision: intent.baseStateRevision,
    revision: intent.baseStateRevision + 1,
    events: patch.events.map(event => materializeEvent(event, candidate.id))
  }
  const previewState = applyNarrativeCommit(
    state,
    previewCommit,
    new CandidateContentRegistry(candidate)
  )
  return {
    intentId: intent.id,
    intentHash: intent.contractHash,
    candidateId: candidate.id,
    candidateHash: candidate.contentHash,
    patchId: patch.id,
    patchHash: patch.patchHash,
    baseStateRevision: patch.baseStateRevision,
    previewStateHash: previewState.stateHash
  }
}

export function prepareNarrativeCommit(input: {
  intent: ChapterIntent
  candidate: ChapterCandidate
  patch: NarrativePatch
  validated: ValidatedNarrativePatch
  commitId: string
  chapterVersionId: string
}): NarrativeCommit {
  const { intent, candidate, patch, validated } = input
  assertNarrativeKernel(
    validated.intentHash === intent.contractHash &&
      validated.candidateHash === candidate.contentHash &&
      validated.patchHash === patch.patchHash &&
      validated.intentId === intent.id &&
      validated.candidateId === candidate.id &&
      validated.patchId === patch.id,
    'PIPELINE_ARTIFACT_HASH_MISMATCH',
    '提交准备阶段的契约、候选或补丁已经变化',
    {
      intentId: intent.id,
      candidateId: candidate.id,
      patchId: patch.id
    }
  )
  return {
    id: input.commitId,
    workId: intent.workId,
    chapterVersionId: input.chapterVersionId,
    chapterOrdinal: intent.chapterOrdinal,
    baseRevision: intent.baseStateRevision,
    revision: intent.baseStateRevision + 1,
    events: patch.events.map(event => materializeEvent(event, input.chapterVersionId))
  }
}
