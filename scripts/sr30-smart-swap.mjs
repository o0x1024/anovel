/**
 * 策略 B：受保护智能 swap
 *
 * 保护人名/量词/固定搭配不被交换，其余词对以 55% 的交换率执行 swap。
 * 仅作用于叙述段落，对话保持不动。
 *
 * 用法: node scripts/sr30-smart-swap.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { hashSeed, createRng, splitSentences } from './word-shuffle.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const experimentsDir = path.join(projectRoot, 'docs/experiments')
const INPUT = path.join(experimentsDir, 'SR30-F1-ai-novel.txt')

const NAME_CHARS = new Set([
  '林', '晚', '苏', '糖',
])

const PROTECTED_SINGLE = new Set([
  '三', '两', '一', '几', '半',
  '不', '没', '别',
])

const PROTECTED_WORDS = new Set([
  '林晚', '苏糖', '男生', '学弟', '外婆', '晚晚糕',
  '忍不住', '一时半会', '不自在', '整整齐齐', '回过神',
  '猫爬架', '螺丝刀', '工具箱', '全家福',
  '同城', '快递', '签收码',
  '白猫', '黑猫', '橘猫', '英短', '流浪猫',
  '相册', '相框', '羊角辫', '猫粮', '桃花运',
])

function isDialogueLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return false
  if (/^["\u201c\u300c]/.test(trimmed)) return true
  if (trimmed.length <= 6) return true
  return false
}

function isProtectedToken(word) {
  if (NAME_CHARS.has(word)) return true
  if (word.length === 1 && PROTECTED_SINGLE.has(word)) return true
  if (PROTECTED_WORDS.has(word)) return true
  return false
}

function smartSwap(sentence, rand, rate) {
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
  const tokens = [...segmenter.segment(sentence)].map(s => ({
    text: s.segment,
    word: s.isWordLike,
  }))
  if (tokens.length <= 2) return sentence

  const wordIdx = tokens.map((t, i) => (t.word ? i : -1)).filter(i => i >= 0)
  if (wordIdx.length <= 1) return sentence

  for (let k = 0; k < wordIdx.length - 1; k++) {
    if (k === 0) continue

    const a = wordIdx[k]
    const b = wordIdx[k + 1]
    const wordA = tokens[a].text
    const wordB = tokens[b].text

    if (isProtectedToken(wordA) || isProtectedToken(wordB)) continue
    if (rand() > rate) continue

    ;[tokens[a].text, tokens[b].text] = [tokens[b].text, tokens[a].text]
  }

  return tokens.map(t => t.text).join('')
}

function main() {
  const text = fs.readFileSync(INPUT, 'utf8').trimEnd()
  const seed = hashSeed(text)

  console.log(`输入: SR30-F1-ai-novel.txt (${text.replace(/\s/g, '').length} 字)\n`)

  const rates = [
    ['SB1', 0.55],
    ['SB2', 0.65],
  ]

  for (const [label, rate] of rates) {
    const out = text.split('\n').map((line, i) => {
      const trimmed = line.trim()
      if (!trimmed) return line
      if (isDialogueLine(trimmed)) return line
      const rand = createRng((seed + i * 9973) >>> 0)
      return splitSentences(trimmed).map(s => smartSwap(s, rand, rate)).join('')
    }).join('\n')

    const outPath = path.join(experimentsDir, `${label}-SR30-smart-swap.txt`)
    fs.writeFileSync(outPath, out + '\n', 'utf8')
    console.log(`✓ ${label} (rate=${rate}) → ${outPath}`)
  }

  console.log('\n完成！')
}

main()
