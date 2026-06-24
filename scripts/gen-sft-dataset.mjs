#!/usr/bin/env node

/**
 * SFT 训练数据集生成器 — 火山方舟格式
 *
 * 从人类小说文本中采样片段，用规则将其"AI 化"作为 input，
 * 人类原文作为 target，生成 (AI风格, 人类风格) 配对训练数据。
 *
 * 用法:
 *   node scripts/gen-sft-dataset.mjs [--count 5000] [--out datasets/sft-train.jsonl]
 *
 * 输出: 火山方舟 SFT 精调要求的 JSONL 格式
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

const DEFAULT_COUNT = 5500
const DEFAULT_OUTPUT = path.join(ROOT, 'datasets/sft-train.jsonl')

const MIN_SEGMENT_CHARS = 150
const MAX_SEGMENT_CHARS = 600
const MIN_SENTENCES = 3

// ─── System Prompt（和 anovel 实际改写场景一致） ───

const SYSTEM_PROMPT = [
  '你是专业的文本润色编辑，擅长消除AI生成痕迹。',
  '将输入的AI风格文本改写为自然的人类写作风格。',
  '',
  '要求：',
  '1. 保持人物、事件、因果关系不变',
  '2. 重组句式：换语序、拆合句子、变换主语、换修辞',
  '3. 制造句长差异：穿插极短句和长句，禁止连续3句长度相近',
  '4. 删除过渡连接词（"他转身""她抬头""接着"），直接跳到下一动作',
  '5. 禁止照抄：与原文连续相同不超过8字（专有名词除外）',
  '6. 对话原文保持不变，只改叙述和描写',
  '7. 只输出改写后的正文，不要解释',
].join('\n')

// ─── AI 化规则（将人类文本转换为典型 AI 风格） ───

const AI_CONNECTORS = [
  '紧接着，', '随即，', '与此同时，', '而此刻，', '就在这时，',
  '几乎是同一时间，', '然而，', '不过，', '说着，', '此时此刻，',
]

const AI_MICRO_ACTIONS = [
  '微微一笑', '微微皱眉', '眼中闪过一丝', '目光深邃', '神色复杂',
  '若有所思', '缓缓说道', '淡淡地说', '不由得', '深吸一口气',
  '愣在原地', '僵在原地', '目光掠过', '视线滑开', '嘴角上扬',
  '嘴角微勾', '翻了个白眼', '点了点头', '摇了摇头', '陷入沉思',
]

const AI_TRANSITION_PHRASES = [
  '他转过身来，', '她抬起头，', '他微微一愣，',
  '她沉默片刻，', '他犹豫了一下，', '她不由自主地，',
]

const ORAL_TO_FORMAL = [
  ['瞅', '注视'], ['搁', '放置'], ['麻溜', '迅速'], ['寻思', '思考'],
  ['压根', '完全'], ['愣是', '坚持'], ['回过味来', '意识到'],
  ['嗯了一声', '点了点头'], ['吼了嗓子', '大声喊道'],
  ['一骨碌', '迅速'], ['垫巴垫巴', '稍作休整'], ['屁大点儿', '不大'],
  ['踅摸', '搜寻'], ['嚷嚷', '说道'], ['猫着', '待着'],
  ['野', '乱跑'], ['歪', '躺'], ['打呼噜', '沉沉入睡'],
  ['呼噜呼噜', '快速地'], ['扒拉', '吃'], ['吭气', '说话'],
  ['蹦下', '跳下'], ['拽着', '拉着'], ['搡', '放'],
  ['冒尖', '满满'], ['瞅', '看'], ['瞧', '看'],
  ['嚯', ''], ['得嘞', '好的'], ['整碗', '来碗'],
  ['灰不溜丢', '灰色'], ['瘦得跟竹竿似的', '非常瘦'],
  ['黑得像锅底', '皮肤黝黑'], ['贼亮', '很有神'],
  ['怪机灵', '很聪明'], ['崽子', '孩子'],
  ['有一搭没一搭', '随意地'], ['犯困', '感到困意'],
]

const SIMILE_TEMPLATES = [
  '仿佛{0}一般', '犹如{0}似的', '宛如{0}一样', '好像{0}似的',
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

// ─── AI 化变换 ───

function aifyText(humanText, rng) {
  let text = humanText

  // 1. 口语 → 书面语替换
  for (const [oral, formal] of ORAL_TO_FORMAL) {
    if (text.includes(oral)) {
      text = text.replaceAll(oral, formal)
    }
  }

  // 2. 均匀化句长 — 合并极短句，拆分极长句
  const sentences = splitSentences(text)
  const processed = []
  let i = 0
  while (i < sentences.length) {
    let s = sentences[i]

    // 合并极短句（< 6 字）与后一句
    if (s.length < 6 && i + 1 < sentences.length) {
      s = s.replace(/[。！？；]$/, '，') + sentences[i + 1]
      i += 2
      processed.push(s)
      continue
    }

    processed.push(s)
    i++
  }

  // 3. 插入 AI 过渡连接词
  const result = []
  for (let j = 0; j < processed.length; j++) {
    let sent = processed[j]

    // 20% 概率在句首插入过渡词
    if (j > 0 && rng() < 0.2 && !sent.startsWith('"') && !sent.startsWith('"')) {
      sent = pick(AI_CONNECTORS, rng) + sent
    }

    // 15% 概率插入过渡短语
    if (j > 0 && rng() < 0.15 && !sent.startsWith('"') && !sent.startsWith('"')) {
      sent = pick(AI_TRANSITION_PHRASES, rng) + sent.charAt(0).toLowerCase() + sent.slice(1)
    }

    result.push(sent)
  }

  text = result.join('')

  // 4. 替换描写为 AI 微动作模板（15% 的非对话句）
  const lines = text.split('\n')
  const finalLines = []
  for (const line of lines) {
    let l = line
    if (!l.startsWith('"') && !l.startsWith('"') && l.length > 15 && rng() < 0.15) {
      const action = pick(AI_MICRO_ACTIONS, rng)
      // 在句中或句末插入微动作
      const insertPos = l.lastIndexOf('，')
      if (insertPos > 5 && insertPos < l.length - 5) {
        l = l.slice(0, insertPos) + '，' + action + '，' + l.slice(insertPos + 1)
      }
    }
    finalLines.push(l)
  }
  text = finalLines.join('\n')

  // 5. 将部分比喻改为"仿佛/犹如"句式
  text = text.replace(/好像(.{2,12}?)似的/g, (_, content) => {
    if (rng() < 0.6) {
      const tmpl = pick(SIMILE_TEMPLATES, rng)
      return tmpl.replace('{0}', content)
    }
    return _
  })

  // 6. 替换不规则标点为规范标点
  text = text.replace(/——/g, '，')
  text = text.replace(/…{2,}/g, '……')

  // 7. 将换行合并（AI 倾向不分段，写成连续文本）
  if (rng() < 0.6) {
    text = text.replace(/\n+/g, '')
  }

  // 8. 在对话前后添加 AI 模板化叙述
  const dialogueNarrations = [
    '他的声音带着一丝不易察觉的颤抖。',
    '她的目光在他脸上停留了片刻。',
    '空气中弥漫着一种微妙的紧张感。',
    '周围的一切仿佛都静止了下来。',
    '他的眼神中闪过一丝复杂的情绪。',
    '她的嘴角微微上扬，带着一抹意味深长的笑意。',
    '沉默在两人之间蔓延开来。',
    '他深吸一口气，似乎在压抑着什么。',
  ]
  if (rng() < 0.3) {
    text = text + pick(dialogueNarrations, rng)
  }

  return text
}

// ─── 文本采样 ───

function loadAndSample(filePath, count, rng) {
  console.log(`  读取: ${path.basename(filePath)}`)
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n')

  // 跳过开头的简介/目录部分
  let startLine = 0
  for (let i = 0; i < Math.min(50, lines.length); i++) {
    if (lines[i].match(/^第[一二三四五六七八九十百千\d]+[章卷节]/)) {
      startLine = i
      break
    }
  }

  // 检测文件格式：是否使用全角空格缩进（如凡人修仙传）
  let indentedLineCount = 0
  let blankLineCount = 0
  const sampleEnd = Math.min(startLine + 200, lines.length)
  for (let i = startLine; i < sampleEnd; i++) {
    if (lines[i].startsWith('\u3000\u3000')) indentedLineCount++
    if (!lines[i].trim()) blankLineCount++
  }
  const isIndentedFormat = indentedLineCount > (sampleEnd - startLine) * 0.3

  const paragraphs = []

  if (isIndentedFormat) {
    // 凡人修仙传格式：每行是一个段落，用全角空格缩进
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i].replace(/^[\s\u3000]+/, '').trim()
      if (!line) continue
      if (line.match(/^第[一二三四五六七八九十百千万\d]+[章卷节]/) && line.length < 40) continue
      if (line.length < 5) continue
      paragraphs.push(line)
    }
  } else {
    // 我在精神病院学斩神格式：用空行分隔段落
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

  // 构造连续片段（3-8个段落组成一个训练样本）
  const segments = []
  const indices = shuffle(
    Array.from({ length: paragraphs.length - 5 }, (_, i) => i),
    rng
  )

  for (const startIdx of indices) {
    if (segments.length >= count) break

    // 取连续段落：缩进格式（每行较短）取更多行
    const paraCount = 3 + Math.floor(rng() * 8)
    const endIdx = Math.min(startIdx + paraCount, paragraphs.length)
    const text = paragraphs.slice(startIdx, endIdx).join('\n')

    // 过滤条件
    if (text.length < MIN_SEGMENT_CHARS) continue
    if (text.length > MAX_SEGMENT_CHARS) {
      // 截断到合理长度
      const sentences = splitSentences(text)
      let truncated = ''
      for (const s of sentences) {
        if (truncated.length + s.length > MAX_SEGMENT_CHARS) break
        truncated += s
      }
      if (truncated.length < MIN_SEGMENT_CHARS) continue
      const sCount = splitSentences(truncated).length
      if (sCount < MIN_SENTENCES) continue
      segments.push(truncated)
      continue
    }

    const sentenceCount = splitSentences(text).length
    if (sentenceCount < MIN_SENTENCES) continue

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
  console.log(`\n=== SFT 数据集生成器 ===`)
  console.log(`目标条数: ${count}`)
  console.log(`输出文件: ${output}\n`)

  const rng = seededRng(42)

  // 1. 从各来源采样人类文本
  const allHumanSegments = []
  for (const source of HUMAN_SOURCES) {
    if (!fs.existsSync(source.file)) {
      console.warn(`  警告: 文件不存在 ${source.file}，跳过`)
      continue
    }
    const perSource = Math.ceil(count * source.weight * 1.2) // 多采 20% 备用
    const segments = loadAndSample(source.file, perSource, rng)
    allHumanSegments.push(...segments)
  }

  console.log(`\n总采样: ${allHumanSegments.length} 段\n`)

  // 洗牌
  const shuffled = shuffle(allHumanSegments, rng).slice(0, count)

  // 2. 生成训练数据
  const outputDir = path.dirname(output)
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  const fd = fs.openSync(output, 'w')
  let written = 0
  let totalHumanChars = 0
  let totalAiChars = 0

  for (const humanText of shuffled) {
    const aiText = aifyText(humanText, rng)

    // 跳过 AI 化变换幅度太小的样本（降低阈值以保留更多数据）
    const changeRatio = computeSimpleChangeRatio(humanText, aiText)
    if (changeRatio < 0.02) continue

    const entry = {
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: aiText },
        { role: 'assistant', content: humanText },
      ]
    }

    fs.writeSync(fd, JSON.stringify(entry) + '\n')
    written++
    totalHumanChars += humanText.length
    totalAiChars += aiText.length
  }

  fs.closeSync(fd)

  const avgHumanLen = Math.round(totalHumanChars / written)
  const avgAiLen = Math.round(totalAiChars / written)

  console.log(`=== 生成完成 ===`)
  console.log(`写入条数: ${written}`)
  console.log(`平均人类文本长度: ${avgHumanLen} 字`)
  console.log(`平均AI化文本长度: ${avgAiLen} 字`)
  console.log(`输出文件: ${output}`)
  console.log(`文件大小: ${(fs.statSync(output).size / 1024 / 1024).toFixed(2)} MB\n`)

  // 打印前 2 条样本预览
  const preview = fs.readFileSync(output, 'utf-8').split('\n').filter(Boolean).slice(0, 2)
  for (let i = 0; i < preview.length; i++) {
    const entry = JSON.parse(preview[i])
    console.log(`--- 样本 ${i + 1} ---`)
    console.log(`[User] ${entry.messages[1].content.slice(0, 120)}...`)
    console.log(`[Assistant] ${entry.messages[2].content.slice(0, 120)}...`)
    console.log()
  }
}

function computeSimpleChangeRatio(a, b) {
  const sa = a.replace(/\s+/g, '')
  const sb = b.replace(/\s+/g, '')
  if (!sa && !sb) return 0
  if (!sa || !sb) return 1
  const bigramsA = new Set()
  for (let i = 0; i < sa.length - 1; i++) bigramsA.add(sa[i] + sa[i + 1])
  let shared = 0
  const totalB = Math.max(1, sb.length - 1)
  for (let i = 0; i < sb.length - 1; i++) {
    if (bigramsA.has(sb[i] + sb[i + 1])) shared++
  }
  return 1 - shared / Math.max(bigramsA.size, totalB)
}

main()
