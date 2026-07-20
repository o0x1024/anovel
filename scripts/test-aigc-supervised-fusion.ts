import assert from 'node:assert/strict'
import { fuseAigcDetection } from '../src/main/context/lab/aigc-detect-fusion'
import type { AigcDetectResult } from '../src/shared/aigc-detect-types'
import type { SupervisedAigcResult } from '../src/main/supervised-aigc'

function statistical(risks: number[], tokenPredictability = 95, documentRisk = 0): AigcDetectResult {
  return {
    segments: risks.map((risk, index) => ({
      text: `第${index + 1}段测试文本。`,
      category: risk >= 65 ? 'ai' : risk >= 38 ? 'suspected_ai' : 'human',
      riskScore: risk,
      reason: '统计证据'
    })),
    distribution: { human: 100, suspected_ai: 0, ai: 0 },
    summary: '统计检测',
    diagnostics: {
      tokenPredictability,
      sequenceRegularity: 0,
      informationUniformity: 0,
      causalClosure: 0,
      voiceStability: 0,
      templateDensity: 0,
      windowRiskP75: 0,
      peakWindowRisk: 0,
      highRiskWindowShare: 0,
      documentRisk,
      reasons: []
    }
  }
}

function supervised(probabilities: number[]): SupervisedAigcResult {
  return {
    modelId: 'aigc-detector-zh-v3-int8',
    windowCount: 1,
    documentAiProbability: probabilities.reduce((a, b) => a + b, 0) / probabilities.length,
    segments: probabilities.map((aiProbability, index) => ({
      text: `第${index + 1}段测试文本。`,
      aiProbability,
      humanProbability: 1 - aiProbability
    }))
  }
}

const recoveredFalseNegative = fuseAigcDetection(statistical([14]), supervised([1]))
assert.notEqual(recoveredFalseNegative.segments[0].category, 'human')
assert.equal(recoveredFalseNegative.distribution.human, 0)
assert.match(recoveredFalseNegative.segments[0].reason || '', /正证据/)

const agreement = fuseAigcDetection(statistical([78]), supervised([0.92]))
assert.equal(agreement.segments[0].category, 'ai')
assert.ok((agreement.segments[0].riskScore || 0) >= 65)

const protectedHuman = fuseAigcDetection(statistical([16]), supervised([0.08]))
assert.equal(protectedHuman.segments[0].category, 'human')

const conflictingFalsePositive = fuseAigcDetection(statistical([90]), supervised([0.05]))
assert.equal(conflictingFalsePositive.segments[0].category, 'ai')
assert.equal(conflictingFalsePositive.segments[0].riskScore, 90)

const lowSupervisedScoreCannotExonerate = fuseAigcDetection(statistical([78]), supervised([0.08]))
assert.equal(lowSupervisedScoreCannotExonerate.segments[0].riskScore, 78)

const lowSupervisedScoreCannotCreateRisk = fuseAigcDetection(statistical([14]), supervised([0.44]))
assert.equal(lowSupervisedScoreCannotCreateRisk.segments[0].riskScore, 14)

const currentZhuqueSuspectedBoundary = fuseAigcDetection(
  statistical([82], 81.4),
  supervised([0.034])
)
assert.equal(currentZhuqueSuspectedBoundary.segments[0].category, 'suspected_ai')
assert.equal(currentZhuqueSuspectedBoundary.distribution.ai, 0)
assert.match(currentZhuqueSuspectedBoundary.segments[0].reason || '', /均未达到AI特征门槛/)

const currentZhuqueAiAnchor = fuseAigcDetection(
  statistical([50], 95.6),
  supervised([0.084])
)
assert.equal(currentZhuqueAiAnchor.segments[0].category, 'ai')
assert.equal(currentZhuqueAiAnchor.distribution.suspected_ai, 0)
assert.match(currentZhuqueAiAnchor.segments[0].reason || '', /词语可预测性 95.6 达到 90/)

const verifiedHumanPattern = fuseAigcDetection(
  statistical([20], 33, 25.7),
  supervised([0.038])
)
assert.equal(verifiedHumanPattern.segments[0].category, 'human')
assert.equal(verifiedHumanPattern.distribution.ai, 0)

const verifiedJointEvidenceAiPattern = fuseAigcDetection(
  statistical([52], 22.3, 44.8),
  supervised([0.533])
)
assert.equal(verifiedJointEvidenceAiPattern.segments[0].category, 'ai')
assert.equal(verifiedJointEvidenceAiPattern.distribution.suspected_ai, 0)
assert.match(verifiedJointEvidenceAiPattern.segments[0].reason || '', /联合证据门槛/)

const verifiedStrongSupervisedAiPattern = fuseAigcDetection(
  statistical([52], 57.7, 23.5),
  supervised([0.969])
)
assert.equal(verifiedStrongSupervisedAiPattern.segments[0].category, 'ai')
assert.equal(verifiedStrongSupervisedAiPattern.distribution.suspected_ai, 0)
assert.match(verifiedStrongSupervisedAiPattern.segments[0].reason || '', /强证据门槛/)

assert.throws(
  () => fuseAigcDetection({ ...statistical([80]), diagnostics: undefined }, supervised([0.1])),
  /缺少词语可预测性/
)

assert.throws(
  () => fuseAigcDetection({
    ...statistical([80]),
    diagnostics: { ...statistical([80]).diagnostics!, documentRisk: undefined as unknown as number }
  }, supervised([0.1])),
  /缺少整篇结构风险/
)

assert.throws(
  () => fuseAigcDetection(statistical([10, 20]), supervised([0.2])),
  /片段.*不一致/
)

console.log('aigc supervised fusion tests passed')
