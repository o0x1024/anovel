import type { AigcCategory, AigcDistribution, AigcSegment } from './aigc-detect-types'
import type { AigcSentencePatch } from './aigc-sentence-rewrite-types'

const ACTIONABLE_PATCH_STATUSES = new Set<AigcSentencePatch['status']>([
  'rewriting',
  'passed',
  'rejected',
  'unmatched'
])

interface LocatedSegment {
  start: number
  end: number
  segment: AigcSegment
}

function locateSegments(segments: AigcSegment[]): LocatedSegment[] {
  let cursor = 0
  return segments.map(segment => {
    const start = cursor
    cursor += segment.text.length
    return { start, end: cursor, segment }
  })
}

function findPatch(
  segment: LocatedSegment,
  patches: AigcSentencePatch[]
): AigcSentencePatch | undefined {
  return patches.find(patch =>
    (patch.start === segment.start && patch.end === segment.end) ||
    (patch.scope === 'block' && patch.start <= segment.start && patch.end >= segment.end)
  )
}

/**
 * 解析句级显示类别。
 *
 * 全文三分类概率不是文本覆盖率，不能按配额强制给句子染色。检测完成后先展示
 * 句子自身的主类别；逐句分析开始后，只有具备症状和具体证据的改写目标才标红。
 * 仅被高风险窗口覆盖、但没有句内证据的句子归为疑似 AI。
 */
export function resolveAigcDisplayCategories(
  segments: AigcSegment[],
  patches: AigcSentencePatch[] = []
): AigcCategory[] {
  return locateSegments(segments).map(located => {
    const patch = findPatch(located, patches)
    if (!patch) return located.segment.category

    const actionable = ACTIONABLE_PATCH_STATUSES.has(patch.status) &&
      patch.aiSymptoms.length > 0 && patch.evidence.trim().length > 0
    if (actionable) return 'ai'

    if (patch.status === 'analyzing') return 'suspected_ai'
    if (patch.status === 'unchanged') {
      return located.segment.category === 'human' ? 'human' : 'suspected_ai'
    }
    return located.segment.category === 'ai' ? 'suspected_ai' : located.segment.category
  })
}

export function summarizeAigcDisplayDistribution(
  segments: AigcSegment[],
  patches: AigcSentencePatch[] = []
): AigcDistribution {
  if (segments.length === 0) return { human: 0, suspected_ai: 0, ai: 0 }
  const categories = resolveAigcDisplayCategories(segments, patches)
  const weights = { human: 0, suspected_ai: 0, ai: 0 }
  let total = 0
  segments.forEach((segment, index) => {
    const weight = Math.max(1, segment.text.replace(/\s/g, '').length)
    weights[categories[index]] += weight
    total += weight
  })
  const human = Math.round(weights.human / total * 10000) / 100
  const ai = Math.round(weights.ai / total * 10000) / 100
  return {
    human,
    suspected_ai: Math.round((100 - human - ai) * 100) / 100,
    ai
  }
}
