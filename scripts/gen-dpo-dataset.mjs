#!/usr/bin/env node

/**
 * DPO 偏好数据集生成器 — 火山方舟格式
 *
 * 用于阶段 2：在 SFT 完成后，生成 (prompt, chosen, rejected) 三元组。
 *
 * 策略：
 *   - prompt = AI 风格文本
 *   - chosen = 人类原文（AIGC 检测分数最低）
 *   - rejected = 规则生成的"半改写"文本（仅表面替换，深层仍是 AI 风格）
 *
 * 用法:
 *   node scripts/gen-dpo-dataset.mjs [--count 3000] [--out datasets/dpo-train.jsonl]
 *
 * 输出: 火山方舟 DPO 精调要求的 JSONL 格式
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ─── 配置 ───

const HUMAN_SOURCES = [
  { file: path.join(ROOT, 'docs/凡人修仙传.txt'), weight: 0.5 },
  { file: path.join(ROOT, 'docs/我在精神病院学斩神.txt'), weight: 0.5 },
]

const DEFAULT_COUNT = 3000
const DEFAULT_OUTPUT = path.join(ROOT, 'datasets/dpo-train.jsonl')

const MIN_SEGMENT_CHARS = 150
const MAX_SEGMENT_CHARS = 500
const MIN_SENTENCES = 3

const SYSTEM_PROMPT = [
  '你是专业的文本润色编辑，擅长消除AI生成痕迹。',
  '将输入的AI风格文本改写为自然的人类写作风格，保持剧情和角色不变，只输出改写后的正文。',
].join('\n')

// ─── AI 化规则（与 gen-sft-dataset.mjs 保持一致） ───

const AI_CONNECTORS = [
  '紧接着，', '随即，', '与此同时，', '而此刻，', '就在这时，',
  '几乎是同一时间，', '然而，', '不过，', '说着，', '此时此刻，',
]

const AI_MICRO_ACTIONS = [
  '微微一笑', '微微皱眉', '眼中闪过一丝', '目光深邃', '神色复杂',
  '若有所思', '缓缓说道', '淡淡地说', '深吸一口气', '愣在原地',
]

const AI_TRANSITION_PHRASES = [
  '他转过身来，', '她抬起头，', '他微微一愣，',
  '她沉默片刻，', '他犹豫了一下，', '她不由自主地，',
]

const ORAL_TO_FORMAL = [
  ['瞅', '注视'], ['搁', '放置'], ['麻溜', '迅速'], ['寻思', '思考'],
  ['压根', '完全'], ['愣是', '坚持'], ['回过味来', '意识到'],
  ['嗯了一声', '点了点头'], ['吼了嗓子', '大声喊道'],
  ['一骨碌', '迅速'], ['屁大点儿', '不大'], ['踅摸', '搜寻'],
  ['猫着', '待着'], ['歪', '躺'], ['扒拉', '吃'],
  ['蹦下', '跳下'], ['拽着', '拉着'], ['搡', '放'],
  ['瞧', '看'], ['怪机灵', '很聪明'],
]

// ─── 工具函数 ───

function seededRng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s * 1103515245 + 12345) >>> 0
    return (s >>> 16) / 65536
  }
}

function pick(arr, rng) {
  return arr[Math.floor(rng() * arr.length)]
}

function shuffle(arr, rng) {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

function splitSentences(text) {
  const units = []
  const breakChars = new Set(['。', '！', '？', '!', '?', '；', '\n'])
  const trailingQuotes = new Set(['\u201d', "'", '\u201c', '\u2019', '\uff09', '\u3011', '\u300b', '\u300d', '\u300f'])
  let start = 0
  let i = 0
  while (i < text.length) {
    if (breakChars.has(text[i])) {
      let end = i + 1
      while (end < text.length && trailingQuotes.has(text[end])) end++
      while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++
      const seg = text.slice(start, end).trim()
      if (seg) units.push(seg)
      start = end
      i = end
      continue
    }
    i++
  }
  if (start < text.length) {
    const seg = text.slice(start).trim()
    if (seg) units.push(seg)
  }
  return units
}

// ─── 重度 AI 化（生成 prompt） ───

function aifyHeavy(humanText, rng) {
  let text = humanText

  for (const [oral, formal] of ORAL_TO_FORMAL) {
    if (text.includes(oral)) text = text.replaceAll(oral, formal)
  }

  const sentences = splitSentences(text)
  const result = []
  for (let j = 0; j < sentences.length; j++) {
    let sent = sentences[j]
    if (j > 0 && rng() < 0.25 && !sent.startsWith('"') && !sent.startsWith('"')) {
      sent = pick(AI_CONNECTORS, rng) + sent
    }
    if (j > 0 && rng() < 0.18 && !sent.startsWith('"') && !sent.startsWith('"')) {
      sent = pick(AI_TRANSITION_PHRASES, rng) + sent
    }
    result.push(sent)
  }

  text = result.join('')

  const lines = text.split('\n')
  const finalLines = []
  for (const line of lines) {
    let l = line
    if (!l.startsWith('"') && !l.startsWith('"') && l.length > 15 && rng() < 0.2) {
      const action = pick(AI_MICRO_ACTIONS, rng)
      const insertPos = l.lastIndexOf('，')
      if (insertPos > 5 && insertPos < l.length - 5) {
        l = l.slice(0, insertPos) + '，' + action + '，' + l.slice(insertPos + 1)
      }
    }
    finalLines.push(l)
  }

  return finalLines.join('\n')
}

// ─── 轻度改写（生成 rejected — 看起来改了但 AI 味仍重） ───

function shallowRewrite(aiText, rng) {
  let text = aiText

  // 只做表面词汇替换，不改句式结构
  const surfaceSwaps = [
    ['微微一笑', '浅浅一笑'], ['微微皱眉', '轻轻蹙眉'],
    ['缓缓说道', '轻声道'], ['淡淡地说', '平静地说'],
    ['深吸一口气', '缓了口气'], ['愣在原地', '呆住了'],
    ['紧接着', '接着'], ['随即', '随后'],
    ['与此同时', '同时'], ['目光深邃', '目光沉静'],
    ['然而', '但是'], ['不过', '只是'],
  ]

  for (const [from, to] of surfaceSwaps) {
    if (rng() < 0.7) {
      text = text.replaceAll(from, to)
    }
  }

  // 随机删除一两个过渡词（不够充分的改写）
  text = text.replace(/就在这时，/g, () => rng() < 0.5 ? '' : '就在这时，')
  text = text.replace(/此时此刻，/g, () => rng() < 0.5 ? '' : '此时此刻，')

  return text
}

// ─── 文本采样（与 SFT 脚本共享逻辑，使用不同种子避免数据重叠） ───

function loadAndSample(filePath, count, rng) {
  console.log(`  读取: ${path.basename(filePath)}`)
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n')

  let startLine = 0
  for (let i = 0; i < Math.min(50, lines.length); i++) {
    if (lines[i].match(/^第[一二三四五六七八九十百千\d]+[章卷节]/)) {
      startLine = i
      break
    }
  }

  let indentedLineCount = 0
  const sampleEnd = Math.min(startLine + 200, lines.length)
  for (let i = startLine; i < sampleEnd; i++) {
    if (lines[i].startsWith('\u3000\u3000')) indentedLineCount++
  }
  const isIndentedFormat = indentedLineCount > (sampleEnd - startLine) * 0.3

  const paragraphs = []

  if (isIndentedFormat) {
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i].replace(/^[\s\u3000]+/, '').trim()
      if (!line) continue
      if (line.match(/^第[一二三四五六七八九十百千万\d]+[章卷节]/) && line.length < 40) continue
      if (line.length < 5) continue
      paragraphs.push(line)
    }
  } else {
    let current = []
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i].replace(/^[\s\u3000]+/, '').trim()
      if (!line) {
        if (current.length > 0) {
          paragraphs.push(current.join('\n'))
          current = []
        }
        continue
      }
      if (line.match(/^第[一二三四五六七八九十百千万\d]+[章卷节]/) && line.length < 40) {
        if (current.length > 0) {
          paragraphs.push(current.join('\n'))
          current = []
        }
        continue
      }
      current.push(line)
    }
    if (current.length > 0) paragraphs.push(current.join('\n'))
  }

  console.log(`  段落总数: ${paragraphs.length}`)

  const segments = []
  // 使用不同的偏移量，避免和 SFT 数据集重叠
  const offset = Math.floor(paragraphs.length * 0.4)
  const indices = shuffle(
    Array.from({ length: paragraphs.length - 5 }, (_, i) => (i + offset) % (paragraphs.length - 5)),
    rng
  )

  for (const startIdx of indices) {
    if (segments.length >= count) break

    const paraCount = 3 + Math.floor(rng() * 8)
    const endIdx = Math.min(startIdx + paraCount, paragraphs.length)
    const text = paragraphs.slice(startIdx, endIdx).join('\n')

    if (text.length < MIN_SEGMENT_CHARS) continue
    if (text.length > MAX_SEGMENT_CHARS) {
      const sents = splitSentences(text)
      let truncated = ''
      for (const s of sents) {
        if (truncated.length + s.length > MAX_SEGMENT_CHARS) break
        truncated += s
      }
      if (truncated.length < MIN_SEGMENT_CHARS) continue
      if (splitSentences(truncated).length < MIN_SENTENCES) continue
      segments.push(truncated)
      continue
    }

    if (splitSentences(text).length < MIN_SENTENCES) continue
    segments.push(text)
  }

  console.log(`  采样片段: ${segments.length}`)
  return segments
}

// ─── 主流程 ───

function parseArgs() {
  const args = process.argv.slice(2)
  let count = DEFAULT_COUNT
  let output = DEFAULT_OUTPUT

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) {
      count = parseInt(args[i + 1], 10)
      i++
    } else if (args[i] === '--out' && args[i + 1]) {
      output = path.resolve(args[i + 1])
      i++
    }
  }

  return { count, output }
}

function main() {
  const { count, output } = parseArgs()
  console.log(`\n=== DPO 数据集生成器 ===`)
  console.log(`目标条数: ${count}`)
  console.log(`输出文件: ${output}\n`)

  // 用不同的种子，确保和 SFT 数据不完全重叠
  const rng = seededRng(12345)

  const allHumanSegments = []
  for (const source of HUMAN_SOURCES) {
    if (!fs.existsSync(source.file)) {
      console.warn(`  警告: 文件不存在 ${source.file}，跳过`)
      continue
    }
    const perSource = Math.ceil(count * source.weight * 1.2)
    const segments = loadAndSample(source.file, perSource, rng)
    allHumanSegments.push(...segments)
  }

  console.log(`\n总采样: ${allHumanSegments.length} 段\n`)

  const shuffled = shuffle(allHumanSegments, rng).slice(0, count)

  const outputDir = path.dirname(output)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  const fd = fs.openSync(output, 'w')
  let written = 0

  for (const humanText of shuffled) {
    // prompt = 重度 AI 化的文本
    const aiText = aifyHeavy(humanText, rng)
    // chosen = 人类原文（最佳改写目标）
    const chosen = humanText
    // rejected = 轻度表面改写（看起来改了但本质不变）
    const rejected = shallowRewrite(aiText, rng)

    const entry = {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: aiText },
      ],
      chosen: chosen,
      rejected: rejected,
    }

    fs.writeSync(fd, JSON.stringify(entry) + '\n')
    written++
  }

  fs.closeSync(fd)

  console.log(`=== 生成完成 ===`)
  console.log(`写入条数: ${written}`)
  console.log(`输出文件: ${output}`)
  console.log(`文件大小: ${(fs.statSync(output).size / 1024 / 1024).toFixed(2)} MB\n`)

  // 打印前 1 条样本预览
  const preview = fs.readFileSync(output, 'utf-8').split('\n').filter(Boolean).slice(0, 1)
  for (let i = 0; i < preview.length; i++) {
    const entry = JSON.parse(preview[i])
    console.log(`--- 样本 ${i + 1} ---`)
    console.log(`[Prompt] ${entry.messages[1].content.slice(0, 100)}...`)
    console.log(`[Chosen] ${entry.chosen.slice(0, 100)}...`)
    console.log(`[Rejected] ${entry.rejected.slice(0, 100)}...`)
    console.log()
  }
}

main()
