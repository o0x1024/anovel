import axios from 'axios'
import { appLogger } from '../logger/app-logger'

interface SegmentPPLResult {
  id: number
  ppl: number
  tokenCount: number
  top5Rate: number
  avgProb: number
}

export interface TokenMetric {
  charOffset: number
  charLen: number
  logProb: number
  prob: number
  inTop5: boolean
}

interface SegmentMetricLike {
  ppl: number
  tokenCount: number
  top5Rate: number
  avgProb: number
}

/** 云端复述 API 常返回全零 logprobs，无法用于困惑度评分 */
export function isDegenerateApiLogprobs(results: SegmentMetricLike[]): boolean {
  const valid = results.filter(r => r.tokenCount >= 2 && r.ppl > 0)
  if (valid.length < 2) return false

  const nearPerfect = valid.filter(r =>
    r.ppl >= 0.99 && r.ppl <= 1.01 &&
    r.top5Rate >= 0.99 &&
    r.avgProb >= 0.99
  )
  return nearPerfect.length / valid.length >= 0.8
}

/**
 * 规范化 API 地址：确保以 /v1 结尾
 */
function normalizeApiBase(apiBase: string): string {
  let base = apiBase.replace(/\/+$/, '')
  if (!base.endsWith('/v1')) {
    base += '/v1'
  }
  return base
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  return headers
}

/**
 * 通过 OpenAI 兼容 API 获取 logprobs 并计算困惑度指标
 * 路由策略：
 *  - 本地 API（localhost/127.0.0.1）→ 先 /completions+echo，失败后 /responses（MLX）
 *  - 云端 API（其他地址 + 有 apiKey）→ chat/completions 复述方式
 */
export async function computeViaApi(
  segments: Array<{ id: number; text: string }>,
  apiBase: string,
  modelName: string,
  onProgress?: (msg: string) => void,
  apiKey?: string
): Promise<SegmentPPLResult[]> {
  const results: SegmentPPLResult[] = []
  const base = normalizeApiBase(apiBase)
  const headers = buildHeaders(apiKey)

  // 判断是否为本地服务
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\./i.test(apiBase)

  // 确定使用哪种模式
  let mode: 'completions' | 'responses' | 'chat' = 'completions'

  if (isLocal) {
    // 本地服务：先探测 /completions 是否可用
    try {
      await axios.post(`${base}/completions`, {
        prompt: '测试', max_tokens: 0, echo: true, logprobs: 1
      }, { timeout: 10000, headers })
    } catch (err: any) {
      const status = err?.response?.status
      if (status === 404 || status === 400) {
        mode = 'responses'
        appLogger.info('perplexity-api', '本地 API 不支持 /completions，切换到 /responses 模式 (MLX)')
      }
    }
  } else if (apiKey) {
    // 云端 API：使用 chat/completions 复述方式
    mode = 'chat'
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (i % 5 === 0) {
      onProgress?.(`正在通过 API 分析段落 ${i + 1}/${segments.length}…`)
    }

    try {
      let result: { ppl: number; tokenCount: number; top5Rate: number; avgProb: number }
      if (mode === 'chat') {
        result = await computeSegmentViaChatApi(base, modelName, seg.text, headers)
      } else if (mode === 'responses') {
        result = await computeSegmentViaResponses(base, modelName, seg.text, headers)
      } else {
        result = await computeSegmentLogprobs(base, modelName, seg.text, headers)
      }
      results.push({ id: seg.id, ...result })
    } catch (err) {
      appLogger.error('perplexity-api', `段落 ${seg.id} API 调用失败: ${err instanceof Error ? err.message : err}`)
      results.push({ id: seg.id, ppl: 0, tokenCount: 0, top5Rate: 0, avgProb: 0 })
    }
  }

  return results
}

/**
 * 整文连续计算（API 模式）：将全文作为一个序列发送，返回 token 级别指标
 * 仅适用于支持 /completions + echo 的本地 API（LM Studio / llama.cpp）
 */
export async function computeWholeViaApi(
  text: string,
  apiBase: string,
  modelName: string,
  onProgress?: (msg: string) => void,
  apiKey?: string
): Promise<TokenMetric[]> {
  const base = normalizeApiBase(apiBase)
  const headers = buildHeaders(apiKey)
  return computeWholeCompletionsApi(base, modelName, text, headers, onProgress)
}

/**
 * 整文连续计算 via /completions (echo 模式)
 * 一次性发送全文，获取所有 token 的 logprobs 和 text_offset
 */
async function computeWholeCompletionsApi(
  apiBase: string,
  model: string,
  text: string,
  headers: Record<string, string>,
  onProgress?: (msg: string) => void
): Promise<TokenMetric[]> {
  onProgress?.('正在通过 API 整文分析…')

  const body: Record<string, unknown> = {
    prompt: text,
    max_tokens: 0,
    echo: true,
    logprobs: 5,
    temperature: 0
  }
  if (model) body.model = model

  const response = await axios.post(`${apiBase}/completions`, body, {
    timeout: 120000,
    headers
  })

  const choice = response.data?.choices?.[0]
  if (!choice?.logprobs) {
    throw new Error('API 响应中无 logprobs 数据')
  }

  const tokenLogprobs: (number | null)[] = choice.logprobs.token_logprobs ?? []
  const topLogprobs: Array<Record<string, number> | null> = choice.logprobs.top_logprobs ?? []
  const tokens: string[] = choice.logprobs.tokens ?? []
  const textOffsets: number[] = choice.logprobs.text_offset ?? []

  const metrics: TokenMetric[] = []
  for (let i = 1; i < tokens.length; i++) {
    const lp = tokenLogprobs[i]
    if (lp === null || lp === undefined) continue

    const prob = Math.exp(lp)
    let inTop5 = true
    const topMap = topLogprobs[i]
    if (topMap) {
      inTop5 = tokens[i] in topMap
    }

    const charOffset = textOffsets[i] ?? 0
    const charLen = tokens[i].length

    metrics.push({ charOffset, charLen, logProb: lp, prob, inTop5 })
  }

  onProgress?.(`API 整文分析完成，共 ${metrics.length} tokens`)
  return metrics
}

/**
 * 通过 /completions (echo模式) 获取 logprobs — 适用于 LM Studio / llama.cpp
 */
async function computeSegmentLogprobs(
  apiBase: string,
  model: string,
  text: string,
  headers: Record<string, string>
): Promise<{ ppl: number; tokenCount: number; top5Rate: number; avgProb: number }> {
  const body: Record<string, unknown> = {
    prompt: text,
    max_tokens: 0,
    echo: true,
    logprobs: 5,
    temperature: 0
  }
  if (model) body.model = model

  const response = await axios.post(`${apiBase}/completions`, body, {
    timeout: 60000,
    headers
  })

  const choice = response.data?.choices?.[0]
  if (!choice?.logprobs) {
    throw new Error('API 响应中无 logprobs 数据')
  }

  const tokenLogprobs: number[] = choice.logprobs.token_logprobs ?? []
  const topLogprobs: Array<Record<string, number> | null> = choice.logprobs.top_logprobs ?? []
  const tokens: string[] = choice.logprobs.tokens ?? []

  const validLogprobs = tokenLogprobs.slice(1).filter(lp => lp !== null && lp !== undefined) as number[]
  const validTopLogprobs = topLogprobs.slice(1).filter(t => t !== null) as Array<Record<string, number>>

  if (validLogprobs.length === 0) {
    return { ppl: 0, tokenCount: tokens.length, top5Rate: 0, avgProb: 0 }
  }

  const avgLogProb = validLogprobs.reduce((a, b) => a + b, 0) / validLogprobs.length
  const ppl = Math.exp(-avgLogProb)
  const avgProb = validLogprobs.reduce((a, lp) => a + Math.exp(lp), 0) / validLogprobs.length

  let top5Hits = 0
  for (let i = 0; i < validLogprobs.length; i++) {
    const topMap = validTopLogprobs[i]
    if (!topMap) { top5Hits++; continue }
    const actualToken = tokens[i + 1]
    if (actualToken && actualToken in topMap) {
      top5Hits++
    }
  }
  const top5Rate = validLogprobs.length > 0 ? top5Hits / validLogprobs.length : 0

  return { ppl, tokenCount: tokens.length, top5Rate, avgProb }
}

/**
 * 通过 /chat/completions (logprobs模式) 获取 logprobs — 适用于 DeepSeek / OpenAI 等云端 API
 * 策略：让模型复述文本，获取输出 token 的 logprobs 作为困惑度近似
 * 云端 chat API 不支持 prefix 模式，无法直接获取输入 token 概率
 */
async function computeSegmentViaChatApi(
  apiBase: string,
  model: string,
  text: string,
  headers: Record<string, string>
): Promise<{ ppl: number; tokenCount: number; top5Rate: number; avgProb: number }> {
  return await computeSegmentChatRepeat(apiBase, model, text, headers)
}

/**
 * 通过 LM Studio /v1/responses 端点获取 logprobs — 适用于 MLX 模型
 * 使用 include: ["message.output_text.logprobs"] 获取输出 token 的 logprobs
 */
async function computeSegmentViaResponses(
  apiBase: string,
  model: string,
  text: string,
  headers: Record<string, string>
): Promise<{ ppl: number; tokenCount: number; top5Rate: number; avgProb: number }> {
  const sampleText = text.slice(0, 300)

  // /v1/responses 端点（注意是 /v1/responses 不是 /api/v1）
  const responsesUrl = apiBase.replace(/\/v1$/, '/v1/responses')

  const body: Record<string, unknown> = {
    input: [
      { role: 'system', content: '逐字复述以下文本，不要修改任何内容，不要添加解释：' },
      { role: 'user', content: sampleText }
    ],
    include: ['message.output_text.logprobs'],
    top_logprobs: 5,
    max_output_tokens: Math.min(500, Math.max(100, sampleText.length)),
    temperature: 0,
    reasoning: { effort: 'none' }
  }
  if (model) body.model = model

  const response = await axios.post(responsesUrl, body, {
    timeout: 60000,
    headers
  })

  // /v1/responses 格式：output[].content[].logprobs[]
  const output = response.data?.output
  if (!output || !Array.isArray(output)) {
    return { ppl: 0, tokenCount: 0, top5Rate: 0, avgProb: 0 }
  }

  const allLogprobs: number[] = []
  let top5Hits = 0

  for (const item of output) {
    if (item.type !== 'message') continue
    const content = item.content
    if (!Array.isArray(content)) continue

    for (const part of content) {
      if (part.type !== 'output_text' || !part.logprobs) continue
      for (const lp of part.logprobs) {
        if (lp.logprob !== null && lp.logprob !== undefined) {
          allLogprobs.push(lp.logprob)
          if (lp.top_logprobs && Array.isArray(lp.top_logprobs)) {
            const topTokens = lp.top_logprobs.map((t: { token: string }) => t.token)
            if (topTokens.includes(lp.token)) {
              top5Hits++
            }
          } else {
            top5Hits++
          }
        }
      }
    }
  }

  if (allLogprobs.length === 0) {
    return { ppl: 0, tokenCount: 0, top5Rate: 0, avgProb: 0 }
  }

  const avgLogProb = allLogprobs.reduce((a, b) => a + b, 0) / allLogprobs.length
  const ppl = Math.exp(-avgLogProb)
  const avgProb = allLogprobs.reduce((a, lp) => a + Math.exp(lp), 0) / allLogprobs.length
  const top5Rate = allLogprobs.length > 0 ? top5Hits / allLogprobs.length : 0

  return { ppl, tokenCount: allLogprobs.length, top5Rate, avgProb }
}

/**
 * 让模型复述文本片段，获取输出 token 的 logprobs
 * 原理：模型在复述已知文本时，其输出 logprobs 反映了模型对该文本的"熟悉度"
 * AI 生成的文本被复述时，logprobs 更高（更可预测）
 */
async function computeSegmentChatRepeat(
  apiBase: string,
  model: string,
  text: string,
  headers: Record<string, string>
): Promise<{ ppl: number; tokenCount: number; top5Rate: number; avgProb: number }> {
  const sampleText = text.slice(0, 300)
  const body: Record<string, unknown> = {
    messages: [
      { role: 'system', content: '逐字复述以下文本，不要修改任何内容，不要添加解释：' },
      { role: 'user', content: sampleText }
    ],
    max_tokens: Math.min(400, Math.max(50, sampleText.length)),
    logprobs: true,
    top_logprobs: 5,
    temperature: 0,
    thinking: { type: 'disabled' }
  }
  if (model) body.model = model

  const response = await axios.post(`${apiBase}/chat/completions`, body, {
    timeout: 60000,
    headers
  })

  const choice = response.data?.choices?.[0]
  const logprobsData = choice?.logprobs?.content
  if (!logprobsData || !Array.isArray(logprobsData) || logprobsData.length === 0) {
    return { ppl: 0, tokenCount: 0, top5Rate: 0, avgProb: 0 }
  }

  const validLogprobs = logprobsData
    .filter((item: { logprob: number }) => item.logprob !== null)
    .map((item: { logprob: number }) => item.logprob)

  if (validLogprobs.length === 0) {
    return { ppl: 0, tokenCount: 0, top5Rate: 0, avgProb: 0 }
  }

  const avgLogProb = validLogprobs.reduce((a: number, b: number) => a + b, 0) / validLogprobs.length
  const ppl = Math.exp(-avgLogProb)
  const avgProb = validLogprobs.reduce((a: number, lp: number) => a + Math.exp(lp), 0) / validLogprobs.length

  let top5Hits = 0
  for (const item of logprobsData) {
    if (item.top_logprobs && Array.isArray(item.top_logprobs)) {
      const topTokens = item.top_logprobs.map((t: { token: string }) => t.token)
      if (topTokens.includes(item.token)) {
        top5Hits++
      }
    } else {
      top5Hits++
    }
  }
  const top5Rate = logprobsData.length > 0 ? top5Hits / logprobsData.length : 0

  return { ppl, tokenCount: logprobsData.length, top5Rate, avgProb }
}

/**
 * 测试 API 连接是否正常
 */
export async function testApiConnection(apiBase: string, modelName: string, apiKey?: string): Promise<{ success: boolean; message: string }> {
  const base = normalizeApiBase(apiBase)
  const headers = buildHeaders(apiKey)
  appLogger.info('perplexity-api', `测试连接: ${base}, 模型: ${modelName || '(默认)'}, 有Key: ${!!apiKey}`)

  // 有 apiKey 时优先尝试 chat/completions
  if (apiKey) {
    try {
      const body: Record<string, unknown> = {
        messages: [{ role: 'user', content: '你好' }],
        max_tokens: 10,
        logprobs: true,
        top_logprobs: 5,
        temperature: 0,
        thinking: { type: 'disabled' }
      }
      if (modelName) body.model = modelName

      const response = await axios.post(`${base}/chat/completions`, body, {
        timeout: 30000,
        headers
      })

      const choice = response.data?.choices?.[0]
      if (!choice?.logprobs?.content) {
        return { success: false, message: '该 API 未返回 logprobs。请确认模型支持 logprobs 参数（DeepSeek V4 支持）' }
      }
      const modelUsed = response.data?.model || modelName || '默认'
      return { success: true, message: `连接成功 ✓ 模型: ${modelUsed}，logprobs 正常` }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('401') || msg.includes('Unauthorized')) {
        return { success: false, message: 'API Key 无效或已过期' }
      }
      if (msg.includes('402') || msg.includes('Payment')) {
        return { success: false, message: 'API 余额不足' }
      }
      if (msg.includes('ECONNREFUSED')) {
        return { success: false, message: '连接被拒绝，请确认 API 地址正确' }
      }
      if (msg.includes('timeout')) {
        return { success: false, message: '连接超时，请检查网络' }
      }
      return { success: false, message: `连接失败: ${msg}` }
    }
  }

  // 无 apiKey 时使用 /completions（本地服务），失败则尝试 /responses（MLX）
  try {
    const body: Record<string, unknown> = {
      prompt: '你好',
      max_tokens: 0,
      echo: true,
      logprobs: 5,
      temperature: 0
    }
    if (modelName) body.model = modelName

    const response = await axios.post(`${base}/completions`, body, {
      timeout: 15000,
      headers
    })

    const choice = response.data?.choices?.[0]
    if (!choice?.logprobs) {
      const hasText = choice?.text?.length > 0
      if (hasText) {
        return { success: false, message: '该服务未返回 logprobs（当前仅 LM Studio 和 llama.cpp server 支持）' }
      }
      return { success: false, message: '未返回 logprobs。请确认：1) 加载的是文本生成模型 2) 服务支持 logprobs 参数' }
    }

    const tokenCount = choice.logprobs.tokens?.length ?? 0
    const modelUsed = response.data?.model || modelName || '默认'
    return { success: true, message: `连接成功 ✓ 模型: ${modelUsed}，测试 tokens: ${tokenCount}，模式: completions` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const status = (err as any)?.response?.status

    // /completions 不支持（可能是 MLX 模型），尝试 /responses 端点
    if (status === 404 || status === 400) {
      return await testResponsesEndpoint(base, modelName, headers)
    }

    if (msg.includes('ECONNREFUSED')) {
      return { success: false, message: '连接被拒绝，请确认服务已启动' }
    }
    if (msg.includes('timeout')) {
      return { success: false, message: '连接超时' }
    }
    return { success: false, message: `连接失败: ${msg}` }
  }
}

/**
 * 测试 /v1/responses 端点（LM Studio MLX 模型）
 */
async function testResponsesEndpoint(
  apiBase: string,
  modelName: string,
  headers: Record<string, string>
): Promise<{ success: boolean; message: string }> {
  const responsesUrl = apiBase.replace(/\/v1$/, '/v1/responses')

  try {
    const body: Record<string, unknown> = {
      input: [{ role: 'user', content: '你好' }],
      include: ['message.output_text.logprobs'],
      top_logprobs: 3,
      max_output_tokens: 100,
      temperature: 0,
      reasoning: { effort: 'none' }
    }
    if (modelName) body.model = modelName

    const response = await axios.post(responsesUrl, body, {
      timeout: 30000,
      headers
    })

    const output = response.data?.output
    if (!output || !Array.isArray(output)) {
      return { success: false, message: '/responses 端点未返回有效数据' }
    }

    let hasLogprobs = false
    for (const item of output) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part.logprobs && Array.isArray(part.logprobs) && part.logprobs.length > 0) {
            hasLogprobs = true
          }
        }
      }
    }

    if (!hasLogprobs) {
      // 检查是否只有 reasoning 输出（思考模型的问题）
      const hasReasoning = output.some((item: any) => item.type === 'reasoning')
      const hasMessage = output.some((item: any) => item.type === 'message')
      if (hasReasoning && !hasMessage) {
        return { success: false, message: '模型仅输出了思考内容，未生成实际回复。请在 LM Studio 中关闭 Thinking 模式，或使用非思考模型' }
      }
      return { success: false, message: '/responses 端点未返回 logprobs。请确认 LM Studio 版本 ≥ 0.3.39 且 include 参数生效' }
    }

    const modelUsed = response.data?.model || modelName || '默认'
    return { success: true, message: `连接成功 ✓ 模型: ${modelUsed}，模式: responses (MLX 兼容)` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, message: `/completions 和 /responses 均不可用: ${msg}` }
  }
}
