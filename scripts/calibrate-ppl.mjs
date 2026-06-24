/**
 * PPL 校准脚本：直接用 node-llama-cpp 计算实验文本的困惑度分布
 * 现在增加 Token Rank 分析（检测 AI 文本的 token 选择模式）
 * 用法: node scripts/calibrate-ppl.mjs
 */
import { getLlama } from 'node-llama-cpp'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const MODEL_PATH = path.join(
  os.homedir(),
  'Library/Application Support/anovel/models/qwen2-0.5b-instruct-q4_k_m/qwen2-0_5b-instruct-q4_k_m.gguf'
)

const EXPERIMENT_FILES = [
  { name: 'A1-human', path: 'docs/experiments/A1-human.txt', expected: 'human' },
  { name: 'A2-ai', path: 'docs/experiments/A2-ai.txt', expected: 'ai' },
  { name: 'B1-ai-varied-sentlen', path: 'docs/experiments/B1-ai-varied-sentlen.txt', expected: 'ai' },
  { name: 'B2-human-uniform-sentlen', path: 'docs/experiments/B2-human-uniform-sentlen.txt', expected: 'human' },
  { name: 'E1-ai-colloquial-rewrite', path: 'docs/experiments/E1-ai-colloquial-rewrite.txt', expected: 'ai' },
  { name: 'E2-ai-with-errors', path: 'docs/experiments/E2-ai-with-errors.txt', expected: 'ai' },
  { name: 'G1-ai-combined-all', path: 'docs/experiments/G1-ai-combined-all.txt', expected: 'ai' },
  { name: 'H1-ai-lowfreq-vocab', path: 'docs/experiments/H1-ai-lowfreq-vocab-only.txt', expected: 'ai' },
  { name: 'H2-ai-no-punct-dialogue', path: 'docs/experiments/H2-ai-no-punctuation-dialogue.txt', expected: 'ai' },
  { name: 'H3-human-ai-interleave', path: 'docs/experiments/H3-mixed-human-ai-interleave.txt', expected: 'mixed' },
  { name: 'H4-ai-first-human-last', path: 'docs/experiments/H4-mixed-ai-first-human-last.txt', expected: 'mixed' },
  { name: 'H5-mixed-80ai-20human', path: 'docs/experiments/H5-mixed-80ai-20human.txt', expected: 'mixed' },
  { name: 'H6-ai-human-phrases', path: 'docs/experiments/H6-ai-with-human-phrases-woven.txt', expected: 'ai' },
  { name: 'I1-30human-70ai', path: 'docs/experiments/I1-30human-front-70ai.txt', expected: 'mixed' },
  { name: 'I2-15human-85ai', path: 'docs/experiments/I2-15human-front-85ai.txt', expected: 'mixed' },
  { name: 'J1-35pct-human-front', path: 'docs/experiments/J1-human-front-35pct-ai-raw.txt', expected: 'mixed' },
  { name: 'J2-seed-3lines-colloquial', path: 'docs/experiments/J2-human-seed-3lines-colloquial-ai.txt', expected: 'ai' },
  { name: 'J3-colloquial-no-seed', path: 'docs/experiments/J3-colloquial-rewrite-no-seed.txt', expected: 'ai' },
  { name: 'X1-AI', path: 'docs/experiments/X1-AI.txt', expected: 'ai' },
]

function segmentText(text) {
  const paragraphs = text.split(/\n/).map((p, idx, arr) => {
    return idx < arr.length - 1 ? p + '\n' : p
  })
  const segments = []
  let id = 0

  for (const para of paragraphs) {
    const trimmed = para.replace(/\n$/, '')
    if (!trimmed.trim()) continue

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
  let top1Matches = 0
  let top5Matches = 0
  let top10Matches = 0
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

      // 计算 token 在概率排名中的位置
      let rank = 0
      for (const [, p] of probMap) {
        if (p > prob) rank++
        else break
      }
      if (rank === 0) top1Matches++
      if (rank < 5) top5Matches++
      if (rank < 10) top10Matches++
    }
  }

  if (count === 0) return null

  const ppl = Math.exp(-sumLogProb / count)
  const avgProb = tokenProbs.reduce((a, b) => a + b, 0) / tokenProbs.length

  // 计算概率的标准差（衡量 token 选择的一致性）
  const probStd = Math.sqrt(
    tokenProbs.reduce((sum, p) => sum + Math.pow(p - avgProb, 2), 0) / tokenProbs.length
  )

  return {
    ppl,
    tokenCount: count,
    top1Rate: top1Matches / count,
    top5Rate: top5Matches / count,
    top10Rate: top10Matches / count,
    avgProb,
    probStd
  }
}

async function main() {
  if (!fs.existsSync(MODEL_PATH)) {
    console.error(`模型文件不存在: ${MODEL_PATH}`)
    process.exit(1)
  }

  console.log('正在加载模型…')
  const llama = await getLlama()
  const model = await llama.loadModel({ modelPath: MODEL_PATH })
  const context = await model.createContext({ contextSize: 2048 })
  const sequence = context.getSequence()
  console.log('模型加载完成\n')

  const allResults = []

  for (const file of EXPERIMENT_FILES) {
    const filePath = path.join(projectRoot, file.path)
    if (!fs.existsSync(filePath)) continue

    const text = fs.readFileSync(filePath, 'utf-8')
    const segments = segmentText(text)

    console.log(`\n${'='.repeat(70)}`)
    console.log(`文件: ${file.name} | 预期: ${file.expected} | 段落: ${segments.length}`)
    console.log(`${'='.repeat(70)}`)
    console.log(`${'Seg'.padStart(3)} | ${'PPL'.padStart(8)} | ${'Top1%'.padStart(6)} | ${'Top5%'.padStart(6)} | ${'Top10%'.padStart(7)} | ${'AvgP'.padStart(6)} | 文本`)
    console.log(`${'-'.repeat(70)}`)

    const fileMetrics = []
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const metrics = await computeSegmentMetrics(sequence, model, seg.text)
      if (!metrics) continue

      fileMetrics.push(metrics)
      const preview = seg.text.slice(0, 25).replace(/\n/g, ' ')
      console.log(
        `${i.toString().padStart(3)} | ` +
        `${metrics.ppl.toFixed(1).padStart(8)} | ` +
        `${(metrics.top1Rate * 100).toFixed(1).padStart(5)}% | ` +
        `${(metrics.top5Rate * 100).toFixed(1).padStart(5)}% | ` +
        `${(metrics.top10Rate * 100).toFixed(1).padStart(6)}% | ` +
        `${metrics.avgProb.toFixed(3).padStart(6)} | ` +
        `${preview}…`
      )
    }

    // 过滤掉极端段落（PPL > 400 通常是极短对话/感叹词）
    const meaningful = fileMetrics.filter(m => m.ppl < 400 && m.tokenCount >= 5)

    const avgPPL = meaningful.reduce((a, m) => a + m.ppl, 0) / meaningful.length
    const avgTop1 = meaningful.reduce((a, m) => a + m.top1Rate, 0) / meaningful.length
    const avgTop5 = meaningful.reduce((a, m) => a + m.top5Rate, 0) / meaningful.length
    const avgTop10 = meaningful.reduce((a, m) => a + m.top10Rate, 0) / meaningful.length
    const avgAvgProb = meaningful.reduce((a, m) => a + m.avgProb, 0) / meaningful.length

    // 计算 PPL 的变异系数（人类文本变异更大）
    const pplStd = Math.sqrt(meaningful.reduce((s, m) => s + Math.pow(m.ppl - avgPPL, 2), 0) / meaningful.length)
    const pplCV = pplStd / avgPPL

    console.log(`\n  ┌─ 整体统计 (过滤极端值后, ${meaningful.length}段) ─┐`)
    console.log(`  │ 平均PPL:     ${avgPPL.toFixed(2)}`)
    console.log(`  │ PPL变异系数: ${pplCV.toFixed(3)} (越大=越不均匀)`)
    console.log(`  │ Top-1命中率: ${(avgTop1 * 100).toFixed(2)}%`)
    console.log(`  │ Top-5命中率: ${(avgTop5 * 100).toFixed(2)}%`)
    console.log(`  │ Top-10命中率: ${(avgTop10 * 100).toFixed(2)}%`)
    console.log(`  │ 平均概率:    ${avgAvgProb.toFixed(4)}`)
    console.log(`  └──────────────────────────────────┘`)

    allResults.push({ name: file.name, expected: file.expected, avgPPL, avgTop1, avgTop5, avgTop10, pplCV, avgAvgProb, meaningful })
  }

  console.log('\n\n' + '='.repeat(70))
  console.log('对比摘要')
  console.log('='.repeat(70))
  console.log(`${'指标'.padEnd(18)} | ${'Human'.padStart(10)} | ${'AI'.padStart(10)} | 判别方向`)
  console.log('-'.repeat(70))
  if (allResults.length >= 2) {
    const h = allResults[0], a = allResults[1]
    console.log(`${'平均PPL'.padEnd(16)} | ${h.avgPPL.toFixed(2).padStart(10)} | ${a.avgPPL.toFixed(2).padStart(10)} | ${h.avgPPL < a.avgPPL ? 'Human更低' : 'AI更低'}`)
    console.log(`${'PPL变异系数'.padEnd(14)} | ${h.pplCV.toFixed(3).padStart(10)} | ${a.pplCV.toFixed(3).padStart(10)} | ${h.pplCV > a.pplCV ? 'Human更大' : 'AI更大'}`)
    console.log(`${'Top-1命中率'.padEnd(14)} | ${(h.avgTop1*100).toFixed(2).padStart(9)}% | ${(a.avgTop1*100).toFixed(2).padStart(9)}% | ${h.avgTop1 > a.avgTop1 ? 'Human更高' : 'AI更高'}`)
    console.log(`${'Top-5命中率'.padEnd(14)} | ${(h.avgTop5*100).toFixed(2).padStart(9)}% | ${(a.avgTop5*100).toFixed(2).padStart(9)}% | ${h.avgTop5 > a.avgTop5 ? 'Human更高' : 'AI更高'}`)
    console.log(`${'Top-10命中率'.padEnd(13)} | ${(h.avgTop10*100).toFixed(2).padStart(9)}% | ${(a.avgTop10*100).toFixed(2).padStart(9)}% | ${h.avgTop10 > a.avgTop10 ? 'Human更高' : 'AI更高'}`)
    console.log(`${'平均概率'.padEnd(16)} | ${h.avgAvgProb.toFixed(4).padStart(10)} | ${a.avgAvgProb.toFixed(4).padStart(10)} | ${h.avgAvgProb > a.avgAvgProb ? 'Human更高' : 'AI更高'}`)
  }

  // ========== 完整检测逻辑 V3：方向一致性 + 双向 ==========
  // 人类基线参数
  const BASELINE = {
    ppl: 83,        // 人类 PPL 中心
    top5: 0.505,    // 人类 Top-5 中心
    avgProb: 0.183, // 人类 AvgProb 中心
  }

  // 方向一致性评分：
  // 核心观察：AI模仿型 → PPL低、Top5高、AvgProb高 (全部偏"可预测")
  //          AI创意型 → PPL高、Top5低、AvgProb低 (全部偏"不可预测")
  //          人类文本 → 三指标方向不一致，散落在基线附近
  function computeV3Score(ppl, top5Rate, avgProb) {
    // 1. 计算各维度的标准化有符号偏差 (正=偏AI方向)
    // 对于PPL：偏离中心 → 可疑 (取绝对值但区分方向)
    // "可预测方向": PPL低、Top5高、AvgProb高
    // "创意方向":   PPL高、Top5低、AvgProb低
    
    // PPL 偏差 (向两个方向偏离都可疑)
    const pplDev = (ppl - BASELINE.ppl) / BASELINE.ppl  // 正=偏高(创意), 负=偏低(模仿)
    
    // Top5 偏差 (方向与 PPL 相反才一致)
    const top5Dev = (BASELINE.top5 - top5Rate) / BASELINE.top5  // 正=偏低(创意), 负=偏高(模仿)
    
    // AvgProb 偏差 (方向与 Top5 一致)
    const probDev = (BASELINE.avgProb - avgProb) / BASELINE.avgProb  // 正=偏低(创意), 负=偏高(模仿)

    // 2. 判断方向一致性
    // 如果三个偏差同号（全正=创意AI，全负=模仿AI），方向一致 → 可疑
    const signs = [Math.sign(pplDev), Math.sign(top5Dev), Math.sign(probDev)]
    const positives = signs.filter(s => s > 0).length
    const negatives = signs.filter(s => s < 0).length
    const coherence = Math.max(positives, negatives) / 3  // 1.0=完全一致, 0.33=完全不一致

    // 3. 计算各维度的绝对偏离分数（映射到 0-100）
    const absPplDev = Math.abs(pplDev)
    const absTop5Dev = Math.abs(top5Dev)
    const absProbDev = Math.abs(probDev)

    // 偏离映射：0偏离→0分, 0.3偏离→30分, 0.7偏离→60分, 1.0+偏离→85分
    const mapDev = (d) => Math.min(95, d <= 0.3 ? d / 0.3 * 30 : 
      d <= 0.7 ? 30 + (d - 0.3) / 0.4 * 30 :
      60 + (d - 0.7) / 0.5 * 25)

    const pplScore = mapDev(absPplDev)
    const top5Score = mapDev(absTop5Dev)
    const probScore = mapDev(absProbDev)

    // 4. 基础分 = 加权平均
    const baseScore = pplScore * 0.40 + top5Score * 0.35 + probScore * 0.25

    // 5. 方向一致性加成：方向一致 → 更可能是AI
    const coherenceMultiplier = 0.7 + coherence * 0.6  // 范围 [0.9, 1.3]
    
    return Math.min(100, baseScore * coherenceMultiplier)
  }

  function classify(score) {
    if (score >= 50) return 'ai'
    if (score <= 28) return 'human'
    return 'suspected_ai'
  }

  function computeHeuristicFeatures(text) {
    const sentences = text.split(/[。！？；…]+/).filter(s => s.trim().length > 2)
    if (sentences.length < 3) return { heuristicAiBoost: 0, details: '句子过少' }

    const lengths = sentences.map(s => s.trim().length)
    let boost = 0
    const markers = []

    // TTR
    const chars = text.replace(/[，。！？、；：""''（）\s\n]/g, '')
    const uniqueChars = new Set(chars).size
    const ttr = uniqueChars / Math.min(chars.length, 500)
    if (ttr < 0.40 && chars.length > 200) {
      boost += 4
      markers.push(`TTR=${ttr.toFixed(3)}`)
    }

    // 句首重复率
    const openings = sentences.map(s => s.trim().slice(0, 2))
    const uniqueOpenings = new Set(openings).size
    const openingDiversity = uniqueOpenings / openings.length
    if (openingDiversity < 0.55 && sentences.length >= 8) {
      boost += 5
      markers.push(`句首重复=${(1 - openingDiversity).toFixed(2)}`)
    }

    // 短长句交替
    if (sentences.length >= 6) {
      let alternationCount = 0
      for (let i = 1; i < lengths.length; i++) {
        const prev = lengths[i - 1]
        const curr = lengths[i]
        if ((prev < 8 && curr > 30) || (prev > 30 && curr < 8)) alternationCount++
      }
      const alternationRate = alternationCount / (lengths.length - 1)
      if (alternationRate > 0.12) {
        boost += 8
        markers.push(`交替率=${alternationRate.toFixed(2)}`)
      }
    }

    // 句长两极化
    const shortSents = lengths.filter(l => l < 8).length
    const longSents = lengths.filter(l => l > 40).length
    const shortRatio = shortSents / sentences.length
    const longRatio = longSents / sentences.length
    if (shortRatio > 0.18 && longRatio > 0.12 && sentences.length >= 8) {
      boost += 6
      markers.push(`两极化: 短${(shortRatio * 100).toFixed(0)}%+长${(longRatio * 100).toFixed(0)}%`)
    }

    // 句长标准差极小（过于均匀 → 疑似改写）
    const avgLen = lengths.reduce((a, b) => a + b, 0) / lengths.length
    const sentLenStd = Math.sqrt(lengths.reduce((s, l) => s + Math.pow(l - avgLen, 2), 0) / lengths.length)
    if (sentLenStd < 5 && sentences.length >= 8) {
      boost += 5
      markers.push(`句长过均匀std=${sentLenStd.toFixed(1)}`)
    }

    return { heuristicAiBoost: Math.min(20, boost), details: markers.length > 0 ? markers.join(', ') : '无' }
  }

  // ========== 运行检测并收集结果 ==========
  console.log('\n\n' + '='.repeat(90))
  console.log('全面检测结果 (V3 方向一致性 + 双向偏离)')
  console.log('='.repeat(90))

  const tableRows = []

  for (const result of allResults) {
    const filePath = path.join(projectRoot, EXPERIMENT_FILES.find(f => f.name === result.name)?.path || '')
    const originalText = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : ''
    const heuristic = computeHeuristicFeatures(originalText)

    const scores = result.meaningful.map(m => computeV3Score(m.ppl, m.top5Rate, m.avgProb))
    const rawDocScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 50
    const docScore = rawDocScore + heuristic.heuristicAiBoost

    let humanLen = 0, suspectedLen = 0, aiLen = 0

    for (let j = 0; j < result.meaningful.length; j++) {
      let adjustedScore = scores[j]
      // 文档级偏置
      if (docScore >= 40) {
        const boost = Math.min(20, (docScore - 40) * 2.0)
        adjustedScore = Math.min(100, adjustedScore + boost)
      } else if (docScore <= 35) {
        const reduction = Math.min(12, (35 - docScore) * 2.5)
        adjustedScore = Math.max(0, adjustedScore - reduction)
      }
      const cat = classify(adjustedScore)
      const textLen = result.meaningful[j].tokenCount * 2
      if (cat === 'human') humanLen += textLen
      else if (cat === 'ai') aiLen += textLen
      else suspectedLen += textLen
    }

    const totalLen = humanLen + suspectedLen + aiLen
    const humanPct = totalLen > 0 ? (humanLen / totalLen * 100).toFixed(1) : '0.0'
    const suspectedPct = totalLen > 0 ? (suspectedLen / totalLen * 100).toFixed(1) : '0.0'
    const aiPct = totalLen > 0 ? (aiLen / totalLen * 100).toFixed(1) : '0.0'

    tableRows.push({
      name: result.name,
      expected: result.expected,
      humanPct, suspectedPct, aiPct,
      docScore: docScore.toFixed(1),
      rawDocScore: rawDocScore.toFixed(1),
      hBoost: heuristic.heuristicAiBoost,
      hDetails: heuristic.details,
      avgPPL: result.avgPPL.toFixed(1),
      avgTop5: (result.avgTop5 * 100).toFixed(1)
    })
  }

  // 输出表格
  console.log('')
  const header = `${'文件名'.padEnd(28)} | ${'预期'.padEnd(6)} | ${'人工%'.padStart(6)} | ${'疑似%'.padStart(6)} | ${'AI%'.padStart(6)} | ${'原始'.padStart(5)} | ${'文档分'.padStart(6)} | 特征`
  console.log(header)
  console.log('-'.repeat(110))
  for (const r of tableRows) {
    console.log(
      `${r.name.padEnd(28)} | ${r.expected.padEnd(6)} | ${r.humanPct.padStart(6)} | ${r.suspectedPct.padStart(6)} | ${r.aiPct.padStart(6)} | ${r.rawDocScore.padStart(5)} | ${r.docScore.padStart(6)} | ${r.hDetails}`
    )
  }

  // 判定准确性
  console.log('\n\n' + '='.repeat(90))
  console.log('准确性评估')
  console.log('='.repeat(90))
  let correct = 0, total = tableRows.length
  for (const r of tableRows) {
    const human = parseFloat(r.humanPct)
    const suspected = parseFloat(r.suspectedPct)
    const ai = parseFloat(r.aiPct)
    let verdict = ''
    if (r.expected === 'human') {
      verdict = human >= 60 ? '✓ 正确' : (human >= 30 ? '△ 部分正确' : '✗ 错误')
      if (human >= 60) correct++
    } else if (r.expected === 'ai') {
      const aiTotal = suspected + ai
      verdict = aiTotal >= 80 ? '✓ 正确' : (aiTotal >= 50 ? '△ 部分正确' : '✗ 错误')
      if (aiTotal >= 80) correct++
    } else {
      verdict = (human > 10 && (suspected + ai) > 10) ? '✓ 正确' : '△ 部分正确'
      if (human > 10 && (suspected + ai) > 10) correct++
    }
    console.log(`  ${r.name.padEnd(28)} [${r.expected.padEnd(6)}] → 人工${r.humanPct}% 疑似${r.suspectedPct}% AI${r.aiPct}% ${verdict}`)
  }
  console.log(`\n  总体准确率: ${correct}/${total} (${(correct/total*100).toFixed(1)}%)`)

  await sequence.dispose()
  await context.dispose()
  await model.dispose()
  await llama.dispose()
}

main().catch(err => {
  console.error('运行失败:', err)
  process.exit(1)
})
