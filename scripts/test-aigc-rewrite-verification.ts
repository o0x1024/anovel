import assert from 'node:assert/strict'
import type { AigcDetectResult } from '../src/shared/aigc-detect-types'
import {
  evaluateAigcRewriteVerification,
  markAiAssistedRewrite,
  runBoundedRewriteAttempts
} from '../src/shared/aigc-rewrite-verification'

function result(overrides: Partial<AigcDetectResult> = {}): AigcDetectResult {
  return {
    segments: [{ text: '样本文本', category: 'human' }],
    distribution: { human: 85, suspected_ai: 15, ai: 0 },
    summary: '测试',
    diagnostics: {
      tokenPredictability: 0,
      sequenceRegularity: 0,
      informationUniformity: 0,
      causalClosure: 0,
      voiceStability: 0,
      templateDensity: 0,
      windowRiskP75: 0,
      peakWindowRisk: 0,
      highRiskWindowShare: 0,
      documentRisk: 0,
      detectorDisagreementShare: 40,
      reasons: []
    },
    ...overrides
  }
}

async function main(): Promise<void> {
assert.equal(evaluateAigcRewriteVerification(result()).passed, true, '边界值应允许自动应用')
assert.equal(evaluateAigcRewriteVerification(result({
  distribution: { human: 84.9, suspected_ai: 15.1, ai: 0 }
})).passed, false, '疑似AI覆盖超过15%必须拦截')
assert.equal(evaluateAigcRewriteVerification(result({
  segments: [{ text: '高风险句', category: 'ai' }],
  distribution: { human: 100, suspected_ai: 0, ai: 0 }
})).passed, false, '存在AI片段时不得只相信汇总舍入值')
assert.equal(evaluateAigcRewriteVerification(result({
  diagnostics: { ...result().diagnostics!, detectorDisagreementShare: 40.1 }
})).passed, false, '双检测器分歧过高必须转人工复核')
assert.equal(evaluateAigcRewriteVerification(result({ diagnostics: undefined })).passed, false, '诊断缺失必须失败关闭')

const marked = markAiAssistedRewrite(result(), 'full_document')
assert.equal(marked.authorship?.mode, 'ai_assisted')
assert.equal(marked.authorship?.method, 'full_document')
assert.match(marked.authorship?.note || '', /不代表人工作者身份/)

let earlyCalls = 0
const early = await runBoundedRewriteAttempts(3, async attemptNumber => {
  earlyCalls += 1
  return { accepted: attemptNumber === 2, value: attemptNumber }
})
assert.deepEqual(early, { accepted: true, attempts: 2, value: 2 })
assert.equal(earlyCalls, 2, '门禁通过后必须立即停止')

let boundedCalls = 0
const exhausted = await runBoundedRewriteAttempts(3, async attemptNumber => {
  boundedCalls += 1
  return { accepted: false, value: attemptNumber }
})
assert.deepEqual(exhausted, { accepted: false, attempts: 3, value: 3 })
assert.equal(boundedCalls, 3, '失败重试不得超过上限')

await assert.rejects(() => runBoundedRewriteAttempts(0, async () => ({ accepted: true, value: 1 })), /正整数/)

console.log('AIGC改写风险门禁与有界重试测试通过')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
