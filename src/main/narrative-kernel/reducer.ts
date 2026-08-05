import {
  NARRATIVE_KERNEL_SCHEMA_VERSION,
  actorKnowledgeKey,
  artifactHolderKey,
  type ActorKnowledgeState,
  type ArtifactHolder,
  type ChapterContentRegistry,
  type NarrativeCommit,
  type NarrativeEvent,
  type NarrativeState
} from './domain'
import { assertNarrativeKernel, NarrativeKernelError } from './errors'
import { validateEvidenceSpan } from './evidence'
import { canonicalHash } from './hash'

function stateWithoutHash(state: NarrativeState): Omit<NarrativeState, 'stateHash'> {
  const { stateHash: _stateHash, ...rest } = state
  return rest
}

export function calculateNarrativeStateHash(state: NarrativeState): string {
  return canonicalHash(stateWithoutHash(state))
}

export function createEmptyNarrativeState(workId: number): NarrativeState {
  const state: NarrativeState = {
    schemaVersion: NARRATIVE_KERNEL_SCHEMA_VERSION,
    workId,
    revision: 0,
    actors: {},
    locations: {},
    artifacts: {},
    claims: {},
    actorKnowledge: {},
    appliedEventIds: {},
    stateHash: ''
  }
  return { ...state, stateHash: calculateNarrativeStateHash(state) }
}

function cloneState(state: NarrativeState): NarrativeState {
  return structuredClone(state)
}

function sameHolder(left: ArtifactHolder, right: ArtifactHolder): boolean {
  return artifactHolderKey(left) === artifactHolderKey(right)
}

function assertActorExists(state: NarrativeState, actorId: string): void {
  assertNarrativeKernel(
    state.actors[actorId],
    'ENTITY_REFERENCE_UNKNOWN',
    `人物实体不存在：${actorId}`,
    { kind: 'actor', entityId: actorId }
  )
}

function assertEntityExists(state: NarrativeState, entityId: string): void {
  assertNarrativeKernel(
    state.actors[entityId] || state.locations[entityId] || state.artifacts[entityId],
    'ENTITY_REFERENCE_UNKNOWN',
    `事实声明主体实体不存在：${entityId}`,
    { entityId }
  )
}

function assertHolderExists(state: NarrativeState, holder: ArtifactHolder): void {
  if (holder.kind === 'actor') {
    assertActorExists(state, holder.actorId)
    return
  }
  assertNarrativeKernel(
    state.locations[holder.locationId],
    'ENTITY_REFERENCE_UNKNOWN',
    `地点实体不存在：${holder.locationId}`,
    { kind: 'location', entityId: holder.locationId }
  )
}

function applyEvent(state: NarrativeState, event: NarrativeEvent): void {
  assertNarrativeKernel(
    !state.appliedEventIds[event.id],
    'EVENT_ID_DUPLICATE',
    `叙事事件已经应用：${event.id}`,
    { eventId: event.id }
  )

  switch (event.type) {
    case 'ActorIntroduced': {
      assertNarrativeKernel(
        !state.actors[event.actorId],
        'ENTITY_ALREADY_EXISTS',
        `人物实体已经存在：${event.actorId}`,
        { kind: 'actor', entityId: event.actorId }
      )
      state.actors[event.actorId] = {
        id: event.actorId,
        canonicalName: event.canonicalName,
        aliases: [...event.aliases],
        alive: true
      }
      break
    }
    case 'LocationIntroduced': {
      assertNarrativeKernel(
        !state.locations[event.locationId],
        'ENTITY_ALREADY_EXISTS',
        `地点实体已经存在：${event.locationId}`,
        { kind: 'location', entityId: event.locationId }
      )
      state.locations[event.locationId] = {
        id: event.locationId,
        canonicalName: event.canonicalName,
        aliases: [...event.aliases]
      }
      break
    }
    case 'ArtifactIntroduced': {
      const existing = state.artifacts[event.artifactId]
      if (existing) {
        const sameProvenance = canonicalHash(existing.provenance) === canonicalHash(event.provenance)
        throw new NarrativeKernelError(
          sameProvenance ? 'ENTITY_ALREADY_EXISTS' : 'ARTIFACT_PROVENANCE_CONFLICT',
          sameProvenance
            ? `道具实体已经存在：${event.artifactId}`
            : `道具来源与权威状态冲突：${event.artifactId}`,
          {
            artifactId: event.artifactId,
            existingProvenance: existing.provenance,
            proposedProvenance: event.provenance
          }
        )
      }
      assertNarrativeKernel(
        Number.isInteger(event.quantity) && event.quantity > 0,
        'ARTIFACT_QUANTITY_INVALID',
        '新道具数量必须是正整数',
        { artifactId: event.artifactId, quantity: event.quantity }
      )
      assertEntityExists(state, event.provenance.sourceEntityId)
      assertHolderExists(state, event.holder)
      state.artifacts[event.artifactId] = {
        id: event.artifactId,
        canonicalName: event.canonicalName,
        aliases: [...event.aliases],
        provenance: { ...event.provenance },
        holder: { ...event.holder },
        quantity: event.quantity,
        retired: false,
        lastMutationEventId: event.id
      }
      break
    }
    case 'ArtifactTransferred': {
      const artifact = state.artifacts[event.artifactId]
      assertNarrativeKernel(
        artifact,
        'ENTITY_REFERENCE_UNKNOWN',
        `道具实体不存在：${event.artifactId}`,
        { kind: 'artifact', entityId: event.artifactId }
      )
      assertNarrativeKernel(
        !artifact.retired,
        'ARTIFACT_ALREADY_RETIRED',
        `已退役道具不能转移：${event.artifactId}`,
        { artifactId: event.artifactId }
      )
      assertHolderExists(state, event.from)
      assertHolderExists(state, event.to)
      assertNarrativeKernel(
        sameHolder(artifact.holder, event.from),
        'ARTIFACT_NOT_OWNED',
        `转出方并未持有道具：${event.artifactId}`,
        {
          artifactId: event.artifactId,
          actualHolder: artifact.holder,
          proposedFrom: event.from
        }
      )
      artifact.holder = { ...event.to }
      artifact.lastMutationEventId = event.id
      break
    }
    case 'ArtifactUsed': {
      const artifact = state.artifacts[event.artifactId]
      assertNarrativeKernel(
        artifact,
        'ENTITY_REFERENCE_UNKNOWN',
        `道具实体不存在：${event.artifactId}`,
        { kind: 'artifact', entityId: event.artifactId }
      )
      assertActorExists(state, event.actorId)
      assertNarrativeKernel(
        !artifact.retired,
        'ARTIFACT_ALREADY_RETIRED',
        `已退役道具不能使用：${event.artifactId}`,
        { artifactId: event.artifactId }
      )
      assertNarrativeKernel(
        sameHolder(artifact.holder, { kind: 'actor', actorId: event.actorId }),
        'ARTIFACT_NOT_OWNED',
        `人物并未持有使用的道具：${event.artifactId}`,
        {
          artifactId: event.artifactId,
          actorId: event.actorId,
          actualHolder: artifact.holder
        }
      )
      artifact.lastMutationEventId = event.id
      break
    }
    case 'ArtifactConsumed': {
      const artifact = state.artifacts[event.artifactId]
      assertNarrativeKernel(
        artifact,
        'ENTITY_REFERENCE_UNKNOWN',
        `道具实体不存在：${event.artifactId}`,
        { kind: 'artifact', entityId: event.artifactId }
      )
      assertActorExists(state, event.actorId)
      assertNarrativeKernel(
        !artifact.retired,
        'ARTIFACT_ALREADY_RETIRED',
        `已退役道具不能消耗：${event.artifactId}`,
        { artifactId: event.artifactId }
      )
      assertNarrativeKernel(
        sameHolder(artifact.holder, { kind: 'actor', actorId: event.actorId }),
        'ARTIFACT_NOT_OWNED',
        `人物并未持有消耗的道具：${event.artifactId}`,
        { artifactId: event.artifactId, actorId: event.actorId }
      )
      assertNarrativeKernel(
        Number.isInteger(event.quantity) && event.quantity > 0,
        'ARTIFACT_QUANTITY_INVALID',
        '道具消耗数量必须是正整数',
        { artifactId: event.artifactId, quantity: event.quantity }
      )
      assertNarrativeKernel(
        artifact.quantity >= event.quantity,
        'ARTIFACT_QUANTITY_INSUFFICIENT',
        `道具数量不足：${event.artifactId}`,
        {
          artifactId: event.artifactId,
          available: artifact.quantity,
          requested: event.quantity
        }
      )
      artifact.quantity -= event.quantity
      artifact.retired = artifact.quantity === 0
      artifact.lastMutationEventId = event.id
      break
    }
    case 'ClaimEstablished': {
      assertEntityExists(state, event.subjectEntityId)
      assertNarrativeKernel(
        !state.claims[event.claimId],
        'ENTITY_ALREADY_EXISTS',
        `事实声明已经存在：${event.claimId}`,
        { kind: 'claim', entityId: event.claimId }
      )
      state.claims[event.claimId] = {
        id: event.claimId,
        subjectEntityId: event.subjectEntityId,
        predicate: event.predicate,
        objectValue: event.objectValue,
        truthStatus: event.truthStatus,
        establishedByEventId: event.id
      }
      break
    }
    case 'ActorLearnedClaim': {
      assertActorExists(state, event.actorId)
      assertNarrativeKernel(
        state.claims[event.claimId],
        'KNOWLEDGE_CLAIM_UNKNOWN',
        `人物获得了不存在的事实声明：${event.claimId}`,
        { actorId: event.actorId, claimId: event.claimId }
      )
      const knowledge: ActorKnowledgeState = {
        actorId: event.actorId,
        claimId: event.claimId,
        belief: event.belief,
        learnedByEventId: event.id
      }
      state.actorKnowledge[actorKnowledgeKey(event.actorId, event.claimId)] = knowledge
      break
    }
    case 'ActorActedOnClaim': {
      assertActorExists(state, event.actorId)
      assertNarrativeKernel(
        state.claims[event.claimId],
        'KNOWLEDGE_CLAIM_UNKNOWN',
        `人物行动依赖不存在的事实声明：${event.claimId}`,
        { actorId: event.actorId, claimId: event.claimId }
      )
      assertNarrativeKernel(
        state.actorKnowledge[actorKnowledgeKey(event.actorId, event.claimId)],
        'KNOWLEDGE_PRECONDITION_FAILED',
        `人物尚未获得行动所依赖的信息：${event.claimId}`,
        { actorId: event.actorId, claimId: event.claimId, action: event.action }
      )
      break
    }
  }

  state.appliedEventIds[event.id] = true
}

export function applyNarrativeCommit(
  current: NarrativeState,
  commit: NarrativeCommit,
  contentRegistry: ChapterContentRegistry
): NarrativeState {
  assertNarrativeKernel(
    current.workId === commit.workId,
    'ENTITY_REFERENCE_UNKNOWN',
    '章节提交不属于当前小说事件流',
    { expectedWorkId: current.workId, actualWorkId: commit.workId }
  )
  assertNarrativeKernel(
    current.revision === commit.baseRevision,
    'STATE_REVISION_STALE',
    '章节提交基于过期的权威状态修订',
    { currentRevision: current.revision, baseRevision: commit.baseRevision }
  )
  assertNarrativeKernel(
    commit.revision === current.revision + 1,
    'COMMIT_REVISION_INVALID',
    '章节提交修订必须连续递增',
    { currentRevision: current.revision, commitRevision: commit.revision }
  )
  assertNarrativeKernel(
    commit.events.length > 0,
    'COMMIT_REVISION_INVALID',
    '章节提交至少必须包含一个叙事事件',
    { commitId: commit.id }
  )

  const next = cloneState(current)
  for (const event of commit.events) {
    assertNarrativeKernel(
      event.chapterOrdinal === commit.chapterOrdinal,
      'EVIDENCE_SCOPE_MISMATCH',
      '事件章节序号与提交章节不一致',
      {
        eventId: event.id,
        eventChapterOrdinal: event.chapterOrdinal,
        commitChapterOrdinal: commit.chapterOrdinal
      }
    )
    validateEvidenceSpan(event.evidence, commit.chapterVersionId, contentRegistry)
    applyEvent(next, event)
  }

  next.revision = commit.revision
  next.stateHash = calculateNarrativeStateHash(next)
  return next
}

export function replayNarrativeCommits(
  workId: number,
  commits: NarrativeCommit[],
  contentRegistry: ChapterContentRegistry
): NarrativeState {
  return commits.reduce(
    (state, commit) => applyNarrativeCommit(state, commit, contentRegistry),
    createEmptyNarrativeState(workId)
  )
}
