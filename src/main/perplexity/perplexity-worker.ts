import { parentPort, workerData } from 'worker_threads'

interface WorkerRequest {
  type: 'init' | 'computeWindows' | 'dispose'
  modelPath?: string
  text?: string
}

interface MetricSummary {
  ppl: number
  tokenCount: number
  top5Rate: number
  avgProb: number
}

interface SegmentPPLResult extends MetricSummary {
  id: number
}

interface TokenMetric {
  charOffset: number
  charLen: number
  logProb: number
  prob: number
  inTop5: boolean
}

interface WorkerResponse {
  type: 'ready' | 'windowResult' | 'error' | 'progress'
  windows?: TokenWindowResult[]
  message?: string
  progress?: number
}

interface TokenWindowResult {
  startToken: number
  endToken: number
  start: number
  end: number
  metric: MetricSummary
  tokenMetrics: TokenMetric[]
}

let model: any = null
let context: any = null
let sequence: any = null
let llamaInstance: any = null

function post(msg: WorkerResponse) {
  parentPort?.postMessage(msg)
}

async function initModel(modelPath: string) {
  const { getLlama } = await import('node-llama-cpp')
  llamaInstance = await getLlama()
  model = await llamaInstance.loadModel({ modelPath })
  context = await model.createContext({ contextSize: 4096 })
  sequence = context.getSequence()
  post({ type: 'ready', message: '模型加载完成' })
}

/**
 * 整文连续计算：将全文作为一个序列送入模型，返回每个 token 的指标和字符偏移
 * 这样短段落也能获得基于完整上下文的可靠评分
 */
async function computeWholeText(text: string): Promise<TokenMetric[]> {
  if (!model || !context) {
    throw new Error('模型未初始化')
  }

  if (!text.trim()) return []

  let tokens = model.tokenize(text)
  if (tokens.length < 2) return []

  const maxLen = 3800
  if (tokens.length > maxLen) {
    tokens = tokens.slice(0, maxLen)
  }

  // 预先解码 token 文本和字符偏移
  const tokenTexts: string[] = []
  for (const t of tokens) {
    try {
      tokenTexts.push(model.detokenize([t]))
    } catch {
      tokenTexts.push('')
    }
  }
  const charOffsets: number[] = []
  let pos = 0
  for (let i = 0; i < tokenTexts.length; i++) {
    charOffsets.push(pos)
    pos += tokenTexts[i].length
  }

  post({ type: 'progress', progress: 5, message: '正在对全文进行困惑度推理…' })

  // node-llama-cpp 会把每个 token 的全词表概率展开为 JS Map；256 个 token
  // 在 0.8B 模型上实测也会突破 4GB V8 堆。小批量可显著降低峰值内存。
  const BATCH_SIZE = 32
  const metrics: TokenMetric[] = []
  const totalTokens = tokens.length - 1
  const totalBatches = Math.ceil(totalTokens / BATCH_SIZE)

  await sequence.clearHistory()

  for (let batch = 0; batch < totalBatches; batch++) {
    const start = batch * BATCH_SIZE
    const end = Math.min(start + BATCH_SIZE, totalTokens)

    const input: any[] = []
    for (let i = start; i < end; i++) {
      input.push([tokens[i], { generateNext: { probabilities: true } }])
    }
    // 如果这不是最后一批，追加下一个 token（无需概率）以维持序列连续性
    // 如果是最后一批，追加末尾 token 但不请求概率
    if (end < tokens.length) {
      // 最后一个token只入 KV cache，不请求概率（下一批或结束时不需要）
      if (batch === totalBatches - 1) {
        input.push(tokens[end])
      }
    }

    const outputItems = await sequence.controlledEvaluate(input)

    for (let j = 0; j < end - start; j++) {
      const globalIdx = start + j
      const output = outputItems[j]
      if (!output || !output.next || !output.next.probabilities) continue

      const nextToken = tokens[globalIdx + 1]
      if (nextToken === undefined) continue

      const probMap = output.next.probabilities
      const prob = probMap.get(nextToken) ?? 0

      if (prob > 0) {
        let rank = 0
        for (const [, p] of probMap) {
          if (p > prob) rank++
          else break
        }

        metrics.push({
          charOffset: charOffsets[globalIdx + 1],
          charLen: tokenTexts[globalIdx + 1].length,
          logProb: Math.log(prob),
          prob,
          inTop5: rank < 5
        })
      }
    }

    const progress = 5 + Math.round(((batch + 1) / totalBatches) * 90)
    post({ type: 'progress', progress, message: `正在计算困惑度… ${batch + 1}/${totalBatches}` })
  }

  post({ type: 'progress', progress: 98, message: '计算完成' })
  return metrics
}

/**
 * 逐个重叠 token 窗独立推理。每窗清空上下文，避免全文前缀长度和窗口位置
 * 改变统计口径；384/192 对应 50% 重叠，尾窗至少保留 128 tokens。
 */
async function computeTokenWindows(text: string): Promise<TokenWindowResult[]> {
  if (!model || !context || !sequence) throw new Error('模型未初始化')
  const tokens = model.tokenize(text)
  if (tokens.length < 2) return []

  const tokenTexts = tokens.map((token: any) => {
    try {
      return model.detokenize([token])
    } catch {
      return ''
    }
  })
  const charOffsets: number[] = []
  let charCursor = 0
  for (const tokenText of tokenTexts) {
    charOffsets.push(charCursor)
    charCursor += tokenText.length
  }

  const windowSize = 384
  const stride = 192
  const minimumTail = 128
  const starts: number[] = []
  for (let start = 0; start < tokens.length; start += stride) {
    const remaining = tokens.length - start
    if (starts.length > 0 && remaining < minimumTail) {
      const anchored = Math.max(0, tokens.length - windowSize)
      if (anchored !== starts[starts.length - 1]) starts.push(anchored)
      break
    }
    starts.push(start)
    if (start + windowSize >= tokens.length) break
  }

  const windows: TokenWindowResult[] = []
  for (let windowIndex = 0; windowIndex < starts.length; windowIndex++) {
    const startToken = starts[windowIndex]
    const endToken = Math.min(tokens.length, startToken + windowSize)
    const selected = tokens.slice(startToken, endToken)
    await sequence.clearHistory()

    let sumLogProb = 0
    let probabilitySum = 0
    let top5Matches = 0
    let tokenCount = 0
    const tokenMetrics: TokenMetric[] = []
    const batchSize = 32
    for (let batchStart = 0; batchStart < selected.length - 1; batchStart += batchSize) {
      const batchEnd = Math.min(selected.length - 1, batchStart + batchSize)
      const input = []
      for (let index = batchStart; index < batchEnd; index++) {
        input.push([selected[index], { generateNext: { probabilities: true } }])
      }
      const outputs = await sequence.controlledEvaluate(input)
      for (let index = 0; index < batchEnd - batchStart; index++) {
        const probabilityMap = outputs[index]?.next?.probabilities
        const nextToken = selected[batchStart + index + 1]
        const probability = probabilityMap?.get(nextToken) ?? 0
        if (probability <= 0) continue
        let rank = 0
        for (const [, candidateProbability] of probabilityMap) {
          if (candidateProbability > probability) rank++
          else break
        }
        sumLogProb += Math.log(probability)
        probabilitySum += probability
        if (rank < 5) top5Matches++
        tokenCount++
        const globalTokenIndex = startToken + batchStart + index + 1
        tokenMetrics.push({
          charOffset: charOffsets[globalTokenIndex],
          charLen: tokenTexts[globalTokenIndex].length,
          logProb: Math.log(probability),
          prob: probability,
          inTop5: rank < 5
        })
      }
    }

    const lastToken = endToken - 1
    windows.push({
      startToken,
      endToken,
      start: startToken === 0 ? 0 : charOffsets[startToken],
      end: endToken === tokens.length
        ? text.length
        : Math.min(text.length, charOffsets[lastToken] + tokenTexts[lastToken].length),
      metric: tokenCount > 0 ? {
        ppl: Math.exp(-sumLogProb / tokenCount),
        tokenCount,
        top5Rate: top5Matches / tokenCount,
        avgProb: probabilitySum / tokenCount
      } : { ppl: 0, tokenCount: 0, top5Rate: 0, avgProb: 0 },
      tokenMetrics
    })
    post({
      type: 'progress',
      progress: Math.round(((windowIndex + 1) / starts.length) * 100),
      message: `正在分析重叠窗口… ${windowIndex + 1}/${starts.length}`
    })
  }
  return windows
}

/**
 * 兼容旧的分段计算模式（保留但不再作为主要路径）
 */
async function computePerplexity(segments: Array<{ id: number; text: string }>): Promise<SegmentPPLResult[]> {
  if (!model || !context) {
    throw new Error('模型未初始化')
  }

  const results: SegmentPPLResult[] = []
  const totalSegments = segments.length

  for (let idx = 0; idx < segments.length; idx++) {
    const seg = segments[idx]
    const metrics = await computeSegmentMetrics(seg.text)
    results.push({ id: seg.id, ...metrics })

    post({
      type: 'progress',
      progress: Math.round(((idx + 1) / totalSegments) * 100),
      message: `正在计算困惑度… ${idx + 1}/${totalSegments}`
    })
  }

  return results
}

async function computeSegmentMetrics(text: string): Promise<Omit<SegmentPPLResult, 'id'>> {
  const empty = { ppl: 0, tokenCount: 0, top5Rate: 0, avgProb: 0 }
  if (!text.trim()) return empty

  let tokens = model.tokenize(text)
  if (tokens.length < 4) return empty

  const maxLen = 1800
  if (tokens.length > maxLen) {
    tokens = tokens.slice(0, maxLen)
  }

  await sequence.clearHistory()

  try {
    const input: any[] = tokens.map((token: any, i: number) => {
      if (i < tokens.length - 1) {
        return [token, { generateNext: { probabilities: true } }]
      }
      return token
    })

    const outputItems = await sequence.controlledEvaluate(input)

    let sumLogProb = 0
    let count = 0
    let top5Matches = 0
    let probSum = 0

    for (let i = 0; i < tokens.length - 1; i++) {
      const output = outputItems[i]
      if (!output || !output.next || !output.next.probabilities) continue

      const nextToken = tokens[i + 1]
      const probMap = output.next.probabilities
      const prob = probMap.get(nextToken) ?? 0

      if (prob > 0) {
        sumLogProb += Math.log(prob)
        count++
        probSum += prob

        let rank = 0
        for (const [, p] of probMap) {
          if (p > prob) rank++
          else break
        }
        if (rank < 5) top5Matches++
      }
    }

    if (count === 0) return empty

    return {
      ppl: Math.exp(-sumLogProb / count),
      tokenCount: count,
      top5Rate: top5Matches / count,
      avgProb: probSum / count
    }
  } catch (err: any) {
    parentPort?.postMessage({
      type: 'progress',
      message: `PPL计算异常: ${err?.message || err}`
    })
    return empty
  }
}

async function dispose() {
  if (sequence) {
    sequence.dispose()
    sequence = null
  }
  if (context) {
    await context.dispose()
    context = null
  }
  if (model) {
    await model.dispose()
    model = null
  }
  if (llamaInstance) {
    await llamaInstance.dispose()
    llamaInstance = null
  }
}

parentPort?.on('message', async (msg: WorkerRequest) => {
  try {
    switch (msg.type) {
      case 'init':
        if (!msg.modelPath) throw new Error('缺少 modelPath')
        await initModel(msg.modelPath)
        break
      case 'computeWindows':
        if (!msg.text) throw new Error('缺少 text')
        const windows = await computeTokenWindows(msg.text)
        post({ type: 'windowResult', windows })
        break
      case 'dispose':
        await dispose()
        post({ type: 'disposed' })
        parentPort?.close()
        break
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : '未知错误' })
  }
})

if (workerData?.modelPath) {
  initModel(workerData.modelPath).catch(err => {
    post({ type: 'error', message: `初始化失败: ${err.message}` })
  })
}
