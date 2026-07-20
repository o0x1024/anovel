import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  validateZhuqueExperimentCorpus,
  ZHUQUE_EXPERIMENT_SAMPLES
} from './zhuque-experiment-corpus'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

assert.deepEqual(validateZhuqueExperimentCorpus(), [])
assert.ok(ZHUQUE_EXPERIMENT_SAMPLES.filter(sample => sample.usage === 'calibration').length >= 8)
assert.ok(ZHUQUE_EXPERIMENT_SAMPLES.filter(sample => sample.usage === 'holdout').length >= 15)
assert.ok(ZHUQUE_EXPERIMENT_SAMPLES.some(sample => sample.usage === 'blind'))
assert.ok(ZHUQUE_EXPERIMENT_SAMPLES.some(sample => sample.usage === 'robustness_only'))

for (const sample of ZHUQUE_EXPERIMENT_SAMPLES) {
  assert.ok(
    fs.existsSync(path.join(projectRoot, 'docs/experiments', sample.file)),
    `实验文件不存在：${sample.file}`
  )
}

const calibrationFiles = new Set(
  ZHUQUE_EXPERIMENT_SAMPLES.filter(sample => sample.usage === 'calibration').map(sample => sample.file)
)
for (const sample of ZHUQUE_EXPERIMENT_SAMPLES.filter(sample => sample.usage === 'blind')) {
  assert.ok(!calibrationFiles.has(sample.file), `盲测样本不得进入校准集：${sample.file}`)
}

console.log('朱雀实验语料分层契约通过', {
  calibration: ZHUQUE_EXPERIMENT_SAMPLES.filter(sample => sample.usage === 'calibration').length,
  holdout: ZHUQUE_EXPERIMENT_SAMPLES.filter(sample => sample.usage === 'holdout').length,
  blind: ZHUQUE_EXPERIMENT_SAMPLES.filter(sample => sample.usage === 'blind').length,
  robustnessOnly: ZHUQUE_EXPERIMENT_SAMPLES.filter(sample => sample.usage === 'robustness_only').length
})
