import assert from 'node:assert/strict'
import { BertWordPieceTokenizer } from '../src/main/supervised-aigc/wordpiece-tokenizer'

const tokenizer = new BertWordPieceTokenizer({
  model: {
    type: 'WordPiece',
    unk_token: '[UNK]',
    continuing_subword_prefix: '##',
    max_input_chars_per_word: 100,
    vocab: {
      '[PAD]': 0,
      '[UNK]': 100,
      '[CLS]': 101,
      '[SEP]': 102,
      '中': 200,
      '文': 201,
      'hello': 202,
      '##s': 203,
      '。': 204
    }
  }
})

const encoded = tokenizer.encode('中文 HELLOS。', 10)
assert.deepEqual(
  Array.from(encoded.inputIds.slice(0, encoded.tokenCount), Number),
  [101, 200, 201, 202, 203, 204, 102]
)
assert.deepEqual(
  Array.from(encoded.attentionMask.slice(0, encoded.tokenCount), Number),
  [1, 1, 1, 1, 1, 1, 1]
)
assert.equal(encoded.inputIds[9], 0n)

const unknown = tokenizer.encode('不存在', 8)
assert.ok(Array.from(unknown.inputIds).includes(100n))

const truncated = tokenizer.encode('中文中文中文中文中文', 5)
assert.equal(truncated.tokenCount, 5)
assert.equal(truncated.inputIds[4], 102n)

console.log('aigc supervised tokenizer tests passed')
