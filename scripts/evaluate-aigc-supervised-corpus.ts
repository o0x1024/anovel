import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ort from 'onnxruntime-node'
import { buildSupervisedTextWindows } from '../src/main/supervised-aigc/text-windows'
import { BertWordPieceTokenizer } from '../src/main/supervised-aigc/wordpiece-tokenizer'
import {
  validateZhuqueExperimentCorpus,
  ZHUQUE_EXPERIMENT_SAMPLES,
  type ZhuqueExperimentSample
} from './zhuque-experiment-corpus'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const modelPath = process.argv[2]
const tokenizerPath = process.argv[3]
if (!modelPath || !tokenizerPath) {
  throw new Error('用法: jiti scripts/evaluate-aigc-supervised-corpus.ts <model.onnx> <tokenizer.json>')
}

interface EvaluationRow {
  sample: ZhuqueExperimentSample
  supervisedRisk: number
  expectedRisk: number
  windowCount: number
}

function softmaxAi(logits: ArrayLike<unknown>): number {
  const humanLogit = Number(logits[0])
  const aiLogit = Number(logits[1])
  const maximum = Math.max(humanLogit, aiLogit)
  const human = Math.exp(humanLogit - maximum)
  const ai = Math.exp(aiLogit - maximum)
  return ai / (human + ai)
}

function expectedRisk(sample: ZhuqueExperimentSample): number {
  return sample.expected.ai + sample.expected.suspected_ai * 0.5
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function meanAbsoluteError(rows: EvaluationRow[], transform = (value: number) => value): number {
  return rows.reduce(
    (sum, row) => sum + Math.abs(transform(row.supervisedRisk) - row.expectedRisk),
    0
  ) / Math.max(1, rows.length)
}

function fitAffine(rows: EvaluationRow[]): { scale: number; offset: number; mae: number } {
  let best = { scale: 1, offset: 0, mae: meanAbsoluteError(rows) }
  for (let scale = 0.2; scale <= 2.5; scale += 0.02) {
    for (let offset = -60; offset <= 60; offset += 1) {
      const mae = meanAbsoluteError(rows, value => clamp(value * scale + offset))
      if (mae < best.mae) best = { scale, offset, mae }
    }
  }
  return best
}

async function inferText(
  session: ort.InferenceSession,
  tokenizer: BertWordPieceTokenizer,
  text: string
): Promise<{ risk: number; windowCount: number }> {
  const windows = buildSupervisedTextWindows(text)
  let weightedRisk = 0
  let totalWeight = 0
  for (const window of windows) {
    const encoded = tokenizer.encode(window.text, 512)
    const dimensions = [1, 512]
    const output = await session.run({
      input_ids: new ort.Tensor('int64', encoded.inputIds, dimensions),
      attention_mask: new ort.Tensor('int64', encoded.attentionMask, dimensions),
      token_type_ids: new ort.Tensor('int64', encoded.tokenTypeIds, dimensions)
    })
    const weight = Math.max(1, window.text.replace(/\s/g, '').length)
    weightedRisk += softmaxAi(output.logits.data) * 100 * weight
    totalWeight += weight
  }
  return { risk: weightedRisk / totalWeight, windowCount: windows.length }
}

async function main() {
  const errors = validateZhuqueExperimentCorpus()
  if (errors.length > 0) throw new Error(errors.join('；'))
  const tokenizer = BertWordPieceTokenizer.fromFile(tokenizerPath)
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
  const rows: EvaluationRow[] = []
  for (const sample of ZHUQUE_EXPERIMENT_SAMPLES) {
    const text = fs.readFileSync(path.join(projectRoot, 'docs/experiments', sample.file), 'utf8')
    const inferred = await inferText(session, tokenizer, text)
    rows.push({
      sample,
      supervisedRisk: inferred.risk,
      expectedRisk: expectedRisk(sample),
      windowCount: inferred.windowCount
    })
  }

  const calibration = rows.filter(row => row.sample.usage === 'calibration')
  const holdout = rows.filter(row => row.sample.usage === 'holdout')
  const blind = rows.filter(row => row.sample.usage === 'blind')
  const robustness = rows.filter(row => row.sample.usage === 'robustness_only')
  const affine = fitAffine(calibration)
  const transform = (value: number) => clamp(value * affine.scale + affine.offset)

  for (const row of rows) {
    console.log([
      row.sample.usage.padEnd(15),
      row.sample.name.padEnd(12),
      `朱雀风险=${row.expectedRisk.toFixed(1).padStart(5)}`,
      `监督=${row.supervisedRisk.toFixed(1).padStart(5)}`,
      `校准后=${transform(row.supervisedRisk).toFixed(1).padStart(5)}`,
      `窗口=${row.windowCount}`
    ].join(' '))
  }
  console.log(JSON.stringify({
    definition: '朱雀风险 = AI特征 + 0.5 × 疑似AI',
    affine: {
      scale: Math.round(affine.scale * 1000) / 1000,
      offset: affine.offset,
      calibrationMae: Math.round(affine.mae * 10) / 10
    },
    rawMae: {
      calibration: Math.round(meanAbsoluteError(calibration) * 10) / 10,
      holdout: Math.round(meanAbsoluteError(holdout) * 10) / 10,
      blind: Math.round(meanAbsoluteError(blind) * 10) / 10,
      robustnessOnly: Math.round(meanAbsoluteError(robustness) * 10) / 10
    },
    calibratedMae: {
      holdout: Math.round(meanAbsoluteError(holdout, transform) * 10) / 10,
      blind: Math.round(meanAbsoluteError(blind, transform) * 10) / 10,
      robustnessOnly: Math.round(meanAbsoluteError(robustness, transform) * 10) / 10
    }
  }, null, 2))
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
