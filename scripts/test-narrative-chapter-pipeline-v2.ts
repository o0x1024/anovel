import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  NarrativeChapterPipeline,
  NarrativeKernelError,
  REQUIRED_EDITORIAL_GATES,
  parseNarrativePatch,
  sha256,
  type CandidateEvidenceSpan
} from '../src/main/narrative-kernel'

const db = new Database(':memory:')
const pipeline = new NarrativeChapterPipeline(db)

function expectCode(code: NarrativeKernelError['code'], run: () => unknown): void {
  assert.throws(run, error => {
    assert.ok(error instanceof NarrativeKernelError)
    assert.equal(error.code, code)
    return true
  })
}

function evidence(candidateId: string, content: string, quote: string): CandidateEvidenceSpan {
  const startOffset = content.indexOf(quote)
  assert.notEqual(startOffset, -1, `测试引文不存在：${quote}`)
  return {
    candidateId,
    startOffset,
    endOffset: startOffset + quote.length,
    quoteHash: sha256(quote)
  }
}

try {
  pipeline.createNovel({ id: 100, title: '自动章节流水线测试' })

  expectCode('CHAPTER_INTENT_INVALID', () => pipeline.registerIntent({
    id: 'intent-100-skipped',
    workId: 100,
    chapterOrdinal: 2,
    baseStateRevision: 0,
    objective: '故意跳过第一章',
    requiredEvents: [],
    forbiddenEvents: [],
    allowedEntityIds: [],
    creatableEntityIds: [],
    targetWordRange: { min: 1, max: 100 }
  }))

  const intent = pipeline.registerIntent({
    id: 'intent-100-1',
    workId: 100,
    chapterOrdinal: 1,
    baseStateRevision: 0,
    objective: '建立陈凉继承徽章并进入避难所的权威事实',
    requiredEvents: [{
      eventType: 'ArtifactIntroduced',
      entityId: 'artifact-badge',
      minCount: 1
    }],
    forbiddenEvents: [{ eventType: 'ArtifactTransferred', entityId: 'artifact-badge' }],
    allowedEntityIds: [],
    creatableEntityIds: [
      'actor-chenliang',
      'actor-father',
      'actor-laozhou',
      'location-shelter',
      'artifact-badge'
    ],
    targetWordRange: { min: 10, max: 100 }
  })

  const content = '陈凉继承了父亲留下的旧徽章，随后在老周注视下走进避难所。'
  expectCode('CHAPTER_CANDIDATE_TRUNCATED', () => pipeline.registerCandidate({
    id: 'candidate-truncated',
    intentId: intent.id,
    content,
    generation: {
      source: 'model',
      finishReason: 'length',
      completionTokens: 30,
      modelCallId: 'model-call-truncated'
    }
  }))

  const candidate = pipeline.registerCandidate({
    id: 'candidate-100-1',
    intentId: intent.id,
    content,
    generation: {
      source: 'model',
      finishReason: 'stop',
      completionTokens: 48,
      modelCallId: 'model-call-100-1'
    }
  })

  const rawPatch = {
    id: 'patch-100-1',
    intentId: intent.id,
    candidateId: candidate.id,
    baseStateRevision: 0,
    events: [
      {
        id: 'event-100-chenliang',
        type: 'ActorIntroduced',
        chapterOrdinal: 1,
        actorId: 'actor-chenliang',
        canonicalName: '陈凉',
        aliases: [],
        evidence: evidence(candidate.id, content, '陈凉')
      },
      {
        id: 'event-100-father',
        type: 'ActorIntroduced',
        chapterOrdinal: 1,
        actorId: 'actor-father',
        canonicalName: '陈凉的父亲',
        aliases: ['父亲'],
        evidence: evidence(candidate.id, content, '父亲')
      },
      {
        id: 'event-100-laozhou',
        type: 'ActorIntroduced',
        chapterOrdinal: 1,
        actorId: 'actor-laozhou',
        canonicalName: '老周',
        aliases: [],
        evidence: evidence(candidate.id, content, '老周')
      },
      {
        id: 'event-100-shelter',
        type: 'LocationIntroduced',
        chapterOrdinal: 1,
        locationId: 'location-shelter',
        canonicalName: '避难所',
        aliases: [],
        evidence: evidence(candidate.id, content, '避难所')
      },
      {
        id: 'event-100-badge',
        type: 'ArtifactIntroduced',
        chapterOrdinal: 1,
        artifactId: 'artifact-badge',
        canonicalName: '父亲的旧徽章',
        aliases: ['旧徽章', '徽章'],
        provenance: {
          kind: 'inherited',
          sourceEntityId: 'actor-father'
        },
        holder: { kind: 'actor', actorId: 'actor-chenliang' },
        quantity: 1,
        evidence: evidence(candidate.id, content, '继承了父亲留下的旧徽章')
      }
    ]
  }

  expectCode('NARRATIVE_PATCH_INVALID', () => parseNarrativePatch({
    ...rawPatch,
    undeclaredModelField: '不得接受'
  }))

  const patch = pipeline.registerPatch(rawPatch)
  const validated = pipeline.validatePatch({
    intentId: intent.id,
    candidateId: candidate.id,
    patchId: patch.id
  })
  assert.equal(validated.baseStateRevision, 0)
  assert.equal(validated.intentHash, intent.contractHash)

  expectCode('EVIDENCE_SCOPE_MISMATCH', () => pipeline.recordEditorialGate({
    id: 'gate-wrong-candidate-evidence',
    candidateId: candidate.id,
    gateType: 'causal_motivation',
    policyVersion: 1,
    status: 'passed',
    report: '故意绑定错误候选证据',
    evidence: [{
      ...evidence(candidate.id, content, '陈凉'),
      candidateId: 'another-candidate'
    }]
  }))

  const commitInput = {
    intentId: intent.id,
    candidateId: candidate.id,
    patchId: patch.id,
    commitId: 'commit-100-1',
    chapterVersionId: 'chapter-version-100-1',
    editorialPolicyVersion: 1
  }
  expectCode('EDITORIAL_GATE_INCOMPLETE', () => pipeline.commitCandidate(commitInput))
  assert.equal(pipeline.loadState(100).revision, 0)
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM narrative_chapter_versions').get() as { count: number }).count,
    0,
    '文学门未完成时不得留下章节版本'
  )

  for (const gateType of REQUIRED_EDITORIAL_GATES) {
    pipeline.recordEditorialGate({
      id: `gate-100-1-${gateType}`,
      candidateId: candidate.id,
      gateType,
      policyVersion: 1,
      status: 'passed',
      score: 90,
      report: `${gateType} 已通过，并绑定候选 ${candidate.id}`,
      evidence: [evidence(candidate.id, content, '陈凉继承了父亲留下的旧徽章')]
    })
  }

  const committed = pipeline.commitCandidate(commitInput)
  assert.equal(committed.revision, 1)
  assert.deepEqual(
    committed.artifacts['artifact-badge'].holder,
    { kind: 'actor', actorId: 'actor-chenliang' }
  )
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS count FROM narrative_pipeline_commits').get() as { count: number }).count,
    1
  )
  assert.deepEqual(pipeline.integrityCheck(), [])

  expectCode('CHAPTER_INTENT_STALE', () => pipeline.registerIntent({
    id: 'intent-100-stale',
    workId: 100,
    chapterOrdinal: 2,
    baseStateRevision: 0,
    objective: '故意建立过期契约',
    requiredEvents: [{ eventType: 'ArtifactUsed', minCount: 1 }],
    forbiddenEvents: [],
    allowedEntityIds: ['actor-chenliang', 'artifact-badge'],
    creatableEntityIds: [],
    targetWordRange: { min: 1, max: 100 }
  }))

  console.log('narrative-chapter-pipeline-v2 tests passed')
} finally {
  db.close()
}
