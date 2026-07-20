#!/usr/bin/env node

/**
 * 连续章节 SFT 数据集生成器。
 *
 * 输入必须是拥有合法训练权利的纯正文文件；脚本按章节先切分 train/validation/test，
 * 再在各自集合内构造“前文 -> 后续正文”样本，杜绝先采样后随机切分造成的相邻文本泄漏。
 *
 * 用法：
 *   node scripts/gen-sft-dataset.mjs --source corpus/book-a.txt --source corpus/book-b.txt
 *   node scripts/gen-sft-dataset.mjs --source-dir corpus --out-dir datasets/continuation
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const SYSTEM_PROMPT = [
  '你正在续写一部小说。',
  '只根据给出的连续前文续写正文，不总结前文，不解释写法，不输出标题。',
  '沿用前文自然形成的用词、注意力、叙述距离、信息释放和角色声线。',
  '不得照搬前文句子；后续事件必须从前文状态自然发生。'
].join('\n')

function parseArgs(argv) {
  const options = {
    sources: [],
    sourceDir: '',
    outDir: path.resolve('datasets/continuation'),
    contextChars: 1800,
    targetChars: 650,
    strideChars: 520,
    leakageChars: 80
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = argv[i + 1]
    if (arg === '--source' && value) options.sources.push(path.resolve(value)), i++
    else if (arg === '--source-dir' && value) options.sourceDir = path.resolve(value), i++
    else if (arg === '--out-dir' && value) options.outDir = path.resolve(value), i++
    else if (arg === '--context-chars' && value) options.contextChars = Number(value), i++
    else if (arg === '--target-chars' && value) options.targetChars = Number(value), i++
    else if (arg === '--stride-chars' && value) options.strideChars = Number(value), i++
    else if (arg === '--leakage-chars' && value) options.leakageChars = Number(value), i++
    else if (arg === '--help') return { ...options, help: true }
    else if (arg.startsWith('--')) throw new Error(`未知参数：${arg}`)
  }
  return options
}

function usage() {
  console.log('用法: node scripts/gen-sft-dataset.mjs --source <正文.txt> [--source ...] [--out-dir datasets/continuation]')
  console.log('或:   node scripts/gen-sft-dataset.mjs --source-dir <纯正文目录>')
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function normalizeText(raw) {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function isNoiseLine(line) {
  const value = line.trim()
  if (!value) return false
  return /^(?:本章完|未完待续|作者的话|作家说|PS[:：]|求收藏|求推荐|求月票|请牢记|最新网址|手机用户请|加入书签|返回目录)/i.test(value) ||
    /(?:https?:\/\/|www\.|公众号|QQ群|加群|下载APP|本书首发)/i.test(value)
}

function cleanSource(raw) {
  return normalizeText(raw.split('\n').filter(line => !isNoiseLine(line)).join('\n'))
}

function splitChapters(text) {
  const heading = /^(第[零〇一二三四五六七八九十百千万两\d]+[章回节卷部][^\n]{0,50})$/gm
  const matches = [...text.matchAll(heading)]
  if (matches.length < 3) {
    const chunks = []
    const chunkSize = 7000
    for (let start = 0; start < text.length; start += chunkSize) {
      const content = text.slice(start, start + chunkSize).trim()
      if (content.length >= 1200) chunks.push({ title: `连续块${chunks.length + 1}`, content })
    }
    return chunks
  }

  const chapters = []
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index + matches[i][0].length
    const end = matches[i + 1]?.index ?? text.length
    const content = text.slice(start, end).trim()
    if (content.length >= 500) chapters.push({ title: matches[i][1].trim(), content })
  }
  return chapters
}

function assignSplit(index, count) {
  const testCount = Math.max(1, Math.floor(count * 0.1))
  const validationCount = Math.max(1, Math.floor(count * 0.1))
  const trainEnd = count - testCount - validationCount
  if (index < trainEnd) return 'train'
  if (index < count - testCount) return 'validation'
  return 'test'
}

function cutAtSentence(text, desired, minimum) {
  if (text.length <= desired) return text
  const lower = Math.max(minimum, Math.floor(desired * 0.72))
  for (let i = desired; i >= lower; i--) {
    if (/[。！？!?；;]/.test(text[i])) return text.slice(0, i + 1)
  }
  return text.slice(0, desired)
}

function buildSamples(sourceId, chapter, chapterIndex, split, options) {
  const samples = []
  const text = chapter.content
  let targetStart = Math.min(options.contextChars, Math.floor(text.length * 0.35))
  while (targetStart + 180 <= text.length) {
    const contextStart = Math.max(0, targetStart - options.contextChars)
    const context = text.slice(contextStart, targetStart).trim()
    const target = cutAtSentence(text.slice(targetStart), options.targetChars, 220).trim()
    if (context.length >= 300 && target.length >= 180) {
      const id = sha256(`${sourceId}:${chapterIndex}:${targetStart}:${context}:${target}`).slice(0, 20)
      samples.push({
        id,
        sourceId,
        chapterIndex,
        chapterTitle: chapter.title,
        split,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `【连续前文】\n${context}` },
          { role: 'assistant', content: target }
        ]
      })
    }
    targetStart += options.strideChars
  }
  return samples
}

function collectSources(options) {
  const files = [...options.sources]
  if (options.sourceDir) {
    if (!fs.existsSync(options.sourceDir)) throw new Error(`语料目录不存在：${options.sourceDir}`)
    for (const entry of fs.readdirSync(options.sourceDir, { withFileTypes: true })) {
      if (entry.isFile() && /\.(txt|md)$/i.test(entry.name)) files.push(path.join(options.sourceDir, entry.name))
    }
  }
  return [...new Set(files)].sort()
}

function ngrams(text, size) {
  const clean = text.replace(/\s/g, '')
  const values = new Set()
  for (let i = 0; i + size <= clean.length; i++) values.add(clean.slice(i, i + size))
  return values
}

function findLeakage(splits, size) {
  const heldOut = new Map()
  for (const split of ['validation', 'test']) {
    for (const sample of splits[split]) {
      const target = sample.messages[2].content
      for (const gram of ngrams(target, size)) {
        if (!heldOut.has(gram)) heldOut.set(gram, `${split}:${sample.id}`)
      }
    }
  }
  const leaks = []
  for (const sample of splits.train) {
    const target = sample.messages[2].content
    for (const gram of ngrams(target, size)) {
      const match = heldOut.get(gram)
      if (match) {
        leaks.push({ train: sample.id, heldOut: match, excerpt: gram })
        break
      }
    }
  }
  return leaks
}

function writeJsonl(file, samples) {
  const lines = samples.map(({ messages }) => JSON.stringify({ messages }))
  fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) return usage()
  const files = collectSources(options)
  if (files.length === 0) throw new Error('必须通过 --source 或 --source-dir 提供拥有合法训练权利的正文语料')
  if ([options.contextChars, options.targetChars, options.strideChars, options.leakageChars].some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('长度参数必须是正数')
  }

  const splits = { train: [], validation: [], test: [] }
  const sources = []
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error(`语料不存在：${file}`)
    const cleaned = cleanSource(fs.readFileSync(file, 'utf8'))
    const chapters = splitChapters(cleaned).filter(chapter =>
      chapter.content.length >= Math.max(800, Math.floor(options.contextChars * 0.7) + 220)
    )
    if (chapters.length < 3) throw new Error(`语料无法形成至少3个连续章节/文本块：${file}`)
    const sourceId = sha256(`${path.basename(file)}:${cleaned}`).slice(0, 16)
    const sourceRecord = { sourceId, file: path.resolve(file), sha256: sha256(cleaned), chapters: chapters.length }
    sources.push(sourceRecord)
    chapters.forEach((chapter, index) => {
      const split = assignSplit(index, chapters.length)
      splits[split].push(...buildSamples(sourceId, chapter, index, split, options))
    })
  }

  for (const split of Object.keys(splits)) {
    const seen = new Set()
    splits[split] = splits[split].filter(sample => {
      const hash = sha256(sample.messages[2].content.replace(/\s/g, ''))
      if (seen.has(hash)) return false
      seen.add(hash)
      return true
    })
  }

  if (splits.train.length === 0 || splits.validation.length === 0 || splits.test.length === 0) {
    throw new Error(`切分后样本不足：train=${splits.train.length}, validation=${splits.validation.length}, test=${splits.test.length}`)
  }
  const leaks = findLeakage(splits, options.leakageChars)
  if (leaks.length > 0) {
    throw new Error(`发现 ${leaks.length} 个跨集合最长重合风险（>=${options.leakageChars}字），首例：${JSON.stringify(leaks[0])}`)
  }

  fs.mkdirSync(options.outDir, { recursive: true })
  for (const split of Object.keys(splits)) writeJsonl(path.join(options.outDir, `${split}.jsonl`), splits[split])
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    task: 'continuous-fiction-completion',
    splitPolicy: 'chapter-first-contiguous-80-10-10',
    leakageGateChars: options.leakageChars,
    options: {
      contextChars: options.contextChars,
      targetChars: options.targetChars,
      strideChars: options.strideChars
    },
    counts: Object.fromEntries(Object.entries(splits).map(([key, value]) => [key, value.length])),
    sources
  }
  fs.writeFileSync(path.join(options.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(JSON.stringify(manifest, null, 2))
}

main()
