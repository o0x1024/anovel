import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getLlama } from 'node-llama-cpp'
import {
  classifyZhuqueSegments,
  computeZhuqueDistribution,
  scoreZhuqueSegment,
  segmentTextForZhuque
} from '../src/main/perplexity/zhuque-alignment'
import {
  validateZhuqueCalibrationCorpus,
  ZHUQUE_CALIBRATION_SAMPLES
} from './zhuque-calibration-corpus'

const projectRoot = process.cwd()
const defaultModel = path.join(
  os.homedir(),
  'Library/Application Support/anovel/models/qwen3.5-0.8b-q4/Qwen3.5-0.8B-Q4_K_M.gguf'
)
const modelPath = process.argv[2] || defaultModel
const cachePath = '/tmp/anovel-zhuque-calibration-cache.json'

type TokenMetric = { charOffset: number; logProb: number; prob: number; inTop5: boolean }

async function computeWholeMetrics(sequence: any, model: any, text: string): Promise<TokenMetric[]> {
  let tokens = model.tokenize(text)
  if (tokens.length > 3800) tokens = tokens.slice(0, 3800)
  const tokenTexts = tokens.map((token: any) => model.detokenize([token]))
  const charOffsets: number[] = []
  let offset = 0
  for (const tokenText of tokenTexts) {
    charOffsets.push(offset)
    offset += tokenText.length
  }

  await sequence.clearHistory()
  const metrics: TokenMetric[] = []
  const batchSize = 32
  for (let start = 0; start < tokens.length - 1; start += batchSize) {
    const end = Math.min(start + batchSize, tokens.length - 1)
    const input = []
    for (let i = start; i < end; i++) {
      input.push([tokens[i], { generateNext: { probabilities: true } }])
    }
    if (end < tokens.length && end === tokens.length - 1) input.push(tokens[end])
    const outputs = await sequence.controlledEvaluate(input)
    for (let i = 0; i < end - start; i++) {
      const output = outputs[i]
      const nextToken = tokens[start + i + 1]
      const probabilityMap = output?.next?.probabilities
      const prob = probabilityMap?.get(nextToken) ?? 0
      if (prob <= 0) continue
      let rank = 0
      for (const [, candidateProb] of probabilityMap) {
        if (candidateProb > prob) rank++
        else break
      }
      metrics.push({
        charOffset: charOffsets[start + i + 1],
        logProb: Math.log(prob),
        prob,
        inTop5: rank < 5
      })
    }
  }
  return metrics
}

function aggregate(text: string, tokenMetrics: TokenMetric[]) {
  const segments = segmentTextForZhuque(text)
  let offset = 0
  return segments.map(segment => {
    const start = offset
    const end = start + segment.text.length
    offset = end
    const covered = tokenMetrics.filter(metric => metric.charOffset >= start && metric.charOffset < end)
    const tokenCount = covered.length
    const ppl = tokenCount > 0
      ? Math.exp(-covered.reduce((sum, metric) => sum + metric.logProb, 0) / tokenCount)
      : 0
    return {
      segment,
      metric: {
        ppl,
        tokenCount,
        top5Rate: tokenCount > 0 ? covered.filter(metric => metric.inTop5).length / tokenCount : 0,
        avgProb: tokenCount > 0 ? covered.reduce((sum, metric) => sum + metric.prob, 0) / tokenCount : 0
      }
    }
  })
}

async function main() {
  const corpusErrors = validateZhuqueCalibrationCorpus()
  if (corpusErrors.length > 0) throw new Error(`朱雀校准语料无效：${corpusErrors.join('；')}`)

  let totalError = 0
  const cache: Record<string, ReturnType<typeof aggregate>> = fs.existsSync(cachePath)
    ? JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    : {}
  const missingSamples = ZHUQUE_CALIBRATION_SAMPLES.filter(sample => !cache[sample.file])
  if (missingSamples.length > 0 && !fs.existsSync(modelPath)) {
    throw new Error(`模型不存在: ${modelPath}`)
  }
  const llama = missingSamples.length > 0 ? await getLlama() : undefined
  const model = llama ? await llama.loadModel({ modelPath }) : undefined
  const context = model ? await model.createContext({ contextSize: 4096 }) : undefined
  const sequence = context?.getSequence()

  for (const sample of ZHUQUE_CALIBRATION_SAMPLES) {
    const text = fs.readFileSync(path.join(projectRoot, 'docs/experiments', sample.file), 'utf8')
    let aggregated = cache[sample.file]
    if (!aggregated) {
      if (!sequence) throw new Error(`样本 ${sample.file} 缺少缓存且模型未初始化`)
      const tokenMetrics = await computeWholeMetrics(sequence, model, text)
      aggregated = aggregate(text, tokenMetrics)
      cache[sample.file] = aggregated
      fs.writeFileSync(cachePath, JSON.stringify(cache))
    }
    const scored = aggregated.map(({ segment, metric }) => scoreZhuqueSegment(segment.text, metric))
    const classified = classifyZhuqueSegments(scored)
    const distribution = computeZhuqueDistribution(classified)
    const expectedEntries = Object.entries(sample.expected.distribution) as Array<[
      keyof typeof distribution,
      number
    ]>
    const error = expectedEntries.reduce(
      (sum, [category, expected]) => sum + Math.abs(distribution[category] - expected),
      0
    ) / expectedEntries.length
    totalError += error
    const scores = classified.map(segment =>
      `${Math.round(segment.score)}${segment.evidence.styleReduction ? `(-${segment.evidence.styleReduction})` : ''}`
    ).join(',')
    const coverage = sample.expected.coverage === 'partial' ? ' 部分标注' : ''
    console.log(`${sample.name.padEnd(10)} 朱雀=${JSON.stringify(sample.expected.distribution)}${coverage} 检测=${JSON.stringify(distribution)} 误差=${error.toFixed(1)} 分=${scores}`)
  }

  console.log(`已知标注字段平均 MAE=${(totalError / ZHUQUE_CALIBRATION_SAMPLES.length).toFixed(1)}%`)
  await sequence?.dispose()
  await context?.dispose()
  await model?.dispose()
  await llama?.dispose()
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
