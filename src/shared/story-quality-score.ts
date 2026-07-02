export const STORY_QUALITY_AI_METRIC_DEFS = [
  { key: 'ai_pattern_ratio', label: 'AI句式占比', max: 100 },
  { key: 'hook_density', label: '钩子悬念密度', max: 100 },
  { key: 'emotion_intensity', label: '情绪张力', max: 100 },
  { key: 'pacing_speed', label: '节奏推进', max: 100 },
  { key: 'scene_description_cap', label: '场景描写克制', max: 100 },
  { key: 'dialogue_impact', label: '对话信息密度', max: 100 },
  { key: 'outline_coverage', label: '大纲覆盖度', max: 100 },
  { key: 'setting_consistency', label: '设定一致性', max: 100 },
  { key: 'word_count', label: '字数达标', max: 100 }
] as const

export type StoryQualityAiMetricKey = (typeof STORY_QUALITY_AI_METRIC_DEFS)[number]['key']

export interface StoryQualityAiScoreItem {
  key: StoryQualityAiMetricKey
  label: string
  score: number
  max: number
  ratio: number
}

export interface StoryQualityAiTopIssue {
  id: string
  evidence: string
  fixHint: string
}

export type AnchorAlignmentVerdict = 'aligned' | 'partial' | 'missing' | 'not_applicable'

export interface AnchorAlignmentAiItem {
  title: string
  verdict: AnchorAlignmentVerdict
  reason: string
}

export interface StoryQualityAiScoreBreakdown {
  scoreTotal: number
  hardFail: boolean
  items: StoryQualityAiScoreItem[]
  failedRules: string[]
  topIssues: StoryQualityAiTopIssue[]
  patches?: StoryQualityAiPatch[]
  anchorAlignment: AnchorAlignmentAiItem[]
}

/** Patch 模式修复：单条精准替换 */
export interface StoryQualityAiPatch {
  find: string
  replace: string
}

/** Patch 模式修复结果 */
export interface StoryQualityAiPatchResult {
  success: boolean
  patchedText: string
  appliedCount: number
  patches: StoryQualityAiPatch[]
  error?: string
}

export function extractStoryJsonText(report: string): string | null {
  // 1) 优先匹配 ```json 代码块
  const fenced = report.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) {
    const inner = fenced[1].trim()
    if (inner.startsWith('{') && inner.includes('"score')) return inner
  }

  // 2) 找包含 score_total/scoreTotal 的最外层 JSON 对象（正确处理嵌套）
  const targetKey = /"(?:score_total|scoreTotal)"/
  let bestMatch: string | null = null

  // 找到所有 { 位置，逐个尝试匹配完整 JSON 对象
  let searchFrom = 0
  while (searchFrom < report.length) {
    const openIdx = report.indexOf('{', searchFrom)
    if (openIdx === -1) break

    // 从 { 开始做括号计数，找到匹配的 }
    let depth = 1
    let i = openIdx + 1
    let inString = false
    let escaped = false
    while (i < report.length && depth > 0) {
      const ch = report[i]
      if (escaped) {
        escaped = false
      } else if (ch === '\\' && inString) {
        escaped = true
      } else if (ch === '"') {
        inString = !inString
      } else if (!inString) {
        if (ch === '{') depth++
        else if (ch === '}') depth--
      }
      i++
    }

    if (depth === 0) {
      const candidate = report.slice(openIdx, i)
      if (targetKey.test(candidate)) {
        // 如果有多个匹配，取最长的一个（更可能是外层完整 JSON）
        if (!bestMatch || candidate.length > bestMatch.length) {
          bestMatch = candidate
        }
      }
    }
    // 即使匹配失败也从下一个大括号继续找
    searchFrom = openIdx + 1
  }

  return bestMatch
}

export function parseStoryQualityAiScoreBreakdown(report: string): StoryQualityAiScoreBreakdown | null {
  const text = extractStoryJsonText(report)
  if (!text) return null

  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null

    // 尝试提取分数对象
    const sObj = parsed.scores || parsed
    if (!sObj) return null

    const items: StoryQualityAiScoreItem[] = STORY_QUALITY_AI_METRIC_DEFS.map(def => {
      let val = sObj[def.key]
      if (val === undefined && typeof sObj === 'object') {
        // camelCase 兼容，比如 wordCount 代替 word_count
        const camel = def.key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
        val = sObj[camel]
      }
      const score = typeof val === 'number' ? val : (parseInt(val, 10) || 0)
      const clamped = Math.max(0, Math.min(score, def.max))
      return {
        key: def.key,
        label: def.label,
        score: clamped,
        max: def.max,
        ratio: def.max > 0 ? clamped / def.max : 0
      }
    })

    const topIssuesRaw = parsed.topIssues || parsed.top_issues || []
    const topIssues: StoryQualityAiTopIssue[] = Array.isArray(topIssuesRaw)
      ? topIssuesRaw.map((x: any, i) => ({
          id: x.id || `issue-${i}`,
          evidence: String(x.evidence || x.description || ''),
          fixHint: String(x.fixHint || x.fix_hint || x.suggestion || '')
        }))
      : []

    const anchorAlignmentRaw = parsed.anchorAlignment || parsed.anchor_alignment || []
    const anchorAlignment: AnchorAlignmentAiItem[] = Array.isArray(anchorAlignmentRaw)
      ? anchorAlignmentRaw.map((x: any) => {
          let v: AnchorAlignmentVerdict = 'not_applicable'
          const rawV = String(x.verdict || x.status).toLowerCase()
          if (rawV.includes('aligned') || rawV.includes('full') || rawV === 'pass') v = 'aligned'
          else if (rawV.includes('partial')) v = 'partial'
          else if (rawV.includes('missing') || rawV.includes('fail')) v = 'missing'
          return {
            title: String(x.title || ''),
            verdict: v,
            reason: String(x.reason || '')
          }
        })
      : []

    const computedAvg = items.length > 0
      ? Math.round(items.reduce((sum, it) => sum + it.score, 0) / items.length)
      : 0
    let explicitTotal = parsed.scoreTotal ?? parsed.score_total
    if (typeof explicitTotal !== 'number') {
      explicitTotal = parseInt(explicitTotal, 10)
    }
    const scoreTotal = Number.isFinite(explicitTotal) && explicitTotal > 0 ? explicitTotal : computedAvg

    const hardFailRaw = parsed.hardFail ?? parsed.hard_fail
    const hardFail = typeof hardFailRaw === 'boolean' ? hardFailRaw : false

    const failedRulesRaw = parsed.failedRules ?? parsed.failed_rules ?? []
    const failedRules = Array.isArray(failedRulesRaw) ? failedRulesRaw.map(String) : []

    const patchesRaw = parsed.patches || []
    const patches: StoryQualityAiPatch[] = Array.isArray(patchesRaw)
      ? patchesRaw
          .map(item => {
            if (!item || typeof item !== 'object') return null
            const row = item as Record<string, unknown>
            const find = typeof row.find === 'string' ? row.find.trim() : ''
            const replace = typeof row.replace === 'string' ? row.replace : ''
            return find ? { find, replace } : null
          })
          .filter((item): item is StoryQualityAiPatch => item != null)
      : []

    return {
      scoreTotal,
      hardFail,
      items,
      failedRules,
      topIssues,
      patches,
      anchorAlignment
    }
  } catch (e) {
    console.error('Failed to parse AI score breakdown JSON', e)
    return null
  }
}
