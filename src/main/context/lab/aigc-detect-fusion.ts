import type {
  AigcCategory,
  AigcDetectResult,
  AigcDistribution,
  AigcSegment
} from '../../../shared/aigc-detect-types'
import type { SupervisedAigcResult } from '../../supervised-aigc'

export const SUPERVISED_AIGC_FUSION_WEIGHT = 0.6
export const SUPERVISED_AIGC_POSITIVE_THRESHOLD = 45
export const SUPERVISED_AIGC_STRONG_THRESHOLD = 85
export const STRUCTURAL_AI_RISK_THRESHOLD = 40
export const DETECTOR_DISAGREEMENT_GAP = 40
export const ZHUQUE_AI_TOKEN_PREDICTABILITY_GATE = 90

interface AiCategoryGate {
  allowed: boolean
  evidence: string
}

function resolveAiCategoryGate(params: {
  tokenPredictability: number
  supervisedDocumentRisk: number
  documentRisk: number
}): AiCategoryGate {
  const { tokenPredictability, supervisedDocumentRisk, documentRisk } = params
  if (tokenPredictability >= ZHUQUE_AI_TOKEN_PREDICTABILITY_GATE) {
    return {
      allowed: true,
      evidence: `词语可预测性 ${round(tokenPredictability)} 达到 ${ZHUQUE_AI_TOKEN_PREDICTABILITY_GATE}`
    }
  }
  if (supervisedDocumentRisk >= SUPERVISED_AIGC_STRONG_THRESHOLD) {
    return {
      allowed: true,
      evidence: `中文监督整文AI ${round(supervisedDocumentRisk)}% 达到强证据门槛 ${SUPERVISED_AIGC_STRONG_THRESHOLD}%`
    }
  }
  if (
    supervisedDocumentRisk >= SUPERVISED_AIGC_POSITIVE_THRESHOLD &&
    documentRisk >= STRUCTURAL_AI_RISK_THRESHOLD
  ) {
    return {
      allowed: true,
      evidence: `中文监督整文AI ${round(supervisedDocumentRisk)}% 且整篇结构风险 ${round(documentRisk)} 达到联合证据门槛`
    }
  }
  return {
    allowed: false,
    evidence: `词语可预测性 ${round(tokenPredictability)}、中文监督整文AI ${round(supervisedDocumentRisk)}%、整篇结构风险 ${round(documentRisk)} 均未达到AI特征门槛`
  }
}

function categoryRisk(category: AigcCategory): number {
  if (category === 'ai') return 82
  if (category === 'suspected_ai') return 52
  return 20
}

function riskCategory(score: number): AigcCategory {
  if (score >= 65) return 'ai'
  if (score >= 38) return 'suspected_ai'
  return 'human'
}

function round(value: number, digits = 1): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function probabilities(score: number): AigcDistribution {
  if (score < 38) {
    const suspected = Math.max(0, score / 38 * 35)
    return { human: round(100 - suspected), suspected_ai: round(suspected), ai: 0 }
  }
  if (score < 65) {
    const ai = (score - 38) / 27 * 35
    return { human: 0, suspected_ai: round(100 - ai), ai: round(ai) }
  }
  const suspected = Math.max(0, (100 - score) / 35 * 40)
  return { human: 0, suspected_ai: round(suspected), ai: round(100 - suspected) }
}

function coverageDistribution(segments: AigcSegment[]): AigcDistribution {
  const counts: AigcDistribution = { human: 0, suspected_ai: 0, ai: 0 }
  let total = 0
  for (const segment of segments) {
    const weight = segment.text.replace(/\s/g, '').length
    counts[segment.category] += weight
    total += weight
  }
  if (total === 0) return { human: 100, suspected_ai: 0, ai: 0 }
  const human = round(counts.human / total * 100, 2)
  const ai = round(counts.ai / total * 100, 2)
  return { human, suspected_ai: round(100 - human - ai, 2), ai }
}

export function fuseAigcDetection(
  statistical: AigcDetectResult,
  supervised: SupervisedAigcResult
): AigcDetectResult {
  if (statistical.segments.length !== supervised.segments.length) {
    throw new Error(`检测融合失败：统计片段 ${statistical.segments.length} 与中文监督片段 ${supervised.segments.length} 不一致`)
  }
  const tokenPredictability = statistical.diagnostics?.tokenPredictability
  if (typeof tokenPredictability !== 'number') {
    throw new Error('检测融合失败：统计检测缺少词语可预测性')
  }
  const documentRisk = statistical.diagnostics?.documentRisk
  if (typeof documentRisk !== 'number') {
    throw new Error('检测融合失败：统计检测缺少整篇结构风险')
  }
  const supervisedDocumentRisk = supervised.documentAiProbability * 100
  const aiCategoryGate = resolveAiCategoryGate({
    tokenPredictability,
    supervisedDocumentRisk,
    documentRisk
  })
  let disagreementChars = 0
  let totalChars = 0
  const segments = statistical.segments.map((segment, index): AigcSegment => {
    if (segment.text !== supervised.segments[index].text) {
      throw new Error(`检测融合失败：第 ${index + 1} 个片段文本不一致`)
    }
    const baseRisk = segment.riskScore ?? categoryRisk(segment.category)
    const supervisedRisk = supervised.segments[index].aiProbability * 100
    const gap = Math.abs(baseRisk - supervisedRisk)
    const positiveEvidence = supervisedRisk >= SUPERVISED_AIGC_POSITIVE_THRESHOLD && supervisedRisk > baseRisk
    const fusedRisk = positiveEvidence
      ? baseRisk + (supervisedRisk - baseRisk) * SUPERVISED_AIGC_FUSION_WEIGHT
      : baseRisk
    const disagrees = gap >= DETECTOR_DISAGREEMENT_GAP
    const weight = segment.text.replace(/\s/g, '').length
    totalChars += weight
    if (disagrees) disagreementChars += weight
    const riskBasedCategory = riskCategory(fusedRisk)
    const category = riskBasedCategory === 'ai' && !aiCategoryGate.allowed
      ? 'suspected_ai'
      : riskBasedCategory === 'suspected_ai' && aiCategoryGate.allowed
        ? 'ai'
        : riskBasedCategory
    const riskProbabilities = probabilities(fusedRisk)
    const categoryProbabilities = category === 'suspected_ai' && riskBasedCategory === 'ai'
      ? {
          human: riskProbabilities.human,
          suspected_ai: round(riskProbabilities.suspected_ai + riskProbabilities.ai),
          ai: 0
        }
      : category === 'ai' && riskBasedCategory === 'suspected_ai'
        ? {
            human: riskProbabilities.human,
            suspected_ai: 0,
            ai: round(riskProbabilities.suspected_ai + riskProbabilities.ai)
          }
      : riskProbabilities
    const supervisedPercent = round(supervisedRisk)
    return {
      ...segment,
      category,
      riskScore: round(fusedRisk),
      probabilities: categoryProbabilities,
      reason: riskBasedCategory === 'ai' && !aiCategoryGate.allowed
        ? `${aiCategoryGate.evidence}，归入疑似AI`
        : riskBasedCategory === 'suspected_ai' && aiCategoryGate.allowed
          ? `${aiCategoryGate.evidence}，归入AI特征`
        : riskBasedCategory === 'ai' && aiCategoryGate.allowed
          ? `${aiCategoryGate.evidence}，保留AI特征；${positiveEvidence
            ? `中文监督AI正证据 ${supervisedPercent}%`
            : segment.reason || '统计证据已融合'}`
        : positiveEvidence
        ? `中文监督AI正证据 ${supervisedPercent}%；${segment.reason || '统计证据已融合'}`
        : `中文监督AI ${supervisedPercent}%（低分不作排除）；${segment.reason || '保留统计证据'}`
    }
  })
  const distribution = coverageDistribution(segments)
  const disagreementShare = totalChars > 0 ? disagreementChars / totalChars : 0
  const supervisedPercent = round(supervised.documentAiProbability * 100)
  const summary = `融合检测覆盖率：人工 ${distribution.human}%，疑似AI ${distribution.suspected_ai}%，AI特征 ${distribution.ai}%` +
    `；中文监督模型整文 AI ${supervisedPercent}%` +
    (disagreementShare > 0 ? `；双检测器分歧覆盖 ${round(disagreementShare * 100)}%` : '')
  return {
    segments,
    distribution,
    summary,
    diagnostics: {
      ...(statistical.diagnostics || {
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
        reasons: []
      }),
      supervisedAiProbability: supervisedPercent,
      detectorDisagreementShare: round(disagreementShare * 100),
      supervisedModelId: supervised.modelId
    }
  }
}
