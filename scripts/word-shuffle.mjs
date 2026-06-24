import path from 'path'
import { fileURLToPath } from 'url'

/**
 * 词级/短语级打乱工具（语义保留版）
 *
 * 模式:
 *   full   — 段内 token 全打乱（破坏语义，朱雀易判 100% 人工）
 *   clause — 句内逗号分句打乱（保留句序，语义基本可读）
 *   phrase — 句内分词短语块打乱（保留助词附着，语义可读）
 *   swap   — 句内随机相邻词对交换（轻度扰动，统计特征几乎不变）
 */

const OPEN_QUOTES = new Set(['"', '"', '\u2018', '\u201c', '\u300c', '\u300e'])
const CLOSE_QUOTES = new Set(['"', '"', '\u2019', '\u201d', '\u300d', '\u300f'])

const PARTICLE_RE = /^[的了地得着过吗呢吧啊呀嘛]$/
const CLAUSE_BREAK = /[，、；]/

export function hashSeed(text) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function createRng(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return state / 0x100000000
  }
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function quoteDelta(ch) {
  if (OPEN_QUOTES.has(ch)) return 1
  if (CLOSE_QUOTES.has(ch)) return -1
  return 0
}

/** 按句号切分，引号内不切 */
export function splitSentences(text) {
  const parts = []
  let cur = ''
  let depth = 0
  for (const ch of text) {
    cur += ch
    depth += quoteDelta(ch)
    if (depth < 0) depth = 0
    if (depth === 0 && /[。！？；]/.test(ch)) {
      parts.push(cur)
      cur = ''
    }
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

/** 句内按逗号切分，引号内不切 */
export function splitClauses(sentence) {
  const parts = []
  let cur = ''
  let depth = 0
  for (const ch of sentence) {
    cur += ch
    depth += quoteDelta(ch)
    if (depth < 0) depth = 0
    if (depth === 0 && CLAUSE_BREAK.test(ch)) {
      parts.push(cur)
      cur = ''
    }
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

function getSegmenter() {
  return new Intl.Segmenter('zh-CN', { granularity: 'word' })
}

/** 将分词结果聚成短语块（助词/单字虚词附着前词） */
export function groupPhrases(text) {
  const segmenter = getSegmenter()
  const groups = []
  let phrase = ''

  for (const seg of segmenter.segment(text)) {
    if (!seg.isWordLike) {
      if (phrase) {
        groups.push({ kind: 'phrase', text: phrase })
        phrase = ''
      }
      groups.push({ kind: 'punct', text: seg.segment })
      continue
    }

    const w = seg.segment
    if (
      phrase &&
      (PARTICLE_RE.test(w) || (w.length === 1 && /[的地得]/.test(w)))
    ) {
      phrase += w
    } else {
      if (phrase) groups.push({ kind: 'phrase', text: phrase })
      phrase = w
    }
  }

  if (phrase) groups.push({ kind: 'phrase', text: phrase })
  return groups
}

function shufflePhraseGroups(groups, rand) {
  const phrases = groups.filter(g => g.kind === 'phrase').map(g => g.text)
  if (phrases.length <= 1) return groups.map(g => g.text).join('')

  const shuffled = shuffleInPlace([...phrases], rand)
  let idx = 0
  return groups
    .map(g => (g.kind === 'phrase' ? shuffled[idx++] : g.text))
    .join('')
}

function shuffleClausesInSentence(sentence, rand) {
  const clauses = splitClauses(sentence)
  if (clauses.length <= 1) return sentence
  return shuffleInPlace([...clauses], rand).join('')
}

function shufflePhrasesInSentence(sentence, rand) {
  return shufflePhraseGroups(groupPhrases(sentence), rand)
}

function shuffleAdjacentSwaps(sentence, rand, rate = 0.32) {
  const segmenter = getSegmenter()
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

function shuffleFullTokens(text, rand) {
  const segmenter = getSegmenter()
  const tokens = [...segmenter.segment(text)].map(s => s.segment)
  if (tokens.length <= 1) return text
  return shuffleInPlace([...tokens], rand).join('')
}

/**
 * 对一段（一行）文本做打乱
 */
export function shuffleParagraph(text, mode, seed = hashSeed(text)) {
  const trimmed = text.trim()
  if (!trimmed) return text
  const rand = createRng(seed)

  if (mode === 'full') {
    return shuffleFullTokens(trimmed, rand)
  }

  const sentences = splitSentences(trimmed)
  if (sentences.length === 0) return trimmed

  const shuffled = sentences.map(sentence => {
    switch (mode) {
      case 'clause':
        return shuffleClausesInSentence(sentence, rand)
      case 'phrase':
        return shufflePhrasesInSentence(sentence, rand)
      case 'swap':
        return shuffleAdjacentSwaps(sentence, rand)
      default:
        throw new Error(`未知模式: ${mode}`)
    }
  })

  return shuffled.join('')
}

export function shuffleDocument(text, mode, seed = hashSeed(text)) {
  return text
    .split('\n')
    .map((line, i) => shuffleParagraph(line, mode, (seed + i * 9973) >>> 0))
    .join('\n')
}

const MODES = ['full', 'clause', 'phrase', 'swap']

export function parseArgs(argv) {
  const args = { mode: 'phrase', input: '', output: '', seed: null }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode' || a === '-m') args.mode = argv[++i]
    else if (a === '--seed' || a === '-s') args.seed = Number(argv[++i])
    else if (a === '--help' || a === '-h') args.help = true
    else if (!args.input) args.input = a
    else args.output = a
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv)
  if (args.help || !args.input) {
    console.log(`用法: node scripts/word-shuffle.mjs [--mode ${MODES.join('|')}] <input> [output]`)
    process.exit(args.help ? 0 : 1)
  }

  if (!MODES.includes(args.mode)) {
    console.error(`mode 必须是: ${MODES.join(', ')}`)
    process.exit(1)
  }

  const fs = await import('fs')
  const text = fs.readFileSync(args.input, 'utf8')
  const seed = args.seed ?? hashSeed(text)
  const out = shuffleDocument(text, args.mode, seed)
  const target = args.output || args.input

  fs.writeFileSync(target, out.endsWith('\n') ? out : out + '\n', 'utf8')
  console.log(`已写入 ${target} (mode=${args.mode}, seed=${seed})`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
