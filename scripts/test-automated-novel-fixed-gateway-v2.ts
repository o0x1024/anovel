import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import Database from 'better-sqlite3'
import {
  AutomatedNovelRunner,
  FixedOpenAICompatibleNarrativeModelGateway,
  NARRATIVE_PROMPT_PROTOCOL_VERSION,
  createFrozenNarrativeModelContract,
  fixedProviderConfigFromModelRow
} from '../src/main/narrative-kernel'

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(Buffer.from(chunk)))
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) } catch (error) { reject(error) }
    })
    request.on('error', reject)
  })
}

function taskAndInput(body: Record<string, unknown>): { task: string; input: Record<string, unknown> } {
  const messages = body.messages as Array<{ role?: string; content?: string }>
  const system = messages.find(message => message.role === 'system')?.content ?? ''
  const prompt = messages.find(message => message.role === 'user')?.content ?? ''
  const inputText = prompt.slice(prompt.indexOf('输入合同：') + '输入合同：'.length).trim()
  return { task: system.match(/^ANOVEL_TASK=(.+)$/m)?.[1] ?? '', input: JSON.parse(inputText) as Record<string, unknown> }
}

function reply(response: ServerResponse, content: string): void {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 100 }
  }))
}

async function main(): Promise<void> {
  const calls: string[] = []
  const server = createServer(async (request, response) => {
    const body = await readJson(request)
    assert.equal(request.url, '/v1/chat/completions')
    assert.equal(request.headers.authorization, 'Bearer auto-secret')
    const { task, input } = taskAndInput(body)
    calls.push(task)
    if (task === 'novel_blueprint') {
      reply(response, JSON.stringify({
        title: '固定网关自动全书', premise: '陈凉在废墟中找到徽章。', storyArc: '获得徽章。',
        chapterStrategy: '先建立主角与徽章，再逐步扩大冲突并在结尾收束。'
      }))
      return
    }
    if (task === 'chapter_intent') {
      reply(response, JSON.stringify({
        objective: '陈凉在废墟中找到旧徽章并收好它。',
        requiredEvents: [{ eventType: 'ArtifactIntroduced', entityId: 'artifact-badge', minCount: 1 }],
        forbiddenEvents: [], allowedEntityIds: [], creatableEntityIds: ['actor-chen', 'artifact-badge']
      }))
      return
    }
    if (task === 'chapter_body') {
      reply(response, '陈凉在废墟中找到旧徽章，郑重地收进衣袋。')
      return
    }
    if (task === 'narrative_patch') {
      const candidate = input.candidate as { id: string; intentId: string }
      reply(response, JSON.stringify({
        id: input.expectedPatchId, intentId: candidate.intentId, candidateId: candidate.id, baseStateRevision: 0,
        events: [
          { id: 'event-chen', type: 'ActorIntroduced', chapterOrdinal: 1, actorId: 'actor-chen', canonicalName: '陈凉', aliases: [], evidenceQuote: '陈凉' },
          { id: 'event-badge', type: 'ArtifactIntroduced', chapterOrdinal: 1, artifactId: 'artifact-badge', canonicalName: '旧徽章', aliases: ['徽章'], provenance: { kind: 'found', sourceEntityId: 'actor-chen' }, holder: { kind: 'actor', actorId: 'actor-chen' }, quantity: 1, evidenceQuote: '找到旧徽章' }
        ]
      }))
      return
    }
    if (task === 'editorial_gate') {
      reply(response, JSON.stringify({ status: 'passed', score: 90, report: '文学门通过。', evidenceQuotes: ['郑重地收进衣袋'] }))
      return
    }
    response.writeHead(400)
    response.end(JSON.stringify({ error: { message: `unsupported:${task}` } }))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const db = new Database(':memory:')
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const config = fixedProviderConfigFromModelRow({
      model_type: 'local', model_name: 'auto-fixed-model', api_key: 'auto-secret',
      api_base: `http://127.0.0.1:${address.port}/v1`, is_enabled: 1, provider_protocol: 'openai'
    }, 5000)
    const runner = new AutomatedNovelRunner(db, new FixedOpenAICompatibleNarrativeModelGateway(config))
    runner.pipeline.createNovel({ id: 880, title: '固定网关自动全书' })
    const run = runner.start({
      runId: 'auto-fixed-880', novelId: 880, premise: '陈凉在废墟中找到徽章。', targetChapters: 1,
      wordRange: { min: 1, max: 100 },
      modelContract: createFrozenNarrativeModelContract({
        provider: config.provider, providerProtocol: config.providerProtocol, apiBase: config.apiBase,
        model: config.model, protocolVersion: NARRATIVE_PROMPT_PROTOCOL_VERSION
      })
    })
    assert.equal((await runner.runToTerminal(run.id)).status, 'completed')
    assert.equal(runner.pipeline.listCommittedChapters(880).length, 1)
    assert.deepEqual(calls, [
      'novel_blueprint', 'chapter_intent', 'chapter_body', 'narrative_patch',
      'editorial_gate', 'editorial_gate', 'editorial_gate', 'editorial_gate', 'editorial_gate', 'editorial_gate'
    ])
    console.log('automated novel fixed gateway v2 tests passed')
  } finally {
    db.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
