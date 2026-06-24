/**
 * PPL 引导的精准句级 DeepSeek 改写
 *
 * 1. 用本地 Qwen-4B 逐句计算 token 概率
 * 2. 按 AI 浓度排序，选出 Top-K 句子
 * 3. 将这些句子（附上下文）发给 DeepSeek 改写
 * 4. 拼回原文，生成 SR30/SR50/SR70/SR100 四个密度版本
 *
 * 用法:
 *   node scripts/ppl-selective-rewrite.mjs [--analyze-only] [--input path]
 *
 * 环境变量:
 *   DEEPSEEK_API_KEY  — DeepSeek API key（未设置则从应用数据库读取）
 */
import { getLlama } from 'node-llama-cpp'
import { execSync } from 'child_process'
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

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1'
const DEEPSEEK_MODEL = 'deepseek-chat'

const REWRITE_SYSTEM_PROMPT = [
  '你是专业的去AI痕迹重写编辑。你的改写必须产生肉眼可见的实质性变化。',
  '',
  '核心目标：改写后的文本必须与原文有30%以上的文字差异。只替换个别词是不合格的。',
  '',
  '硬约束：',
  '1. 保持人物、事件、时间线不变。',
  '2. 每个叙述句都必须重组句式——换语序、拆合句子、变换主语。',
  '3. 禁止照抄：连续10字以上与原文相同是绝对禁止的（专有名词和对话原文除外）。',
  '4. 对话内容保持原样，但对话之间的叙述描写必须重写。',
  '5. 仅输出改写正文，不要解释，不要加标记。',
  '',
  '★★★ 外部检测器最敏感的AI指纹（违反即判定失败）：',
  '',
  'A.【致命】禁止"电影镜头链"式描写：',
  '  禁止连续逐帧动作分镜，禁止"目光落在/扫过…上"，禁止"嘴角微微上扬"。',
  '',
  'B.【高危】禁止书面连接词：',
  '  禁用：然而、因此、此外、与此同时、值得注意的是、总而言之。',
  '  替代：直接删除，或用口语词。',
  '',
  'C.【中危】禁止模板情感句/总结句：',
  '  禁用："心中涌起一股…""这一刻他明白了…"等。',
  '',
  'D. 词汇偏口语化/低频化：用具象词代替标准书面语。',
].join('\n')

// ── 工具函数 ──

function getDeepSeekApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY

  const dbPath = path.join(os.homedir(), 'Library/Application Support/anovel/anovel.db')
  if (!fs.existsSync(dbPath)) {
    throw new Error(`数据库不存在: ${dbPath}\n请设置 DEEPSEEK_API_KEY 环境变量`)
  }

  try {
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT api_key FROM model_configs WHERE model_type = 'deepseek' AND is_enabled = 1"`,
      { encoding: 'utf8' }
    ).trim()
    if (!result) throw new Error('空结果')
    return result
  } catch {
    throw new Error('无法从数据库读取 DeepSeek API key\n请设置 DEEPSEEK_API_KEY 环境变量')
  }
}

const SENTENCE_TERMINATORS = new Set(['。', '！', '？', '!', '?'])
const TRAILING_QUOTES = new Set(['\u201d', '\u2019', '\u300d', '\u300f', '\uff09'])

function splitIntoSentences(text) {
  const sentences = []
  let start = 0
  let i = 0
  while (i < text.length) {
    if (SENTENCE_TERMINATORS.has(text[i])) {
      let end = i + 1
      while (end < text.length && TRAILING_QUOTES.has(text[end])) end++
      sentences.push({ text: text.slice(start, end), start, end })
      start = end
      i = end
      continue
    }
    i++
  }
  if (start < text.length && text.slice(start).trim()) {
    sentences.push({ text: text.slice(start), start, end: text.length })
  }
  return sentences
}

// ── PPL 逐句评分 ──

async function computeSentenceScores(sequence, model, fullText, sentences) {
  let tokens = model.tokenize(fullText)
  if (tokens.length < 4) return sentences.map(() => ({ avgProb: 0, top5Rate: 0 }))
  if (tokens.length > 3800) tokens = tokens.slice(0, 3800)

  await sequence.clearHistory()

  const BATCH_SIZE = 200
  const tokenMetrics = []

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
        tokenMetrics.push({ charLen: tokenText.length, prob: 0, inTop5: false })
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
      tokenMetrics.push({ charLen: tokenText.length, prob, inTop5: rank < 5 })
    }
  }

  // 将 token metrics 映射到字符位置
  const charProbs = new Array(fullText.length).fill(null)
  const charTop5 = new Array(fullText.length).fill(null)
  let pos = 0
  for (const tm of tokenMetrics) {
    for (let j = 0; j < tm.charLen && pos + j < fullText.length; j++) {
      charProbs[pos + j] = tm.prob
      charTop5[pos + j] = tm.inTop5
    }
    pos += tm.charLen
  }

  // 按句子聚合
  return sentences.map(s => {
    const probs = []
    const tops = []
    for (let i = s.start; i < s.end && i < charProbs.length; i++) {
      if (charProbs[i] !== null) {
        probs.push(charProbs[i])
        tops.push(charTop5[i] ? 1 : 0)
      }
    }
    if (probs.length === 0) return { avgProb: 0, top5Rate: 0 }
    const avgProb = probs.reduce((a, b) => a + b, 0) / probs.length
    const top5Rate = tops.reduce((a, b) => a + b, 0) / tops.length
    return { avgProb, top5Rate }
  })
}

// ── DeepSeek 改写 ──

async function rewriteWithDeepSeek(apiKey, sentencesToRewrite, allSentences) {
  const contextWindow = 2
  const rewriteJobs = []

  for (const { idx } of sentencesToRewrite) {
    const ctxStart = Math.max(0, idx - contextWindow)
    const ctxEnd = Math.min(allSentences.length - 1, idx + contextWindow)

    let prompt = '请改写以下文本中被【】标记的句子，保留未标记的句子原样输出。\n\n'
    for (let i = ctxStart; i <= ctxEnd; i++) {
      if (i === idx) {
        prompt += `【${allSentences[i].text}】`
      } else {
        prompt += allSentences[i].text
      }
    }
    prompt += '\n\n仅输出改写后的完整文本（从第一句到最后一句，包括未标记的上下文），不要加任何标记或解释。'

    rewriteJobs.push({ idx, prompt, ctxStart, ctxEnd })
  }

  const results = new Map()

  // 串行调用避免 rate limit
  for (let i = 0; i < rewriteJobs.length; i++) {
    const job = rewriteJobs[i]
    console.log(`  改写 ${i + 1}/${rewriteJobs.length}: 句${job.idx + 1} (avgProb=${(sentencesToRewrite[i].avgProb * 100).toFixed(1)}%)`)

    try {
      const rewritten = await callDeepSeek(apiKey, job.prompt)
      if (rewritten && rewritten.trim()) {
        results.set(job.idx, rewritten.trim())
      }
    } catch (err) {
      console.error(`  句${job.idx + 1} 改写失败: ${err.message}`)
    }

    // 简单限流
    if (i < rewriteJobs.length - 1) {
      await sleep(500)
    }
  }

  return results
}

async function rewriteBatchWithDeepSeek(apiKey, sentencesToRewrite, allSentences) {
  const indices = sentencesToRewrite.map(s => s.idx)

  // 按行重组，保留原始换行结构
  const lineTexts = new Map()
  for (let i = 0; i < allSentences.length; i++) {
    const li = allSentences[i].lineIdx
    if (!lineTexts.has(li)) lineTexts.set(li, [])
    const marked = indices.includes(i)
    lineTexts.get(li).push(marked ? `【${allSentences[i].text}】` : allSentences[i].text)
  }

  let prompt = '请改写以下文本中被【】标记的句子。未标记的句子保持原样。\n'
  prompt += '重要：保持原文的换行格式，每行单独一段。不要合并行。不要保留【】标记。不要加解释。\n\n'

  const sortedLines = [...lineTexts.keys()].sort((a, b) => a - b)
  for (const li of sortedLines) {
    prompt += lineTexts.get(li).join('') + '\n'
  }

  console.log(`  批量改写 ${indices.length} 句…`)

  try {
    const rewritten = await callDeepSeek(apiKey, prompt)
    if (rewritten && rewritten.trim()) {
      return rewritten.trim()
    }
  } catch (err) {
    console.error(`  批量改写失败: ${err.message}`)
  }
  return null
}

async function callDeepSeek(apiKey, userPrompt) {
  const body = {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: REWRITE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.85,
    max_tokens: 4096,
  }

  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`DeepSeek API ${resp.status}: ${text}`)
  }

  const json = await resp.json()
  return json.choices?.[0]?.message?.content ?? ''
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ── 主流程 ──

async function main() {
  const args = process.argv.slice(2)
  const analyzeOnly = args.includes('--analyze-only')
  const inputIdx = args.indexOf('--input')
  const inputFile = inputIdx >= 0 && args[inputIdx + 1]
    ? path.resolve(args[inputIdx + 1])
    : path.join(projectRoot, 'docs/experiments/F1-ai-novel.txt')

  const text = fs.readFileSync(inputFile, 'utf8').trimEnd()
  const baseName = path.basename(inputFile, '.txt')

  console.log(`输入: ${baseName} (${text.length} 字)`)

  // Step 1: 分句
  const lines = text.split('\n')
  const lineSentences = []
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    if (!line.trim()) {
      lineSentences.push({ lineIdx: li, sentences: [], lineText: line })
      continue
    }
    const sents = splitIntoSentences(line)
    lineSentences.push({ lineIdx: li, sentences: sents, lineText: line })
  }

  // 展平为全局句子列表
  const allSentences = []
  for (const ls of lineSentences) {
    for (const s of ls.sentences) {
      allSentences.push({ ...s, lineIdx: ls.lineIdx })
    }
  }

  console.log(`分句: ${allSentences.length} 句`)

  // Step 2: PPL 评分
  console.log('正在加载 PPL 模型…')
  const llama = await getLlama()
  const model = await llama.loadModel({ modelPath: DEFAULT_MODEL })
  const context = await model.createContext({ contextSize: 4096 })
  const sequence = context.getSequence()
  console.log('模型加载完成，正在逐句评分…\n')

  const scores = await computeSentenceScores(sequence, model, text, allSentences)

  // 释放模型资源
  await sequence.dispose()
  await context.dispose()
  await model.dispose()
  await llama.dispose()
  console.log('PPL 模型已释放\n')

  // Step 3: 排序显示
  const scored = allSentences.map((s, i) => ({
    idx: i,
    text: s.text,
    lineIdx: s.lineIdx,
    avgProb: scores[i].avgProb,
    top5Rate: scores[i].top5Rate,
  }))

  const ranked = [...scored]
    .filter(s => s.text.trim().length > 3)
    .sort((a, b) => b.avgProb - a.avgProb)

  console.log('=== 按 AI 浓度排序（avgProb 降序）===\n')
  for (let i = 0; i < ranked.length; i++) {
    const s = ranked[i]
    const preview = s.text.length > 40 ? s.text.slice(0, 40) + '…' : s.text
    const marker = i < Math.ceil(ranked.length * 0.3) ? '★' : '  '
    console.log(`${marker} #${String(i + 1).padStart(2)} avgP=${(s.avgProb * 100).toFixed(1).padStart(5)}% top5=${(s.top5Rate * 100).toFixed(0).padStart(3)}% L${s.lineIdx + 1} "${preview}"`)
  }

  const totalAvgProb = scored.reduce((s, x) => s + x.avgProb, 0) / scored.length
  console.log(`\n全文平均概率: ${(totalAvgProb * 100).toFixed(1)}%`)

  if (analyzeOnly) {
    console.log('\n--analyze-only 模式，跳过改写。')
    return
  }

  // Step 4: DeepSeek 改写
  let apiKey
  try {
    apiKey = getDeepSeekApiKey()
    console.log('\nDeepSeek API key 已获取')
  } catch (err) {
    console.error(`\n${err.message}`)
    console.log('\n请设置 DEEPSEEK_API_KEY 环境变量后重新运行。')
    return
  }

  const densities = [0.3, 0.5, 0.7, 1.0]
  const experimentsDir = path.join(projectRoot, 'docs/experiments')

  for (const density of densities) {
    const count = Math.ceil(ranked.length * density)
    const toRewrite = ranked.slice(0, count)
    const label = `SR${Math.round(density * 100)}`

    console.log(`\n── ${label}: 改写 ${count}/${ranked.length} 句 (密度 ${(density * 100).toFixed(0)}%) ──`)

    const fullRewrite = await rewriteBatchWithDeepSeek(apiKey, toRewrite, allSentences)

    if (fullRewrite) {
      const outPath = path.join(experimentsDir, `${label}-${baseName}.txt`)
      fs.writeFileSync(outPath, fullRewrite + '\n', 'utf8')
      console.log(`  → ${outPath}`)
    } else {
      console.log(`  ✗ ${label} 改写失败`)
    }

    if (density < 1.0) await sleep(1000)
  }

  console.log('\n完成！')
}

main().catch(err => {
  console.error('运行失败:', err)
  process.exit(1)
})
