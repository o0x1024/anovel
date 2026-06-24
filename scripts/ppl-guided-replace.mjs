/**
 * PPL 引导的精准高概率 bigram 替换
 *
 * 思路：用本地模型计算文本中每个 token 的预测概率，
 * 找出概率最高的内容词（AI 最可预测的词），用同义词替换。
 * 用最少的修改量达到最大的概率分布偏移。
 *
 * 用法:
 *   node scripts/ppl-guided-replace.mjs [--model path] [--density 0.3] [--analyze-only]
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

// ── 同义替换词表（扩展版，覆盖常见双字实词） ──

const SYNONYM_TABLE = new Map([
  // 动词（仅独立出现时安全的替换）
  ['看着', ['瞧着', '望着', '盯着', '瞅着']],
  ['走进', ['踏进', '迈进', '进了']],
  ['走出', ['出了', '迈出', '踏出']],
  ['站着', ['杵着', '立着', '戳着']],
  ['站在', ['立在', '停在']],
  ['坐在', ['窝在', '待在']],
  ['坐下', ['落座', '坐定']],
  ['放在', ['搁在', '摆在']],
  ['放下', ['搁下', '撂下']],
  ['拿起', ['抄起', '捡起', '提起']],
  ['拿着', ['握着', '捏着', '攥着', '端着']],
  ['关上', ['带上', '阖上', '合上']],
  ['回头', ['扭头', '转头', '回过头']],
  ['抬头', ['仰头', '昂头', '抬起头']],
  ['低头', ['埋头', '垂头', '低下头']],
  ['转身', ['扭身', '回身', '转过身']],
  ['发现', ['发觉', '察觉', '留意到']],
  ['觉得', ['感觉', '只觉']],
  ['知道', ['晓得', '清楚', '明白']],
  ['说道', ['开口道', '出声道']],
  ['问道', ['开口问', '追问']],
  ['笑道', ['笑着说', '笑了笑说']],
  ['想到', ['念及', '想起', '忆起']],
  ['看到', ['瞥见', '瞧见', '望见']],
  ['听到', ['听见', '闻见']],
  ['来到', ['赶到', '到了']],
  ['跑到', ['奔到', '蹿到', '赶到']],
  ['推开', ['拨开', '搡开']],
  ['伸出', ['探出', '递出']],
  ['接过', ['接了', '取过']],
  // 名词
  ['声音', ['嗓音', '动静', '声儿']],
  ['脸上', ['面上', '面庞上']],
  ['手里', ['手上', '手中']],
  ['门口', ['门前', '门边']],
  ['旁边', ['边上', '一旁', '跟前']],
  ['前面', ['前头', '前边']],
  ['后面', ['后头', '身后']],
  ['里面', ['里头', '内里']],
  ['外面', ['外头', '外边']],
  ['地方', ['地儿', '位置']],
  ['东西', ['物件', '玩意儿']],
  ['时候', ['时节', '当口']],
  ['样子', ['模样', '架势']],
  ['孩子', ['娃子', '小家伙']],
  ['衣服', ['衣裳', '穿戴']],
  // 副词/形容词（仅语义安全的替换）
  ['突然', ['冷不丁', '猛地', '忽然']],
  ['已经', ['早已', '早就']],
  ['终于', ['总算', '可算']],
  ['马上', ['赶紧', '立刻', '当即']],
  ['慢慢', ['渐渐', '徐徐']],
  ['轻轻', ['悄悄', '柔柔']],
  ['非常', ['十分', '极为', '格外']],
  ['一些', ['几分', '些许']],
  ['好像', ['仿佛', '似乎', '像是']],
  ['但是', ['可是', '不过', '然而']],
  ['虽然', ['尽管', '纵使']],
  ['一直', ['始终', '一路', '一径']],
  ['还是', ['依旧', '仍然', '依然']],
  ['这时', ['这会儿', '这当口']],
  ['那时', ['那会儿', '那阵子']],
  ['赶紧', ['连忙', '急忙', '赶忙']],
  ['不过', ['只是', '然而']],
  ['果然', ['果真', '当真']],
  ['忽然', ['突然', '冷不丁', '猛地']],
  ['仔细', ['细细', '用心']],
  ['立刻', ['当即', '即刻']],
  ['大约', ['约莫', '差不多']],
  ['似乎', ['好像', '像是', '仿佛']],
  ['只是', ['不过', '只不过']],
  ['于是', ['随后', '接着']],
  ['然后', ['随后', '之后', '接着']],
  ['一会儿', ['片刻', '一阵子']],
  ['显然', ['分明', '看得出']],
  // 安全的动补结构（不会误切语素）
  ['说完', ['说罢', '言毕']],
  ['做完', ['做罢', '弄完']],
  ['走完', ['走遍', '走到头']],
])

// ── 模型加载与 token 概率计算 ──

async function computeTokenProbs(sequence, model, text) {
  let tokens = model.tokenize(text)
  if (tokens.length < 4) return []
  if (tokens.length > 3800) tokens = tokens.slice(0, 3800)

  await sequence.clearHistory()

  const BATCH_SIZE = 200
  const results = []

  for (let bStart = 0; bStart < tokens.length - 1; bStart += BATCH_SIZE) {
    const bEnd = Math.min(bStart + BATCH_SIZE, tokens.length - 1)
    const input = tokens.slice(bStart, bEnd + 1).map((token, i) => {
      if (bStart + i < bEnd) return [token, { generateNext: { probabilities: true } }]
      return token
    })

    const outputs = await sequence.controlledEvaluate(input)

    for (let i = 0; i < bEnd - bStart; i++) {
      const output = outputs[i]
      const nextToken = tokens[bStart + i + 1]
      const tokenText = model.detokenize([nextToken])
      if (!output?.next?.probabilities) {
        results.push({ token: nextToken, text: tokenText, prob: 0, inTop5: false })
        continue
      }
      const prob = output.next.probabilities.get(nextToken) ?? 0
      let rank = 0
      if (prob > 0) {
        for (const [, p] of output.next.probabilities) {
          if (p > prob) rank++
          if (rank >= 5) break
        }
      }
      results.push({ token: nextToken, text: tokenText, prob, inTop5: rank < 5 })
    }
  }

  return results
}

function mapTokensToText(text, tokenProbs) {
  const charProbs = new Array(text.length).fill(0)
  let pos = 0

  // 第一个 token 从 tokenize 推断
  // tokenProbs[0] 对应 text 中 token[1] 的概率
  // 需要从头重建映射
  // 简化：逐 token 拼接，记录每个字符对应的概率
  for (const tp of tokenProbs) {
    const tLen = tp.text.length
    for (let j = 0; j < tLen && pos + j < text.length; j++) {
      charProbs[pos + j] = tp.prob
    }
    pos += tLen
  }

  return charProbs
}

const PROTECTED_COMPOUNDS = new Set([
  '小时候', '什么样', '怎么样', '怎么说', '怎么办',
  '什么事', '什么人', '为什么', '在那里', '在这里',
  '到那里', '到这里', '从那里', '从这里',
])

function isSafeReplacement(text, start, end, word) {
  // V了V 模式：如 "看了看", "想了想"
  if (word.length === 2 && word[1] === '了') {
    const charAfter = text[end]
    if (charAfter === word[0]) return false
  }
  // V一V 模式：如 "看一看"
  if (word.length === 2 && word[1] === '一') {
    const charAfter = text[end]
    if (charAfter === word[0]) return false
  }
  // 检查是否属于受保护的复合词
  const window = text.slice(Math.max(0, start - 2), end + 2)
  for (const comp of PROTECTED_COMPOUNDS) {
    if (window.includes(comp) && comp.includes(word) && comp !== word) return false
  }
  return true
}

function findReplaceCandidates(text, charProbs, density) {
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  const words = []

  for (const seg of segmenter.segment(text)) {
    if (!seg.isWordLike || seg.segment.length < 2) continue

    const start = seg.index
    const end = start + seg.segment.length
    let maxProb = 0
    for (let i = start; i < end && i < charProbs.length; i++) {
      maxProb = Math.max(maxProb, charProbs[i])
    }

    const synonyms = SYNONYM_TABLE.get(seg.segment)
    if (!synonyms || synonyms.length === 0) continue
    if (!isSafeReplacement(text, start, end, seg.segment)) continue

    words.push({ word: seg.segment, start, end, maxProb, synonyms })
  }

  words.sort((a, b) => b.maxProb - a.maxProb)

  const targetCount = Math.ceil(words.length * density)
  return words.slice(0, targetCount)
}

function applyReplacements(text, candidates, rand) {
  const sorted = [...candidates].sort((a, b) => b.start - a.start)
  let result = text
  let count = 0
  for (const c of sorted) {
    const replacement = c.synonyms[Math.floor(rand() * c.synonyms.length)]
    result = result.slice(0, c.start) + replacement + result.slice(c.end)
    count++
  }
  return { text: result, count }
}

function createRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return state / 0x100000000
  }
}

async function main() {
  const args = process.argv.slice(2)
  const modelPath = args.find(a => !a.startsWith('-'))
    ? args.find(a => !a.startsWith('-'))
    : DEFAULT_MODEL
  const analyzeOnly = args.includes('--analyze-only')

  const densities = [0.15, 0.25, 0.35, 0.50, 0.70, 1.0]

  const inputFile = path.join(projectRoot, 'docs/experiments/A2-ai.txt')
  const text = fs.readFileSync(inputFile, 'utf8').trimEnd()

  console.log(`模型: ${path.basename(modelPath)}`)
  console.log(`输入: A2-ai.txt (${text.length} 字)`)
  console.log('正在加载模型…')

  const llama = await getLlama()
  const model = await llama.loadModel({ modelPath })
  const context = await model.createContext({ contextSize: 4096 })
  const sequence = context.getSequence()
  console.log('模型加载完成，正在计算 token 概率…\n')

  const tokenProbs = await computeTokenProbs(sequence, model, text)
  const charProbs = mapTokensToText(text, tokenProbs)

  // 统计
  const avgProb = tokenProbs.reduce((s, t) => s + t.prob, 0) / tokenProbs.length
  const top5Count = tokenProbs.filter(t => t.inTop5).length
  const top5Rate = top5Count / tokenProbs.length
  console.log(`Token 统计: 总数=${tokenProbs.length}, 平均概率=${(avgProb * 100).toFixed(1)}%, Top5命中率=${(top5Rate * 100).toFixed(1)}%`)

  // 显示概率最高的 20 个可替换词
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  const allWords = []
  for (const seg of segmenter.segment(text)) {
    if (!seg.isWordLike || seg.segment.length < 2) continue
    const start = seg.index
    const end = start + seg.segment.length
    let maxProb = 0
    for (let i = start; i < end && i < charProbs.length; i++) {
      maxProb = Math.max(maxProb, charProbs[i])
    }
    const synonyms = SYNONYM_TABLE.get(seg.segment)
    allWords.push({ word: seg.segment, maxProb, hasSynonym: !!synonyms })
  }
  allWords.sort((a, b) => b.maxProb - a.maxProb)

  console.log('\n概率最高的 30 个内容词（★ = 有同义替换）:')
  for (const w of allWords.slice(0, 30)) {
    const mark = w.hasSynonym ? '★' : '  '
    console.log(`  ${mark} "${w.word}" prob=${(w.maxProb * 100).toFixed(1)}%`)
  }

  const replaceable = allWords.filter(w => w.hasSynonym)
  console.log(`\n可替换词: ${replaceable.length} / ${allWords.length} (${(replaceable.length / allWords.length * 100).toFixed(0)}%)`)

  if (analyzeOnly) {
    await cleanup(sequence, context, model, llama)
    return
  }

  // 生成不同密度的替换版本
  console.log('\n生成替换样本…')

  const experimentsDir = path.join(projectRoot, 'docs/experiments')
  for (const density of densities) {
    const candidates = findReplaceCandidates(text, charProbs, density)
    const rand = createRng(42 + Math.floor(density * 100))
    const { text: replaced, count } = applyReplacements(text, candidates, rand)
    const label = `PPL${Math.round(density * 100)}`
    const outPath = path.join(experimentsDir, `${label}-A2-ai.txt`)
    fs.writeFileSync(outPath, replaced + '\n', 'utf8')
    console.log(`  ${label}: 替换 ${count} 词 (密度 ${(density * 100).toFixed(0)}%) → ${outPath}`)
  }

  // 也处理 F1-ai-novel.txt
  console.log('\n处理 F1-ai-novel.txt…')
  const f1Text = fs.readFileSync(path.join(projectRoot, 'docs/experiments/F1-ai-novel.txt'), 'utf8').trimEnd()
  const f1TokenProbs = await computeTokenProbs(sequence, model, f1Text)
  const f1CharProbs = mapTokensToText(f1Text, f1TokenProbs)

  for (const density of [0.35, 0.50, 1.0]) {
    const candidates = findReplaceCandidates(f1Text, f1CharProbs, density)
    const rand = createRng(42 + Math.floor(density * 100))
    const { text: replaced, count } = applyReplacements(f1Text, candidates, rand)
    const label = `PPL${Math.round(density * 100)}`
    const outPath = path.join(experimentsDir, `${label}-F1-ai-novel.txt`)
    fs.writeFileSync(outPath, replaced + '\n', 'utf8')
    console.log(`  ${label}: 替换 ${count} 词 → ${outPath}`)
  }

  await cleanup(sequence, context, model, llama)
  console.log('\n完成！')
}

async function cleanup(sequence, context, model, llama) {
  await sequence.dispose()
  await context.dispose()
  await model.dispose()
  await llama.dispose()
}

main().catch(err => {
  console.error('运行失败:', err)
  process.exit(1)
})
