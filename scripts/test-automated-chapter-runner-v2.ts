import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  AutomatedChapterRunner,
  NarrativeKernelError,
  sha256,
  type ChapterCandidate,
  type NarrativeModelGateway,
  type NarrativeModelRequest,
  type NarrativeModelResponse
} from '../src/main/narrative-kernel'

function expectCode(code: NarrativeKernelError['code'], run: () => unknown): void {
  assert.throws(run, error => {
    assert.ok(error instanceof NarrativeKernelError)
    assert.equal(error.code, code)
    return true
  })
}

const initialContent = '陈凉继承了父亲留下的旧徽章，老周允许他进入避难所。'
const revisedContent = '为了兑现父亲的遗愿，陈凉继承了父亲留下的旧徽章；老周确认他的动机后，允许他进入避难所。'

function completed(input: {
  content?: string
  structuredOutput?: unknown
}): NarrativeModelResponse {
  return {
    status: 'completed',
    finishReason: 'stop',
    ...input,
    promptTokens: 120,
    completionTokens: 80,
    reasoningLength: 0,
    durationMs: 10
  }
}

function candidateEvidence(candidate: ChapterCandidate, quote: string) {
  const startOffset = candidate.content.indexOf(quote)
  assert.notEqual(startOffset, -1, `假模型引文不存在：${quote}`)
  return {
    candidateId: candidate.id,
    startOffset,
    endOffset: startOffset + quote.length,
    quoteHash: sha256(quote)
  }
}

function patchFor(request: NarrativeModelRequest): unknown {
  const candidate = request.input.candidate as ChapterCandidate
  const expectedPatchId = request.input.expectedPatchId as string
  return {
    id: expectedPatchId,
    intentId: candidate.intentId,
    candidateId: candidate.id,
    baseStateRevision: 0,
    events: [
      {
        id: `${expectedPatchId}:chenliang`,
        type: 'ActorIntroduced',
        chapterOrdinal: 1,
        actorId: 'actor-chenliang',
        canonicalName: '陈凉',
        aliases: [],
        evidence: candidateEvidence(candidate, '陈凉')
      },
      {
        id: `${expectedPatchId}:father`,
        type: 'ActorIntroduced',
        chapterOrdinal: 1,
        actorId: 'actor-father',
        canonicalName: '陈凉的父亲',
        aliases: ['父亲'],
        evidence: candidateEvidence(candidate, '父亲')
      },
      {
        id: `${expectedPatchId}:laozhou`,
        type: 'ActorIntroduced',
        chapterOrdinal: 1,
        actorId: 'actor-laozhou',
        canonicalName: '老周',
        aliases: [],
        evidence: candidateEvidence(candidate, '老周')
      },
      {
        id: `${expectedPatchId}:shelter`,
        type: 'LocationIntroduced',
        chapterOrdinal: 1,
        locationId: 'location-shelter',
        canonicalName: '避难所',
        aliases: [],
        evidence: candidateEvidence(candidate, '避难所')
      },
      {
        id: `${expectedPatchId}:badge`,
        type: 'ArtifactIntroduced',
        chapterOrdinal: 1,
        artifactId: 'artifact-badge',
        canonicalName: '父亲的旧徽章',
        aliases: ['旧徽章', '徽章'],
        provenance: { kind: 'inherited', sourceEntityId: 'actor-father' },
        holder: { kind: 'actor', actorId: 'actor-chenliang' },
        quantity: 1,
        evidence: candidateEvidence(candidate, '继承了父亲留下的旧徽章')
      }
    ]
  }
}

class RepairingFakeGateway implements NarrativeModelGateway {
  readonly requests: NarrativeModelRequest[] = []

  async invoke(request: NarrativeModelRequest): Promise<NarrativeModelResponse> {
    this.requests.push(request)
    switch (request.task) {
      case 'chapter_body':
        return completed({ content: initialContent })
      case 'chapter_revision':
        return completed({ content: revisedContent })
      case 'narrative_patch':
        return completed({ structuredOutput: patchFor(request) })
      case 'editorial_gate': {
        const candidate = request.input.candidate as ChapterCandidate
        const gateType = request.input.gateType as string
        const shouldRepair = candidate.content === initialContent && gateType === 'causal_motivation'
        return completed({
          structuredOutput: {
            status: shouldRepair ? 'failed' : 'passed',
            score: shouldRepair ? 55 : 92,
            report: shouldRepair
              ? '继承徽章的行动缺少足够清晰的主动动机'
              : `${gateType} 已通过`,
            evidenceQuotes: [
              shouldRepair ? '陈凉继承了父亲留下的旧徽章' : '为了兑现父亲的遗愿'
            ]
          }
        })
      }
      default:
        throw new Error(`该章节测试网关不支持任务：${request.task}`)
    }
  }
}

class TruncatedGateway implements NarrativeModelGateway {
  readonly requests: NarrativeModelRequest[] = []

  async invoke(request: NarrativeModelRequest): Promise<NarrativeModelResponse> {
    this.requests.push(request)
    return {
      status: 'completed',
      finishReason: 'length',
      content: '未完成正文',
      promptTokens: 10,
      completionTokens: 5,
      reasoningLength: 0,
      durationMs: 5
    }
  }
}

async function main(): Promise<void> {
  const db = new Database(':memory:')
  try {
    const gateway = new RepairingFakeGateway()
    const runner = new AutomatedChapterRunner(db, gateway)
    runner.pipeline.createNovel({ id: 300, title: '自动运行测试' })
    const intent = runner.pipeline.registerIntent({
      id: 'intent-300-1',
      workId: 300,
      chapterOrdinal: 1,
      baseStateRevision: 0,
      objective: '主角继承徽章并凭动机进入避难所',
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
    runner.start({
      runId: 'run-300-1',
      novelId: 300,
      intentId: intent.id,
      modelContract: {
        provider: 'fake-provider',
        providerProtocol: 'openai',
        apiBase: 'http://127.0.0.1/fake/v1',
        model: 'fixed-novel-model',
        protocolVersion: 1
      },
      maxRepairs: 2,
      maxStepAttempts: 2,
      editorialPolicyVersion: 1
    })

    const completedRun = await runner.runToTerminal('run-300-1', 'test-runner')
    assert.equal(completedRun.status, 'completed')
    assert.equal(completedRun.currentPhase, 'completed')
    assert.equal(completedRun.repairCount, 1, '首个候选文学门失败后必须只修订一次')
    assert.equal(runner.pipeline.loadState(300).revision, 1)
    assert.equal(runner.workflows.countModelCalls('run-300-1'), 11)
    assert.equal(runner.workflows.countModelCalls('run-300-1', 'chapter_revision'), 1)
    assert.equal(
      new Set(gateway.requests.map(request => (
        `${request.contract.provider}:${request.contract.model}:${request.contract.contractHash}`
      ))).size,
      1,
      '整个运行必须固定同一模型契约，不能 fallback'
    )

    const firstRequest = gateway.requests[0]
    db.prepare(`
      UPDATE narrative_model_calls SET content = '被篡改的模型响应'
      WHERE request_id = ?
    `).run(firstRequest.requestId)
    expectCode('PIPELINE_ARTIFACT_HASH_MISMATCH', () => (
      runner.workflows.loadCompletedModelCall(
        firstRequest.requestId,
        firstRequest.task,
        completedRun.modelContract
      )
    ))
    db.prepare(`
      UPDATE narrative_model_calls SET content = ?
      WHERE request_id = ?
    `).run(initialContent, firstRequest.requestId)

    const callsBeforeResume = gateway.requests.length
    const resumedCompleted = await runner.runToTerminal('run-300-1', 'test-runner')
    assert.equal(resumedCompleted.status, 'completed')
    assert.equal(gateway.requests.length, callsBeforeResume, '重复恢复已完成运行不得再次调用模型')

    const chapter2Intent = runner.pipeline.registerIntent({
      id: 'intent-300-2',
      workId: 300,
      chapterOrdinal: 2,
      baseStateRevision: 1,
      objective: '验证取消语义',
      requiredEvents: [{ eventType: 'ArtifactUsed', entityId: 'artifact-badge', minCount: 1 }],
      forbiddenEvents: [],
      allowedEntityIds: ['actor-chenliang', 'artifact-badge'],
      creatableEntityIds: [],
      targetWordRange: { min: 1, max: 100 }
    })
    runner.start({
      runId: 'run-300-cancelled',
      novelId: 300,
      intentId: chapter2Intent.id,
      modelContract: {
        provider: 'fake-provider',
        providerProtocol: 'openai',
        apiBase: 'http://127.0.0.1/fake/v1',
        model: 'fixed-novel-model',
        protocolVersion: 1
      },
      maxRepairs: 1,
      maxStepAttempts: 2,
      editorialPolicyVersion: 1
    })
    runner.workflows.requestCancellation('run-300-cancelled')
    const cancelled = await runner.runToTerminal('run-300-cancelled', 'test-runner')
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(runner.workflows.countModelCalls('run-300-cancelled'), 0)

    const truncatedGateway = new TruncatedGateway()
    const blockedRunner = new AutomatedChapterRunner(db, truncatedGateway)
    blockedRunner.pipeline.createNovel({ id: 301, title: '协议耗尽测试' })
    const blockedIntent = blockedRunner.pipeline.registerIntent({
      id: 'intent-301-1',
      workId: 301,
      chapterOrdinal: 1,
      baseStateRevision: 0,
      objective: '验证固定协议有界失败',
      requiredEvents: [{ eventType: 'ActorIntroduced', minCount: 1 }],
      forbiddenEvents: [],
      allowedEntityIds: [],
      creatableEntityIds: ['actor-test'],
      targetWordRange: { min: 1, max: 100 }
    })
    blockedRunner.start({
      runId: 'run-301-blocked',
      novelId: 301,
      intentId: blockedIntent.id,
      modelContract: {
        provider: 'single-provider',
        providerProtocol: 'openai',
        apiBase: 'http://127.0.0.1/fake/v1',
        model: 'single-model',
        protocolVersion: 1
      },
      maxRepairs: 1,
      maxStepAttempts: 2,
      editorialPolicyVersion: 1
    })
    const blocked = await blockedRunner.runToTerminal('run-301-blocked', 'blocked-runner')
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.errorCode, 'MODEL_PROTOCOL_EXHAUSTED')
    assert.equal(truncatedGateway.requests.length, 2)
    assert.equal(blockedRunner.pipeline.loadState(301).revision, 0)

    assert.deepEqual(runner.pipeline.integrityCheck(), [])
    console.log('automated-chapter-runner-v2 tests passed')
  } finally {
    db.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
