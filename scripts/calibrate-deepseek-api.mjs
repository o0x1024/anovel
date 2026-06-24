/**
 * DeepSeek API 校准脚本 — 对齐朱雀 AI 检测助手
 *
 * 注意：deepseek-v4-flash 云端 chat 复述 logprobs 全为 0，困惑度无效。
 * 本脚本先探测 logprobs；若退化则提示改用启发式校准：
 *   node scripts/calibrate-deepseek-heuristic.mjs
 *
 * 用法: DEEPSEEK_API_KEY=sk-xxx node scripts/calibrate-deepseek-api.mjs [model-name]
 */
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const API_BASE = 'https://api.deepseek.com/v1'
const MODEL_NAME = process.argv[2] || 'deepseek-v4-flash'
const API_KEY = process.env.DEEPSEEK_API_KEY

if (!API_KEY) {
  console.error('请设置环境变量 DEEPSEEK_API_KEY')
  process.exit(1)
}

const SAMPLES = [
  { name: 'A1', path: 'docs/mix-ai/A1.md', zhuque: { human: 46.4, suspected: 53.6, ai: 0 } },
  { name: 'A2', path: 'docs/mix-ai/A2.md', zhuque: { human: 0, suspected: 75.52, ai: 24.48 } },
  { name: 'A3', path: 'docs/mix-ai/A3.md', zhuque: { human: 0, suspected: 51.51, ai: 48.49 } },
  { name: 'B1', path: 'docs/mix-ai/B1.md', zhuque: { human: 0, suspected: 48.65, ai: 51.35 } },
  { name: 'C1', path: 'docs/mix-ai/C1.md', zhuque: { human: 0, suspected: 27.54, ai: 72.46 } },
  { name: 'D1', path: 'docs/mix-ai/D1.md', zhuque: { human: 0, suspected: 62.98, ai: 37.02 } },
  { name: 'E1', path: 'docs/mix-ai/E1.md', zhuque: { human: 0, suspected: 62.73, ai: 37.27 } },
]

function extractText(content) {
  return content.split('\n').slice(3).join('\n').trim()
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
      if (buffer.trim()) segments.push({ id: id++, text: buffer })
    }
  }
  return segments
}

async function computeSegmentChatRepeat(text) {
  const sampleText = text.slice(0, 300)
  const body = {
    model: MODEL_NAME,
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

  const response = await axios.post(`${API_BASE}/chat/completions`, body, {
    timeout: 90000,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`
    }
  })

  const logprobsData = response.data?.choices?.[0]?.logprobs?.content
  if (!logprobsData?.length) return null

  const validLogprobs = logprobsData
    .filter(item => item.logprob !== null)
    .map(item => item.logprob)
  if (validLogprobs.length === 0) return null

  const avgLogProb = validLogprobs.reduce((a, b) => a + b, 0) / validLogprobs.length
  const ppl = Math.exp(-avgLogProb)
  const avgProb = validLogprobs.reduce((a, lp) => a + Math.exp(lp), 0) / validLogprobs.length

  let top5Hits = 0
  for (const item of logprobsData) {
    if (item.top_logprobs?.length) {
      const topTokens = item.top_logprobs.map(t => t.token)
      if (topTokens.includes(item.token)) top5Hits++
    } else {
      top5Hits++
    }
  }
  const top5Rate = top5Hits / logprobsData.length

  return { ppl, tokenCount: logprobsData.length, top5Rate, avgProb, textLen: text.length }
}

const BASELINE = { ppl: 83, top5: 0.505, avgProb: 0.183 }
let CALIBRATED_BASELINE = { ...BASELINE }

function computeAiScore(ppl, top5Rate, avgProb, baseline = CALIBRATED_BASELINE) {
  const pplDev = (ppl - baseline.ppl) / baseline.ppl
  const top5Dev = (baseline.top5 - top5Rate) / baseline.top5
  const probDev = (baseline.avgProb - avgProb) / baseline.avgProb

  const signs = [Math.sign(pplDev), Math.sign(top5Dev), Math.sign(probDev)]
  const positives = signs.filter(s => s > 0).length
  const negatives = signs.filter(s => s < 0).length
  const coherence = Math.max(positives, negatives) / 3

  const mapDev = (d) => Math.min(95,
    d <= 0.3 ? d / 0.3 * 30 :
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
  if (new Set(openings).size / openings.length < 0.55 && sentences.length >= 8) boost += 5

  if (sentences.length >= 6) {
    let alternationCount = 0
    for (let i = 1; i < lengths.length; i++) {
      const prev = lengths[i - 1], curr = lengths[i]
      if ((prev < 8 && curr > 30) || (prev > 30 && curr < 8)) alternationCount++
    }
    if (alternationCount / (lengths.length - 1) > 0.12) boost += 8
  }

  const shortRatio = lengths.filter(l => l < 8).length / sentences.length
  const longRatio = lengths.filter(l => l > 40).length / sentences.length
  if (shortRatio > 0.18 && longRatio > 0.12 && sentences.length >= 8) boost += 6

  const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length
  const sentLenStd = Math.sqrt(lengths.reduce((s, l) => s + (l - avgLen) ** 2, 0) / lengths.length)
  if (sentLenStd < 5 && sentences.length >= 8) boost += 5

  return { heuristicAiBoost: Math.min(25, boost) }
}

const PARAM_GRID = []
for (const aiFloor of [50, 55, 58, 60, 65, 70, 75, 80]) {
  for (const humanCeiling of [18, 22, 25, 28, 32, 35]) {
    for (const boostFactor of [1.5, 2.0, 2.5, 2.8]) {
      for (const boostMax of [15, 20, 25, 28]) {
        PARAM_GRID.push({
          aiFloor,
          humanCeiling,
          boostThresh: 35,
          boostFactor,
          boostMax,
          reduceThresh: 25,
          reduceFactor: 1.2,
          reduceMax: 6,
        })
      }
    }
  }
}

async function main() {
  console.log(`模型: ${MODEL_NAME}`)
  console.log(`样本数: ${SAMPLES.length}`)
  console.log(`参数空间: ${PARAM_GRID.length} 组合\n`)

  const sampleData = []
  const humanMetricsRaw = []

  for (const sample of SAMPLES) {
    const filePath = path.join(projectRoot, sample.path)
    if (!fs.existsSync(filePath)) {
      console.warn(`跳过缺失样本: ${sample.path}`)
      continue
    }

    const text = extractText(fs.readFileSync(filePath, 'utf-8'))
    const segments = segmentText(text)
    console.log(`计算 ${sample.name} (${segments.length} 段, ${text.length} 字)…`)

    const fileMetrics = []
    for (let i = 0; i < segments.length; i++) {
      if (i % 3 === 0) process.stdout.write(`  段落 ${i + 1}/${segments.length}\r`)
      const metrics = await computeSegmentChatRepeat(segments[i].text)
      if (metrics) fileMetrics.push({ ...metrics, text: segments[i].text })
      await new Promise(r => setTimeout(r, 200))
    }
    console.log(`  → ${fileMetrics.length} 段有效指标`)

    const heuristic = computeHeuristicFeatures(text)
    if (sample.zhuque.human >= 40) {
      for (const m of fileMetrics) {
        if (m.tokenCount >= 5 && m.ppl > 0 && m.ppl < 400) humanMetricsRaw.push(m)
      }
    }

    sampleData.push({ sample, fileMetrics, heuristic, text })
  }

  console.log('\n基线校准（人工样本中位数）')
  if (humanMetricsRaw.length > 0) {
    const sortedPPL = humanMetricsRaw.map(r => r.ppl).sort((a, b) => a - b)
    const sortedTop5 = humanMetricsRaw.map(r => r.top5Rate).sort((a, b) => a - b)
    const sortedProb = humanMetricsRaw.map(r => r.avgProb).sort((a, b) => a - b)
    CALIBRATED_BASELINE = {
      ppl: sortedPPL[Math.floor(sortedPPL.length / 2)],
      top5: sortedTop5[Math.floor(sortedTop5.length / 2)],
      avgProb: sortedProb[Math.floor(sortedProb.length / 2)],
    }
    console.log(`  人工段数: ${humanMetricsRaw.length}`)
    console.log(`  新基线: PPL=${CALIBRATED_BASELINE.ppl.toFixed(2)}, Top5=${CALIBRATED_BASELINE.top5.toFixed(4)}, AvgProb=${CALIBRATED_BASELINE.avgProb.toFixed(4)}`)
  } else {
    console.warn('  无人工样本，使用默认基线')
  }

  for (const data of sampleData) {
    const scores = data.fileMetrics.map(m => {
      if (m.tokenCount < 3 || m.ppl === 0 || m.ppl >= 400) return 50
      return computeAiScore(m.ppl, m.top5Rate, m.avgProb)
    })
    data.scores = scores
    const valid = scores.filter((_, i) => data.fileMetrics[i].tokenCount >= 3)
    data.docScore = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 50
    console.log(`  ${data.sample.name}: docScore=${data.docScore.toFixed(1)} + heuristic=${data.heuristic.heuristicAiBoost}`)
  }

  console.log('\n参数网格搜索…\n')
  const paramResults = []

  for (const params of PARAM_GRID) {
    const detectedResults = []

    for (const { sample, fileMetrics, scores, heuristic } of sampleData) {
      const docScore = (scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 50) + heuristic.heuristicAiBoost
      const suspiciousCount = scores.filter(s => s >= 30).length
      const suspiciousRatio = scores.length ? suspiciousCount / scores.length : 0
      const consistencyBoost = suspiciousRatio > 0.55 ? (suspiciousRatio - 0.55) * 30 : 0
      const effectiveDocScore = docScore + consistencyBoost

      let effectiveAiFloor = params.aiFloor
      if (effectiveDocScore >= 50 && heuristic.heuristicAiBoost >= 8) {
        effectiveAiFloor = Math.max(params.aiFloor - 15, 50)
      } else if (effectiveDocScore >= 45) {
        effectiveAiFloor = Math.max(params.aiFloor - 8, 55)
      }

      let humanLen = 0, suspectedLen = 0, aiLen = 0
      for (let j = 0; j < fileMetrics.length; j++) {
        let adjustedScore = scores[j]
        if (fileMetrics[j].tokenCount < 10) adjustedScore = Math.min(adjustedScore, 55)

        if (effectiveDocScore >= params.boostThresh) {
          adjustedScore = Math.min(100, adjustedScore + Math.min(params.boostMax, (effectiveDocScore - params.boostThresh) * params.boostFactor))
        } else if (effectiveDocScore <= params.reduceThresh) {
          adjustedScore = Math.max(0, adjustedScore - Math.min(params.reduceMax, (params.reduceThresh - effectiveDocScore) * params.reduceFactor))
        }

        const cat = adjustedScore >= effectiveAiFloor ? 'ai'
          : adjustedScore <= params.humanCeiling ? 'human' : 'suspected_ai'

        const textLen = fileMetrics[j].textLen
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

    let totalError = 0, totalWeight = 0
    for (const r of detectedResults) {
      const avgErr = (Math.abs(r.detected.human - r.zhuque.human)
        + Math.abs(r.detected.suspected - r.zhuque.suspected)
        + Math.abs(r.detected.ai - r.zhuque.ai)) / 3
      const weight = r.zhuque.human >= 40 ? 2.0 : 1.0
      totalError += avgErr * weight
      totalWeight += weight
    }
    paramResults.push({ params, detectedResults, mae: totalError / totalWeight })
  }

  paramResults.sort((a, b) => a.mae - b.mae)

  console.log('═'.repeat(120))
  console.log('Top 5 参数组合')
  console.log('═'.repeat(120))
  for (let rank = 0; rank < Math.min(5, paramResults.length); rank++) {
    const { params, detectedResults, mae } = paramResults[rank]
    console.log(`\n#${rank + 1} MAE=${mae.toFixed(1)}% | aiFloor=${params.aiFloor} humanCeiling=${params.humanCeiling} boost=${params.boostThresh}/${params.boostFactor}/${params.boostMax}`)
    for (const r of detectedResults) {
      const avg = (Math.abs(r.detected.human - r.zhuque.human)
        + Math.abs(r.detected.suspected - r.zhuque.suspected)
        + Math.abs(r.detected.ai - r.zhuque.ai)) / 3
      console.log(
        `  ${r.name.padEnd(4)} 朱雀[人${r.zhuque.human.toFixed(0).padStart(3)} 疑${r.zhuque.suspected.toFixed(0).padStart(3)} AI${r.zhuque.ai.toFixed(0).padStart(3)}] ` +
        `检测[人${r.detected.human.toFixed(1).padStart(5)} 疑${r.detected.suspected.toFixed(1).padStart(5)} AI${r.detected.ai.toFixed(1).padStart(5)}] 偏差=${avg.toFixed(1)}`
      )
    }
  }

  const best = paramResults[0]
  console.log('\n\n最优参数:')
  console.log(JSON.stringify({
    model: MODEL_NAME,
    baseline: CALIBRATED_BASELINE,
    classify: { aiFloor: best.params.aiFloor, humanCeiling: best.params.humanCeiling },
    docBias: {
      boostThreshold: best.params.boostThresh,
      boostFactor: best.params.boostFactor,
      boostMax: best.params.boostMax,
      reduceThreshold: best.params.reduceThresh,
      reduceFactor: best.params.reduceFactor,
      reduceMax: best.params.reduceMax,
    },
    mae: best.mae,
  }, null, 2))
}

main().catch(err => {
  console.error('运行失败:', err)
  process.exit(1)
})
