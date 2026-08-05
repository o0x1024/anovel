import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import {
  AutomatedNovelRunner,
  NarrativeKernelError,
  ensureNarrativeEventStoreSchema,
  sha256,
  type ChapterCandidate,
  type NarrativeModelGateway,
  type NarrativeModelRequest,
  type NarrativeModelResponse
} from '../src/main/narrative-kernel'

function completed(structuredOutput?: unknown, content?: string): NarrativeModelResponse {
  return {
    status: 'completed',
    finishReason: 'stop',
    ...(structuredOutput == null ? {} : { structuredOutput }),
    ...(content == null ? {} : { content }),
    promptTokens: 100,
    completionTokens: 100,
    reasoningLength: 0,
    durationMs: 1
  }
}

function evidence(candidate: ChapterCandidate, quote: string) {
  const startOffset = candidate.content.indexOf(quote)
  assert.notEqual(startOffset, -1)
  return {
    candidateId: candidate.id,
    startOffset,
    endOffset: startOffset + quote.length,
    quoteHash: sha256(quote)
  }
}

class AutoNovelGateway implements NarrativeModelGateway {
  readonly tasks: string[] = []

  async invoke(request: NarrativeModelRequest): Promise<NarrativeModelResponse> {
    this.tasks.push(request.task)
    switch (request.task) {
      case 'novel_blueprint':
        return completed({
          title: '自动全书测试',
          premise: '陈凉在废墟中获得徽章，并用它揭开避难所的真相。',
          storyArc: '获得徽章、进入避难所、揭开真相。',
          chapterStrategy: '前段建立徽章与动机，中段让徽章打开避难所秘密，后段揭示真相并完成选择。'
        })
      case 'chapter_intent': {
        const ordinal = request.input.chapterOrdinal as number
        return completed(ordinal === 1 ? {
          objective: '陈凉在废墟中找到旧徽章并收好它。',
          requiredEvents: [{ eventType: 'ArtifactIntroduced', entityId: 'artifact-badge', minCount: 1 }],
          forbiddenEvents: [],
          allowedEntityIds: [],
          creatableEntityIds: ['actor-chen', 'artifact-badge']
        } : {
          objective: '陈凉拿着旧徽章进入避难所。',
          requiredEvents: [{ eventType: 'ArtifactUsed', entityId: 'artifact-badge', minCount: 1 }],
          forbiddenEvents: [],
          allowedEntityIds: ['actor-chen', 'artifact-badge'],
          creatableEntityIds: ['location-shelter']
        })
      }
      case 'chapter_body': {
        const intent = request.input.intent as { chapterOrdinal: number }
        return completed(undefined, intent.chapterOrdinal === 1
          ? '陈凉在废墟中找到旧徽章，郑重地收进衣袋。'
          : '陈凉拿着旧徽章敲开避难所的大门，守卫放他进入。')
      }
      case 'narrative_patch': {
        const candidate = request.input.candidate as ChapterCandidate
        const patchId = request.input.expectedPatchId as string
        if (candidate.content.includes('废墟')) {
          return completed({
            id: patchId,
            intentId: candidate.intentId,
            candidateId: candidate.id,
            baseStateRevision: 0,
            events: [
              { id: 'event-chen', type: 'ActorIntroduced', chapterOrdinal: 1, actorId: 'actor-chen', canonicalName: '陈凉', aliases: [], evidence: evidence(candidate, '陈凉') },
              { id: 'event-badge', type: 'ArtifactIntroduced', chapterOrdinal: 1, artifactId: 'artifact-badge', canonicalName: '旧徽章', aliases: ['徽章'], provenance: { kind: 'found', sourceEntityId: 'actor-chen' }, holder: { kind: 'actor', actorId: 'actor-chen' }, quantity: 1, evidence: evidence(candidate, '找到旧徽章') }
            ]
          })
        }
        return completed({
          id: patchId,
          intentId: candidate.intentId,
          candidateId: candidate.id,
          baseStateRevision: 1,
          events: [
            { id: 'event-shelter', type: 'LocationIntroduced', chapterOrdinal: 2, locationId: 'location-shelter', canonicalName: '避难所', aliases: [], evidence: evidence(candidate, '避难所') },
            { id: 'event-badge-use', type: 'ArtifactUsed', chapterOrdinal: 2, artifactId: 'artifact-badge', actorId: 'actor-chen', action: '敲开避难所的大门', evidence: evidence(candidate, '旧徽章敲开避难所') }
          ]
        })
      }
      case 'editorial_gate': {
        const candidate = request.input.candidate as ChapterCandidate
        return completed({
          status: 'passed',
          score: 90,
          report: '文学门通过。',
          evidenceQuotes: [candidate.content.includes('废墟') ? '郑重地收进衣袋' : '守卫放他进入']
        })
      }
      case 'chapter_revision':
        throw new Error('本测试不应触发修订')
    }
  }
}

class IntentRepairGateway extends AutoNovelGateway {
  private returnedMalformedIntent = false

  override async invoke(request: NarrativeModelRequest): Promise<NarrativeModelResponse> {
    if (request.task === 'chapter_intent' && !this.returnedMalformedIntent) {
      this.returnedMalformedIntent = true
      this.tasks.push(request.task)
      return completed({
        objective: '陈凉在废墟中找到旧徽章并收好它。',
        requiredEvents: ['ArtifactIntroduced'],
        forbiddenEvents: [],
        allowedEntityIds: [],
        creatableEntityIds: ['actor-chen', 'artifact-badge']
      })
    }
    return super.invoke(request)
  }
}

async function main(): Promise<void> {
  const migrationDb = new Database(':memory:')
  try {
    migrationDb.exec(`
      CREATE TABLE narrative_kernel_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO narrative_kernel_meta (key, value) VALUES ('schema_version', '6');
      CREATE TABLE narrative_auto_novel_runs (
        id TEXT PRIMARY KEY,
        novel_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        desired_state TEXT NOT NULL,
        current_phase TEXT NOT NULL,
        target_chapters INTEGER NOT NULL,
        word_min INTEGER NOT NULL,
        word_max INTEGER NOT NULL,
        premise TEXT NOT NULL,
        blueprint_json TEXT,
        blueprint_hash TEXT,
        active_chapter_run_id TEXT,
        model_contract_json TEXT NOT NULL,
        model_contract_hash TEXT NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `)
    ensureNarrativeEventStoreSchema(migrationDb)
    ensureNarrativeEventStoreSchema(migrationDb)
    const columns = migrationDb.prepare('PRAGMA table_info(narrative_auto_novel_runs)').all() as Array<{ name: string }>
    assert.ok(columns.some(column => column.name === 'recovered_from_run_id'))
  } finally {
    migrationDb.close()
  }

  const db = new Database(':memory:')
  try {
    const gateway = new AutoNovelGateway()
    const runner = new AutomatedNovelRunner(db, gateway)
    runner.pipeline.createNovel({ id: 700, title: '自动全书测试' })
    const started = runner.start({
      runId: 'auto-700',
      novelId: 700,
      premise: '陈凉在废墟中获得徽章，并用它揭开避难所的真相。',
      targetChapters: 2,
      wordRange: { min: 1, max: 100 },
      modelContract: {
        provider: 'test-provider',
        providerProtocol: 'openai',
        apiBase: 'http://127.0.0.1/test',
        model: 'test-model',
        protocolVersion: 1
      }
    })
    assert.equal(started.currentPhase, 'plan_novel')
    assert.deepEqual(runner.progress(started.id), {
      run: started,
      committedChapterCount: 0
    })
    const finished = await runner.runToTerminal(started.id)
    assert.equal(finished.status, 'completed')
    assert.equal(finished.currentPhase, 'completed')
    assert.equal(runner.pipeline.loadState(700).revision, 2)
    assert.equal(runner.pipeline.listCommittedChapters(700).length, 2)
    assert.equal(runner.listRuns(700).length, 1)
    assert.equal(runner.progress(started.id).committedChapterCount, 2)
    assert.equal(runner.progress(started.id).currentChapter, undefined)
    assert.deepEqual(gateway.tasks, [
      'novel_blueprint', 'chapter_intent', 'chapter_body', 'narrative_patch',
      'editorial_gate', 'editorial_gate', 'editorial_gate', 'editorial_gate', 'editorial_gate', 'editorial_gate',
      'chapter_intent', 'chapter_body', 'narrative_patch',
      'editorial_gate', 'editorial_gate', 'editorial_gate', 'editorial_gate', 'editorial_gate', 'editorial_gate'
    ])

    runner.pipeline.createNovel({ id: 701, title: '取消测试' })
    const cancelled = runner.start({
      runId: 'auto-701',
      novelId: 701,
      premise: '这是一个用于验证取消的自动小说创意。',
      targetChapters: 1,
      wordRange: { min: 1, max: 100 },
      modelContract: {
        provider: 'test-provider', providerProtocol: 'openai', apiBase: 'http://127.0.0.1/test', model: 'test-model', protocolVersion: 1
      }
    })
    runner.requestCancellation(cancelled.id)
    assert.equal((await runner.runToTerminal(cancelled.id)).status, 'cancelled')
    assert.equal(runner.pipeline.listCommittedChapters(701).length, 0)

    const failingRunner = new AutomatedNovelRunner(db, {
      async invoke(): Promise<NarrativeModelResponse> {
        return {
          status: 'failed',
          promptTokens: 0,
          completionTokens: 0,
          reasoningLength: 0,
          durationMs: 1,
          errorCode: 'MODEL_CALL_FAILED',
          errorMessage: '模拟模型失败'
        }
      }
    })
    failingRunner.pipeline.createNovel({ id: 702, title: '恢复测试' })
    const blocked = await failingRunner.runToTerminal(failingRunner.start({
      runId: 'auto-702',
      novelId: 702,
      premise: '这是一个用于验证暂停恢复的自动小说创意。',
      targetChapters: 1,
      wordRange: { min: 1, max: 100 },
      modelContract: {
        provider: 'test-provider', providerProtocol: 'openai', apiBase: 'http://127.0.0.1/test', model: 'test-model', protocolVersion: 1
      }
    }).id)
    assert.equal(blocked.status, 'blocked')
    const recovered = failingRunner.recover({
      sourceRunId: blocked.id,
      runId: 'auto-702-recovery',
      modelContract: {
        provider: 'recovery-provider', providerProtocol: 'openai', apiBase: 'http://127.0.0.1/recovery', model: 'recovery-model', protocolVersion: 1
      }
    })
    assert.equal(recovered.status, 'running')
    assert.equal(recovered.currentPhase, 'plan_novel')
    assert.equal(recovered.recoveredFromRunId, blocked.id)
    assert.equal(recovered.modelContract.provider, 'recovery-provider')

    const repairDb = new Database(':memory:')
    try {
      const repairGateway = new IntentRepairGateway()
      const repairRunner = new AutomatedNovelRunner(repairDb, repairGateway)
      repairRunner.pipeline.createNovel({ id: 703, title: '契约修复测试' })
      const repaired = await repairRunner.runToTerminal(repairRunner.start({
        runId: 'auto-703',
        novelId: 703,
        premise: '陈凉在废墟中找到徽章，并由此揭开避难所的真相。',
        targetChapters: 1,
        wordRange: { min: 1, max: 100 },
        modelContract: {
          provider: 'test-provider', providerProtocol: 'openai', apiBase: 'http://127.0.0.1/test', model: 'test-model', protocolVersion: 1
        }
      }).id)
      assert.equal(repaired.status, 'completed')
      assert.equal(repairGateway.tasks.filter(task => task === 'chapter_intent').length, 2)
    } finally {
      repairDb.close()
    }
    console.log('automated novel runner v2 tests passed')
  } finally {
    db.close()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
