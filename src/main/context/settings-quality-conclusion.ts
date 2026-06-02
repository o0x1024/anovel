export type QualitySeverity = 'none' | 'advisory' | 'blocking'
export type QualityVerdict = 'pass' | 'review' | 'fail'

export interface SectionLike {
  title: string
  content: string
  reviseType?: string
  action?: string
  severity?: QualitySeverity
}

export interface QualitySectionConclusion {
  key: string
  severity: QualitySeverity
  score: number
  summary: string
}

export interface QualityConclusion {
  overallScore: number
  verdict: QualityVerdict
  blockingCount: number
  advisoryCount: number
  sections: QualitySectionConclusion[]
}

export const PASS_SCORE_THRESHOLD = 75
export const MIN_SECTION_SCORE = 70
export const MAX_REVISE_ROUNDS = 2

const SECTION_KEY_HINTS: Record<string, string[]> = {
  character: ['人设'],
  worldview: ['世界观'],
  conflict: ['核心冲突', '冲突'],
  cards: ['卡片', 'Markdown 一致性'],
  anchors: ['锚点'],
  cross: ['跨设定', '矛盾']
}

function clampScore(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)))
}

function normalizeSeverity(value: unknown): QualitySeverity {
  const s = String(value ?? '').toLowerCase()
  if (s === 'blocking' || s === 'block' || s === '严重') return 'blocking'
  if (s === 'advisory' || s === 'suggest' || s === '建议') return 'advisory'
  return 'none'
}

function normalizeVerdict(value: unknown, conclusion: Omit<QualityConclusion, 'verdict'>): QualityVerdict {
  const v = String(value ?? '').toLowerCase()
  if (v === 'pass' || v === 'passed') return 'pass'
  if (v === 'fail' || v === 'failed') return 'fail'
  if (conclusion.blockingCount > 0) return 'fail'
  if (conclusion.overallScore >= PASS_SCORE_THRESHOLD && conclusion.blockingCount === 0) return 'pass'
  return 'review'
}

const SCORABLE_SECTION_KEYS = new Set(['character', 'worldview', 'conflict', 'cards', 'anchors', 'cross'])

function isScorableSectionKey(key: string): boolean {
  return SCORABLE_SECTION_KEYS.has(key)
}

function recalculateSeverityCounts(sections: QualitySectionConclusion[]): {
  blockingCount: number
  advisoryCount: number
} {
  const scorable = sections.filter(s => isScorableSectionKey(s.key))
  return {
    blockingCount: scorable.filter(s => s.severity === 'blocking').length,
    advisoryCount: scorable.filter(s => s.severity === 'advisory').length
  }
}

export function normalizeConclusion(raw: Record<string, unknown>): QualityConclusion {
  const sections: QualitySectionConclusion[] = Array.isArray(raw.sections)
    ? raw.sections.map((item: Record<string, unknown>) => ({
        key: String(item.key ?? 'unknown'),
        severity: normalizeSeverity(item.severity),
        score: clampScore(Number(item.score ?? 80)),
        summary: String(item.summary ?? '').trim()
      }))
    : []

  const counts = recalculateSeverityCounts(sections)
  const overallScore = clampScore(Number(raw.overallScore ?? 0))
  const base = { overallScore, ...counts, sections }
  return {
    ...base,
    verdict: normalizeVerdict(raw.verdict, base)
  }
}

export function parseQualityConclusion(report: string): QualityConclusion | null {
  const match = report.match(/```json\s*([\s\S]*?)```/)
  if (match) {
    try {
      return normalizeConclusion(JSON.parse(match[1]) as Record<string, unknown>)
    } catch {
      // fall through
    }
  }
  return inferConclusionFromReport(report)
}

function inferSectionSeverity(section: SectionLike): QualitySeverity {
  const content = section.content.trim()
  if (!content) return 'none'

  // 写作技巧：正文已说明自洽 / 已有解释 → none
  if (/说明：|已有解释|设定中已有|逻辑完整|弧线.{0,6}清晰|无硬矛盾|已覆盖|覆盖良好|相互一致|暂无问题|无明显问题|已基本自洽|无问题/.test(content)) {
    if (!/阻塞：|必须修复|硬逻辑|完全未|拖垮|毒点/.test(content)) return 'none'
  }

  // 明确 blocking（硬矛盾 / 毒点 / 完全遗漏）
  if (/阻塞：|必须修复|硬逻辑矛盾|根本背离|拖垮文章|毒点|完全未体现|完全未覆盖|严重不一致|遗漏主要角色|无法自洽|互相打架/.test(content)) {
    return 'blocking'
  }

  // 明确 advisory（精修 / 分场 / 文档整理）
  if (/^建议：|建议：|可优化|可以考虑|待.*场景|分散在|可再细化|挂靠|强化.*场景|量化的比喻|表现.*加强|微调|补全|集中呈现|进一步/.test(content)) {
    return 'advisory'
  }

  // 「问题N + 建议」格式 — 写作技巧默认为优化项，非结构失败
  if (/^\*\*问题|问题\d/.test(content) && !/阻塞：/.test(content)) {
    return 'advisory'
  }

  if (/无问题|良好|基本一致|无需修改/.test(content)) return 'none'

  if (/无法|严重矛盾|不能共存/.test(content)) return 'blocking'

  if (/矛盾|不一致|遗漏|缺失|未覆盖|未体现|略弱|偏弱/.test(content)) return 'advisory'

  if (content.split('\n').filter(l => /^[-*•]\s+/.test(l.trim())).length >= 1) {
    return 'advisory'
  }

  return 'none'
}

/** 正文与 JSON 结论冲突时，以正文为准（避免误标阻塞） */
export function reconcileSectionSeverity(
  section: SectionLike,
  fromConclusion?: QualitySeverity
): QualitySeverity {
  const fromContent = inferSectionSeverity(section)
  if (!fromConclusion) return fromContent
  if (fromContent === 'none' && fromConclusion !== 'none') return 'none'
  if (fromContent === 'blocking') return 'blocking'
  // JSON 标 blocking 但正文仅为建议级 → 以正文为准降级
  if (fromConclusion === 'blocking' && fromContent !== 'blocking') return fromContent
  if (fromConclusion === 'blocking' && fromContent === 'advisory') return 'advisory'
  return fromConclusion
}

export function inferConclusionFromReport(report: string): QualityConclusion {
  const lines = report.split('\n')
  const sections: QualitySectionConclusion[] = []
  let current: SectionLike | null = null

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)/)
    if (heading) {
      if (current) {
        const title = current.title.trim()
        if (!title.includes('总体评价') && !title.includes('自检结论')) {
          const severity = inferSectionSeverity(current)
          const key = matchSectionKey(title)
          if (isScorableSectionKey(key)) {
            sections.push({
              key,
              severity,
              score: severity === 'none' ? 85 : severity === 'advisory' ? 78 : 60,
              summary: current.content.slice(0, 80)
            })
          }
        }
      }
      current = { title: heading[1].trim(), content: '' }
    } else if (current) {
      current.content += (current.content ? '\n' : '') + line
    }
  }
  if (current) {
    const title = current.title.trim()
    if (!title.includes('总体评价') && !title.includes('自检结论')) {
      const severity = inferSectionSeverity({ ...current, content: current.content.trim() })
      const key = matchSectionKey(title)
      if (isScorableSectionKey(key)) {
        sections.push({
          key,
          severity,
          score: severity === 'none' ? 85 : severity === 'advisory' ? 78 : 60,
          summary: current.content.slice(0, 80)
        })
      }
    }
  }

  const counts = recalculateSeverityCounts(sections)
  const overallScore = sections.length
    ? clampScore(sections.reduce((sum, s) => sum + s.score, 0) / sections.length)
    : 80

  const base = { overallScore, ...counts, sections }
  return {
    ...base,
    verdict: normalizeVerdict(undefined, base)
  }
}

function matchSectionKey(title: string): string {
  for (const [key, hints] of Object.entries(SECTION_KEY_HINTS)) {
    if (hints.some(h => title.includes(h))) return key
  }
  if (title.includes('总体')) return 'overall'
  return 'unknown'
}

export function matchSectionSeverity(
  section: SectionLike,
  conclusion: QualityConclusion
): QualitySeverity | undefined {
  const key = matchSectionKey(section.title)
  const found = conclusion.sections.find(s => s.key === key)
  if (found) return found.severity
  return conclusion.sections.find(s =>
    section.title.includes(s.summary.slice(0, 4)) || s.summary.includes(section.title.slice(0, 4))
  )?.severity
}

export function enrichSectionsWithConclusion<T extends SectionLike>(
  sections: T[],
  conclusion: QualityConclusion | null
): T[] {
  return sections.map(section => {
    if (section.title.includes('总体评价') || section.title.includes('自检结论')) {
      return { ...section, severity: 'none' as QualitySeverity }
    }
    const fromConclusion = conclusion ? matchSectionSeverity(section, conclusion) : undefined
    const severity = reconcileSectionSeverity(section, fromConclusion ?? inferSectionSeverity(section))
    return { ...section, severity }
  })
}

export function countSectionSeverities(sections: SectionLike[]): {
  blockingCount: number
  advisoryCount: number
} {
  const relevant = sections.filter(s =>
    !s.title.includes('总体评价') && !s.title.includes('自检结论')
  )
  return {
    blockingCount: relevant.filter(s => s.severity === 'blocking').length,
    advisoryCount: relevant.filter(s => s.severity === 'advisory').length
  }
}

export function meetsPassCriteriaReconciled(
  conclusion: QualityConclusion | null | undefined,
  sections: SectionLike[]
): boolean {
  if (!conclusion) return false
  const { blockingCount } = countSectionSeverities(sections)
  if (blockingCount > 0) return false
  return meetsPassCriteria(conclusion)
}

export function meetsPassCriteria(conclusion: QualityConclusion | null | undefined): boolean {
  if (!conclusion) return false
  const { blockingCount } = recalculateSeverityCounts(conclusion.sections)
  if (blockingCount > 0) return false
  if (conclusion.overallScore < PASS_SCORE_THRESHOLD) return false
  const coreSections = conclusion.sections.filter(s =>
    ['character', 'worldview', 'conflict'].includes(s.key)
  )
  if (coreSections.some(s => s.score < MIN_SECTION_SCORE && s.severity === 'blocking')) {
    return false
  }
  return true
}

export function detectConvergenceStalled(
  prevBlocking: number,
  newBlocking: number,
  prevScore: number | null,
  newScore: number
): boolean {
  const blockingReduced = newBlocking < prevBlocking
  const scoreImproved = prevScore === null || newScore >= prevScore + 5
  return !blockingReduced && !scoreImproved
}
