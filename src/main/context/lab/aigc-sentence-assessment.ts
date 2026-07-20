import type {
  HumanRewriteAiSymptom,
  HumanRewriteAssessment,
  HumanRewriteSceneType
} from '../../../shared/human-rewrite-reference-types'
import {
  HUMAN_REWRITE_AI_SYMPTOMS,
  HUMAN_REWRITE_SCENE_TYPES
} from '../../../shared/human-rewrite-reference-types'

export interface SentenceAssessment extends HumanRewriteAssessment {
  shouldRewrite: boolean
  factAnchors: string[]
}

const sceneTypeSet = new Set<string>(HUMAN_REWRITE_SCENE_TYPES)
const symptomSet = new Set<string>(HUMAN_REWRITE_AI_SYMPTOMS)

export function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    JSON.parse(trimmed)
    return trimmed
  } catch { /* continue */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  if (fenced) {
    try {
      JSON.parse(fenced)
      return fenced
    } catch { /* continue */ }
  }
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first < 0 || last <= first) return null
  const candidate = trimmed.slice(first, last + 1)
  try {
    JSON.parse(candidate)
    return candidate
  } catch {
    return null
  }
}

export function parseSentenceAssessments(
  raw: string,
  count: number,
  requiredRewriteIds: ReadonlySet<number> = new Set(),
  sourceTexts: readonly string[] = []
): Map<number, SentenceAssessment> {
  const json = extractJsonObject(raw)
  if (!json) throw new Error('逐句分类未返回有效 JSON')
  const parsed = JSON.parse(json) as { items?: unknown[] }
  if (!Array.isArray(parsed.items)) throw new Error('逐句分类没有返回 items 数组')

  const result = new Map<number, SentenceAssessment>()
  const invalidItems: string[] = []
  for (const rawItem of parsed.items) {
    if (!rawItem || typeof rawItem !== 'object') {
      invalidItems.push('存在非对象项目')
      continue
    }
    const item = rawItem as Record<string, unknown>
    const id = Number(item.id)
    if (!Number.isInteger(id) || id < 0 || id >= count) {
      invalidItems.push(`非法 id: ${String(item.id)}`)
      continue
    }
    if (result.has(id)) {
      invalidItems.push(`id ${id} 重复`)
      continue
    }
    if (typeof item.shouldRewrite !== 'boolean') {
      invalidItems.push(`id ${id} 缺少布尔字段 shouldRewrite`)
      continue
    }

    const sceneTypes = Array.isArray(item.sceneTypes)
      ? Array.from(new Set(item.sceneTypes.filter(
          (value): value is HumanRewriteSceneType => typeof value === 'string' && sceneTypeSet.has(value)
        ))).slice(0, 2)
      : []
    const aiSymptoms = Array.isArray(item.aiSymptoms)
      ? Array.from(new Set(item.aiSymptoms.filter(
          (value): value is HumanRewriteAiSymptom => typeof value === 'string' && symptomSet.has(value)
        ))).slice(0, 3)
      : []
    const evidence = typeof item.evidence === 'string' ? item.evidence.trim() : ''
    const factAnchors = Array.isArray(item.factAnchors)
      ? Array.from(new Set(item.factAnchors.filter(
          (value): value is string => typeof value === 'string' && value.trim().length > 0
        ).map(value => value.trim()))).slice(0, 8)
      : []

    if (sceneTypes.length === 0) {
      invalidItems.push(`id ${id} 缺少有效场景类型，收到 ${JSON.stringify(item.sceneTypes)}`)
      continue
    }
    if (item.shouldRewrite && aiSymptoms.length === 0) {
      invalidItems.push(`id ${id} 需要改写但缺少 AI 症状，收到 ${JSON.stringify(item.aiSymptoms)}`)
      continue
    }
    if (item.shouldRewrite && !evidence) {
      invalidItems.push(`id ${id} 需要改写但缺少具体证据`)
      continue
    }
    if (!Array.isArray(item.factAnchors)) {
      invalidItems.push(`id ${id} 缺少事实锚点数组 factAnchors`)
      continue
    }
    const sourceText = sourceTexts[id]
    const invalidAnchor = typeof sourceText === 'string'
      ? factAnchors.find(anchor => !sourceText.includes(anchor))
      : undefined
    if (invalidAnchor) {
      invalidItems.push(`id ${id} 的事实锚点“${invalidAnchor}”不是原句原文`)
      continue
    }
    if (requiredRewriteIds.has(id) && !item.shouldRewrite) {
      invalidItems.push(`id ${id} 是检测器确认的红色句子，不允许返回 shouldRewrite=false`)
      continue
    }
    result.set(id, {
      shouldRewrite: item.shouldRewrite,
      sceneTypes,
      aiSymptoms,
      reason: evidence,
      factAnchors
    })
  }

  if (result.size !== count) {
    const details = invalidItems.length > 0 ? `；${invalidItems.join('；')}` : ''
    throw new Error(`逐句分类结果不完整：需要 ${count} 项，实际 ${result.size} 项${details}`)
  }
  return result
}
