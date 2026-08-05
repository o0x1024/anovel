import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NarrativeApplication,
  type NarrativeApplicationConfig
} from '../src/main/narrative-app'
import { runNarrativeCli } from '../src/main/narrative-app/cli'

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function taskFrom(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role?: string; content?: string }> | undefined
  const content = messages?.find(message => message.role === 'system')?.content ?? ''
  return content.match(/^ANOVEL_TASK=(.+)$/m)?.[1] ?? ''
}

function reply(response: ServerResponse, content: string): void {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 120, completion_tokens: 80 }
  }))
}

async function main(): Promise<void> {
  const calls: string[] = []
  const server = createServer(async (request, response) => {
    const body = await readJson(request)
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer v2-test-secret')
    assert.equal(body.model, 'v2-test-model')
    const task = taskFrom(body)
    calls.push(task)
    if (task === 'chapter_body') {
      reply(response, '陈凉在废墟里找到一枚旧徽章，郑重地收进衣袋。')
      return
    }
    if (task === 'narrative_patch') {
      reply(response, JSON.stringify({
        id: 'run-901:patch:0',
        intentId: 'intent-901-1',
        candidateId: 'run-901:candidate:0',
        baseStateRevision: 0,
        events: [
          {
            id: 'event-chen',
            type: 'ActorIntroduced',
            chapterOrdinal: 1,
            actorId: 'actor-chen',
            canonicalName: '陈凉',
            aliases: [],
            evidenceQuote: '陈凉'
          },
          {
            id: 'event-badge',
            type: 'ArtifactIntroduced',
            chapterOrdinal: 1,
            artifactId: 'artifact-badge',
            canonicalName: '旧徽章',
            aliases: ['徽章'],
            provenance: { kind: 'found', sourceEntityId: 'actor-chen' },
            holder: { kind: 'actor', actorId: 'actor-chen' },
            quantity: 1,
            evidenceQuote: '找到一枚旧徽章'
          }
        ]
      }))
      return
    }
    if (task === 'editorial_gate') {
      reply(response, JSON.stringify({
        status: 'passed',
        score: 91,
        report: '本章目标、动机与叙述均满足当前文学门。',
        evidenceQuotes: ['郑重地收进衣袋']
      }))
      return
    }
    response.writeHead(400)
    response.end(JSON.stringify({ error: { message: `unsupported:${task}` } }))
  })
  const tempRoot = mkdtempSync(join(tmpdir(), 'anovel-v2-app-'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const configPath = join(tempRoot, 'v2-config.json')
    const intentPath = join(tempRoot, 'intent.json')
    const exportPath = join(tempRoot, 'publication.md')
    const config: NarrativeApplicationConfig = {
      databasePath: 'v2.sqlite',
      model: {
        provider: 'test-openai',
        providerProtocol: 'openai',
        apiBase: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'v2-test-secret',
        model: 'v2-test-model',
        timeoutMs: 5000
      },
      automation: {
        maxRepairs: 1,
        maxStepAttempts: 2,
        editorialPolicyVersion: 1
      }
    }
    writeFileSync(configPath, JSON.stringify(config), 'utf8')
    writeFileSync(intentPath, JSON.stringify({
      id: 'intent-901-1',
      workId: 901,
      chapterOrdinal: 1,
      baseStateRevision: 0,
      objective: '陈凉在废墟中获得旧徽章',
      requiredEvents: [{
        eventType: 'ArtifactIntroduced',
        entityId: 'artifact-badge',
        minCount: 1
      }],
      forbiddenEvents: [],
      allowedEntityIds: [],
      creatableEntityIds: ['actor-chen', 'artifact-badge'],
      targetWordRange: { min: 1, max: 100 }
    }), 'utf8')

    await runNarrativeCli(['init', '--config', configPath, '--novel-id', '901', '--title', '端到端测试'])
    await runNarrativeCli(['intent', '--config', configPath, '--file', intentPath])
    await runNarrativeCli([
      'run', '--config', configPath, '--run-id', 'run-901', '--novel-id', '901', '--intent-id', 'intent-901-1'
    ])
    await runNarrativeCli(['status', '--config', configPath, '--run-id', 'run-901'])
    await runNarrativeCli(['export', '--config', configPath, '--novel-id', '901', '--output', exportPath])

    const app = NarrativeApplication.open({ ...config, databasePath: join(tempRoot, 'v2.sqlite') })
    try {
      assert.equal(app.chapterStatus('run-901').status, 'completed')
      const publication = app.publication(901)
      assert.equal(publication.chapters.length, 1)
      assert.equal(publication.chapters[0].ordinal, 1)
      assert.equal(publication.stateRevision, 1)
      assert.equal(app.runner.workflows.listRuns(901).length, 1)
      const generatedNovelId = app.createNovelWithGeneratedId('UI 创建小说测试')
      assert.equal(generatedNovelId, 902)
      assert.equal(app.listNovels().length, 2)
      assert.match(readFileSync(exportPath, 'utf8'), /陈凉在废墟里找到一枚旧徽章/)
    } finally {
      app.close()
    }
    assert.deepEqual(calls, [
      'chapter_body',
      'narrative_patch',
      'editorial_gate',
      'editorial_gate',
      'editorial_gate',
      'editorial_gate',
      'editorial_gate',
      'editorial_gate'
    ])
    console.log('narrative application v2 tests passed')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
