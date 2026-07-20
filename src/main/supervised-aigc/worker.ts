import { parentPort, workerData } from 'worker_threads'
import * as ort from 'onnxruntime-node'
import { BertWordPieceTokenizer } from './wordpiece-tokenizer'
import { SUPERVISED_AIGC_MODEL } from './constants'

interface WorkerData {
  modelPath: string
  tokenizerPath: string
}

interface DetectRequest {
  type: 'detect'
  requestId: number
  texts: string[]
}

function softmaxPair(humanLogit: number, aiLogit: number) {
  const maximum = Math.max(humanLogit, aiLogit)
  const human = Math.exp(humanLogit - maximum)
  const ai = Math.exp(aiLogit - maximum)
  const total = human + ai
  return { human: human / total, ai: ai / total }
}

async function main() {
  const data = workerData as WorkerData
  const tokenizer = BertWordPieceTokenizer.fromFile(data.tokenizerPath)
  const session = await ort.InferenceSession.create(data.modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all'
  })
  parentPort?.postMessage({ type: 'ready' })
  parentPort?.on('message', async (request: DetectRequest) => {
    if (request.type !== 'detect') return
    try {
      const scores = []
      for (const text of request.texts) {
        const encoded = tokenizer.encode(text, SUPERVISED_AIGC_MODEL.maxTokens)
        const dimensions = [1, SUPERVISED_AIGC_MODEL.maxTokens]
        const output = await session.run({
          input_ids: new ort.Tensor('int64', encoded.inputIds, dimensions),
          attention_mask: new ort.Tensor('int64', encoded.attentionMask, dimensions),
          token_type_ids: new ort.Tensor('int64', encoded.tokenTypeIds, dimensions)
        })
        const logits = output.logits?.data
        if (!logits || logits.length < 2) throw new Error('中文监督模型没有返回二分类 logits')
        scores.push({ ...softmaxPair(Number(logits[0]), Number(logits[1])), tokenCount: encoded.tokenCount })
      }
      parentPort?.postMessage({ type: 'result', requestId: request.requestId, scores })
    } catch (error) {
      parentPort?.postMessage({
        type: 'error',
        requestId: request.requestId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })
}

main().catch(error => {
  parentPort?.postMessage({ type: 'error', requestId: 0, message: error instanceof Error ? error.message : String(error) })
})
