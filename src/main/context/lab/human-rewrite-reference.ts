import {
  HUMAN_REWRITE_AI_SYMPTOMS,
  HUMAN_REWRITE_SCENE_TYPES,
  type HumanRewriteAiSymptom,
  type HumanRewriteAssessment,
  type HumanRewriteReference,
  type HumanRewriteSceneType
} from '../../../shared/human-rewrite-reference-types'

const sceneTypeSet = new Set<string>(HUMAN_REWRITE_SCENE_TYPES)
const aiSymptomSet = new Set<string>(HUMAN_REWRITE_AI_SYMPTOMS)

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

function parseAssessment(item: unknown): HumanRewriteAssessment | null {
  if (!item || typeof item !== 'object') return null
  const row = item as Record<string, unknown>
  if (!Array.isArray(row.sceneTypes) || !Array.isArray(row.aiSymptoms)) return null
  const sceneTypes = unique(row.sceneTypes.filter(
    (value): value is HumanRewriteSceneType => typeof value === 'string' && sceneTypeSet.has(value)
  )).slice(0, 2)
  const aiSymptoms = unique(row.aiSymptoms.filter(
    (value): value is HumanRewriteAiSymptom => typeof value === 'string' && aiSymptomSet.has(value)
  )).slice(0, 3)
  const reason = typeof row.reason === 'string' ? row.reason.trim() : ''
  if (sceneTypes.length === 0 || aiSymptoms.length === 0 || !reason) return null
  return { sceneTypes, aiSymptoms, reason }
}

export function parseHumanRewriteAssessments(
  jsonText: string,
  expectedIds: number[]
): Map<number, HumanRewriteAssessment> {
  const parsed = JSON.parse(jsonText) as { items?: unknown[] }
  if (!Array.isArray(parsed.items)) throw new Error('场景分类没有返回 items 数组')

  const expected = new Set(expectedIds)
  const result = new Map<number, HumanRewriteAssessment>()
  for (const raw of parsed.items) {
    if (!raw || typeof raw !== 'object') continue
    const id = Number((raw as Record<string, unknown>).id)
    if (!Number.isInteger(id) || !expected.has(id) || result.has(id)) continue
    const assessment = parseAssessment(raw)
    if (assessment) result.set(id, assessment)
  }
  if (result.size !== expected.size) {
    throw new Error(`场景分类结果不完整：需要 ${expected.size} 项，实际 ${result.size} 项`)
  }
  return result
}

export function selectHumanRewriteReferences(
  assessment: HumanRewriteAssessment,
  references: HumanRewriteReference[],
  limit = 3
): HumanRewriteReference[] {
  const scored = references.flatMap(reference => {
    const symptomMatches = reference.aiSymptoms.filter(item => assessment.aiSymptoms.includes(item)).length
    const sceneMatches = reference.sceneTypes.filter(item => assessment.sceneTypes.includes(item)).length
    if (symptomMatches === 0 || sceneMatches === 0) return []
    return [{
      reference,
      score: symptomMatches * 10 + sceneMatches * 4 + reference.priority / 100
    }]
  })
  scored.sort((a, b) => b.score - a.score || b.reference.priority - a.reference.priority)
  return scored.slice(0, Math.max(1, limit)).map(item => item.reference)
}

export function formatHumanRewriteReferences(references: HumanRewriteReference[]): string {
  return references.map((reference, index) => {
    const principles = reference.rewritePrinciples.map(item => `- ${item}`).join('\n')
    const preserved = reference.preservedFacts.map(item => `- ${item}`).join('\n') || '- 按目标原文事实逐项保留'
    const forbidden = reference.forbiddenChanges.map(item => `- ${item}`).join('\n') || '- 不扩大改写范围'
    return [
      `案例 ${index + 1}：${reference.title}`,
      `【改写前】\n${reference.originalText.slice(0, 900)}`,
      `【人类改写后】\n${reference.rewrittenText.slice(0, 900)}`,
      `【改写原则】\n${principles}`,
      `【必须保留】\n${preserved}`,
      `【禁止变化】\n${forbidden}`
    ].join('\n')
  }).join('\n\n')
}

export function findCopiedReferencePhrase(
  rewrittenText: string,
  references: HumanRewriteReference[],
  minLength = 24
): { referenceTitle: string; phrase: string } | null {
  const target = rewrittenText.replace(/\s+/g, '')
  if (target.length < minLength) return null
  for (const reference of references) {
    const source = reference.rewrittenText.replace(/\s+/g, '')
    for (let start = 0; start + minLength <= source.length; start++) {
      const phrase = source.slice(start, start + minLength)
      if (target.includes(phrase)) return { referenceTitle: reference.title, phrase }
    }
  }
  return null
}
