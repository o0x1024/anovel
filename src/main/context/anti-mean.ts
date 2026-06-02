export interface SurpriseScoreResult {
  score: number
  passed: boolean
  threshold: number
  analysis: string
  alternatives?: string[]
}

export interface DisruptorResult {
  proposal: string
  rationale: string
}

export const SURPRISE_THRESHOLD = 5

export function parseSurpriseScore(content: string): SurpriseScoreResult {
  const match = content.match(/```json\s*([\s\S]*?)```/)
  const raw = match?.[1] ?? content
  try {
    const parsed = JSON.parse(raw) as {
      score?: number
      analysis?: string
      alternatives?: string[]
    }
    const score = Math.min(10, Math.max(1, parsed.score ?? 5))
    return {
      score,
      passed: score >= SURPRISE_THRESHOLD,
      threshold: SURPRISE_THRESHOLD,
      analysis: parsed.analysis || '',
      alternatives: parsed.alternatives?.filter(Boolean)
    }
  } catch {
    const numMatch = content.match(/(\d+(?:\.\d+)?)\s*[分\/]/);
    const score = numMatch ? Math.min(10, parseFloat(numMatch[1])) : 5
    return {
      score,
      passed: score >= SURPRISE_THRESHOLD,
      threshold: SURPRISE_THRESHOLD,
      analysis: content.slice(0, 300)
    }
  }
}

export const SURPRISE_SYSTEM_PROMPT = [
  '评估以下情节/正文的「意外程度/惊喜度」，1-10 分。',
  '5 分以下表示过于套路/可预测，需给出 2 个更具颠覆性但仍合理的替代走向。',
  '输出 JSON：',
  '```json',
  '{"score":6,"analysis":"评分理由","alternatives":["替代走向1","替代走向2"]}',
  '```'
].join('\n')

export const DISRUPTOR_SYSTEM_PROMPT = [
  '你是创意破坏者编辑，对给定内容提出「最意想不到但合理」的颠覆方案。',
  '例如：配角其实是卧底、胜利实为陷阱、看似失败实为计划。',
  '输出 JSON：',
  '```json',
  '{"proposal":"颠覆方案描述","rationale":"为何合理且意外"}',
  '```'
].join('\n')

export function parseDisruptorResponse(content: string): DisruptorResult {
  const match = content.match(/```json\s*([\s\S]*?)```/)
  const raw = match?.[1] ?? content
  try {
    const parsed = JSON.parse(raw) as { proposal?: string; rationale?: string }
    return {
      proposal: parsed.proposal || content,
      rationale: parsed.rationale || ''
    }
  } catch {
    return { proposal: content, rationale: '' }
  }
}

export const GENRE_DEVIATION_PROMPT = [
  '分析以下情节在同类小说中的常见程度，估计出现频率（如 70% 作品会用类似套路）。',
  '若频率>60%，给出 1 个差异化替代方向。',
  '输出 JSON：',
  '```json',
  '{"frequencyPercent":75,"pattern":"套路描述","alternative":"差异化方向"}',
  '```'
].join('\n')

export function parseGenreDeviation(content: string): {
  frequencyPercent: number
  pattern: string
  alternative: string
} {
  const match = content.match(/```json\s*([\s\S]*?)```/)
  try {
    const parsed = JSON.parse(match?.[1] ?? content) as {
      frequencyPercent?: number
      pattern?: string
      alternative?: string
    }
    return {
      frequencyPercent: parsed.frequencyPercent ?? 50,
      pattern: parsed.pattern ?? '',
      alternative: parsed.alternative ?? ''
    }
  } catch {
    return { frequencyPercent: 50, pattern: '', alternative: '' }
  }
}
