import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  createChapterCandidate,
  createChapterIntent,
  createFrozenNarrativeModelContract,
  FixedOpenAICompatibleNarrativeModelGateway,
  fixedProviderConfigFromModelRow,
  NARRATIVE_PROMPT_PROTOCOL_VERSION,
  sha256,
  type NarrativeModelRequest
} from '../src/main/narrative-kernel'

interface CapturedCall {
  authorization: string | undefined
  path: string | undefined
  body: Record<string, unknown>
}

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
  const system = messages?.find(message => message.role === 'system')?.content ?? ''
  return system.match(/^ANOVEL_TASK=(.+)$/m)?.[1] ?? ''
}

function userPrompt(body: Record<string, unknown>): string {
  const messages = body.messages as Array<{ role?: string; content?: string }> | undefined
  return messages?.find(message => message.role === 'user')?.content ?? ''
}

function reply(response: ServerResponse, content: string, reasoning = ''): void {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({
    choices: [{
      finish_reason: 'stop',
      message: { content, reasoning_content: reasoning }
    }],
    usage: { prompt_tokens: 31, completion_tokens: 17 }
  }))
}

async function main(): Promise<void> {
  const calls: CapturedCall[] = []
  const server = createServer(async (request, response) => {
    try {
      const body = await readJson(request)
      calls.push({
        authorization: request.headers.authorization,
        path: request.url,
        body
      })
      const task = taskFrom(body)
      if (task === 'chapter_body') {
        reply(response, '陈凉把旧徽章交给老周。', '先确认章节目标。')
        return
      }
      if (task === 'chapter_revision') {
        reply(response, '陈凉郑重地把旧徽章交给老周。')
        return
      }
      if (task === 'narrative_patch') {
        const fenced = userPrompt(body).includes('forceInvalid')
        const patch = JSON.stringify({
          id: 'patch-http',
          intentId: 'intent-http',
          candidateId: 'candidate-http',
          baseStateRevision: 0,
          events: [{
            id: 'event-transfer',
            type: 'ArtifactTransferred',
            chapterOrdinal: 1,
            artifactId: 'artifact-badge',
            from: { kind: 'actor', actorId: 'actor-chen' },
            to: { kind: 'actor', actorId: 'actor-lao' },
            evidenceQuote: '把旧徽章交给'
          }]
        })
        reply(response, fenced ? `\`\`\`json\n${patch}\n\`\`\`` : patch)
        return
      }
      if (task === 'editorial_gate') {
        reply(response, JSON.stringify({
          status: 'passed',
          score: 92,
          report: '因果动作清晰且证据充分',
          evidenceQuotes: ['把旧徽章交给']
        }))
        return
      }
      response.writeHead(400)
      response.end(JSON.stringify({ error: { message: 'unknown task' } }))
    } catch (error) {
      response.writeHead(500)
      response.end(JSON.stringify({ error: { message: String(error) } }))
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    const apiBase = `http://127.0.0.1:${address.port}/v1`
    const config = fixedProviderConfigFromModelRow({
      model_type: 'local-openai',
      model_name: 'fixed-test-model',
      api_key: 'test-secret',
      api_base: apiBase,
      is_enabled: 1,
      provider_protocol: 'openai'
    }, 5000)
    const gateway = new FixedOpenAICompatibleNarrativeModelGateway(config)
    const contract = createFrozenNarrativeModelContract({
      provider: config.provider,
      providerProtocol: config.providerProtocol,
      apiBase: config.apiBase,
      model: config.model,
      protocolVersion: NARRATIVE_PROMPT_PROTOCOL_VERSION
    })
    const intent = createChapterIntent({
      id: 'intent-http',
      workId: 901,
      chapterOrdinal: 1,
      baseStateRevision: 0,
      objective: '陈凉把旧徽章交给老周',
      requiredEvents: [{
        eventType: 'ArtifactTransferred',
        entityId: 'artifact-badge',
        minCount: 1
      }],
      forbiddenEvents: [],
      allowedEntityIds: ['actor-chen', 'actor-lao', 'artifact-badge'],
      creatableEntityIds: [],
      targetWordRange: { min: 1, max: 100 }
    })
    const candidate = createChapterCandidate(intent, {
      id: 'candidate-http',
      intentId: intent.id,
      content: '陈凉把旧徽章交给老周。',
      generation: { source: 'author' }
    })
    const request = (
      requestId: string,
      task: NarrativeModelRequest['task'],
      input: Record<string, unknown>
    ): NarrativeModelRequest => ({ requestId, task, contract, input })

    const body = await gateway.invoke(request('body-1', 'chapter_body', { intent }))
    assert.equal(body.status, 'completed')
    assert.equal(body.content, candidate.content)
    assert.equal(body.finishReason, 'stop')
    assert.equal(body.promptTokens, 31)
    assert.equal(body.completionTokens, 17)
    assert.equal(body.reasoningLength, '先确认章节目标。'.length)

    const revision = await gateway.invoke(request('revision-1', 'chapter_revision', {
      intent,
      candidate,
      repairReasons: ['动作缺乏郑重感']
    }))
    assert.equal(revision.status, 'completed')
    assert.match(revision.content ?? '', /郑重/)

    const patch = await gateway.invoke(request('patch-1', 'narrative_patch', {
      intent,
      candidate
    }))
    assert.equal(patch.status, 'completed')
    const patchOutput = patch.structuredOutput as {
      events: Array<{ evidence: {
        candidateId: string
        startOffset: number
        endOffset: number
        quoteHash: string
      } }>
    }
    const quote = '把旧徽章交给'
    const expectedStart = candidate.content.indexOf(quote)
    assert.deepEqual(patchOutput.events[0].evidence, {
      candidateId: candidate.id,
      startOffset: expectedStart,
      endOffset: expectedStart + quote.length,
      quoteHash: sha256(quote)
    })

    const editorial = await gateway.invoke(request('editorial-1', 'editorial_gate', {
      intent,
      candidate,
      gateType: 'causal_motivation'
    }))
    assert.equal(editorial.status, 'completed')
    assert.equal((editorial.structuredOutput as { status: string }).status, 'passed')

    const beforeMismatch = calls.length
    const mismatch = await gateway.invoke({
      ...request('body-mismatch', 'chapter_body', { intent }),
      contract: createFrozenNarrativeModelContract({
        provider: config.provider,
        providerProtocol: config.providerProtocol,
        apiBase: config.apiBase,
        model: 'different-model',
        protocolVersion: NARRATIVE_PROMPT_PROTOCOL_VERSION
      })
    })
    assert.equal(mismatch.status, 'failed')
    assert.equal(mismatch.errorCode, 'MODEL_CONTRACT_MISMATCH')
    assert.equal(calls.length, beforeMismatch)

    const invalid = await gateway.invoke(request('patch-invalid', 'narrative_patch', {
      intent,
      candidate,
      forceInvalid: true
    }))
    assert.equal(invalid.status, 'failed')
    assert.equal(invalid.errorCode, 'MODEL_STRUCTURED_OUTPUT_INVALID')

    assert.equal(calls.length, 5)
    for (const call of calls) {
      assert.equal(call.path, '/v1/chat/completions')
      assert.equal(call.authorization, 'Bearer test-secret')
      assert.equal(call.body.model, 'fixed-test-model')
      assert.equal(call.body.stream, false)
    }
    assert.equal(taskFrom(calls[0].body), 'chapter_body')
    assert.match(
      (calls[0].body.messages as Array<{ content: string }>)[0].content,
      new RegExp(`ANOVEL_PROMPT_PROTOCOL=${NARRATIVE_PROMPT_PROTOCOL_VERSION}`)
    )
    console.log('fixed model gateway v2 tests passed')
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
