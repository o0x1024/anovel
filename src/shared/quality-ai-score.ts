export const QUALITY_AI_METRIC_DEFS = [
  { key: 'ai_pattern_ratio', label: 'AI句式占比', max: 12 },
  { key: 'dialogue_density', label: '对话密度', max: 10 },
  { key: 'sentence_variation', label: '句长波动', max: 10 },
  { key: 'short_sentence_ratio', label: '短句占比', max: 8 },
  { key: 'imagery_repeat', label: '强意象复用', max: 8 },
  { key: 'scene_description_cap', label: '场景描写克制', max: 8 },
  { key: 'new_info_density', label: '推进信息密度', max: 10 },
  { key: 'outline_coverage', label: '大纲覆盖度', max: 14 },
  { key: 'content_logic', label: '内容逻辑', max: 10 },
  { key: 'word_count', label: '字数达标', max: 10 }
] as const

export type QualityAiMetricKey = (typeof QUALITY_AI_METRIC_DEFS)[number]['key']

export interface QualityAiScoreItem {
  key: QualityAiMetricKey
  label: string
  score: number
  max: number
  ratio: number
}

export interface QualityAiTopIssue {
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

export interface QualityAiScoreBreakdown {
  scoreTotal: number
  hardFail: boolean
  items: QualityAiScoreItem[]
  failedRules: string[]
  topIssues: QualityAiTopIssue[]
  patches?: QualityAiPatch[]
  anchorAlignment: AnchorAlignmentAiItem[]
}

/** Patch 模式修复：单条精准替换 */
export interface QualityAiPatch {
  find: string
  replace: string
}

/** Patch 模式修复结果 */
export interface QualityAiPatchResult {
  success: boolean
  patchedText: string
  appliedCount: number
  patches: QualityAiPatch[]
  error?: string
}

function extractJsonText(report: string): string | null {
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
        // 验证是否可解析
        try {
          JSON.parse(candidate)
          return candidate
        } catch {
          // 解析失败，记录但继续找（可能后面有更完整的）
          if (!bestMatch) bestMatch = candidate
        }
      }
    }

    searchFrom = openIdx + 1
  }

  // 3) 回退：如果没找到可解析的，返回第一个包含 score key 的候选
  if (bestMatch) return bestMatch

  return null
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function parseQualityAiScoreReport(report: string): QualityAiScoreBreakdown | null {
  const jsonText = extractJsonText(report)
  if (!jsonText) return null

  let data: Record<string, unknown>
  try {
    data = JSON.parse(jsonText) as Record<string, unknown>
  } catch {
    return null
  }

  // 兼容 camelCase 键名（AI 有时会偏离 snake_case 约定）
  const hardFail = data.hard_fail === true || data.hardFail === true
  const scoreTotal = readNumber(data.score_total ?? data.scoreTotal)
  const rawScores = data.scores ?? data.Scores

  let scoreMap: Record<string, unknown> = {}
  if (rawScores && typeof rawScores === 'object' && !Array.isArray(rawScores)) {
    scoreMap = rawScores as Record<string, unknown>
  } else if (typeof rawScores === 'string') {
    // AI 偶尔把 scores 写成字符串，尝试解析
    try {
      const parsed = JSON.parse(rawScores)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        scoreMap = parsed as Record<string, unknown>
      }
    } catch { /* 忽略 */ }
  }

  const items: QualityAiScoreItem[] = QUALITY_AI_METRIC_DEFS.map(def => {
    const score = Math.max(0, Math.min(def.max, readNumber(scoreMap[def.key])))
    return {
      key: def.key,
      label: def.label,
      score,
      max: def.max,
      ratio: def.max > 0 ? score / def.max : 0
    }
  })

  const failedRules = Array.isArray(data.failed_rules)
    ? data.failed_rules.map(v => readString(v)).filter(Boolean)
    : []

  const topIssues = Array.isArray(data.top_issues)
    ? data.top_issues
        .map(item => {
          if (!item || typeof item !== 'object') return null
          const row = item as Record<string, unknown>
          const issue: QualityAiTopIssue = {
            id: readString(row.id),
            evidence: readString(row.evidence),
            fixHint: readString(row.fix_hint)
          }
          return issue.id || issue.evidence || issue.fixHint ? issue : null
        })
        .filter((item): item is QualityAiTopIssue => item != null)
    : []

  const validVerdicts = new Set<AnchorAlignmentVerdict>(['aligned', 'partial', 'missing', 'not_applicable'])
  const anchorAlignment: AnchorAlignmentAiItem[] = Array.isArray(data.anchor_alignment)
    ? data.anchor_alignment
        .map(item => {
          if (!item || typeof item !== 'object') return null
          const row = item as Record<string, unknown>
          const title = readString(row.title)
          const verdict = readString(row.verdict) as AnchorAlignmentVerdict
          const reason = readString(row.reason)
          if (!title || !validVerdicts.has(verdict)) return null
          return { title, verdict, reason }
        })
        .filter((item): item is AnchorAlignmentAiItem => item != null)
    : []

  const patches = Array.isArray(data.patches)
    ? data.patches
        .map(item => {
          if (!item || typeof item !== 'object') return null
          const row = item as Record<string, unknown>
          const find = typeof row.find === 'string' ? row.find.trim() : ''
          const replace = typeof row.replace === 'string' ? row.replace : ''
          return find ? { find, replace } : null
        })
        .filter((item): item is QualityAiPatch => item != null)
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
}

export function stripQualityAiScoreJson(report: string): string {
  return report
    .replace(/```json\s*[\s\S]*?```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 解析 AI 返回的 patch 指令 JSON */
export function parseQualityAiPatchResponse(response: string): QualityAiPatch[] {
  const trimmed = response.trim()

  // 尝试多种 JSON 提取策略
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  const jsonText = fenced ? fenced[1].trim() : trimmed

  let data: unknown
  try {
    data = JSON.parse(jsonText)
  } catch {
    // 尝试找到第一个 JSON 对象
    const bare = jsonText.match(/\{[\s\S]*"patches"[\s\S]*\}/)
    if (!bare) return []
    try {
      data = JSON.parse(bare[0])
    } catch {
      return []
    }
  }

  if (!data || typeof data !== 'object') return []
  const patches = (data as Record<string, unknown>).patches
  if (!Array.isArray(patches)) return []

  return patches
    .map(p => {
      if (!p || typeof p !== 'object') return null
      const row = p as Record<string, unknown>
      const find = typeof row.find === 'string' ? row.find.trim() : ''
      const replace = typeof row.replace === 'string' ? row.replace : ''
      return find ? { find, replace } : null
    })
    .filter((p): p is QualityAiPatch => p != null)
}

export function metricProgressClass(ratio: number): string {
  if (ratio >= 0.8) return 'progress-success'
  if (ratio >= 0.6) return 'progress-warning'
  return 'progress-error'
}

export function totalScoreBadgeClass(score: number, hardFail: boolean): string {
  if (hardFail || score < 60) return 'badge-error'
  if (score >= 80) return 'badge-success'
  return 'badge-warning'
}

export function totalScoreProgressClass(score: number, hardFail: boolean): string {
  if (hardFail || score < 60) return 'progress-error'
  if (score >= 80) return 'progress-success'
  return 'progress-warning'
}

export function anchorVerdictBadgeClass(verdict: AnchorAlignmentVerdict): string {
  if (verdict === 'aligned') return 'badge-success'
  if (verdict === 'partial') return 'badge-warning'
  if (verdict === 'not_applicable') return 'badge-ghost'
  return 'badge-error'
}

const VERDICT_LABELS: Record<AnchorAlignmentVerdict, string> = {
  aligned: '已对齐',
  partial: '部分对齐',
  missing: '未对齐',
  not_applicable: '不适用'
}

export function anchorVerdictLabel(verdict: AnchorAlignmentVerdict): string {
  return VERDICT_LABELS[verdict] ?? verdict
}
