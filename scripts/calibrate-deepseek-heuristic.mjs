/**
 * deepseek-v4-flash API 启发式校准（logprobs 退化时）
 * 用法: node scripts/calibrate-deepseek-heuristic.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

const SAMPLES = [
  { name: 'A1', path: 'docs/mix-ai/A1.md', zhuque: { human: 46.4, suspected: 53.6, ai: 0 } },
  { name: 'A2', path: 'docs/mix-ai/A2.md', zhuque: { human: 0, suspected: 75.52, ai: 24.48 } },
  { name: 'A3', path: 'docs/mix-ai/A3.md', zhuque: { human: 0, suspected: 51.51, ai: 48.49 } },
  { name: 'B1', path: 'docs/mix-ai/B1.md', zhuque: { human: 0, suspected: 48.65, ai: 51.35 } },
  { name: 'C1', path: 'docs/mix-ai/C1.md', zhuque: { human: 0, suspected: 27.54, ai: 72.46 } },
  { name: 'D1', path: 'docs/mix-ai/D1.md', zhuque: { human: 0, suspected: 62.98, ai: 37.02 } },
  { name: 'E1', path: 'docs/mix-ai/E1.md', zhuque: { human: 0, suspected: 62.73, ai: 37.27 } },
]

const CONNECTOR_REGEX = /(然而|因此|此外|同时|不禁|仿佛|与此同时|值得注意的是|不难发现|由此可见|换言之|总而言之|不仅如此|尽管如此)/g

function computeStd(values) {
  if (!values.length) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length)
}

function splitSentenceUnits(text) {
  const units = []
  let start = 0
  const breaks = new Set(['。', '！', '？', '!', '?', ';', '；', '\n'])
  const trailing = new Set(['"', "'", '”', '’', '）', '】', '》', '」', '』'])
  for (let i = 0; i < text.length; i++) {
    if (breaks.has(text[i])) {
      let end = i + 1
      while (end < text.length && trailing.has(text[end])) end++
      units.push(text.slice(start, end))
      start = end
    }
  }
  if (start < text.length) units.push(text.slice(start))
  return units
}

function computeDocMetrics(text) {
  const sentenceUnits = splitSentenceUnits(text).map(u => u.trim()).filter(Boolean)
  const sentenceLens = sentenceUnits.map(s => s.length)
  const sentenceStd = computeStd(sentenceLens)
  let adjacentChangeRate = 0
  if (sentenceLens.length > 1) {
    let changed = 0
    for (let i = 1; i < sentenceLens.length; i++) {
      const prev = sentenceLens[i - 1]
      const curr = sentenceLens[i]
      if (Math.abs(curr - prev) / Math.max(prev, curr, 1) >= 0.5) changed++
    }
    adjacentChangeRate = changed / (sentenceLens.length - 1)
  }
  const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(Boolean)
  const paragraphLens = paragraphs.map(p => p.length)
  const paragraphMean = paragraphLens.length ? paragraphLens.reduce((a, b) => a + b, 0) / paragraphLens.length : 0
  const paragraphCv = paragraphMean > 0 ? computeStd(paragraphLens) / paragraphMean : 0
  return { sentenceStd, adjacentChangeRate, paragraphCv }
}

function computeHeuristicScore(text, docMetrics, baseScore) {
  const sentences = splitSentenceUnits(text).map(u => u.trim()).filter(Boolean)
  const sentenceLens = sentences.map(s => s.length)
  const sentenceCount = Math.max(1, sentences.length)
  const avgLen = sentenceLens.length ? sentenceLens.reduce((a, b) => a + b, 0) / sentenceLens.length : text.length
  const connectorHits = (text.match(CONNECTOR_REGEX) || []).length
  const connectorDensity = connectorHits / sentenceCount
  const quoteHits = (text.match(/[“”"'‘’]/g) || []).length
  const quoteRatio = quoteHits / Math.max(1, text.length)
  const localStd = computeStd(sentenceLens)
  let localAdjacentChangeRate = 0
  if (sentenceLens.length > 1) {
    let changed = 0
    for (let i = 1; i < sentenceLens.length; i++) {
      const prev = sentenceLens[i - 1]
      const curr = sentenceLens[i]
      if (Math.abs(curr - prev) / Math.max(prev, curr, 1) >= 0.5) changed++
    }
    localAdjacentChangeRate = changed / (sentenceLens.length - 1)
  }
  const shortSentenceRatio = sentenceLens.filter(len => len <= 10).length / sentenceCount
  const oralNoiseHits = (text.match(/[？！…—]|(嗯|啊|诶|欸|唉|哈)\b/g) || []).length

  let score = baseScore
  if (connectorDensity > 0.2) score += 14
  else if (connectorDensity > 0.1) score += 8
  else if (connectorDensity > 0.05) score += 3
  if (avgLen >= 20 && avgLen <= 42) score += 4
  else if (avgLen < 10) score -= 2
  if (quoteRatio < 0.004) score += 4
  else if (quoteRatio > 0.035) score -= 3
  if (/(仿佛|宛如|犹如|与此同时|值得注意的是|不难发现|由此可见|总而言之)/.test(text)) score += 10
  if (localStd < 5) score += 8
  else if (localStd < 8) score += 4
  else if (localStd > 18) score -= 5
  if (localAdjacentChangeRate < 0.2) score += 6
  else if (localAdjacentChangeRate > 0.5) score -= 5
  if (shortSentenceRatio > 0.55) score -= 3
  else if (shortSentenceRatio < 0.08) score += 4
  if (oralNoiseHits >= 4) score -= 2
  if (docMetrics.sentenceStd < 7) score += 2
  if (docMetrics.adjacentChangeRate < 0.18) score += 2
  if (docMetrics.paragraphCv < 0.3) score += 2
  if (docMetrics.sentenceStd > 14) score -= 3
  if (docMetrics.adjacentChangeRate > 0.4) score -= 3
  if (docMetrics.paragraphCv > 0.6) score -= 3
  return Math.max(0, Math.min(100, Math.round(score)))
}

function segmentText(text) {
  const paragraphs = text.split(/\n/).filter(p => p.trim())
  const segments = []
  let id = 0
  for (const para of paragraphs) {
    const trimmed = para.trim()
    if (!trimmed) continue
    const sentences = trimmed.split(/(?<=[。！？；…」』）])/g).filter(s => s.trim().length > 3)
    if (sentences.length <= 2) segments.push({ id: id++, text: trimmed })
    else {
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

const sampleData = SAMPLES.map(sample => {
  const text = fs.readFileSync(path.join(projectRoot, sample.path), 'utf-8').split('\n').slice(3).join('\n').trim()
  const docMetrics = computeDocMetrics(text)
  const segments = segmentText(text)
  return { sample, text, docMetrics, segments }
})

const PARAM_GRID = []
for (const baseScore of [52, 55, 58, 60, 62, 65]) {
  for (const humanCeiling of [42, 45, 48, 50, 52, 55]) {
    for (const aiFloor of [68, 72, 75, 78, 80]) {
      for (const boostThresh of [55, 60, 65, 68]) {
        for (const boostFactor of [0.8, 1.0, 1.2]) {
          PARAM_GRID.push({ baseScore, humanCeiling, aiFloor, boostThresh, boostFactor, boostMax: 12, reduceThresh: 48, reduceFactor: 1.0, reduceMax: 8 })
        }
      }
    }
  }
}

console.log(`参数空间: ${PARAM_GRID.length}`)

const results = []
for (const params of PARAM_GRID) {
  const detectedResults = []
  for (const { sample, text, docMetrics, segments } of sampleData) {
    const scores = segments.map(seg => computeHeuristicScore(seg.text, docMetrics, params.baseScore))
    const docScore = scores.reduce((a, b) => a + b, 0) / scores.length

    let humanLen = 0, suspectedLen = 0, aiLen = 0
    for (let i = 0; i < segments.length; i++) {
      let adjusted = scores[i]
      if (docScore >= params.boostThresh) {
        adjusted = Math.min(100, adjusted + Math.min(params.boostMax, (docScore - params.boostThresh) * params.boostFactor))
      } else if (docScore <= params.reduceThresh) {
        adjusted = Math.max(0, adjusted - Math.min(params.reduceMax, (params.reduceThresh - docScore) * params.reduceFactor))
      }
      const cat = adjusted >= params.aiFloor ? 'ai'
        : adjusted <= params.humanCeiling ? 'human' : 'suspected_ai'
      const len = segments[i].text.length
      if (cat === 'human') humanLen += len
      else if (cat === 'ai') aiLen += len
      else suspectedLen += len
    }
    const total = humanLen + suspectedLen + aiLen
    detectedResults.push({
      name: sample.name,
      zhuque: sample.zhuque,
      detected: {
        human: total ? humanLen / total * 100 : 0,
        suspected: total ? suspectedLen / total * 100 : 0,
        ai: total ? aiLen / total * 100 : 0,
      }
    })
  }

  let err = 0, weight = 0
  for (const r of detectedResults) {
    const avgErr = (Math.abs(r.detected.human - r.zhuque.human)
      + Math.abs(r.detected.suspected - r.zhuque.suspected)
      + Math.abs(r.detected.ai - r.zhuque.ai)) / 3
    const w = r.zhuque.human >= 40 ? 2 : 1
    err += avgErr * w
    weight += w
  }
  results.push({ params, detectedResults, mae: err / weight })
}

results.sort((a, b) => a.mae - b.mae)

for (let i = 0; i < Math.min(5, results.length); i++) {
  const { params, detectedResults, mae } = results[i]
  console.log(`\n#${i + 1} MAE=${mae.toFixed(1)} base=${params.baseScore} humanCeiling=${params.humanCeiling} aiFloor=${params.aiFloor} boost=${params.boostThresh}/${params.boostFactor}`)
  for (const r of detectedResults) {
    const avg = (Math.abs(r.detected.human - r.zhuque.human)
      + Math.abs(r.detected.suspected - r.zhuque.suspected)
      + Math.abs(r.detected.ai - r.zhuque.ai)) / 3
    console.log(`  ${r.name} 朱雀[人${r.zhuque.human.toFixed(0)} 疑${r.zhuque.suspected.toFixed(0)} AI${r.zhuque.ai.toFixed(0)}] 检测[人${r.detected.human.toFixed(1)} 疑${r.detected.suspected.toFixed(1)} AI${r.detected.ai.toFixed(1)}] 偏差=${avg.toFixed(1)}`)
  }
}

console.log('\n最优:', JSON.stringify(results[0].params, null, 2))
console.log('MAE:', results[0].mae.toFixed(1))
