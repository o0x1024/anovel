import { diagnoseChapterQuality } from './chapter-quality'
import { checkWorldviewConsistency } from './worldview-check'
import { checkAnchorAlignment } from './anchor-alignment'
import { getSettingsQualityGateHints } from './settings-quality'

export interface ConsistencyGateResult {
  passed: boolean
  blockers: string[]
  warnings: string[]
}

/** 保存正文前的 consistency 门禁 */
export function runConsistencyGate(
  workId: number,
  chapterId: number,
  content: string
): ConsistencyGateResult {
  const blockers: string[] = []
  const warnings: string[] = []

  const quality = diagnoseChapterQuality(workId, chapterId, content)
  for (const item of quality.items) {
    if (item.passed) continue
    if (item.severity === 'fatal') blockers.push(`${item.label}：${item.detail}`)
    else warnings.push(`${item.label}：${item.detail}`)
  }

  const worldview = checkWorldviewConsistency(workId, content)
  for (const v of worldview) {
    warnings.push(`世界观：${v.detail}`)
  }

  const alignment = checkAnchorAlignment(workId, content, { chapterId, step: 'body_generation', persist: false })
  if (alignment.summary.missing > 0) {
    warnings.push(`本章相关锚点中有 ${alignment.summary.missing} 个可能未对齐`)
  }
  if (alignment.summary.partial > 0) {
    warnings.push(`本章相关锚点中有 ${alignment.summary.partial} 个仅部分对齐`)
  }

  const qualityHints = getSettingsQualityGateHints(workId)
  warnings.push(...qualityHints.warnings)
  blockers.push(...qualityHints.blockers)

  return {
    passed: blockers.length === 0,
    blockers,
    warnings
  }
}
