import { diagnoseChapterQuality } from './chapter-quality'
import { checkWorldviewConsistency } from './worldview-check'
import { getSettingsQualityGateHints } from './settings-quality'
import { timelineDAO, workDAO } from '../db'

export interface ConsistencyGateResult {
  passed: boolean
  blockers: string[]
  warnings: string[]
}

export interface ConsistencyGateOptions {
  /** 候选正文尚未提交派生记忆时，不得用数据库时间线缺失否决正文。 */
  requireTimeline?: boolean
}

/** consistency 门禁；默认用于记忆已提交后的完整验收，候选阶段可显式延迟时间线检查。 */
export function runConsistencyGate(
  workId: number,
  chapterId: number,
  content: string,
  options: ConsistencyGateOptions = {}
): ConsistencyGateResult {
  const blockers: string[] = []
  const warnings: string[] = []
  const isNovel = workDAO.getById(workId)?.work_type === 'novel'

  const quality = diagnoseChapterQuality(workId, chapterId, content)
  for (const item of quality.items) {
    if (item.passed) continue
    if (item.severity === 'fatal') blockers.push(`${item.label}：${item.detail}`)
    else warnings.push(`${item.label}：${item.detail}`)
  }

  const worldview = checkWorldviewConsistency(workId, content)
  for (const v of worldview) {
    if (isNovel && v.severity === 'error') blockers.push(`世界观：${v.detail}`)
    else warnings.push(`世界观：${v.detail}`)
  }

  const qualityHints = getSettingsQualityGateHints(workId)
  warnings.push(...qualityHints.warnings)
  blockers.push(...qualityHints.blockers)

  if (options.requireTimeline ?? true) {
    const timelineEvents = timelineDAO.listByWork(workId).filter(event => event.chapter_id === chapterId)
    if (timelineEvents.length === 0) blockers.push(`时间线：本${isNovel ? '章' : '拍'}缺少关键事件与时间推进记录`)
  }

  return {
    passed: blockers.length === 0,
    blockers,
    warnings
  }
}
