import { diagnoseChapterQuality } from './chapter-quality'
import { checkWorldviewConsistency } from './worldview-check'
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

  const qualityHints = getSettingsQualityGateHints(workId)
  warnings.push(...qualityHints.warnings)
  blockers.push(...qualityHints.blockers)

  return {
    passed: blockers.length === 0,
    blockers,
    warnings
  }
}
