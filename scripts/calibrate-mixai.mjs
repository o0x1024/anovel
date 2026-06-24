/**
 * 朱雀样本拟合校准脚本
 * 用法: node scripts/calibrate-mixai.mjs [model-path]
 */
import { getLlama } from 'node-llama-cpp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const DEFAULT_MODEL = path.join(
  os.homedir(),
  'Library/Application Support/anovel/models/qwen3.5-0.8b-q4/Qwen3.5-0.8B-Q4_K_M.gguf'
)
const MODEL_PATH = process.argv[2] || DEFAULT_MODEL

// 朱雀检测结果作为拟合目标
const SAMPLES = [
  {
    name: 'A1',
    path: 'docs/mix-ai/A1.md',
    zhuque: { human: 46.4, suspected: 53.6, ai: 0 },
  },
  {
    name: 'B1',
    path: 'docs/mix-ai/B1.md',
    zhuque: { human: 0, suspected: 48.65, ai: 51.35 },
  },
  {
    name: 'C1',
    path: 'docs/mix-ai/C1.md',
    zhuque: { human: 0, suspected: 27.54, ai: 72.46 },
  },
  {
    name: 'D1',
    path: 'docs/mix-ai/D1.md',
    zhuque: { human: 0, suspected: 62.98, ai: 37.02 },
  },
  {
    name: 'E1',
    path: 'docs/mix-ai/E1.md',
    zhuque: { human: 0, suspected: 62.73, ai: 37.27 },
  },
]

function extractText(content) {
  const lines = content.split('\n')
  // Skip first 3 lines (Zhuque results + blank line)
  return lines.slice(3).join('\n').trim()
}

function segmentText(text) {
  const paragraphs = text.split(/\n/).filter(p => p.trim())
  const segments = []
  let id = 0

  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue

    const sentences = trimmed.split(/(?<=[。！？；…」』）])/g).filter(s => s.trim().length > 3)
    if (sentences.length <= 2) {
      segments.push({ id: id++, text: trimmed })
    } else {
      let buffer = ''
      for (const s of sentences) {
        buffer += s
        if (buffer.length >= 40) {
          segments.push({ id: id++, text: buffer })
          buffer = ''
        }
      }
      if (buffer.trim()) {
        segments.push({ id: id++, text: buffer })
      }
    }
  }

  return segments
}

async function computeSegmentMetrics(sequence, model, text) {
  if (!text.trim()) return null

  let tokens = model.tokenize(text)
  if (tokens.length < 4) return null
  if (tokens.length > 1800) tokens = tokens.slice(0, 1800)

  await sequence.clearHistory()

  const input = tokens.map((token, i) => {
    if (i < tokens.length - 1) {
      return [token, { generateNext: { probabilities: true } }]
    }
    return token
  })

  const outputItems = await sequence.controlledEvaluate(input)

  let sumLogProb = 0
  let count = 0
  let top5Matches = 0
  const tokenProbs = []

  for (let i = 0; i < tokens.length - 1; i++) {
    const output = outputItems[i]
    if (!output || !output.next || !output.next.probabilities) continue

    const nextToken = tokens[i + 1]
    const probMap = output.next.probabilities
    const prob = probMap.get(nextToken) ?? 0

    if (prob > 0) {
      sumLogProb += Math.log(prob)
      count++
      tokenProbs.push(prob)

      let rank = 0
      for (const [, p] of probMap) {
        if (p > prob) rank++
        else break
      }
      if (rank < 5) top5Matches++
    }
  }

  if (count === 0) return null

  const ppl = Math.exp(-sumLogProb / count)
  const avgProb = tokenProbs.reduce((a, b) => a + b, 0) / tokenProbs.length

  return {
    ppl,
    tokenCount: count,
    top5Rate: top5Matches / count,
    avgProb,
    textLen: text.length
  }
}

// V3 评分逻辑
const BASELINE = { ppl: 83, top5: 0.505, avgProb: 0.183 }

function computeV3Score(ppl, top5Rate, avgProb) {
  const pplDev = (ppl - BASELINE.ppl) / BASELINE.ppl
  const top5Dev = (BASELINE.top5 - top5Rate) / BASELINE.top5
  const probDev = (BASELINE.avgProb - avgProb) / BASELINE.avgProb

  const signs = [Math.sign(pplDev), Math.sign(top5Dev), Math.sign(probDev)]
  const positives = signs.filter(s => s > 0).length
  const negatives = signs.filter(s => s < 0).length
  const coherence = Math.max(positives, negatives) / 3

  const mapDev = (d) => Math.min(95, d <= 0.3 ? d / 0.3 * 30 :
    d <= 0.7 ? 30 + (d - 0.3) / 0.4 * 30 :
    60 + (d - 0.7) / 0.5 * 25)

  const pplScore = mapDev(Math.abs(pplDev))
  const top5Score = mapDev(Math.abs(top5Dev))
  const probScore = mapDev(Math.abs(probDev))

  const baseScore = pplScore * 0.40 + top5Score * 0.35 + probScore * 0.25
  const coherenceMultiplier = 0.7 + coherence * 0.6

  return Math.min(100, baseScore * coherenceMultiplier)
}

function computeHeuristicFeatures(text) {
  const sentences = text.split(/[。！？；…]+/).filter(s => s.trim().length > 2)
  if (sentences.length < 3) return { heuristicAiBoost: 0 }

  const lengths = sentences.map(s => s.trim().length)
  let boost = 0

  const chars = text.replace(/[，。！？、；：""''（）\s\n]/g, '')
  const uniqueChars = new Set(chars).size
  const ttr = uniqueChars / Math.min(chars.length, 500)
  if (ttr < 0.40 && chars.length > 200) boost += 4

  const openings = sentences.map(s => s.trim().slice(0, 2))
  const uniqueOpenings = new Set(openings).size
  const openingDiversity = uniqueOpenings / openings.length
  if (openingDiversity < 0.55 && sentences.length >= 8) boost += 5

  if (sentences.length >= 6) {
    let alternationCount = 0
    for (let i = 1; i < lengths.length; i++) {
      const prev = lengths[i - 1]
      const curr = lengths[i]
      if ((prev < 8 && curr > 30) || (prev > 30 && curr < 8)) alternationCount++
    }
    const alternationRate = alternationCount / (lengths.length - 1)
    if (alternationRate > 0.12) boost += 8
  }

  const shortSents = lengths.filter(l => l < 8).length
  const longSents = lengths.filter(l => l > 40).length
  const shortRatio = shortSents / sentences.length
  const longRatio = longSents / sentences.length
  if (shortRatio > 0.18 && longRatio > 0.12 && sentences.length >= 8) boost += 6

  const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length
  const sentLenStd = Math.sqrt(lengths.reduce((s, l) => s + Math.pow(l - avgLen, 2), 0) / lengths.length)
  if (sentLenStd < 5 && sentences.length >= 8) boost += 5

  // 新增: 对话密度过高（AI小说倾向使用大量短对话推动情节）
  const dialogueLines = text.split('\n').filter(l => /^["「『"]/.test(l.trim()) || /^["""]/.test(l.trim()))
  const allLines = text.split('\n').filter(l => l.trim().length > 0)
  if (allLines.length >= 10) {
    const dialogueRatio = dialogueLines.length / allLines.length
    if (dialogueRatio > 0.35) {
      boost += 6
    }
  }

  // 新增: 短对话回复模式（大量 "嗯"、"什么？" 等极短句）
  const veryShortSents = sentences.filter(s => s.trim().length <= 4)
  if (veryShortSents.length >= 5 && veryShortSents.length / sentences.length > 0.10) {
    boost += 5
  }

  // 新增: 情感/动作描写模板密度（"她愣住了"、"声音很轻"、"猛地"类模板）
  const templatePatterns = /[她他](?:愣|笑|叹|呆|抖|站|蹲|转身|低头|抬头|皱眉|摇头|点头|放下|拿起|走到)|声音很[轻小低哑]|猛地|突然|像是|忽然|半天没/g
  const templateCount = (text.match(templatePatterns) || []).length
  if (templateCount >= 8 && sentences.length >= 15) {
    boost += 6
  }

  return { heuristicAiBoost: Math.min(25, boost) }
}

// 参数网格搜索
const PARAM_SETS = [
  { name: 'V5-a(0.8B最优)', aiFloor: 65, humanCeiling: 28, boostThresh: 38, boostFactor: 2.5, boostMax: 25, reduceThresh: 30, reduceFactor: 1.5, reduceMax: 8 },
  { name: '4B-v1',       aiFloor: 78, humanCeiling: 28, boostThresh: 42, boostFactor: 2.0, boostMax: 20, reduceThresh: 35, reduceFactor: 2.0, reduceMax: 10 },
  { name: '4B-v2',       aiFloor: 80, humanCeiling: 30, boostThresh: 44, boostFactor: 1.8, boostMax: 18, reduceThresh: 36, reduceFactor: 2.0, reduceMax: 12 },
  { name: '4B-v3',       aiFloor: 82, humanCeiling: 32, boostThresh: 45, boostFactor: 1.5, boostMax: 15, reduceThresh: 38, reduceFactor: 2.5, reduceMax: 14 },
  { name: '4B-v4',       aiFloor: 75, humanCeiling: 30, boostThresh: 40, boostFactor: 2.0, boostMax: 20, reduceThresh: 34, reduceFactor: 2.0, reduceMax: 10 },
  { name: '4B-v5',       aiFloor: 85, humanCeiling: 35, boostThresh: 48, boostFactor: 1.5, boostMax: 12, reduceThresh: 40, reduceFactor: 2.5, reduceMax: 15 },
  { name: '4B-v6',       aiFloor: 80, humanCeiling: 32, boostThresh: 42, boostFactor: 2.0, boostMax: 20, reduceThresh: 36, reduceFactor: 2.0, reduceMax: 12 },
  { name: '4B-v7',       aiFloor: 78, humanCeiling: 32, boostThresh: 40, boostFactor: 2.0, boostMax: 20, reduceThresh: 35, reduceFactor: 2.0, reduceMax: 12 },
]

async function main() {
  if (!fs.existsSync(MODEL_PATH)) {
    console.error(`模型文件不存在: ${MODEL_PATH}`)
    process.exit(1)
  }

  console.log(`模型: ${path.basename(MODEL_PATH)}`)
  console.log('正在加载模型…')
  const llama = await getLlama()
  const model = await llama.loadModel({ modelPath: MODEL_PATH })
  const context = await model.createContext({ contextSize: 4096 })
  const sequence = context.getSequence()
  console.log('模型加载完成\n')

  // 第一步：计算所有样本的原始指标（只需运行一次）
  const sampleData = []

  for (const sample of SAMPLES) {
    const filePath = path.join(projectRoot, sample.path)
    if (!fs.existsSync(filePath)) continue

    const content = fs.readFileSync(filePath, 'utf-8')
    const text = extractText(content)
    const segments = segmentText(text)

    console.log(`计算 ${sample.name} (${segments.length} 段)…`)

    const fileMetrics = []
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const metrics = await computeSegmentMetrics(sequence, model, seg.text)
      if (!metrics) continue
      fileMetrics.push({ ...metrics, text: seg.text })
    }

    const heuristic = computeHeuristicFeatures(text)
    const meaningful = fileMetrics.filter(m => m.ppl < 300 && m.tokenCount >= 5)
    const scores = meaningful.map(m => computeV3Score(m.ppl, m.top5Rate, m.avgProb))

    sampleData.push({ sample, meaningful, scores, heuristic, text })
  }

  console.log('\n原始指标已计算完成，开始参数搜索…\n')

  // 第二步：对每组参数进行评估
  console.log('='.repeat(120))
  console.log('参数网格搜索结果')
  console.log('='.repeat(120))

  const paramResults = []

  for (const params of PARAM_SETS) {
    const detectedResults = []

    for (const { sample, meaningful, scores, heuristic } of sampleData) {
      const rawDocScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 50
      const docScore = rawDocScore + heuristic.heuristicAiBoost

      // 一致性检测：如果大多数段落评分偏高，说明文档整体AI特征明显
      const suspiciousCount = scores.filter(s => s >= 30).length
      const suspiciousRatio = scores.length > 0 ? suspiciousCount / scores.length : 0
      const consistencyBoost = suspiciousRatio > 0.55 ? (suspiciousRatio - 0.55) * 30 : 0

      const effectiveDocScore = docScore + consistencyBoost

      // 动态 aiFloor: 当文档多重信号均指向AI时，降低AI判定门槛
      let effectiveAiFloor = params.aiFloor
      if (effectiveDocScore >= 50 && heuristic.heuristicAiBoost >= 8) {
        effectiveAiFloor = Math.max(params.aiFloor - 15, 50)
      } else if (effectiveDocScore >= 45) {
        effectiveAiFloor = Math.max(params.aiFloor - 8, 55)
      }

      let humanLen = 0, suspectedLen = 0, aiLen = 0

      for (let j = 0; j < meaningful.length; j++) {
        let adjustedScore = scores[j]

        // 短段落（token < 10）得分封顶，避免极端PPL导致误判
        if (meaningful[j].tokenCount < 10) {
          adjustedScore = Math.min(adjustedScore, 55)
        }

        if (effectiveDocScore >= params.boostThresh) {
          const boost = Math.min(params.boostMax, (effectiveDocScore - params.boostThresh) * params.boostFactor)
          adjustedScore = Math.min(100, adjustedScore + boost)
        } else if (effectiveDocScore <= params.reduceThresh) {
          const reduction = Math.min(params.reduceMax, (params.reduceThresh - effectiveDocScore) * params.reduceFactor)
          adjustedScore = Math.max(0, adjustedScore - reduction)
        }

        let cat
        if (adjustedScore >= effectiveAiFloor) cat = 'ai'
        else if (adjustedScore <= params.humanCeiling) cat = 'human'
        else cat = 'suspected_ai'

        const textLen = meaningful[j].textLen
        if (cat === 'human') humanLen += textLen
        else if (cat === 'ai') aiLen += textLen
        else suspectedLen += textLen
      }

      const totalLen = humanLen + suspectedLen + aiLen
      detectedResults.push({
        name: sample.name,
        zhuque: sample.zhuque,
        detected: {
          human: totalLen > 0 ? humanLen / totalLen * 100 : 0,
          suspected: totalLen > 0 ? suspectedLen / totalLen * 100 : 0,
          ai: totalLen > 0 ? aiLen / totalLen * 100 : 0,
        }
      })
    }

    // 计算 MAE
    let totalError = 0
    for (const r of detectedResults) {
      const errH = Math.abs(r.detected.human - r.zhuque.human)
      const errS = Math.abs(r.detected.suspected - r.zhuque.suspected)
      const errA = Math.abs(r.detected.ai - r.zhuque.ai)
      totalError += (errH + errS + errA) / 3
    }
    const mae = totalError / detectedResults.length

    paramResults.push({ params, detectedResults, mae })
  }

  // 输出结果（按MAE排序）
  paramResults.sort((a, b) => a.mae - b.mae)

  for (const { params, detectedResults, mae } of paramResults) {
    console.log(`\n┌─ ${params.name} | MAE=${mae.toFixed(1)}% | aiFloor=${params.aiFloor} humanCeiling=${params.humanCeiling} boost=${params.boostThresh}/${params.boostFactor}/${params.boostMax} reduce=${params.reduceThresh}/${params.reduceFactor}/${params.reduceMax}`)
    for (const r of detectedResults) {
      const errH = Math.abs(r.detected.human - r.zhuque.human)
      const errS = Math.abs(r.detected.suspected - r.zhuque.suspected)
      const errA = Math.abs(r.detected.ai - r.zhuque.ai)
      const avg = (errH + errS + errA) / 3
      console.log(
        `│  ${r.name.padEnd(4)} 朱雀[人${r.zhuque.human.toFixed(0).padStart(3)} 疑${r.zhuque.suspected.toFixed(0).padStart(3)} AI${r.zhuque.ai.toFixed(0).padStart(3)}] ` +
        `检测[人${r.detected.human.toFixed(1).padStart(5)} 疑${r.detected.suspected.toFixed(1).padStart(5)} AI${r.detected.ai.toFixed(1).padStart(5)}] ` +
        `偏差=${avg.toFixed(1)}`
      )
    }
    console.log(`└─ 总MAE: ${mae.toFixed(1)}%`)
  }

  console.log('\n\n最优参数: ' + paramResults[0].params.name)
  console.log(JSON.stringify(paramResults[0].params, null, 2))

  await sequence.dispose()
  await context.dispose()
  await model.dispose()
  await llama.dispose()
}

main().catch(err => {
  console.error('运行失败:', err)
  process.exit(1)
})
