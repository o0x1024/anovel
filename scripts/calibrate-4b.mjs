/**
 * 4B 模型校准脚本 — 对齐朱雀 AI 检测助手
 * 用法: node scripts/calibrate-4b.mjs [model-path]
 * 
 * 思路：遍历参数空间，找到让检测结果最接近朱雀的阈值组合
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
  'Library/Application Support/anovel/models/qwen3.5-4b-q4/Qwen3.5-4B-Q4_K_M.gguf'
)
const MODEL_PATH = process.argv[2] || DEFAULT_MODEL

// ═══════════════════════════════════════════════════════════════════════════
// 校准样本集 — 朱雀检测结果作为 ground truth
// ═══════════════════════════════════════════════════════════════════════════

const SAMPLES = [
  {
    name: 'A1-human',
    path: 'docs/experiments/A1-human.txt',
    zhuque: { human: 100, suspected: 0, ai: 0 },
    description: '凡人修仙传原文（纯人工）',
  },
  {
    name: 'F1-ai-novel',
    path: 'docs/experiments/F1-ai-novel.txt',
    zhuque: { human: 0, suspected: 85.03, ai: 14.97 },
    description: 'AI生成的都市小说（高AI特征）',
  },
  {
    name: 'A1-mix',
    path: 'docs/mix-ai/A1.md',
    zhuque: { human: 46.4, suspected: 53.6, ai: 0 },
    description: '人工+AI混合文本（半人工）',
  },
  {
    name: 'A2-mix',
    path: 'docs/mix-ai/A2.md',
    zhuque: { human: 0, suspected: 75.52, ai: 24.48 },
    description: 'AI资讯体（高疑似）',
  },
  {
    name: 'A3-mix',
    path: 'docs/mix-ai/A3.md',
    zhuque: { human: 0, suspected: 51.51, ai: 48.49 },
    description: 'AI科普体（疑似/AI各半）',
  },
  {
    name: 'B1-mix',
    path: 'docs/mix-ai/B1.md',
    zhuque: { human: 0, suspected: 48.65, ai: 51.35 },
    description: 'AI为主混合文本（中AI）',
  },
  {
    name: 'C1-mix',
    path: 'docs/mix-ai/C1.md',
    zhuque: { human: 0, suspected: 27.54, ai: 72.46 },
    description: 'AI为主混合文本（强AI）',
  },
  {
    name: 'D1-mix',
    path: 'docs/mix-ai/D1.md',
    zhuque: { human: 0, suspected: 62.98, ai: 37.02 },
    description: 'AI为主混合文本（中AI偏疑似）',
  },
  {
    name: 'E1-mix',
    path: 'docs/mix-ai/E1.md',
    zhuque: { human: 0, suspected: 62.73, ai: 37.27 },
    description: 'AI为主混合文本（中AI偏疑似）',
  },
]

// ═══════════════════════════════════════════════════════════════════════════
// 文本预处理
// ═══════════════════════════════════════════════════════════════════════════

function extractText(content, filePath) {
  // mix-ai 样本前3行是朱雀结果
  if (filePath.includes('mix-ai')) {
    const lines = content.split('\n')
    return lines.slice(3).join('\n').trim()
  }
  return content.trim()
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

// ═══════════════════════════════════════════════════════════════════════════
// 整文连续困惑度计算（对齐 perplexity-worker 中的 computeWhole 逻辑）
// ═══════════════════════════════════════════════════════════════════════════

async function computeWholeTextMetrics(sequence, model, text) {
  const fullText = text.trim()
  if (!fullText) return null

  let tokens = model.tokenize(fullText)
  if (tokens.length < 4) return null
  if (tokens.length > 3800) tokens = tokens.slice(0, 3800)

  await sequence.clearHistory()

  // 分批处理以避免 OOM（每批 150 个 token 请求概率）
  const BATCH_SIZE = 150
  const tokenMetrics = []
  let charOffset = 0

  for (let batchStart = 0; batchStart < tokens.length - 1; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, tokens.length - 1)

    const input = tokens.slice(batchStart, batchEnd + 1).map((token, i) => {
      const globalIdx = batchStart + i
      if (globalIdx < batchEnd) {
        return [token, { generateNext: { probabilities: true } }]
      }
      return token
    })

    const outputItems = await sequence.controlledEvaluate(input)

    for (let i = 0; i < batchEnd - batchStart; i++) {
      const globalIdx = batchStart + i
      const output = outputItems[i]
      if (!output || !output.next || !output.next.probabilities) {
        const nextToken = tokens[globalIdx + 1]
        const tokenText = model.detokenize([nextToken])
        charOffset += tokenText.length
        continue
      }

      const nextToken = tokens[globalIdx + 1]
      const tokenText = model.detokenize([nextToken])
      const probMap = output.next.probabilities
      const prob = probMap.get(nextToken) ?? 0

      if (prob > 0) {
        let rank = 0
        for (const [, p] of probMap) {
          if (p > prob) rank++
          if (rank >= 5) break
        }

        tokenMetrics.push({
          charOffset,
          charLen: tokenText.length,
          logProb: Math.log(prob),
          prob,
          inTop5: rank < 5,
        })
      }

      charOffset += tokenText.length
    }

    // 不清除历史，保持上下文连续性
  }

  return tokenMetrics
}

/**
 * 将整文 token metrics 按段落边界聚合
 */
function aggregateBySegments(tokenMetrics, segments, fullText) {
  // 计算段落的字符边界
  const boundaries = []
  let searchFrom = 0
  for (const seg of segments) {
    const start = fullText.indexOf(seg.text, searchFrom)
    if (start === -1) {
      boundaries.push({ start: searchFrom, end: searchFrom + seg.text.length })
    } else {
      boundaries.push({ start, end: start + seg.text.length })
      searchFrom = start + seg.text.length
    }
  }

  // 聚合
  const results = segments.map((seg, idx) => {
    const { start, end } = boundaries[idx]
    const covered = tokenMetrics.filter(t =>
      t.charOffset >= start && t.charOffset < end
    )

    if (covered.length === 0) {
      return { ppl: 0, top5Rate: 0, avgProb: 0, tokenCount: 0, textLen: seg.text.length }
    }

    const sumLogProb = covered.reduce((s, t) => s + t.logProb, 0)
    const ppl = Math.exp(-sumLogProb / covered.length)
    const top5Rate = covered.filter(t => t.inTop5).length / covered.length
    const avgProb = covered.reduce((s, t) => s + t.prob, 0) / covered.length

    return { ppl, top5Rate, avgProb, tokenCount: covered.length, textLen: seg.text.length }
  })

  return results
}

// ═══════════════════════════════════════════════════════════════════════════
// 评分逻辑
// ═══════════════════════════════════════════════════════════════════════════

const BASELINE = { ppl: 83, top5: 0.505, avgProb: 0.183 }

// 4B 模型的基线需要从人工样本中重新测定
let CALIBRATED_BASELINE = { ...BASELINE }

function computeAiScore(ppl, top5Rate, avgProb, baseline = CALIBRATED_BASELINE) {
  const pplDev = (ppl - baseline.ppl) / baseline.ppl
  const top5Dev = (baseline.top5 - top5Rate) / baseline.top5
  const probDev = (baseline.avgProb - avgProb) / baseline.avgProb

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

/** 对齐 perplexity-service.ts 的启发式加分 */
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

  const dialogueLines = text.split('\n').filter(l => /^["「『"]/.test(l.trim()) || /^["""]/.test(l.trim()))
  const allLines = text.split('\n').filter(l => l.trim().length > 0)
  if (allLines.length >= 10) {
    const dialogueRatio = dialogueLines.length / allLines.length
    if (dialogueRatio > 0.35) boost += 6
  }

  const veryShortSents = sentences.filter(s => s.trim().length <= 4)
  if (veryShortSents.length >= 5 && veryShortSents.length / sentences.length > 0.10) boost += 5

  const templatePatterns = /[她他](?:愣|笑|叹|呆|抖|站|蹲|转身|低头|抬头|皱眉|摇头|点头|放下|拿起|走到)|声音很[轻小低哑]|猛地|突然|像是|忽然|半天没/g
  const templateCount = (text.match(templatePatterns) || []).length
  if (templateCount >= 8 && sentences.length >= 15) boost += 6

  const explainerPatterns = /(你以为|说真的|很多人|换个角度|认知还停留在|千万别|记住|赶紧|提醒|黑产|精准诈骗|导出上千条|你想想看|渗透测试|防不胜防|半分钟|划重点)/g
  const explainerHits = (text.match(explainerPatterns) || []).length
  if (explainerHits >= 3 && sentences.length >= 10) {
    boost += 12 + Math.min(6, explainerHits - 3)
  }

  return { heuristicAiBoost: Math.min(30, boost), explainerHits }
}

function computeDocScore(rawDocScore, scores, heuristicBoost) {
  const suspiciousCount = scores.filter(s => s >= 30).length
  const suspiciousRatio = scores.length > 0 ? suspiciousCount / scores.length : 0
  const consistencyBoost = suspiciousRatio > 0.55 ? (suspiciousRatio - 0.55) * 30 : 0
  return rawDocScore + heuristicBoost + consistencyBoost
}

// ═══════════════════════════════════════════════════════════════════════════
// 参数网格 — 对齐生产 perplexity-service 逻辑
// ═══════════════════════════════════════════════════════════════════════════

const PARAM_GRID = []

for (const aiFloor of [48, 52, 55, 58, 62, 65, 68]) {
  for (const humanCeiling of [12, 15, 18, 22, 25]) {
    for (const boostThresh of [28, 32, 35, 38, 42]) {
      for (const boostFactor of [2.0, 2.5, 3.0]) {
        for (const boostMax of [15, 20, 25, 28]) {
          PARAM_GRID.push({
            aiFloor,
            humanCeiling,
            boostThresh,
            boostFactor,
            boostMax,
            reduceThresh: 22,
            reduceFactor: 1.0,
            reduceMax: 6,
          })
        }
      }
    }
  }
}

console.log(`参数空间大小: ${PARAM_GRID.length} 组合`)

// ═══════════════════════════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  if (!fs.existsSync(MODEL_PATH)) {
    console.error(`模型文件不存在: ${MODEL_PATH}`)
    console.error(`请确认 Qwen3.5-4B 已下载到: ${MODEL_PATH}`)
    process.exit(1)
  }

  console.log(`模型: ${path.basename(MODEL_PATH)}`)
  console.log('正在加载模型…')
  const llama = await getLlama()
  const model = await llama.loadModel({ modelPath: MODEL_PATH })
  const context = await model.createContext({ contextSize: 4096 })
  const sequence = context.getSequence()
  console.log('模型加载完成\n')

  // 第一步：计算所有样本的原始指标
  const sampleData = []
  const humanMetricsRaw = [] // 用于基线校准

  for (const sample of SAMPLES) {
    const filePath = path.join(projectRoot, sample.path)
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️ 样本文件不存在，跳过: ${sample.path}`)
      continue
    }

    const content = fs.readFileSync(filePath, 'utf-8')
    const text = extractText(content, sample.path)
    const segments = segmentText(text)

    console.log(`计算 ${sample.name} (${segments.length} 段, ${text.length} 字)…`)

    // 整文连续计算
    const tokenMetrics = await computeWholeTextMetrics(sequence, model, text)
    if (!tokenMetrics || tokenMetrics.length === 0) {
      console.warn(`  ⚠️ 整文计算失败，跳过`)
      continue
    }

    // 聚合到段落
    const segResults = aggregateBySegments(tokenMetrics, segments, text)

    // 收集人工样本的原始指标用于基线校准
    if (sample.zhuque.human >= 50) {
      for (const r of segResults) {
        if (r.tokenCount >= 5 && r.ppl > 0 && r.ppl < 400) {
          humanMetricsRaw.push(r)
        }
      }
    }

    const heuristic = computeHeuristicFeatures(text)
    sampleData.push({ sample, segResults, segments, text, tokenMetrics, heuristic })
    console.log(`  → ${tokenMetrics.length} tokens, ${segResults.length} 段, 启发式+${heuristic.heuristicAiBoost}`)
  }

  // ═══ 第1.5步：基线校准 ═══
  console.log('\n' + '═'.repeat(80))
  console.log('基线校准（从人工样本推导 4B 模型的基线）')
  console.log('═'.repeat(80))

  if (humanMetricsRaw.length > 0) {
    const avgPPL = humanMetricsRaw.reduce((s, r) => s + r.ppl, 0) / humanMetricsRaw.length
    const avgTop5 = humanMetricsRaw.reduce((s, r) => s + r.top5Rate, 0) / humanMetricsRaw.length
    const avgProb = humanMetricsRaw.reduce((s, r) => s + r.avgProb, 0) / humanMetricsRaw.length

    // 基线设为人工文本的中位数方向，略偏向AI（这样人工文本得分低，AI文本得分高）
    const sortedPPL = humanMetricsRaw.map(r => r.ppl).sort((a, b) => a - b)
    const medianPPL = sortedPPL[Math.floor(sortedPPL.length / 2)]
    const sortedTop5 = humanMetricsRaw.map(r => r.top5Rate).sort((a, b) => a - b)
    const medianTop5 = sortedTop5[Math.floor(sortedTop5.length / 2)]
    const sortedProb = humanMetricsRaw.map(r => r.avgProb).sort((a, b) => a - b)
    const medianProb = sortedProb[Math.floor(sortedProb.length / 2)]

    console.log(`人工样本统计 (${humanMetricsRaw.length} 段):`)
    console.log(`  PPL:     avg=${avgPPL.toFixed(2)}, median=${medianPPL.toFixed(2)}`)
    console.log(`  Top5:    avg=${avgTop5.toFixed(4)}, median=${medianTop5.toFixed(4)}`)
    console.log(`  AvgProb: avg=${avgProb.toFixed(4)}, median=${medianProb.toFixed(4)}`)
    console.log(`  旧基线: PPL=${BASELINE.ppl}, Top5=${BASELINE.top5}, AvgProb=${BASELINE.avgProb}`)

    CALIBRATED_BASELINE = {
      ppl: medianPPL,
      top5: medianTop5,
      avgProb: medianProb,
    }
    console.log(`  新基线: PPL=${CALIBRATED_BASELINE.ppl.toFixed(2)}, Top5=${CALIBRATED_BASELINE.top5.toFixed(4)}, AvgProb=${CALIBRATED_BASELINE.avgProb.toFixed(4)}`)
  } else {
    console.warn('⚠️ 没有人工样本数据，使用默认基线')
  }

  // 重新计算所有分数（使用新基线）
  for (const data of sampleData) {
    data.scores = data.segResults.map(r => {
      if (r.tokenCount < 3 || r.ppl === 0 || r.ppl >= 400) return 50
      return computeAiScore(r.ppl, r.top5Rate, r.avgProb)
    })
    const validScores = data.scores.filter((_, i) => data.segResults[i].tokenCount >= 3)
    const rawDocScore = validScores.length > 0
      ? validScores.reduce((a, b) => a + b, 0) / validScores.length : 50
    data.docScore = computeDocScore(rawDocScore, validScores, data.heuristic.heuristicAiBoost)
    console.log(`  ${data.sample.name}: raw=${rawDocScore.toFixed(1)} doc=${data.docScore.toFixed(1)}, 范围=[${Math.min(...validScores).toFixed(0)}, ${Math.max(...validScores).toFixed(0)}]`)
  }

  console.log(`\n已计算 ${sampleData.length} 个样本的校准指标`)
  console.log('开始参数网格搜索…\n')

  // 第二步：遍历参数空间
  const paramResults = []

  for (const params of PARAM_GRID) {
    const detectedResults = []

    const explainerPatterns = /(你以为|说真的|很多人|换个角度|认知还停留在|千万别|记住|赶紧|提醒|黑产|精准诈骗|导出上千条|你想想看|渗透测试|防不胜防|半分钟|划重点)/g

    for (const { sample, segResults, scores, docScore, heuristic, segments } of sampleData) {
      let humanLen = 0, suspectedLen = 0, aiLen = 0
      const explainerMode = heuristic.explainerHits >= 6 && segResults.length >= 12
      const aiFloor = explainerMode ? Math.min(params.aiFloor, 54) : params.aiFloor

      for (let j = 0; j < segResults.length; j++) {
        const r = segResults[j]
        if (r.tokenCount < 3) {
          suspectedLen += r.textLen
          continue
        }

        let adjustedScore = scores[j]

        if (docScore >= params.boostThresh) {
          const boost = Math.min(params.boostMax, (docScore - params.boostThresh) * params.boostFactor)
          adjustedScore = Math.min(100, adjustedScore + boost)
        } else if (docScore <= params.reduceThresh) {
          const reduction = Math.min(params.reduceMax, (params.reduceThresh - docScore) * params.reduceFactor)
          adjustedScore = Math.max(0, adjustedScore - reduction)
        }

        if (explainerMode) {
          const segText = segments?.[j]?.text ?? ''
          const segHits = (segText.match(explainerPatterns) || []).length
          if (segHits >= 2) adjustedScore = Math.min(100, adjustedScore + 20)
          else if (segHits >= 1) adjustedScore = Math.min(100, adjustedScore + 14)
          else adjustedScore = Math.min(100, adjustedScore + 10)
        }

        let cat
        if (adjustedScore >= aiFloor) cat = 'ai'
        else if (adjustedScore <= params.humanCeiling) cat = 'human'
        else cat = 'suspected'

        if (cat === 'human') humanLen += r.textLen
        else if (cat === 'ai') aiLen += r.textLen
        else suspectedLen += r.textLen
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

    // 计算 MAE（加权：纯人工样本权重更高）
    let totalError = 0
    let totalWeight = 0
    for (const r of detectedResults) {
      const errH = Math.abs(r.detected.human - r.zhuque.human)
      const errS = Math.abs(r.detected.suspected - r.zhuque.suspected)
      const errA = Math.abs(r.detected.ai - r.zhuque.ai)
      const avgErr = (errH + errS + errA) / 3
      // 纯人工样本误判为AI是最严重的错误
      const weight = r.zhuque.human >= 50 ? 2.0 : 1.0
      totalError += avgErr * weight
      totalWeight += weight
    }
    const mae = totalError / totalWeight

    paramResults.push({ params, detectedResults, mae })
  }

  // 排序取 Top 10
  paramResults.sort((a, b) => a.mae - b.mae)

  console.log('═'.repeat(130))
  console.log('Top 10 参数组合（按 MAE 排序）')
  console.log('═'.repeat(130))

  for (let rank = 0; rank < Math.min(10, paramResults.length); rank++) {
    const { params, detectedResults, mae } = paramResults[rank]
    console.log(`\n┌─ #${rank + 1} MAE=${mae.toFixed(1)}% | aiFloor=${params.aiFloor} humanCeiling=${params.humanCeiling} boost=${params.boostThresh}/${params.boostFactor}/${params.boostMax} reduce=${params.reduceThresh}/${params.reduceFactor}/${params.reduceMax}`)
    for (const r of detectedResults) {
      const errH = Math.abs(r.detected.human - r.zhuque.human)
      const errS = Math.abs(r.detected.suspected - r.zhuque.suspected)
      const errA = Math.abs(r.detected.ai - r.zhuque.ai)
      const avg = (errH + errS + errA) / 3
      console.log(
        `│  ${r.name.padEnd(12)} 朱雀[人${r.zhuque.human.toFixed(0).padStart(4)} 疑${r.zhuque.suspected.toFixed(0).padStart(4)} AI${r.zhuque.ai.toFixed(0).padStart(4)}] ` +
        `检测[人${r.detected.human.toFixed(1).padStart(5)} 疑${r.detected.suspected.toFixed(1).padStart(5)} AI${r.detected.ai.toFixed(1).padStart(5)}] ` +
        `偏差=${avg.toFixed(1)}%`
      )
    }
    console.log(`└─ 加权MAE: ${mae.toFixed(1)}%`)
  }

  // 输出最优参数
  const best = paramResults[0]
  console.log('\n\n' + '═'.repeat(80))
  console.log('最优参数')
  console.log('═'.repeat(80))
  console.log(JSON.stringify(best.params, null, 2))
  console.log(`\n建议写入 constants.ts MODEL_THRESHOLD_OVERRIDES['qwen3.5-4b-q4']:`)
  console.log(`  baseline: { ppl: ${CALIBRATED_BASELINE.ppl.toFixed(2)}, top5: ${CALIBRATED_BASELINE.top5.toFixed(4)}, avgProb: ${CALIBRATED_BASELINE.avgProb.toFixed(4)} },`)
  console.log(`  classify: { aiFloor: ${best.params.aiFloor}, humanCeiling: ${best.params.humanCeiling} },`)
  console.log(`  docBias: {`)
  console.log(`    boostThreshold: ${best.params.boostThresh},`)
  console.log(`    boostFactor: ${best.params.boostFactor},`)
  console.log(`    boostMax: ${best.params.boostMax},`)
  console.log(`    reduceThreshold: ${best.params.reduceThresh},`)
  console.log(`    reduceFactor: ${best.params.reduceFactor},`)
  console.log(`    reduceMax: ${best.params.reduceMax},`)
  console.log(`  },`)

  const a3 = best.detectedResults.find(r => r.name === 'A3-mix')
  if (a3) {
    console.log(`\nA3 样本校验: 朱雀[疑${a3.zhuque.suspected} AI${a3.zhuque.ai}] → 检测[疑${a3.detected.suspected.toFixed(1)} AI${a3.detected.ai.toFixed(1)}]`)
  }

  await sequence.dispose()
  await context.dispose()
  await model.dispose()
  await llama.dispose()
}

main().catch(err => {
  console.error('运行失败:', err)
  process.exit(1)
})
