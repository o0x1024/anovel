import fs from 'fs'

interface TokenizerJson {
  model: {
    type: 'WordPiece'
    unk_token: string
    continuing_subword_prefix: string
    max_input_chars_per_word: number
    vocab: Record<string, number>
  }
}

export interface BertModelInputs {
  inputIds: BigInt64Array
  attentionMask: BigInt64Array
  tokenTypeIds: BigInt64Array
  tokenCount: number
}

const CONTROL_CHARACTER = /[\u0000\uFFFD]/g
const WHITESPACE = /\s/u
const PUNCTUATION = /[!-/:-@[-`{-~\u2000-\u206F\u3000-\u303F\uFF01-\uFF65]/u
const CJK_CHARACTER = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u

function cleanAndSplit(text: string): string[] {
  const normalized = text
    .replace(CONTROL_CHARACTER, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
  const tokens: string[] = []
  let buffer = ''
  const flush = () => {
    if (buffer) tokens.push(buffer)
    buffer = ''
  }
  for (const char of normalized) {
    if (WHITESPACE.test(char)) {
      flush()
    } else if (CJK_CHARACTER.test(char) || PUNCTUATION.test(char)) {
      flush()
      tokens.push(char)
    } else {
      buffer += char
    }
  }
  flush()
  return tokens
}

export class BertWordPieceTokenizer {
  private readonly vocabulary: Record<string, number>
  private readonly unknownId: number
  private readonly prefix: string
  private readonly maxWordLength: number
  private readonly clsId: number
  private readonly sepId: number
  private readonly padId: number

  constructor(config: TokenizerJson) {
    if (config.model.type !== 'WordPiece') throw new Error('中文检测模型分词器不是 WordPiece')
    this.vocabulary = config.model.vocab
    this.unknownId = this.requiredId(config.model.unk_token)
    this.prefix = config.model.continuing_subword_prefix || '##'
    this.maxWordLength = config.model.max_input_chars_per_word || 100
    this.clsId = this.requiredId('[CLS]')
    this.sepId = this.requiredId('[SEP]')
    this.padId = this.requiredId('[PAD]')
  }

  static fromFile(filePath: string): BertWordPieceTokenizer {
    return new BertWordPieceTokenizer(JSON.parse(fs.readFileSync(filePath, 'utf8')) as TokenizerJson)
  }

  encode(text: string, maxTokens = 512): BertModelInputs {
    if (maxTokens < 2) throw new Error('BERT 最大 token 数必须至少为 2')
    const ids: number[] = [this.clsId]
    for (const token of cleanAndSplit(text)) {
      if (ids.length >= maxTokens - 1) break
      const pieces = this.wordPiece(token)
      for (const piece of pieces) {
        if (ids.length >= maxTokens - 1) break
        ids.push(piece)
      }
    }
    ids.push(this.sepId)

    const inputIds = new BigInt64Array(maxTokens)
    const attentionMask = new BigInt64Array(maxTokens)
    const tokenTypeIds = new BigInt64Array(maxTokens)
    inputIds.fill(BigInt(this.padId))
    for (let index = 0; index < ids.length; index++) {
      inputIds[index] = BigInt(ids[index])
      attentionMask[index] = 1n
    }
    return { inputIds, attentionMask, tokenTypeIds, tokenCount: ids.length }
  }

  private requiredId(token: string): number {
    const id = this.vocabulary[token]
    if (!Number.isInteger(id)) throw new Error(`中文检测分词器缺少 ${token}`)
    return id
  }

  private wordPiece(token: string): number[] {
    const characters = Array.from(token)
    if (characters.length > this.maxWordLength) return [this.unknownId]
    const result: number[] = []
    let start = 0
    while (start < characters.length) {
      let end = characters.length
      let matchedId: number | undefined
      while (start < end) {
        const raw = characters.slice(start, end).join('')
        const candidate = start === 0 ? raw : `${this.prefix}${raw}`
        const id = this.vocabulary[candidate]
        if (Number.isInteger(id)) {
          matchedId = id
          break
        }
        end--
      }
      if (matchedId === undefined) return [this.unknownId]
      result.push(matchedId)
      start = end
    }
    return result
  }
}
