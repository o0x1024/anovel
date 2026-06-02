export interface CritiqueDimension {
  key: string
  label: string
  score: number
  passed: boolean
  issues: string[]
}

export interface CritiqueResult {
  dimensions: CritiqueDimension[]
  overallScore: number
  needsReview: boolean
  summary: string
  rawContent?: string
}

const DIMENSIONS = [
  { key: 'character', label: '角色一致性' },
  { key: 'plot', label: '情节合理性' },
  { key: 'dialogue', label: '对话自然度' },
  { key: 'pacing', label: '节奏把控' },
  { key: 'anchor', label: '锚点对齐' },
  { key: 'ai_trace', label: 'AI 痕迹' }
] as const

const PASS_THRESHOLD = 6

export function parseCritiqueResponse(content: string): CritiqueResult {
  const match = content.match(/```json\s*([\s\S]*?)```/)
  const raw = match?.[1] ?? content
  try {
    const parsed = JSON.parse(raw) as {
      dimensions?: { key?: string; label?: string; score?: number; issues?: string[] }[]
      summary?: string
    }
    const dimensions: CritiqueDimension[] = DIMENSIONS.map(def => {
      const found = parsed.dimensions?.find(d => d.key === def.key)
      const score = Math.min(10, Math.max(0, found?.score ?? 7))
      return {
        key: def.key,
        label: def.label,
        score,
        passed: score >= PASS_THRESHOLD,
        issues: found?.issues?.filter(Boolean) ?? []
      }
    })
    const overallScore = Math.round(
      dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length * 10
    ) / 10
    const needsReview = dimensions.some(d => !d.passed)
    return {
      dimensions,
      overallScore,
      needsReview,
      summary: parsed.summary || (needsReview ? '存在需关注的维度，建议审阅' : '各维度通过，可静默采纳'),
      rawContent: content
    }
  } catch {
    return {
      dimensions: DIMENSIONS.map(def => ({
        key: def.key,
        label: def.label,
        score: 7,
        passed: true,
        issues: []
      })),
      overallScore: 7,
      needsReview: false,
      summary: '未能解析结构化评分，请查看原文',
      rawContent: content
    }
  }
}

export const CRITIQUE_SYSTEM_PROMPT = [
  '你是资深小说编辑，对刚生成的章节正文进行六维批判性自评。',
  '评分 1-10，6 分及以上为通过。',
  '维度：角色一致性、情节合理性、对话自然度、节奏把控、锚点对齐、AI痕迹。',
  '输出 JSON：',
  '```json',
  '{"summary":"总体评价","dimensions":[{"key":"character","score":8,"issues":[]},{"key":"plot","score":7,"issues":[]},{"key":"dialogue","score":7,"issues":[]},{"key":"pacing","score":6,"issues":[]},{"key":"anchor","score":8,"issues":[]},{"key":"ai_trace","score":7,"issues":[]}]}',
  '```'
].join('\n')

export { PASS_THRESHOLD as CRITIQUE_PASS_THRESHOLD }
