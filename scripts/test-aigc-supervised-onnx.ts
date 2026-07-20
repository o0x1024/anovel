import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as ort from 'onnxruntime-node'
import { BertWordPieceTokenizer } from '../src/main/supervised-aigc/wordpiece-tokenizer'

const modelPath = process.argv[2]
const tokenizerPath = process.argv[3]
if (!modelPath || !tokenizerPath) {
  throw new Error('用法: jiti scripts/test-aigc-supervised-onnx.ts <model.onnx> <tokenizer.json>')
}

async function main() {
  const tokenizer = BertWordPieceTokenizer.fromFile(tokenizerPath)
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
  assert.deepEqual(session.inputNames, ['input_ids', 'attention_mask', 'token_type_ids'])
  assert.deepEqual(session.outputNames, ['logits'])

  const text = process.argv[4]
    ? fs.readFileSync(process.argv[4], 'utf8')
    : '人工写作通常会留下作者个人经验、语气变化和不完全规整的表达。'
  const encoded = tokenizer.encode(text, 512)
  const dimensions = [1, 512]
  const result = await session.run({
    input_ids: new ort.Tensor('int64', encoded.inputIds, dimensions),
    attention_mask: new ort.Tensor('int64', encoded.attentionMask, dimensions),
    token_type_ids: new ort.Tensor('int64', encoded.tokenTypeIds, dimensions)
  })
  assert.equal(result.logits.dims[0], 1)
  assert.equal(result.logits.dims[1], 2)
  assert.ok(result.logits.data.every(value => Number.isFinite(Number(value))))
  const logits = Array.from(result.logits.data, Number)
  const maximum = Math.max(...logits)
  const exponentials = logits.map(value => Math.exp(value - maximum))
  const aiProbability = exponentials[1] / (exponentials[0] + exponentials[1])
  console.log('aigc supervised ONNX smoke test passed', { logits, aiProbability })
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
