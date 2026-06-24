/**
 * SR30 突破实验：在 SR30 基底上叠加 n-gram 扰动，不使用人类文本
 *
 * U 系列: WS4 梯度搜索（全文 swap @ 8/12/16/20%）
 * V 系列: 选择性 WS4（仅叙述段落 swap @ 15/20%）
 * W 系列: WS2 分句打乱
 *
 * 用法:
 *   node scripts/sr30-breakthrough.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  hashSeed,
  createRng,
  splitSentences,
  splitClauses,
  shuffleParagraph,
  shuffleDocument,
} from './word-shuffle.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const experimentsDir = path.join(projectRoot, 'docs/experiments')

const INPUT = path.join(experimentsDir, 'SR30-F1-ai-novel.txt')

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

function swapDocument(text, rate, seed = hashSeed(text)) {
  return text
    .split('\n')
    .map((line, i) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      const rand = createRng((seed + i * 9973) >>> 0)
      const sentences = splitSentences(trimmed)
      return sentences.map(s => swapAdjacentWords(s, rand, rate)).join('')
    })
    .join('\n')
}

function swapDocumentSelective(text, rate, seed = hashSeed(text)) {
  return text
    .split('\n')
    .map((line, i) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (isDialogueLine(trimmed)) return line
      const rand = createRng((seed + i * 9973) >>> 0)
      const sentences = splitSentences(trimmed)
      return sentences.map(s => swapAdjacentWords(s, rand, rate)).join('')
    })
    .join('\n')
}

function clauseShuffleDocument(text, seed = hashSeed(text)) {
  return shuffleDocument(text, 'clause', seed)
}

function writeExperiment(name, content) {
  const outPath = path.join(experimentsDir, `${name}.txt`)
  fs.writeFileSync(outPath, content.endsWith('\n') ? content : content + '\n', 'utf8')
  const charCount = content.replace(/\s/g, '').length
  console.log(`  ✓ ${name} → ${outPath} (${charCount} 字)`)
}

function main() {
  const text = fs.readFileSync(INPUT, 'utf8').trimEnd()
  const seed = hashSeed(text)

  console.log(`输入: SR30-F1-ai-novel.txt (${text.replace(/\s/g, '').length} 字)\n`)

  // ── Phase A: U 系列 — WS4 梯度全文 swap ──
  console.log('Phase A: U 系列 — WS4 梯度全文 swap')
  const uRates = [
    ['U1', 0.08],
    ['U2', 0.12],
    ['U3', 0.16],
    ['U4', 0.20],
  ]
  for (const [label, rate] of uRates) {
    const out = swapDocument(text, rate, seed)
    writeExperiment(`${label}-SR30-swap${Math.round(rate * 100)}`, out)
  }

  // ── Phase B: V 系列 — 选择性 swap（仅叙述段落）──
  console.log('\nPhase B: V 系列 — 选择性 swap（仅叙述段落）')
  const vRates = [
    ['V1', 0.20],
    ['V2', 0.15],
  ]
  for (const [label, rate] of vRates) {
    const out = swapDocumentSelective(text, rate, seed)
    writeExperiment(`${label}-SR30-narr-swap${Math.round(rate * 100)}`, out)
  }

  // ── Phase C: W 系列 — WS2 分句打乱 ──
  console.log('\nPhase C: W 系列 — WS2 分句打乱')
  const w1 = clauseShuffleDocument(text, seed)
  writeExperiment('W1-SR30-clause-shuffle', w1)

  console.log('\n完成！共生成 7 个实验文件。')
  console.log('\n测试优先级：U2 (12%) → U3 (16%) → V1 (选择性20%) → W1 (分句打乱)')
}

main()
