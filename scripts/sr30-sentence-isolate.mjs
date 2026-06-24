/**
 * 策略 A：句级独立 DeepSeek 改写 + 轻度 swap 叠加
 *
 * 1. 每个叙述句单独发给 DeepSeek 改写（无上下文，制造跨句 n-gram 断裂）
 * 2. 对话句保持不动
 * 3. 拼合后叠加 15%/20% swap
 *
 * 用法: node scripts/sr30-sentence-isolate.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import os from 'os'
import { hashSeed, createRng, splitSentences } from './word-shuffle.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const experimentsDir = path.join(projectRoot, 'docs/experiments')
const INPUT = path.join(experimentsDir, 'SR30-F1-ai-novel.txt')

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1'
const DEEPSEEK_MODEL = 'deepseek-chat'

const STYLE_PROMPTS = [
  '用更精简的方式改写这个句子，保留核心意思，减少修饰词。不要加解释。',
  '用口语化的方式改写这个句子，像朋友聊天。不要加解释。',
  '换一种句式结构改写这个句子，保留语义。不要加解释。',
]

function getDeepSeekApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const dbPath = path.join(os.homedir(), 'Library/Application Support/anovel/anovel.db')
  if (!fs.existsSync(dbPath)) throw new Error('请设置 DEEPSEEK_API_KEY')
  try {
    const result = execSync(
      `sqlite3 "${dbPath}" "SELECT api_key FROM model_configs WHERE model_type = 'deepseek' AND is_enabled = 1"`,
      { encoding: 'utf8' }
    ).trim()
    if (!result) throw new Error('空结果')
    return result
  } catch {
    throw new Error('无法读取 API key，请设置 DEEPSEEK_API_KEY')
  }
}

async function callDeepSeek(apiKey, systemPrompt, userText) {
  const body = {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ],
    temperature: 0.9,
    max_tokens: 512,
  }
  const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`DeepSeek ${resp.status}: ${text}`)
  }
  const json = await resp.json()
  return json.choices?.[0]?.message?.content?.trim() ?? ''
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isDialogueLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^["\u201c\u300c]/.test(trimmed)) return true
  if (trimmed.length <= 6) return true
  return false
}

function swapAdjacentWords(sentence, rand, rate) {
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  const tokens = [...segmenter.segment(sentence)].map(s => ({
    text: s.segment,
    word: s.isWordLike,
  }))
  if (tokens.length <= 2) return sentence
  const wordIdx = tokens.map((t, i) => (t.word ? i : -1)).filter(i => i >= 0)
  if (wordIdx.length <= 1) return sentence
  for (let k = 0; k < wordIdx.length - 1; k++) {
    if (rand() > rate) continue
    const a = wordIdx[k]
    const b = wordIdx[k + 1]
    ;[tokens[a].text, tokens[b].text] = [tokens[b].text, tokens[a].text]
  }
  return tokens.map(t => t.text).join('')
}

async function main() {
  const text = fs.readFileSync(INPUT, 'utf8').trimEnd()
  const lines = text.split('\n')
  console.log(`输入: SR30 (${text.replace(/\s/g, '').length} 字, ${lines.length} 行)\n`)

  const apiKey = getDeepSeekApiKey()
  console.log('DeepSeek API key 已获取\n')

  // Step 1: 句级独立改写
  console.log('=== Step 1: 句级独立 DeepSeek 改写 ===')
  const rewrittenLines = []
  let sentIdx = 0

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    const trimmed = line.trim()

    if (!trimmed || isDialogueLine(trimmed)) {
      rewrittenLines.push(line)
      continue
    }

    const sentences = splitSentences(trimmed)
    const rewrittenSentences = []

    for (const sent of sentences) {
      if (sent.trim().length <= 4) {
        rewrittenSentences.push(sent)
        continue
      }

      const styleIdx = sentIdx % STYLE_PROMPTS.length
      const prompt = STYLE_PROMPTS[styleIdx]

      try {
        const rewritten = await callDeepSeek(apiKey, prompt, sent)
        if (rewritten && rewritten.length > 2 && rewritten.length < sent.length * 3) {
          const clean = rewritten.replace(/^[""\u201c\u201d]|[""\u201c\u201d]$/g, '').trim()
          rewrittenSentences.push(clean)
        } else {
          rewrittenSentences.push(sent)
        }
      } catch (err) {
        console.error(`  句 ${sentIdx} 失败: ${err.message}`)
        rewrittenSentences.push(sent)
      }

      sentIdx++
      if (sentIdx % 10 === 0) console.log(`  已改写 ${sentIdx} 句…`)
      await sleep(300)
    }

    rewrittenLines.push(rewrittenSentences.join(''))
  }

  const isolatedText = rewrittenLines.join('\n')
  console.log(`\nStep 1 完成: ${sentIdx} 句已独立改写\n`)

  // Step 2: 叠加 swap
  console.log('=== Step 2: 叠加轻度 swap ===')
  const seed = hashSeed(isolatedText)

  for (const [label, rate] of [['SA1', 0.15], ['SA2', 0.20]]) {
    const swapped = isolatedText.split('\n').map((line, i) => {
      const trimmed = line.trim()
      if (!trimmed || isDialogueLine(trimmed)) return line
      const rand = createRng((seed + i * 9973) >>> 0)
      return splitSentences(trimmed).map(s => swapAdjacentWords(s, rand, rate)).join('')
    }).join('\n')

    const outPath = path.join(experimentsDir, `${label}-SR30-isolate-swap.txt`)
    fs.writeFileSync(outPath, swapped + '\n', 'utf8')
    console.log(`  ✓ ${label} (swap=${rate}) → ${outPath}`)
  }

  // Also save the pure isolated version (no swap) for reference
  const sa0Path = path.join(experimentsDir, 'SA0-SR30-isolate-only.txt')
  fs.writeFileSync(sa0Path, isolatedText + '\n', 'utf8')
  console.log(`  ✓ SA0 (no swap) → ${sa0Path}`)

  console.log('\n完成！')
}

main().catch(err => {
  console.error('运行失败:', err)
  process.exit(1)
})
