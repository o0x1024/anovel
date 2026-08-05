import assert from 'node:assert/strict'
import {
  NarrativeKernelError,
  applyNarrativeCommit,
  createEmptyNarrativeState,
  replayNarrativeCommits,
  resolveNarrativeEntityId,
  sha256,
  type ChapterContentRegistry,
  type EvidenceSpan,
  type NarrativeCommit,
  type NarrativeEvent,
  type NarrativeState
} from '../src/main/narrative-kernel'

class MemoryChapterContentRegistry implements ChapterContentRegistry {
  constructor(private readonly contents: Readonly<Record<string, string>>) {}

  getChapterContent(chapterVersionId: string): string | undefined {
    return this.contents[chapterVersionId]
  }
}

const contents = {
  ch1: '陈凉一直带着父亲留下的旧徽章。老周在避难所里检查门锁。',
  ch2: '陈凉把父亲留下的旧徽章交给老周，换取进入仓库的机会。',
  ch3: '陈凉从自己口袋里拿出那枚旧徽章，贴在门禁感应区。',
  ch4: '陈凉从收尸人的外套内袋里找到了那枚旧徽章。',
  ch5: '陈凉在废墟找到两个监听器，其中一个来自刘梅房间。',
  ch6: '陈凉依据避难所今晚停电的秘密，提前潜入了配电室。',
  ch7: '老周告诉陈凉：避难所今晚会停电。'
} as const

const registry = new MemoryChapterContentRegistry(contents)

function evidence(chapterVersionId: keyof typeof contents, quote: string): EvidenceSpan {
  const content = contents[chapterVersionId]
  const startOffset = content.indexOf(quote)
  assert.notEqual(startOffset, -1, `测试引文不存在：${quote}`)
  return {
    chapterVersionId,
    startOffset,
    endOffset: startOffset + quote.length,
    quoteHash: sha256(quote)
  }
}

function commit(
  revision: number,
  chapterVersionId: keyof typeof contents,
  events: NarrativeEvent[]
): NarrativeCommit {
  return {
    id: `commit-${revision}`,
    workId: 49,
    chapterVersionId,
    chapterOrdinal: revision,
    baseRevision: revision - 1,
    revision,
    events
  }
}

function expectKernelError(
  expectedCode: NarrativeKernelError['code'],
  execute: () => unknown
): NarrativeKernelError {
  try {
    execute()
  } catch (error) {
    assert.ok(error instanceof NarrativeKernelError)
    assert.equal(error.code, expectedCode)
    return error as NarrativeKernelError
  }
  throw new Error(`预期失败码未抛出：${expectedCode}`)
}

const chapter1 = commit(1, 'ch1', [
  {
    id: 'event-actor-chenliang',
    type: 'ActorIntroduced',
    chapterOrdinal: 1,
    actorId: 'actor-chenliang',
    canonicalName: '陈凉',
    aliases: ['陈凉'],
    evidence: evidence('ch1', '陈凉')
  },
  {
    id: 'event-actor-laozhou',
    type: 'ActorIntroduced',
    chapterOrdinal: 1,
    actorId: 'actor-laozhou',
    canonicalName: '老周',
    aliases: ['周叔'],
    evidence: evidence('ch1', '老周')
  },
  {
    id: 'event-actor-father',
    type: 'ActorIntroduced',
    chapterOrdinal: 1,
    actorId: 'actor-father',
    canonicalName: '陈凉的父亲',
    aliases: ['父亲'],
    evidence: evidence('ch1', '父亲')
  },
  {
    id: 'event-location-shelter',
    type: 'LocationIntroduced',
    chapterOrdinal: 1,
    locationId: 'location-shelter',
    canonicalName: '避难所',
    aliases: ['庇护所'],
    evidence: evidence('ch1', '避难所')
  },
  {
    id: 'event-badge-introduced',
    type: 'ArtifactIntroduced',
    chapterOrdinal: 1,
    artifactId: 'artifact-father-badge',
    canonicalName: '父亲的旧徽章',
    aliases: ['旧徽章', '徽章'],
    provenance: { kind: 'inherited', sourceEntityId: 'actor-father' },
    holder: { kind: 'actor', actorId: 'actor-chenliang' },
    quantity: 1,
    evidence: evidence('ch1', '父亲留下的旧徽章')
  }
])

const chapter2 = commit(2, 'ch2', [
  {
    id: 'event-badge-transferred',
    type: 'ArtifactTransferred',
    chapterOrdinal: 2,
    artifactId: 'artifact-father-badge',
    from: { kind: 'actor', actorId: 'actor-chenliang' },
    to: { kind: 'actor', actorId: 'actor-laozhou' },
    evidence: evidence('ch2', '陈凉把父亲留下的旧徽章交给老周')
  }
])

const stateAfterTransfer = replayNarrativeCommits(49, [chapter1, chapter2], registry)
assert.equal(stateAfterTransfer.revision, 2)
assert.deepEqual(
  stateAfterTransfer.artifacts['artifact-father-badge'].holder,
  { kind: 'actor', actorId: 'actor-laozhou' }
)

const illegalBadgeUse = commit(3, 'ch3', [
  {
    id: 'event-badge-illegal-use',
    type: 'ArtifactUsed',
    chapterOrdinal: 3,
    artifactId: 'artifact-father-badge',
    actorId: 'actor-chenliang',
    action: '贴在门禁感应区',
    evidence: evidence('ch3', '陈凉从自己口袋里拿出那枚旧徽章')
  }
])
expectKernelError(
  'ARTIFACT_NOT_OWNED',
  () => applyNarrativeCommit(stateAfterTransfer, illegalBadgeUse, registry)
)
assert.equal(stateAfterTransfer.revision, 2, '失败提交不得修改输入状态')
assert.deepEqual(
  stateAfterTransfer.artifacts['artifact-father-badge'].holder,
  { kind: 'actor', actorId: 'actor-laozhou' },
  '失败提交不得污染权威所有权'
)

const conflictingBadgeOrigin = commit(3, 'ch4', [
  {
    id: 'event-badge-second-origin',
    type: 'ArtifactIntroduced',
    chapterOrdinal: 3,
    artifactId: 'artifact-father-badge',
    canonicalName: '旧徽章',
    aliases: ['徽章'],
    provenance: { kind: 'found', sourceEntityId: 'actor-corpse-collector' },
    holder: { kind: 'actor', actorId: 'actor-chenliang' },
    quantity: 1,
    evidence: evidence('ch4', '从收尸人的外套内袋里找到了那枚旧徽章')
  }
])
expectKernelError(
  'ARTIFACT_PROVENANCE_CONFLICT',
  () => applyNarrativeCommit(stateAfterTransfer, conflictingBadgeOrigin, registry)
)

const listenerState = applyNarrativeCommit(
  stateAfterTransfer,
  commit(3, 'ch5', [
    {
      id: 'event-location-liumei-room',
      type: 'LocationIntroduced',
      chapterOrdinal: 3,
      locationId: 'location-liumei-room',
      canonicalName: '刘梅房间',
      aliases: [],
      evidence: evidence('ch5', '刘梅房间')
    },
    {
      id: 'event-listener-one',
      type: 'ArtifactIntroduced',
      chapterOrdinal: 3,
      artifactId: 'artifact-listener-wire',
      canonicalName: '自制监听器',
      aliases: ['监听器'],
      provenance: { kind: 'created', sourceEntityId: 'actor-chenliang' },
      holder: { kind: 'actor', actorId: 'actor-chenliang' },
      quantity: 1,
      evidence: evidence('ch5', '监听器')
    },
    {
      id: 'event-listener-two',
      type: 'ArtifactIntroduced',
      chapterOrdinal: 3,
      artifactId: 'artifact-listener-liumei',
      canonicalName: '刘梅房间的监听器',
      aliases: ['监听器'],
      provenance: { kind: 'found', sourceEntityId: 'location-liumei-room' },
      holder: { kind: 'actor', actorId: 'actor-chenliang' },
      quantity: 1,
      evidence: evidence('ch5', '来自刘梅房间')
    }
  ]),
  registry
)
expectKernelError(
  'ENTITY_REFERENCE_AMBIGUOUS',
  () => resolveNarrativeEntityId(listenerState, 'artifact', '监听器')
)

const knowledgeBase = applyNarrativeCommit(
  stateAfterTransfer,
  commit(3, 'ch6', [
    {
      id: 'event-blackout-claim',
      type: 'ClaimEstablished',
      chapterOrdinal: 3,
      claimId: 'claim-shelter-blackout',
      subjectEntityId: 'location-shelter',
      predicate: 'will_blackout_at',
      objectValue: 'tonight',
      truthStatus: 'true',
      evidence: evidence('ch6', '避难所今晚停电的秘密')
    }
  ]),
  registry
)
expectKernelError(
  'KNOWLEDGE_PRECONDITION_FAILED',
  () => applyNarrativeCommit(
    knowledgeBase,
    commit(4, 'ch6', [
      {
        id: 'event-acted-before-learning',
        type: 'ActorActedOnClaim',
        chapterOrdinal: 4,
        actorId: 'actor-chenliang',
        claimId: 'claim-shelter-blackout',
        action: '提前潜入配电室',
        evidence: evidence('ch6', '提前潜入了配电室')
      }
    ]),
    registry
  )
)

const wrongChapterEvidence = commit(3, 'ch3', [
  {
    id: 'event-wrong-evidence-scope',
    type: 'ArtifactUsed',
    chapterOrdinal: 3,
    artifactId: 'artifact-father-badge',
    actorId: 'actor-laozhou',
    action: '检查徽章',
    evidence: evidence('ch2', '旧徽章')
  }
])
expectKernelError(
  'EVIDENCE_SCOPE_MISMATCH',
  () => applyNarrativeCommit(stateAfterTransfer, wrongChapterEvidence, registry)
)

const replayOne = replayNarrativeCommits(49, [chapter1, chapter2], registry)
const replayTwo = replayNarrativeCommits(49, [chapter1, chapter2], registry)
assert.equal(replayOne.stateHash, replayTwo.stateHash, '相同事件流必须得到相同状态哈希')
assert.deepEqual(replayOne, replayTwo, '相同事件流必须得到完全相同状态')

const staleCommit: NarrativeCommit = {
  ...chapter2,
  id: 'commit-stale',
  baseRevision: 0,
  revision: 1
}
expectKernelError(
  'STATE_REVISION_STALE',
  () => applyNarrativeCommit(stateAfterTransfer, staleCommit, registry)
)

const duplicateEventCommit: NarrativeCommit = {
  id: 'commit-duplicate-event',
  workId: 49,
  chapterVersionId: 'ch3',
  chapterOrdinal: 3,
  baseRevision: 2,
  revision: 3,
  events: [{
    ...chapter1.events[0],
    chapterOrdinal: 3,
    evidence: evidence('ch3', '陈凉')
  }]
}
expectKernelError(
  'EVENT_ID_DUPLICATE',
  () => applyNarrativeCommit(stateAfterTransfer, duplicateEventCommit, registry)
)

const learnedState: NarrativeState = applyNarrativeCommit(
  knowledgeBase,
  commit(4, 'ch7', [
    {
      id: 'event-chen-learned-blackout',
      type: 'ActorLearnedClaim',
      chapterOrdinal: 4,
      actorId: 'actor-chenliang',
      claimId: 'claim-shelter-blackout',
      belief: 'knows',
      evidence: evidence('ch7', '老周告诉陈凉：避难所今晚会停电')
    }
  ]),
  registry
)
assert.equal(
  learnedState.actorKnowledge['actor-chenliang:claim-shelter-blackout'].belief,
  'knows'
)

console.log('narrative-kernel-v2 tests passed')
