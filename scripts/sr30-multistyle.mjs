/**
 * X 系列: 多风格 DeepSeek 改写实验
 *
 * 将 SR30 分段，用不同风格 prompt 让 DeepSeek 改写，制造模型内部的分布多样性。
 *
 * X1: 4 段 × 4 种风格（网文老手 / 文艺青年 / 口语化 / 极简风）
 * X2: 每 3 个段落轮换风格
 *
 * 用法:
 *   node scripts/sr30-multistyle.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const experimentsDir = path.join(projectRoot, 'docs/experiments')

const INPUT = path.join(experimentsDir, 'SR30-F1-ai-novel.txt')

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1'
const DEEPSEEK_MODEL = 'deepseek-chat'

const STYLE_PROMPTS = [
  {
    name: '网文老手',
    system: [
      '你是一个写了十年网文的老手，文风节奏快、废话少、用词接地气。',
      '改写以下段落，保持人物和情节不变，但要像网文大神那样写：',
      '- 多用短句，动作干脆',
      '- 少用形容词，偏口语化',
      '- 绝不用"然而""因此""与此同时"这类连接词',
      '- 绝不用"心中涌起""这一刻他明白了"这类模板句',
      '- 绝不用电影镜头式的逐帧描写',
      '- 保持换行格式，每段单独一行',
      '- 仅输出改写结果，不加解释',
    ].join('\n'),
  },
  {
    name: '文艺青年',
    system: [
      '你是一个文艺范儿的写手，偏好意象、留白、细腻感受。',
      '改写以下段落，保持人物和情节不变：',
      '- 多用感官细节（气味、触感、光线变化）',
      '- 句子可以长一些，有节奏感',
      '- 偶尔用比喻，但要新鲜，不用俗套的',
      '- 绝不用"然而""因此""与此同时"这类连接词',
      '- 绝不用"心中涌起""这一刻他明白了"这类模板句',
      '- 绝不用电影镜头式的逐帧描写',
      '- 保持换行格式，每段单独一行',
      '- 仅输出改写结果，不加解释',
    ].join('\n'),
  },
  {
    name: '口语化',
    system: [
      '你是个说话大大咧咧的人，写东西跟聊天似的。',
      '改写以下段落，保持人物和情节不变：',
      '- 用大白话，就像跟朋友讲故事',
      '- 可以有语气词（"嘛""呗""得了"），偶尔断句不规整',
      '- 少用书面语，把文绉绉的词都换成大白话',
      '- 绝不用"然而""因此""与此同时"这类连接词',
      '- 绝不用"心中涌起""这一刻他明白了"这类模板句',
      '- 保持换行格式，每段单独一行',
      '- 仅输出改写结果，不加解释',
    ].join('\n'),
  },
  {
    name: '极简风',
    system: [
      '你的文字极度精练，像海明威一样，能删就删。',
      '改写以下段落，保持人物和情节不变：',
      '- 每个句子不超过15字',
      '- 砍掉所有不必要的修饰语',
      '- 动词为王，减少形容词',
      '- 留白多于描写',
      '- 绝不用"然而""因此""与此同时"这类连接词',
      '- 绝不用"心中涌起""这一刻他明白了"这类模板句',
      '- 保持换行格式，每段单独一行',
      '- 仅输出改写结果，不加解释',
    ].join('\n'),
  },
]

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

async function callDeepSeek(apiKey, systemPrompt, userPrompt) {
  const body = {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.85,
    max_tokens: 4096,
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
    throw new Error(`DeepSeek API ${resp.status}: ${text}`)
  }

  const json = await resp.json()
  return json.choices?.[0]?.message?.content ?? ''
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function splitIntoChunks(paragraphs, numChunks) {
  const chunks = Array.from({ length: numChunks }, () => [])
  for (let i = 0; i < paragraphs.length; i++) {
    chunks[i % numChunks].push({ idx: i, text: paragraphs[i] })
  }
  return chunks
}

function splitIntoContiguousChunks(paragraphs, numChunks) {
  const chunkSize = Math.ceil(paragraphs.length / numChunks)
  const chunks = []
  for (let i = 0; i < paragraphs.length; i += chunkSize) {
    const chunk = paragraphs.slice(i, i + chunkSize).map((text, j) => ({
      idx: i + j,
      text,
    }))
    chunks.push(chunk)
  }
  return chunks
}

async function main() {
  const args = process.argv.slice(2)
  const x2Only = args.includes('--x2-only')

  const text = fs.readFileSync(INPUT, 'utf8').trimEnd()
  const paragraphs = text.split('\n')

  console.log(`输入: SR30-F1-ai-novel.txt (${text.replace(/\s/g, '').length} 字, ${paragraphs.length} 行)\n`)

  let apiKey
  try {
    apiKey = getDeepSeekApiKey()
    console.log('DeepSeek API key 已获取\n')
  } catch (err) {
    console.error(err.message)
    process.exit(1)
  }

  // ── X1: 4 段连续区域 × 4 种风格 ──
  if (x2Only) {
    console.log('跳过 X1 (--x2-only)\n')
  } else {
  console.log('=== X1: 4 段连续区域 × 4 种风格 ===')
  const contiguousChunks = splitIntoContiguousChunks(paragraphs, 4)

  const x1Result = [...paragraphs]
  for (let ci = 0; ci < contiguousChunks.length; ci++) {
    const chunk = contiguousChunks[ci]
    const style = STYLE_PROMPTS[ci % STYLE_PROMPTS.length]
    const chunkText = chunk.map(p => p.text).join('\n')

    if (!chunkText.trim()) continue

    console.log(`  段 ${ci + 1}: ${style.name} (${chunk.length} 行)`)

    try {
      const rewritten = await callDeepSeek(apiKey, style.system, chunkText)
      if (rewritten && rewritten.trim()) {
        const rewrittenLines = rewritten.trim().split('\n')
        for (let j = 0; j < chunk.length && j < rewrittenLines.length; j++) {
          x1Result[chunk[j].idx] = rewrittenLines[j]
        }
      }
    } catch (err) {
      console.error(`  段 ${ci + 1} 改写失败: ${err.message}`)
    }

    await sleep(1000)
  }

  const x1Text = x1Result.join('\n')
  const x1Path = path.join(experimentsDir, 'X1-SR30-multistyle-block.txt')
  fs.writeFileSync(x1Path, x1Text.endsWith('\n') ? x1Text : x1Text + '\n', 'utf8')
  console.log(`  ✓ X1 → ${x1Path}\n`)
  } // end if !x2Only

  // ── X2: 每 3 个段落轮换风格 ──
  console.log('=== X2: 每 3 段轮换风格 ===')
  const x2Parts = []
  const paraGroups = []
  for (let i = 0; i < paragraphs.length; i += 3) {
    paraGroups.push(paragraphs.slice(i, Math.min(i + 3, paragraphs.length)))
  }

  for (let gi = 0; gi < paraGroups.length; gi++) {
    const group = paraGroups[gi]
    const style = STYLE_PROMPTS[gi % STYLE_PROMPTS.length]
    const groupText = group.join('\n')

    if (!groupText.trim()) {
      x2Parts.push(groupText)
      continue
    }

    console.log(`  组 ${gi + 1}/${paraGroups.length}: ${style.name}`)

    try {
      const rewritten = await callDeepSeek(apiKey, style.system, groupText)
      if (rewritten && rewritten.trim()) {
        x2Parts.push(rewritten.trim())
      } else {
        x2Parts.push(groupText)
      }
    } catch (err) {
      console.error(`  组 ${gi + 1} 改写失败: ${err.message}`)
      x2Parts.push(groupText)
    }

    if (gi < paraGroups.length - 1) await sleep(500)
  }

  const x2Text = x2Parts.join('\n\n')
  const x2Path = path.join(experimentsDir, 'X2-SR30-multistyle-rotate.txt')
  fs.writeFileSync(x2Path, x2Text.endsWith('\n') ? x2Text : x2Text + '\n', 'utf8')
  console.log(`  ✓ X2 → ${x2Path}\n`)

  console.log('完成！X 系列 2 个实验文件已生成。')
}

main().catch(err => {
  console.error('运行失败:', err)
  process.exit(1)
})
