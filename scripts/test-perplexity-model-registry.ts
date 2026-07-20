import assert from 'node:assert/strict'
import {
  DEFAULT_MODEL_ID,
  PERPLEXITY_MODELS,
  PRODUCTION_DETECT_MODEL_ID,
  getDetectThresholds,
  getModelDef
} from '../src/main/perplexity/constants'

assert.equal(DEFAULT_MODEL_ID, 'qwen3.5-4b-q4', '中文AIGC检测基座必须是Qwen3.5 4B')
assert.equal(PRODUCTION_DETECT_MODEL_ID, DEFAULT_MODEL_ID, '正式检测基座必须固定为默认4B模型')
assert.equal(PERPLEXITY_MODELS[0]?.id, DEFAULT_MODEL_ID, '默认基座必须位于模型列表首位')
assert.match(getModelDef(DEFAULT_MODEL_ID).name, /推荐/, 'Qwen3.5 4B必须标记为推荐模型')
assert.equal(getModelDef(DEFAULT_MODEL_ID).sizeBytes, 2_740_937_888, '正式模型必须使用精确字节数校验')
assert.match(getModelDef(DEFAULT_MODEL_ID).sha256 || '', /^[a-f0-9]{64}$/, '正式模型必须登记SHA-256')
assert.ok(
  !PERPLEXITY_MODELS.some(model => model.id === 'minicpm3-4b-q4' || /MiniCPM/i.test(model.name)),
  'MiniCPM3 4B必须从产品模型注册表移除'
)
assert.throws(() => getModelDef('minicpm3-4b-q4'), /未知的困惑度检测模型/)

const thresholds = getDetectThresholds(DEFAULT_MODEL_ID)
assert.deepEqual(thresholds.baseline, { ppl: 22.52, top5: 0.600, avgProb: 0.320 })
assert.deepEqual(thresholds.classify, { aiFloor: 68, humanCeiling: 40 })

console.log('困惑度检测模型注册策略测试通过：Qwen3.5 4B为基座，MiniCPM已移除')
